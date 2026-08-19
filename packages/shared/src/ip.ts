import { isIP, BlockList } from "node:net";

/**
 * Sanity-check a CIDR string before it's stored as a native Postgres
 * `inet` value. This is deliberately lightweight — it doesn't compute a
 * numeric range (there's no need to anymore: containment queries are
 * `<<=`/`>>=` against the `inet` column itself, see lib/lookup.ts) — it
 * just confirms the address parses and the prefix length is in range for
 * that family, so a malformed line from an upstream feed gets skipped
 * instead of failing an entire insert batch.
 */
export function parseCidr(text: string): { family: 4 | 6; prefixLen: number } | null {
  const slash = text.indexOf("/");
  if (slash === -1) return null;
  const address = text.slice(0, slash);
  // Digits only, not Number(): Number("") is 0 — which silently turned a
  // truncated feed line like "1.2.3.0/" into a match-everything /0 — and
  // Number also accepts "24.5", " 24", "+24", all of which the eventual
  // ::inet cast rejects, failing the whole insert batch this function
  // exists to protect.
  const prefixPart = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefixLen = Number(prefixPart);
  const family = isIP(address);
  if (family === 4) {
    if (prefixLen < 0 || prefixLen > 32) return null;
    return { family: 4, prefixLen };
  }
  if (family === 6) {
    if (prefixLen < 0 || prefixLen > 128) return null;
    return { family: 6, prefixLen };
  }
  return null;
}

