/**
 * MaxMind DB (.mmdb) writer.
 *
 * Why this exists: a Postgres-backed lookup costs a handful of GiST
 * containment scans per request, and measured on a 4-vCPU box that caps out
 * around 500 requests/second. An .mmdb file is a memory-mapped binary trie —
 * a lookup is a walk down at most 128 bits with no database, no network, and
 * no allocation. That is a different order of magnitude, and it is how
 * commercial IP databases are actually deployed at volume.
 *
 * The second reason is compatibility. Every language has a MaxMind DB
 * reader already; emitting this format means a consumer can use this
 * project's data with the library they were going to use anyway, instead of
 * writing an integration.
 *
 * No npm package writes this format (readers are plentiful, writers are
 * not), so the format is implemented here against MaxMind's published
 * specification. The tests verify output by reading it back with the
 * `maxmind` reader rather than by trusting this code.
 *
 * Layout, in order:
 *   [search tree] [16 zero bytes] [data section] [metadata marker] [metadata]
 *
 * The tree is binary over the address bits: at depth d, bit d of the address
 * chooses record 0 or 1. A record value is interpreted by comparing it to
 * the node count — below it, another node index; equal, no data; above,
 * an offset into the data section. That comparison is why node count has to
 * be known before the tree can be serialised, and therefore why the tree is
 * built in memory first.
 *
 * Everything is stored in a single IPv6 tree with IPv4 at ::/96, which is
 * where readers look for it (they walk 96 zero branches from the root to
 * find the IPv4 subtree), and which avoids maintaining two trees.
 */
import { isIP } from "node:net";

/** Record size in bits. 32 keeps the arithmetic simple and caps the tree at
 * 2^32 nodes — orders of magnitude more than any dataset here will produce. */
const RECORD_SIZE = 32;
const NODE_BYTES = (RECORD_SIZE * 2) / 8;
const DATA_SECTION_SEPARATOR = Buffer.alloc(16, 0);
const METADATA_MARKER = Buffer.from([
  0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com", "ascii"),
]);

/** A value the data section can hold. Deliberately narrow: these are the
 * types this project's records actually use. */
export type MmdbValue =
  | string
  | number
  | boolean
  | null
  | MmdbValue[]
  | { [key: string]: MmdbValue };

export interface MmdbEntry {
  /** CIDR, either family. */
  network: string;
  record: Record<string, MmdbValue>;
}

export interface MmdbWriteOptions {
  /** Free-form name for the database, e.g. "IP-Insight-Engine-City". */
  databaseType: string;
  /** Human description keyed by language code. */
  description?: Record<string, string>;
  /** Defaults to now. */
  buildEpoch?: number;
}

/* ------------------------------------------------------------------------ */
/* Data section encoding                                                     */
/* ------------------------------------------------------------------------ */

const TYPE_POINTER = 1;
const TYPE_UTF8 = 2;
const TYPE_DOUBLE = 3;
const TYPE_UINT16 = 5;
const TYPE_UINT32 = 6;
const TYPE_MAP = 7;
const TYPE_INT32 = 8;
const TYPE_UINT64 = 9;
const TYPE_ARRAY = 11;
const TYPE_BOOLEAN = 14;

/**
 * Control byte + size, per the spec: the top 3 bits are the type (or 0 for
 * "extended", where the type is carried in the byte after the size), and the
 * bottom 5 bits are the size, with 29/30/31 meaning "size continues in the
 * following 1/2/3 bytes".
 */
