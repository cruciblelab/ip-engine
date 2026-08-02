/**
 * Anycast detection.
 *
 * Anycast IPs are advertised from many physical locations at once, so any
 * single geographic answer would be misleading. The lookup pipeline reports
 * `geo.geo_source = "anycast"` (city/region/coordinates all null) and
 * `anycast = true` for IPs in any of these well-known prefixes.
 *
 * Two layers are consulted:
 *   1. A static, hard-coded list of widely known public-DNS / CDN anycast
 *      prefixes (no DB round-trip required).
 *   2. The `anycast_ranges` table, which mirrors the same data and lets
 *      operators add private/internal anycast prefixes without redeploying.
 *
 * The static set is consulted first since it covers >95% of real lookups
 * and avoids the DB hop entirely on the hot path. It's IPv4-only and stays
 * an in-memory integer binary search — that's an implementation detail of
 * this one static list, independent of `anycast_ranges`, which is a real
 * `inet` column and works for IPv6 anycast prefixes too (root DNS letters
 * announce IPv6 anycast as well; add them to the DB table, not here, if
 * you want the fast static path — this list intentionally stays small).
 */
import { sql } from "drizzle-orm";
import { db, anycastRangesTable, CURATED_ANYCAST_RANGES, seedAnycastTable as seedAnycastTableFromDb } from "@workspace/db";
import { ipv4ToInt } from "@workspace/shared";

export interface AnycastInfo {
  isAnycast: boolean;
  label: string | null;
  operator: string | null;
}

interface StaticAnycastEntry {
  cidr: string;
  startAddr: number;
  endAddr: number;
  label: string;
  operator: string;
}

/**
 * Build a static IPv4 anycast range from a CIDR. Used at module load time;
 * we never accept invalid CIDRs at runtime so this throws on bad input.
 */
function staticRange(
  cidr: string,
  label: string,
  operator: string,
): StaticAnycastEntry {
  const slash = cidr.indexOf("/");
  if (slash === -1) throw new Error(`Bad anycast CIDR: ${cidr}`);
  const ip = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  const start = ipv4ToInt(ip);
  const size = Math.pow(2, 32 - prefix);
  return {
    cidr,
    startAddr: start,
    endAddr: start + size - 1,
    label,
    operator,
  };
}

/**
 * Built from `@workspace/db`'s `CURATED_ANYCAST_RANGES` — the single place
 * this list is written down (see that file's header for why it lives in
 * `db`, not here). This is just the fast in-memory shape of the same data.
 */
const STATIC_ANYCAST: StaticAnycastEntry[] = CURATED_ANYCAST_RANGES.map((e) =>
  staticRange(e.cidr, e.label, e.operator),
);

// Pre-sort by start address so a binary-search style lookup stays cheap.
STATIC_ANYCAST.sort((a, b) => a.startAddr - b.startAddr);

/**
 * Synchronous, in-memory anycast match against the curated static list.
 * O(log n) over a tiny constant — well under 1µs per call. IPv4 only.
 */
function matchStatic(ipInt: number): AnycastInfo | null {
  let lo = 0;
  let hi = STATIC_ANYCAST.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = STATIC_ANYCAST[mid]!;
    if (ipInt < entry.startAddr) {
      hi = mid - 1;
    } else if (ipInt > entry.endAddr) {
      lo = mid + 1;
    } else {
      return {
        isAnycast: true,
        label: entry.label,
        operator: entry.operator,
      };
    }
  }
  return null;
}

/**
 * Fall back to the operator-managed table for prefixes not in the static
 * set. Works for both IPv4 and IPv6 — `network` is a real `inet` column,
 * matched via Postgres's own containment operator against its GiST index.
 * Longest-prefix match (masklen desc) in case ranges ever overlap.
 */
async function matchTable(ip: string): Promise<AnycastInfo | null> {
  const rows = await db
    .select({
      label: anycastRangesTable.label,
      operator: anycastRangesTable.operator,
    })
    .from(anycastRangesTable)
    .where(sql`${anycastRangesTable.network} >>= ${ip}::inet`)
    .orderBy(sql`masklen(${anycastRangesTable.network}) desc`)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    isAnycast: true,
    label: row.label ?? null,
    operator: row.operator ?? null,
  };
}

/**
 * Public entry point used by the lookup pipeline. `ip` must already be
 * normalized (see lib/ip-normalize.ts) by the caller.
 *
 * Returns a non-null `AnycastInfo` only when the IP is in a known anycast
 * range; otherwise returns null (callers treat null as "not anycast").
 */
export async function detectAnycast(ip: string): Promise<AnycastInfo | null> {
  if (!ip.includes(":")) {
    try {
      const fast = matchStatic(ipv4ToInt(ip));
      if (fast) return fast;
    } catch {
      // Not a parseable IPv4 dotted-quad (shouldn't happen — the caller
      // already validated family) — fall through to the DB check.
    }
  }
  return matchTable(ip);
}

/**
 * Re-exported for backward compatibility — existing callers (`apps/server`)
 * import this from `@workspace/lookup`. The actual implementation lives in
 * `@workspace/db` now, specifically so `@workspace/collector` can also call
 * it (from every enrichment run — see enrichment.ts) without depending on
 * `@workspace/lookup`. Before that change, this table was only ever seeded
 * when `apps/server` had been started at least once — a CLI-only deployment
 * (collector + db, no server, no lookup) silently never got it, so
 * `ip_intel.is_anycast` disagreed with this file's own `detectAnycast`
 * (which has always had its own in-memory fallback) for every well-known
 * anycast address.
 */
export const seedAnycastTable = seedAnycastTableFromDb;
