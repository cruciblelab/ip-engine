/**
 * `ip-insight cycle` — one unattended pass over everything: collect, then
 * enrich (which ends by refreshing `ip_intel` and, if enabled, capturing a
 * history baseline).
 *
 * This exists because history cannot be backfilled. Every day the pipeline
 * doesn't run is a day of change permanently unobserved, so the pipeline has
 * to survive being run by cron rather than by a person watching a terminal.
 * `collect && enrich` in a crontab looks equivalent and isn't, for three
 * reasons this command handles:
 *
 *  - **Overlap.** A full pass is long (the materialized `ip_intel` rebuild
 *    alone ran ~4.7h on modest hardware). A daily cron entry will eventually
 *    fire while the previous run is still going, and two concurrent passes
 *    rewriting the same tables is not something to find out about later.
 *  - **Partial failure.** `&&` stops at the first non-zero exit, so a failed
 *    collect would silently skip enrichment for that day — the opposite of
 *    what's wanted, since the enrichment sources are independent of the RIR
 *    files and can refresh perfectly well without them.
 *  - **Evidence afterwards.** Console output belongs to a terminal that
 *    isn't there. Everything worth knowing goes through `logger`, which
 *    already dual-writes to `logs/ip-insight.log`, so "did last night work?"
 *    is answerable in the morning.
 */
import { logger, LOG_FILE_PATH } from "@workspace/shared";
import { loadCollectorConfig } from "@workspace/collector";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runCollect } from "./collect";
import { runEnrich } from "./enrich";

/**
 * Arbitrary but fixed 64-bit key for `pg_advisory_lock`. Any process using
 * this same number is, by definition, another cycle.
 *
 * A Postgres advisory lock rather than a lock file on disk: it is tied to
 * the database session, so a crashed or killed run releases it the moment
 * its connection drops. A lock file would survive the crash and block every
 * subsequent run until someone noticed and deleted it — the exact failure
 * this command exists to prevent, reintroduced by its own safety mechanism.
 */
const CYCLE_LOCK_KEY = 8_421_509_143_770_112n;

export interface CycleOptions {
  /** Comma-separated RIR names, or empty for the configured/default set. */
  sources?: string;
  /** Enrichment source ids, or empty for the configured/default set. */
  enrichSources?: string;
}

interface PhaseOutcome {
  ok: boolean;
  error?: string;
}

async function runPhase(name: string, fn: () => Promise<void>): Promise<PhaseOutcome> {
  const startedAt = Date.now();
  logger.info({ phase: name }, `Cycle: ${name} started`);
  try {
    await fn();
    logger.info(
      { phase: name, durationMs: Date.now() - startedAt },
      `Cycle: ${name} finished`,
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Logged, not rethrown: a failed phase must not take the rest of the
    // pass down with it, and the aggregate result is decided by the caller.
    logger.error(
      { err, phase: name, durationMs: Date.now() - startedAt },
      `Cycle: ${name} failed`,
    );
    return { ok: false, error: message };
  }
}

export async function runCycle(opts: CycleOptions = {}): Promise<void> {
  const acquired = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${CYCLE_LOCK_KEY}) AS locked`,
  );
  if (!acquired.rows[0]?.locked) {
    // Not an error: with any periodic schedule this is the expected outcome
    // whenever a pass runs long. Exit 0 so cron stays quiet — but say it
    // plainly, because *repeated* skips mean the schedule is tighter than a
    // pass actually takes, which is a real problem worth noticing.
    logger.warn(
      "Cycle skipped: another cycle is already running (advisory lock held). If this repeats, the schedule is shorter than one pass takes.",
    );
    console.log("Another cycle is already running — nothing to do.");
    return;
  }

  const startedAt = Date.now();
  // Which config was actually loaded, and where logs are actually going, are
  // the first two things logged — because both are resolved relative to the
  // *current working directory*, and cron runs with a cwd nobody chose
  // (typically the user's home). A cron entry that doesn't cd first still
  // runs happily, just with every setting at its default: history capture
  // silently off, ip_intel silently a plain view, logs written somewhere
  // nobody looks. That failure is invisible in the data and would only
  // surface weeks later as "why is there no history?" — so it gets stated
  // up front, every run, whether or not anything is wrong.
  const cfg = loadCollectorConfig();
  logger.info(
    {
      cwd: process.cwd(),
      configFile: cfg.sourcePath ?? "(none found — running entirely on defaults)",
      logFile: LOG_FILE_PATH,
      ipIntelMode: cfg.ipIntelMode,
      historyCaptureEnabled: cfg.historyCaptureEnabled,
    },
    "Cycle started",
  );
  if (!cfg.sourcePath) {
    logger.warn(
      `No ip-insight.config.json found from ${process.cwd()} — every setting is at its default. If this is a scheduled run, cd into the project directory first or set IP_INSIGHT_CONFIG.`,
    );
  }
  const rirs = opts.sources ? opts.sources.split(",").map((s) => s.trim()) : [];
  const enrichIds = opts.enrichSources
    ? opts.enrichSources.split(",").map((s) => s.trim())
    : [];

  try {
    const collect = await runPhase("collect", () => runCollect(rirs));
    // Deliberately not gated on `collect.ok` — see the header. Enrichment
    // reads its own upstreams and the tables already in the database, so a
    // failed RIR download is a reason to enrich anyway, not to skip it.
    const enrich = await runPhase("enrich", () => runEnrich(enrichIds));

    const failures = [
      ...(collect.ok ? [] : [`collect: ${collect.error}`]),
      ...(enrich.ok ? [] : [`enrich: ${enrich.error}`]),
    ];
    const durationMs = Date.now() - startedAt;

    if (failures.length === 0) {
      logger.info({ durationMs }, "Cycle completed");
      console.log(`Cycle completed in ${Math.round(durationMs / 1000)}s.`);
      return;
    }
    logger.error({ durationMs, failures }, "Cycle completed with failures");
    console.error(`Cycle completed with failures:\n  ${failures.join("\n  ")}`);
    // Non-zero so cron/systemd reports it rather than the failure living
    // only in a log nobody opened.
    process.exitCode = 1;
  } finally {
    // Released explicitly so a long-lived caller (not the CLI, which exits)
    // doesn't hold it; the session ending would release it regardless.
    await db
      .execute(sql`SELECT pg_advisory_unlock(${CYCLE_LOCK_KEY})`)
      .catch((err) => logger.debug({ err }, "Cycle: advisory unlock failed"));
  }
}
