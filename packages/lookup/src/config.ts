/**
 * Optional config controlling `lookupIp`'s behavior: which optional
 * signals it computes (`lookupFeatures`), plus performance tuning
 * (in-memory cache size/TTL, reverse-DNS timeout, bulk-lookup concurrency).
 * Every one of these is on/at-its-default with no config file — nothing
 * here changes behavior unless the file exists and sets it.
 *
 * `lookupFeatures`: the signals in `ALL_LOOKUP_FEATURES` below (that list
 * is the authority — a numeral here has already rotted twice) — `asn`,
 * `network_status` (the RIR status), `geo`, `reverse_dns`, `threat`,
 * `usage_type`, `cloud_provider`, `anycast`, `special_purpose` (IANA
 * reserved-range detection), `asn_reach` (announced address space /
 * route-collector visibility for the resolved ASN, derived locally),
 * `anonymity` (published Tor/VPN egress lists), `abuse_contact`, `rpki`
 * (is the observed BGP origin authorised), `risk` (transparent composite
 * of the others), `connection_type` (heuristic guess from ASN name / rDNS
 * text), `verified_bot` (is this address inside a range a crawler operator
 * publishes as its own), `neighborhood` (counts of flagged entries in
 * the surrounding block), and `network_stability` (per-prefix history
 * maturity state — `score` stays null until real accumulated history
 * justifies one; see `routeAnomalyEnabled` below for why that one field
 * alone doesn't follow this "on by default" rule). All enabled by default;
 * skipping some means a smaller
 * response, and for `reverse_dns` specifically a real per-query latency win
 * (a live DNS call otherwise happens on every single lookup). A disabled
 * feature's fields come back exactly as they already do when there's simply
 * no data for that facet (null, or the appropriate "nothing found" shape) —
 * never omitted, never a different type, so the response contract never
 * changes.
 *
 * `cacheSize`/`cacheTtlMinutes`: the in-memory LRU cache lookupIp checks
 * before touching Postgres at all. Lower `cacheSize` on a memory-
 * constrained deployment (e.g. a phone running this under Termux); lower
 * `cacheTtlMinutes` if the underlying data changes often enough that a
 * stale cached answer matters more than the extra DB round-trips.
 *
 * `reverseDnsTimeoutMs`: how long a single PTR lookup is allowed to block
 * a request before giving up (never throws — see reverse-dns.ts).
 *
 * `bulkLookupConcurrency`: how many IPs `lookupBulk` resolves in parallel.
 *
 * Format: `{ "lookupFeatures": "asn,geo", "cacheSize": 20000 }`.
 *
 * Cached for the process lifetime, unlike @workspace/collector's config
 * (which re-reads every call): `lookupIp` is the hot path this whole
 * project is built around (sub-5ms cached, sub-20ms cold — see
 * lookup.ts's header), so a synchronous file read + JSON.parse on every
 * single request isn't something to pay for a setting that changes at
 * most a few times a day. Restart the process to pick up an edit.
 */
import {
  readConfigFile,
  parseListValue,
  validateAgainstKnown,
  parseNumberValue,
  parseBooleanValue,
} from "@workspace/shared";

export type LookupFeature =
  | "asn"
  | "network_status"
  | "geo"
  | "reverse_dns"
  | "threat"
  | "usage_type"
  | "cloud_provider"
  | "anycast"
  | "special_purpose"
  | "asn_reach"
  | "anonymity"
  | "abuse_contact"
  | "rpki"
  | "risk"
  | "connection_type"
  | "verified_bot"
  | "neighborhood"
  | "network_stability";

export const ALL_LOOKUP_FEATURES: LookupFeature[] = [
  "asn",
  "network_status",
  "geo",
  "reverse_dns",
  "threat",
  "usage_type",
  "cloud_provider",
  "anycast",
  "special_purpose",
  "asn_reach",
  "anonymity",
  "abuse_contact",
  "rpki",
  "risk",
  "connection_type",
  "verified_bot",
  "neighborhood",
  "network_stability",
];

