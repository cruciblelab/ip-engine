import { sql } from "drizzle-orm";
import { db, GEOFEED_LIVE_DISCOVERY_SOURCE_ID, RDAP_LIVE_CACHE_SOURCE } from "@workspace/db";

export interface RdapCachePurgeResult {
  abuseContacts: number;
  networkNames: number;
  geofeedRows: number;
}

/**
 * Removes everything earlier live RDAP queries cached. Run by `enrich` while
 * `rdapEnabled` is false (`docs/106` G1): RDAP abuse contacts can be
 * personal data, and live collection is kept out of the product. Only
 * RDAP-tagged rows go; `security.txt` contacts (self-published, G3) stay.
 */
export async function purgeRdapCache(): Promise<RdapCachePurgeResult> {
  const count = async (q: ReturnType<typeof sql>): Promise<number> => {
    const r = await db.execute<{ n: number }>(q);
    return r.rows[0]?.n ?? 0;
  };
  const abuseContacts = await count(sql`
    WITH d AS (DELETE FROM abuse_contacts WHERE source = ${RDAP_LIVE_CACHE_SOURCE} RETURNING 1)
    SELECT count(*)::int AS n FROM d`);
  const networkNames = await count(sql`
    WITH d AS (DELETE FROM network_names WHERE source = ${RDAP_LIVE_CACHE_SOURCE} RETURNING 1)
    SELECT count(*)::int AS n FROM d`);
  const geofeedRows = await count(sql`
    WITH d AS (DELETE FROM geofeed_ranges WHERE source_id = ${GEOFEED_LIVE_DISCOVERY_SOURCE_ID} RETURNING 1)
    SELECT count(*)::int AS n FROM d`);
  return { abuseContacts, networkNames, geofeedRows };
}
