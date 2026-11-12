import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { KNOWN_ENRICHMENT_SOURCES, type EnrichmentSourceConfig } from "./enrichment-sources";

/**
 * Whether disabling this source can remove *all* of its data automatically.
 *
 * True for geofeed sources that write only to `geofeed_ranges`, tagged with
 * their own registry id as `source_id` (checked in each ingester). Not for
 * `digitalocean-geofeed`, which also writes `cloud_ranges`, and not for
 * other kinds: their tables tag rows with ingester-chosen values that don't
 * always match the registry id (`feodotracker` writes
 * `abuse.ch-feodotracker`, `gcp-ip-ranges` writes `gcp`), so deleting by id
 * there would silently miss rows. Those are reported instead of guessed at.
 */
export function isFullyPurgeable(source: EnrichmentSourceConfig): boolean {
  return source.kind === "geofeed" && source.parser !== "digitalocean-geofeed-csv";
}

export interface DisabledPurgeResult {
  /** Rows removed from `geofeed_ranges`. */
  deletedGeofeedRows: number;
  /** Disabled ids whose earlier data may still sit in some table. */
  notFullyPurged: string[];
}

/**
 * Removes the data of sources listed in `disabledEnrichmentSources`, so a
 * disabled source stops reaching `ip_intel` and the customer `.mmdb` — not
 * just stops downloading. Its registry entry stays: re-enabling it is a
 * config edit, and its next run downloads the data again.
 */
export async function purgeDisabledSourceRows(ids: string[]): Promise<DisabledPurgeResult> {
  if (ids.length === 0) return { deletedGeofeedRows: 0, notFullyPurged: [] };
  const result = await db.execute<{ deleted: number }>(sql`
    WITH removed AS (
      DELETE FROM geofeed_ranges
      WHERE source_id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM removed
  `);
  const notFullyPurged = ids.filter((id) => {
    const s = KNOWN_ENRICHMENT_SOURCES.find((k) => k.id === id);
    return !s || !isFullyPurgeable(s);
  });
  return { deletedGeofeedRows: result.rows[0]?.deleted ?? 0, notFullyPurged };
}
