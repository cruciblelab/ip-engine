import {
  pgTable,
  integer,
  text,
  doublePrecision,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * `geonames_places` — a local copy of GeoNames' free city gazetteer
 * (cities5000.zip: every place with population > 5000 or a capital,
 * https://download.geonames.org/export/dump/, CC BY 4.0, see SOURCES.md).
 *
 * This is infrastructure, not a live dependency: downloaded once, kept
 * locally, never queried over the network at lookup time. Its only job is
 * turning a city *name* (extracted from whois text — see
 * enrichment.ts's LACNIC/APNIC parsers) into real coordinates and an
 * admin1/admin2 (province/district) code, since none of the RIR/BGP/threat
 * sources carry that themselves.
 */
export const geonamesPlacesTable = pgTable(
  "geonames_places",
  {
    geonameId: integer("geoname_id").primaryKey(),
    name: text("name").notNull(),
    asciiName: text("ascii_name").notNull(),
    countryCode: text("country_code").notNull(),
    admin1Code: text("admin1_code"),
    admin2Code: text("admin2_code"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    population: bigint("population", { mode: "number" }).notNull().default(0),
    timezone: text("timezone"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Matching path is always "this name, in this country" — see
    // lib/geocode.ts. lower() so lookups are case-insensitive without
    // needing a citext extension.
    nameCountryIdx: index("geonames_places_name_country_idx").on(
      t.countryCode,
      t.asciiName,
    ),
  }),
);

export type GeonamesPlace = typeof geonamesPlacesTable.$inferSelect;
export type InsertGeonamesPlace = typeof geonamesPlacesTable.$inferInsert;

/**
 * `geonames_admin1` — code -> human-readable name for first-level admin
 * divisions (province/state), e.g. "TR.34" -> "Istanbul". Tiny reference
 * table (~4000 rows worldwide), from GeoNames' admin1CodesASCII.txt.
 */
export const geonamesAdmin1Table = pgTable("geonames_admin1", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  asciiName: text("ascii_name").notNull(),
  geonameId: integer("geoname_id"),
});

export type GeonamesAdmin1 = typeof geonamesAdmin1Table.$inferSelect;
export type InsertGeonamesAdmin1 = typeof geonamesAdmin1Table.$inferInsert;
