/**
 * The "resale" `.mmdb` profile: the same build as the served file, minus
 * what may not be handed to a buyer as a copy (`docs/106`, "Selling the
 * `.mmdb` itself"), plus the attribution that must travel with it.
 *
 * Selling API answers and selling the file are different acts — the file
 * *is* a copy of the data. Three things differ for a copy:
 *
 *  - `asn_name` comes from CAIDA, whose licence is "non-transferable" and
 *    grants only "to copy, modify, and use the data" (B3). Not in a sold copy.
 *  - A `country` whose only source is the RIPE NCC's delegated stats (the
 *    `country-estimate` fallback on a RIPE-region block) — RIPE's Copyright
 *    Statement requires written authorisation for commercial use (A2).
 *  - `rpki_status` — the RPKI data's own terms (B5) have not been read yet.
 *    Excluded until they are; one config edit puts it back.
 *
 * All three are config (`resaleMmdbExcludeFields`,
 * `resaleMmdbDropCountryFallbackRirs`), so each can change when its
 * licensing question is answered, without a code change.
 *
 * Kept pure — no database, no I/O — so the rules are unit-tested directly
 * (`resale-profile.test.ts`) rather than only through a multi-hour build.
 */
import { KNOWN_ENRICHMENT_SOURCES } from "../enrichment/enrichment-sources";

/** Every key `toRecord()` in mmdb-export.ts can put into a record. */
export const MMDB_RECORD_FIELDS = [
  "country",
  "city",
  "region",
  "postal",
  "location",
  "geo_source",
  "asn",
  "asn_name",
  "asn_size_rank",
  "cloud_provider",
  "rpki_status",
  "special_purpose",
  "verified_bot",
  "verified_bot_operator",
  "stable_since",
  "is_cloud",
  "is_anycast",
  "is_threat",
  "is_tor",
  "is_vpn",
] as const;

export const RESALE_DEFAULT_EXCLUDED_FIELDS = ["asn_name", "rpki_status"];
export const RESALE_DEFAULT_DROP_COUNTRY_FALLBACK_RIRS = ["ripencc"];

export interface ResaleOptions {
  excludeFields: string[];
  /** RIRs (as `ip_intel.rir` spells them) whose registry country must not
   * appear as the only geo answer. */
  dropCountryFallbackRirs: string[];
}

/**
 * Applies the resale rules to one built record, in place, and returns it.
 * `geoSource` and `rir` are the row's own values, read before any field was
 * removed (`geo_source` itself may be one of the excluded fields).
 */
export function applyResaleProfile(
  record: Record<string, unknown>,
  row: { geo_source: string | null; rir: string | null },
  opts: ResaleOptions,
): Record<string, unknown> {
  if (
    row.geo_source === "country-estimate" &&
    row.rir !== null &&
    opts.dropCountryFallbackRirs.includes(row.rir)
  ) {
    // The country is the registry's, and nothing else located this block:
    // drop the answer along with the label that says where it came from.
    delete record["country"];
    delete record["geo_source"];
  }
  for (const field of opts.excludeFields) delete record[field];
  return record;
}

/**
 * RouteViews' required boilerplate, verbatim from
 * `routeviews.org/routeviews/licenses/` (read 2026-11-08, `docs/103`).
 */
const ROUTEVIEWS_BOILERPLATE =
  "With contributions from network operators and volunteers all over the world, RouteViews collects BGP data " +
  "by direct peering at Internet Exchange Points (IXPs) or multi-hop peering. Data are archived and made publicly " +
  "available for download at archive.routeviews.org, lg.routeviews.org, and api.routeviews.org.";

/** Registry ids whose data can be in a resale file and whose licence requires attribution. */
const ATTRIBUTED_SOURCE_IDS = ["routeviews-rib-ipv4", "dbip-lite", "geonames-cities"];

/**
 * The attribution that travels with a resale file — written beside it as
 * ATTRIBUTION.txt. Built from the registry's own `attributionText` fields so
 * it cannot drift from what `docs/103` and the Sources page say.
 */
export function resaleAttributionText(opts: ResaleOptions, builtAt: Date): string {
  const lines: string[] = [
    "IP-Insight-Engine — resale .mmdb",
    `Built: ${builtAt.toISOString()}`,
    "",
    "This database contains data from the following sources, used under their licences:",
    "",
  ];
  for (const id of ATTRIBUTED_SOURCE_IDS) {
    const s = KNOWN_ENRICHMENT_SOURCES.find((k) => k.id === id);
    if (!s?.license?.attributionText) continue;
    lines.push(`- ${s.license.attributionText}`);
    lines.push(`  Licence: ${s.license.name}`);
  }
  lines.push(
    "",
    "About RouteViews:",
    ROUTEVIEWS_BOILERPLATE,
    "",
    "Creative Commons Attribution 4.0: https://creativecommons.org/licenses/by/4.0/",
    "Parts of this database derived from CC BY 4.0 material remain under that licence: you may",
    "reuse and share those parts under its terms, provided the attribution above is kept.",
    "",
    "Deliberately not included in this file:",
  );
  if (opts.excludeFields.length > 0) lines.push(`- fields: ${opts.excludeFields.join(", ")}`);
  if (opts.dropCountryFallbackRirs.length > 0) {
    lines.push(`- registry-only country answers for blocks held by: ${opts.dropCountryFallbackRirs.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}
