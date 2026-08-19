/**
 * Turn a city name (from whois text — LACNIC's structured `city:` field
 * today, potentially APNIC's free-text `descr:` later) into real
 * coordinates, matched against the local GeoNames gazetteer (see
 * enrichment-sources.ts's "geonames-cities" source).
 *
 * Deliberately exact-match only (case-insensitive, ASCII-normalized) — no
 * fuzzy/typo-tolerant matching. Real whois data has real typos (LACNIC's
 * own dump has at least one "Guamtemala City" for "Guatemala City"), and a
 * fuzzy matcher would occasionally match the *wrong* city with a similar
 * name — worse than the honest "no match" this returns instead. Matches
 * the project's rule throughout: never dress up a guess as a fact.
 */
import { and, eq, sql, desc } from "drizzle-orm";
import { db, geonamesPlacesTable } from "@workspace/db";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  admin1: string | null;
  admin2: string | null;
}

export async function geocodeCityName(
  cityName: string,
  countryCode: string,
): Promise<GeocodeResult | null> {
  const cleaned = cityName.trim();
  const country = countryCode.trim().toUpperCase();
  if (!cleaned || !country) return null;

  const rows = await db
    .select({
      latitude: geonamesPlacesTable.latitude,
      longitude: geonamesPlacesTable.longitude,
      admin1: geonamesPlacesTable.admin1Code,
      admin2: geonamesPlacesTable.admin2Code,
    })
    .from(geonamesPlacesTable)
    .where(
      and(
        eq(geonamesPlacesTable.countryCode, country),
        sql`lower(${geonamesPlacesTable.asciiName}) = lower(${cleaned})`,
      ),
    )
    // Ties (same city name, same country — e.g. two small towns sharing a
    // name) go to the more populous match: whois text naming a common
    // place name is far more likely to mean the well-known one.
    .orderBy(desc(geonamesPlacesTable.population))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    admin1: row.admin1,
    admin2: row.admin2,
  };
}
