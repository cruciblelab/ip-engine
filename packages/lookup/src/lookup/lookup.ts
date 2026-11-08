/**
 * IP / ASN lookup engine.
 *
 * Pipeline (per IP):
 *   1. Validate + integerize the address.
 *   2. Cache hit → return immediately.
 *   3. In parallel: range query against ip_blocks, cloud_ranges,
 *      threat_ranges, geofeed_ranges, anycast (static + table fallback).
 *   4. Resolve ASN — local BGP-origin table first (Layer 1, see below),
 *      live RIPE Stat call only as a fallback (prefix-level in-memory cache).
 *   5. Run the classifier over those signals to derive usage_type, flags,
 *      and confidence.
 *   6. Shape the rich response, cache it, return it.
 *
 * Performance budget: <5ms cached / <20ms cold (local-only) / <50ms cold
 * with the RIPE Stat fallback on a miss.
 *
 * ASN resolution (Layer 1): RIR delegated-stats files do NOT carry IP→ASN
 * mapping — only ASN *number* allocations. Resolving that per-request
 * against a live third-party API (RIPE Stat) means reliability tracks how
 * *popular* an IP is to look up, not how big its network is: a
 * constantly-queried address answers fast and reliably, while an ordinary
 * residential prefix — even one behind a large, unremarkable ISP like Turk
 * Telekom (AS9121) — can time out or get rate-limited and silently come back
 * with no ASN at all. That's the actual cause of "well-known ASNs resolve,
 * everything else doesn't".
 *
 * The fix: ingest RIPE RIS whois dumps (real BGP routing tables, refreshed
 * daily, see lib/enrichment.ts + bgp_origin_ranges) so ASN resolution is a
 * local longest-prefix-match — uniformly reliable regardless of the ASN's
 * size or query popularity, no live call, no rate limit. The RIPE Stat live
 * API is kept only as a fallback for prefixes the local table hasn't picked
 * up yet (e.g. very recent BGP changes between ingestion runs).
 */

import { isIP } from "node:net";
import { sql, desc, and, eq, lte, gte } from "drizzle-orm";
import {
  db,
  ipBlocksTable,
  asnBlocksTable,
  cloudRangesTable,
  geofeedRangesTable,
  dbipLiteRangesTable,
  threatRangesTable,
  specialPurposeRangesTable,
  asnReachTable,
  asnProfileTable,
  anonymityRangesTable,
  abuseContactsTable,
  verifiedBotRangesTable,
  neighborhoodStatsTable,
  networkNamesTable,
  rpkiRoasTable,
} from "@workspace/db";
import { logger, normalizeIp, LRUCache } from "@workspace/shared";
import { detectAnycast } from "./anycast";
import { classify, type UsageType, type UsageTypeFlags } from "./classifier";
import { geoForCountry } from "./geo-meta";
import { inferredGeoConfidence } from "./geo-confidence";
import { allocationAgeDays, isFreshAllocation } from "./allocation-age";
import { reverseDnsLookup } from "./reverse-dns";
import {
  fetchRdapObject,
  abuseContactFromRdap,
  geofeedFromRdap,
  networkNameFromRdap,
  GEOFEED_CACHE_SOURCE,
} from "./rdap";
import { fetchAbuseContactViaSecurityTxt } from "./security-txt";
import { assessRisk, type RiskAssessment } from "./risk";
import { guessConnectionType, type ConnectionTypeGuess } from "./connection-type";
import { looksLikeSameOperator } from "./asn-types";
import { isLookupFeatureEnabled, loadLookupConfig } from "../config";

/* ------------------------------------------------------------------------ */
/* ASN resolution — local BGP table only, no live third-party fallback      */
/* ------------------------------------------------------------------------ */

// LRUCache itself now lives in @workspace/shared, not here — geo-meta.ts
// needs the same bounded-cache shape for its own country-estimate cache
// (see that file), so it was promoted out rather than duplicated a second
// time. `prefixAsnCache`/`negativeAsnCache` below, and `lookupCache` further
// down, are still the every-cache-in-this-file instances of it; the
// eviction/TTL behavior itself is unchanged from before the move.

/**
 * Which BGP route-collector project the matching `bgp_origin_ranges` row
 * came from — read from the row's own `source` column, not assumed, so the
 * API says RouteViews when the data is RouteViews (`bgpOriginSource` in the
 * collector config). A hardcoded "bgp-ris" here would have kept naming RIPE
 * RIS after the switch: false provenance in a field customers read.
 */
type AsnSource = "bgp-ris" | "bgp-routeviews";

function asnSourceOf(sourceId: string): AsnSource {
  // Registry ids `routeviews-rib-ipv4/6`; everything else this table has
  // ever held is RIS (`ris-whois-ipv4/6`, or the column default `ripe-ris`).
  return sourceId.startsWith("routeviews-") ? "bgp-routeviews" : "bgp-ris";
}

interface PrefixAsnEntry {
  asnNumber: number;
  asnName: string | null;
  asnType: string | null;
  asnCountry: string | null;
  /** The ASN's own RIR registration date, "YYYY-MM-DD" or null. Cached as
   * the *date* rather than as a derived age precisely because this entry is
   * held in `prefixAsnCache` across requests — see allocation-age.ts for why
   * an age must never be stored anywhere it can go stale. */
  asnRegisteredDate: string | null;
  prefix: string;
  /** Narrowest prefix that strictly contains `prefix` from a different
   * origin ASN — see `resolveAsnLocal`'s doc comment. Cached alongside
   * everything else here specifically so a cache hit never has to run the
   * separate query this used to require on every single lookup. */
  widerAsn: number | null;
  source: AsnSource;
}

// Loaded once, here, rather than separately near each cache: `lookupCache`
// further down and both ASN caches below all size themselves off the same
// "cacheSize" config value — one number to reason about, not three.
const cacheConfig = loadLookupConfig();

const LOCAL_ASN_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_ASN_TTL_MS = 60 * 60 * 1000;

/**
 * Bounded now (`LRUCache`, not a bare `Map`) — the previous version had no
 * eviction at all, which independent security/performance/architecture
 * audit passes all separately flagged as a memory-exhaustion risk: every
 * queried address that's never queried again stayed in the map forever,
 * and IPv6's address space makes "never queried again" the common case,
 * not the exception.
 *
 * Two separate caches, not one, because positive and negative results
 * deserve different TTLs (a resolved ASN is good for a day; "not found yet"
 * should be rechecked within the hour, since the local BGP table refreshes
 * daily and a gap can close between refreshes) and `LRUCache` bakes its TTL
 * into the constructor rather than accepting one per `set()` call — simpler
 * than a variable-TTL cache API that nothing else in this file would use.
 *
 * Both keyed by the queried `ip`, not by `entry.prefix` — a prior version
 * stored positive entries under the resolved prefix string (e.g.
 * "1.1.1.0/24") while every read looked them up by the raw queried address
 * (e.g. "1.1.1.5"), two different strings that can never match. That made
 * the positive cache a pure write-only sink: every resolution, cached or
 * not, still hit the database, and the entries it stored were dead weight
 * that only ever got evicted, never read. Keying by `ip` on both sides
 * loses the "every sibling IP in the prefix shares one entry for free"
 * aspiration the old comment described — that never actually worked — but
 * gains a cache that is at least genuinely a cache; extending it to true
 * prefix-level sharing would need real CIDR-containment matching against
 * cached keys, which is a bigger change than fixing what silently didn't
 * work.
 */
const prefixAsnCache = new LRUCache<PrefixAsnEntry>(cacheConfig.cacheSize, LOCAL_ASN_TTL_MS);
const negativeAsnCache = new LRUCache<true>(cacheConfig.cacheSize, NEGATIVE_ASN_TTL_MS);

/**
 * Longest-prefix match against the locally ingested BGP origin table, plus
 * two facts that used to be separate queries against the same or an
 * adjacent table:
 *
 *  - The org name/type/country from `asn_blocks`, previously a second,
 *    strictly-dependent round trip (`lookupAsnMeta`, needed the ASN number
 *    this query produces before it could even start) — now a `LEFT JOIN
 *    LATERAL` in the same statement.
 *  - The "wider, different-ASN" prefix — previously computed by the caller
 *    (`lookupIp`) as a *third* query, run unconditionally on every call
 *    including cache hits, because the cached `PrefixAsnEntry` had nowhere
 *    to carry it. Computed here via the same candidates-CTE technique
 *    `ip_intel`'s SQL uses for the identical redundant-GiST-scan problem
 *    (see that file's comment for the full reasoning) and now cached with
 *    everything else, so a cache hit costs zero extra queries instead of
 *    one guaranteed extra query.
 *
 * Pure DB read, no network call — this is the primary resolution path.
 * `network` is a native `inet` column so the base scan is one query for
 * both IPv4 and IPv6: Postgres's own `>>=` containment operator
 * (GiST-indexed) finds every covering prefix, `masklen()` picks the most
 * specific one.
 *
 * One tradeoff from merging: `lookupAsnMeta` used to catch its own
 * failures and degrade to null name/type/country without losing the ASN
 * number itself (already resolved by that point). A single statement can't
 * partially fail that way — an `asn_blocks` problem now fails the whole
 * resolution, same as `ip_intel`'s equivalent LATERAL joins already do.
 * Judged an acceptable trade for eliminating up to two round trips per
 * cache miss (and one guaranteed round trip per cache hit); `getAsnForIp`'s
 * own try/catch still keeps a query failure here from taking the rest of
 * the lookup down.
 */