export interface LookupConfig {
  /** `null` means every feature is enabled. */
  features: LookupFeature[] | null;
  cacheSize: number;
  cacheTtlMinutes: number;
  reverseDnsTimeoutMs: number;
  /** How long a single live RDAP call (abuse contact / geofeed discovery)
   * is allowed to block a request before giving up — never throws, see
   * rdap.ts. Longer than reverseDnsTimeoutMs since this is a real HTTPS
   * round trip to a remote RIR server, not a local-ish DNS resolution. */
  rdapTimeoutMs: number;
  /** How long a single security.txt fetch (one of up to two HTTP requests,
   * see security-txt.ts) is allowed to block before giving up — never
   * throws. Only reached after RDAP already came back empty, so this stays
   * short: it's a bonus signal, not one worth trading much latency for. */
  securityTxtTimeoutMs: number;
  /** How old a cached abuse contact may get before the next lookup for that
   * prefix re-fetches it. Not a performance knob: it is the *only* thing
   * that makes a changed abuse contact observable at all, since nothing else
   * ever revisits a prefix once cached. Lower means fresher data and more
   * RDAP traffic; higher means a holder could change theirs and be served
   * stale for that long. */
  abuseContactMaxAgeDays: number;
  /** How long a cached *geofeed-discovery* row (the ones RDAP found, not
   * the ones a bulk source publishes) may get before the next lookup for
   * that prefix re-discovers it. Same reasoning as
   * `abuseContactMaxAgeDays` directly above, for the other RDAP-derived
   * signal — without it, the first geofeed answer for a prefix was the
   * only one it would ever give, permanently.
   *
   * Deliberately a separate knob rather than reusing
   * `abuseContactMaxAgeDays`: that one is already set in live config files
   * (including this project's own), so folding the two together would
   * silently change refresh behaviour for anyone who had tuned it. Same
   * default, independently adjustable. */
  geofeedDiscoveryMaxAgeDays: number;
  /** Per-registry ceiling on live RDAP queries in a rolling 24h window,
   * enforced by this project on itself (see rdap.ts's budget comment).
   * Set below whatever the strictest registry actually allows, so the
   * limit that bites is the self-imposed, gracefully-degrading one rather
   * than a RIR cutting this host off. Counted per RIR, not globally: five
   * registries mean five independent allowances. */
  rdapDailyQueryCap: number;
  bulkLookupConcurrency: number;
  /** Whether `lookupIp` computes and returns the `route_anomaly` block.
   * Deliberately NOT part of `LookupFeature`/`ALL_LOOKUP_FEATURES` — that
   * system defaults every feature *on* (no config file means
   * `features === null`, which enables everything), and this one shouldn't
   * default on yet. Same reasoning and same mechanism as
   * `@workspace/collector`'s `mmdbHistoryFields`: an unproven heuristic with
   * real, disclosed false-positive modes (see SOURCES.md) and zero outcome
   * data to calibrate against — "technically correct but not a claim this
   * project wants shipped" until real usage validates it. Default false. */
  routeAnomalyEnabled: boolean;
  sourcePath: string | null;
}

const DEFAULTS = {
  cacheSize: 50_000,
  cacheTtlMinutes: 360,
  reverseDnsTimeoutMs: 800,
  rdapTimeoutMs: 4000,
  securityTxtTimeoutMs: 1500,
  abuseContactMaxAgeDays: 30,
  geofeedDiscoveryMaxAgeDays: 30,
  // 800/day/registry, under RIPE's documented ~1,000 personal-data-query
  // threshold with real headroom, so the self-imposed limit is what bites
  // first. Not tuned to LACNIC, which is stricter still — a deployment
  // serving mostly Latin American space should lower this.
  rdapDailyQueryCap: 800,
  bulkLookupConcurrency: 32,
  routeAnomalyEnabled: false,
};

let cached: LookupConfig | null = null;

