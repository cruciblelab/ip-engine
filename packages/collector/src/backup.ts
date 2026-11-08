/**
 * `pg_dump`/`pg_restore` mechanics — shared by `ip-insight backup
 * create`/`list`/`restore` (manual, user-initiated, always available) and
 * the maintenance scheduler's automatic snapshots (maintenance.ts, off by
 * default — see that file if you'd rather remove background automation
 * entirely). Kept in its own file specifically so deleting maintenance.ts
 * doesn't take the manual commands down with it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db, backupRunsTable } from "@workspace/db";
import { logger } from "@workspace/shared";
import type { CollectorConfig } from "./config";

const execFileAsync = promisify(execFile);

let pgDumpMissingLogged = false;

/** Shared by the automatic scheduler and `ip-insight backup create`. */
export async function runBackup(
  config: CollectorConfig,
): Promise<{ filePath: string; sizeBytes: number } | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("Backup: DATABASE_URL not set, skipping");
    return null;
  }

  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(config.backupDir, `ip-insight-${stamp}.dump`);

  const [run] = await db.insert(backupRunsTable).values({ status: "running", filePath }).returning();
  if (!run) throw new Error("Failed to create backup_runs row");

  try {
    await execFileAsync("pg_dump", [databaseUrl, "-Fc", "-f", filePath]);
    const sizeBytes = fs.statSync(filePath).size;
    await db
      .update(backupRunsTable)
      .set({ status: "completed", endedAt: new Date(), sizeBytes })
      .where(eq(backupRunsTable.id, run.id));
    logger.info({ filePath, sizeBytes }, "Backup completed");
    await pruneOldBackups(config.backupRetentionCount);
    return { filePath, sizeBytes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isMissingBinary = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isMissingBinary && !pgDumpMissingLogged) {
      pgDumpMissingLogged = true;
      logger.warn(
        "pg_dump not found on PATH — backups are unavailable. Install the postgresql-client package to enable them.",
      );
    } else if (!isMissingBinary) {
      logger.warn({ err }, "Backup failed");
    }
    await db
      .update(backupRunsTable)
      .set({ status: "failed", endedAt: new Date(), errorMessage: message })
      .where(eq(backupRunsTable.id, run.id));
    return null;
  }
}

async function pruneOldBackups(retentionCount: number): Promise<void> {
  const completed = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.status, "completed"))
    .orderBy(desc(backupRunsTable.startedAt));
  const toDelete = completed.slice(retentionCount);
  for (const row of toDelete) {
    if (row.filePath) {
      fs.rm(row.filePath, { force: true }, () => undefined);
    }
    await db.delete(backupRunsTable).where(eq(backupRunsTable.id, row.id));
  }
  if (toDelete.length > 0) {
    logger.info({ count: toDelete.length }, "Pruned old backup(s) past retention count");
  }
}

export async function listBackups(): Promise<Array<typeof backupRunsTable.$inferSelect>> {
  return db.select().from(backupRunsTable).orderBy(desc(backupRunsTable.startedAt));
}

/** Restores the database from a `pg_dump -Fc` file via `pg_restore
 * --clean --if-exists` — this drops/recreates matching objects before
 * restoring, i.e. it overwrites current data. Takes a raw filesystem path:
 * callers are expected to have already gotten explicit confirmation *and*
 * to trust the path itself before calling this — it does neither. Used
 * directly by the CLI (a local, already-trusted operator) and indirectly,
 * through restoreBackupById below, by the HTTP API (which must not trust a
 * client-supplied path). */
export async function restoreBackup(filePath: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL not set");
  if (!fs.existsSync(filePath)) throw new Error(`Backup file not found: ${filePath}`);
  await execFileAsync("pg_restore", ["--clean", "--if-exists", "-d", databaseUrl, filePath]);
}

/**
 * The only restore path the HTTP API is allowed to use — takes a
 * `backup_runs.id` instead of a filesystem path, so a caller can never point
 * `pg_restore` at an arbitrary file. Two independent checks before the path
 * ever reaches restoreBackup(): the path must come from our own DB row (an
 * attacker without DB write access can't inject one), *and* the resolved
 * path must still live under `config.backupDir`. The second check is
 * deliberately redundant with the first — it catches a backupDir that
 * changed after the row was written, or a row whose filePath was altered
 * directly in the database — as defense-in-depth independent of whatever
 * auth sits in front of the HTTP route.
 */
export async function restoreBackupById(id: string, config: CollectorConfig): Promise<void> {
  const [run] = await db.select().from(backupRunsTable).where(eq(backupRunsTable.id, id));
  if (!run) throw new Error(`Backup not found: ${id}`);
  if (!run.filePath) throw new Error(`Backup ${id} has no file path recorded (failed run?)`);

  const resolvedPath = path.resolve(run.filePath);
  const resolvedBackupDir = path.resolve(config.backupDir);
  const relative = path.relative(resolvedBackupDir, resolvedPath);
  const isInsideBackupDir = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!isInsideBackupDir) {
    throw new Error(`Backup ${id}'s file path is outside the configured backup directory`);
  }

  await restoreBackup(resolvedPath);
}

/** Whether a due backup would run right now, given the last completed one. */
export async function isBackupDue(config: CollectorConfig): Promise<boolean> {
  const [lastBackup] = await db
    .select({ startedAt: backupRunsTable.startedAt })
    .from(backupRunsTable)
    .where(eq(backupRunsTable.status, "completed"))
    .orderBy(desc(backupRunsTable.startedAt))
    .limit(1);
  const dueMs = config.backupIntervalHours * 3_600_000;
  return !lastBackup || Date.now() - lastBackup.startedAt.getTime() >= dueMs;
}
