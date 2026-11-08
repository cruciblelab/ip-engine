/**
 * Collector engine.
 *
 * Runs a single collection job at a time. For each configured RIR source,
 * streams the delegated-extended stats file line-by-line, parses each
 * record, and bulk-inserts into the database with conflict-skip semantics.
 *
 * Designed for high throughput:
 *  - HTTP body is consumed as a Node Readable, broken into lines without
 *    buffering the entire response.
 *  - Records are accumulated into batches (default 2000 rows) and flushed
 *    via a single multi-row INSERT ... ON CONFLICT DO NOTHING per batch.
 *  - The job state machine supports cooperative cancellation; the collector
 *    checks the stop flag between batches and after each line buffer flush.
 */

import { eq, sql, desc, and, lt, inArray } from "drizzle-orm";
import {
  db,
  ipBlocksTable,
  asnBlocksTable,
  collectionJobsTable,
  collectionSourcesTable,
  type CollectionJob,
} from "@workspace/db";
import {
  logger,
  fetchWithRetry,
  formatJobDisplayId,
  parseSequentialJobRef,
  sleep,
} from "@workspace/shared";
import { KNOWN_SOURCES, type KnownSourceConfig } from "./sources";
import { parseRirLine } from "./rir-line-parser";
import { loadCollectorConfig, type CollectorConfig } from "../config";

const JOB_ID_PREFIX = "collect";
/** A job row is orphaned if it's still "running"/"stopping" once we get
 * here — the in-memory `activeJob` guard above already rules out a job
 * genuinely active in *this* process, so any such row was left behind by a
 * process that died (crash, kill -9, power loss) mid-run. Assumes a single
 * collector process talks to the database at a time, same assumption the
 * in-memory guard already makes. */
const ORPHANED_STATUSES = ["running", "stopping"] as const;

interface SourceRuntime {
  config: KnownSourceConfig;
  sourceId: number;
  status:
    | "pending"
    | "downloading"
    | "parsing"
    | "completed"
    | "failed"
    | "stopped"
    | "skipped";
  recordsIngested: number;
  recordsSkipped: number;
  bytesDownloaded: number;
  ipv4Count: number;
  ipv6Count: number;
  asnCount: number;
  startedAt: Date | null;
  endedAt: Date | null;
  errorMessage: string | null;
  recordsPerSecond: number;
  lastFlushAt: number;
  lastFlushIngested: number;
}

interface ActiveJob {
  jobId: string;
  startedAtMs: number;
  shouldStop: boolean;
  sources: SourceRuntime[];
  totalIngested: number;
  totalSkipped: number;
  ratePerSecond: number;
  lastRateSampleMs: number;
  lastRateSampleIngested: number;
  /** From ip-insight.config.json's "collectionStatuses" — `null` means keep
   * every RIR status (allocated/assigned/reserved/available), the default. */
  allowedStatuses: string[] | null;
  /** From ip-insight.config.json's "batchSize" — default 2000. */
  batchSize: number;
  /** From ip-insight.config.json's fetchRetry* keys. */
  fetchRetry: { attempts: number; baseDelayMs: number; timeoutMs: number };
  /** From ip-insight.config.json's "sourceRetryMaxAttempts" — how many times
   * a whole RIR source (fetch + parse together) is redone from scratch after
   * failing outright, separate from fetchRetry's connection-level retries. */
  sourceRetryMaxAttempts: number;
}

let activeJob: ActiveJob | null = null;

const FLUSH_PROGRESS_EVERY_MS = 1000;

export function isJobActive(): boolean {
  return activeJob !== null && !["completed", "stopped", "failed"].includes(
    activeStatusLabel(),
  );
}

function activeStatusLabel(): string {
  if (!activeJob) return "idle";
  if (activeJob.shouldStop) return "stopping";
  return "running";
}

export function getActiveJobSnapshot(): {
  jobId: string;
  shouldStop: boolean;
  sources: SourceRuntime[];
  ratePerSecond: number;
} | null {
  if (!activeJob) return null;
  return {
    jobId: activeJob.jobId,
    shouldStop: activeJob.shouldStop,
    sources: activeJob.sources.map((s) => ({ ...s })),
    ratePerSecond: activeJob.ratePerSecond,
  };
}

