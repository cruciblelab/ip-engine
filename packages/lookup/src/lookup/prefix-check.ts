/**
 * The free, no-account "self-check" (SSL-Labs-style) — an operator enters
 * their own prefix and gets a report card: geofeed published, RPKI signed,
 * abuse contact resolves, reverse DNS in place. Item 7 of the 2026-07-28
 * roadmap, built once the SaaS launch made "there's a site to put it on"
 * true.
 *
 * Deliberately a *report*, not a score: same discipline as risk.ts and
 * neighborhood_stats — each field is a fact an operator can act on
 * ("publish a geofeed"), never a single number they'd have to trust blindly.
 *
 * No new table, no precomputation: every check here reuses a query shape
 * that already exists elsewhere in this codebase (geofeed containment,
 * the RPKI-validity join from computeAsnProfile, the RDAP/security.txt
 * abuse-contact chain from lookup.ts) against a single caller-supplied
 * prefix instead of the whole database. Cheap enough to run on demand.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { parseCidr, ipv4ToInt, intToIpv4, logger } from "@workspace/shared";
import { fetchRdapObject, abuseContactFromRdap } from "./rdap";
import { reverseDnsLookup } from "./reverse-dns";

/** Widest prefix accepted per family — bounds query cost and stops the free
 * tool being used to bulk-scan huge blocks one CTE at a time. An operator's
 * own allocation is almost always narrower than this. */
const MIN_PREFIX_LEN: Record<4 | 6, number> = { 4: 16, 6: 32 };

/** How many addresses inside the prefix get a live PTR lookup. Small and
 * fixed regardless of prefix width — this is a spot-check, not a sweep;
 * see the IPv4-only note below. */
const RDNS_SAMPLE_SIZE = 5;

/** Bad caller input (invalid CIDR, prefix too wide) — as opposed to an
 * infrastructure failure mid-check. The HTTP route maps this to 400 and
 * everything else to a generic 500, so a database error never leaks its
 * SQL text to what is meant to be a public, unauthenticated endpoint. */
export class PrefixCheckInputError extends Error {}

export interface PrefixCheckReport {
  /** Canonical network address (host bits zeroed) — what was actually
   * checked, which is not always what was typed: "8.8.8.5/24" is answered
   * as "8.8.8.0/24". */
  prefix: string;
  family: 4 | 6;
  geofeed: {
    published: boolean;
    city: string | null;
    country: string | null;
  };
  rpki: {
    announcedRanges: number;
    valid: number;
    invalid: number;
    unsigned: number;
  };
  abuseContact: {
    resolved: boolean;
    org: string | null;
  };
  reverseDns: {
    /** IPv6 sampling needs 128-bit address arithmetic this codebase
     * deliberately doesn't have yet (see ipv4CidrToRange's header) —
     * rather than build fragile ad-hoc BigInt math for one feature,
     * this comes back empty for v6 and says so. */
    supported: boolean;
    sampled: number;
    resolved: number;
  };
  checkedAt: string;
}

function ipv4Samples(input: string, prefixLen: number): string[] {
  const slash = input.indexOf("/");
  const size = Math.pow(2, 32 - prefixLen);
  // Mask to the aligned network address before walking forward. checkPrefix
  // already normalises its input, but this helper must not depend on that:
  // given "8.8.8.255/24" un-masked, base+1 is 8.8.9.0 and every sample
  // lands in someone else's block — a report about the wrong network.
  const base = Math.floor(ipv4ToInt(input.slice(0, slash)) / size) * size;
  // Skip the network address (offset 0) when the block is large enough to
  // have one; a /32 has no such thing to skip.
  const start = size > 1 ? base + 1 : base;
  const count = Math.min(RDNS_SAMPLE_SIZE, size > 1 ? size - 1 : 1);
  return Array.from({ length: count }, (_, i) => intToIpv4(start + i));
}

