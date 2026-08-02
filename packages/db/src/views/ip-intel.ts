/**
 * `ip_intel` — the one-query answer.
 *
 * Everything else in this database is organised by *source*: one table per
 * feed, each holding what that feed alone knows. That is the right shape for
 * building and auditing the data, and the wrong shape for using it. Asking
 * "what do I know about this address" against the source tables means seven
 * separate containment queries plus this project's layer-precedence rules
 * reimplemented in whatever language the consumer happens to be using.
 *
 * `ip_intel` flattens all of it into one relation, so a consumer in any
 * language writes exactly one query and inherits the precedence for free:
 *
 *     SELECT * FROM ip_intel
 *     WHERE network >>= '1.1.1.1'
 *     ORDER BY masklen(network) DESC
 *     LIMIT 1;
 *
 * How the rows are chosen: the base is every distinct prefix that appears in
 * any range table, and each signal column is filled by longest-prefix match
 * from its own table. That is the same rule `@workspace/lookup` applies per
 * IP, evaluated once per prefix boundary instead — which is why including
 * *every* table's prefixes in the base matters. If a geofeed covers a /25
 * inside an otherwise-plain /24, the /25 has to be its own base row, or an
 * address inside it would match the /24 row and miss the geofeed.
 *
 * Two forms, same definition (see `IpIntelMode`):
 *
 *   - `view` — a plain view. No storage, no build step, never stale.
 *     Measured at ~40-65ms per lookup on a full dataset: the seven range
 *     scans run as sequential nested loops, where `@workspace/lookup` fires
 *     them concurrently and finishes in under 20ms. Fine for a consumer
 *     querying the database directly; not what you'd put under a
 *     high-throughput API.
 *   - `materialized` — the same SELECT, precomputed. A lookup becomes a
 *     single GiST index probe. Costs a rebuild after each `enrich` and the
 *     disk to hold it. This is the shape commercial IP databases ship.
 *
 * The unique index on `network` is not decoration: it is what lets
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` work, so a rebuild doesn't lock
 * out readers. It is sound because the base is `SELECT DISTINCT network`.
 */
import { sql } from "drizzle-orm";
import { db } from "../index";

export type IpIntelMode = "view" | "materialized" | "off";

export const IP_INTEL_RELATION = "ip_intel";

/**
 * The flattening SELECT. Written once and used verbatim by both forms, so
 * the plain view and the materialized view can never disagree about what a
 * column means.
 */
