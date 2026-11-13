/**
 * Enrichment engine.
 *
 * Mirrors the collector but for free public CIDR/ASN feeds:
 *   - asn-name sources update asn_blocks.name in-place
 *   - bgp-origin sources insert into bgp_origin_ranges (separate table)
 *   - cloud sources insert into cloud_ranges (separate table)
 *   - geofeed sources insert into geofeed_ranges (separate table)
 *   - threat sources insert into threat_ranges (separate table)
 *
 * One enrichment job at a time. Cloud/geofeed/bgp-origin/threat sources are
 * refreshed by deleting prior rows for that provider/source before
 * re-ingesting, so repeated runs always reflect the upstream file.
 */

import { isIP } from "node:net";
import { createHash, type Hash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { PassThrough, Readable } from "node:stream";
import unbzip2 from "unbzip2-stream";
import parserWebStream from "stream-json/web";
import { pick } from "stream-json/web/filters/pick.js";
import { streamArray } from "stream-json/web/streamers/stream-array.js";
import { eq, sql, desc, and, lt, inArray, notInArray } from "drizzle-orm";
import {
  db,
  asnBlocksTable,
  bgpOriginRangesTable,
  cloudRangesTable,
  geofeedRangesTable,
  dbipLiteRangesTable,
  geonamesPlacesTable,
  threatRangesTable,
  specialPurposeRangesTable,
  asnReachTable,
  anonymityRangesTable,
  rpkiRoasTable,
  enrichmentJobsTable,
  enrichmentSourcesTable,
  verifiedBotRangesTable,
  neighborhoodStatsTable,
  asnProfileTable,
  ensureIpIntel,
  ipIntelState,
  seedAnycastTable,
  type EnrichmentJob,
} from "@workspace/db";
import { openBulkRowWriter } from "./bulk-load";
import {
  logger,
  parseCidr,
  fetchWithRetry,
  formatJobDisplayId,
  parseSequentialJobRef,
  sleep,
  ipv4ToInt,
  rangeToCidrs,
  parseIpv6,
  rangeToCidrs6,
} from "@workspace/shared";
import { extractSingleEntryZip } from "./zip";
import { iterMrtRibPrefixes, type MrtStats } from "./mrt";
import { pruneDbIpCoveredByGeofeeds } from "./dbip-prune";
import { purgeDisabledSourceRows } from "./disabled-sources";
import { purgeRdapCache } from "./rdap-cache-purge";
import { geocodeCityName } from "./geocode";
import {
  BGP_ORIGIN_SOURCE_IDS,
  KNOWN_ENRICHMENT_SOURCES,
  type EnrichmentSourceConfig,
} from "./enrichment-sources";
import { loadCollectorConfig, type CollectorConfig } from "../config";
import { runCapture } from "../history";
import { geofeedField, geofeedCountry, withHeartbeat } from "@workspace/shared";

const JOB_ID_PREFIX = "enrich";
const USER_AGENT = "ip-insight-engine/1.0 (self-hosted; contact via project operator)";
/** See collector.ts's identical constant/comment — same reasoning. */
const ORPHANED_STATUSES = ["running", "stopping"] as const;

interface SourceRuntime {
  config: EnrichmentSourceConfig;
  sourceRowId: number;
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
  /**
   * BGP-origin sources only: rows Postgres refused with ON CONFLICT DO
   * NOTHING. Also counted in `recordsSkipped`, but kept apart because the
   * purge of a deselected BGP project must know it specifically: a large
   * value means the new project's rows collided with the old project's
   * instead of being written, and deleting the old rows then empties the
   * table. In memory only — the purge runs in the same job.
   */
  conflictDropped: number;
  bytesDownloaded: number;
  /** Fed every downloaded chunk (see the three read paths below) and
   * digested once the body is consumed. Null for sources that download
   * nothing. */
  hasher: Hash | null;
  contentHash: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  errorMessage: string | null;
}

interface ActiveJob {
  jobId: string;
  startedAtMs: number;
  shouldStop: boolean;
  sources: SourceRuntime[];
  totalIngested: number;
  totalSkipped: number;
  /** When true, skip the trailing `ip_intel` refresh — see the comment at
   * that call site in `runJob` for why this exists and when it is safe. */
  skipIpIntelRefresh: boolean;
}

let activeJob: ActiveJob | null = null;

// Set once per job, at the top of startEnrichment, from
// ip-insight.config.json — module-level rather than threaded through every
// parser/flush helper below (there are over a dozen), safe because only one
// enrichment job runs at a time (see the "already running" guard above) and
// neither value changes mid-job.
let BATCH_SIZE = 2000;
let FETCH_RETRY = { attempts: 4, baseDelayMs: 1000, timeoutMs: 30_000 };
let SOURCE_RETRY_ATTEMPTS = 3;

export function isEnrichmentActive(): boolean {
  return activeJob !== null;
}

export function listEnrichmentSources(): EnrichmentSourceConfig[] {
  return KNOWN_ENRICHMENT_SOURCES.slice();
}

export async function startEnrichment(
  sourceIds?: string[],
  options?: { resumeJobRef?: string; skipIpIntelRefresh?: boolean },
): Promise<EnrichmentJob> {
  if (activeJob) {
    throw new Error("An enrichment job is already running");
  }
  const config = loadCollectorConfig();
  BATCH_SIZE = config.batchSize;
  FETCH_RETRY = {
    attempts: config.fetchRetry.maxAttempts,
    baseDelayMs: config.fetchRetry.baseDelayMs,
    timeoutMs: config.fetchRetry.timeoutMs,
  };
  SOURCE_RETRY_ATTEMPTS = config.sourceRetryMaxAttempts;

  // Only `apps/server`'s startup ever seeded this table before — a CLI-only
  // deployment (no server ever started) silently never got it, so
  // `ip_intel.is_anycast` disagreed with this same package's own `lookup`
  // command (which has its own in-memory fallback for the same curated
  // list) for every well-known anycast address. Idempotent and cheap
  // (~20 rows, ON CONFLICT DO NOTHING), safe to call on every enrichment run.
  await seedAnycastTable();

  // Sweep runs before either branch below: a job that crashed mid-run is
  // still marked "running" until this marks it "interrupted", and
  // `resumeEnrichment` only accepts a job already in that state. Without
  // this running here too, `--resume` called right after a crash (the most
  // common time anyone calls it) found nothing to resume, since nothing had
  // been swept yet — this used to only run on the non-resume branch below.
  if (config.checkpointingEnabled) {
    await sweepOrphanedEnrichmentJobs(config);
  }

  if (options?.resumeJobRef) {
    return resumeEnrichment(options.resumeJobRef, config, options.skipIpIntelRefresh ?? false);
  }

  // Explicit `sourceIds` always wins; otherwise fall back to
  // ip-insight.config.json's "enrichment" list, then to everything.
  const effectiveIds = sourceIds && sourceIds.length > 0 ? sourceIds : config.enrichment;
  const sourcesToRun = (
    effectiveIds && effectiveIds.length > 0
      ? KNOWN_ENRICHMENT_SOURCES.filter((s) => effectiveIds.includes(s.id))
      : KNOWN_ENRICHMENT_SOURCES
  ).slice();
  if (sourcesToRun.length === 0) {
    throw new Error("No matching enrichment sources to run");
  }

  const [job] = await db
    .insert(enrichmentJobsTable)
    .values({ status: "running" })
    .returning();
  if (!job) throw new Error("Failed to create enrichment job row");

  const sourceRows = await db
    .insert(enrichmentSourcesTable)
    .values(
      sourcesToRun.map((s) => ({
        jobId: job.id,
        sourceId: s.id,
        kind: s.kind,
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
    skipIpIntelRefresh: options?.skipIpIntelRefresh ?? false,
    sources: sourcesToRun.map((cfg) => {
      const row = sourceRows.find((r) => r.sourceId === cfg.id);
      return {
        config: cfg,
        sourceRowId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
        conflictDropped: 0,
        bytesDownloaded: 0,
        hasher: null,
        contentHash: null,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
      };
    }),
  };

  void runJob(activeJob).catch((err) => {
    logger.error({ err }, "Enrichment job failed unexpectedly");
  });
  return job;
}

/** See collector.ts's `sweepOrphanedCollectionJobs` — identical reasoning,
 * separate table, also called periodically by the maintenance scheduler. */
export async function sweepOrphanedEnrichmentJobs(config: CollectorConfig): Promise<void> {
  if (activeJob) return;
  const orphaned = await db
    .update(enrichmentJobsTable)
    .set({ status: "interrupted", endedAt: new Date() })
    .where(inArray(enrichmentJobsTable.status, [...ORPHANED_STATUSES]))
    .returning({ id: enrichmentJobsTable.id });
  if (orphaned.length > 0) {
    logger.warn(
      { jobIds: orphaned.map((o) => o.id) },
      "Marked orphaned enrichment job(s) as interrupted (process restarted mid-run)",
    );
  }

  if (config.checkpointAutoCleanupStaleJobs) {
    const cutoff = new Date(Date.now() - config.checkpointStaleAfterHours * 3_600_000);
    const deleted = await db
      .delete(enrichmentJobsTable)
      .where(
        and(
          eq(enrichmentJobsTable.status, "interrupted"),
          lt(enrichmentJobsTable.startedAt, cutoff),
        ),
      )
      .returning({ id: enrichmentJobsTable.id });
    if (deleted.length > 0) {
      logger.info({ count: deleted.length }, "Auto-cleaned stale interrupted enrichment job(s)");
    }
  }
}

async function resolveEnrichmentJobRef(ref: string): Promise<EnrichmentJob> {
  const seq = parseSequentialJobRef(JOB_ID_PREFIX, ref);
  let row: EnrichmentJob | undefined;
  try {
    const rows =
      seq !== null
        ? await db.select().from(enrichmentJobsTable).where(eq(enrichmentJobsTable.seq, seq))
        : await db.select().from(enrichmentJobsTable).where(eq(enrichmentJobsTable.id, ref));
    row = rows[0];
  } catch {
    row = undefined;
  }
  if (!row) throw new Error(`No enrichment job found matching "${ref}"`);
  return row;
}

export function formatEnrichmentJobDisplayId(job: { id: string; seq: number }): string {
  const format = loadCollectorConfig().checkpointIdFormat;
  return formatJobDisplayId(JOB_ID_PREFIX, job.seq, format, job.id);
}

/** Sweeps orphaned jobs first: the id-less `--resume` path resolves its
 * default entirely through this function, without ever calling
 * `startEnrichment` (which is where the sweep otherwise runs) — so without
 * this, a job that crashed moments ago is still sitting as "running" here
 * and `--resume` (called right after the crash, the most common time to
 * call it at all) reports nothing to resume. */
export async function listResumableEnrichmentJobs(): Promise<
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
  await sweepOrphanedEnrichmentJobs(config);
  const jobs = await db
    .select()
    .from(enrichmentJobsTable)
    .where(eq(enrichmentJobsTable.status, "interrupted"))
    .orderBy(desc(enrichmentJobsTable.startedAt));
  const cutoffMs = Date.now() - config.checkpointStaleAfterHours * 3_600_000;

  const out = [];
  for (const job of jobs) {
    const srcs = await db
      .select({ status: enrichmentSourcesTable.status })
      .from(enrichmentSourcesTable)
      .where(eq(enrichmentSourcesTable.jobId, job.id));
    out.push({
      id: job.id,
      displayId: formatJobDisplayId(JOB_ID_PREFIX, job.seq, config.checkpointIdFormat, job.id),
      startedAt: job.startedAt,
      sourcesTotal: srcs.length,
      sourcesCompleted: srcs.filter((s) => s.status === "completed").length,
      stale: job.startedAt.getTime() < cutoffMs,
    });
  }
  return out;
}

/** Resumes an interrupted job: only "completed" sources are left alone —
 * unlike collector.ts, enrichment has no legitimate "skipped, still
 * fresh" state (its only "skipped" comes from a graceful-stop request,
 * which — barring a crash in the same instant a stop was requested, a
 * narrow double-fault this doesn't special-case — ends the job as
 * "stopped", not "interrupted", so it's never seen here). Every other
 * source re-runs from scratch. Config-driven skips (a deselected
 * `bgpOriginSource` project, a disabled ASN-name fallback) also land in
 * "skipped" since 2026-11-08 and so re-run here too — harmless, since they
 * check the same config again and skip again. */
async function resumeEnrichment(
  ref: string,
  config: CollectorConfig,
  skipIpIntelRefresh = false,
): Promise<EnrichmentJob> {
  if (!config.checkpointingEnabled) {
    throw new Error(
      "Checkpointing is disabled (checkpointingEnabled: false in config) — nothing to resume",
    );
  }
  const job = await resolveEnrichmentJobRef(ref);
  if (job.status !== "interrupted") {
    throw new Error(`Job ${ref} is not resumable (status: ${job.status})`);
  }

  const existingSources = await db
    .select()
    .from(enrichmentSourcesTable)
    .where(eq(enrichmentSourcesTable.jobId, job.id));
  const pending = existingSources.filter((s) => s.status !== "completed");
  if (pending.length === 0) {
    throw new Error(`Job ${ref} has no pending sources left — every source already completed`);
  }

  const sourcesToRun = pending
    .map((s) => KNOWN_ENRICHMENT_SOURCES.find((k) => k.id === s.sourceId))
    .filter((s): s is EnrichmentSourceConfig => s !== undefined);

  for (const s of pending) {
    await db
      .update(enrichmentSourcesTable)
      .set({
        status: "pending",
        recordsIngested: 0,
        recordsSkipped: 0,
        bytesDownloaded: 0,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
      })
      .where(eq(enrichmentSourcesTable.id, s.id));
  }

  const [updatedJob] = await db
    .update(enrichmentJobsTable)
    // See collector.ts's resumeCollection — same reasoning for bumping startedAt.
    .set({ status: "running", endedAt: null, startedAt: new Date() })
    .where(eq(enrichmentJobsTable.id, job.id))
    .returning();
  if (!updatedJob) throw new Error(`Failed to reactivate job ${ref}`);

  activeJob = {
    jobId: job.id,
    startedAtMs: Date.now(),
    shouldStop: false,
    totalIngested: job.totalIngested,
    totalSkipped: job.totalSkipped,
    skipIpIntelRefresh,
    sources: sourcesToRun.map((cfg) => {
      const row = pending.find((r) => r.sourceId === cfg.id);
      return {
        config: cfg,
        sourceRowId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
        conflictDropped: 0,
        bytesDownloaded: 0,
        hasher: null,
        contentHash: null,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
      };
    }),
  };

  logger.info(
    { jobId: job.id, resumedSources: sourcesToRun.map((s) => s.id) },
    "Resuming interrupted enrichment job",
  );

  void runJob(activeJob).catch((err) => {
    logger.error({ err }, "Resumed enrichment job failed unexpectedly");
  });

  return updatedJob;
}

export async function stopEnrichment(): Promise<EnrichmentJob | null> {
  if (!activeJob) return null;
  activeJob.shouldStop = true;
  const [row] = await db
    .update(enrichmentJobsTable)
    .set({ status: "stopping" })
    .where(eq(enrichmentJobsTable.id, activeJob.jobId))
    .returning();
  return row ?? null;
}

/**
 * Start-of-job cleanup for `disabledEnrichmentSources`. At the start, not the
 * end: a disabled source has no replacement to wait for, and removing its
 * geofeed rows first lets a DB-IP run later in the same job restore the
 * DB-IP rows it had pruned underneath them.
 */
async function purgeDisabledSources(job: ActiveJob): Promise<void> {
  const disabled = loadCollectorConfig().disabledEnrichmentSources;
  if (disabled.length === 0) return;
  try {
    const { deletedGeofeedRows, notFullyPurged } = await purgeDisabledSourceRows(disabled);
    if (deletedGeofeedRows > 0) {
      logger.info({ disabled, deletedGeofeedRows }, "Removed geofeed rows of sources disabled in config");
      const dbipRuns = job.sources.some((s) => s.config.id === "dbip-lite") && !disabled.includes("dbip-lite");
      if (!dbipRuns) {
        logger.warn(
          "DB-IP rows that had been pruned under those geofeed rows are still missing, so those addresses have no city until DB-IP is ingested again. Run: ip-insight enrich --sources dbip-lite",
        );
      }
    }
    if (notFullyPurged.length > 0) {
      logger.warn(
        { notFullyPurged },
        "Disabled sources whose earlier rows may remain in a table other than geofeed_ranges — not removed automatically",
      );
    }
  } catch (err) {
    // Not fatal: the sources are still skipped; the rows go next run.
    logger.warn({ err }, "Removing rows of disabled sources failed — retried on the next run");
  }
}

async function runJob(job: ActiveJob): Promise<void> {
  try {
    await purgeDisabledSources(job);
    if (!loadCollectorConfig().rdapEnabled) {
      try {
        const removed = await purgeRdapCache();
        if (removed.abuseContacts + removed.networkNames + removed.geofeedRows > 0) {
          logger.info(removed, "Removed data cached by live RDAP queries (rdapEnabled is false)");
        }
      } catch (err) {
        logger.warn({ err }, "Removing the RDAP cache failed — retried on the next run");
      }
    }
    for (const source of job.sources) {
      if (job.shouldStop) {
        source.status = "skipped";
        await persistSource(source);
        continue;
      }
      await runSourceWithRetry(job, source);
      // Right after the BGP sources, not at the end of the job: the derived
      // sources registered after them (asn-reach, neighborhood-stats,
      // asn-profile) aggregate `bgp_origin_ranges`, and on the run that
      // switches `bgpOriginSource` they would otherwise count both projects'
      // rows at once. The purge guards itself, so calling it after each
      // BGP source is a no-op until every selected one has completed.
      if (source.config.kind === "bgp-origin") {
        await purgeDeselectedBgpOriginSource(job);
      }
    }

    // After every source has had its turn, never before: this removes ASN
    // names belonging to a source the config no longer selects, and it
    // guards itself against partial/failed runs rather than trusting the
    // caller to only invoke it on a full one. See its own doc comment and
    // `docs/104`.
    await purgeDeselectedAsnNameSources(job);

    // A source failing (network cut mid-stream, upstream outage, ...) does
    // not throw out of runSource — it's caught there and recorded on the
    // source row, so the loop above always runs every remaining source
    // rather than abandoning the whole job over one feed. That's the right
    // call for independent sources, but it means "every source ran" and
    // "every source succeeded" are different things, and the job's own
    // status has to say which one actually happened — reporting "completed"
    // either way would hide a source that silently only got a fraction of
    // its data (e.g. a multi-million-row feed cut off partway through) behind
    // a status that reads as "nothing wrong here".
    const failedSources = job.sources.filter((s) => s.status === "failed");
    const finalStatus = job.shouldStop
      ? "stopped"
      : failedSources.length > 0
        ? "completed_with_errors"
        : "completed";
    await db
      .update(enrichmentJobsTable)
      .set({
        status: finalStatus,
        endedAt: new Date(),
        totalIngested: job.totalIngested,
        totalSkipped: job.totalSkipped,
        errorMessage:
          failedSources.length > 0
            ? `${failedSources.length} source(s) failed: ${failedSources.map((s) => `${s.config.id} (${s.errorMessage ?? "unknown error"})`).join("; ")}`
            : null,
      })
      .where(eq(enrichmentJobsTable.id, job.jobId));
    logger.info(
      {
        jobId: job.jobId,
        status: finalStatus,
        ingested: job.totalIngested,
        skipped: job.totalSkipped,
        durationMs: Date.now() - job.startedAtMs,
      },
      "Enrichment job finished",
    );

    // The flattened `ip_intel` relation reads every table this job just
    // rewrote, so it is stale the moment enrichment completes. Refreshing it
    // here (rather than leaving it to the operator) is what keeps the
    // one-query contract honest: whatever `ip_intel` returns always reflects
    // the last completed enrichment. Cheap for a plain view (a DDL statement),
    // genuinely expensive to rebuild when materialized — which is exactly why
    // that form is opt-in. Never fatal: a failure here leaves the source
    // tables correct and only the convenience layer behind, so it is logged
    // and the job still counts as completed.
    if (job.skipIpIntelRefresh) {
      // Opt-in escape hatch for a *partial* enrichment run. The refresh
      // below is unconditional by design (see its comment) precisely so
      // `ip_intel` can never silently lag the tables it reads — but that
      // guarantee costs a full materialized rebuild, measured at ~4.7 hours
      // on the real deployment, and it is paid in full even by a run that
      // touched exactly one small source. That makes `--sources <one-id>`
      // useless for the frequent, narrow refreshes a fast tier needs: the
      // 10-minute part is dwarfed by the 4.7-hour part that follows it.
      //
      // Skipping is therefore allowed, but never by default and never
      // silently: the caller has to ask for it, and the log line below says
      // plainly that `ip_intel` is now behind the source tables and names
      // what fixes it. Anything reading `ip_intel` (including the .mmdb
      // export, which builds from it) keeps serving the previous build
      // until a refresh actually runs — stale, but coherent and clearly
      // announced, which is the tradeoff this flag exists to make
      // available rather than to hide.
      logger.warn(
        { jobId: job.jobId },
        "Skipping the ip_intel refresh (--skip-flatten): source tables are now newer than " +
          "ip_intel, and anything built from it (including the .mmdb export) will keep serving " +
          "the previous build until `ip-insight flatten` runs.",
      );
    } else if (!job.shouldStop) {
      try {
        // Refresh whatever form `ip_intel` is already in; only fall back to
        // the configured mode when there is nothing to refresh.
        //
        // Enrichment's job here is to keep the relation *current*, not to
        // change what kind of relation it is. Obeying the config outright
        // made this the most destructive line in the codebase: a
        // materialized `ip_intel` costs hours to build, and any run that
        // saw `ipIntelMode: "view"` would drop it without a word. That
        // includes runs where nobody chose "view" at all — the config is
        // resolved from the working directory, so a scheduled run started
        // from the wrong one finds no file, takes every default, and the
        // default is "view". A cron entry missing a `cd` would quietly
        // destroy the build it exists to maintain.
        //
        // Changing form stays possible, but only where it is asked for by
        // name: `ip-insight flatten --mode <view|materialized|off>`.
        const configured = loadCollectorConfig().ipIntelMode;
        const current = await ipIntelState();
        const mode = current === "off" ? configured : current;
        if (mode !== configured) {
          logger.info(
            { jobId: job.jobId, configured, actual: mode },
            `ip_intel is currently "${mode}" while the config says "${configured}" — refreshing it as-is. Use \`ip-insight flatten --mode ${configured}\` to convert it deliberately.`,
          );
        }
        // A materialized build/refresh is one blocking statement with no
        // sub-progress to report — hours on a full dataset (see DEPLOY.md's
        // sizing section) with nothing logged for the entire span otherwise,
        // indistinguishable from the job having silently died. The heartbeat
        // below is the same fix already applied to `ip-insight flatten` for
        // the same reason; a plain "view" completes near-instantly, so it
        // ticks at most once.
        const rows = await withHeartbeat(
          30_000,
          (elapsedSec) =>
            logger.info({ jobId: job.jobId, mode, elapsedSec }, "ip_intel refresh still running"),
          () => ensureIpIntel(mode),
          () =>
            db
              .execute(sql`SELECT 1`)
              .then(() => true)
              .catch(() => false),
          (elapsedSec, consecutiveFailures) =>
            logger.warn(
              { jobId: job.jobId, mode, elapsedSec, consecutiveFailures },
              "ip_intel refresh: database connection check failed — the build may be stuck on a dead connection, not just slow",
            ),
        );
        logger.info({ jobId: job.jobId, mode, rows }, "ip_intel refreshed");
      } catch (err) {
        logger.warn({ err, jobId: job.jobId }, "ip_intel refresh failed — source tables are unaffected");
      }

      // History capture, when enabled, is the last thing an enrichment does —
      // strictly after the `ip_intel` refresh above, since it diffs exactly
      // that relation and would otherwise archive the *previous* run's data
      // as though it were this one's. `runCapture` never throws and records
      // its own outcome (including "skipped, ip_intel isn't materialized"),
      // so nothing here can turn an enrichment that already succeeded into a
      // failure — see history.ts.
      if (loadCollectorConfig().historyCaptureEnabled) {
        const capture = await runCapture("auto");
        logger.info(
          { jobId: job.jobId, status: capture.status, ...(capture.result ?? {}) },
          "History capture (auto)",
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(enrichmentJobsTable)
      .set({
        status: "failed",
        endedAt: new Date(),
        errorMessage: message,
        totalIngested: job.totalIngested,
        totalSkipped: job.totalSkipped,
      })
      .where(eq(enrichmentJobsTable.id, job.jobId));
    logger.error({ err, jobId: job.jobId }, "Enrichment job failed");
  } finally {
    if (activeJob?.jobId === job.jobId) {
      activeJob = null;
    }
  }
}

/**
 * Runs a source, and if it fails outright, redoes the whole thing (fetch and
 * parse together) from scratch — up to SOURCE_RETRY_ATTEMPTS times, with the
 * same exponential backoff fetchWithRetry uses. This exists for a failure
 * mode fetchWithRetry can't cover: a connection that dies *after* the
 * request already succeeded, partway through streaming a multi-million-row
 * body. Retrying is only safe because every ingest function either deletes
 * its source's old rows before inserting or upserts on conflict — a redo
 * never leaves duplicate or half-old-half-new data behind.
 */
async function runSourceWithRetry(job: ActiveJob, source: SourceRuntime): Promise<void> {
  for (let attempt = 1; attempt <= SOURCE_RETRY_ATTEMPTS; attempt++) {
    await runSource(job, source);
    if (source.status !== "failed") return; // succeeded, or user-requested stop
    // Retrying cannot fix an old schema; it only made the operator wait
    // through the backoff before seeing the message.
    if (source.errorMessage === BGP_SCHEMA_OUT_OF_DATE) return;
    if (attempt === SOURCE_RETRY_ATTEMPTS) break;

    const delay = FETCH_RETRY.baseDelayMs * 2 ** attempt;
    logger.warn(
      { sourceId: source.config.id, attempt, attempts: SOURCE_RETRY_ATTEMPTS, delayMs: delay },
      "Enrichment source failed, retrying whole source",
    );
    source.status = "pending";
    source.recordsIngested = 0;
    source.recordsSkipped = 0;
    source.conflictDropped = 0;
    source.bytesDownloaded = 0;
    source.errorMessage = null;
    await persistSource(source);
    await sleep(delay);
  }
  logger.error(
    { sourceId: source.config.id, attempts: SOURCE_RETRY_ATTEMPTS, errorMessage: source.errorMessage },
    `Enrichment source "${source.config.id}" failed after ${SOURCE_RETRY_ATTEMPTS} attempts — giving up`,
  );
}

async function runSource(
  job: ActiveJob,
  source: SourceRuntime,
): Promise<void> {
  source.status = "downloading";
  source.startedAt = new Date();
  await persistSource(source);

  // Disabled in config (`disabledEnrichmentSources`): skipped before
  // anything else, derived sources included, and even when named in
  // `--sources` — the config is the decision; a command-line list should
  // not quietly override a licensing call.
  if (loadCollectorConfig().disabledEnrichmentSources.includes(source.config.id)) {
    source.status = "skipped";
    source.errorMessage = "disabled in config (disabledEnrichmentSources)";
    source.endedAt = new Date();
    await persistSource(source);
    return;
  }

  try {
    // Derived sources compute from tables already in this database, so they
    // skip the fetch entirely rather than fitting the single-fetch-then-parse
    // flow every other source below uses.
    const derivedHandlers: Record<string, (j: ActiveJob, s: SourceRuntime) => Promise<void>> = {
      "asn-reach-sql": computeAsnReach,
      "neighborhood-sql": computeNeighborhoodStats,
      "asn-profile-sql": computeAsnProfile,
    };
    const derived = derivedHandlers[source.config.parser];
    if (derived) {
      source.status = "parsing";
      await persistSource(source);
      await derived(job, source);
      if ((source.status as string) !== "stopped") {
        source.status = "completed";
      }
      source.endedAt = new Date();
      await persistSource(source);
      return;
    }

    // `bgpOriginSource` is exclusive (config.ts): the deselected collector
    // project does not run at all — checked *before* the fetch, unlike the
    // ASN-name fallback's in-parser check, because here the point is not
    // depending on that project, and a download we then ignore is still
    // contact with it. Until RouteViews existed this gate had nothing to
    // gate: the only project's sources always ran.
    if (source.config.kind === "bgp-origin" && !isSelectedBgpOriginSource(source.config.id)) {
      source.status = "skipped";
      source.errorMessage = `not the selected bgpOriginSource ("${loadCollectorConfig().bgpOriginSource}") — see config.ts`;
      source.endedAt = new Date();
      await persistSource(source);
      return;
    }

    // Refuse to ingest BGP data into a table whose unique index is still the
    // pre-2026-11-08 (network, asn) one. On that index a newly selected
    // project's rows collide with the old project's and are dropped, and the
    // purge then deletes the old rows — measured on a real phone database
    // after a `push` that silently didn't run: 26,725 of 1,443,232 rows
    // left, ASN empty for nearly every address. Failing here, before any
    // delete, leaves the current data serving.
    if (source.config.kind === "bgp-origin") {
      const problem = await bgpOriginSchemaProblem();
      if (problem) {
        source.status = "failed";
        source.errorMessage = problem;
        source.endedAt = new Date();
        await persistSource(source);
        return;
      }
    }

    if (!source.config.url) {
      throw new Error(
        `Enrichment source "${source.config.id}" has no URL and no derived-source handler.`,
      );
    }

    const response = await fetchWithRetry(
      source.config.url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
        },
      },
      { label: `enrichment:${source.config.id}`, ...FETCH_RETRY },
    );
    if (!response.ok || !response.body) {
      source.status = "failed";
      source.errorMessage = `HTTP ${response.status} ${response.statusText}`;
      source.endedAt = new Date();
      await persistSource(source);
      return;
    }
    source.status = "parsing";
    // Started here rather than at source construction so it only ever covers
    // the bytes of the body actually parsed below — a run that failed at the
    // HTTP layer has no content to describe and leaves `contentHash` null.
    source.hasher = createHash("sha256");
    await persistSource(source);

    switch (source.config.parser) {
      case "ripe-asn-txt":
        await ingestRipeAsnTxt(job, source, response);
        break;
      case "caida-asn-org-txt":
        await ingestCaidaAsnOrgTxt(job, source, response);
        break;
      case "ris-whois-dump":
        await ingestRisWhoisDump(job, source, response);
        break;
      case "routeviews-mrt-rib":
        await ingestRouteViewsRib(job, source, response);
        break;
      case "aws-json":
        await ingestAwsJson(job, source, response);
        break;
      case "gcp-json":
        await ingestGcpJson(job, source, response);
        break;
      case "cloudflare-text":
        await ingestCloudflareText(job, source, response);
        break;
      case "oracle-json":
        await ingestOracleJson(job, source, response);
        break;
      case "fastly-json":
        await ingestFastlyJson(job, source, response);
        break;
      case "bunny-cdn-json":
        await ingestBunnyCdnJson(job, source, response);
        break;
      case "digitalocean-geofeed-csv":
        await ingestDigitalOceanGeofeedCsv(job, source, response);
        break;
      case "rfc8805-geofeed-csv":
        await ingestRfc8805GeofeedCsv(job, source, response);
        break;
      case "lacnic-whois-city":
        await ingestLacnicWhoisCity(job, source, response);
        break;
      case "geonames-cities-zip":
        await ingestGeonamesCitiesZip(job, source, response);
        break;
      case "iana-special-csv":
        await ingestIanaSpecialCsv(job, source, response);
        break;
      case "bot-prefixes-json":
        await ingestBotPrefixesJson(job, source, response);
        break;
      case "tor-exit-list":
        await ingestTorExitList(job, source, response);
        break;
      case "azure-service-tags-json":
        await ingestAzureServiceTags(job, source, response);
        break;
      case "mullvad-relays-json":
        await ingestMullvadRelays(job, source, response);
        break;
      case "rpki-vrp-json":
        await ingestRpkiVrp(job, source, response);
        break;
      case "feodotracker-json":
        await ingestFeodoTracker(job, source, response);
        break;
      case "dbip-lite-csv":
        await ingestDbIpLiteCsv(job, source, response);
        break;
      default:
        throw new Error(`Unknown parser ${source.config.parser}`);
    }

    // "skipped" survives too: a parser that decided not to run (the ASN-name
    // fallback when disabled) used to be relabelled "completed" here, so
    // status output claimed a run that never happened.
    const s = source.status as string;
    if (s !== "stopped" && s !== "failed" && s !== "skipped") {
      source.status = "completed";
    }
  } catch (err) {
    source.status = "failed";
    source.errorMessage = err instanceof Error ? err.message : String(err);
    // `err` goes through pino's error serializer, which includes the full
    // stack — the one-line errorMessage above is what gets persisted/shown
    // in status polling, but the stack is what's actually needed to tell
    // "flaky mobile connection" apart from "this parser has a real bug".
    logger.error({ err, sourceId: source.config.id }, "Enrichment source failed");
  }
  // Digested here rather than beside each parser: every read path feeds the
  // same hasher, and this runs on success and failure alike, so a partial
  // download still records what was actually received.
  if (source.hasher) {
    source.contentHash = source.hasher.digest("hex");
    source.hasher = null;
  }
  source.endedAt = new Date();
  await persistSource(source);
}

/* ------------------------------------------------------------------------ */
/* Streaming helpers                                                         */
/* ------------------------------------------------------------------------ */

async function readAllText(
  response: Response,
  source: SourceRuntime,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    source.bytesDownloaded += value.byteLength;
    source.hasher?.update(value);
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Same as readAllText, but returns the raw bytes — for binary formats (ZIP) that can't be decoded as text. */
async function readAllBytes(
  response: Response,
  source: SourceRuntime,
): Promise<Buffer> {
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    source.bytesDownloaded += value.byteLength;
    source.hasher?.update(value);
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function* iterLines(
  response: Response,
  source: SourceRuntime,
): AsyncGenerator<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    source.bytesDownloaded += value.byteLength;
    source.hasher?.update(value);
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/** 0 when not an address, else the family. Thin wrapper so the parsers read
 * as intent rather than as a Node API detail. */
function isIpAddress(value: string): 0 | 4 | 6 {
  return isIP(value) as 0 | 4 | 6;
}

/* ------------------------------------------------------------------------ */
/* Parsers                                                                   */
/* ------------------------------------------------------------------------ */

async function ingestRipeAsnTxt(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  // Which tier this run is depends on config, not a fixed role — see
  // `asnNamePrimary`'s own doc comment in config.ts. Checked once at the
  // top, same as dbipLiteIpv6, so a config edit mid-run can't change
  // behaviour partway through a source's own pass.
  const cfg = loadCollectorConfig();
  const isPrimary = cfg.asnNamePrimary === "ripe";
  if (!isPrimary && !cfg.asnNameFallbackEnabled) {
    // Not a full no-op, and worth being honest about why: `runSource`
    // fetches every source's `url` before dispatching to its parser, so by
    // the time this function runs, `asn.txt` (a few MB) has already been
    // downloaded regardless of this check. What this actually skips is the
    // parse and every `asn_blocks` write — the part with real cost at scale
    // (122k rows) and the only part that could touch data caida-asn-names
    // already set correctly. Making the download itself conditional too
    // would mean `runSource` checking per-source config before fetching,
    // which no other source needs and isn't worth the coupling for one
    // small file.
    source.status = "skipped";
    source.errorMessage = "asnNameFallbackEnabled is false and this is not asnNamePrimary — see config.ts";
    await persistSource(source);
    return;
  }
  // Lines look like:  "1234 GOOGLE - Google LLC, US"
  // First whitespace-delimited token is the ASN, the rest is the holder name.
  let batch: Array<{ asn: number; name: string }> = [];
  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    const asn = Number(match[1]);
    const name = match[2]!.slice(0, 250);
    if (!Number.isFinite(asn)) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    batch.push({ asn, name });
    if (batch.length >= BATCH_SIZE) {
      // Unconditional (always wins) when this run is configured as
      // primary; otherwise only fills whatever the primary left null,
      // never overwriting it — the write-mode distinction *is* what
      // "primary" means here, independent of run order (see
      // asnNamePrimary's doc comment in config.ts).
      await flushAsnNames(batch, source, job, { onlyIfMissing: !isPrimary });
      batch = [];
    }
  }
  if (batch.length > 0) await flushAsnNames(batch, source, job, { onlyIfMissing: !isPrimary });
}

/**
 * CAIDA's `as-org2info.txt`: two sections in one file, org rows first
 * (`org_id|changed|org_name|country|source`) then AS rows
 * (`aut|changed|aut_name|org_id|opaque_id|source`) referencing them. Held
 * in memory rather than two passes over the stream — ~99k orgs, a few MB,
 * against a collector already holding much larger structures (dbip-lite's
 * CIDR batches) in flight elsewhere. Org rows are guaranteed to precede AS
 * rows in every real file checked (2026-08-24 through 2026-08's), and this
 * relies on that ordering rather than sorting first — if CAIDA ever
 * reorders the file, AS rows referencing a not-yet-seen org_id are counted
 * as skipped rather than silently dropped, so that assumption failing
 * would show up as a real number, not a quiet gap.
 */
async function ingestCaidaAsnOrgTxt(
  job: ActiveJob,
  source: SourceRuntime,
  _bootstrapResponse: Response,
): Promise<void> {
  // Checked before the real fetch below (unlike ripe-asn-names' equivalent
  // check, which runs after `runSource` already downloaded `asn.txt` — see
  // that function's comment). This one genuinely is a no-op when it fires:
  // `_bootstrapResponse` above is only the tiny directory-listing page
  // `runSource` fetches for every source's base `url`; the real ~10-20MB
  // monthly file is fetched below, and this return is placed before that.
  const cfg = loadCollectorConfig();
  const isPrimary = cfg.asnNamePrimary === "caida";
  if (!isPrimary && !cfg.asnNameFallbackEnabled) {
    source.status = "skipped";
    source.errorMessage = "asnNameFallbackEnabled is false and this is not asnNamePrimary — see config.ts";
    await persistSource(source);
    return;
  }

  const now = new Date();
  const candidateMonths = [0, 1].map((monthsBack) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`;
  });

  let gzResponse: Response | undefined;
  let resolvedUrl = "";
  for (const yyyymmdd of candidateMonths) {
    const url = `https://publicdata.caida.org/datasets/as-organizations/${yyyymmdd}.as-org2info.txt.gz`;
    const attempt = await fetchWithRetry(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } },
      { label: `enrichment:${source.config.id}:${yyyymmdd}`, ...FETCH_RETRY },
    );
    if (attempt.ok && attempt.body) {
      gzResponse = attempt;
      resolvedUrl = url;
      break;
    }
  }
  if (!gzResponse) {
    throw new Error(
      `CAIDA AS-org: no downloadable file found for ${candidateMonths.join(" or ")} — check publicdata.caida.org's current filename pattern.`,
    );
  }
  logger.info({ url: resolvedUrl }, "caida-asn-names: resolved this month's download URL");

  const orgNames = new Map<string, string>();
  let section: "org" | "aut" | null = null;
  let batch: Array<{ asn: number; name: string }> = [];

  for await (const raw of iterLinesGzip(gzResponse, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# format:org_id")) {
      section = "org";
      continue;
    }
    if (line.startsWith("# format:aut")) {
      section = "aut";
      continue;
    }
    if (line.startsWith("#")) continue;

    if (section === "org") {
      const parts = line.split("|");
      const orgId = parts[0];
      const orgName = parts[2];
      if (orgId && orgName) orgNames.set(orgId, orgName.slice(0, 250));
      continue;
    }
    if (section === "aut") {
      const parts = line.split("|");
      const asn = Number(parts[0]);
      const orgId = parts[3];
      const name = orgId ? orgNames.get(orgId) : undefined;
      if (!Number.isFinite(asn) || !name) {
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      batch.push({ asn, name });
      if (batch.length >= BATCH_SIZE) {
        // Same write-mode distinction as ripe-asn-names' own calls — see
        // the comment there. Unconditional when configured primary,
        // fills-only-if-missing otherwise.
        await flushAsnNames(batch, source, job, { onlyIfMissing: !isPrimary });
        batch = [];
      }
    }
  }
  if (batch.length > 0) await flushAsnNames(batch, source, job, { onlyIfMissing: !isPrimary });
}

async function flushAsnNames(
  pairs: Array<{ asn: number; name: string }>,
  source: SourceRuntime,
  job: ActiveJob,
  opts: { onlyIfMissing: boolean },
): Promise<void> {
  if (pairs.length === 0) return;
  try {
    const values = sql.join(
      pairs.map((p) => sql`(${p.asn}::int, ${p.name}::text)`),
      sql`, `,
    );
    // `name_source` is written on the same statement as `name`, never
    // separately: a name whose provenance is a second UPDATE away is a name
    // that can end up mislabelled if anything fails in between, and the
    // purge below trusts this column to decide what to delete.
    await db.execute(sql`
      UPDATE asn_blocks
      SET name = v.name, name_source = ${source.config.id}
      FROM (VALUES ${values}) AS v(asn, name)
      WHERE asn_blocks.asn_start <= v.asn
        AND asn_blocks.asn_end >= v.asn
        ${
          opts.onlyIfMissing
            ? // "Only fill what's missing" has to mean missing *or
              // unattributed*, not just missing. A fallback guarded by
              // `name IS NULL` alone can never re-stamp a row it wrote on
              // an earlier run — that row has a name now, so the guard
              // skips it — which leaves the fallback's own past output
              // permanently without provenance. The purge then reads that
              // absent provenance as "no active source claims this" and
              // deletes live, legitimate data.
              //
              // Found by running exactly that case against a populated
              // database (docs/104): a full default run wiped 14,647 real
              // ASN names that ripe-asn-names had written in an earlier
              // session and could not re-claim. Adding `name_source IS
              // NULL` lets a fallback adopt its own unattributed rows, so
              // after one full run "no provenance" means what the purge
              // assumes it means.
              //
              // The third branch is why this isn't just two conditions: a
              // row the fallback already stamped satisfies neither of the
              // first two, so without it the fallback could never refresh
              // its *own* output — those names would freeze at whatever
              // the first stamped run wrote and silently go stale as the
              // upstream file changed. Matching this source's own id keeps
              // the "never overwrite the primary" rule intact (a row the
              // primary owns carries the primary's id, so it still fails
              // all three) while letting each source stay current in the
              // rows it actually owns.
              sql`AND (
                asn_blocks.name IS NULL
                OR asn_blocks.name_source IS NULL
                OR asn_blocks.name_source = ${source.config.id}
              )`
            : sql``
        }
    `);
    source.recordsIngested += pairs.length;
    job.totalIngested += pairs.length;
  } catch (err) {
    logger.warn({ err }, "asn-name batch update failed");
    source.recordsSkipped += pairs.length;
    job.totalSkipped += pairs.length;
  }
  await persistSource(source);
}

/**
 * Null when `bgp_origin_ranges` has the unique index this code needs,
 * otherwise an operator-facing explanation. Checks the index *definition*
 * rather than its name, and fails on the old (network, asn) index even if
 * the new one exists beside it, since either way the old one still drops
 * colliding rows.
 */
const BGP_SCHEMA_OUT_OF_DATE =
  "Database schema is out of date: bgp_origin_ranges still has the old (network, asn) unique index. " +
  "Run `pnpm --filter @workspace/db run push` first (it needs DATABASE_URL, from the shell or the repo-root .env). " +
  "Nothing was changed — the current BGP data is still in place.";

async function bgpOriginSchemaProblem(): Promise<string | null> {
  const { rows } = await db.execute<{ has_new: boolean | null; has_old: boolean | null }>(sql`
    SELECT bool_or(indexdef LIKE '%(network, asn, source)') AS has_new,
           bool_or(indexdef LIKE '%(network, asn)')         AS has_old
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'bgp_origin_ranges'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  `);
  const r = rows[0];
  if (r?.has_new && !r?.has_old) return null;
  return BGP_SCHEMA_OUT_OF_DATE;
}

/** Whether `bgpOriginSource` currently selects the project this source id belongs to. */
function isSelectedBgpOriginSource(sourceId: string): boolean {
  return BGP_ORIGIN_SOURCE_IDS[loadCollectorConfig().bgpOriginSource].includes(sourceId);
}


/**
 * Removes `bgp_origin_ranges` rows belonging to a BGP collector project
 * that `bgpOriginSource` no longer selects.
 *
 * Needed for the same reason as the ASN-name purge below, but the shape
 * differs because the setting is *exclusive* rather than primary/fallback:
 * exactly one project is active, so the active set is a single value and
 * the cleanup is one comparison, with no set arithmetic to get wrong.
 * (Why exclusive rather than a merge: `docs/104` — the second source
 * exists as a licensing escape hatch, not for extra coverage, and
 * blending them would leave us depending on the source we were trying to
 * become independent of.)
 *
 * The stale-data risk here is sharper than for names. Each source only
 * ever deletes its own rows before reinserting, so a deselected project's
 * rows simply stay — and because `ip_intel` resolves this table by
 * longest-prefix match, a stale narrow prefix from the old project
 * out-ranks a fresh wider one from the new. Old data wouldn't merely
 * linger; it would answer queries.
 *
 * Guarded exactly like the ASN-name purge: it runs only after the
 * selected source has completed in this job. That is also what makes the
 * setting safe to point at a source that hasn't been built yet — nothing
 * completes, so nothing is purged, and the current data keeps serving
 * rather than the table being emptied with no replacement.
 */
async function purgeDeselectedBgpOriginSource(job: ActiveJob): Promise<void> {
  const cfg = loadCollectorConfig();
  const active = cfg.bgpOriginSource;
  const activeIds = BGP_ORIGIN_SOURCE_IDS[active];

  // A project with no sources registered yet can never have "delivered its
  // data", so there is nothing to purge *against*. Checked explicitly
  // because the completed-sources guard below would otherwise pass
  // vacuously on an empty list — and `notInArray(source, [])` matches every
  // row, i.e. it would delete the whole table.
  if (activeIds.length === 0) {
    logger.debug(
      { active },
      "Skipping deselected-BGP-origin-source purge: the selected project has no sources registered yet",
    );
    return;
  }

  // Every id, not just one: a project contributes IPv4 and IPv6 through
  // separate sources, and purging the other project after only half of the
  // selected one landed would leave that family with no data at all —
  // neither the old project's rows nor replacements for them.
  const missing = activeIds.filter(
    (id) =>
      !job.sources.some(
        (s) => s.config.id === id && s.status === "completed",
      ),
  );
  if (missing.length > 0) {
    logger.debug(
      { active, activeIds, missing },
      "Skipping deselected-BGP-origin-source purge: not every source of the selected project completed in this job",
    );
    return;
  }

  // The same schema check runSource does, repeated here because this is the
  // step that actually deletes: on the old index, "the selected project
  // completed" can be true with almost none of its rows written.
  const schemaProblem = await bgpOriginSchemaProblem();
  if (schemaProblem) {
    logger.warn({ active }, `Skipping deselected-BGP-origin-source purge: ${schemaProblem}`);
    return;
  }
  // Independent of the index: if a selected source had a meaningful share of
  // its rows refused as conflicts, its data did not land, whatever the row
  // count says. RIS's own MOAS duplicates are ~150 in 1.27M; RouteViews
  // produces none. 1% leaves wide room for both.
  const collided = job.sources.filter(
    (s) =>
      activeIds.includes(s.config.id) &&
      s.conflictDropped > 0.01 * (s.recordsIngested + s.conflictDropped),
  );
  if (collided.length > 0) {
    logger.warn(
      {
        active,
        collided: collided.map((s) => ({ id: s.config.id, written: s.recordsIngested, refused: s.conflictDropped })),
      },
      "Skipping deselected-BGP-origin-source purge: the selected project's rows were largely refused as conflicts, so deleting the other project's rows would empty the table",
    );
    return;
  }

  try {
    // Refuse to delete when the rows we intend to *keep* don't exist.
    //
    // "Delete everything except X" is only ever correct if X is actually
    // there. Zero matches means one of two things, and neither justifies
    // deleting the rest: the selected sources completed without writing
    // anything, or — the dangerous one — `activeIds` doesn't match what
    // the column really contains.
    //
    // That mismatch is a live hazard, not a theoretical one. These
    // provenance columns hold an ingester-chosen tag, and other ingesters
    // in this file already use `source.config.source ?? source.config.id`,
    // so the tag and the registry id genuinely diverge elsewhere:
    // `feodotracker` writes `abuse.ch-feodotracker`, `gcp-ip-ranges`
    // writes `gcp`. `ingestRisWhoisDump` happens to write its plain
    // `config.id` today, which is the only reason the map above is
    // correct — add a `source:` override to those registry entries and it
    // silently stops matching, at which point this check is all that
    // stands between a config edit and an empty table.
    const [kept] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bgpOriginRangesTable)
      .where(inArray(bgpOriginRangesTable.source, activeIds));
    const keptCount = kept?.count ?? 0;
    if (keptCount === 0) {
      logger.warn(
        { active, activeIds },
        "Skipping deselected-BGP-origin-source purge: no rows carry the selected project's own source ids, so deleting everything else would empty the table",
      );
      return;
    }
    // "Some rows exist" was not enough: on the first real switch to
    // RouteViews, 24,527 rows existed where 1,170,244 had been reported
    // ingested, and the purge went ahead. The selected sources just ran in
    // this job, so the table must hold at least what they reported writing.
    // Fewer means rows went missing between insert and here, and deleting
    // the only other copy of the data would be the worst response to that.
    const reported = job.sources
      .filter((s) => activeIds.includes(s.config.id))
      .reduce((sum, s) => sum + s.recordsIngested, 0);
    if (keptCount < reported) {
      logger.warn(
        { active, activeIds, keptCount, reported },
        "Skipping deselected-BGP-origin-source purge: the selected project's rows in the table are fewer than it reported ingesting",
      );
      return;
    }

    const result = await db
      .delete(bgpOriginRangesTable)
      .where(notInArray(bgpOriginRangesTable.source, activeIds));
    const cleared = (result as { rowCount?: number | null }).rowCount ?? 0;
    if (cleared > 0) {
      logger.info(
        { active, cleared },
        "Deleted BGP origin ranges belonging to a deselected collector project",
      );
      // asn-reach / neighborhood-stats / asn-profile are computed *from*
      // bgp_origin_ranges. If this job doesn't recompute them, they keep
      // describing the old project — found on a real switch: "seen by 342"
      // (RIS's scale) next to RouteViews data, whose maximum is ~20.
      const derivedIds = KNOWN_ENRICHMENT_SOURCES.filter((s) => s.kind === "derived").map((s) => s.id);
      const missingDerived = derivedIds.filter((id) => !job.sources.some((s) => s.config.id === id));
      if (missingDerived.length > 0) {
        logger.warn(
          { active, missingDerived },
          `Tables derived from BGP data still describe the previous project. Run: ip-insight enrich --sources ${missingDerived.join(",")}`,
        );
      }
    }
  } catch (err) {
    // Non-fatal, same reasoning as the ASN-name purge: the ingestion
    // itself succeeded, and failing the job over a cleanup step would
    // discard good data. Stale rows survive to the next run, which retries.
    logger.warn({ err }, "Deselected-BGP-origin-source purge failed");
  }
}

/**
 * The ASN-name sources the current config actually has running: the
 * configured primary, plus the other one only when it's enabled as the
 * fallback. Derived from config alone — deliberately not from which
 * sources a given job happened to include, since a `--sources` run is a
 * subset of what's active, not a redefinition of it.
 */
function activeAsnNameSourceIds(
  cfg: ReturnType<typeof loadCollectorConfig>,
): string[] {
  const primary =
    cfg.asnNamePrimary === "caida" ? "caida-asn-names" : "ripe-asn-names";
  const fallback =
    cfg.asnNamePrimary === "caida" ? "ripe-asn-names" : "caida-asn-names";
  return cfg.asnNameFallbackEnabled ? [primary, fallback] : [primary];
}

/**
 * Clears ASN names left behind by a source that is no longer active.
 *
 * The gap this closes (`docs/104`): nothing else ever set `asn_blocks.name`
 * back to null, and each source only ever wrote its own rows — so switching
 * `asnNamePrimary`, or setting `asnNameFallbackEnabled` to false, stopped
 * *adding* that source's names without removing the ones already written.
 * They kept being served indefinitely, and kept flowing into `ip_intel` and
 * the published `.mmdb` from there.
 *
 * Two deliberate safety properties:
 *
 * 1. **Runs only after every active source completed in this job.** A
 *    partial run (`--sources caida-asn-names` while `ripe-asn-names` is
 *    still an active fallback) must not purge the source that simply
 *    didn't get its turn — that would delete live data and leave nothing
 *    to refill it. Same reason a failed source blocks the purge.
 * 2. **Runs after the writes, not before them.** Purging first would mean
 *    a failed ingest leaves neither the old names nor the new ones. This
 *    way the previous data keeps serving right up until verified fresh
 *    data has replaced it.
 *
 * Rows with a null `name_source` are treated as deselected too, not
 * spared: that's data written before this column existed, of unknown
 * provenance. This is only safe because `flushAsnNames` lets a fallback
 * claim unattributed rows (`name IS NULL OR name_source IS NULL`) — see
 * the long comment there. Without that, a fallback could never re-stamp
 * its own earlier output, and this function would delete live data it had
 * no way to recognise. That is not hypothetical: it is what the first
 * version of this pair actually did, on a real database, to 14,647 rows.
 */
async function purgeDeselectedAsnNameSources(job: ActiveJob): Promise<void> {
  const cfg = loadCollectorConfig();
  const active = activeAsnNameSourceIds(cfg);

  const missing = active.filter(
    (id) =>
      !job.sources.some(
        (s) => s.config.id === id && s.status === "completed",
      ),
  );
  if (missing.length > 0) {
    logger.debug(
      { active, missing },
      "Skipping deselected-ASN-name-source purge: not every active source completed in this job",
    );
    return;
  }

  try {
    const result = await db.execute(sql`
      UPDATE asn_blocks
      SET name = NULL, name_source = NULL
      WHERE name IS NOT NULL
        AND (
          name_source IS NULL
          OR name_source NOT IN (${sql.join(
            active.map((id) => sql`${id}`),
            sql`, `,
          )})
        )
    `);
    const cleared = (result as { rowCount?: number | null }).rowCount ?? 0;
    if (cleared > 0) {
      logger.info(
        { active, cleared },
        "Cleared ASN names belonging to no currently-active source",
      );
    }
  } catch (err) {
    // Non-fatal on purpose: the job's own ingestion succeeded, and failing
    // the whole run over a cleanup step would throw away good data. The
    // stale rows simply survive to the next run, which retries this.
    logger.warn({ err }, "Deselected-ASN-name-source purge failed");
  }
}

/**
 * Same line-by-line streaming as `iterLines`, but for a gzip-compressed
 * response body (the RIS whois dumps are ~5MB gzipped / ~50MB raw).
 * `source.bytesDownloaded` tracks compressed bytes actually read off the
 * wire, matching how the other ingesters report progress.
 */
async function* iterLinesGzip(
  response: Response,
  source: SourceRuntime,
  encoding: string = "utf-8",
): AsyncGenerator<string> {
  const nodeStream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  nodeStream.on("data", (chunk: Buffer) => {
    source.bytesDownloaded += chunk.byteLength;
    // Hash the *compressed* wire bytes, same as bytesDownloaded counts them.
    // Without this line the gzip-delivered sources — the biggest files this
    // project ingests — would digest as the hash of an empty stream, which
    // would read as "content identical" on every single run.
    source.hasher?.update(chunk);
  });
  const gunzip = createGunzip();
  // .pipe() does not forward 'error' events from source to destination, and
  // an unhandled 'error' event on an EventEmitter is fatal to the whole
  // Node process — not just this generator. A transient network failure
  // mid-download (proxy reset, mobile network hiccup, etc.) on nodeStream
  // must be forwarded into gunzip explicitly so it surfaces as a normal
  // thrown exception through the `for await` loop below, where the
  // existing try/catch in runSource can catch it like any other source
  // failure instead of crashing the server.
  nodeStream.on("error", (err) => gunzip.destroy(err));
  nodeStream.pipe(gunzip);
  const decoder = new TextDecoder(encoding);
  let buffer = "";
  for await (const chunk of gunzip) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

/**
 * RIPE RIS whois dump — Layer 1 (see bgp_origin_ranges schema comment).
 *
 * Lines are `<origin>\t<prefix>\t<seen-by-#rispeers>`, plus `%`-prefixed
 * comment/header lines to skip. `<origin>` is either a bare ASN or a MOAS
 * (multi-origin) set like `{8034,8035}` when RIS peers observed more than
 * one AS announcing the same prefix. BGP doesn't give us a principled way
 * to pick a single "correct" origin out of a MOAS set from this file alone,
 * so — same tradeoff the rest of this codebase makes (favor precision, degrade
 * gracefully) — we take the first-listed ASN and move on rather than
 * guessing further; MOAS prefixes are a small minority of the table.
 */
async function ingestRisWhoisDump(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  // Refresh: this source fully replaces its own prior rows every run.
  await db
    .delete(bgpOriginRangesTable)
    .where(eq(bgpOriginRangesTable.source, source.config.id));

  let batch: Array<typeof bgpOriginRangesTable.$inferInsert> = [];
  for await (const raw of iterLinesGzip(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("%")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    const originField = parts[0]!.trim();
    const prefix = parts[1]!.trim();
    const peerCount = Number(parts[2] ?? 0) || 0;

    let asn: number;
    if (originField.startsWith("{")) {
      const first = originField.slice(1, -1).split(",")[0];
      asn = Number(first);
    } else {
      asn = Number(originField);
    }
    if (!Number.isFinite(asn) || asn <= 0) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }

    // parseCidr auto-detects family per line, so the IPv4 and IPv6 dump
    // files (two different source URLs) both flow through the exact same
    // path — `network` is a native `inet` column, there's no separate v4/v6
    // branch to keep in sync anymore.
    if (!isUsableBgpOriginPrefix(prefix)) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }

    batch.push({ network: prefix, asn, peerCount, source: source.config.id });
    if (batch.length >= BATCH_SIZE) {
      await flushBgpOriginBatch(batch, source, job);
      batch = [];
    }
  }
  if (batch.length > 0) await flushBgpOriginBatch(batch, source, job);
}

/**
 * The prefix filter every BGP-origin source applies, so switching
 * `bgpOriginSource` changes where the data comes from, not what is kept.
 */
function isUsableBgpOriginPrefix(prefix: string): boolean {
  const parsed = parseCidr(prefix);
  if (!parsed) return false;
  // 0.0.0.0/0, ::/0 and similarly-huge default-route entries carry no
  // useful signal and would win every longest-prefix-match tie
  // incorrectly if ever queried before a real match — drop anything
  // wider than a reasonable per-family minimum.
  const minPrefix = parsed.family === 4 ? 8 : 16;
  if (parsed.prefixLen < minPrefix) return false;
  // IPv4-mapped "v6" announcements (::ffff:92.47.144.56/127 — real
  // example, leaked by AS9198's routers into the RIS dump) are junk that
  // can never match a query: a v4 lookup compares against family-4 rows
  // only, and no genuine v6 address sits inside ::ffff:0:0/96. Left in,
  // they inflate the announcing ASN's asn_profile counts.
  if (parsed.family === 6 && prefix.toLowerCase().startsWith("::ffff:")) return false;
  return true;
}

/**
 * Picks the newest complete RIB file in a RouteViews collector archive
 * (`<base>/YYYY.MM/RIBS/rib.YYYYMMDD.HHMM.bz2`).
 *
 * RouteViews writes a RIB every two hours and the directory listing shows a
 * file while it is still being written, so the newest entry can be partial.
 * Files younger than `RIB_MIN_AGE_MS` are passed over. A partial file that
 * slips through anyway does not get ingested: bzip2 and the MRT reader both
 * fail on a stream that ends mid-block/mid-record, and the source retries.
 *
 * The previous month is listed too, so a run in the first hours of a month
 * (when the new month's directory is empty or missing) still finds a file.
 */
const RIB_MIN_AGE_MS = 60 * 60 * 1000;
async function resolveLatestRouteViewsRib(base: string, label: string): Promise<{ url: string; takenAt: Date }> {
  const now = new Date();
  const months = [0, 1].map((back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const root = base.endsWith("/") ? base : `${base}/`;
  for (const month of months) {
    const dir = `${root}${month}/RIBS/`;
    const res = await fetchWithRetry(
      dir,
      { headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" } },
      { label: `${label}:${month}`, ...FETCH_RETRY },
    );
    if (!res.ok) {
      await res.body?.cancel();
      continue;
    }
    const html = await res.text();
    let best: { url: string; takenAt: Date } | null = null;
    for (const m of html.matchAll(/rib\.(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})\.bz2/g)) {
      const takenAt = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!));
      if (now.getTime() - takenAt.getTime() < RIB_MIN_AGE_MS) continue;
      if (!best || takenAt > best.takenAt) best = { url: `${dir}${m[0]}`, takenAt };
    }
    if (best) return best;
  }
  throw new Error(`RouteViews: no RIB file older than 1h found under ${root} for ${months.join(" or ")}`);
}

/**
 * RouteViews RIB snapshot → `bgp_origin_ranges`. The alternative to the RIS
 * whois dump selected by `bgpOriginSource: "routeviews"` (config.ts,
 * `docs/104`, `docs/106` B1/B2).
 *
 * RouteViews publishes raw MRT RIBs, not a prefix→origin text file, so this
 * reads the RIB itself (`mrt.ts`) and derives the same rows the RIS dump
 * provides: one row per (prefix, origin ASN), `peer_count` = distinct
 * RouteViews peers that saw that origin for that prefix. Same filter as
 * the RIS path (`isUsableBgpOriginPrefix`), same delete-own-rows-then-insert
 * refresh.
 *
 * One collector per family, the same choice CAIDA's long-running pfx2as
 * dataset makes: route-views2 for IPv4, route-views6 for IPv6. Measured
 * against the RIS dump on 2026-11-08 (`docs/106`, Phase 1 log): same best
 * origin on 99.90% (v4) / 99.97% (v6) of shared prefixes; of uniformly
 * random routed IPv4 addresses, 98.71% get the same answer from both.
 *
 * `peer_count` is NOT on the RIS scale: route-views2/6 have ~20 full-table
 * peers where RIS has ~440, so the number is only comparable within one
 * source. It still does its job in lookup tie-breaks (higher = more peers
 * agree), but anything showing it as an absolute number must say which
 * project measured it.
 *
 * `response` is the bootstrap fetch of the collector's archive root (the
 * registry URL); its body is discarded and the actual RIB URL is resolved
 * from the dated directory listing.
 */
async function ingestRouteViewsRib(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  await response.body?.cancel();
  const family = source.config.family;
  if (family !== 4 && family !== 6) {
    throw new Error(`RouteViews source "${source.config.id}" needs family 4 or 6 in its registry entry`);
  }
  const rib = await resolveLatestRouteViewsRib(source.config.url!, `enrichment:${source.config.id}`);
  logger.info({ url: rib.url, takenAt: rib.takenAt.toISOString() }, "routeviews: resolved RIB snapshot");

  const ribResponse = await fetchWithRetry(
    rib.url,
    { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } },
    { label: `enrichment:${source.config.id}:rib`, ...FETCH_RETRY },
  );
  if (!ribResponse.ok || !ribResponse.body) {
    throw new Error(`RouteViews RIB download failed: HTTP ${ribResponse.status} ${ribResponse.statusText} (${rib.url})`);
  }

  // Only after the RIB is known to be downloadable: deleting first would
  // leave this source's family empty for every failed attempt.
  await db
    .delete(bgpOriginRangesTable)
    .where(eq(bgpOriginRangesTable.source, source.config.id));

  const wire = Readable.fromWeb(
    ribResponse.body as unknown as import("node:stream/web").ReadableStream,
  );
  wire.on("data", (chunk: Buffer) => {
    source.bytesDownloaded += chunk.byteLength;
    source.hasher?.update(chunk);
  });
  // `unbzip2-stream` is a classic (pre-streams2) `through` stream: not
  // async-iterable, and its destroy() takes no error. So its output goes
  // through a PassThrough, and errors from both ends are forwarded into
  // that — same reason as iterLinesGzip: .pipe() does not forward errors,
  // and an unhandled 'error' would take the whole process down instead of
  // failing this source.
  const bunzip = unbzip2();
  const decompressed = new PassThrough();
  wire.on("error", (err) => decompressed.destroy(err));
  bunzip.on("error", (err: Error) =>
    decompressed.destroy(
      new Error(`bzip2 decompression failed — truncated or corrupt RIB download? (${err.message})`),
    ),
  );
  wire.pipe(bunzip).pipe(decompressed);

  const stats: MrtStats = { records: 0, ribRecords: 0, skippedRecords: 0, peerIndexTables: 0 };
  let ambiguousPrefixes = 0;
  let batch: Array<typeof bgpOriginRangesTable.$inferInsert> = [];
  try {
    for await (const p of iterMrtRibPrefixes(decompressed, stats)) {
      if (job.shouldStop) {
        source.status = "stopped";
        break;
      }
      if (p.family !== family || !isUsableBgpOriginPrefix(p.prefix) || p.origins.length === 0) {
        if (p.origins.length === 0) ambiguousPrefixes++;
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      for (const o of p.origins) {
        if (o.asn <= 0) continue;
        batch.push({ network: p.prefix, asn: o.asn, peerCount: o.peers, source: source.config.id });
      }
      if (batch.length >= BATCH_SIZE) {
        await flushBgpOriginBatch(batch, source, job);
        batch = [];
      }
    }
  } finally {
    wire.destroy();
    decompressed.destroy();
  }
  if (batch.length > 0) await flushBgpOriginBatch(batch, source, job);
  if (source.status !== "stopped" && stats.peerIndexTables === 0) {
    throw new Error("RouteViews RIB had no PEER_INDEX_TABLE — not a TABLE_DUMP_V2 RIB file");
  }
  logger.info(
    { sourceId: source.config.id, rib: rib.url, ...stats, prefixesWithNoSingleOrigin: ambiguousPrefixes },
    "routeviews: RIB ingested",
  );
}

async function flushBgpOriginBatch(
  rows: Array<typeof bgpOriginRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      // Count what Postgres actually inserted, not what was offered. The
      // difference is rows ON CONFLICT dropped, and reporting those as
      // ingested is how a run that lost 98% of its rows once read as a
      // clean success (see the unique index's comment in bgpOriginRanges.ts).
      const result = await db.insert(bgpOriginRangesTable).values(slice).onConflictDoNothing();
      const inserted = (result as { rowCount?: number | null }).rowCount ?? slice.length;
      source.recordsIngested += inserted;
      job.totalIngested += inserted;
      source.recordsSkipped += slice.length - inserted;
      source.conflictDropped += slice.length - inserted;
      job.totalSkipped += slice.length - inserted;
    } catch (err) {
      logger.warn({ err }, "bgp-origin batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

/** Splits a DB-IP Lite CSV line, stripping the double quotes RFC4180 wraps
 * around fields like city names — this feed never puts a comma inside a
 * quoted field in practice, so a full CSV parser would be solving a problem
 * this data doesn't actually have (same call the geofeed parsers above
 * already make with a plain `line.split(",")`). */
function parseDbIpCsvLine(line: string): string[] {
  return line.split(",").map((f) => {
    const t = f.trim();
    return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  });
}

/**
 * DB-IP Lite (IP-to-City Lite CSV) — a computed, third-party geolocation
 * guess, not an operator's own published data. Populates
 * `dbip_lite_ranges`, a fallback tier `ip-intel.ts` only consults when no
 * real geofeed covers a prefix — see that table's schema comment and
 * SOURCES.md's "Planned — DB-IP Lite" entry for the full reasoning and the
 * license check (CC BY 4.0, attribution required, confirmed to explicitly
 * allow redistribution/commercial use unlike IP2Location LITE).
 *
 * `source.config.url` (the registry entry) only points at DB-IP's Lite
 * landing page — it exists so the generic fetch-then-dispatch step above
 * has something that resolves. The real file lives at a month-stamped URL
 * that changes every month (`dbip-city-lite-YYYY-MM.csv.gz`), so it's
 * fetched here directly instead, trying the current UTC month first and
 * falling back one month if that 404s (the new month's file isn't always
 * live in the first day or two) — same "resolve the real link ourselves"
 * shape as `ingestAzureServiceTags` above, just computed instead of scraped.
 *
 * **IPv4 only.** DB-IP mixes IPv4 and IPv6 ranges in the same two plain-
 * address columns with no family marker of its own; this project's only
 * range-to-CIDR splitter (`rangeToCidrs`, reused from the RIR delegated-
 * stats parser) is 32-bit-int based. An IPv6 splitter needing BigInt
 * arithmetic throughout is a separate piece of work, not a mechanical
 * follow-on — the exact same call `ipv4CidrToRange`'s own header comment
 * already makes for a different sweep-line algorithm. IPv6 lines are
 * skipped, not guessed at.
 */
async function ingestDbIpLiteCsv(
  job: ActiveJob,
  source: SourceRuntime,
  _bootstrapResponse: Response,
): Promise<void> {
  // Read once, not per line: the file has millions of rows and the config is
  // a file read. Also means a mid-run config edit cannot change behaviour
  // halfway through, which would leave the table half one shape half another.
  const wantIpv6 = loadCollectorConfig().dbipLiteIpv6;
  logger.info(
    { ipv6: wantIpv6 },
    wantIpv6
      ? "dbip-lite: IPv6 enabled (dbipLiteIpv6) — expect roughly 2x the rows of an IPv4-only run"
      : "dbip-lite: IPv4 only (dbipLiteIpv6 is off) — IPv6 rows will be counted as skipped",
  );
  const now = new Date();
  const candidateMonths = [0, 1].map((monthsBack) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });

  let gzResponse: Response | undefined;
  let resolvedUrl = "";
  for (const yearMonth of candidateMonths) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${yearMonth}.csv.gz`;
    const attempt = await fetchWithRetry(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } },
      { label: `enrichment:${source.config.id}:${yearMonth}`, ...FETCH_RETRY },
    );
    if (attempt.ok && attempt.body) {
      gzResponse = attempt;
      resolvedUrl = url;
      break;
    }
  }
  if (!gzResponse) {
    throw new Error(
      `DB-IP Lite: no downloadable file found for ${candidateMonths.join(" or ")} — check download.db-ip.com's current filename pattern.`,
    );
  }
  logger.info({ url: resolvedUrl }, "dbip-lite: resolved this month's download URL");

  let batch: Array<typeof dbipLiteRangesTable.$inferInsert> = [];
  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    await flushDbIpLiteBatch(batch, source, job);
    batch = [];
  };

  // ─── COPY fast path (`bulkCopyIngest`) — begin ──────────────────────────
  //
  // Everything this feature adds to this function lives between these two
  // markers. That is on purpose: the first draft scattered `if (copyWriter)`
  // checks through the loop and the tail, and applying this file's own
  // documented removal steps to a scratch copy then failed to typecheck —
  // the instructions had named three edit sites where there were eight.
  // Removing the feature now means deleting this block and restoring the two
  // lines it names at the bottom.
  //
  // TRUNCATE rather than DELETE: an unqualified DELETE of 14.7M rows writes a
  // WAL record per row and leaves every one behind as a dead tuple, so the
  // table settles at roughly twice the size of the data it holds — measured
  // on the real deployment at 2,512 MB for rows needing about 1,000 MB. Not
  // merely wasted disk, since `ip_intel`'s base UNION scans this heap, so the
  // bloat was paid again on every flatten. See `docs/100-bulk-copy-ingest.md`.
  const useCopy = loadCollectorConfig().bulkCopyIngest;
  if (useCopy) {
    await db.execute(sql.raw(`TRUNCATE TABLE dbip_lite_ranges`));
  } else {
    await db.delete(dbipLiteRangesTable);
  }
  // Strictly after the clear above: an open COPY holds a lock the TRUNCATE
  // would then wait on forever. Null (falling back to batched INSERTs) when
  // the pool is too small to spare a connection for the whole load.
  const copyWriter = useCopy
    ? await openBulkRowWriter("dbip_lite_ranges", [
        "network",
        "country",
        "region",
        "city",
        "latitude",
        "longitude",
      ])
    : null;
  // The progress row only exists so `ip-insight enrich` can print a moving
  // counter, so it does not need to be accurate to the row. The old path
  // wrote it once per 2,000-row batch — ~7,350 extra round trips, measured at
  // a third of the entire load's cost. Time-based, so the cadence is the same
  // on a machine doing 20k rows/sec and one doing 200k.
  const PROGRESS_INTERVAL_MS = 2_000;
  let lastProgressAt = 0;

  /** The one row sink the loop below writes through. */
  const pushRow = copyWriter
    ? async (r: typeof dbipLiteRangesTable.$inferInsert): Promise<void> => {
        await copyWriter.push([r.network, r.country, r.region, r.city, r.latitude, r.longitude]);
        source.recordsIngested++;
        job.totalIngested++;
        if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          lastProgressAt = Date.now();
          await persistSource(source);
        }
      }
    : async (r: typeof dbipLiteRangesTable.$inferInsert): Promise<void> => {
        batch.push(r);
        if (batch.length >= BATCH_SIZE) await flushBatch();
      };

  /** All-or-nothing on the COPY path, unlike the batched one, which absorbed
   * a rejected batch as `recordsSkipped` and carried on. Deliberate: every
   * value in this stream is generated by this file (CIDRs from
   * `rangeToCidrs`/`rangeToCidrs6`, coordinates already `Number.isFinite`-
   * filtered), so a rejection means a bug in that generation rather than bad
   * upstream data — and quietly dropping 2,000 rows in response to a bug is
   * worse than failing loudly. `runSourceWithRetry` still retries the whole
   * source, and the table is left empty either way, exactly as a mid-run
   * crash on the old path also left it. */
  const finishRows = copyWriter
    ? async (): Promise<void> => {
        await copyWriter.finish();
        await persistSource(source);
      }
    : flushBatch;

  /** Returns the pooled connection the COPY was holding. Without it a failed
   * run leaks one connection per attempt, and `sourceRetryMaxAttempts` means
   * there can be three. */
  const abortRows = async (): Promise<void> => {
    await copyWriter?.abort();
  };
  //
  // To remove: delete from the "begin" marker to here, and put back the two
  // lines this replaced —
  //     await db.delete(dbipLiteRangesTable);
  //     const pushRow = async (r) => { batch.push(r); if (batch.length >= BATCH_SIZE) await flushBatch(); };
  // with `finishRows = flushBatch` and `abortRows` dropped from the tail.
  //
  // ─── COPY fast path — end ──────────────────────────────────────────────

  try {
    for await (const raw of iterLinesGzip(gzResponse, source)) {
      if (job.shouldStop) {
        source.status = "stopped";
        break;
      }
      const line = raw.trim();
      if (!line) continue;
      const fields = parseDbIpCsvLine(line);
      if (fields.length < 8) {
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      const [ipStart, ipEnd, , country, region, city, latStr, lonStr] = fields as string[];
      const family = isIpAddress(ipStart!);
      if (family === 0 || isIpAddress(ipEnd!) !== family) {
        // Malformed, or a start/end pair that disagree about family.
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      if (family === 6 && !wantIpv6) {
        // IPv6 present in the file but not wanted — see `dbipLiteIpv6` in
        // config.ts for the measured cost this default avoids. Counted as
        // skipped, exactly as before this branch existed, so a run with the
        // flag off is indistinguishable from one built without the feature.
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      let cidrs: string[];
      try {
        if (family === 6) {
          const start = parseIpv6(ipStart!);
          const end = parseIpv6(ipEnd!);
          // rangeToCidrs6 returns [] for an inverted or out-of-range pair
          // rather than throwing; treat that the same as a parse failure.
          cidrs = start === null || end === null ? [] : rangeToCidrs6(start, end);
          if (cidrs.length === 0) throw new Error("unusable IPv6 range");
        } else {
          const start = ipv4ToInt(ipStart!);
          const end = ipv4ToInt(ipEnd!);
          if (end < start) throw new Error("range end before start");
          cidrs = rangeToCidrs(start, end - start + 1);
        }
      } catch {
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      const latitude = latStr ? Number(latStr) : null;
      const longitude = lonStr ? Number(lonStr) : null;
      const lat = Number.isFinite(latitude) ? latitude : null;
      const lon = Number.isFinite(longitude) ? longitude : null;
      for (const cidr of cidrs) {
        await pushRow({
          network: cidr,
          country: country || null,
          region: region || null,
          city: city || null,
          latitude: lat,
          longitude: lon,
        });
      }
    }
    await finishRows();
  } catch (err) {
    await abortRows();
    throw err;
  }

  // Prune anything already covered by a real geofeed. `ip-intel.ts`'s LATERAL
  // join already refuses to let a dbip row outrank a geofeed one at read
  // time (`AND gf.network IS NULL`), so those rows were never going to
  // answer anything — but until this DELETE they still sat in `ip_intel`'s
  // base UNION as dead weight, inflating the materialize/history-capture
  // cost by exactly as many rows as this removes. Real numbers from the
  // first full run before this existed: 6.25M rows ingested, `ip_intel`'s
  // tracked prefix count went from ~3.2M to ~8.77M, and a `history capture`
  // afterward took long enough to be the actual complaint that led here.
  // Kept as a real DELETE against the real table, not a smarter WHERE
  // clause on ingest, because a geofeed can arrive or change after this
  // source last ran — pruning at read of the *current* geofeed_ranges is
  // the only version that can't go stale between the two sources' own
  // refresh schedules.
  try {
    const before = source.recordsIngested;
    const deleted = await pruneDbIpCoveredByGeofeeds();
    source.recordsIngested = before - deleted;
    job.totalIngested -= deleted;
    logger.info(
      { deleted, kept: source.recordsIngested },
      "dbip-lite: pruned rows already covered by a real geofeed",
    );
  } catch (err) {
    // Not fatal to the run — worst case is the pre-pruning row count and
    // its ip_intel cost, not wrong data (the read-time guard in
    // ip-intel.ts still holds regardless of whether this DELETE ran).
    logger.warn({ err }, "dbip-lite: geofeed-overlap pruning failed, rows kept unpruned");
  }
}

async function flushDbIpLiteBatch(
  rows: Array<typeof dbipLiteRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(dbipLiteRangesTable).values(slice);
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "dbip-lite batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

/**
 * DigitalOcean (and, sharing this same parser, Linode — see its entry in
 * enrichment-sources.ts) publishes its own datacenter ranges in exactly the
 * RFC 8805 geofeed CSV shape (`prefix,country,region,city,postal`), so one
 * file feeds two tables: cloud_ranges (Layer 4 — this is a datacenter) and
 * geofeed_ranges (Layer 2 — precise facility city, operator-published).
 * `source.config.provider` is what tells this generic function which
 * provider's rows it's replacing on each run.
 */
/**
 * A published geofeed line claiming a prefix this wide isn't real —
 * legitimate geo-location entries describe one operator's specific site or
 * PoP, not a meaningful fraction of the whole address space. Same floor as
 * `bgp_origin_ranges`' default-route guard elsewhere in this file, reused
 * rather than invented fresh.
 *
 * Found needed 2026-08-09 against real data: a single line in NTT's
 * (AS2914) own published geofeed parsed as `206.163.25.0/2` — syntactically
 * a valid CIDR, so `parseCidr` alone let it through — and, because
 * `ip_intel.country` is `COALESCE(geofeed, RIR country)`, silently
 * overrode the correct country for roughly a quarter of all IPv4
 * addresses (every address whose first two bits match, RIPE NCC's own
 * 193.0.0.0/21 included) to whatever that one bad line said. Direct-URL
 * geofeeds like this one carry none of the RDAP-discovery path's own
 * containment check (a publisher's file is trusted wholesale, not
 * verified per-line against what RDAP says they actually hold), so this is
 * the only defense against exactly this failure mode.
 */
function isGeofeedPrefixTooWide(parsed: { family: 4 | 6; prefixLen: number }): boolean {
  return parsed.prefixLen < (parsed.family === 4 ? 8 : 16);
}

async function ingestDigitalOceanGeofeedCsv(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const provider = source.config.provider ?? "digitalocean";
  const confidence = source.config.confidence ?? 0.8;

  await db.delete(cloudRangesTable).where(eq(cloudRangesTable.provider, provider));

  const cloudBatch: Array<typeof cloudRangesTable.$inferInsert> = [];
  const geofeedBatch: Array<typeof geofeedRangesTable.$inferInsert> = [];

  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [prefix, country, region, city, postal] = line.split(",");
    const parsedPrefix = prefix ? parseCidr(prefix) : null;
    if (!parsedPrefix || isGeofeedPrefixTooWide(parsedPrefix)) {
      source.recordsSkipped++;
      continue;
    }
    cloudBatch.push({
      network: prefix,
      provider,
      service: null,
      region: geofeedField(region),
    });
    geofeedBatch.push({
      network: prefix,
      country: geofeedCountry(country),
      region: geofeedField(region),
      city: geofeedField(city),
      postal: geofeedField(postal),
      sourceId: source.config.id,
      confidence,
    });
  }
  await flushCloudBatches(cloudBatch, source, job);
  await replaceGeofeedRows(source.config.id, geofeedBatch, source, job);
}

/**
 * Generic RFC 8805 geofeed CSV ingestion for network operators that publish
 * their own feed at a fixed, directly-known URL (Google, NTT, Cogent,
 * Verizon, T-Mobile, Netflix, Vultr/Constant, Civo, Schwarz IT, Telia — see
 * SOURCES.md). Unlike DigitalOcean's variant above, these are general
 * network operators, not cloud/hosting providers, so this only populates
 * geofeed_ranges (Layer 2) — it does not also mark the space as
 * datacenter/cloud in cloud_ranges (Layer 4).
 */
async function ingestRfc8805GeofeedCsv(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const confidence = source.config.confidence ?? 0.85;

  const geofeedBatch: Array<typeof geofeedRangesTable.$inferInsert> = [];

  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [prefix, country, region, city, postal] = line.split(",");
    const parsedPrefix = prefix ? parseCidr(prefix) : null;
    if (!parsedPrefix || isGeofeedPrefixTooWide(parsedPrefix)) {
      source.recordsSkipped++;
      continue;
    }
    geofeedBatch.push({
      network: prefix,
      country: geofeedCountry(country),
      region: geofeedField(region),
      city: geofeedField(city),
      postal: geofeedField(postal),
      sourceId: source.config.id,
      confidence,
    });
  }
  await replaceGeofeedRows(source.config.id, geofeedBatch, source, job);
}

/**
 * Every verified-bot feed found (Google's three, Bing, Apple, OpenAI's
 * three, Perplexity, Ahrefs) publishes the same JSON Google defined:
 * `{"prefixes":[{"ipv4Prefix":"..."}|{"ipv6Prefix":"..."}]}`. One parser
 * therefore serves all of them, and a new operator adopting the convention
 * costs a registry URL and a source entry, no code.
 *
 * `provider` carries the crawler token, `source` the operator name — the
 * two levels a caller might match on (see verifiedBotRanges.ts).
 */
async function ingestBotPrefixesJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const bot = source.config.provider ?? source.config.id;
  const operator = source.config.source ?? "unknown";
  const text = await readAllText(response, source);

  let parsed: { prefixes?: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse ${source.config.id} JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed.prefixes)) {
    throw new Error(
      `${source.config.id}: expected a "prefixes" array — the operator may have changed the format.`,
    );
  }

  // Scoped to this bot, not the whole table: operators publish independently
  // and one feed being reachable says nothing about the others.
  await db.delete(verifiedBotRangesTable).where(eq(verifiedBotRangesTable.bot, bot));

  const batch: Array<typeof verifiedBotRangesTable.$inferInsert> = [];
  for (const entry of parsed.prefixes) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const cidr = entry.ipv4Prefix ?? entry.ipv6Prefix;
    if (!cidr || !parseCidr(cidr)) {
      source.recordsSkipped++;
      continue;
    }
    batch.push({ network: cidr, bot, operator, sourceId: source.config.id });
  }

  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const slice = batch.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(verifiedBotRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err, bot }, "verified-bot batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

/**
 * A publisher's feed can come back HTTP 200 while carrying far less data
 * than usual — not a network failure `runSourceWithRetry` would catch (the
 * fetch *succeeded*), just a degraded or temporarily-truncated file on the
 * publisher's own side. Left unguarded, that's a real replacement of good
 * rows with bad ones: `ip_intel.country` reads `COALESCE(geofeed, RIR
 * country)`, so a geofeed row disappearing for one run silently falls back
 * to the RIR's (coarser, often wrong-for-multinational-operators) country —
 * and once history capture is running, that reads as "this prefix's
 * country changed", a false signal with no real-world event behind it.
 *
 * Compares the new row count against what this source already has before
 * committing anything. Below `GEOFEED_MIN_RATIO` of the previous count (and
 * only once there *was* a previous count — a source's first-ever run has
 * nothing to compare against), the whole replacement is skipped: old rows
 * stay exactly as they were, nothing is deleted, nothing is inserted. This
 * is a floor against a collapse, not a smoothing function — a source that
 * genuinely shrinks by 20% between runs still updates normally.
 *
 * `ingestion-health.ts` already catches a source landing near *zero* — this
 * catches a source landing far below its *own* recent size, which a fixed
 * floor tuned across every source can't (a shared floor low enough to allow
 * Verizon's real row count would also allow T-Mobile's feed to silently
 * collapse to a tenth of itself and still pass).
 */
const GEOFEED_MIN_RATIO = 0.5;

async function replaceGeofeedRows(
  sourceId: string,
  rows: Array<typeof geofeedRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(geofeedRangesTable)
    .where(eq(geofeedRangesTable.sourceId, sourceId));
  const previousCount = existing?.count ?? 0;

  if (previousCount > 0 && rows.length < previousCount * GEOFEED_MIN_RATIO) {
    logger.warn(
      { sourceId, previousCount, newCount: rows.length, minRatio: GEOFEED_MIN_RATIO },
      `Geofeed source "${sourceId}" returned ${rows.length} rows, down from ${previousCount} ` +
        "— below the collapse floor, so this run's data was NOT applied. Existing rows are " +
        "unchanged. If this source genuinely shrank, it stays stale until a run above the floor lands.",
    );
    source.status = "failed";
    source.errorMessage = `Row count collapsed: ${rows.length} vs previous ${previousCount} (floor ${GEOFEED_MIN_RATIO})`;
    return;
  }

  await db.delete(geofeedRangesTable).where(eq(geofeedRangesTable.sourceId, sourceId));
  await flushGeofeedBatches(rows, source, job);
}

async function flushGeofeedBatches(
  rows: Array<typeof geofeedRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(geofeedRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "geofeed batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

/**
 * LACNIC's bulk whois dump has a real, structured `city:` field directly on
 * inetnum/inet6num (IP block) records — no free-text parsing needed, unlike
 * every other RIR. Two format quirks handled here:
 *
 *  1. Encoding: the dump is ISO-8859-1 (Latin-1), not UTF-8 — verified
 *     against the real file (a "São Paulo" record decodes as garbage
 *     replacement characters under UTF-8). Decoding it correctly matters
 *     for matching against GeoNames afterward.
 *  2. Legacy short CIDR notation: older records write e.g. "2.152.0/22"
 *     instead of "2.152.0.0/22" (trailing zero octets omitted). Padded
 *     back out before validating/storing.
 */
async function ingestLacnicWhoisCity(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  await db
    .delete(geofeedRangesTable)
    .where(eq(geofeedRangesTable.sourceId, source.config.id));

  const confidence = source.config.confidence ?? 0.75;
  // Cache geocode lookups within this run — the same "city, country" pair
  // (e.g. "Santo Domingo, DO") repeats across thousands of records, and
  // each lookup is a DB round trip.
  const geocodeCache = new Map<string, Awaited<ReturnType<typeof geocodeCityName>>>();

  async function cachedGeocode(city: string, country: string) {
    const key = `${country}|${city.toLowerCase()}`;
    const cached = geocodeCache.get(key);
    if (cached !== undefined) return cached;
    const result = await geocodeCityName(city, country);
    geocodeCache.set(key, result);
    return result;
  }

  let fields = new Map<string, string>();
  let batch: Array<typeof geofeedRangesTable.$inferInsert> = [];

  async function flushRecord(): Promise<void> {
    const raw = fields.get("inetnum") ?? fields.get("inet6num");
    const country = fields.get("country");
    const city = fields.get("city");
    fields = new Map();
    if (!raw || !country) return;

    let cidr: string;
    const isV4 = raw.includes(".") && !raw.includes(":");
    if (isV4) {
      const slash = raw.indexOf("/");
      if (slash === -1) {
        source.recordsSkipped++;
        return;
      }
      const segments = raw.slice(0, slash).split(".");
      while (segments.length < 4) segments.push("0");
      if (segments.length !== 4) {
        source.recordsSkipped++;
        return;
      }
      cidr = `${segments.join(".")}${raw.slice(slash)}`;
    } else {
      cidr = raw;
    }
    if (!parseCidr(cidr)) {
      source.recordsSkipped++;
      return;
    }

    let geo: Awaited<ReturnType<typeof geocodeCityName>> = null;
    if (city && city.trim()) {
      geo = await cachedGeocode(city, country);
    }

    batch.push({
      network: cidr,
      country,
      city: city || null,
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      admin1: geo?.admin1 ?? null,
      admin2: geo?.admin2 ?? null,
      sourceId: source.config.id,
      confidence,
    });
    if (batch.length >= BATCH_SIZE) {
      await flushGeofeedBatches(batch, source, job);
      batch = [];
    }
  }

  for await (const raw of iterLinesGzip(response, source, "iso-8859-1")) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line) {
      await flushRecord();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (value) fields.set(key, value);
  }
  await flushRecord();
  if (batch.length > 0) await flushGeofeedBatches(batch, source, job);
}

/**
 * GeoNames city gazetteer (see lib/geocode.ts for why this exists). One ZIP
 * entry, tab-delimited, upserted by geonameId so re-runs pick up population/
 * name corrections rather than accumulating duplicates.
 */
async function ingestGeonamesCitiesZip(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const bytes = await readAllBytes(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  const { content } = await extractSingleEntryZip(bytes);
  const text = content.toString("utf-8");

  let batch: Array<typeof geonamesPlacesTable.$inferInsert> = [];
  for (const raw of text.split("\n")) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split("\t");
    const geonameId = Number(cols[0]);
    const name = cols[1];
    const asciiName = cols[2];
    const latitude = Number(cols[4]);
    const longitude = Number(cols[5]);
    const countryCode = cols[8];
    const admin1Code = cols[10] || null;
    const admin2Code = cols[11] || null;
    const population = Number(cols[14]) || 0;
    const timezone = cols[17] || null;

    if (
      !Number.isFinite(geonameId) ||
      !name ||
      !asciiName ||
      !countryCode ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      source.recordsSkipped++;
      continue;
    }

    batch.push({
      geonameId,
      name,
      asciiName,
      countryCode,
      admin1Code,
      admin2Code,
      latitude,
      longitude,
      population,
      timezone,
    });
    if (batch.length >= BATCH_SIZE) {
      await flushGeonamesBatch(batch, source, job);
      batch = [];
    }
  }
  if (batch.length > 0) await flushGeonamesBatch(batch, source, job);
}

async function flushGeonamesBatch(
  rows: Array<typeof geonamesPlacesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db
        .insert(geonamesPlacesTable)
        .values(slice)
        .onConflictDoUpdate({
          target: geonamesPlacesTable.geonameId,
          set: {
            name: sql`excluded.name`,
            asciiName: sql`excluded.ascii_name`,
            countryCode: sql`excluded.country_code`,
            admin1Code: sql`excluded.admin1_code`,
            admin2Code: sql`excluded.admin2_code`,
            latitude: sql`excluded.latitude`,
            longitude: sql`excluded.longitude`,
            population: sql`excluded.population`,
            timezone: sql`excluded.timezone`,
            ingestedAt: sql`now()`,
          },
        });
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "geonames batch upsert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

async function ingestAwsJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const text = await readAllText(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  let parsed: {
    prefixes?: Array<{
      ip_prefix: string;
      region?: string;
      service?: string;
    }>;
    ipv6_prefixes?: Array<{
      ipv6_prefix: string;
      region?: string;
      service?: string;
    }>;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse AWS JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Refresh: clear all aws rows, then re-insert.
  await db
    .delete(cloudRangesTable)
    .where(eq(cloudRangesTable.provider, "aws"));

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const p of parsed.prefixes ?? []) {
    if (!parseCidr(p.ip_prefix)) {
      source.recordsSkipped++;
      continue;
    }
    all.push({
      network: p.ip_prefix,
      provider: "aws",
      service: p.service ?? null,
      region: p.region ?? null,
    });
  }
  for (const p of parsed.ipv6_prefixes ?? []) {
    if (!parseCidr(p.ipv6_prefix)) {
      source.recordsSkipped++;
      continue;
    }
    all.push({
      network: p.ipv6_prefix,
      provider: "aws",
      service: p.service ?? null,
      region: p.region ?? null,
    });
  }
  await flushCloudBatches(all, source, job);
}

async function ingestGcpJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const text = await readAllText(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  let parsed: {
    prefixes?: Array<{
      ipv4Prefix?: string;
      ipv6Prefix?: string;
      service?: string;
      scope?: string;
    }>;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse GCP JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await db
    .delete(cloudRangesTable)
    .where(eq(cloudRangesTable.provider, "gcp"));

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const p of parsed.prefixes ?? []) {
    if (p.ipv4Prefix) {
      if (!parseCidr(p.ipv4Prefix)) {
        source.recordsSkipped++;
        continue;
      }
      all.push({
        network: p.ipv4Prefix,
        provider: "gcp",
        service: p.service ?? null,
        region: p.scope ?? null,
      });
    } else if (p.ipv6Prefix) {
      if (!parseCidr(p.ipv6Prefix)) {
        source.recordsSkipped++;
        continue;
      }
      all.push({
        network: p.ipv6Prefix,
        provider: "gcp",
        service: p.service ?? null,
        region: p.scope ?? null,
      });
    }
  }
  await flushCloudBatches(all, source, job);
}

async function ingestCloudflareText(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const family = source.config.family ?? 4;
  // Refresh: only delete cloudflare rows of this family — cloudflare-v4 and
  // cloudflare-v6 are separate sources/URLs sharing one table, so a v4 run
  // must not touch the v6 rows the other source owns. `family(network)` is
  // Postgres's own accessor on the `inet` value; nothing to store ourselves.
  await db
    .delete(cloudRangesTable)
    .where(
      sql`${cloudRangesTable.provider} = 'cloudflare' AND family(${cloudRangesTable.network}) = ${family}`,
    );

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!parseCidr(line)) {
      source.recordsSkipped++;
      continue;
    }
    all.push({
      network: line,
      provider: "cloudflare",
      service: "edge",
      region: null,
    });
  }
  await flushCloudBatches(all, source, job);
}

/**
 * Bunny.net's edge-server list: `["89.187.188.227", "2400:52e0:...", ...]` —
 * bare host addresses, not CIDR blocks, unlike every other cloud source in
 * this file. `parseCidr()` requires a "/" and returns null for a bare
 * address, so it can't be reused as the validity gate here (it would
 * silently skip every single entry, a real trap found by fetching this feed
 * directly rather than assuming it matched the AWS/GCP/Cloudflare shape).
 * Validated with `isIP()` instead, then stored as the address's own /32 or
 * /128 — the natural CIDR representation of a single host, and the same
 * `network` column every other cloud-range row already uses, so nothing
 * downstream needs to know this source is host-granular rather than
 * block-granular.
 */
async function ingestBunnyCdnJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const family = source.config.family ?? 4;
  const text = await readAllText(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse Bunny CDN JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${source.config.id}: expected a JSON array of addresses — the operator may have changed the format.`,
    );
  }

  // Same family-scoped delete as cloudflare-text above: bunny-cdn-v4 and
  // bunny-cdn-v6 are separate sources/URLs sharing this table.
  await db
    .delete(cloudRangesTable)
    .where(
      sql`${cloudRangesTable.provider} = 'bunny' AND family(${cloudRangesTable.network}) = ${family}`,
    );

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") {
      source.recordsSkipped++;
      continue;
    }
    const detected = isIP(entry);
    if (detected === 0 || detected !== family) {
      source.recordsSkipped++;
      continue;
    }
    all.push({
      network: `${entry}/${family === 4 ? 32 : 128}`,
      provider: "bunny",
      service: "edge",
      region: null,
    });
  }
  await flushCloudBatches(all, source, job);
}

async function ingestOracleJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const text = await readAllText(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  let parsed: {
    regions?: Array<{ region: string; cidrs: Array<{ cidr: string; tags?: string[] }> }>;
  };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse Oracle Cloud JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.delete(cloudRangesTable).where(eq(cloudRangesTable.provider, "oracle"));

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const r of parsed.regions ?? []) {
    for (const c of r.cidrs ?? []) {
      if (!parseCidr(c.cidr)) {
        source.recordsSkipped++;
        continue;
      }
      all.push({ network: c.cidr, provider: "oracle", service: c.tags?.[0] ?? null, region: r.region });
    }
  }
  await flushCloudBatches(all, source, job);
}

async function ingestFastlyJson(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const text = await readAllText(response, source);
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }
  let parsed: { addresses?: string[]; ipv6_addresses?: string[] };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse Fastly JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.delete(cloudRangesTable).where(eq(cloudRangesTable.provider, "fastly"));

  const all: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const cidr of [...(parsed.addresses ?? []), ...(parsed.ipv6_addresses ?? [])]) {
    if (!parseCidr(cidr)) {
      source.recordsSkipped++;
      continue;
    }
    all.push({ network: cidr, provider: "fastly", service: "edge", region: null });
  }
  await flushCloudBatches(all, source, job);
}

/**
 * Minimal CSV line splitter for IANA's special-purpose registries — the
 * only source in this file that actually needs CSV (not just delimiter-
 * split) parsing: fields like the RFC column embed commas inside quotes
 * (`"[RFC791], Section 3.2"`), and some names are double-quoted in the
 * source data itself (`"""This network"""`, i.e. the literal value
 * `"This network"` CSV-escaped). Doesn't handle newlines inside quoted
 * fields — not needed here, IANA's registry is one record per line.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * IANA IPv4/IPv6 special-purpose address registry — small, static CSV:
 * "Address Block,Name,RFC,Allocation Date,Termination Date,Source,
 * Destination,Forwardable,Globally Reachable,Reserved-by-Protocol".
 */
async function ingestIanaSpecialCsv(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const family = source.config.family ?? 4;
  await db
    .delete(specialPurposeRangesTable)
    .where(sql`family(${specialPurposeRangesTable.network}) = ${family}`);

  const all: Array<typeof specialPurposeRangesTable.$inferInsert> = [];
  let isHeader = true;
  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line) continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const cols = parseCsvLine(line);
    const network = cols[0]?.trim();
    const name = cols[1]?.trim();
    const rfc = cols[2]?.trim() || null;
    const forwardable = cols[7]?.trim();
    const globallyReachable = cols[8]?.trim();
    const reservedByProtocol = cols[9]?.trim();
    if (!network || !name || !parseCidr(network)) {
      source.recordsSkipped++;
      continue;
    }
    all.push({
      network,
      name,
      rfc,
      isForwardable: forwardable === "True" ? true : forwardable === "False" ? false : null,
      isGloballyReachable:
        globallyReachable === "True" ? true : globallyReachable === "False" ? false : null,
      isReservedByProtocol:
        reservedByProtocol === "True" ? true : reservedByProtocol === "False" ? false : null,
    });
  }
  await flushSpecialPurposeBatches(all, source, job);
}

/**
 * ASN reach metrics — the one "source" here that downloads nothing.
 *
 * Everything it needs is already in `bgp_origin_ranges` (the RIS whois
 * dumps), so this is a single server-side aggregation rather than a fetch +
 * parse + batch-insert loop: Postgres groups ~1.5M route rows by origin ASN,
 * sums announced IPv4 space, counts prefixes, takes the best peer_count, and
 * dense-ranks the result — measured at ~1.2s end to end, so there is no
 * value in batching or progress-reporting it in slices.
 *
 * Full refresh each run (delete-then-insert) like the cloud/threat sources:
 * an ASN that stopped announcing anything should disappear from the table,
 * not linger with last week's numbers.
 *
 * See asn_reach's schema comment for what these numbers do and do not mean —
 * in short, announced-footprint size, not transit-hierarchy centrality.
 */
/**
 * Roll the flagged-address tables up to the block around each address: /24
 * for IPv4, /48 for IPv6.
 *
 * `set_masklen(network::cidr, 24)` truncates an address to its enclosing
 * block, so grouping by it gives one row per block that contains anything —
 * and only those. Entries wider than the block (a threat listing on a /20)
 * would truncate *up* rather than fan out across the /24s they cover, which
 * would attribute them to a single block and undercount the rest; they are
 * therefore restricted to entries at least as specific as the block itself.
 * The alternative — expanding a /20 into 16 rows — is possible but would
 * turn one listing into sixteen "flagged neighbours" and overstate exactly
 * the concentration this is meant to measure.
 */
/**
 * Per-ASN composition, computed from the tables this database already holds.
 *
 * Counted in prefixes rather than addresses throughout — see asn_profile's
 * schema comment for why. The RPKI buckets follow exactly the definition
 * `ip_intel` uses, and share its trap: an ASN whose prefixes no ROA covers
 * is *unsigned*, which is the normal state of most of the internet, not
 * invalid. Conflating the two would report the majority of every network as
 * broken.
 */
async function computeAsnProfile(job: ActiveJob, source: SourceRuntime): Promise<void> {
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }

  // Every CTE below is driven from the *smallest* table in its join.
  // The first draft asked the question the other way round — for each of
  // 1.5M announced prefixes, probe cloud/bot/anonymity/ip_blocks — which is
  // ~9M GiST lookups and did not finish in ten minutes. Driving from
  // anonymity_ranges (2.5k rows) or cloud_ranges (61k) instead answers the
  // identical question in thousands of probes. Only the RPKI classification
  // genuinely has to visit every prefix, because that is what it is: a
  // per-prefix fact.
  //
  // Delete + rebuild in one transaction: without it, a crash between the
  // delete and the insert (a killed process, an OOM) leaves this table
  // empty until the next successful run instead of just stale.
  const result = await db.transaction(async (tx) => {
    await tx.delete(asnProfileTable);
    return tx.execute<{ inserted: number }>(sql`
    WITH prefix_rpki AS (
      SELECT
        b.asn,
        CASE
          WHEN NOT r.covering THEN 'unsigned'
          WHEN r.authorized  THEN 'valid'
          ELSE 'invalid'
        END AS rpki
      FROM bgp_origin_ranges b
      LEFT JOIN LATERAL (
        SELECT count(*) > 0 AS covering,
               bool_or(x.asn = b.asn AND masklen(b.network) <= x.max_length) AS authorized
        FROM rpki_roas x WHERE x.prefix >>= b.network
      ) r ON true
    ), rpki_agg AS (
      SELECT asn,
        COUNT(*) FILTER (WHERE rpki = 'valid')::int    AS rpki_valid,
        COUNT(*) FILTER (WHERE rpki = 'invalid')::int  AS rpki_invalid,
        COUNT(*) FILTER (WHERE rpki = 'unsigned')::int AS rpki_unsigned
      FROM prefix_rpki GROUP BY asn
    ), cloud_agg AS (
      SELECT asn, COUNT(DISTINCT network)::int AS cloud_prefixes FROM (
        SELECT DISTINCT b.asn, b.network
        FROM cloud_ranges c JOIN bgp_origin_ranges b ON b.network && c.network
      ) d GROUP BY asn
    ), bot_agg AS (
      SELECT asn, COUNT(DISTINCT network)::int AS bot_prefixes FROM (
        SELECT DISTINCT b.asn, b.network
        FROM verified_bot_ranges v JOIN bgp_origin_ranges b ON b.network && v.network
      ) d GROUP BY asn
    ), anon_agg AS (
      SELECT b.asn,
        COUNT(*) FILTER (WHERE a.kind = 'tor')::int  AS tor_addresses,
        COUNT(*) FILTER (WHERE a.kind <> 'tor')::int AS vpn_addresses
      FROM anonymity_ranges a JOIN bgp_origin_ranges b ON a.network <<= b.network
      GROUP BY b.asn
    ), country_agg AS (
      SELECT asn, COUNT(DISTINCT country)::int AS country_count,
             (ARRAY_AGG(country ORDER BY n DESC))[1] AS primary_country
      FROM (
        SELECT b.asn, i.country, COUNT(*) AS n
        FROM ip_blocks i JOIN bgp_origin_ranges b ON b.network <<= i.network
        WHERE i.country IS NOT NULL
        GROUP BY b.asn, i.country
      ) c GROUP BY asn
    ), ins AS (
      INSERT INTO asn_profile (
        asn, country_count, primary_country,
        rpki_valid_prefixes, rpki_invalid_prefixes, rpki_unsigned_prefixes,
        cloud_prefixes, tor_addresses, vpn_addresses, bot_prefixes, computed_at
      )
      SELECT r.asn,
             COALESCE(co.country_count, 0), co.primary_country,
             r.rpki_valid, r.rpki_invalid, r.rpki_unsigned,
             COALESCE(cl.cloud_prefixes, 0),
             COALESCE(an.tor_addresses, 0), COALESCE(an.vpn_addresses, 0),
             COALESCE(bo.bot_prefixes, 0), now()
      FROM rpki_agg r
      LEFT JOIN cloud_agg   cl ON cl.asn = r.asn
      LEFT JOIN bot_agg     bo ON bo.asn = r.asn
      LEFT JOIN anon_agg    an ON an.asn = r.asn
      LEFT JOIN country_agg co ON co.asn = r.asn
      RETURNING 1
    )
    SELECT count(*)::int AS inserted FROM ins
  `);
  });

  const inserted = result.rows[0]?.inserted ?? 0;
  source.recordsIngested += inserted;
  job.totalIngested += inserted;
  logger.info({ asns: inserted }, "ASN profiles computed");
  await persistSource(source);
}

async function computeNeighborhoodStats(job: ActiveJob, source: SourceRuntime): Promise<void> {
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }

  // Same delete+rebuild atomicity concern as computeAsnProfile above.
  const result = await db.transaction(async (tx) => {
    await tx.delete(neighborhoodStatsTable);
    return tx.execute<{ inserted: number }>(sql`
    WITH flagged AS (
      SELECT network, CASE WHEN kind = 'tor' THEN 'tor' ELSE 'vpn' END AS bucket
      FROM anonymity_ranges
      UNION ALL SELECT network, 'threat' FROM threat_ranges
      UNION ALL SELECT network, 'bot' FROM verified_bot_ranges
    ), blocked AS (
      SELECT
        set_masklen(network::cidr, CASE WHEN family(network) = 4 THEN 24 ELSE 48 END) AS block,
        family(network) AS family,
        bucket
      FROM flagged
      -- Only entries at least as specific as their block; see above.
      WHERE masklen(network) >= CASE WHEN family(network) = 4 THEN 24 ELSE 48 END
    ), agg AS (
      SELECT block, family,
        COUNT(*) FILTER (WHERE bucket = 'tor')::int    AS tor_entries,
        COUNT(*) FILTER (WHERE bucket = 'vpn')::int    AS vpn_entries,
        COUNT(*) FILTER (WHERE bucket = 'threat')::int AS threat_entries,
        COUNT(*) FILTER (WHERE bucket = 'bot')::int    AS bot_entries
      FROM blocked GROUP BY block, family
    ), ins AS (
      INSERT INTO neighborhood_stats
        (block, family, tor_entries, vpn_entries, threat_entries, bot_entries, computed_at)
      SELECT block, family, tor_entries, vpn_entries, threat_entries, bot_entries, now()
      FROM agg
      RETURNING 1
    )
    SELECT count(*)::int AS inserted FROM ins
  `);
  });

  const inserted = result.rows[0]?.inserted ?? 0;
  source.recordsIngested += inserted;
  job.totalIngested += inserted;
  logger.info({ blocks: inserted }, "Neighborhood stats computed");
  await persistSource(source);
}

async function computeAsnReach(job: ActiveJob, source: SourceRuntime): Promise<void> {
  if (job.shouldStop) {
    source.status = "stopped";
    return;
  }

  // Same delete+rebuild atomicity concern as computeAsnProfile above.
  const ingested = await db.transaction(async (tx) => {
    await tx.delete(asnReachTable);

    // 2^(32 - masklen) per IPv4 prefix = the addresses it covers. Computed in
    // `numeric` (a /0 would overflow int) and only then narrowed to bigint.
    // IPv6 gets a prefix count instead: a single v6 /32 covers 2^96 addresses,
    // which is not a number that belongs in the same column as v4 counts.
    await tx.execute(sql`
      INSERT INTO asn_reach (
        asn, rank, originated_prefixes, originated_prefixes_v6,
        originated_addresses, peer_visibility, computed_at
      )
      WITH agg AS (
        SELECT
          asn,
          COUNT(*)::int AS prefixes,
          COUNT(*) FILTER (WHERE family(network) = 6)::int AS prefixes_v6,
          COALESCE(SUM(
            CASE WHEN family(network) = 4
                 THEN (2::numeric ^ (32 - masklen(network)))
                 ELSE 0 END
          ), 0)::bigint AS addresses_v4,
          MAX(peer_count)::int AS max_peers
        FROM bgp_origin_ranges
        GROUP BY asn
      )
      SELECT
        asn,
        DENSE_RANK() OVER (ORDER BY addresses_v4 DESC, prefixes DESC)::int,
        prefixes,
        prefixes_v6,
        addresses_v4,
        max_peers,
        now()
      FROM agg
    `);

    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(asnReachTable);
    return row?.count ?? 0;
  });
  source.recordsIngested += ingested;
  job.totalIngested += ingested;
  await persistSource(source);
}

/**
 * Tor's bulk exit list: one address per line, no CIDR, no header. Stored as
 * /32 and /128 entries — Tor publishes individual relay addresses, not the
 * blocks they sit in, and widening them would over-claim.
 */
async function ingestTorExitList(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const tag = source.config.source ?? source.config.id;
  await db.delete(anonymityRangesTable).where(eq(anonymityRangesTable.source, tag));

  let batch: Array<typeof anonymityRangesTable.$inferInsert> = [];
  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const family = isIpAddress(line);
    if (family === 0) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    batch.push({
      network: family === 4 ? `${line}/32` : `${line}/128`,
      kind: "tor",
      provider: source.config.provider ?? "tor",
      source: tag,
    });
    if (batch.length >= BATCH_SIZE) {
      await flushAnonymityBatch(batch, source, job);
      batch = [];
    }
  }
  if (batch.length > 0) await flushAnonymityBatch(batch, source, job);
}

/**
 * Mullvad's relay API. Each relay carries the address traffic *leaves* from
 * (`ipv4_addr_in`/`ipv6_addr_in`), which is the one a destination actually
 * sees — the entry address would be useless here.
 */
async function ingestMullvadRelays(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const tag = source.config.source ?? source.config.id;
  await db.delete(anonymityRangesTable).where(eq(anonymityRangesTable.source, tag));

  const text = await readAllText(response, source);
  let relays: Array<{ ipv4_addr_in?: string; ipv6_addr_in?: string; active?: boolean }>;
  try {
    relays = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse Mullvad relay JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(relays)) throw new Error("Mullvad relay JSON was not an array");

  const batch: Array<typeof anonymityRangesTable.$inferInsert> = [];
  for (const relay of relays) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    // Inactive relays are kept out: an address Mullvad has retired may well
    // have been reassigned to someone ordinary by now, and flagging it as a
    // VPN would be a false positive that never expires.
    if (relay.active === false) continue;
    for (const [addr, suffix] of [
      [relay.ipv4_addr_in, "/32"],
      [relay.ipv6_addr_in, "/128"],
    ] as const) {
      if (!addr || isIpAddress(addr) === 0) continue;
      batch.push({
        network: `${addr}${suffix}`,
        kind: "vpn",
        provider: source.config.provider ?? "mullvad",
        source: tag,
      });
    }
  }
  await flushAnonymityBatches(batch, source, job);
}

/**
 * Azure's Service Tags file. Microsoft dates the filename and rotates it
 * weekly, so `source.config.url` is the download *page*: the current JSON
 * link is scraped out of it, then fetched. Two requests instead of one, but
 * it means the registry URL keeps working week to week rather than 404ing
 * every Monday.
 */
async function ingestAzureServiceTags(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const page = await readAllText(response, source);
  const match = page.match(
    /https:\/\/download\.microsoft\.com\/[^"']*ServiceTags_Public_\d+\.json/,
  );
  if (!match) {
    throw new Error(
      "Could not find the ServiceTags JSON link on Azure's download page — Microsoft likely changed the page layout; update the regex or point the registry at the JSON directly.",
    );
  }
  const jsonResponse = await fetchWithRetry(
    match[0],
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    { label: `enrichment:${source.config.id}:json`, ...FETCH_RETRY },
  );
  if (!jsonResponse.ok) {
    throw new Error(`Azure Service Tags HTTP ${jsonResponse.status} ${jsonResponse.statusText}`);
  }
  const text = await readAllText(jsonResponse, source);

  let parsed: { values?: Array<{ properties?: { addressPrefixes?: string[] } }> };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse Azure Service Tags JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const provider = source.config.provider ?? "azure";
  await db.delete(cloudRangesTable).where(eq(cloudRangesTable.provider, provider));

  // Service tags overlap heavily (an address appears under both a regional
  // tag and a service tag), so dedupe before inserting rather than relying
  // on the unique index to absorb thousands of conflicts.
  const seen = new Set<string>();
  const batch: Array<typeof cloudRangesTable.$inferInsert> = [];
  for (const value of parsed.values ?? []) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    for (const prefix of value.properties?.addressPrefixes ?? []) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      if (!parseCidr(prefix)) {
        source.recordsSkipped++;
        job.totalSkipped++;
        continue;
      }
      batch.push({ network: prefix, provider });
    }
  }
  await flushCloudBatches(batch, source, job);
}

/**
 * Validated ROA payloads. The published shape is
 * `{ roas: [{ prefix, maxLength, asn }] }`, where `asn` is usually the
 * string "AS13335" but is an integer in some validators' output — both are
 * accepted here rather than assuming one.
 */
interface RawRoa {
  prefix?: string;
  maxLength?: number;
  asn?: string | number;
}

/**
 * Streamed rather than buffered. The old version did `readAllText` (the
 * whole body as one string) → `JSON.parse` (the whole tree as JS objects,
 * a second full copy) → a `batch` array holding transformed rows for
 * essentially every entry (a third) — three copies of the same data alive
 * at once, measured at ~1.4GB peak on a real feed. This pipes the response
 * body straight through a SAX-style JSON tokenizer (`stream-json`'s "web"
 * build — the flavor that works on WHATWG `ReadableStream`/`TransformStream`
 * directly, matching how every other reader in this file already consumes
 * `response.body`, instead of requiring a Node `Readable` conversion),
 * picks out just the `roas` array, and yields one object at a time —
 * `batch` only ever holds up to `BATCH_SIZE` rows, same as every
 * line-streamed source in this file (see `iterLines`'s callers).
 */
async function ingestRpkiVrp(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const tag = source.config.source ?? source.config.id;

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      source.bytesDownloaded += chunk.byteLength;
      source.hasher?.update(chunk);
      controller.enqueue(chunk);
    },
  });
  const roaStream = response
    .body!.pipeThrough(counter)
    .pipeThrough(parserWebStream())
    .pipeThrough(pick.asWebStream({ filter: "roas" }))
    .pipeThrough(streamArray.asWebStream()) as ReadableStream<{ key: number; value: RawRoa }>;
  const reader = roaStream.getReader();

  const readNext = async (): Promise<{ done: true } | { done: false; roa: RawRoa }> => {
    let result: Awaited<ReturnType<typeof reader.read>>;
    try {
      result = await reader.read();
    } catch (err) {
      throw new Error(
        `Failed to parse RPKI VRP JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result.done ? { done: true } : { done: false, roa: result.value.value };
  };

  // Peeked before the delete below, not after: an empty/malformed feed must
  // never wipe the existing table. Buffering the array to check its length
  // upfront (the old approach) is exactly what streaming exists to avoid,
  // so this reads one item ahead instead — the same safety property from
  // one item of lookahead rather than the whole array.
  const first = await readNext();
  if (first.done) {
    throw new Error("RPKI VRP JSON contained no roas — refusing to wipe the existing table");
  }

  await db.delete(rpkiRoasTable).where(eq(rpkiRoasTable.source, tag));

  let batch: Array<typeof rpkiRoasTable.$inferInsert> = [];
  const processRoa = (roa: RawRoa): void => {
    const prefix = roa.prefix;
    const parsedPrefix = prefix ? parseCidr(prefix) : null;
    const asn =
      typeof roa.asn === "number" ? roa.asn : Number(String(roa.asn ?? "").replace(/^AS/i, ""));
    if (!prefix || !parsedPrefix || !Number.isFinite(asn) || asn <= 0) {
      source.recordsSkipped++;
      job.totalSkipped++;
      return;
    }
    const maskLen = Number(prefix.split("/")[1]);
    const maxLength =
      typeof roa.maxLength === "number" && Number.isFinite(roa.maxLength)
        ? roa.maxLength
        : maskLen;
    batch.push({ prefix, maxLength, asn, source: tag });
  };

  processRoa(first.roa);
  while (true) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const next = await readNext();
    if (next.done) break;
    processRoa(next.roa);
    if (batch.length >= BATCH_SIZE) {
      await flushRpkiBatches(batch, source, job);
      batch = [];
    }
  }
  if (batch.length > 0) await flushRpkiBatches(batch, source, job);
}

/**
 * abuse.ch Feodo Tracker — a flat JSON array of currently/recently-seen
 * botnet C2 addresses (`{ip_address, port, status, malware, ...}`), the
 * smallest and simplest shape ingested here. `status` ("online"/"offline")
 * is kept as-is rather than filtered to online-only: an address seen
 * offline in the last few days is still meaningfully more suspicious than
 * one never observed at all, and the whole file is small enough (tens of
 * rows, not thousands) that this isn't a false-positive-volume concern the
 * way an unbounded historical list would be — see enrichment-sources.ts's
 * comment on why the "aggressive" (multi-year historical) variant is
 * deliberately not used instead.
 */
async function ingestFeodoTracker(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const tag = source.config.source ?? source.config.id;
  const text = await readAllText(response, source);

  let entries: Array<{ ip_address?: string; malware?: string }>;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse Feodo Tracker JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error("Feodo Tracker JSON was not an array — the feed's shape may have changed.");
  }

  await db.delete(threatRangesTable).where(eq(threatRangesTable.source, tag));

  const batch: Array<typeof threatRangesTable.$inferInsert> = [];
  for (const entry of entries) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const ip = entry.ip_address;
    const family = ip ? isIpAddress(ip) : 0;
    if (!ip || family === 0) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    batch.push({
      network: family === 4 ? `${ip}/32` : `${ip}/128`,
      source: tag,
      category: entry.malware ?? source.config.category ?? null,
    });
  }
  await flushThreatBatches(batch, source, job);
}

