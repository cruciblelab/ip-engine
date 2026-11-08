/**
 * Minimal MRT (RFC 6396) reader for RIB snapshots — just enough to turn a
 * RouteViews `rib.YYYYMMDD.HHMM` file into `prefix -> origin ASN` rows, the
 * same shape the RIPE RIS whois dump hands us ready-made.
 *
 * Why a parser of our own instead of a library or CAIDA's processed
 * `pfx2as` files (`docs/106`, Phase 1 log):
 *  - CAIDA's `pfx2as` is RouteViews data *re-published under CAIDA's AUA*,
 *    which grants "copy, modify, and use" and states "No license is granted
 *    for any other purpose" — it never mentions commercial use. Reading the
 *    raw RouteViews files keeps exactly one license in play: RouteViews'
 *    CC BY 4.0, whose terms name selling derivative works explicitly.
 *  - No maintained, dependency-light MRT parser exists on npm, and the part
 *    of the format we need is small and fixed: TABLE_DUMP_V2 RIB records and
 *    the AS_PATH attribute inside them.
 *
 * Scope, deliberately narrow:
 *  - Only TABLE_DUMP_V2 (type 13) unicast RIB subtypes are read: 2
 *    (IPv4), 4 (IPv6), and their RFC 8050 ADD-PATH variants 8 and 10.
 *    Everything else (PEER_INDEX_TABLE, multicast, RIB_GENERIC, BGP4MP
 *    updates) is skipped by its length field and counted, never guessed at.
 *  - Only the AS_PATH attribute (type 2) is decoded. RFC 6396 §4.3.4
 *    requires AS_PATH in TABLE_DUMP_V2 to use 4-byte ASNs, so there is no
 *    AS4_PATH merging to do.
 *
 * TABLE_DUMP_V2 puts every peer's route for one prefix into a single
 * record, so each prefix is complete the moment its record is read. That
 * is what lets this stream: nothing is held across records, memory stays
 * flat no matter how large the RIB is.
 */

/** One prefix out of a RIB, with every origin ASN peers reported for it. */
export interface MrtPrefixOrigins {
  family: 4 | 6;
  /** Canonical CIDR text, host bits zeroed (`192.0.2.0/24`, `2001:db8::/32`). */
  prefix: string;
  prefixLen: number;
  /** Distinct peers per origin ASN, highest first. Empty if no peer's path had a usable origin. */
  origins: Array<{ asn: number; peers: number }>;
  /**
   * Peers whose path ended in something with no single origin: an AS_SET
   * of more than one ASN, a confederation segment, or an empty path.
   * Counted, not resolved — see `originOfAsPath`.
   */
  ambiguousPeers: number;
}

export interface MrtStats {
  records: number;
  ribRecords: number;
  /** Records of a type/subtype this reader does not decode, skipped whole. */
  skippedRecords: number;
  peerIndexTables: number;
}

const MRT_TABLE_DUMP_V2 = 13;
const SUB_PEER_INDEX_TABLE = 1;
const SUB_RIB_IPV4_UNICAST = 2;
const SUB_RIB_IPV6_UNICAST = 4;
const SUB_RIB_IPV4_UNICAST_ADDPATH = 8;
const SUB_RIB_IPV6_UNICAST_ADDPATH = 10;

const ATTR_AS_PATH = 2;
const ATTR_FLAG_EXTENDED_LENGTH = 0x10;

const SEG_AS_SET = 1;
const SEG_AS_SEQUENCE = 2;

/** Thrown for a structurally broken file — never swallowed, so a truncated
 * download fails the source instead of silently ingesting half a table. */
export class MrtFormatError extends Error {}

/**
 * The origin of an AS_PATH: the last ASN of its final segment, when that
 * segment names exactly one AS.
 *
 * Returns null — and the caller counts it as ambiguous — for a path ending
 * in an AS_SET of several ASNs (aggregation; there is no single origin to
 * report, and AS_SET is deprecated by RFC 9774 anyway), a confederation
 * segment (should never reach an external collector), or an empty path.
 * Same rule the rest of this codebase follows: precision over coverage,
 * no guessing.
 */
export function originOfAsPath(attr: Buffer): number | null {
  let off = 0;
  let lastType = 0;
  let lastCount = 0;
  let lastAsn = 0;
  while (off < attr.length) {
    if (off + 2 > attr.length) throw new MrtFormatError("AS_PATH segment header truncated");
    const type = attr[off]!;
    const count = attr[off + 1]!;
    off += 2;
    const end = off + count * 4;
    if (end > attr.length) throw new MrtFormatError("AS_PATH segment truncated");
    lastType = type;
    lastCount = count;
    if (count > 0) lastAsn = attr.readUInt32BE(end - 4);
    off = end;
  }
  if (lastCount === 0) return null;
  if (lastType === SEG_AS_SEQUENCE) return lastAsn;
  if (lastType === SEG_AS_SET && lastCount === 1) return lastAsn;
  return null;
}

/** Finds the AS_PATH attribute in a path-attribute block, or null. */
function findAsPath(attrs: Buffer): Buffer | null {
  let off = 0;
  while (off < attrs.length) {
    if (off + 3 > attrs.length) throw new MrtFormatError("path attribute header truncated");
    const flags = attrs[off]!;
    const type = attrs[off + 1]!;
    let len: number;
    if (flags & ATTR_FLAG_EXTENDED_LENGTH) {
      if (off + 4 > attrs.length) throw new MrtFormatError("path attribute header truncated");
      len = attrs.readUInt16BE(off + 2);
      off += 4;
    } else {
      len = attrs[off + 2]!;
      off += 3;
    }
    if (off + len > attrs.length) throw new MrtFormatError("path attribute truncated");
    if (type === ATTR_AS_PATH) return attrs.subarray(off, off + len);
    off += len;
  }
  return null;
}

