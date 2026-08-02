/**
 * Country-derived geo estimate — the fallback used when no operator-
 * published geofeed covers an IP's prefix, so all we know is its
 * registered country.
 *
 * The RIR delegated-stats files only carry a country code — no city,
 * lat/lon, or timezone. Most commercial IP-info providers still return
 * *something* for city/coordinates in this situation rather than leaving
 * the field empty; the honest way to match that without pretending to
 * know more than we do is: pick the most populous place GeoNames knows
 * for that country, return it, and mark it clearly as a coarse estimate
 * (via `geo_source: "country-estimate"` and a low confidence score in the
 * caller) — never silently blended with a real per-operator geofeed hit,
 * and never presented as equally trustworthy.
 *
 * Backed by the same local `geonames_places` table geocode.ts already
 * uses for LACNIC city-name resolution — no live query, no new
 * dependency, and coverage is essentially every country (not the ~55
 * this used to hardcode), since GeoNames has data for nearly all of them.
 */
import { desc, eq } from "drizzle-orm";
import { db, geonamesPlacesTable } from "@workspace/db";

export interface CountryGeoEstimate {
  /** Most populous place GeoNames has for this country — not necessarily
   * the capital, but a reasonable "somewhere in this country" anchor. */
  city: string;
  /** GeoNames admin1 code (province/state), same format as the geofeed
   * path's `region` field — a code, not a human-readable name (see
   * geonamesAdmin1Table, not yet wired up for name lookup). */
  region: string | null;
  latitude: number;
  longitude: number;
  timezone: string | null;
}

/**
 * Returns a coarse geo estimate for a country code, or `null` when we have
 * no GeoNames data for it at all (e.g. an unrecognized/reserved code).
 */
export async function geoForCountry(
  country: string | null,
): Promise<CountryGeoEstimate | null> {
  if (!country) return null;
  const code = country.trim().toUpperCase();
  if (code.length !== 2) return null;

  const [row] = await db
    .select({
      asciiName: geonamesPlacesTable.asciiName,
      admin1Code: geonamesPlacesTable.admin1Code,
      latitude: geonamesPlacesTable.latitude,
      longitude: geonamesPlacesTable.longitude,
      timezone: geonamesPlacesTable.timezone,
    })
    .from(geonamesPlacesTable)
    .where(eq(geonamesPlacesTable.countryCode, code))
    .orderBy(desc(geonamesPlacesTable.population))
    .limit(1);

  if (!row) return null;
  return {
    city: row.asciiName,
    region: row.admin1Code,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
  };
}
