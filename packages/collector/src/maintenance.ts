/**
 * Background maintenance scheduler — ALL of this project's unattended,
 * timer-driven automation lives in this one file, on purpose. If you don't
 * want any background automation running at all (cron-like ticking,
 * whatever gets swept/backed-up/logged on its own), the whole thing goes
 * away cleanly by deleting this file and removing its two call sites
 * (`startMaintenanceScheduler()`/`stopMaintenanceScheduler()`) in
 * apps/server/src/index.ts, then rebuilding — every manual command
 * (`ip-insight jobs`, `collect`/`enrich --resume`, `ip-insight backup
 * create/list/restore`) keeps working exactly as before, since those live
 * in collection/collector.ts, enrichment/enrichment.ts, and backup.ts, not
 * here.
 *
 * Off by default (`maintenanceSchedulerEnabled: false`): `startMaintenance
 * Scheduler()` becomes a no-op unless that's explicitly set. This is the
 * one setting in this whole config file that DOES need a restart to take
 * effect either way — turning the scheduler itself on/off has to happen
 * before anything exists that could notice a later edit; every setting
 * below it (what a running scheduler actually does) still applies on its
 * next tick with no restart, same as the rest of this config.
 *
 * Once running, it ticks on a fixed internal cadence (`TICK_MS`, not
 * itself configurable) and re-reads `loadCollectorConfig()` fresh every
 * time, so each of the three jobs below turns on/off/retunes on its next
 * tick:
 *
 *  - Stale interrupted-job cleanup (`checkpointAutoCleanupStaleJobs`,
 *    default false): the same sweep `startCollection`/`startEnrichment`
 *    already run at their own start, run here too so it doesn't wait on
 *    the next manual/cron collect or enrich to happen.
 *
 *  - Automatic `pg_dump` backups (`backupEnabled`, default false): see
 *    backup.ts for the actual mechanics — this just decides when one's due.
 *
 *  - Idle/"sleep mode" logging (`sleepModeEnabled`, default false): a
 *    single log line when no collect/enrich job has started in
 *    `sleepModeIdleHours`, and one more when a job starts again
 *    afterward. Purely informational either way.
 *
 * This module only runs inside a long-lived process (the API server) — a
 * one-shot CLI invocation exits before a tick could ever fire.
 */
import { desc } from "drizzle-orm";
import { db, collectionJobsTable, enrichmentJobsTable } from "@workspace/db";
import { logger } from "@workspace/shared";
import { loadCollectorConfig } from "./config";
import { sweepOrphanedCollectionJobs } from "./collection/collector";
import { sweepOrphanedEnrichmentJobs } from "./enrichment/enrichment";
import { runBackup, isBackupDue } from "./backup";

const TICK_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let sleepLogged = false;

export function startMaintenanceScheduler(): void {
  if (timer) return;
  if (!loadCollectorConfig().maintenanceSchedulerEnabled) {
    logger.info(
      "Maintenance scheduler disabled (maintenanceSchedulerEnabled: false in config) — no background jobs will run.",
    );
    return;
  }
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  logger.info({ tickMs: TICK_MS }, "Maintenance scheduler started");
}

export function stopMaintenanceScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  const config = loadCollectorConfig();
  try {
    if (config.checkpointingEnabled && config.checkpointAutoCleanupStaleJobs) {
      await sweepOrphanedCollectionJobs(config);
      await sweepOrphanedEnrichmentJobs(config);
    }
  } catch (err) {
    logger.warn({ err }, "Maintenance: checkpoint cleanup sweep failed");
  }

  try {
    if (config.sleepModeEnabled) {
      await checkSleepMode(config.sleepModeIdleHours);
    }
  } catch (err) {
    logger.warn({ err }, "Maintenance: sleep-mode check failed");
  }

  try {
    if (config.backupEnabled && (await isBackupDue(config))) {
      await runBackup(config);
    }
  } catch (err) {
    logger.warn({ err }, "Maintenance: backup check failed");
  }
}

async function lastOperationAt(): Promise<Date | null> {
  const [collect] = await db
    .select({ startedAt: collectionJobsTable.startedAt })
    .from(collectionJobsTable)
    .orderBy(desc(collectionJobsTable.startedAt))
    .limit(1);
  const [enrich] = await db
    .select({ startedAt: enrichmentJobsTable.startedAt })
    .from(enrichmentJobsTable)
    .orderBy(desc(enrichmentJobsTable.startedAt))
    .limit(1);
  const candidates = [collect?.startedAt, enrich?.startedAt].filter(
    (d): d is Date => d !== undefined,
  );
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

async function checkSleepMode(idleHours: number): Promise<void> {
  const last = await lastOperationAt();
  const idleMs = last ? Date.now() - last.getTime() : Infinity;
  const isIdle = idleMs > idleHours * 3_600_000;

  if (isIdle && !sleepLogged) {
    sleepLogged = true;
    logger.info(
      { idleHours, lastOperationAt: last ? last.toISOString() : null },
      `No collect/enrich activity in over ${idleHours}h — entered sleep mode`,
    );
  } else if (!isIdle && sleepLogged) {
    sleepLogged = false;
    logger.info("Collect/enrich activity resumed — exited sleep mode");
  }
}
