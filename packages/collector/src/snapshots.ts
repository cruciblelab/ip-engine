/**
 * Versioned snapshots and incremental deltas.
 *
 * A snapshot records what `ip_intel` said, per prefix, as a content hash. A
 * delta is then the set difference between two snapshots: prefixes added,
 * removed, or whose answer changed. That is the piece a consumer needs to
 * keep their own copy in step without re-downloading the whole database
 * daily — which, at a few million prefixes, is the difference between a
 * sync that runs in seconds and one that doesn't get run at all.
 *
 * The hash is computed in Postgres (`hashtextextended`) over the same column
 * list on both sides, so the comparison never leaves the database and never
 * depends on how JavaScript happens to serialise a row.
 *
 * A deliberate limitation, stated because it decides what this is good for:
 * a delta tells you what a prefix says *now*, not what it said before. Only
 * the current `ip_intel` is queryable; snapshots keep hashes, not history.
 * Rolling back to a previous build is the backup/restore path, not this one.
 */
import { sql, eq, desc } from "drizzle-orm";
import { db, snapshotsTable, snapshotPrefixesTable, ipIntelState } from "@workspace/db";
import { logger } from "@workspace/shared";

/** Columns that define "the answer" for a prefix. Adding a column here
 * changes every hash, which correctly makes the next delta report every
 * prefix as changed — a release that adds a signal really has changed every
 * answer. */
const HASHED_COLUMNS = sql`
  coalesce(country,'') || '|' || coalesce(city,'') || '|' || coalesce(region,'') ||
  '|' || coalesce(postal,'') || '|' || coalesce(latitude::text,'') ||
  '|' || coalesce(longitude::text,'') || '|' || coalesce(geo_source,'') ||
  '|' || coalesce(asn::text,'') || '|' || coalesce(asn_name,'') ||
  '|' || coalesce(cloud_provider,'') || '|' || coalesce(is_cloud::text,'') ||
  '|' || coalesce(is_anycast::text,'') || '|' || coalesce(is_threat::text,'') ||
  '|' || coalesce(is_tor::text,'') || '|' || coalesce(is_vpn::text,'') ||
  '|' || coalesce(rpki_status,'') || '|' || coalesce(special_purpose,'')
`;

export interface SnapshotSummary {
  id: number;
  version: string;
  prefixCount: number;
  createdAt: Date;
  note: string | null;
}

/** Row counts for the tables a consumer would notice changing, plus when
 * each enrichment source last completed. Recorded so a snapshot explains
 * itself later without a separate archaeology exercise. */
async function collectStats(): Promise<Record<string, unknown>> {
  const tables = await db.execute<{ table_name: string; rows: number }>(sql`
    SELECT relname AS table_name, n_live_tup::int AS rows
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY relname
  `);
  // `db.execute()` returns raw driver values, not drizzle's schema-aware
  // column mapping — ended_at comes back as a string, not a Date.
  const sources = await db.execute<{ source_id: string; ended_at: string | null }>(sql`
    SELECT DISTINCT ON (source_id) source_id, ended_at
    FROM ops.enrichment_sources
    WHERE status = 'completed'
    ORDER BY source_id, ended_at DESC
  `);
  return {
    tables: Object.fromEntries(tables.rows.map((r) => [r.table_name, r.rows])),
    sourcesLastCompleted: Object.fromEntries(
      sources.rows.map((r) => [r.source_id, r.ended_at ? new Date(r.ended_at).toISOString() : null]),
    ),
  };
}

