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
  bgpOriginRangesTable,
  cloudRangesTable,
  geofeedRangesTable,
  threatRangesTable,
  specialPurposeRangesTable,
  asnReachTable,
  anonymityRangesTable,
  abuseContactsTable,
  verifiedBotRangesTable,
  neighborhoodStatsTable,
  rpkiRoasTable,
} from "@workspace/db";
import { logger, normalizeIp } from "@workspace/shared";
import { detectAnycast } from "./anycast";
import { classify, type UsageType, type UsageTypeFlags } from "./classifier";
import { geoForCountry } from "./geo-meta";
import { reverseDnsLookup } from "./reverse-dns";
import { fetchRdapObject, abuseContactFromRdap, geofeedFromRdap } from "./rdap";
import { fetchAbuseContactViaSecurityTxt } from "./security-txt";
import { assessRisk, type RiskAssessment } from "./risk";
import { guessConnectionType, type ConnectionTypeGuess } from "./connection-type";
import { isLookupFeatureEnabled, loadLookupConfig } from "../config";

/* ------------------------------------------------------------------------ */
/* ASN resolution — local BGP table first, live RIPE Stat as fallback       */
/* ------------------------------------------------------------------------ */

interface RipeStatNetworkInfo {
  prefix: string;
  asns: string[];
}

type AsnSource = "bgp-ris" | "ripe-stat";

interface PrefixAsnEntry {
  asnNumber: number;
  asnName: string | null;
  asnType: string | null;
  asnCountry: string | null;
  prefix: string;
  source: AsnSource;
  expiresAt: number;
}

/**
 * In-memory cache keyed by *CIDR prefix* (not individual IP) so all IPs
 * inside the same announced prefix share one entry. Local-table hits get a
 * long TTL (the underlying data only refreshes once a day); live RIPE Stat
 * fallback hits get the original shorter TTL since they're covering for
 * data the local table doesn't have yet.
 */
interface NegativeEntry {
  negative: true;
  expiresAt: number;
}

const prefixAsnCache = new Map<string, PrefixAsnEntry | NegativeEntry>();
const LOCAL_ASN_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_ASN_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_ASN_TTL_MS = 60 * 60 * 1000;

/** Look up the ASN org name/type/country from the RIR-populated asn_blocks table. */
async function lookupAsnMeta(
  asnNumber: number,
): Promise<{ name: string | null; type: string | null; country: string | null }> {
  try {
    const rows = await db
      .select({
        name: asnBlocksTable.name,
        type: asnBlocksTable.type,
        country: asnBlocksTable.country,
      })
      .from(asnBlocksTable)
      .where(
        and(
          lte(asnBlocksTable.asnStart, asnNumber),
          gte(asnBlocksTable.asnEnd, asnNumber),
        ),
      )
      .orderBy(desc(asnBlocksTable.asnStart))
      .limit(1);
    const row = rows[0];
    if (!row) return { name: null, type: null, country: null };
    return {
      name: row.name ?? null,
      type: row.type ?? null,
      country: row.country ?? null,
    };
  } catch (err) {
    logger.debug({ err, asnNumber }, "Local ASN name resolve failed");
    return { name: null, type: null, country: null };
  }
}

/**
 * Longest-prefix match against the locally ingested BGP origin table.
 * Pure DB read, no network call — this is the primary resolution path.
 * `network` is a native `inet` column so this is one query for both IPv4
 * and IPv6: Postgres's own `>>=` containment operator (GiST-indexed) finds
 * every covering prefix, `masklen()` picks the most specific one.
 */