async function resolveAsnLocal(ip: string): Promise<PrefixAsnEntry | null> {
  // asn/wider_asn are `bigint` columns (RFC 6793 ASNs can exceed 32 bits) —
  // node-postgres hands bigints back as *strings* on this raw db.execute()
  // path to avoid silently losing precision above 2^53, unlike Drizzle's
  // typed `.select()` builder (used before this query was merged), which
  // applies the column's declared `bigint(..., { mode: "number" })` coercion
  // automatically. That coercion has to happen here by hand now — skipping
  // it was a real bug caught on real data: `rpki.status` compares
  // `asnEntry.asnNumber` against `roaRows[].asn` (a proper number from a
  // different, still-Drizzle-typed query) with `===`, and `15169 === "15169"`
  // is `false` in JS — every RPKI-valid announcement was silently reported
  // "invalid" for as long as this bug existed. `Number()` is safe for ASNs
  // specifically: they're 32-bit, comfortably inside the range a JS number
  // represents exactly (same reasoning mmdb-export.ts already documents for
  // its own identical bigint-asn case).
  const { rows } = await db.execute<{
    network: string;
    asn: string;
    source: string;
    wider_asn: string | null;
    asn_name: string | null;
    asn_type: string | null;
    asn_country: string | null;
    asn_registered_date: string | null;
  }>(sql`
    WITH candidates AS (
      SELECT x.network, x.asn, x.source,
             row_number() OVER (ORDER BY masklen(x.network) DESC, x.peer_count DESC) AS rn
      FROM bgp_origin_ranges x WHERE x.network >>= ${ip}::inet
    )
    SELECT
      c1.network::text AS network,
      c1.asn,
      c1.source,
      (SELECT c2.asn FROM candidates c2 WHERE c2.rn > 1 AND c2.asn <> c1.asn
       ORDER BY c2.rn LIMIT 1) AS wider_asn,
      meta.name AS asn_name,
      meta.type AS asn_type,
      meta.country AS asn_country,
      -- ::text so this arrives as a plain "YYYY-MM-DD" rather than however
      -- the driver would otherwise render a date column on this raw-execute
      -- path (Drizzle's typed builder applies a coercion here that
      -- db.execute() does not — the same asymmetry the bigint note above
      -- documents). allocation-age.ts accepts both, but pinning it keeps
      -- the cached entry a stable, comparable string.
      meta.registered_date::text AS asn_registered_date
    FROM candidates c1
    LEFT JOIN LATERAL (
      SELECT y.name, y.type, y.country, y.registered_date FROM asn_blocks y
      WHERE y.asn_start <= c1.asn AND y.asn_end >= c1.asn
      ORDER BY y.asn_start DESC LIMIT 1
    ) meta ON true
    WHERE c1.rn = 1
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    asnNumber: Number(row.asn),
    asnName: row.asn_name,
    asnType: row.asn_type,
    asnCountry: row.asn_country,
    asnRegisteredDate: row.asn_registered_date,
    prefix: row.network,
    widerAsn: row.wider_asn === null ? null : Number(row.wider_asn),
    source: asnSourceOf(row.source),
  };
}

/**
 * Main ASN resolution entry point with prefix-level caching.
 * Local BGP-origin table only — no live third-party call. An IP the local
 * table has no coverage for yet returns null, same as any other "not in
 * this dataset" answer elsewhere in this project (e.g. a missing geofeed);
 * the next `enrich` run is what closes that gap, not a per-request network
 * call. (This used to fall back to a live RIPE Stat query — removed: RIPE
 * Stat's own terms don't permit incorporating it into a commercial
 * product, and this project's whole design principle is no live
 * third-party call at query time. See DEPLOY.md.)
 */
async function getAsnForIp(ip: string): Promise<PrefixAsnEntry | null> {
  const cachedPositive = prefixAsnCache.get(ip);
  if (cachedPositive) return cachedPositive;
  if (negativeAsnCache.get(ip)) return null;

  let entry: PrefixAsnEntry | null = null;
  try {
    entry = await resolveAsnLocal(ip);
  } catch (err) {
    logger.debug({ err, ip }, "Local BGP-origin resolve failed");
  }

  if (entry) {
    prefixAsnCache.set(ip, entry);
  } else {
    negativeAsnCache.set(ip, true);
  }

  return entry;
}

/** Expose for metrics / admin endpoints. */
export function prefixAsnCacheStats(): {
  positive: { size: number; hits: number; misses: number; hitRatio: number };
  negative: { size: number; hits: number; misses: number; hitRatio: number };
} {
  return { positive: prefixAsnCache.stats(), negative: negativeAsnCache.stats() };
}

/* ------------------------------------------------------------------------ */
/* Public response shape                                                     */
/* ------------------------------------------------------------------------ */

export interface GeoBlock {
  country: string | null;
  city: string | null;
  region: string | null;
  /** Only ever populated from an operator-published RFC 8805 geofeed — the
   * one source here that carries it. Null for the country-estimate fallback,
   * which knows a country and nothing finer. */
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  /**
   * How `city`/`region` were derived:
   *  - "geofeed": RFC 8805, operator self-published — high confidence.
   *  - "dbip-lite": no operator geofeed covers this prefix, but DB-IP's
   *    free Lite database has a computed guess for it. Inferred, not
   *    self-published — better than naming the country's largest city, and
   *    materially weaker than a geofeed. Off if the "dbip_lite" lookup
   *    feature is disabled, in which case these addresses fall through to
   *    "country-estimate" as they did before the tier existed.
   *  - "country-estimate": no geofeed covers this prefix, so this is the
   *    most populous place GeoNames has for the RIR-registered country —
   *    a coarse "somewhere in this country" anchor, not a per-IP fact.
   *    Always paired with a low `confidence.geo` score.
   *  - "anycast": this address is announced from many locations at once,
   *    so no single city/region is meaningful — see `anycast: true`.
   *  - `null`: no data at all for this facet.
   * Surfaced so callers never mistake a guess for a fact.
   */
  geo_source: "geofeed" | "dbip-lite" | "country-estimate" | "anycast" | null;
  /**
   * The network `city`/`region` actually describe — the geofeed or DB-IP
   * range that matched, not the address that was asked about. `null` for
   * "country-estimate" (the claim is the whole country) and for "anycast"
   * (no location claim is made).
   *
   * Reported because it is the one thing about an inferred answer that is
   * simply a fact: this city is what the source says about 4,096 addresses,
   * or about 256. A caller deciding whether two addresses can be told apart
   * needs that, and it cannot be derived from `confidence.geo`.
   *
   * Deliberately *not* a quality signal, and it should not be read as one.
   * Measured 2026-08-24 (docs/101): holding the operator's own prefix size
   * fixed at /24, DB-IP was right 82.3% of the time when its matching range
   * was a /24 and 79.3% when it was wider. Narrower is not better here.
   */
  geo_network: string | null;
}

export interface NetworkBlock {
  cidr: string | null;
  network_name: string | null;
  allocation_date: string | null;
  /**
   * Days since `allocation_date`, or `null` when the RIR publishes no date
   * for this block — which is every `reserved`/`available` block, and is
   * correct rather than missing data (unallocated space has no allocation
   * date). Computed per request, never stored: see allocation-age.ts.
   *
   * A small number here is rare — under 1% of allocated blocks are inside
   * the 90-day window the `freshly-allocated` flag uses — but it is not by
   * itself a judgement: every legitimate new network is new once. It is
   * deliberately not folded into `risk.score`.
   */
  allocation_age_days: number | null;
  rir: string | null;
  /**
   * The RIR's own status for this block: "allocated" (in active use),
   * "assigned" (end-user assignment), "reserved" (held back by the RIR,
   * not yet delegated), "available" (unallocated, free for the RIR to
   * hand out), or `null` (no matching block, or the "network_status"
   * lookup feature is disabled — see @workspace/lookup's config.ts).
   */
  status: string | null;
}

export interface AsnBlock {
  number: number | null;
  name: string | null;
  type: string | null;
  /** Which route-collector project's BGP table (ingested locally) answered:
   * "bgp-ris" (RIPE RIS) or "bgp-routeviews" (RouteViews). Null if there is
   * no local coverage for this address — never a live third-party fallback. */
  source: AsnSource | null;
  /** When the RIR registered this AS number, "YYYY-MM-DD" or null. */
  registered_date: string | null;
  /** Days since `registered_date` — same computed-not-stored treatment and
   * same "a new ASN is not wrongdoing" caveat as
   * `network.allocation_age_days`. Fires `freshly-registered-asn` below 90
   * days, which is about 1.5% of all ASNs. */
  registered_age_days: number | null;
  /**
   * Rank by announced IPv4 address space among all originating ASNs — 1 is
   * the largest (currently AS16509/Amazon). Derived locally from the BGP
   * table, not a third-party score.
   *
   * This is a *size* rank, not an importance or centrality rank: a CDN that
   * announces little space but appears in every routing table ranks low here
   * despite being enormously significant. `peer_visibility` is the column
   * that speaks to reach. `null` when the ASN originates nothing, or the
   * "asn_reach" lookup feature is disabled.
   */
  rank: number | null;
  /** Prefixes this ASN originates, both families. */
  originated_prefixes: number | null;
  /** IPv6 subset of `originated_prefixes` (v6 space is counted in prefixes,
   * not addresses — see the asn_reach schema comment). */
  originated_prefixes_v6: number | null;
  /** Total IPv4 addresses announced across all of this ASN's prefixes. */
  originated_addresses: number | null;
  /** How many BGP peers of the route-collector project in `source` see this
   * ASN's best-propagated prefix — a proxy for how globally visible the
   * network is. Only comparable within one project: RIPE RIS has ~440
   * full-table peers, RouteViews' route-views2/6 ~20 (measured 2026-11-08). */
  peer_visibility: number | null;
  /**
   * The origin ASN of the narrowest prefix that strictly contains this
   * address's own announced prefix, when that origin differs from `number`
   * — `null` when no such wider announcement exists, or when the wider one
   * shares this same ASN (normal — most networks announce both an
   * aggregate and its constituent parts).
   *
   * A raw fact, not a verdict: on its own this is ordinary internet
   * structure (a transit provider's /16 covering a customer's /24), true
   * for roughly a quarter of announced prefixes. Combined with
   * `rpki.status === "invalid"` in the same response, it's the textbook
   * shape of an unauthorized sub-prefix announcement — this field alone
   * can't distinguish a hijack from a misconfigured provider switch, only
   * that the pattern is present. See SOURCES.md.
   */
  wider_prefix_asn: number | null;
}

export interface NeighborhoodBlock {
  /** The block these counts are for: a /24 (IPv4) or /48 (IPv6). */
  block: string;
  /** Listed Tor exits inside it. */
  tor_entries: number;
  /** Listed VPN egress addresses inside it. */
  vpn_entries: number;
  /** Threat-feed listings inside it. Zero unless a threat source is
   * licensed and wired up — see SOURCES.md. */
  threat_entries: number;
  /** Published crawler ranges inside it. Context, not a negative signal. */
  bot_entries: number;
}

export interface VerifiedBotBlock {
  /** Crawler token as its operator names it: "googlebot", "gptbot", … */
  bot: string;
  /** Publishing organisation: "Google", "OpenAI", … */
  operator: string;
  /** The published prefix that matched. */
  network: string;
}

export interface AnonymityBlock {
  is_tor: boolean;
  is_vpn: boolean;
  is_proxy: boolean;
  /** Named operator(s) this address belongs to, where the source says. */
  providers: string[];
}

export interface AbuseBlock {
  email: string | null;
  phone: string | null;
  org: string | null;
}

export interface RpkiBlock {
  /**
   * "valid"     — a ROA covers this prefix and authorises the observed origin
   * "invalid"   — a ROA covers it but authorises a different origin, or the
   *               announcement is more specific than max-length allows; the
   *               signature of a hijack or a misconfiguration
   * "not-found" — no ROA covers this prefix (still the majority of space)
   * null        — the rpki feature is off, or no origin ASN was resolved, so
   *               the question could not be asked
   */
  status: "valid" | "invalid" | "not-found" | null;
  /** ASNs the covering ROAs authorise, when any ROA covers the prefix. */
  authorized_asns: number[];
}

export interface RouteAnomalyBlock {
  /**
   * True only when BOTH hold at once: `asn.wider_prefix_asn` is non-null AND
   * `rpki.status === "invalid"`. Neither field alone sets this — see
   * SOURCES.md for the measured base rates that justify requiring both.
   *
   * A disclosed gap, not a hidden one: `wider_prefix_asn` only compares ASN
   * *numbers*, never organisational identity, so a same-company "sibling
   * ASN" pair (e.g. two ASN numbers both operated by the same carrier
   * announcing their own aggregate) can set `detected: true` exactly like a
   * real anomaly would. Measured at roughly 1-in-8 of real matches — see
   * SOURCES.md — and not suppressed in this version.
   */
  detected: boolean;
  /** "medium" | "high" | null. null iff `detected` is false. Never "low" —
   * unlike `risk.score` (a continuum banded into three tiers), this only
   * exists once the already-rare base condition has fired; there's no
   * natural weaker tier beneath it worth a third band. */
  confidence: "medium" | "high" | null;
  /** Machine-readable reason codes, same contract as `risk.reasons` — every
   * one traceable to a named field already in this response. */
  reasons: string[];
}

export interface SpecialPurposeBlock {
  /** e.g. "Private-Use", "Loopback", "Documentation (TEST-NET-1)". */
  name: string;
  rfc: string | null;
  is_forwardable: boolean | null;
  is_globally_reachable: boolean | null;
}

export interface ThreatBlock {
  is_malicious: boolean;
  sources: string[];
  confidence: number;
}

export interface ConfidenceBlock {
  overall: number;
  geo: number | null;
  network: number | null;
  asn: number | null;
  usage_type: number | null;
  threat: number | null;
}

export interface IpLookupResult {
  ip: string;
  family: 4 | 6;
  found: boolean;
  cached: boolean;

  geo: GeoBlock;
  network: NetworkBlock;
  asn: AsnBlock;
  cloud_provider: string | null;
  usage_type: UsageType | null;
  usage_type_flags: UsageTypeFlags;
  anycast: boolean;
  flags: string[];
  threat: ThreatBlock;
  confidence: ConfidenceBlock;
  /** PTR hostname for the IP, when one resolves. Best-effort, never blocks the lookup. */
  reverse_dns: string | null;
  /**
   * Set when this address falls in an IANA special-purpose range (private/
   * loopback/documentation/multicast/etc, RFC 6890) — these are never RIR-
   * allocated, so `network` above is legitimately empty for them; this is
   * what explains why. `null` for an ordinary routable address, or when
   * the "special_purpose" lookup feature is disabled.
   */
  special_purpose: SpecialPurposeBlock | null;
  /** Tor/VPN/proxy membership, from services that publish their addresses.
   * Silent about residential and mobile proxy networks, which do not
   * publish — see anonymity_ranges' schema comment. */
  anonymity: AnonymityBlock;
  /** Non-null when the address falls inside a range a crawler's operator
   * publishes as its own. Says nothing about the User-Agent the request
   * carried — comparing the two is the caller's job, and the point. `null`
   * means "not in any published list", which includes every operator that
   * doesn't publish one: not a verdict of "fake". */
  verified_bot: VerifiedBotBlock | null;
  /** What else is flagged in the surrounding block. `null` means nothing is
   * — the table is sparse, so absence is the common, clean case. Counts
   * only: deciding what a concentration means is the caller's call, and
   * depends on their product in ways this project can't know. */
  neighborhood: NeighborhoodBlock | null;
  /** Who to send an abuse report to, from RIR bulk whois. Null outside the
   * registries that publish a free bulk dump (in practice: not ARIN). */
  abuse: AbuseBlock | null;
  /** Whether the BGP origin reported in `asn` is the one the prefix holder
   * cryptographically authorised. */
  rpki: RpkiBlock;
  /** Derived synthesis of `asn.wider_prefix_asn` + `rpki.status` — the
   * textbook shape of an unauthorized sub-prefix announcement, computed
   * entirely from data already fetched for this request. Off unless the
   * `routeAnomalyEnabled` config flag is set (default false, independent of
   * `LookupFeature`) — an unproven heuristic with real, disclosed
   * false-positive modes and zero outcome data to calibrate against, same
   * status as `stable_since`. Degrades to `{ detected: false, confidence:
   * null, reasons: [] }` whenever `asn` or `rpki` themselves are disabled,
   * regardless of its own toggle. See SOURCES.md. */
  route_anomaly: RouteAnomalyBlock;
  /** Transparent composite risk assessment — every point traceable to a
   * named signal above. Not a calibrated fraud probability; see risk.ts. */
  risk: RiskAssessment | null;
  /** Heuristic guess at the access-network type from ASN name / rDNS text.
   * Null unless a pattern matched; never defaulted. */
  connection_type: ConnectionTypeGuess | null;
}

/** `asn_profile` reshaped for a consumer — what *kind* of network this is,
 * as distinct from `AsnInfo`'s registration facts. `null` when `enrich`
 * hasn't computed a profile for this ASN yet (a real possibility: it's
 * recomputed wholesale after each enrichment, not incrementally, so a
 * brand-new ASN can lag behind `asn_blocks` briefly), never an empty object
 * standing in for "not computed". */
export interface AsnProfileInfo {
  /** Distinct countries this ASN's announced space is registered in. */
  countryCount: number;
  /** The country holding most of its prefixes. */
  primaryCountry: string | null;
  rpki: {
    /** Announced prefixes with a ROA authorising this ASN. */
    validPrefixes: number;
    /** Announced prefixes a ROA covers but does not authorise for this ASN
     * — a live routing problem, not a missing signature. */
    invalidPrefixes: number;
    /** Announced prefixes no ROA covers at all — the majority of the
     * internet, not a fault. */
    unsignedPrefixes: number;
  };
  /** Prefixes overlapping a published cloud/CDN range. */
  cloudPrefixes: number;
  /** Listed Tor exits inside this ASN's space. */
  torAddresses: number;
  /** Listed VPN egress addresses inside this ASN's space. */
  vpnAddresses: number;
  /** Published crawler ranges inside it — context, not a negative signal. */
  botPrefixes: number;
  computedAt: string;
}

/** `asn_reach` reshaped for a consumer — origination footprint (announced
 * space, prefix count, peer visibility), the same source `ip_intel.ar.*`
 * and the per-IP lookup's `asn.rank`/`asn.peer_visibility` fields draw from.
 * `null` when `asn-reach` hasn't aggregated this ASN yet, same convention as
 * `AsnProfileInfo`. */
export interface AsnReachInfo {
  /** Rank by announced IPv4 address space, 1 = largest. */
  rank: number | null;
  originatedPrefixes: number | null;
  originatedPrefixesV6: number | null;
  originatedAddresses: number | null;
  /** Highest peer_count across this ASN's prefixes — how many peers of the
   * selected route-collector project see its best-propagated announcement
   * (scale depends on the project; see `AsnBlock.peer_visibility`). */
  peerVisibility: number | null;
  computedAt: string;
}

export interface AsnInfo {
  asn: number;
  name: string | null;
  type: string | null;
  country: string | null;
  rir: string;
  registeredDate: string | null;
  /** Days since `registeredDate` — computed per request, never stored (see
   * allocation-age.ts). Same field the per-IP lookup exposes as
   * `asn.registered_age_days`, kept in step so the two interfaces can't
   * disagree about the same ASN. */
  registeredAgeDays: number | null;
  profile: AsnProfileInfo | null;
  reach: AsnReachInfo | null;
}

/* ------------------------------------------------------------------------ */
/* In-memory LRU cache — result cache                                       */
/* ------------------------------------------------------------------------ */

// `LRUCache` itself, and `cacheConfig`, are declared once near the top of
// this file (before the ASN caches, which need both too) — see that
// section for why. From ip-insight.config.json's "cacheSize"/
// "cacheTtlMinutes" — defaults 50,000 entries / 6 hours, unchanged from
// before this was configurable.
export const lookupCache = new LRUCache<IpLookupResult>(
  cacheConfig.cacheSize,
  cacheConfig.cacheTtlMinutes * 60 * 1000,
);

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function detectFamily(ip: string): 4 | 6 | null {
  const fam = isIP(ip);
  return fam === 4 || fam === 6 ? fam : null;
}

function normalizeCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const v = c.trim().toUpperCase();
  return v || null;
}

function normalizeRir(c: string | null | undefined): string | null {
  if (!c) return null;
  const v = c.trim().toUpperCase();
  return v || null;
}

/**
 * Build an empty/"not found" rich response. Reused for IPv6 lookups (which
 * we don't carry blocks for yet) and for invalid-but-syntactically-valid
 * IPs that don't fall in any allocated range.
 */
function emptyResult(ip: string, family: 4 | 6): IpLookupResult {
  return {
    ip,
    family,
    found: false,
    cached: false,
    geo: {
      country: null,
      city: null,
      region: null,
      postal: null,
      latitude: null,
      longitude: null,
      timezone: null,
      geo_source: null,
      geo_network: null,
    },
    network: {
      cidr: null,
      network_name: null,
      allocation_date: null,
      allocation_age_days: null,
      rir: null,
      status: null,
    },
    asn: {
      number: null,
      name: null,
      type: null,
      source: null,
      registered_date: null,
      registered_age_days: null,
      rank: null,
      originated_prefixes: null,
      originated_prefixes_v6: null,
      originated_addresses: null,
      peer_visibility: null,
      wider_prefix_asn: null,
    },
    anonymity: { is_tor: false, is_vpn: false, is_proxy: false, providers: [] },
    abuse: null,
    rpki: { status: null, authorized_asns: [] },
    route_anomaly: { detected: false, confidence: null, reasons: [] },
    risk: null,
    connection_type: null,
    cloud_provider: null,
    usage_type: null,
    usage_type_flags: {
      hosting: false,
      residential: false,
      mobile: false,
      cdn: false,
      vpn: false,
      proxy: false,
    },
    anycast: false,
    flags: [],
    threat: { is_malicious: false, sources: [], confidence: 0 },
    confidence: {
      overall: 0,
      geo: null,
      network: null,
      asn: null,
      usage_type: null,
      threat: null,
    },
    reverse_dns: null,
    special_purpose: null,
    verified_bot: null,
    neighborhood: null,
  };
}

/* ------------------------------------------------------------------------ */
/* Core lookup                                                               */
/* ------------------------------------------------------------------------ */

/** Bad caller input (unparseable IP) — as opposed to an infrastructure
 * failure mid-lookup. The HTTP route maps this to 400 and everything else
 * to a generic 500, so a database error never leaks its details to what is
 * meant to be a public, unauthenticated endpoint. */
export class InvalidIpError extends Error {}

/**
 * Resolve a single IP address to its enriched record. See the file header
 * for the full pipeline.
 */
export async function lookupIp(rawIp: string): Promise<IpLookupResult> {
  const ip = normalizeIp(rawIp.trim());
  const family = detectFamily(ip);
  if (!family) {
    throw new InvalidIpError(`Invalid IP address: ${rawIp}`);
  }

  const cached = lookupCache.get(ip);
  if (cached) return { ...cached, cached: true };

  // Every optional signal below is individually skippable via
  // ip-insight.config.json's "lookupFeatures" (@workspace/lookup's
  // config.ts) — disabled ones are replaced with an empty/`null` result,
  // exactly matching the existing "nothing found" shape (see that file for
  // why this never changes the response contract, only what's populated).
  const wantCloud = isLookupFeatureEnabled("cloud_provider");
  const wantThreat = isLookupFeatureEnabled("threat");
  const wantGeo = isLookupFeatureEnabled("geo");
  const wantAnycast = isLookupFeatureEnabled("anycast");
  const wantReverseDns = isLookupFeatureEnabled("reverse_dns");
  const wantAsn = isLookupFeatureEnabled("asn");
  const wantNetworkStatus = isLookupFeatureEnabled("network_status");
  const wantUsageType = isLookupFeatureEnabled("usage_type");
  const wantSpecialPurpose = isLookupFeatureEnabled("special_purpose");
  const wantAsnReach = isLookupFeatureEnabled("asn_reach");
  const wantAnonymity = isLookupFeatureEnabled("anonymity");
  const wantAbuse = isLookupFeatureEnabled("abuse_contact");
  const wantVerifiedBot = isLookupFeatureEnabled("verified_bot");
  const wantNeighborhood = isLookupFeatureEnabled("neighborhood");
  const wantRpki = isLookupFeatureEnabled("rpki");
  const wantRisk = isLookupFeatureEnabled("risk");
  const wantConnectionType = isLookupFeatureEnabled("connection_type");
  // route_anomaly is gated by its own config flag, not a `LookupFeature`
  // (see config.ts's doc comment on `routeAnomalyEnabled` for why), AND by
  // `asn`/`rpki` themselves — it's synthesised entirely from their output,
  // so it degrades to the same null shape whenever either of those is off,
  // regardless of its own toggle, exactly like every other field here that
  // depends on more than one upstream signal.
  const wantRouteAnomaly = loadLookupConfig().routeAnomalyEnabled && wantAsn && wantRpki;

  // Every range scan below queries a native Postgres `inet` column via the
  // `>>=` containment operator (GiST-indexed, opclass inet_ops) — the exact
  // same query shape for IPv4 and IPv6, no separate code path. Longest-
  // prefix match is `ORDER BY masklen(network) DESC` throughout. The
  // ip_blocks scan itself is never skippable — cidr/rir/allocation_date/
  // country/found all depend on it regardless of which optional features
  // are on; only its `status` column output is gated by "network_status".
  const [
    blockRows,
    cloudRows,
    threatRows,
    geofeedRows,
    dbipRows,
    anycastInfo,
    reverseDns,
    specialPurposeRows,
    anonymityRows,
    verifiedBotRows,
    neighborhoodRows,
    abuseRows,
    networkNameRows,
    roaRows,
  ] = await Promise.all([
    db
      .select({
        network: sql<string>`${ipBlocksTable.network}`,
        country: ipBlocksTable.country,
        rir: ipBlocksTable.rir,
        registeredDate: ipBlocksTable.registeredDate,
        networkName: ipBlocksTable.networkName,
        status: ipBlocksTable.status,
        usageType: ipBlocksTable.usageType,
        classificationConfidence: ipBlocksTable.classificationConfidence,
        flags: ipBlocksTable.flags,
      })
      .from(ipBlocksTable)
      .where(sql`${ipBlocksTable.network} >>= ${ip}::inet`)
      .orderBy(sql`masklen(${ipBlocksTable.network}) desc`)
      .limit(1),

    wantCloud
      ? db
          .select({
            provider: cloudRangesTable.provider,
            service: cloudRangesTable.service,
            region: cloudRangesTable.region,
          })
          .from(cloudRangesTable)
          .where(sql`${cloudRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${cloudRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    wantThreat
      ? db
          .select({
            source: threatRangesTable.source,
            category: threatRangesTable.category,
          })
          .from(threatRangesTable)
          .where(sql`${threatRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${threatRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    // Layer 2: RFC 8805 geofeed hit, longest-prefix match (a geofeed can
    // carve a big allocation into smaller, more specific city prefixes).
    wantGeo
      ? db
          .select({
            // For `geo.geo_network`: the prefix the operator actually made
            // this statement about, which is rarely the same size as the
            // address asked about.
            network: geofeedRangesTable.network,
            country: geofeedRangesTable.country,
            region: geofeedRangesTable.region,
            city: geofeedRangesTable.city,
            postal: geofeedRangesTable.postal,
            confidence: geofeedRangesTable.confidence,
            latitude: geofeedRangesTable.latitude,
            longitude: geofeedRangesTable.longitude,
            admin1: geofeedRangesTable.admin1,
            // Both selected purely for the staleness decision below: which
            // source published this row, and how old it is. A bulk-source
            // row is refreshed by `enrich` and must never be re-fetched
            // live; only an RDAP-discovered one is this path's to refresh.
            sourceId: geofeedRangesTable.sourceId,
            ingestedAt: geofeedRangesTable.ingestedAt,
          })
          .from(geofeedRangesTable)
          .where(sql`${geofeedRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${geofeedRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    // DB-IP Lite — the middle geo tier, consulted only when no operator
    // geofeed covers the address (enforced below, not here: this runs in
    // the same parallel block as the geofeed query, so at this point
    // whether that one found anything is not yet known). One extra SP-GiST
    // probe alongside the dozen already in flight.
    //
    // Gated by its own "dbip_lite" lookup feature so a deployment that does
    // not want an inferred tier at all can switch it off and get exactly
    // the previous two-tier behaviour back — see README's "Every optional
    // feature must be removable" and docs/99.
    wantGeo && isLookupFeatureEnabled("dbip_lite")
      ? db
          .select({
            // Selected so `geo.geo_network` can report the extent of the
            // claim — "this city is what DB-IP says about a /20", which is a
            // fact about the data rather than an opinion about it.
            network: dbipLiteRangesTable.network,
            country: dbipLiteRangesTable.country,
            region: dbipLiteRangesTable.region,
            city: dbipLiteRangesTable.city,
            latitude: dbipLiteRangesTable.latitude,
            longitude: dbipLiteRangesTable.longitude,
          })
          .from(dbipLiteRangesTable)
          .where(sql`${dbipLiteRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${dbipLiteRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    wantAnycast ? detectAnycast(ip) : Promise.resolve(null),

    // Reverse DNS — plain DNS, not a rate-limited HTTP API, so it's safe as
    // a per-request live signal (unlike the old RIPE Stat ASN call). Run in
    // parallel with everything else so it can't add sequential latency;
    // bounded by its own short timeout in reverse-dns.ts. The one feature
    // toggle with a real, direct per-request latency payoff when off.
    wantReverseDns ? reverseDnsLookup(ip) : Promise.resolve(null),

    // IANA special-purpose ranges never overlap with real RIR allocations,
    // so this is a longest-prefix match same as every other range table
    // here, just against a tiny (~50-row) static table.
    wantSpecialPurpose
      ? db
          .select({
            name: specialPurposeRangesTable.name,
            rfc: specialPurposeRangesTable.rfc,
            isForwardable: specialPurposeRangesTable.isForwardable,
            isGloballyReachable: specialPurposeRangesTable.isGloballyReachable,
          })
          .from(specialPurposeRangesTable)
          .where(sql`${specialPurposeRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${specialPurposeRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    // Anonymity: all matching rows, not just the longest prefix. An address
    // can legitimately be listed by more than one source (a VPN egress that
    // is also a Tor exit), and collapsing that to one row would hide it.
    wantAnonymity
      ? db
          .select({
            kind: anonymityRangesTable.kind,
            provider: anonymityRangesTable.provider,
          })
          .from(anonymityRangesTable)
          .where(sql`${anonymityRangesTable.network} >>= ${ip}::inet`)
      : Promise.resolve([]),

    wantVerifiedBot
      ? db
          .select({
            bot: verifiedBotRangesTable.bot,
            operator: verifiedBotRangesTable.operator,
            network: sql<string>`${verifiedBotRangesTable.network}::text`,
          })
          .from(verifiedBotRangesTable)
          .where(sql`${verifiedBotRangesTable.network} >>= ${ip}::inet`)
          // Longest prefix wins, same rule as every other range table here:
          // an operator publishing both a /16 and a /24 inside it means the
          // /24 is the more specific statement about this address.
          .orderBy(sql`masklen(${verifiedBotRangesTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    wantNeighborhood
      ? db
          .select({
            block: sql<string>`${neighborhoodStatsTable.block}::text`,
            tor_entries: neighborhoodStatsTable.torEntries,
            vpn_entries: neighborhoodStatsTable.vpnEntries,
            threat_entries: neighborhoodStatsTable.threatEntries,
            bot_entries: neighborhoodStatsTable.botEntries,
          })
          .from(neighborhoodStatsTable)
          .where(sql`${neighborhoodStatsTable.block} >>= ${ip}::inet`)
          .limit(1)
      : Promise.resolve([]),

    wantAbuse
      ? db
          .select({
            email: abuseContactsTable.email,
            phone: abuseContactsTable.phone,
            org: abuseContactsTable.org,
            // Selected so the cached row can be checked for staleness below —
            // without it a contact fetched once would be served unchanged
            // forever, and a holder quietly changing theirs would be
            // invisible to us.
            ingestedAt: abuseContactsTable.ingestedAt,
          })
          .from(abuseContactsTable)
          .where(sql`${abuseContactsTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${abuseContactsTable.network}) desc`)
          .limit(1)
      : Promise.resolve([]),

    // Cached registry name for this allocation. Read unconditionally (it
    // is one indexed containment query, and the field is part of the
    // baseline `network` block rather than behind a feature flag), but
    // only ever *written* as a by-product of an RDAP call some other
    // signal already paid for — see networkNames.ts.
    db
      .select({ name: networkNamesTable.name })
      .from(networkNamesTable)
      .where(sql`${networkNamesTable.network} >>= ${ip}::inet`)
      .orderBy(sql`masklen(${networkNamesTable.network}) desc`)
      .limit(1),

    // Every ROA covering this address, because validity is a property of the
    // (prefix, origin, max-length) triple: one ROA may authorise the observed
    // origin while another covers the same space for a different AS. Deciding
    // needs all of them, not the most specific one.
    wantRpki
      ? db
          .select({
            prefix: sql<string>`${rpkiRoasTable.prefix}::text`,
            maxLength: rpkiRoasTable.maxLength,
            asn: rpkiRoasTable.asn,
          })
          .from(rpkiRoasTable)
          .where(sql`${rpkiRoasTable.prefix} >>= ${ip}::inet`)
      : Promise.resolve([] as Array<{ prefix: string; maxLength: number; asn: number }>),
  ]);

  const blockRow = blockRows[0];
  const cloudRow = cloudRows[0];
  const threatRow = threatRows[0];
  const geofeedRow = geofeedRows[0];
  // Empty when the feature is off or nothing covers the address; the geo
  // chain below treats both the same way.
  const dbipRow = dbipRows[0];
  const specialPurposeRow = specialPurposeRows[0];
  const abuseRow = abuseRows[0];
  const verifiedBotRow = verifiedBotRows[0];
  const neighborhoodRow = neighborhoodRows[0];

  const anonymityKinds = new Set(anonymityRows.map((r) => r.kind));
  const anonymity: AnonymityBlock = {
    is_tor: anonymityKinds.has("tor"),
    is_vpn: anonymityKinds.has("vpn"),
    is_proxy: anonymityKinds.has("proxy"),
    providers: [...new Set(anonymityRows.map((r) => r.provider).filter((p): p is string => !!p))],
  };

  // Resolve ASN — local BGP-origin table first (Layer 1 primary, no
  // network call), live RIPE Stat only as a fallback. Prefix-level cached.
  const asnEntry = wantAsn ? await getAsnForIp(ip) : null;

  // Reach metrics are keyed by ASN number, not by prefix, so they can only
  // run once the ASN is known — a second, small lookup rather than part of
  // the Promise.all above.
  const asnReachRow =
    wantAsnReach && asnEntry?.asnNumber
      ? (
          await db
            .select({
              rank: asnReachTable.rank,
              originatedPrefixes: asnReachTable.originatedPrefixes,
              originatedPrefixesV6: asnReachTable.originatedPrefixesV6,
              originatedAddresses: asnReachTable.originatedAddresses,
              peerVisibility: asnReachTable.peerVisibility,
            })
            .from(asnReachTable)
            .where(eq(asnReachTable.asn, asnEntry.asnNumber))
            .limit(1)
        )[0]
      : undefined;

  // The narrowest announced prefix that strictly contains this address's
  // own announcement AND comes from a different origin ASN — the same raw
  // fact `ip_intel.wider_prefix_asn` carries, computed here for the live
  // path since the two are independent implementations (see
  // @workspace/lookup's own header comment on why). On its own this is
  // ordinary internet structure (~27% of announced prefixes have one on a
  // real sample of this database — a transit provider's /16 covering a
  // customer's /24 produces exactly this shape), not a signal. Combined
  // with `rpki.status === "invalid"` on this same response, it's the
  // textbook shape of an unauthorized sub-prefix announcement — this field
  // can't tell a hijack from a misconfigured provider switch, only that the
  // pattern is present. Exposed as a raw fact, same as `country-conflict`
  // below: the caller combines it with RPKI status themselves rather than
  // this project pre-judging the two into a score (see DEPLOY.md).
  //
  // No longer a separate query here: `resolveAsnLocal` now computes this in
  // the same statement as the ASN match itself and caches it on
  // `PrefixAsnEntry`, so it costs nothing extra on a cache hit — previously
  // this ran as its own fresh GiST scan on *every* call, cached ASN or not.
  const widerAsn = asnEntry?.widerAsn ?? null;

  // RPKI validity, per RFC 6811: a prefix with no covering ROA is
  // "not-found" (the majority of address space, and not a problem); one with
  // a covering ROA is "valid" only if some ROA both authorises the observed
  // origin AND permits an announcement this specific. Anything else covered
  // by a ROA is "invalid".
  const rpki: RpkiBlock = { status: null, authorized_asns: [] };
  if (wantRpki && roaRows.length > 0) {
    rpki.authorized_asns = [...new Set(roaRows.map((r) => r.asn))];
    if (asnEntry?.asnNumber) {
      const announcedLen = asnEntry.prefix.includes("/")
        ? Number(asnEntry.prefix.split("/")[1])
        : null;
      const ok = roaRows.some(
        (r) =>
          r.asn === asnEntry.asnNumber &&
          (announcedLen === null || announcedLen <= r.maxLength),
      );
      rpki.status = ok ? "valid" : "invalid";
    }
  } else if (wantRpki && asnEntry?.asnNumber) {
    rpki.status = "not-found";
  }

  // route_anomaly: synthesises `widerAsn` + `rpki.status`, both already
  // computed above, into the named, textbook shape of an unauthorized
  // sub-prefix announcement — this combination can't distinguish a real
  // hijack from a misconfigured provider switch, only that the pattern is
  // present. See the field's own doc comment and SOURCES.md for the
  // measured base rates and the disclosed sibling-ASN false-positive mode.
  let routeAnomaly: RouteAnomalyBlock = { detected: false, confidence: null, reasons: [] };
  if (wantRouteAnomaly && widerAsn !== null && rpki.status === "invalid") {
    const reasons: string[] = ["wider_prefix_other_asn", "rpki_invalid"];
    let upgrade = false;

    if (threatRow) {
      reasons.push("threat_listed");
      upgrade = true;
    }
    // bot_entries deliberately excluded — not a negative signal, per
    // neighborhood_stats's own schema comment.
    if (
      neighborhoodRow &&
      (neighborhoodRow.tor_entries > 0 ||
        neighborhoodRow.vpn_entries > 0 ||
        neighborhoodRow.threat_entries > 0)
    ) {
      reasons.push("neighborhood_flagged");
      upgrade = true;
    }

    // One new, cheap, indexed point query (asn_profile_asn_unique) — gated
    // on `detected` already being true, so it runs for roughly 1 in every
    // ~170 lookups (the compound base rate measured in SOURCES.md), never
    // on the other ~99%+ of requests and never on a cache hit (this whole
    // block is computed once and cached alongside the rest of the
    // response). Looks up the address's *own* ASN, not the wider one: is
    // this specific announcement an outlier for this network, or is the
    // whole network chronically loose with RPKI hygiene regardless?
    if (asnEntry?.asnNumber) {
      const profileRows = await db
        .select({
          rpkiValidPrefixes: asnProfileTable.rpkiValidPrefixes,
          rpkiInvalidPrefixes: asnProfileTable.rpkiInvalidPrefixes,
        })
        .from(asnProfileTable)
        .where(eq(asnProfileTable.asn, asnEntry.asnNumber))
        .limit(1);
      const profileRow = profileRows[0];
      if (profileRow) {
        const total = profileRow.rpkiValidPrefixes + profileRow.rpkiInvalidPrefixes;
        // Require a real track record (>= 5 signed prefixes) before trusting
        // the ratio — avoids over-triggering the upgrade on a brand-new or
        // tiny ASN with 1-2 total prefixes.
        if (total >= 5) {
          const invalidRatio = profileRow.rpkiInvalidPrefixes / total;
          if (invalidRatio < 0.1) {
            reasons.push("asn_otherwise_clean_rpki");
            upgrade = true;
          } else {
            // Grade explicitly stays at the medium floor — visible in
            // reasons[] either way, so a caller can see *why* this wasn't
            // upgraded, not just that it wasn't.
            reasons.push("asn_chronic_rpki_hygiene");
          }
        }
      }
    }

    // Sibling-ASN check: is the "wider" ASN actually the same real-world
    // operator as the address's own ASN (a parent/subsidiary pair, or two AS
    // numbers the same company runs), just its own aggregate over its own
    // more specific announcement one level removed? Found on real data
    // (2026-08-06): a 94-row sample of this exact compound condition showed
    // roughly a quarter of the distinct relationships were this pattern —
    // "GoDaddy.com, LLC" covered by "AS-26496-GO-DADDY-COM-LLC", "JAZZNET
    // Orange Espagne SA" covered by "UNI2-AS Orange Espagne SA" (the single
    // largest cluster in that sample), etc. One more cheap, gated query
    // (same range-lookup shape `lookupAsn` already uses, only reached on
    // this already-rare `detected` path) resolves the wider ASN's name so
    // `looksLikeSameOperator` (asn-types.ts) can check it against the
    // address's own ASN name.
    if (widerAsn !== null) {
      const widerAsnRows = await db
        .select({ name: asnBlocksTable.name })
        .from(asnBlocksTable)
        .where(and(lte(asnBlocksTable.asnStart, widerAsn), gte(asnBlocksTable.asnEnd, widerAsn)))
        .orderBy(desc(asnBlocksTable.asnStart))
        .limit(1);
      if (looksLikeSameOperator(asnEntry?.asnName, widerAsnRows[0]?.name)) {
        reasons.push("same_operator_suspected");
        // Never "high" for a same-operator pair, regardless of what the
        // corroborating checks above found — a company's own aggregate over
        // its own more specific route isn't a stronger anomaly just because
        // that company also has generally messy RPKI hygiene.
        upgrade = false;
      }
    }

    routeAnomaly = { detected: true, confidence: upgrade ? "high" : "medium", reasons };
  }

  // Country: prefer the ASN's own registered country over the enclosing
  // RIR block's country. A CIDR block — especially a large legacy PA
  // allocation like a /14 — is often registered to one holding/distributor
  // entity, then sub-delegated in much smaller, BGP-announced pieces to
  // completely unrelated operators in other countries; the block's RIR
  // country then reflects the paperwork, not whoever is actually
  // announcing this specific /24. The ASN registration is one-to-one with
  // an operator, so it's the more specific signal whenever we have it —
  // same reasoning already applied to `network_name` below, just missing
  // here previously (root cause of a KEYUBU/TR prefix showing country AE).
  const blockCountry = normalizeCountry(blockRow?.country ?? null);
  const asnCountry = normalizeCountry(asnEntry?.asnCountry ?? null);
  const country = asnCountry ?? blockCountry;
  // Surfaced so callers (and we, debugging) can see when the RIR block's
  // administrative country disagrees with the actual operator's ASN
  // country, instead of the mismatch silently resolving one way. This is
  // exactly the KEYUBU/AE-vs-TR case found in testing — now a first-class
  // signal instead of something you have to notice by hand.
  const countryConflict = !!(blockCountry && asnCountry && blockCountry !== asnCountry);
  const rir = normalizeRir(blockRow?.rir ?? null);
  const isAnycast = !!anycastInfo;

  // Cache miss on the bulk-ingested tables: fall back to a live, bounded,
  // write-through-cached RDAP lookup (see rdap.ts) rather than just
  // returning "no data". This is what replaced bulk RIPE/APNIC whois
  // ingestion for these two signals — sequential rather than joining the
  // Promise.all above, since whether it's even needed depends on that
  // block's own result (a cache hit there skips this entirely).
  //
  // Both signals read different fields of the *same* RDAP document, so the
  // request is made once here and handed to each extractor. Fetching per
  // signal would double our consumption of a quota the RIRs enforce
  // strictly (RIPE blocks for the day past ~1,000 personal-data queries) for
  // no additional information.
  // A cached contact is re-checked once it passes `abuseContactMaxAgeDays`,
  // not kept forever. Without this the first answer for a prefix would be the
  // only answer it ever gave: a holder changing their abuse contact — which
  // is exactly what a network does after an incident, and exactly what a
  // caller investigating one needs to see — would never reach us, and the
  // history tables would faithfully record that nothing had changed.
  const lookupConfig = loadLookupConfig();
  const maxAgeMs = lookupConfig.abuseContactMaxAgeDays * 86_400_000;
  const abuseRowIsStale =
    !!abuseRow && Date.now() - abuseRow.ingestedAt.getTime() > maxAgeMs;
  const needAbuseRdap = wantAbuse && (!abuseRow || abuseRowIsStale);
  // The same staleness reasoning the abuse contact above has always had,
  // which geofeed discovery was missing entirely: the condition used to be
  // just `!geofeedRow`, so a prefix's first discovered geofeed was the only
  // one it would ever serve — an operator republishing their feed with
  // corrected cities was invisible forever, and history would faithfully
  // record that nothing had changed.
  //
  // Scoped to rows this module actually owns: a row from a bulk source
  // (Cogent, Charter, Google, ...) is re-ingested wholesale by `enrich`, so
  // re-fetching it live would spend RDAP budget re-deriving data that is
  // already being kept current by a cheaper path.
  const geofeedRowIsStale =
    !!geofeedRow &&
    geofeedRow.sourceId === GEOFEED_CACHE_SOURCE &&
    Date.now() - geofeedRow.ingestedAt.getTime() >
      lookupConfig.geofeedDiscoveryMaxAgeDays * 86_400_000;
  const needGeofeedRdap = wantGeo && !isAnycast && (!geofeedRow || geofeedRowIsStale);
  // `rir` routes the query to the registry that actually holds this
  // address rather than bouncing it off RIPE — see rdap.ts. It comes from
  // the `ip_blocks` row already read above, so this costs nothing.
  const rdapObject =
    needAbuseRdap || needGeofeedRdap ? await fetchRdapObject(ip, rir) : null;

  const rdapAbuse = needAbuseRdap && rdapObject ? await abuseContactFromRdap(rdapObject) : null;
  // Read off whatever response the two signals above already fetched —
  // deliberately never a reason to fetch one. `rdapObject` is null unless
  // abuse or geofeed needed it, so this cannot add a single query.
  const rdapNetworkName = rdapObject ? await networkNameFromRdap(rdapObject) : null;
  // Bonus, independent signal — only worth the extra round trip when RDAP
  // itself came back with nothing (see security-txt.ts for why this can
  // never replace RDAP as the primary path). Reuses the PTR already resolved
  // in the parallel block above rather than resolving it a second time.
  const securityTxtAbuse =
    wantAbuse && (!abuseRow || abuseRowIsStale) && !rdapAbuse
      ? await fetchAbuseContactViaSecurityTxt(ip, reverseDns)
      : null;
  const rdapGeofeed =
    needGeofeedRdap && rdapObject ? await geofeedFromRdap(rdapObject, ip) : null;
  const effectiveGeofeedRow = geofeedRow ?? rdapGeofeed ?? undefined;

  // Classification — pure in-memory, sub-ms.
  const classification = classify({
    anycast: anycastInfo,
    cloud: cloudRow
      ? {
          provider: cloudRow.provider,
          service: cloudRow.service ?? null,
          region: cloudRow.region ?? null,
        }
      : null,
    threat: threatRow
      ? {
          source: threatRow.source,
          category: threatRow.category ?? null,
        }
      : null,
    asn: {
      number: asnEntry?.asnNumber ?? null,
      name: asnEntry?.asnName ?? null,
    },
    reverseDns,
  });

  // Geo: anycast means no single location is meaningful — `country` stays
  // a real ISO code or null, never a sentinel string like "distributed"
  // (a magic value there would break any caller expecting a real country
  // code). Otherwise prefer the Layer 2 geofeed hit (operator
  // self-published, high confidence) for city/region; fall back to a
  // GeoNames country-estimate (geo-meta.ts) when no geofeed covers this
  // prefix. Never blend the two — callers can tell which one answered via
  // `geo_source`, paired with a confidence score low enough to reflect
  // what a country-estimate actually is, instead of silently getting a
  // guess dressed as a fact.
  // `wantGeo` gates the whole block, including the "anycast" geo_source —
  // that value explains *why* geo is empty, which itself is part of the
  // geo answer, not a separate concern. The top-level `anycast` field
  // (gated by its own "anycast" feature) is independent and still reports
  // correctly either way.
  const geoMeta = wantGeo && !isAnycast ? await geoForCountry(country) : null;
  const geo: GeoBlock = !wantGeo
    ? {
        country: null,
        city: null,
        region: null,
        postal: null,
        latitude: null,
        longitude: null,
        timezone: null,
        geo_source: null,
        geo_network: null,
      }
    : isAnycast
      ? {
          country: null,
          city: null,
          region: null,
          latitude: null,
          longitude: null,
          timezone: null,
          postal: null,
          geo_source: "anycast",
          geo_network: null,
        }
      : effectiveGeofeedRow
        ? {
            country: normalizeCountry(effectiveGeofeedRow.country) ?? country,
            city: effectiveGeofeedRow.city ?? null,
            // admin1 (province/state, e.g. from GeoNames — see lib/geocode.ts)
            // is more specific than the country-estimate's `geoMeta.region`
            // fallback, so it wins when we have it.
            region: effectiveGeofeedRow.admin1 ?? effectiveGeofeedRow.region ?? geoMeta?.region ?? null,
            postal: effectiveGeofeedRow.postal ?? null,
            latitude: effectiveGeofeedRow.latitude ?? null,
            longitude: effectiveGeofeedRow.longitude ?? null,
            timezone: geoMeta?.timezone ?? null,
            geo_source: "geofeed",
            geo_network: effectiveGeofeedRow.network ?? null,
          }
        : dbipRow
          ? {
              // Between the two existing tiers on purpose: a real
              // per-range guess beats "the biggest city in this country",
              // and loses to an operator describing their own network.
              //
              // DB-IP's country wins over the RIR's, exactly as the geofeed
              // branch above does, because the three fields have to agree
              // with each other. Preferring the RIR country here was tried
              // first and produced a real incoherent answer on real data:
              // `2001:4:112::` came back as "Amsterdam, North Holland, US"
              // — city and region from DB-IP (the instance really is in
              // Amsterdam), country from ARIN (which administers AS112).
              // Both halves defensible, the combination nonsense. Whichever
              // source supplies the city supplies the country with it.
              country: normalizeCountry(dbipRow.country) ?? country,
              city: dbipRow.city ?? null,
              region: dbipRow.region ?? null,
              latitude: dbipRow.latitude ?? null,
              longitude: dbipRow.longitude ?? null,
              timezone: geoMeta?.timezone ?? null,
              postal: null,
              geo_source: "dbip-lite",
              geo_network: dbipRow.network ?? null,
            }
        : geoMeta
          ? {
              country,
              city: geoMeta.city,
              region: geoMeta.region,
              latitude: geoMeta.latitude,
              longitude: geoMeta.longitude,
              timezone: geoMeta.timezone,
              postal: null,
              geo_source: "country-estimate",
              geo_network: null,
            }
          : {
              country,
              city: null,
              region: null,
              latitude: null,
              longitude: null,
              timezone: null,
              postal: null,
              geo_source: null,
              geo_network: null,
            };

  // Threat block uses the structured shape required by the spec.
  const threatSources = threatRow ? [threatRow.source.toLowerCase()] : [];
  const threat: ThreatBlock = {
    is_malicious: !!threatRow,
    sources: threatSources,
    confidence: threatRow ? 0.9 : 0,
  };

  // Per-field confidences: nulls when we have no data for that facet.
  // ASN confidence reflects *how* it was resolved: the local BGP table is a
  // deterministic longest-prefix match against real routing data, so it
  // scores higher than the live RIPE Stat fallback.
  // Both inferred tiers score against a real measurement rather than a feel:
  // see geo-confidence.ts, which also records the two splits that were tried
  // and rejected because the data did not support them. Computed once — the
  // flags block below reads it too.
  const inferredGeo =
    isAnycast || effectiveGeofeedRow
      ? null
      : dbipRow
        ? inferredGeoConfidence({ source: "dbip-lite", countryConflict })
        : geoMeta
          ? inferredGeoConfidence({ source: "country-estimate", countryConflict })
          : null;

  const confidence: ConfidenceBlock = {
    overall: classification.confidence,
    // No confidence value is meaningful for "anycast" — no geo claim is
    // being made at all, so this isn't a "we're 100% sure" case (that was
    // a bug: 1 there implied maximum certainty for a block with no data).
    geo: isAnycast
      ? null
      : effectiveGeofeedRow
        ? effectiveGeofeedRow.confidence
        : (inferredGeo?.score ?? null),
    network: blockRow ? 0.95 : null,
    // Both projects are the same kind of evidence (a local BGP table
    // match). The 0.8 branch dates from the removed live RIPE Stat
    // fallback and no longer has a source that reaches it.
    asn: asnEntry ? 0.95 : null,
    usage_type: wantUsageType ? classification.confidence : null,
    threat: threatRow ? 0.9 : null,
  };

  // Derived once here, from rows already fetched above — no extra query.
  // Kept next to the flags that read them rather than inline in the
  // response object, since both the flag and the field must come from the
  // same evaluation (a lookup spanning midnight UTC would otherwise be able
  // to report an age and a flag computed against different days).
  const blockAgeDays = allocationAgeDays(blockRow?.registeredDate ?? null);
  const asnAgeDays = allocationAgeDays(asnEntry?.asnRegisteredDate ?? null);

  // The classifier already merged anycast + cloud + threat tags.
  // Add network-level flags here.
  const flags = new Set<string>(classification.flags);
  if (isFreshAllocation(blockAgeDays)) flags.add("freshly-allocated");
  if (isFreshAllocation(asnAgeDays)) flags.add("freshly-registered-asn");
  if (rir) flags.add(`rir:${rir.toLowerCase()}`);
  if (country) flags.add(`country:${country.toLowerCase()}`);
  if (asnEntry?.asnNumber) flags.add(`as:${asnEntry.asnNumber}`);
  if (asnEntry?.source) flags.add(`asn-source:${asnEntry.source}`);
  if (geo.geo_source) flags.add(`geo:${geo.geo_source}`);
  // Said out loud rather than left implicit in `confidence.geo`, which a
  // caller may never read. Every inferred tier gets it: measured 76-86% per
  // address for DB-IP and far less for a country estimate, neither of which
  // is an operator describing their own network. See geo-confidence.ts.
  if (inferredGeo?.cityApproximate && geo.city) flags.add("geo:city-approximate");
  if (countryConflict) {
    flags.add("country-conflict");
    flags.add(`block-country:${blockCountry!.toLowerCase()}`);
    flags.add(`asn-country:${asnCountry!.toLowerCase()}`);
  }
  if (widerAsn) {
    flags.add("wider-prefix-other-asn");
    flags.add(`wider-prefix-as:${widerAsn}`);
  }

  const result: IpLookupResult = {
    ip,
    family,
    found: !!blockRow,
    cached: false,
    geo,
    network: {
      cidr: blockRow?.network ?? asnEntry?.prefix ?? null,
      // Precedence, most to least specific about *this network*:
      //
      //  1. The registry's own name for the allocation, from RDAP. This is
      //     the only one that actually answers "what is this network
      //     called" — e.g. Quad9's 149.112.112.0/24 is `PCH-PUBLIC-RESOLVER`
      //     (Packet Clearing House operates it), which no other source here
      //     knows. Cached in `network_names`, populated as a by-product of
      //     RDAP calls made for abuse/geofeed, never on its own account.
      //  2. The ASN's org name, the previous first choice. Kept as fallback
      //     because it is better than nothing, but it answers a different
      //     question (who runs the AS, not what the allocation is called)
      //     and is already returned verbatim as `asn.name` — so when it
      //     lands here the two fields are simply duplicates.
      //  3. `ip_blocks.network_name`, which has been null on every row this
      //     project has ever held: the RIR delegated-extended statistics
      //     files carry no name field at all. Kept only so a deployment
      //     that fills that column from some other source still works.
      //
      // `rdapNetworkName` (just fetched) is checked before the cached row
      // for the same reason the abuse contact below does it: the cache read
      // happens in the parallel block *above* the RDAP call, so on a first
      // lookup for a prefix the cache is empty while the live value is in
      // hand. Reading the cache first would make every prefix's first
      // answer fall through to the ASN name and only self-correct on the
      // second lookup.
      network_name:
        rdapNetworkName ?? networkNameRows[0]?.name ?? asnEntry?.asnName ?? blockRow?.networkName ?? null,
      allocation_date: blockRow?.registeredDate
        ? String(blockRow.registeredDate)
        : null,
      allocation_age_days: blockAgeDays,
      rir,
      status: wantNetworkStatus ? (blockRow?.status ?? null) : null,
    },
    asn: {
      number: asnEntry?.asnNumber ?? null,
      name: asnEntry?.asnName ?? null,
      type: asnEntry?.asnType ?? null,
      source: asnEntry?.source ?? null,
      registered_date: asnEntry?.asnRegisteredDate ?? null,
      registered_age_days: asnAgeDays,
      rank: asnReachRow?.rank ?? null,
      originated_prefixes: asnReachRow?.originatedPrefixes ?? null,
      originated_prefixes_v6: asnReachRow?.originatedPrefixesV6 ?? null,
      originated_addresses: asnReachRow?.originatedAddresses ?? null,
      peer_visibility: asnReachRow?.peerVisibility ?? null,
      wider_prefix_asn: widerAsn,
    },
    cloud_provider: cloudRow ? cloudRow.provider.toLowerCase() : null,
    usage_type: wantUsageType ? classification.usageType : null,
    usage_type_flags: wantUsageType
      ? classification.usageBooleans
      : { hosting: false, residential: false, mobile: false, cdn: false, vpn: false, proxy: false },
    anycast: isAnycast,
    flags: Array.from(flags).sort(),
    threat,
    confidence,
    reverse_dns: reverseDns,
    special_purpose: specialPurposeRow
      ? {
          name: specialPurposeRow.name,
          rfc: specialPurposeRow.rfc,
          is_forwardable: specialPurposeRow.isForwardable,
          is_globally_reachable: specialPurposeRow.isGloballyReachable,
        }
      : null,
    anonymity,
    verified_bot: verifiedBotRow ?? null,
    neighborhood: neighborhoodRow ?? null,
    // A freshly re-fetched value wins over the stale cached one it was
    // fetched to replace — otherwise the refresh above would update the
    // database but keep serving the old answer for the rest of this request.
    abuse:
      (abuseRowIsStale ? (rdapAbuse ?? securityTxtAbuse) : null) ??
      (abuseRow
        ? { email: abuseRow.email, phone: abuseRow.phone, org: abuseRow.org }
        : (rdapAbuse ?? securityTxtAbuse)),
    rpki,
    route_anomaly: routeAnomaly,
    risk: wantRisk
      ? assessRisk({
          threatSources: threatRow ? [threatRow.source] : [],
          isTor: anonymity.is_tor,
          isVpn: anonymity.is_vpn,
          isCloudOrHosting: !!cloudRow || classification.usageType === "hosting",
          isAnycast,
          hasReverseDns: !!reverseDns,
          rpkiStatus: rpki.status,
          isSpecialPurpose: !!specialPurposeRow,
          routeAnomalyConfidence: routeAnomaly.confidence,
        })
      : null,
    connection_type: wantConnectionType
      ? guessConnectionType(asnEntry?.asnName ?? null, reverseDns, asnEntry?.asnNumber ?? null)
      : null,
  };

  lookupCache.set(ip, result);
  return result;
}

/**
 * Bulk lookup. Same response shape per element. Internally fans out with
 * bounded concurrency so the connection pool isn't saturated.
 */
export async function lookupBulk(
  ips: string[],
  concurrency = loadLookupConfig().bulkLookupConcurrency,
): Promise<IpLookupResult[]> {
  const results: IpLookupResult[] = new Array(ips.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= ips.length) return;
      try {
        results[i] = await lookupIp(ips[i]!);
      } catch (err) {
        // Preserve order — emit a normalized "not found" entry so callers
        // never see undefined slots.
        const ip = ips[i]!;
        results[i] = emptyResult(ip, detectFamily(ip) ?? 4);
        logger.warn({ err, ip }, "Bulk lookup error for IP");
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, ips.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * ASN lookup by ASN number. Returns metadata from asn_blocks (org name +
 * type harvested by the asn-name enrichment job) plus, when available, its
 * `asn_profile` — computed separately and looked up by exact ASN number, not
 * joined into the same query: `asn_blocks` is a range table matched by
 * `asnStart <= asn <= asnEnd`, `asn_profile` is one row per exact ASN, and
 * the two run concurrently rather than sequentially since neither depends on
 * the other's result.
 */
export async function lookupAsn(asn: number): Promise<AsnInfo | null> {
  const [blockRows, profileRows, reachRows] = await Promise.all([
    db
      .select({
        asnStart: asnBlocksTable.asnStart,
        asnEnd: asnBlocksTable.asnEnd,
        name: asnBlocksTable.name,
        type: asnBlocksTable.type,
        country: asnBlocksTable.country,
        rir: asnBlocksTable.rir,
        registeredDate: asnBlocksTable.registeredDate,
      })
      .from(asnBlocksTable)
      .where(
        and(lte(asnBlocksTable.asnStart, asn), gte(asnBlocksTable.asnEnd, asn)),
      )
      .orderBy(desc(asnBlocksTable.asnStart))
      .limit(1),
    db
      .select({
        countryCount: asnProfileTable.countryCount,
        primaryCountry: asnProfileTable.primaryCountry,
        rpkiValidPrefixes: asnProfileTable.rpkiValidPrefixes,
        rpkiInvalidPrefixes: asnProfileTable.rpkiInvalidPrefixes,
        rpkiUnsignedPrefixes: asnProfileTable.rpkiUnsignedPrefixes,
        cloudPrefixes: asnProfileTable.cloudPrefixes,
        torAddresses: asnProfileTable.torAddresses,
        vpnAddresses: asnProfileTable.vpnAddresses,
        botPrefixes: asnProfileTable.botPrefixes,
        computedAt: asnProfileTable.computedAt,
      })
      .from(asnProfileTable)
      .where(eq(asnProfileTable.asn, asn))
      .limit(1),
    db
      .select({
        rank: asnReachTable.rank,
        originatedPrefixes: asnReachTable.originatedPrefixes,
        originatedPrefixesV6: asnReachTable.originatedPrefixesV6,
        originatedAddresses: asnReachTable.originatedAddresses,
        peerVisibility: asnReachTable.peerVisibility,
        computedAt: asnReachTable.computedAt,
      })
      .from(asnReachTable)
      .where(eq(asnReachTable.asn, asn))
      .limit(1),
  ]);

  const row = blockRows[0];
  if (!row) return null;
  const profileRow = profileRows[0];
  const reachRow = reachRows[0];
  return {
    asn,
    name: row.name ?? null,
    type: row.type ?? null,
    country: row.country ?? null,
    rir: row.rir,
    registeredDate: row.registeredDate ? String(row.registeredDate) : null,
    registeredAgeDays: allocationAgeDays(row.registeredDate),
    profile: profileRow
      ? {
          countryCount: profileRow.countryCount,
          primaryCountry: profileRow.primaryCountry ?? null,
          rpki: {
            validPrefixes: profileRow.rpkiValidPrefixes,
            invalidPrefixes: profileRow.rpkiInvalidPrefixes,
            unsignedPrefixes: profileRow.rpkiUnsignedPrefixes,
          },
          cloudPrefixes: profileRow.cloudPrefixes,
          torAddresses: profileRow.torAddresses,
          vpnAddresses: profileRow.vpnAddresses,
          botPrefixes: profileRow.botPrefixes,
          computedAt: profileRow.computedAt.toISOString(),
        }
      : null,
    reach: reachRow
      ? {
          rank: reachRow.rank,
          originatedPrefixes: reachRow.originatedPrefixes,
          originatedPrefixesV6: reachRow.originatedPrefixesV6,
          originatedAddresses: reachRow.originatedAddresses,
          peerVisibility: reachRow.peerVisibility,
          computedAt: reachRow.computedAt.toISOString(),
        }
      : null,
  };
}

/** Throw-away helper used by tests / health checks. */
export function _unusedSqlMarker(): unknown {
  return sql`SELECT 1`;
}
