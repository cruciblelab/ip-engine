import {
  pgTable,
  serial,
  text,
  inet,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `geofeed_ranges` — per-prefix city/region hints sourced from RFC 8805
 * self-published geofeeds (Layer 2).
 *
 * A geofeed is a CSV an operator publishes themselves, mapping their own
 * prefixes to `country,region,city,postal`. Because the operator is
 * describing their own network, this is materially more trustworthy than
 * guessing a city from the RIR-registered country (which is often just
 * "where the company is legally registered", not where the addresses are
 * actually routed). `confidence` records that provenance so API consumers
 * are never silently handed a guess dressed up as a fact.
 *
 * `network` is a native `inet` column — longest-prefix match is
 * `ORDER BY masklen(network) DESC`, same as bgp_origin_ranges, since a
 * geofeed can carve a big allocation into smaller, more specific
 * city-level prefixes.
 */
/**
 * `source_id` of geofeed rows found *at query time*: when a lookup finds no
 * geofeed for an address, `lookup/rdap.ts` asks the RIR's RDAP server for
 * the network's `geofeed:` link, fetches it, and caches the result here.
 *
 * Those rows are live-collected, not bulk-ingested, so they are kept out of
 * everything customers receive (2026-11-12, operator decision: live and
 * long-running collection stays out of the commercial product). Concretely:
 *  - `ip_intel` (and so the `.mmdb` export) ignores them — `views/ip-intel.ts`;
 *  - DB-IP's "already covered by a geofeed" prune ignores them, or the
 *    `.mmdb` would lose DB-IP's fallback answer under every live row while
 *    also not carrying the live row — `ingestDbIpLiteCsv` in enrichment.ts.
 * The engine's own live lookups (`lookup.ts`) still use them.
 */
export const GEOFEED_LIVE_DISCOVERY_SOURCE_ID = "geofeed-discovery:rdap-live";

export const geofeedRangesTable = pgTable(
  "geofeed_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    postal: text("postal"),
    /**
     * Real coordinates, resolved once at ingestion time by matching `city`
     * against the local geonames_places gazetteer (see lib/geocode.ts) —
     * never geocoded live. Null when the source gave no city name, or no
     * confident match was found (never guessed).
     */
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    admin1: text("admin1"),
    admin2: text("admin2"),
    /** Where this row came from — e.g. "digitalocean", "lacnic-whois-city". */
    sourceId: text("source_id").notNull(),
    /** 0..1 — how much we trust this row. Self-published geofeeds score high. */
    confidence: doublePrecision("confidence").notNull().default(0.8),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("geofeed_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    networkSourceUnique: uniqueIndex("geofeed_ranges_network_source_unique").on(
      t.network,
      t.sourceId,
    ),
  }),
);

export type GeofeedRange = typeof geofeedRangesTable.$inferSelect;
export type InsertGeofeedRange = typeof geofeedRangesTable.$inferInsert;
