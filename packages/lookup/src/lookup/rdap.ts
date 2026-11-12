/**
 * RDAP — live, per-address lookups against whichever RIR is authoritative
 * for a given IP, replacing what this project used to get from bulk RIPE/
 * APNIC whois dumps: abuse contact and RFC 9092 geofeed discovery.
 *
 * Why this is a different thing from the bulk dumps it replaces, not just a
 * workaround for their redistribution terms: RDAP is the IETF-standardised
 * protocol (RFC 7480-7484) every RIR is required to run specifically for
 * individual, machine-readable queries — as opposed to a bulk whois dump,
 * built for offline research use, whose terms this project cannot meet
 * once it's serving many customers' worth of query volume. Querying RDAP
 * one address at a time is the same action a user's own browser takes
 * clicking "lookup" on any RIR's site — just automated.
 *
 * Referral is handled by the protocol itself, not by this module: every
 * RIR's RDAP server redirects to the correct one for an out-of-region
 * address (verified against all five: RIPE's server 301s to ARIN, APNIC,
 * and LACNIC for their respective space), so a single entry point plus
 * following redirects is sufficient — no local bootstrap-file/CIDR-matching
 * needs maintaining here.
 *
 * Same contract as reverse-dns.ts, the existing live-lookup precedent in
 * this file's neighbourhood: bounded by a timeout, never throws, never
 * blocks a lookup on failure — a dead or slow RIR RDAP server degrades to
 * "no data", not to a broken response.
 *
 * Results are cached (write-through, on the same tables the old bulk
 * sources populated) so a second query for the same prefix never needs a
 * live RDAP round trip at all.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { sql } from "drizzle-orm";
import {
  db,
  abuseContactsTable,
  geofeedRangesTable,
  networkNamesTable,
  GEOFEED_LIVE_DISCOVERY_SOURCE_ID,
} from "@workspace/db";
import { logger, parseCidr, geofeedField, geofeedCountry, isPubliclyRoutable } from "@workspace/shared";
import { loadLookupConfig } from "../config";

/**
 * Per-RIR RDAP endpoints, so a query goes straight to the registry that is
 * actually authoritative for the address instead of bouncing off one of
 * them and following a redirect.
 *
 * This used to be a single hardcoded RIPE entry point, relying on RDAP's
 * own referral behaviour to redirect out-of-region queries (which does
 * work — verified against all five). The problem is not correctness, it is
 * **quota**: RIRs rate-limit RDAP per client address (RIPE blocks for the
 * day past roughly a thousand personal-data queries, LACNIC far sooner),
 * and routing everything through one of them spends a single registry's
 * quota on lookups for address space it does not even hold. Every one of
 * these was confirmed live (HTTP 200 on a real address in that registry's
 * own space) before being wired up.
 *
 * Note the path differs per registry — this is not a hostname swap.
 *
 * The `rir` this is keyed by comes from `ip_blocks`, which the caller has
 * already read for other fields, so choosing the right endpoint costs
 * nothing extra. RIPE stays the fallback for the case where that lookup
 * found no row (an address in no delegated-stats file at all): its
 * redirect behaviour is what the single-endpoint version relied on
 * throughout, so the fallback is exactly the old behaviour, not a guess.
 */
const RDAP_ENDPOINTS: Record<string, string> = {
  ARIN: "https://rdap.arin.net/registry/ip/",
  RIPENCC: "https://rdap.db.ripe.net/ip/",
  APNIC: "https://rdap.apnic.net/ip/",
  LACNIC: "https://rdap.lacnic.net/rdap/ip/",
  AFRINIC: "https://rdap.afrinic.net/rdap/ip/",
};
const RDAP_FALLBACK_ENDPOINT = RDAP_ENDPOINTS["RIPENCC"]!;
const RDAP_CACHE_SOURCE = "rdap-live";
/** Exported so lookup.ts can tell an RDAP-discovered geofeed row (which
 * this module is responsible for refreshing, since nothing else revisits
 * it) apart from one a bulk source published (which `enrich` already
 * refreshes on its own schedule, and must never be re-fetched live). */
export const GEOFEED_CACHE_SOURCE = GEOFEED_LIVE_DISCOVERY_SOURCE_ID;