function load(): LookupConfig {
  const file = readConfigFile();
  if (!file) {
    return {
      features: null,
      cacheSize: DEFAULTS.cacheSize,
      cacheTtlMinutes: DEFAULTS.cacheTtlMinutes,
      reverseDnsTimeoutMs: DEFAULTS.reverseDnsTimeoutMs,
      rdapTimeoutMs: DEFAULTS.rdapTimeoutMs,
      securityTxtTimeoutMs: DEFAULTS.securityTxtTimeoutMs,
      abuseContactMaxAgeDays: DEFAULTS.abuseContactMaxAgeDays,
      geofeedDiscoveryMaxAgeDays: DEFAULTS.geofeedDiscoveryMaxAgeDays,
      rdapDailyQueryCap: DEFAULTS.rdapDailyQueryCap,
      bulkLookupConcurrency: DEFAULTS.bulkLookupConcurrency,
      routeAnomalyEnabled: DEFAULTS.routeAnomalyEnabled,
      sourcePath: null,
    };
  }
  const features = validateAgainstKnown(
    parseListValue(file.obj["lookupFeatures"], "lookupFeatures", "all"),
    ALL_LOOKUP_FEATURES,
    "lookupFeatures",
  ) as LookupFeature[] | null;

  return {
    features,
    cacheSize: parseNumberValue(file.obj["cacheSize"], "cacheSize", DEFAULTS.cacheSize, {
      min: 1,
      max: 5_000_000,
    }),
    cacheTtlMinutes: parseNumberValue(
      file.obj["cacheTtlMinutes"],
      "cacheTtlMinutes",
      DEFAULTS.cacheTtlMinutes,
      { min: 1, max: 43_200 },
    ),
    reverseDnsTimeoutMs: parseNumberValue(
      file.obj["reverseDnsTimeoutMs"],
      "reverseDnsTimeoutMs",
      DEFAULTS.reverseDnsTimeoutMs,
      { min: 10, max: 60_000 },
    ),
    rdapTimeoutMs: parseNumberValue(file.obj["rdapTimeoutMs"], "rdapTimeoutMs", DEFAULTS.rdapTimeoutMs, {
      min: 100,
      max: 60_000,
    }),
    securityTxtTimeoutMs: parseNumberValue(
      file.obj["securityTxtTimeoutMs"],
      "securityTxtTimeoutMs",
      DEFAULTS.securityTxtTimeoutMs,
      { min: 100, max: 60_000 },
    ),
    abuseContactMaxAgeDays: parseNumberValue(
      file.obj["abuseContactMaxAgeDays"],
      "abuseContactMaxAgeDays",
      DEFAULTS.abuseContactMaxAgeDays,
      { min: 1, max: 3650 },
    ),
    geofeedDiscoveryMaxAgeDays: parseNumberValue(
      file.obj["geofeedDiscoveryMaxAgeDays"],
      "geofeedDiscoveryMaxAgeDays",
      DEFAULTS.geofeedDiscoveryMaxAgeDays,
      { min: 1, max: 3650 },
    ),
    rdapDailyQueryCap: parseNumberValue(
      file.obj["rdapDailyQueryCap"],
      "rdapDailyQueryCap",
      DEFAULTS.rdapDailyQueryCap,
      { min: 0, max: 1_000_000 },
    ),
    bulkLookupConcurrency: parseNumberValue(
      file.obj["bulkLookupConcurrency"],
      "bulkLookupConcurrency",
      DEFAULTS.bulkLookupConcurrency,
      { min: 1, max: 1000 },
    ),
    routeAnomalyEnabled: parseBooleanValue(
      file.obj["routeAnomalyEnabled"],
      "routeAnomalyEnabled",
      DEFAULTS.routeAnomalyEnabled,
    ),
    sourcePath: file.sourcePath,
  };
}

export function loadLookupConfig(): LookupConfig {
  if (!cached) cached = load();
  return cached;
}

export function isLookupFeatureEnabled(feature: LookupFeature): boolean {
  const { features } = loadLookupConfig();
  return features === null || features.includes(feature);
}