export function ipv4ToInt(ip: string): number {
  const octets = ip.split(".");
  // Digits only, not Number(): same trap as parseCidr above — Number("")
  // is 0 (turning "1.2.3." into 1.2.3.0), and Number also accepts "1e2",
  // "0x10", " 24", "+24", all of which would parse into a wrong-but-
  // plausible address instead of throwing.
  if (octets.length !== 4 || octets.some((p) => !/^\d{1,3}$/.test(p))) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  const parts = octets.map((p) => Number(p));
  if (parts.some((p) => p > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return ((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!;
}

export function intToIpv4(n: number): string {
  return [
    Math.floor(n / 16777216) % 256,
    Math.floor(n / 65536) % 256,
    Math.floor(n / 256) % 256,
    n % 256,
  ].join(".");
}

/**
 * Express an arbitrary IPv4 range [start, end] as one or more aligned CIDR
 * prefixes. RIR delegated-stats files allow non-power-of-two block sizes;
 * this returns the canonical CIDR list for such ranges.
 */
export function rangeToCidrs(start: number, count: number): string[] {
  const out: string[] = [];
  let cur = start;
  let remaining = count;
  while (remaining > 0) {
    // Largest power of 2 aligned with cur that fits in remaining
    let size = 1;
    let prefix = 32;
    while (
      cur % (size * 2) === 0 &&
      size * 2 <= remaining &&
      prefix > 0
    ) {
      size *= 2;
      prefix -= 1;
    }
    out.push(`${intToIpv4(cur)}/${prefix}`);
    cur += size;
    remaining -= size;
  }
  return out;
}

/**
 * Convert an IPv4 CIDR string (as stored in the `network` inet column) into
 * a [start, end] integer range. Used only by lib/canonical.ts, whose
 * sweep-line overlap resolver needs ordered numeric boundaries to merge
 * intervals — a fundamentally different need from "is this IP contained in
 * that prefix", which is what the `inet` + GiST containment queries
 * elsewhere in this codebase handle. That algorithm is IPv4-only by design
 * (see canonical.ts's own header comment): doing the equivalent sweep over
 * 128-bit IPv6 boundaries would need BigInt arithmetic throughout, which is
 * a separate piece of work, not a mechanical follow-on to this one.
 */
export function ipv4CidrToRange(
  cidr: string,
): { startAddr: number; endAddr: number } | null {
  const slash = cidr.indexOf("/");
  if (slash === -1) return null;
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  let start: number;
  try {
    start = ipv4ToInt(cidr.slice(0, slash));
  } catch {
    return null;
  }
  const size = Math.pow(2, 32 - prefix);
  return { startAddr: start, endAddr: start + size - 1 };
}

export function cidrPrefixOf(count: number): number | null {
  // returns prefix length if count is a power of 2, else null
  if (count <= 0) return null;
  const log = Math.log2(count);
  if (!Number.isInteger(log)) return null;
  return 32 - log;
}

/**
 * Non-public IPv4 space: RFC1918 private ranges, loopback, link-local
 * (169.254.0.0/16 — where cloud instance metadata endpoints live, the
 * range that matters most for SSRF), CGNAT, multicast, and the misc
 * IANA-reserved /8 and /24 blocks. Built once as a `net.BlockList` rather
 * than by hand-rolled bit math: BlockList's subnet containment is part of
 * Node's own tested implementation, not logic this module needs to get
 * right itself.
 */
const IPV4_RESERVED_RANGES: ReadonlyArray<{ network: string; prefixLen: number }> = [
  { network: "0.0.0.0", prefixLen: 8 },
  { network: "10.0.0.0", prefixLen: 8 },
  { network: "100.64.0.0", prefixLen: 10 },
  { network: "127.0.0.0", prefixLen: 8 },
  { network: "169.254.0.0", prefixLen: 16 },
  { network: "172.16.0.0", prefixLen: 12 },
  { network: "192.0.0.0", prefixLen: 24 },
  { network: "192.168.0.0", prefixLen: 16 },
  { network: "224.0.0.0", prefixLen: 4 },
];

const IPV4_RESERVED_BLOCKLIST = new BlockList();
for (const { network, prefixLen } of IPV4_RESERVED_RANGES) {
  IPV4_RESERVED_BLOCKLIST.addSubnet(network, prefixLen, "ipv4");
}

/** Non-public IPv6 space: loopback, unique-local, link-local, multicast. */
const IPV6_RESERVED_RANGES: ReadonlyArray<{ network: string; prefixLen: number }> = [
  { network: "::1", prefixLen: 128 },
  { network: "fc00::", prefixLen: 7 },
  { network: "fe80::", prefixLen: 10 },
  { network: "ff00::", prefixLen: 8 },
];

const IPV6_RESERVED_BLOCKLIST = new BlockList();
for (const { network, prefixLen } of IPV6_RESERVED_RANGES) {
  IPV6_RESERVED_BLOCKLIST.addSubnet(network, prefixLen, "ipv6");
}

/**
 * Expand any syntactically valid textual IPv6 address (compressed `::`
 * form, mixed dotted-quad tail, or fully written) into its 8 16-bit
 * groups. Written by hand instead of reaching for a parsing library
 * because there isn't one in this codebase yet (see the caller's
 * comment on why one wasn't added just for this) — `isIP` is used first
 * wherever this is called so this only ever runs on strings already
 * confirmed to be valid IPv6 literals.
 */
function expandIpv6Groups(ip: string): number[] | null {
  const zoneIdx = ip.indexOf("%");
  const clean = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx);

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const tokens = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (i === tokens.length - 1 && tok.includes(".")) {
        const parts = tok.split(".");
        if (parts.length !== 4) return null;
        const bytes = parts.map((p) => Number(p));
        if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
        groups.push(((bytes[0]! << 8) | bytes[1]!) & 0xffff);
        groups.push(((bytes[2]! << 8) | bytes[3]!) & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return null;
      groups.push(parseInt(tok, 16));
    }
    return groups;
  };

  const doubleColonIdx = clean.indexOf("::");
  if (doubleColonIdx === -1) {
    const groups = parseSide(clean);
    return groups && groups.length === 8 ? groups : null;
  }
  if (clean.indexOf("::", doubleColonIdx + 1) !== -1) return null; // more than one "::"
  const leftGroups = parseSide(clean.slice(0, doubleColonIdx));
  const rightGroups = parseSide(clean.slice(doubleColonIdx + 2));
  if (leftGroups === null || rightGroups === null) return null;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (missing < 0) return null;
  return [...leftGroups, ...new Array(missing).fill(0), ...rightGroups];
}

/**
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`, or its all-hex equivalent) unwrapped
 * to the plain dotted-quad it represents, or null if `groups` isn't that
 * shape. Needed so a private IPv4 target can't be smuggled past an IPv6
 * literal check by wrapping it — see `isPubliclyRoutable`'s doc comment.
 */
function unwrapIpv4Mapped(groups: number[]): string | null {
  if (!groups.slice(0, 5).every((g) => g === 0) || groups[5] !== 0xffff) return null;
  const g6 = groups[6]!;
  const g7 = groups[7]!;
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join(".");
}

/**
 * Is `ip` (a single already-resolved address, v4 or v6) a normal public
 * unicast address — i.e. safe to let this server make an outbound
 * connection to on an attacker's say-so?
 *
 * Exists for the RDAP geofeed fetch in lookup/rdap.ts: RFC 9092 lets
 * whoever holds an IP delegation publish a geofeed URL pointing anywhere
 * at all, so before this codebase fetches one, every DNS-resolved address
 * for it has to clear this check — including IPv4-mapped IPv6 literals,
 * which unwrap to their IPv4 form and get re-checked against the same
 * rules, so `::ffff:169.254.169.254` doesn't sneak past as "just an IPv6
 * address". Returns false (never throws) for anything unparseable, so
 * callers can fail closed by default.
 */
export function isPubliclyRoutable(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return !IPV4_RESERVED_BLOCKLIST.check(ip, "ipv4");
  }
  if (family === 6) {
    const groups = expandIpv6Groups(ip);
    if (!groups) return false;
    const mapped = unwrapIpv4Mapped(groups);
    if (mapped) return !IPV4_RESERVED_BLOCKLIST.check(mapped, "ipv4");
    return !IPV6_RESERVED_BLOCKLIST.check(ip, "ipv6");
  }
  return false;
}
