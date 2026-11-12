import { sql } from "drizzle-orm";
import { db, GEOFEED_LIVE_DISCOVERY_SOURCE_ID } from "@workspace/db";

/**
 * Deletes DB-IP Lite rows already covered by a real, bulk-ingested geofeed,
 * and returns how many went. Why the rows are deleted rather than merely
 * outranked: see the call site in `ingestDbIpLiteCsv` (enrichment.ts).
 *
 * Live-discovered geofeed rows (`GEOFEED_LIVE_DISCOVERY_SOURCE_ID`) do not
 * count as coverage. They never reach `ip_intel` or the `.mmdb`, so pruning
 * under them would leave those addresses with no geo at all in the customer
 * file — the live row excluded, and the DB-IP fallback deleted.
 *
 * Its own module so it can be tested against a real database without a
 * DB-IP download (`dbip-prune.integration.test.ts`).
 */
export async function pruneDbIpCoveredByGeofeeds(): Promise<number> {
  const result = await db.execute<{ deleted: number }>(sql`
    WITH removed AS (
      DELETE FROM dbip_lite_ranges d
      WHERE EXISTS (
        SELECT 1 FROM geofeed_ranges g
        WHERE g.network >>= d.network
          AND g.source_id <> ${GEOFEED_LIVE_DISCOVERY_SOURCE_ID}
      )
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM removed
  `);
  return result.rows[0]?.deleted ?? 0;
}
