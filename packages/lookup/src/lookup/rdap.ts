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
import { sql } from "drizzle-orm";
import { db, abuseContactsTable, geofeedRangesTable } from "@workspace/db";
import { logger, parseCidr, geofeedField, geofeedCountry } from "@workspace/shared";
import { loadLookupConfig } from "../config";

const RDAP_ENTRY_POINT = "https://rdap.db.ripe.net/ip/";
const RDAP_CACHE_SOURCE = "rdap-live";
const GEOFEED_CACHE_SOURCE = "geofeed-discovery:rdap-live";

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
export async function fetchRdapObject(ip: string): Promise<RdapResponse | null> {
  const timeoutMs = loadLookupConfig().rdapTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${RDAP_ENTRY_POINT}${encodeURIComponent(ip)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as RdapResponse;
  } catch (err) {
    logger.debug({ err, ip }, "RDAP lookup failed — degraded gracefully");
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