async function resolveAsnLocal(ip: string): Promise<PrefixAsnEntry | null> {
  const rows = await db
    .select({
      network: sql<string>`${bgpOriginRangesTable.network}`,
      asn: bgpOriginRangesTable.asn,
    })
    .from(bgpOriginRangesTable)
    .where(sql`${bgpOriginRangesTable.network} >>= ${ip}::inet`)
    .orderBy(
      sql`masklen(${bgpOriginRangesTable.network}) desc`,
      desc(bgpOriginRangesTable.peerCount),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const meta = await lookupAsnMeta(row.asn);
  return {
    asnNumber: row.asn,
    asnName: meta.name,
    asnType: meta.type,
    asnCountry: meta.country,
    prefix: row.network,
    source: "bgp-ris",
    expiresAt: Date.now() + LOCAL_ASN_TTL_MS,
  };
}

/**
 * Fallback: call RIPE Stat to find the announcing prefix + ASN for an IP,
 * then look the ASN number up in our local asn_blocks table for the org
 * name. Only reached when the local BGP table has no match for this IP.
 *
 * Returns null if:
 *  - RIPE Stat returns no routing info (unannounced / martian space)
 *  - network is unreachable (offline dev environment)
 *
 * Always resolves — never throws.
 */
async function resolveAsnLive(ip: string): Promise<PrefixAsnEntry | null> {
  const url = `https://stat.ripe.net/data/network-info/data.json?resource=${ip}`;
  let info: RipeStatNetworkInfo | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { data?: RipeStatNetworkInfo };
      info = body.data ?? null;
    }
  } catch (err) {
    // Network error or timeout — degrade gracefully.
    logger.debug({ err, ip }, "RIPE Stat ASN resolve failed — degraded gracefully");
    return null;
  }

  if (!info || !info.asns || info.asns.length === 0) return null;

  const prefix = info.prefix ?? ip;
  const asnNumber = parseInt(info.asns[0]!, 10);
  if (isNaN(asnNumber)) return null;

  const meta = await lookupAsnMeta(asnNumber);
  return {
    asnNumber,
    asnName: meta.name,
    asnType: meta.type,
    asnCountry: meta.country,
    prefix,
    source: "ripe-stat",
    expiresAt: Date.now() + LIVE_ASN_TTL_MS,
  };
}

/**
 * Main ASN resolution entry point with prefix-level caching.
 * Tries the local BGP-origin table first (no network call); only falls
 * back to the live RIPE Stat API when the local table has no match.
 */
async function getAsnForIp(ip: string): Promise<PrefixAsnEntry | null> {
  // We use the raw IP as a preliminary cache key; after the first real
  // resolution we re-key on the actual prefix.
  const existing = prefixAsnCache.get(ip);
  const existingFresh = existing !== undefined && existing.expiresAt > Date.now();
  if (existing !== undefined && !existingFresh) {
    prefixAsnCache.delete(ip);
  }
  // A cached *local*-table hit is trusted for its full TTL — that data only
  // refreshes ~daily, so it can't go stale mid-cache-life. A cached live
  // RIPE Stat fallback (or a negative result) is different: it exists only
  // because the local table had nothing at cache time, and an `enrich` run
  // ingesting real coverage for it later gives no cross-package signal to
  // invalidate this in-memory cache — so re-check the local table (cheap,
  // indexed) on every hit for those instead of trusting the cache blind.
  if (existingFresh && !("negative" in existing!) && existing!.source === "bgp-ris") {
    return existing;
  }

  let entry: PrefixAsnEntry | null = null;
  try {
    entry = await resolveAsnLocal(ip);
  } catch (err) {
    logger.debug({ err, ip }, "Local BGP-origin resolve failed");
  }
  if (!entry && existingFresh) {
    // Local table still has nothing new for this prefix — reuse the cached
    // live/negative result instead of re-hitting RIPE Stat on every request.
    return "negative" in existing! ? null : existing!;
  }
  if (!entry) {
    entry = await resolveAsnLive(ip);
  }

  if (entry) {
    // Store under the actual prefix so sibling IPs hit the cache.
    prefixAsnCache.set(entry.prefix, entry);
  } else {
    // Negative cache for 1h to avoid hammering RIPE Stat for dead space.
    prefixAsnCache.set(ip, { negative: true, expiresAt: Date.now() + NEGATIVE_ASN_TTL_MS });
  }

  return entry;
}