/**
 * Per-registry query budget, enforced here rather than discovered by being
 * blocked.
 *
 * Without this the failure mode is: run normally until a RIR cuts this
 * host off, then serve nothing from that registry for the rest of the day
 * — and find out only from a sudden drop in abuse/geofeed coverage. The
 * budget makes the same limit visible and self-imposed instead: once a
 * registry's allowance is spent, RDAP for that registry is skipped and the
 * lookup degrades exactly the way it already degrades on a timeout (cached
 * data, or nothing, never an error), while the other four registries keep
 * working normally.
 *
 * A rolling 24h window per registry, held in memory: it resets on restart,
 * which is the conservative direction (a restart can only give back budget
 * that a fresh process was going to spend anyway), and it deliberately
 * does not coordinate across processes — a multi-server deployment gets
 * one budget per server, which matches how the RIRs count in the first
 * place (per client address).
 */
const RDAP_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
interface RdapBudget {
  used: number;
  windowStartedAt: number;
}
const rdapBudgets = new Map<string, RdapBudget>();

/** Exported for observability (`ip-insight status`-style reporting and
 * tests) — the counters are otherwise invisible until something is already
 * being skipped. */
export function rdapBudgetStats(): Array<{ rir: string; used: number; windowStartedAt: number }> {
  return [...rdapBudgets.entries()].map(([rir, b]) => ({
    rir,
    used: b.used,
    windowStartedAt: b.windowStartedAt,
  }));
}

/** Discards all budget state. Exported for tests only — the counters are
 * process-lifetime by design, so a test asserting exhaustion would
 * otherwise leak into the next one. */
export function __resetRdapBudgets(): void {
  rdapBudgets.clear();
}

/** Reserves one query against `rir`'s budget, or refuses when it is spent.
 * Refusal is the whole point: the caller skips the request entirely rather
 * than making it and being blocked.
 *
 * Exported (rather than left private) so the per-registry independence
 * this whole change exists for is directly testable without a network —
 * see rdap-budget.test.ts. */
export function claimRdapBudget(rir: string, cap: number): boolean {
  // Checked before the fresh-window branch below, not after: `cap: 0` is a
  // supported setting meaning "never make a live RDAP call at all" (a
  // deployment that wants zero third-party dependency at request time),
  // and a window-reset must not hand out a free first query in that case.
  if (cap <= 0) return false;
  const now = Date.now();
  const budget = rdapBudgets.get(rir);
  if (!budget || now - budget.windowStartedAt >= RDAP_BUDGET_WINDOW_MS) {
    rdapBudgets.set(rir, { used: 1, windowStartedAt: now });
    return true;
  }
  if (budget.used >= cap) return false;
  budget.used++;
  return true;
}

interface RdapVcardField extends Array<unknown> {
  0: string;
  3: unknown;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, RdapVcardField[]];
}

interface RdapCidr {
  v4prefix?: string;
  v6prefix?: string;
  length?: number;
}

interface RdapLink {
  rel?: string;
  href?: string;
}

interface RdapResponse {
  entities?: RdapEntity[];
  links?: RdapLink[];
  cidr0_cidrs?: RdapCidr[];
  startAddress?: string;
  endAddress?: string;
  /** The registry's own name for the allocation (`PCH-PUBLIC-RESOLVER`,
   * `RIPE-NCC`, ...). Present in all five RIRs' responses — verified
   * against a real address in each registry's own space, not assumed from
   * one of them. See networkNames.ts for why this is the only source this
   * project has for the field. */
  name?: string;
}

/**
 * One RDAP round trip for an address, exported so a caller that needs both
 * signals below pays for a single request rather than one each.
 *
 * That distinction is not a micro-optimisation: RIRs rate-limit RDAP (RIPE
 * blocks an address for the day past ~1,000 personal-data queries, LACNIC
 * far sooner), so querying twice per lookup would halve the effective quota
 * for no benefit — both extractors read different fields of the *same*
 * document.
 */
