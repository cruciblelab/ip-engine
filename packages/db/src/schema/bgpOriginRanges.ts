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
 * routing tables, refreshed daily — from RIPE RIS whois dumps or RouteViews
 * RIB snapshots, whichever `bgpOriginSource` selects (one project at a time;
 * `source` records which registry id wrote each row).
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
    // Every ingester writes its registry id explicitly; the default is a
    // historical leftover, kept only so existing rows stay valid.
    source: text("source").notNull().default("ripe-ris"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("bgp_origin_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    asnIdx: index("bgp_origin_ranges_asn_idx").on(t.asn),
    // `source` is part of the key on purpose (2026-11-08, `docs/106` Phase
    // 1 log). With only (network, asn), the first run after switching
    // `bgpOriginSource` lost ~98% of the new project's rows: they collided
    // with the old project's identical (prefix, origin) pairs, were dropped
    // by ON CONFLICT DO NOTHING, and the purge then deleted the old rows
    // they had collided with — measured on real data at 24,527 of
    // 1,170,244 RouteViews IPv4 rows surviving. Each source owns its rows
    // outright now, so two projects coexist for exactly the one run in
    // which the purge removes the deselected one.
    networkAsnSourceUnique: uniqueIndex("bgp_origin_ranges_network_asn_source_unique").on(
      t.network,
      t.asn,
      t.source,
    ),
  }),
);

export type BgpOriginRange = typeof bgpOriginRangesTable.$inferSelect;
export type InsertBgpOriginRange = typeof bgpOriginRangesTable.$inferInsert;