/** Expose for metrics / admin endpoints. */
export function prefixAsnCacheStats(): { size: number } {
  return { size: prefixAsnCache.size };
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
   *  - "country-estimate": no geofeed covers this prefix, so this is the
   *    most populous place GeoNames has for the RIR-registered country —
   *    a coarse "somewhere in this country" anchor, not a per-IP fact.
   *    Always paired with a low `confidence.geo` score.
   *  - "anycast": this address is announced from many locations at once,
   *    so no single city/region is meaningful — see `anycast: true`.
   *  - `null`: no data at all for this facet.
   * Surfaced so callers never mistake a guess for a fact.
   */
  geo_source: "geofeed" | "country-estimate" | "anycast" | null;
}

export interface NetworkBlock {
  cidr: string | null;
  network_name: string | null;
  allocation_date: string | null;
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
  /** "bgp-ris" (local BGP table, Layer 1 primary) or "ripe-stat" (live API fallback). */
  source: "bgp-ris" | "ripe-stat" | null;
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
  /** How many RIS route collectors see this ASN's best-propagated prefix —
   * a proxy for how globally visible the network is. */
  peer_visibility: number | null;
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
  /** Transparent composite risk assessment — every point traceable to a
   * named signal above. Not a calibrated fraud probability; see risk.ts. */
  risk: RiskAssessment | null;
  /** Heuristic guess at the access-network type from ASN name / rDNS text.
   * Null unless a pattern matched; never defaulted. */
  connection_type: ConnectionTypeGuess | null;
}

export interface AsnInfo {
  asn: number;
  name: string | null;
  type: string | null;
  country: string | null;
  rir: string;
  registeredDate: string | null;
}

/* ------------------------------------------------------------------------ */
/* In-memory LRU cache                                                       */
/* ------------------------------------------------------------------------ */

interface CacheEntry {
  value: IpLookupResult;
  expiresAt: number;
}

class LRUCache {
  private map = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): IpLookupResult | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: IpLookupResult): void {
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  stats(): { size: number; hits: number; misses: number; hitRatio: number } {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total === 0 ? 0 : this.hits / total,
    };
  }
}

// From ip-insight.config.json's "cacheSize"/"cacheTtlMinutes" — defaults
// 50,000 entries / 6 hours, unchanged from before this was configurable.
const cacheConfig = loadLookupConfig();
export const lookupCache = new LRUCache(
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
    },
    network: {
      cidr: null,
      network_name: null,
      allocation_date: null,
      rir: null,
      status: null,
    },
    asn: {
      number: null,
      name: null,
      type: null,
      source: null,
      rank: null,
      originated_prefixes: null,
      originated_prefixes_v6: null,
      originated_addresses: null,
      peer_visibility: null,
    },
    anonymity: { is_tor: false, is_vpn: false, is_proxy: false, providers: [] },
    abuse: null,
    rpki: { status: null, authorized_asns: [] },
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

/**
 * Resolve a single IP address to its enriched record. See the file header
 * for the full pipeline.
 */