function formatIpv4(bytes: Buffer): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/** RFC 5952 text form: lowercase, no leading zeros, longest zero run (≥2
 * groups, first on a tie) compressed to `::`. */
export function formatIpv6(bytes: Buffer): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (g: number) => g.toString(16);
  if (bestLen < 2) return groups.map(hex).join(":");
  const head = groups.slice(0, bestStart).map(hex).join(":");
  const tail = groups.slice(bestStart + bestLen).map(hex).join(":");
  return `${head}::${tail}`;
}

/** Decodes one RIB record body into a prefix and its per-origin peer counts. */
export function parseRibRecord(body: Buffer, family: 4 | 6, addPath: boolean): MrtPrefixOrigins {
  let off = 4; // sequence number
  if (body.length < off + 1) throw new MrtFormatError("RIB record truncated");
  const prefixLen = body[off]!;
  off += 1;
  const maxLen = family === 4 ? 32 : 128;
  if (prefixLen > maxLen) throw new MrtFormatError(`prefix length ${prefixLen} > ${maxLen}`);
  const nBytes = Math.ceil(prefixLen / 8);
  if (body.length < off + nBytes + 2) throw new MrtFormatError("RIB record truncated");
  const addr = Buffer.alloc(family === 4 ? 4 : 16);
  body.copy(addr, 0, off, off + nBytes);
  // Zero any host bits in the last byte so `10.1.2.3/8`-style values can't
  // reach the inet column as a different value from `10.0.0.0/8`.
  if (prefixLen % 8 !== 0) addr[nBytes - 1]! &= 0xff << (8 - (prefixLen % 8));
  off += nBytes;
  const entryCount = body.readUInt16BE(off);
  off += 2;

  const peersByAsn = new Map<number, Set<number>>();
  const ambiguous = new Set<number>();
  for (let e = 0; e < entryCount; e++) {
    const headerLen = 2 + 4 + (addPath ? 4 : 0) + 2;
    if (body.length < off + headerLen) throw new MrtFormatError("RIB entry truncated");
    const peerIndex = body.readUInt16BE(off);
    off += 2 + 4 + (addPath ? 4 : 0); // peer index, originated time, [path id]
    const attrLen = body.readUInt16BE(off);
    off += 2;
    if (body.length < off + attrLen) throw new MrtFormatError("RIB entry attributes truncated");
    const asPath = findAsPath(body.subarray(off, off + attrLen));
    off += attrLen;
    const origin = asPath ? originOfAsPath(asPath) : null;
    if (origin === null) {
      ambiguous.add(peerIndex);
      continue;
    }
    let set = peersByAsn.get(origin);
    if (!set) peersByAsn.set(origin, (set = new Set()));
    set.add(peerIndex);
  }

  const origins = [...peersByAsn.entries()]
    .map(([asn, peers]) => ({ asn, peers: peers.size }))
    .sort((a, b) => b.peers - a.peers || a.asn - b.asn);
  // A peer that sent both a usable path and an ambiguous one (possible with
  // ADD-PATH) is not ambiguous for this prefix.
  for (const peers of peersByAsn.values()) for (const p of peers) ambiguous.delete(p);

  const text = family === 4 ? formatIpv4(addr) : formatIpv6(addr);
  return { family, prefix: `${text}/${prefixLen}`, prefixLen, origins, ambiguousPeers: ambiguous.size };
}

/**
 * Streams an uncompressed MRT RIB file and yields one entry per unicast
 * prefix. `stats` is filled in as the stream is read.
 *
 * Fails with `MrtFormatError` on a record cut short at end of input — the
 * signature of a truncated download — rather than returning what it had.
 */
export async function* iterMrtRibPrefixes(
  input: AsyncIterable<Buffer | Uint8Array>,
  stats: MrtStats = { records: 0, ribRecords: 0, skippedRecords: 0, peerIndexTables: 0 },
): AsyncGenerator<MrtPrefixOrigins> {
  let buf: Buffer = Buffer.alloc(0);
  let off = 0;
  for await (const chunk of input) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Keep only the unread tail, then append — linear in total bytes.
    buf = off < buf.length ? Buffer.concat([buf.subarray(off), c]) : c;
    off = 0;
    while (buf.length - off >= 12) {
      const type = buf.readUInt16BE(off + 4);
      const subtype = buf.readUInt16BE(off + 6);
      const len = buf.readUInt32BE(off + 8);
      if (buf.length - off < 12 + len) break; // wait for the rest of the record
      const body = buf.subarray(off + 12, off + 12 + len);
      off += 12 + len;
      stats.records++;
      if (type !== MRT_TABLE_DUMP_V2) {
        stats.skippedRecords++;
        continue;
      }
      switch (subtype) {
        case SUB_PEER_INDEX_TABLE:
          stats.peerIndexTables++;
          break;
        case SUB_RIB_IPV4_UNICAST:
          stats.ribRecords++;
          yield parseRibRecord(body, 4, false);
          break;
        case SUB_RIB_IPV6_UNICAST:
          stats.ribRecords++;
          yield parseRibRecord(body, 6, false);
          break;
        case SUB_RIB_IPV4_UNICAST_ADDPATH:
          stats.ribRecords++;
          yield parseRibRecord(body, 4, true);
          break;
        case SUB_RIB_IPV6_UNICAST_ADDPATH:
          stats.ribRecords++;
          yield parseRibRecord(body, 6, true);
          break;
        default:
          stats.skippedRecords++;
      }
    }
  }
  if (buf.length - off !== 0) {
    throw new MrtFormatError(`input ended mid-record (${buf.length - off} trailing bytes)`);
  }
}
