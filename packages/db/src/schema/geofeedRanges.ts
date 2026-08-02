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
    networkGist: index("geofeed_ranges_network_gist").using("gist", t.network.op("inet_ops")),
    networkSourceUnique: uniqueIndex("geofeed_ranges_network_source_unique").on(
      t.network,
      t.sourceId,
    ),
  }),
);

export type GeofeedRange = typeof geofeedRangesTable.$inferSelect;
export type InsertGeofeedRange = typeof geofeedRangesTable.$inferInsert;