const IP_INTEL_SELECT = `
SELECT
  b.network,
  family(b.network)                       AS family,
  blk.rir,
  blk.status                              AS rir_status,
  blk.network_name,
  blk.registered_date,
  COALESCE(gf.country, blk.country)       AS country,
  gf.city,
  gf.region,
  gf.postal,
  gf.latitude,
  gf.longitude,
  CASE WHEN gf.network IS NOT NULL THEN 'geofeed'
       WHEN ac.network IS NOT NULL THEN 'anycast'
       WHEN blk.country IS NOT NULL THEN 'country-estimate'
       ELSE NULL END                      AS geo_source,
  bgp.asn,
  an.name                                 AS asn_name,
  an.type                                 AS asn_type,
  ar.rank                                 AS asn_size_rank,
  ar.originated_prefixes                  AS asn_originated_prefixes,
  ar.originated_addresses                 AS asn_originated_addresses,
  ar.peer_visibility                      AS asn_peer_visibility,
  cl.provider                             AS cloud_provider,
  (cl.network IS NOT NULL)                AS is_cloud,
  (ac.network IS NOT NULL)                AS is_anycast,
  (th.network IS NOT NULL)                AS is_threat,
  th.source                               AS threat_source,
  th.category                             AS threat_category,
  sp.name                                 AS special_purpose,
  sp.rfc                                  AS special_purpose_rfc,
  sp.is_globally_reachable,
  an2.is_tor,
  an2.is_vpn,
  an2.anonymity_providers,
  ab.email                                AS abuse_email,
  ab.org                                  AS abuse_org,
  -- RPKI status is a property of (prefix, origin, max-length), so it can
  -- only be decided where an origin is known — which is exactly here, one
  -- row per prefix with bgp.asn already resolved.
  -- Order matters and the no-ROA case is the trap: an empty LATERAL
  -- aggregate yields covering=false (not NULL), so testing only for NULL
  -- would land every unsigned prefix in ELSE and report the majority of the
  -- internet as hijacked. "no ROA" is 'not-found', which is normal.
  CASE
    WHEN bgp.asn IS NULL THEN NULL
    WHEN NOT roa.covering THEN 'not-found'
    WHEN roa.authorized THEN 'valid'
    ELSE 'invalid'
  END                                     AS rpki_status,
  roa.authorized_asns                     AS rpki_authorized_asns,
  vb.bot                                  AS verified_bot,
  vb.operator                             AS verified_bot_operator
FROM (
  SELECT DISTINCT network FROM (
    SELECT network FROM ip_blocks
    UNION ALL SELECT network FROM bgp_origin_ranges
    UNION ALL SELECT network FROM geofeed_ranges
    UNION ALL SELECT network FROM cloud_ranges
    UNION ALL SELECT network FROM threat_ranges
    UNION ALL SELECT network FROM special_purpose_ranges
    UNION ALL SELECT network FROM anycast_ranges
    -- Tor/VPN entries are single addresses (/32, /128) — narrower than any
    -- prefix around them. Without them in the base, an address inside a
    -- listed /32 would match only the enclosing /24 base row, whose LATERAL
    -- ("does an anonymity range contain this /24") is false, and the flag
    -- would silently never fire.
    UNION ALL SELECT network FROM anonymity_ranges
    -- Published crawler ranges are typically /24-/27, narrower than the
    -- allocation rows around them — same reasoning as anonymity_ranges
    -- directly above.
    UNION ALL SELECT network FROM verified_bot_ranges
  ) u
) b
LEFT JOIN LATERAL (
  SELECT x.rir, x.status, x.network_name, x.registered_date, x.country
  FROM ip_blocks x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) blk ON true
LEFT JOIN LATERAL (
  -- network comes back alongside asn because RPKI validity is a property of
  -- the *announced route*, not of this base row. Most base rows are narrower
  -- than the announcement covering them (a Tor /32, a published crawler /27,
  -- a geofeed sub-prefix), and validating those against a ROA max-length is
  -- asking about an announcement nobody ever made.
  SELECT x.network, x.asn FROM bgp_origin_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC, x.peer_count DESC LIMIT 1) bgp ON true
LEFT JOIN LATERAL (
  SELECT x.network, x.city, x.region, x.postal, x.country, x.latitude, x.longitude
  FROM geofeed_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC, x.confidence DESC LIMIT 1) gf ON true
LEFT JOIN LATERAL (
  SELECT x.network, x.provider FROM cloud_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) cl ON true
LEFT JOIN LATERAL (
  SELECT x.network, x.source, x.category FROM threat_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) th ON true
LEFT JOIN LATERAL (
  SELECT x.network, x.name, x.rfc, x.is_globally_reachable
  FROM special_purpose_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) sp ON true
LEFT JOIN LATERAL (
  SELECT x.network FROM anycast_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) ac ON true
LEFT JOIN LATERAL (
  SELECT x.name, x.type FROM asn_blocks x
  WHERE x.asn_start <= bgp.asn AND x.asn_end >= bgp.asn
  ORDER BY x.asn_start DESC LIMIT 1) an ON true
LEFT JOIN LATERAL (
  SELECT x.rank, x.originated_prefixes, x.originated_addresses, x.peer_visibility
  FROM asn_reach x WHERE x.asn = bgp.asn LIMIT 1) ar ON true
LEFT JOIN LATERAL (
  SELECT bool_or(x.kind = 'tor') AS is_tor,
         bool_or(x.kind = 'vpn') AS is_vpn,
         array_agg(DISTINCT x.provider) FILTER (WHERE x.provider IS NOT NULL)
           AS anonymity_providers
  FROM anonymity_ranges x WHERE x.network >>= b.network) an2 ON true
LEFT JOIN LATERAL (
  SELECT x.email, x.org FROM abuse_contacts x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) ab ON true
LEFT JOIN LATERAL (
  SELECT x.bot, x.operator FROM verified_bot_ranges x WHERE x.network >>= b.network
  ORDER BY masklen(x.network) DESC LIMIT 1) vb ON true
LEFT JOIN LATERAL (
  SELECT count(*) > 0 AS covering,  -- false, never NULL, for an uncovered prefix
         bool_or(x.asn = bgp.asn AND masklen(bgp.network) <= x.max_length) AS authorized,
         array_agg(DISTINCT x.asn) AS authorized_asns
  -- Both tests use bgp.network (the announced prefix), never b.network.
  -- RFC 6811 validates a *route* — (announced prefix, origin AS) — and this
  -- row's own boundary is frequently not one. Using b.network here reported
  -- 96% of sampled Tor/verified-bot rows as RPKI-invalid, i.e. as hijacks,
  -- including Google's own published Googlebot ranges.
  FROM rpki_roas x WHERE x.prefix >>= bgp.network) roa ON true
`;