/* ------------------------------------------------------------------------ */
/* Flushers                                                                  */
/* ------------------------------------------------------------------------ */

async function flushAnonymityBatch(
  rows: Array<typeof anonymityRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(anonymityRangesTable).values(rows).onConflictDoNothing();
    source.recordsIngested += rows.length;
    job.totalIngested += rows.length;
  } catch (err) {
    logger.warn({ err }, "anonymity batch insert failed");
    source.recordsSkipped += rows.length;
    job.totalSkipped += rows.length;
  }
  await persistSource(source);
}

async function flushAnonymityBatches(
  rows: Array<typeof anonymityRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await flushAnonymityBatch(rows.slice(i, i + BATCH_SIZE), source, job);
  }
}

async function flushRpkiBatches(
  rows: Array<typeof rpkiRoasTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(rpkiRoasTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "rpki batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

async function flushThreatBatches(
  rows: Array<typeof threatRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(threatRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "threat batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

async function flushSpecialPurposeBatches(
  rows: Array<typeof specialPurposeRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(specialPurposeRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "special-purpose batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

async function flushCloudBatches(
  rows: Array<typeof cloudRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(cloudRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "cloud batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

async function persistSource(source: SourceRuntime): Promise<void> {
  await db
    .update(enrichmentSourcesTable)
    .set({
      status: source.status,
      recordsIngested: source.recordsIngested,
      recordsSkipped: source.recordsSkipped,
      bytesDownloaded: source.bytesDownloaded,
      contentHash: source.contentHash,
      startedAt: source.startedAt,
      endedAt: source.endedAt,
      errorMessage: source.errorMessage,
    })
    .where(eq(enrichmentSourcesTable.id, source.sourceRowId));
}

/* ------------------------------------------------------------------------ */
/* Status                                                                    */
/* ------------------------------------------------------------------------ */

export async function loadEnrichmentStatus(): Promise<{
  isActive: boolean;
  job: EnrichmentJob | null;
  sources: Array<{
    sourceId: string;
    kind: string;
    /** Null for "derived" sources, which download nothing. */
    url: string | null;
    status: string;
    recordsIngested: number;
    recordsSkipped: number;
    bytesDownloaded: number;
    startedAt: Date | null;
    endedAt: Date | null;
    errorMessage: string | null;
  }>;
}> {
  let jobId: string | null = activeJob?.jobId ?? null;
  let jobRow: EnrichmentJob | null = null;
  if (jobId) {
    const [r] = await db
      .select()
      .from(enrichmentJobsTable)
      .where(eq(enrichmentJobsTable.id, jobId));
    jobRow = r ?? null;
  } else {
    const [r] = await db
      .select()
      .from(enrichmentJobsTable)
      .orderBy(desc(enrichmentJobsTable.startedAt))
      .limit(1);
    jobRow = r ?? null;
    jobId = r?.id ?? null;
  }
  let sources: Array<typeof enrichmentSourcesTable.$inferSelect> = [];
  if (jobId) {
    sources = await db
      .select()
      .from(enrichmentSourcesTable)
      .where(eq(enrichmentSourcesTable.jobId, jobId))
      .orderBy(enrichmentSourcesTable.id);
  }
  const liveMap = new Map(
    activeJob?.sources.map((s) => [s.config.id, s]) ?? [],
  );
  return {
    isActive: activeJob !== null,
    job: jobRow,
    sources: sources.map((s) => {
      const live = liveMap.get(s.sourceId);
      return {
        sourceId: s.sourceId,
        kind: s.kind,
        url: s.url,
        status: live?.status ?? s.status,
        recordsIngested: live?.recordsIngested ?? s.recordsIngested,
        recordsSkipped: live?.recordsSkipped ?? s.recordsSkipped,
        bytesDownloaded: live?.bytesDownloaded ?? s.bytesDownloaded,
        startedAt: live?.startedAt ?? s.startedAt,
        endedAt: live?.endedAt ?? s.endedAt,
        errorMessage: live?.errorMessage ?? s.errorMessage,
      };
    }),
  };
}

export function enrichmentJobToDto(job: EnrichmentJob): {
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
