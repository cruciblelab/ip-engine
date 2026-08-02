import { isIP } from "node:net";

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
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
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