export async function startCollection(
  sources?: string[],
  options?: { resumeJobRef?: string },
): Promise<CollectionJob> {
  if (activeJob) {
    throw new Error("A collection job is already running");
  }

  const config = loadCollectorConfig();

  // Sweep runs before either branch below: a job that crashed mid-run is
  // still marked "running" until this marks it "interrupted", and
  // `resumeCollection` only accepts a job already in that state. Without
  // this running here too, `--resume` called right after a crash (the most
  // common time anyone calls it) found nothing to resume, since nothing had
  // been swept yet — this used to only run on the non-resume branch below.
  if (config.checkpointingEnabled) {
    await sweepOrphanedCollectionJobs(config);
  }

  if (options?.resumeJobRef) {
    return resumeCollection(options.resumeJobRef, config);
  }

  // Explicit `sources` (CLI --sources, or an HTTP request body) always wins;
  // otherwise fall back to ip-insight.config.json's "collection" list, and
  // only default to literally everything if neither says anything.
  const effectiveSources = sources && sources.length > 0 ? sources : config.collection;
  const sourcesToRun = (
    effectiveSources && effectiveSources.length > 0
      ? KNOWN_SOURCES.filter((s) => effectiveSources.includes(s.rir))
      : KNOWN_SOURCES
  ).slice();

  if (sourcesToRun.length === 0) {
    throw new Error("No matching sources to run");
  }

  const [job] = await db
    .insert(collectionJobsTable)
    .values({ status: "running" })
    .returning();
  if (!job) throw new Error("Failed to create job row");

  const sourceRows = await db
    .insert(collectionSourcesTable)
    .values(
      sourcesToRun.map((s) => ({
        jobId: job.id,
        rir: s.rir,
        url: s.url,
        status: "pending" as const,
      })),
    )
    .returning();

  activeJob = {
    jobId: job.id,
    startedAtMs: Date.now(),
    shouldStop: false,
    totalIngested: 0,
    totalSkipped: 0,
    ratePerSecond: 0,
    lastRateSampleMs: Date.now(),
    lastRateSampleIngested: 0,
    allowedStatuses: config.collectionStatuses,
    batchSize: config.batchSize,
    fetchRetry: {
      attempts: config.fetchRetry.maxAttempts,
      baseDelayMs: config.fetchRetry.baseDelayMs,
      timeoutMs: config.fetchRetry.timeoutMs,
    },
    sourceRetryMaxAttempts: config.sourceRetryMaxAttempts,
    sources: sourcesToRun.map((cfg) => {
      const row = sourceRows.find((r) => r.rir === cfg.rir);
      return {
        config: cfg,
        sourceId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
        bytesDownloaded: 0,
        ipv4Count: 0,
        ipv6Count: 0,
        asnCount: 0,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
        recordsPerSecond: 0,
        lastFlushAt: Date.now(),
        lastFlushIngested: 0,
      };
    }),
  };

  // Fire-and-forget; the routes poll status to track progress.
  void runJob(activeJob).catch((err) => {
    logger.error({ err }, "Collection job failed unexpectedly");
  });

  return job;
}

/**
 * Marks any collection_jobs row left "running"/"stopping" from a process
 * that never got to update it (crash/kill/power loss) as "interrupted", so
 * it stops looking like a live job and starts showing up in
 * `listResumableCollectionJobs`. Called at the top of every *fresh*
 * (non-`--resume`) `startCollection`, and periodically by the maintenance
 * scheduler (maintenance.ts) so an orphaned row doesn't sit mislabeled
 * "running" forever if nobody starts a new job for a while. Guarded by
 * `activeJob` being null: a currently-active job in *this* process is never
 * touched, whichever caller invoked this.
 */
