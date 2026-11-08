import { pgTable, serial, text, inet, doublePrecision, timestamp, index } from "drizzle-orm/pg-core";

/**
 * `dbip_lite_ranges` — a computed, third-party geolocation guess (DB-IP
 * Lite, CC BY 4.0) used only as a fallback tier between a real
 * operator-published geofeed (`geofeed_ranges`) and the crude
 * "most populous place in the whole country" estimate (`geo-meta.ts`).
 *
 * Deliberately a separate table from `geofeed_ranges`, not another
 * `source_id` row in it: `geofeed_ranges` is documented as operator-
 * published data the codebase trusts more than a guess, and its LATERAL
 * join in `ip-intel.ts` breaks ties on `confidence DESC` at equal prefix
 * specificity — mixing an *inferred* source into that table risks a
 * lower-confidence DB-IP row outranking a real, less-specific geofeed
 * whenever DB-IP happens to have a narrower prefix for the same address.
 * Kept separate, this table can never win over a real geofeed hit
 * regardless of prefix specificity — see `ip-intel.ts`'s `dbip` LATERAL,
 * which only applies when no geofeed covers the address at all.
 *
 * IPv4 only for now (see the ingestion function's own header comment for
 * why) — `network` stays a native `inet` column for consistency and to
 * make adding IPv6 later a data-only change, not a schema change.
 */
export const dbipLiteRangesTable = pgTable(
  "dbip_lite_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkSpgist: index("dbip_lite_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
  }),
);

export type DbipLiteRange = typeof dbipLiteRangesTable.$inferSelect;
export type InsertDbipLiteRange = typeof dbipLiteRangesTable.$inferInsert;