export async function createSnapshot(version?: string, note?: string): Promise<SnapshotSummary> {
  if ((await ipIntelState()) === "off") {
    throw new Error("ip_intel does not exist — run `ip-insight flatten` before snapshotting.");
  }
  const label = version ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const [row] = await db
    .insert(snapshotsTable)
    .values({ version: label, note: note ?? null, stats: await collectStats() })
    .returning();
  if (!row) throw new Error("Failed to create snapshot row");

  // Hash every prefix in one server-side statement — pulling millions of
  // rows into this process to hash them would be slower and would make the
  // result depend on JS serialisation rather than on the data.
  await db.execute(sql`
    INSERT INTO ops.snapshot_prefixes (snapshot_id, network, record_hash)
    SELECT ${row.id}, network, hashtextextended(${HASHED_COLUMNS}, 0)
    FROM ip_intel
  `);

  const [{ count }] = (
    await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ops.snapshot_prefixes WHERE snapshot_id = ${row.id}`,
    )
  ).rows;
  await db.update(snapshotsTable).set({ prefixCount: count }).where(eq(snapshotsTable.id, row.id));

  logger.info({ version: label, prefixes: count }, "Snapshot created");
  return { id: row.id, version: label, prefixCount: count, createdAt: row.createdAt, note: row.note };
}

export async function listSnapshots(): Promise<SnapshotSummary[]> {
  const rows = await db.select().from(snapshotsTable).orderBy(desc(snapshotsTable.createdAt));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    prefixCount: r.prefixCount,
    createdAt: r.createdAt,
    note: r.note,
  }));
}

export interface DeltaRow {
  change: "added" | "removed" | "changed";
  network: string;
}

export interface DeltaResult {
  fromVersion: string;
  added: number;
  removed: number;
  changed: number;
  rows: DeltaRow[];
}

/**
 * Compare the live `ip_intel` against a stored snapshot.
 *
 * `limit` caps the returned rows — the counts are always exact, but a
 * caller that only wants to know *how much* moved shouldn't have to receive
 * a million networks to find out.
 */
export async function computeDelta(version: string, limit = 100_000): Promise<DeltaResult> {
  const [snapshot] = await db
    .select()
    .from(snapshotsTable)
    .where(eq(snapshotsTable.version, version));
  if (!snapshot) throw new Error(`No snapshot named "${version}"`);
  if ((await ipIntelState()) === "off") {
    throw new Error("ip_intel does not exist — run `ip-insight flatten` before diffing.");
  }

  // FULL OUTER JOIN so one pass yields all three change kinds: a null on the
  // snapshot side is an addition, a null on the live side is a removal, and
  // two hashes that differ is a change.
  const result = await db.execute<{ change: string; network: string }>(sql`
    WITH live AS (
      SELECT network, hashtextextended(${HASHED_COLUMNS}, 0) AS h FROM ip_intel
    ), snap AS (
      SELECT network, record_hash AS h
      FROM ops.snapshot_prefixes WHERE snapshot_id = ${snapshot.id}
    )
    SELECT
      CASE
        WHEN snap.network IS NULL THEN 'added'
        WHEN live.network IS NULL THEN 'removed'
        ELSE 'changed'
      END AS change,
      COALESCE(live.network, snap.network)::text AS network
    FROM live
    FULL OUTER JOIN snap ON live.network = snap.network
    WHERE snap.network IS NULL OR live.network IS NULL OR live.h <> snap.h
  `);

  const rows = result.rows.map((r) => ({ change: r.change as DeltaRow["change"], network: r.network }));
  return {
    fromVersion: version,
    added: rows.filter((r) => r.change === "added").length,
    removed: rows.filter((r) => r.change === "removed").length,
    changed: rows.filter((r) => r.change === "changed").length,
    rows: rows.slice(0, limit),
  };
}

/** Drop a snapshot and its prefix hashes. */
export async function deleteSnapshot(version: string): Promise<boolean> {
  const [snapshot] = await db
    .select()
    .from(snapshotsTable)
    .where(eq(snapshotsTable.version, version));
  if (!snapshot) return false;
  await db.delete(snapshotPrefixesTable).where(eq(snapshotPrefixesTable.snapshotId, snapshot.id));
  await db.delete(snapshotsTable).where(eq(snapshotsTable.id, snapshot.id));
  return true;
}