export async function sweepOrphanedCollectionJobs(config: CollectorConfig): Promise<void> {
  if (activeJob) return;
  const orphaned = await db
    .update(collectionJobsTable)
    .set({ status: "interrupted", endedAt: new Date() })
    .where(inArray(collectionJobsTable.status, [...ORPHANED_STATUSES]))
    .returning({ id: collectionJobsTable.id });
  if (orphaned.length > 0) {
    logger.warn(
      { jobIds: orphaned.map((o) => o.id) },
      "Marked orphaned collection job(s) as interrupted (process restarted mid-run)",
    );
  }

  if (config.checkpointAutoCleanupStaleJobs) {
    const cutoff = new Date(Date.now() - config.checkpointStaleAfterHours * 3_600_000);
    const deleted = await db
      .delete(collectionJobsTable)
      .where(
        and(
          eq(collectionJobsTable.status, "interrupted"),
          lt(collectionJobsTable.startedAt, cutoff),
        ),
      )
      .returning({ id: collectionJobsTable.id });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length }, "Auto-cleaned stale interrupted collection job(s)");
    }
  }
}

/** Accepts either the uuid primary key or, if `checkpointIdFormat` is
 * "sequential", the "collect-000123" display form. */
async function resolveCollectionJobRef(ref: string): Promise<CollectionJob> {
  const seq = parseSequentialJobRef(JOB_ID_PREFIX, ref);
  let row: CollectionJob | undefined;
  try {
    const rows =
      seq !== null
        ? await db.select().from(collectionJobsTable).where(eq(collectionJobsTable.seq, seq))
        : await db.select().from(collectionJobsTable).where(eq(collectionJobsTable.id, ref));
    row = rows[0];
  } catch {
    // Malformed uuid ref, etc. — surfaced as "not found" below rather than a raw Postgres error.
    row = undefined;
  }
  if (!row) throw new Error(`No collection job found matching "${ref}"`);
  return row;
}

export function formatCollectionJobDisplayId(job: { id: string; seq: number }): string {
  const format = loadCollectorConfig().checkpointIdFormat;
  return formatJobDisplayId(JOB_ID_PREFIX, job.seq, format, job.id);
}

/** Interrupted jobs, most recent first, for `ip-insight jobs` and the
 * id-less `--resume`. `stale` jobs (older than `checkpointStaleAfterHours`)
 * are still included but flagged — the CLI hides them from the "pick the
 * most recent one" default and requires an explicit id for those.
 *
 * Sweeps orphaned jobs first: the id-less `--resume` path resolves its
 * default entirely through this function, without ever calling
 * `startCollection` (which is where the sweep otherwise runs) — so without
 * this, a job that crashed moments ago is still sitting as "running" here
 * and `--resume` (called right after the crash, the most common time to
 * call it at all) reports nothing to resume. */
export async function listResumableCollectionJobs(): Promise<
  Array<{
    id: string;
    displayId: string;
    startedAt: Date;
    sourcesTotal: number;
    sourcesCompleted: number;
    stale: boolean;
  }>
> {
  const config = loadCollectorConfig();
  if (!config.checkpointingEnabled) return [];
  await sweepOrphanedCollectionJobs(config);
  const jobs = await db
    .select()
    .from(collectionJobsTable)
    .where(eq(collectionJobsTable.status, "interrupted"))
    .orderBy(desc(collectionJobsTable.startedAt));
  const cutoffMs = Date.now() - config.checkpointStaleAfterHours * 3_600_000;

  const out = [];
  for (const job of jobs) {
    const srcs = await db
      .select({ status: collectionSourcesTable.status })
      .from(collectionSourcesTable)
      .where(eq(collectionSourcesTable.jobId, job.id));
    out.push({
      id: job.id,
      displayId: formatJobDisplayId(JOB_ID_PREFIX, job.seq, config.checkpointIdFormat, job.id),
      startedAt: job.startedAt,
      sourcesTotal: srcs.length,
      sourcesCompleted: srcs.filter((s) => s.status === "completed" || s.status === "skipped").length,
      stale: job.startedAt.getTime() < cutoffMs,
    });
  }
  return out;
}

/** Resumes an interrupted job: sources already "completed"/"skipped" are
 * left alone; every other source is reset and re-run from scratch (there's
 * no byte-offset/mid-file resume — a source is the smallest resumable
 * unit, same granularity `sweepOrphanedCollectionJobs` reasons about).
 * Cumulative totals from before the crash are preserved. */
