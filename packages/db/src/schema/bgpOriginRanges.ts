import {
  bigint,
  pgTable,
  serial,
  text,
  inet,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `bgp_origin_ranges` — prefix -> origin-ASN mapping derived from real BGP
 * routing tables (RIPE RIS whois dumps), refreshed daily.
 *
 * Why this table exists (Layer 1 hardening):
 * RIR delegated-stats files only carry ASN *number* allocations, never
 * IP->ASN. The previous design resolved that at request time via a live
 * call to RIPE Stat's network-info API. That works fine for IPs that get
 * looked up constantly (well-known DNS resolvers, big cloud ranges — the
 * request is fast and reliably answered), but is exactly the kind of
 * single-point-of-failure that silently degrades for everything else: any
 * RIPE Stat slowness, rate limiting, or the 5s client timeout produces a
 * null ASN with no visible error, so a mid-size ISP prefix (e.g. Turk
 * Telekom / AS9121) can come back with no ASN at all despite being fully
 * announced and completely ordinary.
 *
 * Ingesting the RIS whois dump ahead of time turns ASN resolution into a
 * local index lookup — no live third-party call, no rate limit, uniform
 * reliability regardless of the ASN's size or popularity. The live RIPE
 * Stat call is kept only as a fallback for prefixes this table hasn't
 * picked up yet (see lib/lookup.ts).
 *
 * `network` is a native `inet` column (both IPv4 and IPv6 origin prefixes
 * live in the same table/column now). Prefixes genuinely overlap here (a
 * /17 and a /22 announced by different — or the same — ASN both exist),
 * so resolution is a real longest-prefix match: `ORDER BY masklen(network)
 * DESC` — there's no separately stored prefix-length column to keep in
 * sync, Postgres derives it from the `inet` value itself.
 */
export const bgpOriginRangesTable = pgTable(
  "bgp_origin_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    // bigint, not integer: 4-byte ASNs (RFC 6793) run to 4294967295, while
    // Postgres `integer` is signed 32-bit and stops at 2147483647. The
    // private-use range 4200000000-4294967294 (RFC 6996) is above that line
    // and does appear in real routing and RPKI data — an `integer` column
    // fails the whole insert batch when it does.
    asn: bigint("asn", { mode: "number" }).notNull(),
    peerCount: integer("peer_count").notNull().default(0),
    source: text("source").notNull().default("ripe-ris"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("bgp_origin_ranges_network_gist").using("gist", t.network.op("inet_ops")),
    asnIdx: index("bgp_origin_ranges_asn_idx").on(t.asn),
    networkAsnUnique: uniqueIndex("bgp_origin_ranges_network_asn_unique").on(
      t.network,
      t.asn,
    ),
  }),
);

export type BgpOriginRange = typeof bgpOriginRangesTable.$inferSelect;
export type InsertBgpOriginRange = typeof bgpOriginRangesTable.$inferInsert;
