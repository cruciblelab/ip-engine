import {
  pgTable,
  serial,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `asn_reach` — per-ASN size/visibility metrics, derived entirely from data
 * this project already holds (`bgp_origin_ranges`, i.e. the RIPE RIS whois
 * dumps). No download, no third-party API, no separate license: it is a
 * single SQL aggregation over a table we ingest anyway.
 *
 * What it measures — and what it deliberately does NOT:
 * These columns describe an ASN's *origination footprint*: how much address
 * space it announces to the internet itself, across how many prefixes, and
 * how widely those announcements are seen. That answers "how big is this
 * network's own presence".
 *
 * It is NOT a customer cone. A customer cone ("how many networks sit beneath
 * this one in the transit hierarchy") can only be derived from AS *paths*,
 * which requires full MRT routing dumps and relationship inference — the RIS
 * whois dump we ingest carries prefix -> origin ASN only, no path. The two
 * metrics genuinely disagree for some networks and both are correct about
 * different things: a CDN like Cloudflare (AS13335) originates comparatively
 * little address space but is seen by nearly every route collector, while a
 * legacy address holder announces enormous space with a small footprint
 * otherwise. Read `rank` as "rank by announced IPv4 address space", never as
 * "rank by importance".
 *
 * Refreshed by the `asn-reach` derived enrichment source, which runs after
 * the BGP-origin sources so it always aggregates freshly ingested routes.
 */
export const asnReachTable = pgTable(
  "asn_reach",
  {
    id: serial("id").primaryKey(),
    // bigint, not integer: 4-byte ASNs (RFC 6793) run to 4294967295, while
    // Postgres `integer` is signed 32-bit and stops at 2147483647. The
    // private-use range 4200000000-4294967294 (RFC 6996) is above that line
    // and does appear in real routing and RPKI data — an `integer` column
    // fails the whole insert batch when it does.
    asn: bigint("asn", { mode: "number" }).notNull(),
    /** Rank by announced IPv4 address space, 1 = largest. Dense-ranked, so
     * ASNs announcing identical space share a rank. */
    rank: integer("rank"),
    /** Total prefixes this ASN originates (both families). */
    originatedPrefixes: integer("originated_prefixes"),
    /** IPv6 subset of the above — kept separate because IPv6 address counts
     * are too large to express in the same units as IPv4 (a single /32 is
     * 2^96 addresses), so prefix count is the only comparable v6 measure. */
    originatedPrefixesV6: integer("originated_prefixes_v6"),
    /** Sum of announced IPv4 addresses (2^(32-masklen) per prefix). */
    originatedAddresses: bigint("originated_addresses", { mode: "number" }),
    /** Highest peer_count across this ASN's prefixes: how many RIS route
     * collectors see its best-propagated announcement. A rough proxy for how
     * globally visible / well-connected the network is, and the one column
     * here that captures something closer to reach than to size. */
    peerVisibility: integer("peer_visibility"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    asnUnique: uniqueIndex("asn_reach_asn_unique").on(t.asn),
    rankIdx: index("asn_reach_rank_idx").on(t.rank),
  }),
);

export type AsnReach = typeof asnReachTable.$inferSelect;
export type InsertAsnReach = typeof asnReachTable.$inferInsert;