async function resumeCollection(ref: string, config: CollectorConfig): Promise<CollectionJob> {
  if (!config.checkpointingEnabled) {
    throw new Error(
      "Checkpointing is disabled (checkpointingEnabled: false in config) — nothing to resume",
    );
  }
  const job = await resolveCollectionJobRef(ref);
  if (job.status !== "interrupted") {
    throw new Error(`Job ${ref} is not resumable (status: ${job.status})`);
  }

  const existingSources = await db
    .select()
    .from(collectionSourcesTable)
    .where(eq(collectionSourcesTable.jobId, job.id));
  const pending = existingSources.filter((s) => s.status !== "completed" && s.status !== "skipped");
  if (pending.length === 0) {
    throw new Error(`Job ${ref} has no pending sources left — every source already completed`);
  }

  const sourcesToRun = pending
    .map((s) => KNOWN_SOURCES.find((k) => k.rir === s.rir))
    .filter((s): s is KnownSourceConfig => s !== undefined);

  for (const s of pending) {
    await db
      .update(collectionSourcesTable)
      .set({
        status: "pending",
        recordsIngested: 0,
        recordsSkipped: 0,
        bytesDownloaded: 0,
        ipv4Count: 0,
        ipv6Count: 0,
        asnCount: 0,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
      })
      .where(eq(collectionSourcesTable.id, s.id));
  }

  const [updatedJob] = await db
    .update(collectionJobsTable)
    // Bumping startedAt matters beyond cosmetics: loadStatus()'s "no active
    // job in this process" fallback picks the most-recently-started job to
    // display, and without this a job resumed after a *newer* job already
    // ran (e.g. arin ran after this one crashed) would look older than that
    // newer job and never show up as the one being polled.
    .set({ status: "running", endedAt: null, startedAt: new Date() })
    .where(eq(collectionJobsTable.id, job.id))
    .returning();
  if (!updatedJob) throw new Error(`Failed to reactivate job ${ref}`);

  activeJob = {
    jobId: job.id,
    startedAtMs: Date.now(),
    shouldStop: false,
    totalIngested: job.totalIngested,
    totalSkipped: job.totalSkipped,
    ratePerSecond: 0,
    lastRateSampleMs: Date.now(),
    lastRateSampleIngested: 0,
    allowedStatuses: config.collectionStatuses,
    batchSize: config.batchSize,
    fetchRetry: {
      attempts: config.fetchRetry.maxAttempts,
      baseDelayMs: config.fetchRetry.baseDelayMs,
      timeoutMs: config.fetchRetry.timeoutMs,
    },
    sourceRetryMaxAttempts: config.sourceRetryMaxAttempts,
    sources: sourcesToRun.map((cfg) => {
      const row = pending.find((r) => r.rir === cfg.rir);
      return {
        config: cfg,
        sourceId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
        bytesDownloaded: 0,
        ipv4Count: 0,
        ipv6Count: 0,
        asnCount: 0,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
        recordsPerSecond: 0,
        lastFlushAt: Date.now(),
        lastFlushIngested: 0,
      };
    }),
  };

  logger.info(
    { jobId: job.id, resumedSources: sourcesToRun.map((s) => s.rir) },
    "Resuming interrupted collection job",
  );

  void runJob(activeJob).catch((err) => {
    logger.error({ err }, "Resumed collection job failed unexpectedly");
  });

  return updatedJob;
}

/**
 * Cooperative cancel signal — used by both the /collection/stop HTTP route
 * and by the SIGTERM/SIGINT graceful-shutdown handler in index.ts.
 */
export async function requestStop(): Promise<void> {
  if (activeJob) {
    activeJob.shouldStop = true;
  }
}

export async function stopCollection(): Promise<CollectionJob | null> {
  if (!activeJob) return null;
  activeJob.shouldStop = true;
  const [row] = await db
    .update(collectionJobsTable)
    .set({ status: "stopping" })
    .where(eq(collectionJobsTable.id, activeJob.jobId))
    .returning();
  return row ?? null;
}