function encodeControl(type: number, size: number): Buffer {
  const parts: number[] = [];
  const extended = type >= 8;
  const typeBits = extended ? 0 : type;

  if (size < 29) {
    parts.push((typeBits << 5) | size);
  } else if (size < 285) {
    parts.push((typeBits << 5) | 29, size - 29);
  } else if (size < 65821) {
    const v = size - 285;
    parts.push((typeBits << 5) | 30, (v >> 8) & 0xff, v & 0xff);
  } else {
    const v = size - 65821;
    parts.push((typeBits << 5) | 31, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  if (extended) parts.push(type - 7);
  return Buffer.from(parts);
}

/** Big-endian, minimal-length unsigned integer — the spec stores uints with
 * leading zero bytes stripped, so `size` is the byte count. */
function uintBytes(value: number): Buffer {
  if (value === 0) return Buffer.alloc(0);
  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Buffer.from(bytes);
}

/** Forces a specific integer type regardless of how small `value` is — the
 * metadata section's field types are fixed by the spec, not chosen by
 * value size the way a data-section record's fields are. `encodeValue`'s
 * generic path picks the smallest type that fits, which is correct for
 * arbitrary record fields but wrong here: it once put `node_count` (a
 * value comfortably under 65,536 on a small database) into a uint16 rather
 * than the uint32 every reader is entitled to assume. MaxMind's own Go
 * reader and the JS `maxmind` package decode a uint16 as a plain number and
 * never noticed; Rust's `maxminddb` crate matches the field's *type tag*
 * against the type it decodes as, and correctly rejected the file outright.
 * Found by testing this file against three independent readers, not two. */
function encodeForcedUint(type: number, value: number): Buffer {
  // Trimmed to its minimal byte count, same convention `uintBytes` already
  // uses elsewhere — the type tag alone conveys "this is a uint32", not the
  // byte count, so a small value legitimately encodes in fewer bytes.
  const b = uintBytes(value);
  return Buffer.concat([encodeControl(type, b.length), b]);
}

/** Builds the metadata map with per-field types fixed by the spec, rather
 * than reusing the generic object encoder (which is correct for the data
 * section, where a reader trusts whatever type tag it finds, but not here). */
function encodeMetadata(fields: {
  node_count: number;
  record_size: number;
  ip_version: number;
  database_type: string;
  languages: string[];
  binary_format_major_version: number;
  binary_format_minor_version: number;
  build_epoch: number;
  description: Record<string, string>;
}): Buffer {
  const entries: Array<[string, Buffer]> = [
    ["node_count", encodeForcedUint(TYPE_UINT32, fields.node_count)],
    ["record_size", encodeForcedUint(TYPE_UINT16, fields.record_size)],
    ["ip_version", encodeForcedUint(TYPE_UINT16, fields.ip_version)],
    ["database_type", encodeValue(fields.database_type)],
    ["languages", encodeValue(fields.languages)],
    [
      "binary_format_major_version",
      encodeForcedUint(TYPE_UINT16, fields.binary_format_major_version),
    ],
    [
      "binary_format_minor_version",
      encodeForcedUint(TYPE_UINT16, fields.binary_format_minor_version),
    ],
    ["build_epoch", encodeForcedUint(TYPE_UINT64, fields.build_epoch)],
    ["description", encodeValue(fields.description)],
  ];
  const parts: Buffer[] = [encodeControl(TYPE_MAP, entries.length)];
  for (const [key, valueBuf] of entries) {
    const k = Buffer.from(key, "utf8");
    parts.push(encodeControl(TYPE_UTF8, k.length), k, valueBuf);
  }
  return Buffer.concat(parts);
}

function encodeValue(value: MmdbValue): Buffer {
  if (value === null) {
    // No null type exists in the format; an empty map is the closest honest
    // representation and readers surface it as an empty object rather than
    // as a wrong value.
    return encodeControl(TYPE_MAP, 0);
  }
  if (typeof value === "boolean") {
    return encodeControl(TYPE_BOOLEAN, value ? 1 : 0);
  }
  if (typeof value === "string") {
    const buf = Buffer.from(value, "utf8");
    return Buffer.concat([encodeControl(TYPE_UTF8, buf.length), buf]);
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) {
      if (value <= 0xffff) {
        const b = uintBytes(value);
        return Buffer.concat([encodeControl(TYPE_UINT16, b.length), b]);
      }
      if (value <= 0xffffffff) {
        const b = uintBytes(value);
        return Buffer.concat([encodeControl(TYPE_UINT32, b.length), b]);
      }
      const b = uintBytes(value);
      return Buffer.concat([encodeControl(TYPE_UINT64, b.length), b]);
    }
    if (Number.isInteger(value)) {
      const b = Buffer.alloc(4);
      b.writeInt32BE(value);
      return Buffer.concat([encodeControl(TYPE_INT32, 4), b]);
    }
    const b = Buffer.alloc(8);
    b.writeDoubleBE(value);
    return Buffer.concat([encodeControl(TYPE_DOUBLE, 8), b]);
  }
  if (Array.isArray(value)) {
    const items = value.map(encodeValue);
    return Buffer.concat([encodeControl(TYPE_ARRAY, value.length), ...items]);
  }
  const keys = Object.keys(value);
  const parts: Buffer[] = [encodeControl(TYPE_MAP, keys.length)];
  for (const key of keys) {
    const k = Buffer.from(key, "utf8");
    parts.push(encodeControl(TYPE_UTF8, k.length), k, encodeValue(value[key]!));
  }
  return Buffer.concat(parts);
}

/**
 * Builds the data section, returning each distinct record's offset.
 *
 * Records repeat heavily — every prefix belonging to one ASN in one city
 * encodes identically — so identical encodings are stored once and shared.
 * On a real export this is the difference between a file of a few hundred MB
 * and one of a few tens.
 */
class DataSection {
  private readonly chunks: Buffer[] = [];
  private readonly offsets = new Map<string, number>();
  private length = 0;

  add(record: Record<string, MmdbValue>): number {
    const encoded = encodeValue(record);
    const key = encoded.toString("base64");
    const existing = this.offsets.get(key);
    if (existing !== undefined) return existing;
    const offset = this.length;
    this.chunks.push(encoded);
    this.length += encoded.length;
    this.offsets.set(key, offset);
    return offset;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }

  get size(): number {
    return this.length;
  }
}

/* ------------------------------------------------------------------------ */
/* Search tree                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The trie, held in a flat Int32Array rather than as linked objects.
 *
 * This is not premature optimisation — it is the difference between working
 * and not. A real export is ~2.5M prefixes, and because IPv4 sits at ::/96
 * each one descends ~120 levels, so an object-per-node trie allocates on the
 * order of 60 million objects. At roughly 100 bytes of object header, map
 * and array apiece that is 5-6 GB, well past Node's default heap; the first
 * attempt at this died there after 25 minutes. Two int32s per node is 8
 * bytes, so the same trie is under half a gigabyte.
 *
 * Slot encoding, chosen so one array covers all three cases the format needs:
 *   >= 0   child node index
 *   -1     empty (no child)
 *   <= -2  terminal record; data offset is (-value) - 2
 */
class Trie {
  private slots: Int32Array;
  /** Node count, not slot count — each node owns two consecutive slots. */
  private count = 1;

  constructor(initialNodes = 1 << 16) {
    this.slots = new Int32Array(initialNodes * 2).fill(-1);
  }

  private ensure(nodes: number): void {
    if (nodes * 2 <= this.slots.length) return;
    let size = this.slots.length;
    while (size < nodes * 2) size *= 2;
    const grown = new Int32Array(size).fill(-1);
    grown.set(this.slots);
    this.slots = grown;
  }

  get nodeCount(): number {
    return this.count;
  }

  /**
   * Insert a prefix, creating intermediate nodes as needed.
   *
   * The terminal record goes into the *last node's record slot*, not into a
   * node of its own — a reader walks exactly `prefixLen` bit-steps and then
   * inspects the value it last read, so a record parked one level deeper is
   * never seen. (That is precisely how a /32 silently returned null before
   * this was written correctly: the walk ended on an interior node index
   * instead of on the data pointer.)
   *
   * A later, deeper entry overwrites a shallower one at its own depth —
   * which is why the exporter feeds rows least-specific first.
   */
  insert(bits: number[], prefixLen: number, dataOffset: number): void {
    const terminal = -(dataOffset + 2);
    if (prefixLen === 0) {
      this.slots[0] = terminal;
      this.slots[1] = terminal;
      return;
    }
    let node = 0;
    // Stop one short: the final bit selects a *record*, not a child.
    for (let depth = 0; depth < prefixLen - 1; depth++) {
      const slot = node * 2 + bits[depth]!;
      const value = this.slots[slot]!;
      if (value >= 0) {
        node = value;
        continue;
      }
      // Either empty, or a terminal record being subdivided by a more
      // specific prefix — both become a fresh interior node. Subdividing
      // discards the shallower record on this branch, which is correct:
      // the more specific entry is the better answer for everything below.
      this.ensure(this.count + 1);
      const child = this.count++;
      this.slots[slot] = child;
      node = child;
    }
    this.slots[node * 2 + bits[prefixLen - 1]!] = terminal;
  }

  /**
   * Serialise to the on-disk tree. Record values are resolved against the
   * final node count, which is why this can only run once every insert is
   * done.
   */
  serialise(): Buffer {
    const nodeCount = this.count;
    const tree = Buffer.alloc(nodeCount * NODE_BYTES);
    for (let node = 0; node < nodeCount; node++) {
      for (let bit = 0; bit < 2; bit++) {
        const value = this.slots[node * 2 + bit]!;
        let encoded: number;
        if (value >= 0) {
          encoded = value;
        } else if (value === -1) {
          // "No data" is encoded as exactly the node count.
          encoded = nodeCount;
        } else {
          encoded = nodeCount + 16 + (-value - 2);
        }
        tree.writeUInt32BE(encoded, node * NODE_BYTES + bit * 4);
      }
    }
    return tree;
  }
}

/** 128-bit address as a bit array, IPv4 mapped into ::ffff:0:0/96. */
function addressBits(network: string): { bits: number[]; prefixLen: number } | null {
  const [addr, lenStr] = network.split("/");
  if (!addr || lenStr === undefined) return null;
  const family = isIP(addr);
  if (family === 0) return null;
  const declared = Number(lenStr);
  if (!Number.isInteger(declared)) return null;

  const bytes: number[] = [];
  if (family === 4) {
    const octets = addr.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    // IPv4 lives at ::/96 — 96 zero bits then the four octets. Not
    // ::ffff:0:0/96, which is the more familiar v4-mapped form: readers
    // locate the IPv4 subtree by walking 96 *left* (zero) branches from the
    // root, so anything stored behind an 0xffff prefix is unreachable to
    // them. Verified against mmdb-lib's ipv4Start().
    bytes.push(...Array(12).fill(0), ...octets);
  } else {
    const expanded = expandIpv6(addr);
    if (!expanded) return null;
    bytes.push(...expanded);
  }
  const prefixLen = family === 4 ? declared + 96 : declared;
  if (prefixLen < 0 || prefixLen > 128) return null;

  const bits: number[] = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  return { bits, prefixLen };
}

/** IPv6 text to 16 bytes. Handles `::` compression and trailing v4 form. */
function expandIpv6(addr: string): number[] | null {
  let text = addr;
  const v4Match = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const octets = v4Match[1]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hex =
      ((octets[0]! << 8) | octets[1]!).toString(16) +
      ":" +
      ((octets[2]! << 8) | octets[3]!).toString(16);
    text = text.slice(0, v4Match.index) + hex;
  }
  const [head, tail] = text.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (text.includes("::")) {
    if (missing < 0) return null;
  } else if (headParts.length !== 8) {
    return null;
  }
  const groups = text.includes("::")
    ? [...headParts, ...Array(missing).fill("0"), ...tailParts]
    : headParts;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/* ------------------------------------------------------------------------ */
/* Writer                                                                    */
/* ------------------------------------------------------------------------ */

export interface MmdbBuildResult {
  buffer: Buffer;
  nodeCount: number;
  /** Distinct records after dedup — usually far below the entry count. */
  recordCount: number;
  skipped: number;
}

/**
 * Build a complete .mmdb file from prefix→record entries.
 *
 * Entries are inserted in the order given, and a later entry covering the
 * same space overwrites an earlier one at that depth. Callers should
 * therefore insert least-specific first, which is what the exporter does by
 * ordering on `masklen`.
 */
export function buildMmdb(entries: Iterable<MmdbEntry>, opts: MmdbWriteOptions): MmdbBuildResult {
  const trie = new Trie();
  const data = new DataSection();
  let skipped = 0;
  let recordCount = 0;

  for (const entry of entries) {
    const parsed = addressBits(entry.network);
    if (!parsed) {
      skipped++;
      continue;
    }
    const sizeBefore = data.size;
    const dataOffset = data.add(entry.record);
    if (data.size !== sizeBefore) recordCount++;
    trie.insert(parsed.bits, parsed.prefixLen, dataOffset);
  }

  const nodeCount = trie.nodeCount;
  const tree = trie.serialise();

  const metadata = encodeMetadata({
    node_count: nodeCount,
    record_size: RECORD_SIZE,
    ip_version: 6,
    database_type: opts.databaseType,
    languages: ["en"],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: opts.buildEpoch ?? Math.floor(Date.now() / 1000),
    description: opts.description ?? { en: opts.databaseType },
  });

  return {
    buffer: Buffer.concat([tree, DATA_SECTION_SEPARATOR, data.build(), METADATA_MARKER, metadata]),
    nodeCount,
    recordCount,
    skipped,
  };
}
