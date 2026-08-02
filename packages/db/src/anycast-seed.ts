/**
 * Curated list of well-known public anycast prefixes, and the function that
 * seeds `anycast_ranges` from it. Owned here — not in `@workspace/lookup`,
 * where the table itself was first used — specifically so `@workspace/
 * collector` can seed it too without depending on `@workspace/lookup` (see
 * that package's own header comment for why collector and lookup stay
 * independent of each other). `@workspace/lookup`'s own fast in-memory
 * anycast check (lookup/anycast.ts) builds its static list from this same
 * data, so there is exactly one place this list is written down.
 *
 * Idempotent via `ON CONFLICT DO NOTHING` on the network unique index —
 * safe to call every time (every enrichment run, every server boot),
 * cheap when already seeded.
 */
import { db } from "./index";
import { anycastRangesTable } from "./schema";

export interface CuratedAnycastEntry {
  cidr: string;
  label: string;
  operator: string;
}

/**
 * Sources:
 *   - Cloudflare 1.1.1.1 / 1.0.0.1 public resolvers
 *   - Google Public DNS 8.8.8.8 / 8.8.4.4
 *   - Quad9 9.9.9.9 / 149.112.112.112
 *   - OpenDNS 208.67.222.222 / 208.67.220.220
 *   - IANA root DNS letters (subset, all anycast)
 *
 * Kept as /24 or smaller so this never accidentally classifies a
 * non-anycast neighbor as distributed.
 */
export const CURATED_ANYCAST_RANGES: CuratedAnycastEntry[] = [
  { cidr: "1.1.1.0/24", label: "Cloudflare 1.1.1.1 public DNS", operator: "cloudflare" },
  { cidr: "1.0.0.0/24", label: "Cloudflare 1.0.0.1 public DNS", operator: "cloudflare" },
  { cidr: "8.8.8.0/24", label: "Google Public DNS", operator: "google" },
  { cidr: "8.8.4.0/24", label: "Google Public DNS secondary", operator: "google" },
  { cidr: "9.9.9.0/24", label: "Quad9 DNS", operator: "quad9" },
  { cidr: "149.112.112.0/24", label: "Quad9 DNS secondary", operator: "quad9" },
  { cidr: "208.67.222.0/24", label: "OpenDNS / Cisco Umbrella", operator: "opendns" },
  { cidr: "208.67.220.0/24", label: "OpenDNS / Cisco Umbrella", operator: "opendns" },
  { cidr: "198.41.0.0/24", label: "a.root-servers.net", operator: "iana" },
  { cidr: "199.9.14.0/24", label: "b.root-servers.net", operator: "iana" },
  { cidr: "192.33.4.0/24", label: "c.root-servers.net", operator: "iana" },
  { cidr: "199.7.91.0/24", label: "d.root-servers.net", operator: "iana" },
  { cidr: "192.203.230.0/24", label: "e.root-servers.net", operator: "iana" },
  { cidr: "192.5.5.0/24", label: "f.root-servers.net", operator: "iana" },
  { cidr: "192.112.36.0/24", label: "g.root-servers.net", operator: "iana" },
  { cidr: "198.97.190.0/24", label: "h.root-servers.net", operator: "iana" },
  { cidr: "192.36.148.0/24", label: "i.root-servers.net", operator: "iana" },
  { cidr: "192.58.128.0/24", label: "j.root-servers.net", operator: "iana" },
  { cidr: "193.0.14.0/24", label: "k.root-servers.net", operator: "iana" },
  { cidr: "199.7.83.0/24", label: "l.root-servers.net", operator: "iana" },
  { cidr: "202.12.27.0/24", label: "m.root-servers.net", operator: "iana" },
];

/** Returns the number of newly inserted rows. */
export async function seedAnycastTable(): Promise<number> {
  if (CURATED_ANYCAST_RANGES.length === 0) return 0;
  const inserted = await db
    .insert(anycastRangesTable)
    .values(
      CURATED_ANYCAST_RANGES.map((e) => ({
        network: e.cidr,
        label: e.label,
        operator: e.operator,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: anycastRangesTable.id });
  return inserted.length;
}
