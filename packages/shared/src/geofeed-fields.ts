/**
 * Cleaning for one RFC 8805 geofeed CSV row's fields.
 *
 * Shared by every path that ingests a geofeed — the batch enrichment sources
 * in @workspace/collector and the live RDAP discovery in @workspace/lookup —
 * because they parse the same format and were, before this existed, each
 * getting it slightly wrong in their own way.
 *
 * Geofeeds are self-published, and real ones contain real mistakes. Observed
 * in production data from a tier-1 carrier's own feed:
 *
 *   38.79.152.0/24,MONGOLIA,MONGOLIA,ULAANBAATAR,
 *   209.146.32.120/29,HK ,HK ,HONG KONG,
 *   38.32.40.184/29,US,US-PA,PHILADELPHIA ,
 *
 * The country field is specified as ISO 3166-1 alpha-2, and this project's
 * API promises callers exactly that. Passing `MONGOLIA` straight through
 * would break that promise for anyone matching on a two-letter code — so a
 * malformed country is dropped rather than stored, while the rest of the row
 * (the city here is perfectly good) is kept. Dropping the whole row would
 * throw away correct data because one field was wrong; keeping the bad value
 * would mean the response type is a lie. Neither is worth doing.
 */

/** Trim, and treat an empty remainder as absent rather than as `""`. */
export function geofeedField(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * As `geofeedField`, plus the ISO 3166-1 alpha-2 shape the country column is
 * defined to hold. Anything else is a publisher error and becomes null.
 * Upper-cased so a feed written in lowercase doesn't produce a second,
 * unequal spelling of a country already in the database.
 */
export function geofeedCountry(value: string | undefined): string | null {
  const field = geofeedField(value);
  if (field === null) return null;
  return /^[A-Za-z]{2}$/.test(field) ? field.toUpperCase() : null;
}