export async function checkPrefix(rawInput: string): Promise<PrefixCheckReport> {
  const parsed = parseCidr(rawInput);
  if (!parsed) {
    throw new PrefixCheckInputError(
      `"${rawInput}" is not a valid CIDR prefix (e.g. 203.0.113.0/24)`,
    );
  }
  const { family, prefixLen } = parsed;
  const minLen = MIN_PREFIX_LEN[family];
  if (prefixLen < minLen) {
    throw new PrefixCheckInputError(
      `Prefix too wide to self-check — narrower than /${minLen} required for IPv${family}`,
    );
  }

  // Canonicalise once, with Postgres's own inet logic (works for both
  // families), and use the result everywhere below. The containment
  // operators ignore host bits anyway, so without this the queries would
  // silently answer about "8.8.8.0/24" while the report echoed
  // "8.8.8.5/24" — correct data under a misleading label.
  const normalized = await db.execute<{ p: string }>(
    sql`SELECT network(${rawInput}::inet)::text AS p`,
  );
  const input = normalized.rows[0]?.p;
  if (!input) throw new PrefixCheckInputError(`"${rawInput}" could not be parsed as a prefix`);

  const [geofeedRow, rpki, abuseRow] = await Promise.all([
    db.execute<{ city: string | null; country: string | null }>(sql`
      SELECT city, country FROM geofeed_ranges
      WHERE network && ${input}::inet
      ORDER BY masklen(network) DESC LIMIT 1
    `),
    db.execute<{
      announced: number;
      valid: number;
      invalid: number;
      unsigned: number;
    }>(sql`
      WITH announced AS (
        SELECT DISTINCT network, asn FROM bgp_origin_ranges WHERE network && ${input}::inet
      ), classified AS (
        SELECT
          CASE
            WHEN NOT r.covering THEN 'unsigned'
            WHEN r.authorized  THEN 'valid'
            ELSE 'invalid'
          END AS rpki
        FROM announced a
        LEFT JOIN LATERAL (
          SELECT count(*) > 0 AS covering,
                 bool_or(x.asn = a.asn AND masklen(a.network) <= x.max_length) AS authorized
          FROM rpki_roas x WHERE x.prefix >>= a.network
        ) r ON true
      )
      SELECT
        count(*)::int AS announced,
        count(*) FILTER (WHERE rpki = 'valid')::int    AS valid,
        count(*) FILTER (WHERE rpki = 'invalid')::int  AS invalid,
        count(*) FILTER (WHERE rpki = 'unsigned')::int AS unsigned
      FROM classified
    `),
    db.execute<{ org: string | null }>(sql`
      SELECT org FROM abuse_contacts WHERE network && ${input}::inet
      ORDER BY masklen(network) DESC LIMIT 1
    `),
  ]);

  let abuseContact = { resolved: !!abuseRow.rows[0], org: abuseRow.rows[0]?.org ?? null };
  if (!abuseContact.resolved) {
    // Same live fallback lookup.ts uses on a cache miss, run once against a
    // representative address rather than per-lookup — the RDAP result is
    // for the whole holder network, not just the one address queried.
    const representative = input.slice(0, input.indexOf("/"));
    try {
      const rdap = await fetchRdapObject(representative);
      const live = rdap ? await abuseContactFromRdap(rdap) : null;
      if (live) abuseContact = { resolved: true, org: live.org };
    } catch (err) {
      logger.debug({ err, input }, "self-check RDAP abuse lookup failed — degraded gracefully");
    }
  }

  let reverseDns = { supported: family === 4, sampled: 0, resolved: 0 };
  if (family === 4) {
    const samples = ipv4Samples(input, prefixLen);
    const hostnames = await Promise.all(samples.map((ip) => reverseDnsLookup(ip)));
    reverseDns = {
      supported: true,
      sampled: samples.length,
      resolved: hostnames.filter((h) => h !== null).length,
    };
  }

  const geo = geofeedRow.rows[0];
  return {
    prefix: input,
    family,
    geofeed: {
      published: !!geo,
      city: geo?.city ?? null,
      country: geo?.country ?? null,
    },
    rpki: {
      announcedRanges: rpki.rows[0]?.announced ?? 0,
      valid: rpki.rows[0]?.valid ?? 0,
      invalid: rpki.rows[0]?.invalid ?? 0,
      unsigned: rpki.rows[0]?.unsigned ?? 0,
    },
    abuseContact,
    reverseDns,
    checkedAt: new Date().toISOString(),
  };
}