export async function lookupIp(rawIp: string): Promise<IpLookupResult> {
  const ip = normalizeIp(rawIp.trim());
  const family = detectFamily(ip);
  if (!family) {
    throw new Error(`Invalid IP address: ${rawIp}`);
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
    anycastInfo,
    reverseDns,
    specialPurposeRows,
    anonymityRows,
    verifiedBotRows,
    neighborhoodRows,
    abuseRows,
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
            country: geofeedRangesTable.country,
            region: geofeedRangesTable.region,
            city: geofeedRangesTable.city,
            postal: geofeedRangesTable.postal,
            confidence: geofeedRangesTable.confidence,
            latitude: geofeedRangesTable.latitude,
            longitude: geofeedRangesTable.longitude,
            admin1: geofeedRangesTable.admin1,
          })
          .from(geofeedRangesTable)
          .where(sql`${geofeedRangesTable.network} >>= ${ip}::inet`)
          .orderBy(sql`masklen(${geofeedRangesTable.network}) desc`)
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
  const maxAgeMs = loadLookupConfig().abuseContactMaxAgeDays * 86_400_000;
  const abuseRowIsStale =
    !!abuseRow && Date.now() - abuseRow.ingestedAt.getTime() > maxAgeMs;
  const needAbuseRdap = wantAbuse && (!abuseRow || abuseRowIsStale);
  const needGeofeedRdap = wantGeo && !isAnycast && !geofeedRow;
  const rdapObject = needAbuseRdap || needGeofeedRdap ? await fetchRdapObject(ip) : null;

  const rdapAbuse = needAbuseRdap && rdapObject ? await abuseContactFromRdap(rdapObject) : null;
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
  const confidence: ConfidenceBlock = {
    overall: classification.confidence,
    // No confidence value is meaningful for "anycast" — no geo claim is
    // being made at all, so this isn't a "we're 100% sure" case (that was
    // a bug: 1 there implied maximum certainty for a block with no data).
    geo: isAnycast
      ? null
      : effectiveGeofeedRow
        ? effectiveGeofeedRow.confidence
        : geoMeta
          ? (countryConflict ? 0.15 : 0.2)
          : null,
    network: blockRow ? 0.95 : null,
    asn: asnEntry ? (asnEntry.source === "bgp-ris" ? 0.95 : 0.8) : null,
    usage_type: wantUsageType ? classification.confidence : null,
    threat: threatRow ? 0.9 : null,
  };

  // The classifier already merged anycast + cloud + threat tags.
  // Add network-level flags here.
  const flags = new Set<string>(classification.flags);
  if (rir) flags.add(`rir:${rir.toLowerCase()}`);
  if (country) flags.add(`country:${country.toLowerCase()}`);
  if (asnEntry?.asnNumber) flags.add(`as:${asnEntry.asnNumber}`);
  if (asnEntry?.source) flags.add(`asn-source:${asnEntry.source}`);
  if (geo.geo_source) flags.add(`geo:${geo.geo_source}`);
  if (countryConflict) {
    flags.add("country-conflict");
    flags.add(`block-country:${blockCountry!.toLowerCase()}`);
    flags.add(`asn-country:${asnCountry!.toLowerCase()}`);
  }

  const result: IpLookupResult = {
    ip,
    family,
    found: !!blockRow,
    cached: false,
    geo,
    network: {
      cidr: blockRow?.network ?? asnEntry?.prefix ?? null,
      // network_name: prefer the ASN org name from RIPE (more accurate than
      // the sparse field in RIR delegation files, which is often null).
      network_name: asnEntry?.asnName ?? blockRow?.networkName ?? null,
      allocation_date: blockRow?.registeredDate
        ? String(blockRow.registeredDate)
        : null,
      rir,
      status: wantNetworkStatus ? (blockRow?.status ?? null) : null,
    },
    asn: {
      number: asnEntry?.asnNumber ?? null,
      name: asnEntry?.asnName ?? null,
      type: asnEntry?.asnType ?? null,
      source: asnEntry?.source ?? null,
      rank: asnReachRow?.rank ?? null,
      originated_prefixes: asnReachRow?.originatedPrefixes ?? null,
      originated_prefixes_v6: asnReachRow?.originatedPrefixesV6 ?? null,
      originated_addresses: asnReachRow?.originatedAddresses ?? null,
      peer_visibility: asnReachRow?.peerVisibility ?? null,
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
        })
      : null,
    connection_type: wantConnectionType
      ? guessConnectionType(asnEntry?.asnName ?? null, reverseDns)
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
 * ASN lookup by ASN number. Returns metadata from asn_blocks plus the org
 * name + type harvested by the asn-name enrichment job.
 */
export async function lookupAsn(asn: number): Promise<AsnInfo | null> {
  const rows = await db
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
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    asn,
    name: row.name ?? null,
    type: row.type ?? null,
    country: row.country ?? null,
    rir: row.rir,
    registeredDate: row.registeredDate ? String(row.registeredDate) : null,
  };
}

/** Throw-away helper used by tests / health checks. */
export function _unusedSqlMarker(): unknown {
  return sql`SELECT 1`;
}
