/**
 * `geo-confidence.ts` — how much to trust an *inferred* city, and saying so.
 *
 * ## The measurement
 *
 * Run 2026-08-24 against four operators' own RFC 8805 geofeeds — the network
 * owner stating where their own addresses are, which is the only honest
 * yardstick available. DB-IP Lite was asked the same question `ip_intel`'s
 * `dbip` LATERAL asks, and the answers compared. Full write-up: `docs/101`.
 *
 * | operator | kind         | per-prefix | **per-address** | /24-or-wider |
 * |----------|--------------|-----------:|----------------:|-------------:|
 * | Charter  | consumer ISP |      14.9% |       **76.2%** |        82.2% |
 * | Google   | datacenter   |      81.0% |       **86.4%** |        82.0% |
 * | T-Mobile | mobile ISP   |      21.9% |       **78.1%** |        85.4% |
 * | NTT      | transit/DC   |      69.7% |           53.4% |        75.1% |
 *
 * Country, separately, is right 81-98% everywhere. Only the city is at issue.
 *
 * ## Why one number, not a split
 *
 * The first version of this file shipped 0.7 for datacenter space and 0.3 for
 * everything else, on the per-prefix column above. **That was wrong, and the
 * way it was wrong is worth keeping written down.**
 *
 * Averaging per *prefix* weights a /30 the same as a /16. Charter publishes
 * 346k of its 416k prefixes as /29s and /30s — individual customer
 * assignments — so the "consumer" figure was overwhelmingly measuring one
 * question: *which household is this?* DB-IP's data has roughly /24
 * resolution, so the answer collapses exactly where the question passes that
 * line, and does so cleanly:
 *
 *     operator's prefix    /19-/24   /25    /26    /27    /28    /29   /30
 *     DB-IP correct         81-84%  56.3%  35.5%  21.6%  11.9%  9.2%  8.0%
 *
 * Weighted by address — which is what a random IP lookup actually draws from
 * — consumer space is 76.2%, against datacenter's 86.4%. A real gap, but
 * nothing like the 15.6%-vs-74.3% the first version encoded, and not enough
 * to justify treating the two as different tiers. Restricted to questions at
 * or above DB-IP's own resolution, the gap disappears entirely (82.2% vs
 * 82.0%).
 *
 * Two other splits were tested against the same data and rejected:
 *
 *   - **The matched range's own width does not predict accuracy.** Holding
 *     the operator's prefix size fixed at /24, DB-IP scored 82.3% when its
 *     matching range was also a /24 and 79.3% when it was wider. It is
 *     reported to callers as `geo_network` because it is a true fact about
 *     the claim's extent, but it is deliberately not used here.
 *   - **Datacenter detection is unreliable anyway.** 12 of 12 sampled real
 *     NTT datacenter addresses classified as `residential`/`unknown`, since
 *     `cloud_ranges` only lists the big public clouds. A split that cannot
 *     be applied correctly is worse than no split.
 *
 * So: **0.6, for every inferred city.** Below the 76-86% measured, because
 * NTT's 53.4% is inside the range and the sample is four operators in two
 * countries. Approximating measured reality, not marketing.
 *
 * ## Removing this
 *
 * Delete this file and its test, drop the import and the `inferredGeo` block
 * in `lookup.ts`, and restore the two literals that were there before:
 * `dbipRow ? (countryConflict ? 0.4 : 0.5)` and `geoMeta ? (countryConflict ?
 * 0.15 : 0.2)`. Then remove `"geo:city-approximate"` from the flags block in
 * the same file, and its two mentions in `packages/api-spec/openapi.yaml`
 * (`IpLookupConfidence.geo`'s description and `flags`'), then re-run codegen.
 *
 * **Keep the `const isCloudOrHosting` line** in `lookup.ts` if it is still
 * there: `assessRisk` further down takes it as an argument. (This file no
 * longer uses it — see the rejected splits above — so it may already have
 * been inlined back into that call.)
 *
 * Nothing else imports any of it, and geo *values* are unaffected either way:
 * this file only ever decides how loudly to doubt them.
 *
 * **`geo.geo_network` is a separate feature and survives all of the above.**
 * It landed in the same change and is described here only so the two are not
 * confused: it is the prefix the geo answer describes, it has no dependency
 * on this file, and removing this file leaves it working. To remove *it*
 * instead: drop the `geo_network` field from `GeoBlock` and its seven call
 * sites in `lookup.ts`, the `network:` line from the geofeed and DB-IP
 * selects in the same file, the assertions in
 * `geo-tiers.integration.test.ts`, the two-line block in
 * `apps/cli/src/commands/lookup.ts`, and the field plus its `required` entry
 * in `openapi.yaml`, then re-run codegen.
 */

/** Which inferred tier produced the city being scored. */
export type InferredGeoSource = "dbip-lite" | "country-estimate";

export interface InferredGeoConfidence {
  /** 0-1, comparable with the geofeed's own 0.8-0.85 and nothing else. */
  score: number;
  /**
   * Whether the caller should be told outright that this city is inferred,
   * rather than left to work it out from a number they may never read.
   * True for every tier here — none of them is operator-published. Drives
   * the `geo:city-approximate` flag.
   */
  cityApproximate: boolean;
}

/**
 * A DB-IP per-range guess. Measured 76.2-86.4% per address across three of
 * the four operators, 53.4% on the fourth; 0.6 sits under the range rather
 * than in the middle of it, which is the right direction to be wrong in for
 * a source whose whole job is to be a labelled guess.
 */
const DBIP_LITE = 0.6;
/**
 * "The most populous place in this country" — not a per-range claim at all.
 * Unchanged from what this codebase used before any of this work; no
 * measurement here speaks to it, and inventing a number for it would be the
 * same unsupported precision this file exists to avoid.
 */
const COUNTRY_ESTIMATE = 0.2;

/**
 * What a country/ASN disagreement costs. Applied identically to both tiers,
 * as it was before: it is evidence about the *record*, not about the
 * geolocation method, so it should not scale with the method's accuracy.
 */
const COUNTRY_CONFLICT_PENALTY = 0.05;

export function inferredGeoConfidence(opts: {
  source: InferredGeoSource;
  countryConflict: boolean;
}): InferredGeoConfidence {
  const base = opts.source === "country-estimate" ? COUNTRY_ESTIMATE : DBIP_LITE;
  const score = opts.countryConflict ? base - COUNTRY_CONFLICT_PENALTY : base;
  return {
    // 0.6 - 0.05 is 0.5499999999999999 in IEEE 754, and that would be served
    // verbatim in a JSON response.
    score: Math.round(score * 100) / 100,
    cityApproximate: true,
  };
}