export async function fetchRdapObject(
  ip: string,
  /** The RIR that holds this address, from `ip_blocks` — already read by
   * the caller, so routing to the right registry is free. `null`/unknown
   * falls back to RIPE and its redirects, the old single-endpoint
   * behaviour. */
  rir?: string | null,
): Promise<RdapResponse | null> {
  const config = loadLookupConfig();
  // The single gate for every live RDAP query (abuse contact, network name,
  // geofeed discovery, prefix-check) — all of them start here.
  if (!config.rdapEnabled) return null;
  const registry = rir?.trim().toUpperCase() ?? "";
  const endpoint = RDAP_ENDPOINTS[registry] ?? RDAP_FALLBACK_ENDPOINT;
  // Budget is keyed by the endpoint actually being called, not by the
  // requested `rir` — an unknown/absent RIR routes to RIPE, so it must
  // spend RIPE's allowance, not a phantom one of its own.
  const budgetKey = RDAP_ENDPOINTS[registry] ? registry : "RIPENCC";
  if (!claimRdapBudget(budgetKey, config.rdapDailyQueryCap)) {
    logger.debug(
      { ip, rir: budgetKey, cap: config.rdapDailyQueryCap },
      "RDAP skipped: daily query budget for this registry is spent — degraded gracefully",
    );
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.rdapTimeoutMs);
  try {
    const response = await fetch(`${endpoint}${encodeURIComponent(ip)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as RdapResponse;
  } catch (err) {
    logger.debug({ err, ip, rir: budgetKey }, "RDAP lookup failed — degraded gracefully");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function vcardField(vcard: RdapVcardField[] | undefined, name: string): string | null {
  const field = vcard?.find((f) => f[0] === name);
  return typeof field?.[3] === "string" ? field[3] : null;
}

/** The network this RDAP object actually describes, for caching by prefix
 * rather than by the single queried address — otherwise every address in
 * the same /24 would trigger its own RDAP call. `cidr0_cidrs` is exact when
 * present; the `startAddress`-`endAddress` range (always present) is
 * resolved to its covering CIDR the same way the old bulk-whois ingestion
 * did, via Postgres `inet_merge`, when it isn't. */
async function rdapNetworkCidr(rdap: RdapResponse): Promise<string | null> {
  const cidr = rdap.cidr0_cidrs?.[0];
  const prefix = cidr?.v4prefix ?? cidr?.v6prefix;
  if (prefix && typeof cidr?.length === "number") return `${prefix}/${cidr.length}`;

  if (rdap.startAddress && rdap.endAddress) {
    try {
      const result = await db.execute<{ cidr: string }>(
        sql`SELECT inet_merge(${rdap.startAddress}::inet, ${rdap.endAddress}::inet)::text AS cidr`,
      );
      return result.rows[0]?.cidr ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The registry's name for this allocation, cached by the prefix the RDAP
 * object describes.
 *
 * Deliberately has no fetch of its own: it reads a field off a response
 * some *other* signal already paid for. `ip_blocks.network_name` has been
 * null on every row since this project started (the RIR statistics files
 * carry no name field at all — see networkNames.ts), and this closes that
 * without spending a single additional query against a registry's quota.
 *
 * Returns null when the response carries no usable name, which is normal
 * for some LACNIC objects — their `name` is sometimes just the address
 * range restated as text (`"200.3.12.0 - 200.3.15.255"`), which is not a
 * name in any useful sense and is filtered out rather than stored as if
 * it were one.
 */
export async function networkNameFromRdap(rdap: RdapResponse): Promise<string | null> {
  const raw = rdap.name?.trim();
  if (!raw) return null;
  // Reject the "name is just the range again" case seen in real LACNIC
  // responses. Anything containing a dash between two address-looking
  // tokens, or that parses as a bare address/CIDR, carries no information
  // the `network` column doesn't already hold.
  if (/^[0-9a-fA-F.:]+\s*-\s*[0-9a-fA-F.:]+$/.test(raw)) return null;
  if (/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(raw)) return null;

  const network = await rdapNetworkCidr(rdap);
  if (network) {
    void db
      .insert(networkNamesTable)
      .values({ network, name: raw, source: RDAP_CACHE_SOURCE })
      .onConflictDoUpdate({
        target: [networkNamesTable.network, networkNamesTable.source],
        set: { name: sql`excluded.name`, ingestedAt: sql`now()` },
      })
      .catch((err) => logger.debug({ err, network }, "network name cache write failed"));
  }
  return raw;
}

export interface RdapAbuseContact {
  email: string | null;
  phone: string | null;
  org: string | null;
}

async function cacheAbuseContact(network: string, contact: RdapAbuseContact): Promise<void> {
  await db
    .insert(abuseContactsTable)
    .values({ network, email: contact.email, phone: contact.phone, org: contact.org, source: RDAP_CACHE_SOURCE })
    .onConflictDoUpdate({
      target: [abuseContactsTable.network, abuseContactsTable.source],
      // `ingested_at` is refreshed too: it is what the staleness check in
      // lookup.ts reads, so leaving it at the original fetch time would
      // mean a row re-fetched today still looked months old and would be
      // re-fetched again on the very next lookup.
      set: {
        email: sql`excluded.email`,
        phone: sql`excluded.phone`,
        org: sql`excluded.org`,
        ingestedAt: sql`now()`,
      },
    });
}

/**
 * Live abuse-contact lookup, called only on a cache miss (see lookup.ts —
 * the `abuse_contacts` table is checked first; this is the fallback that
 * populates it for next time). Returns null on anything from "no abuse
 * role in this RDAP object" to "the RIR's server timed out" — the caller
 * cannot and should not distinguish those, matching how an empty result
 * has always been handled here.
 */
export async function abuseContactFromRdap(rdap: RdapResponse): Promise<RdapAbuseContact | null> {
  const abuseEntity = rdap.entities?.find((e) => e.roles?.includes("abuse"));
  const vcard = abuseEntity?.vcardArray?.[1];
  const email = vcardField(vcard, "email");
  if (!email) return null;
  const contact: RdapAbuseContact = { email, phone: vcardField(vcard, "tel"), org: vcardField(vcard, "fn") };

  const network = await rdapNetworkCidr(rdap);
  if (network) {
    void cacheAbuseContact(network, contact).catch((err) =>
      logger.debug({ err, network }, "abuse contact cache write failed"),
    );
  }
  return contact;
}

/**
 * Live RFC 9092 geofeed discovery for a single prefix, called only when the
 * existing `geofeed_ranges` table has no row covering the queried address.
 * RDAP's `geofeed1` extension surfaces the same reference the old bulk-
 * whois scan found (a `links` entry with `rel: "geofeed"`) — verified
 * against real data: querying RDAP for a prefix already known (from the old
 * bulk scan) to publish a geofeed returns the identical CSV URL.
 *
 * Unlike abuse contact, this needs a second fetch (the geofeed CSV itself)
 * and a containment check before it's usable — RFC 9092 lets a publisher
 * describe only their own space, so a row outside the RDAP object's own
 * range is dropped exactly as the old ingestion dropped it.
 */
export interface RdapGeofeedMatch {
  country: string | null;
  region: string | null;
  city: string | null;
  postal: string | null;
  /** Never resolved at fetch time, same as the old bulk-whois ingestion —
   * a separate GeoNames correlation pass fills these in from `city`, on
   * whatever schedule that already runs, not on this live-fetch path. */
  admin1: null;
  latitude: null;
  longitude: null;
  confidence: number;
}

export async function geofeedFromRdap(
  rdap: RdapResponse,
  ip: string,
): Promise<RdapGeofeedMatch | null> {
  const geofeedLink = rdap.links?.find((l) => l.rel === "geofeed" && l.href);
  if (!geofeedLink?.href) return null;

  const holder = await rdapNetworkCidr(rdap);
  if (!holder) return null;

  // SSRF guard: RFC 9092 puts no constraint on this URL at all — whoever
  // holds the RDAP delegation for *any* IP block can point it anywhere,
  // e.g. http://169.254.169.254/ (cloud instance-metadata) or an internal
  // hostname that only resolves on this host's network. So the target has
  // to be validated like any other attacker-supplied URL before this
  // server fetches it on their behalf: https-only, and every DNS-resolved
  // address (v4 and v6, not just the first one back) has to be a normal
  // public unicast address — see isPubliclyRoutable's doc comment for why
  // that also has to catch IPv4-mapped IPv6 literals.
  //
  // Known residual gap (TOCTOU / DNS rebinding): this validates the
  // hostname's resolution *now*, but fetch() below re-resolves and
  // connects on its own a moment later — a TTL=0 attacker-controlled
  // resolver could in principle answer differently the second time.
  // Closing that fully needs pinning the fetch to the exact validated
  // address (e.g. a custom undici dispatcher with a `lookup` override),
  // which isn't done here: undici isn't a direct dependency of this repo
  // today, and adding one purely to close this narrow a gap was judged
  // out of scope for this fix. The DNS-resolve-then-check below still
  // closes the actual reported vulnerability (a static malicious href),
  // just not a fully adaptive DNS-rebinding attacker.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(geofeedLink.href);
  } catch (err) {
    logger.debug({ err, url: geofeedLink.href }, "geofeed URL unparseable — degraded gracefully");
    return null;
  }
  if (parsedUrl.protocol !== "https:") {
    logger.debug(
      { url: geofeedLink.href, protocol: parsedUrl.protocol },
      "geofeed URL rejected: non-https scheme — degraded gracefully",
    );
    return null;
  }
  try {
    const resolved = await dnsLookup(parsedUrl.hostname, { all: true });
    if (resolved.length === 0 || !resolved.every((r) => isPubliclyRoutable(r.address))) {
      logger.debug(
        { url: geofeedLink.href, resolved },
        "geofeed URL rejected: resolves to a non-public address — degraded gracefully",
      );
      return null;
    }
  } catch (err) {
    logger.debug({ err, url: geofeedLink.href }, "geofeed URL DNS resolution failed — degraded gracefully");
    return null;
  }

  const timeoutMs = loadLookupConfig().rdapTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: string;
  try {
    const feed = await fetch(geofeedLink.href, { signal: controller.signal });
    if (!feed.ok) return null;
    body = await feed.text();
  } catch (err) {
    logger.debug({ err, url: geofeedLink.href }, "geofeed fetch failed — degraded gracefully");
    return null;
  } finally {
    clearTimeout(timer);
  }

  const rows: Array<typeof geofeedRangesTable.$inferInsert> = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [prefix, country, region, city, postal] = line.split(",");
    const network = geofeedField(prefix);
    if (!network || !parseCidr(network)) continue;
    rows.push({
      network,
      country: geofeedCountry(country),
      region: geofeedField(region),
      city: geofeedField(city),
      postal: geofeedField(postal),
      sourceId: GEOFEED_CACHE_SOURCE,
      confidence: 0.85,
    });
  }
  if (rows.length === 0) return null;

  let insideSet: Set<string>;
  try {
    const result = await db.execute<{ n: string }>(sql`
      SELECT n::text AS n
      FROM unnest(${sql.raw(`ARRAY[${rows.map((r) => `'${r.network}'`).join(",")}]::inet[]`)}) AS n
      WHERE n <<= ${holder}::inet
    `);
    insideSet = new Set(result.rows.map((r) => r.n));
  } catch (err) {
    logger.debug({ err, holder }, "geofeed containment check failed — feed skipped");
    return null;
  }
  const contained = rows.filter((r) => insideSet.has(String(r.network)));
  if (contained.length === 0) return null;

  try {
    await db.insert(geofeedRangesTable).values(contained).onConflictDoNothing();
  } catch (err) {
    logger.debug({ err }, "geofeed cache write failed");
  }

  // Which of the just-cached rows actually covers the queried address —
  // a real containment/mask check via the same longest-prefix-match query
  // every other range table here uses, not string parsing: a feed's rows
  // are arbitrary sub-prefixes of the holder's space, several of which can
  // exist without any of them being the one covering this specific `ip`.
  try {
    const result = await db.execute<{
      country: string | null;
      region: string | null;
      city: string | null;
      postal: string | null;
    }>(sql`
      SELECT country, region, city, postal
      FROM geofeed_ranges
      WHERE source_id = ${GEOFEED_CACHE_SOURCE} AND network >>= ${ip}::inet
      ORDER BY masklen(network) DESC
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, admin1: null, latitude: null, longitude: null, confidence: 0.85 };
  } catch (err) {
    logger.debug({ err, ip }, "geofeed match query failed");
    return null;
  }
}