/** Whether `ip_intel` currently exists, and in which form. */
export async function ipIntelState(): Promise<IpIntelMode> {
  const rows = await db.execute<{ relkind: string }>(sql`
    SELECT c.relkind::text AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${IP_INTEL_RELATION} AND n.nspname = 'public'
  `);
  const kind = rows.rows[0]?.relkind;
  if (kind === "m") return "materialized";
  if (kind === "v") return "view";
  return "off";
}

/**
 * Bring `ip_intel` to the requested form. Idempotent — safe to call after
 * every enrichment run, which is exactly what the enrichment engine does.
 *
 * Postgres cannot convert between a view and a materialized view in place,
 * so a mode change means replacing the relation. Which direction matters:
 * dropping a materialized view to put a plain one back takes milliseconds,
 * but building a materialized view takes minutes — long enough that dropping
 * first would leave consumers with no `ip_intel` at all for the duration.
 * That direction therefore builds under a staging name and swaps in one
 * transaction (see below).
 *
 * Returns how many rows the relation holds for `materialized`, or null for
 * the other modes, where the question has no answer without scanning.
 */
export async function ensureIpIntel(mode: IpIntelMode): Promise<number | null> {
  const current = await ipIntelState();

  if (mode === "off") {
    await dropIpIntel();
    return null;
  }

  if (mode === "view") {
    // Switching down from materialized has to drop first — Postgres won't
    // replace a materialized view with a plain one. That gap is measured in
    // milliseconds (a DROP and a CREATE), unlike the reverse direction below.
    if (current === "materialized") await dropIpIntel();
    // Prefer CREATE OR REPLACE: it keeps any grants a consumer has added.
    // It only works while the column list is unchanged or appended to,
    // though — Postgres refuses to reorder or remove a view's columns in
    // place. A release that adds a column anywhere but the end therefore
    // lands here on the upgrade run, and the only way through is to drop
    // and recreate. Grants are lost in that case, which is worth saying out
    // loud rather than silently doing on every call.
    try {
      await db.execute(sql.raw(`CREATE OR REPLACE VIEW ${IP_INTEL_RELATION} AS ${IP_INTEL_SELECT}`));
    } catch {
      await db.execute(sql.raw(`DROP VIEW IF EXISTS ${IP_INTEL_RELATION}`));
      await db.execute(sql.raw(`CREATE VIEW ${IP_INTEL_RELATION} AS ${IP_INTEL_SELECT}`));
    }
    return null;
  }

  if (current === "materialized") {
    await refreshIpIntel();
  } else {
    // Build under a temporary name and swap at the end, rather than dropping
    // what's there first. The build takes minutes on a full dataset, and a
    // naive drop-then-create would leave `ip_intel` simply *missing* for that
    // whole window — every consumer query failing outright. Here the existing
    // relation keeps answering until the swap, and the swap itself is one
    // transaction, so no reader ever sees a gap.
    const staging = `${IP_INTEL_RELATION}_building`;
    await db.execute(sql.raw(`DROP MATERIALIZED VIEW IF EXISTS ${staging}`));
    await db.execute(sql.raw(`CREATE MATERIALIZED VIEW ${staging} AS ${IP_INTEL_SELECT}`));
    // The unique index is not optional: REFRESH ... CONCURRENTLY requires
    // one. It is sound because the base is SELECT DISTINCT network.
    await db.execute(sql.raw(`CREATE UNIQUE INDEX ${staging}_network_key ON ${staging} (network)`));
    await db.execute(
      sql.raw(`CREATE INDEX ${staging}_network_gist ON ${staging} USING gist (network inet_ops)`),
    );
    await db.execute(sql.raw(`CREATE INDEX ${staging}_asn_idx ON ${staging} (asn)`));

    await db.transaction(async (tx) => {
      // What exists is re-read HERE, inside the swap transaction — not taken
      // from `current`, which was captured before a build that takes hours
      // on a full dataset. Anything can happen to `ip_intel` in that window,
      // and one thing reliably does: an enrichment run finishing meanwhile
      // ends with ensureIpIntel("view") and recreates it as a plain view.
      // Trusting the stale answer meant either skipping the drop (`current`
      // said "off") or using the wrong DROP keyword (Postgres refuses to
      // DROP VIEW a materialized view and vice versa, even with IF EXISTS) —
      // both of which fail the rename and throw away the entire build at
      // its very last step. Seen happen: a 4.7-hour build lost to exactly
      // this race.
      const actual = await tx.execute<{ relkind: string }>(sql`
        SELECT c.relkind::text AS relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = ${IP_INTEL_RELATION} AND n.nspname = 'public'
      `);
      const kind = actual.rows[0]?.relkind;
      if (kind === "v") {
        await tx.execute(sql.raw(`DROP VIEW ${IP_INTEL_RELATION}`));
      } else if (kind === "m") {
        await tx.execute(sql.raw(`DROP MATERIALIZED VIEW ${IP_INTEL_RELATION}`));
      }
      await tx.execute(sql.raw(`ALTER MATERIALIZED VIEW ${staging} RENAME TO ${IP_INTEL_RELATION}`));
      // Indexes keep the staging name after the rename, which is only
      // cosmetic — but a later rebuild creates `${staging}_*` again and would
      // collide, so rename them too.
      for (const suffix of ["network_key", "network_gist", "asn_idx"]) {
        await tx.execute(
          sql.raw(`ALTER INDEX ${staging}_${suffix} RENAME TO ${IP_INTEL_RELATION}_${suffix}`),
        );
      }
    });
  }
  const rows = await db.execute<{ count: number }>(
    sql.raw(`SELECT count(*)::int AS count FROM ${IP_INTEL_RELATION}`),
  );
  return rows.rows[0]?.count ?? null;
}

/**
 * Recompute a materialized `ip_intel`. CONCURRENTLY so readers keep seeing
 * the previous contents instead of blocking for the length of the rebuild —
 * possible only because of the unique index created above.
 *
 * No-op when `ip_intel` is a plain view (nothing to refresh) or absent.
 */
export async function refreshIpIntel(): Promise<number | null> {
  if ((await ipIntelState()) !== "materialized") return null;
  await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${IP_INTEL_RELATION}`));
  const rows = await db.execute<{ count: number }>(
    sql.raw(`SELECT count(*)::int AS count FROM ${IP_INTEL_RELATION}`),
  );
  return rows.rows[0]?.count ?? null;
}

/** Drop `ip_intel` in whichever form it exists. */
export async function dropIpIntel(): Promise<void> {
  const current = await ipIntelState();
  if (current === "off") return;
  const keyword = current === "materialized" ? "MATERIALIZED VIEW" : "VIEW";
  await db.execute(sql.raw(`DROP ${keyword} IF EXISTS ${IP_INTEL_RELATION}`));
}
