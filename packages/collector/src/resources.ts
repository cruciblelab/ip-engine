/**
 * "What is this actually costing, right now" — disk space (database tables,
 * history specifically, logs, backups) as a single on-demand snapshot.
 * Complements summary.ts (which counts rows) with bytes, and complements
 * status.ts (which reports job progress) with what running those jobs
 * accumulates on disk over time. Built for exactly the question that comes
 * up on a space-constrained deployment (a phone under Termux, a small VDS):
 * "how much room is history actually using, and is it growing faster than
 * expected."
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { LOG_FILE_PATH, RUN_HISTORY_PATH } from "@workspace/shared";
import type { CollectorConfig } from "./config";

export interface RelationSize {
  schema: string;
  name: string;
  /** "table" (ordinary/partitioned) or "materialized view". */
  kind: "table" | "materialized view";
  bytes: number;
}

export interface FileSize {
  path: string;
  /** `false` means the path doesn't exist (nothing has been written yet). */
  exists: boolean;
  bytes: number;
}

export interface ResourceReport {
  generatedAt: string;
  databaseBytes: number;
  /** Every ordinary table and materialized view outside Postgres's own
   * catalogs, largest first. Includes both domain data (ip_blocks,
   * prefix_history, ...) and this project's own operational tables
   * (ops.collection_jobs, ...) — not filtered, since the "which one is
   * secretly huge" question is exactly what a fixed allowlist would miss. */
  relations: RelationSize[];
  logFiles: FileSize[];
  /** Sum of every file directly inside backupDir, or null if the directory
   * doesn't exist (nothing has ever backed up there). */
  backupDirBytes: number | null;
  backupFileCount: number;
}

export async function buildResourceReport(config: CollectorConfig): Promise<ResourceReport> {
  const {
    rows: [dbSizeRow],
  } = await db.execute<{ bytes: string }>(sql`SELECT pg_database_size(current_database())::text AS bytes`);
  const databaseBytes = Number(dbSizeRow?.bytes ?? 0);

  const { rows: relationRows } = await db.execute<{
    schema: string;
    name: string;
    kind: string;
    bytes: string;
  }>(sql`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      c.relkind AS kind,
      pg_total_relation_size(c.oid)::text AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);
  const relations: RelationSize[] = relationRows.map((r) => ({
    schema: r.schema,
    name: r.name,
    kind: r.kind === "m" ? "materialized view" : "table",
    bytes: Number(r.bytes),
  }));

  const logFiles: FileSize[] = [LOG_FILE_PATH, RUN_HISTORY_PATH].map((p) => {
    try {
      return { path: p, exists: true, bytes: fs.statSync(p).size };
    } catch {
      return { path: p, exists: false, bytes: 0 };
    }
  });

  let backupDirBytes: number | null = null;
  let backupFileCount = 0;
  try {
    const entries = fs.readdirSync(config.backupDir, { withFileTypes: true });
    backupDirBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      backupDirBytes += fs.statSync(path.join(config.backupDir, entry.name)).size;
      backupFileCount++;
    }
  } catch {
    // Directory doesn't exist yet — no backup has ever been taken there.
  }

  return {
    generatedAt: new Date().toISOString(),
    databaseBytes,
    relations,
    logFiles,
    backupDirBytes,
    backupFileCount,
  };
}