async function runJob(job: ActiveJob): Promise<void> {
  try {
    // Run all RIR sources in parallel — they ingest into the same tables but
    // postgres handles concurrent INSERTs cleanly thanks to (rir, cidr)
    // unique indexes. This collapses total wall-clock time from
    // sum(per-RIR) → max(per-RIR), typically a 4-5x speedup.
    await Promise.allSettled(
      job.sources.map(async (source) => {
        if (job.shouldStop) {
          source.status = "skipped";
          await persistSource(source);
          return;
        }
        await runSourceWithRetry(job, source);
      }),
    );
    // Same reasoning as the enrichment job runner: allSettled means one RIR
    // failing never stops the others, so "every source ran" and "every
    // source succeeded" have to be reported as different outcomes, or a
    // partial RIR (network cut mid-download) reads as a clean success.
    const failedSources = job.sources.filter((s) => s.status === "failed");
    const finalStatus = job.shouldStop
      ? "stopped"
      : failedSources.length > 0
        ? "completed_with_errors"
        : "completed";
    await db
      .update(collectionJobsTable)
      .set({
        status: finalStatus,
        endedAt: new Date(),
        totalIngested: job.totalIngested,
        totalSkipped: job.totalSkipped,
        errorMessage:
          failedSources.length > 0
            ? `${failedSources.length} source(s) failed: ${failedSources.map((s) => `${s.config.rir} (${s.errorMessage ?? "unknown error"})`).join("; ")}`
            : null,
      })
      .where(eq(collectionJobsTable.id, job.jobId));
    logger.info(
      {
        jobId: job.jobId,
        status: finalStatus,
        ingested: job.totalIngested,
        skipped: job.totalSkipped,
        durationMs: Date.now() - job.startedAtMs,
      },
      "Collection job finished",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(collectionJobsTable)
      .set({
        status: "failed",
        endedAt: new Date(),
        errorMessage: message,
        totalIngested: job.totalIngested,
        totalSkipped: job.totalSkipped,
      })
      .where(eq(collectionJobsTable.id, job.jobId));
    logger.error({ err, jobId: job.jobId }, "Collection job failed");
  } finally {
    if (activeJob?.jobId === job.jobId) {
      activeJob = null;
    }
  }
}

/**
 * Runs a source, and if it fails outright, redoes the whole thing (fetch and
 * parse together) from scratch — up to job.sourceRetryMaxAttempts times, with
 * the same exponential backoff fetchWithRetry uses. Same reasoning as the
 * enrichment engine's equivalent: a connection that dies mid-stream, after
 * the request already succeeded, isn't something fetchWithRetry can catch —
 * recovering means redoing the whole source. Safe because every collection
 * insert is `ON CONFLICT DO NOTHING`, so a redo can never create duplicates.
 */
async function runSourceWithRetry(job: ActiveJob, source: SourceRuntime): Promise<void> {
  for (let attempt = 1; attempt <= job.sourceRetryMaxAttempts; attempt++) {
    try {
      await runSource(job, source);
    } catch (err) {
      source.status = "failed";
      source.errorMessage = err instanceof Error ? err.message : String(err);
      source.endedAt = new Date();
      logger.error({ err, rir: source.config.rir }, "Collection source failed");
      await persistSource(source);
    }
    if (source.status !== "failed") return; // succeeded, skipped (304), or user-requested stop
    if (attempt === job.sourceRetryMaxAttempts) break;

    const delay = job.fetchRetry.baseDelayMs * 2 ** attempt;
    logger.warn(
      { rir: source.config.rir, attempt, attempts: job.sourceRetryMaxAttempts, delayMs: delay },
      "Collection source failed, retrying whole source",
    );
    source.status = "pending";
    source.recordsIngested = 0;
    source.recordsSkipped = 0;
    source.bytesDownloaded = 0;
    source.ipv4Count = 0;
    source.ipv6Count = 0;
    source.asnCount = 0;
    source.errorMessage = null;
    await persistSource(source);
    await sleep(delay);
  }
  logger.error(
    { rir: source.config.rir, attempts: job.sourceRetryMaxAttempts, errorMessage: source.errorMessage },
    `Collection source "${source.config.rir}" failed after ${job.sourceRetryMaxAttempts} attempts — giving up`,
  );
}

async function runSource(
  job: ActiveJob,
  source: SourceRuntime,
): Promise<void> {
  source.status = "downloading";
  source.startedAt = new Date();
  await persistSource(source);

  // --- Change detection ----------------------------------------------------
  // Look up the most recent successful run for this RIR and ask the upstream
  // server "has anything changed since last time?" via ETag / If-Modified-
  // Since. RIR delegated-extended files are typically refreshed once a day,
  // so most runs return 304 Not Modified and we save bandwidth + DB load.
  const [previous] = await db
    .select({
      etag: collectionSourcesTable.etag,
      lastModified: collectionSourcesTable.lastModified,
    })
    .from(collectionSourcesTable)
    .where(
      and(
        eq(collectionSourcesTable.rir, source.config.rir),
        eq(collectionSourcesTable.status, "completed"),
      ),
    )
    .orderBy(desc(collectionSourcesTable.id))
    .limit(1);

  const conditionalHeaders: Record<string, string> = {
    "User-Agent": "ip-insight-engine/1.0 (self-hosted; contact via project operator)",
    Accept: "text/plain",
  };
  if (previous?.etag) conditionalHeaders["If-None-Match"] = previous.etag;
  if (previous?.lastModified)
    conditionalHeaders["If-Modified-Since"] = previous.lastModified;

  let response: Response;
  try {
    response = await fetchWithRetry(
      source.config.url,
      { headers: conditionalHeaders },
      { label: `collector:${source.config.rir}`, ...job.fetchRetry },
    );
  } catch (err) {
    source.status = "failed";
    source.errorMessage =
      err instanceof Error ? err.message : "Network error";
    source.endedAt = new Date();
    logger.error({ err, rir: source.config.rir }, "Collection source fetch failed");
    await persistSource(source);
    return;
  }

  // Server confirms nothing has changed since last successful run.
  if (response.status === 304) {
    source.status = "skipped";
    source.errorMessage = "unchanged since last run (HTTP 304)";
    source.endedAt = new Date();
    // Carry forward the cache validators so subsequent runs keep working.
    if (previous?.etag) source.bytesDownloaded = 0;
    await db
      .update(collectionSourcesTable)
      .set({
        status: "skipped",
        endedAt: source.endedAt,
        errorMessage: source.errorMessage,
        etag: previous?.etag ?? null,
        lastModified: previous?.lastModified ?? null,
      })
      .where(eq(collectionSourcesTable.id, source.sourceId));
    logger.info(
      { rir: source.config.rir },
      "Source unchanged; skipping ingest",
    );
    return;
  }

  if (!response.ok || !response.body) {
    source.status = "failed";
    source.errorMessage = `HTTP ${response.status} ${response.statusText}`;
    source.endedAt = new Date();
    await persistSource(source);
    return;
  }

  // Capture cache validators for next time.
  const newEtag = response.headers.get("etag");
  const newLastModified = response.headers.get("last-modified");

  source.status = "parsing";
  await persistSource(source);

  const ipBatch: Array<typeof ipBlocksTable.$inferInsert> = [];
  const asnBatch: Array<typeof asnBlocksTable.$inferInsert> = [];
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const reader = response.body.getReader();
  try {
    while (true) {
      if (job.shouldStop) {
        source.status = "stopped";
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      source.bytesDownloaded += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line, source, ipBatch, asnBatch, job.allowedStatuses);
        if (ipBatch.length >= job.batchSize) {
          await flushIp(ipBatch, job, source);
        }
        if (asnBatch.length >= job.batchSize) {
          await flushAsn(asnBatch, job, source);
        }
      }
      maybeUpdateRate(job, source);
      if (Date.now() - source.lastFlushAt > FLUSH_PROGRESS_EVERY_MS) {
        await persistSource(source);
        source.lastFlushAt = Date.now();
      }
    }
    if (buffer.length > 0) {
      processLine(buffer, source, ipBatch, asnBatch, job.allowedStatuses);
    }
    if (ipBatch.length > 0) await flushIp(ipBatch, job, source);
    if (asnBatch.length > 0) await flushAsn(asnBatch, job, source);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  if (source.status !== "stopped") {
    source.status = "completed";
  }
  source.endedAt = new Date();
  await db
    .update(collectionSourcesTable)
    .set({
      status: source.status,
      recordsIngested: source.recordsIngested,
      recordsSkipped: source.recordsSkipped,
      bytesDownloaded: source.bytesDownloaded,
      ipv4Count: source.ipv4Count,
      ipv6Count: source.ipv6Count,
      asnCount: source.asnCount,
      endedAt: source.endedAt,
      etag: newEtag,
      lastModified: newLastModified,
    })
    .where(eq(collectionSourcesTable.id, source.sourceId));
}

function processLine(
  raw: string,
  source: SourceRuntime,
  ipBatch: Array<typeof ipBlocksTable.$inferInsert>,
  asnBatch: Array<typeof asnBlocksTable.$inferInsert>,
  allowedStatuses: string[] | null,
): void {
  const parsed = parseRirLine(raw, source.config.rir);
  if (!parsed) return;
  if (parsed.skipped) {
    source.recordsSkipped++;
    return;
  }
  // A status excluded by ip-insight.config.json's "collectionStatuses" was
  // parsed fine — it just wasn't asked for — so it's neither ingested nor
  // skipped (skipped implies a parse failure); it's simply not counted.
  const keep = (status: string | null) =>
    !allowedStatuses || (status !== null && allowedStatuses.includes(status));
  for (const row of parsed.ipRows) {
    if (!keep(row.status)) continue;
    ipBatch.push(row);
    if (row.network.includes(":")) source.ipv6Count++;
    else source.ipv4Count++;
  }
  for (const row of parsed.asnRows) {
    if (!keep(row.status)) continue;
    asnBatch.push(row);
    source.asnCount++;
  }
}

async function flushIp(
  batch: Array<typeof ipBlocksTable.$inferInsert>,
  job: ActiveJob,
  source: SourceRuntime,
): Promise<void> {
  const rows = batch.splice(0, batch.length);
  try {
    await db.insert(ipBlocksTable).values(rows).onConflictDoNothing();
    source.recordsIngested += rows.length;
    job.totalIngested += rows.length;
    maybeUpdateRate(job, source);
  } catch (err) {
    logger.warn({ err, rir: source.config.rir }, "ip batch insert failed");
    source.recordsSkipped += rows.length;
    job.totalSkipped += rows.length;
  }
}

async function flushAsn(
  batch: Array<typeof asnBlocksTable.$inferInsert>,
  job: ActiveJob,
  source: SourceRuntime,
): Promise<void> {
  const rows = batch.splice(0, batch.length);
  try {
    await db.insert(asnBlocksTable).values(rows).onConflictDoNothing();
    source.recordsIngested += rows.length;
    job.totalIngested += rows.length;
    maybeUpdateRate(job, source);
  } catch (err) {
    logger.warn({ err, rir: source.config.rir }, "asn batch insert failed");
    source.recordsSkipped += rows.length;
    job.totalSkipped += rows.length;
  }
}

function maybeUpdateRate(job: ActiveJob, source: SourceRuntime): void {
  const now = Date.now();
  const dt = now - job.lastRateSampleMs;
  if (dt >= 500) {
    job.ratePerSecond = ((job.totalIngested - job.lastRateSampleIngested) /
      dt) *
      1000;
    job.lastRateSampleMs = now;
    job.lastRateSampleIngested = job.totalIngested;
  }
  const sdt = now - source.lastFlushAt;
  if (sdt >= 500) {
    source.recordsPerSecond =
      ((source.recordsIngested - source.lastFlushIngested) / sdt) * 1000;
    source.lastFlushIngested = source.recordsIngested;
  }
}

async function persistSource(source: SourceRuntime): Promise<void> {
  await db
    .update(collectionSourcesTable)
    .set({
      status: source.status,
      recordsIngested: source.recordsIngested,
      recordsSkipped: source.recordsSkipped,
      bytesDownloaded: source.bytesDownloaded,
      ipv4Count: source.ipv4Count,
      ipv6Count: source.ipv6Count,
      asnCount: source.asnCount,
      startedAt: source.startedAt,
      endedAt: source.endedAt,
      errorMessage: source.errorMessage,
    })
    .where(eq(collectionSourcesTable.id, source.sourceId));
}

export async function loadStatus(): Promise<{
  isActive: boolean;
  job: CollectionJob | null;
  sources: Array<{
    rir: string;
    url: string;
    status: string;
    recordsIngested: number;
    recordsSkipped: number;
    bytesDownloaded: number;
    ipv4Count: number;
    ipv6Count: number;
    asnCount: number;
    startedAt: Date | null;
    endedAt: Date | null;
    errorMessage: string | null;
    recordsPerSecond: number;
  }>;
  ratePerSecond: number;
}> {
  // Find the most recent job: active one if present, else most recent finished
  let jobId: string | null = activeJob?.jobId ?? null;
  let jobRow: CollectionJob | null = null;
  if (jobId) {
    const [r] = await db
      .select()
      .from(collectionJobsTable)
      .where(eq(collectionJobsTable.id, jobId));
    jobRow = r ?? null;
  } else {
    const [r] = await db
      .select()
      .from(collectionJobsTable)
      .orderBy(desc(collectionJobsTable.startedAt))
      .limit(1);
    jobRow = r ?? null;
    jobId = r?.id ?? null;
  }
  let sources: Array<typeof collectionSourcesTable.$inferSelect> = [];
  if (jobId) {
    sources = await db
      .select()
      .from(collectionSourcesTable)
      .where(eq(collectionSourcesTable.jobId, jobId))
      .orderBy(collectionSourcesTable.id);
  }
  // Overlay live in-memory rates if this is the active job
  const activeSnapshot = activeJob?.jobId === jobId ? getActiveJobSnapshot() : null;
  const sourceMap = new Map(
    activeSnapshot?.sources.map((s) => [s.config.rir, s]) ?? [],
  );

  return {
    isActive: activeJob !== null,
    job: jobRow,
    sources: sources.map((s) => {
      const live = sourceMap.get(s.rir);
      return {
        rir: s.rir,
        url: s.url,
        status: live?.status ?? s.status,
        recordsIngested: live?.recordsIngested ?? s.recordsIngested,
        recordsSkipped: live?.recordsSkipped ?? s.recordsSkipped,
        bytesDownloaded: live?.bytesDownloaded ?? s.bytesDownloaded,
        ipv4Count: live?.ipv4Count ?? s.ipv4Count,
        ipv6Count: live?.ipv6Count ?? s.ipv6Count,
        asnCount: live?.asnCount ?? s.asnCount,
        startedAt: live?.startedAt ?? s.startedAt,
        endedAt: live?.endedAt ?? s.endedAt,
        errorMessage: live?.errorMessage ?? s.errorMessage,
        recordsPerSecond: live?.recordsPerSecond ?? 0,
      };
    }),
    ratePerSecond: activeSnapshot?.ratePerSecond ?? 0,
  };
}

export function jobToDto(job: CollectionJob): {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  totalIngested: number;
  totalSkipped: number;
  durationMs: number | null;
  errorMessage: string | null;
} {
  const live = activeJob?.jobId === job.id ? activeJob : null;
  const totalIngested = live?.totalIngested ?? job.totalIngested;
  const totalSkipped = live?.totalSkipped ?? job.totalSkipped;
  const status = live ? (live.shouldStop ? "stopping" : "running") : job.status;
  const durationMs = job.endedAt
    ? job.endedAt.getTime() - job.startedAt.getTime()
    : live
      ? Date.now() - live.startedAtMs
      : null;
  return {
    id: job.id,
    status,
    startedAt: job.startedAt.toISOString(),
    endedAt: job.endedAt ? job.endedAt.toISOString() : null,
    totalIngested,
    totalSkipped,
    durationMs,
    errorMessage: job.errorMessage,
  };
}
