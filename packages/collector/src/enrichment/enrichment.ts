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
import { Readable } from "node:stream";
import { eq, sql, desc, and, lt, inArray } from "drizzle-orm";
import {
  db,
  asnBlocksTable,
  bgpOriginRangesTable,
  cloudRangesTable,
  geofeedRangesTable,
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
import {
  logger,
  parseCidr,
  fetchWithRetry,
  formatJobDisplayId,
  parseSequentialJobRef,
  sleep,
} from "@workspace/shared";
import { extractSingleEntryZip } from "./zip";
import { geocodeCityName } from "./geocode";
import {
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
  options?: { resumeJobRef?: string },
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
    return resumeEnrichment(options.resumeJobRef, config);
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
    sources: sourcesToRun.map((cfg) => {
      const row = sourceRows.find((r) => r.sourceId === cfg.id);
      return {
        config: cfg,
        sourceRowId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
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
 * source re-runs from scratch. */
async function resumeEnrichment(ref: string, config: CollectorConfig): Promise<EnrichmentJob> {
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
    sources: sourcesToRun.map((cfg) => {
      const row = pending.find((r) => r.sourceId === cfg.id);
      return {
        config: cfg,
        sourceRowId: row!.id,
        status: "pending" as const,
        recordsIngested: 0,
        recordsSkipped: 0,
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

async function runJob(job: ActiveJob): Promise<void> {
  try {
    for (const source of job.sources) {
      if (job.shouldStop) {
        source.status = "skipped";
        await persistSource(source);
        continue;
      }
      await runSourceWithRetry(job, source);
    }
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
    if (!job.shouldStop) {
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
    if (attempt === SOURCE_RETRY_ATTEMPTS) break;

    const delay = FETCH_RETRY.baseDelayMs * 2 ** attempt;
    logger.warn(
      { sourceId: source.config.id, attempt, attempts: SOURCE_RETRY_ATTEMPTS, delayMs: delay },
      "Enrichment source failed, retrying whole source",
    );
    source.status = "pending";
    source.recordsIngested = 0;
    source.recordsSkipped = 0;
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
      case "ris-whois-dump":
        await ingestRisWhoisDump(job, source, response);
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
      default:
        throw new Error(`Unknown parser ${source.config.parser}`);
    }

    if ((source.status as string) !== "stopped" && (source.status as string) !== "failed") {
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
      await flushAsnNames(batch, source, job);
      batch = [];
    }
  }
  if (batch.length > 0) await flushAsnNames(batch, source, job);
}

async function flushAsnNames(
  pairs: Array<{ asn: number; name: string }>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  if (pairs.length === 0) return;
  try {
    const values = sql.join(
      pairs.map((p) => sql`(${p.asn}::int, ${p.name}::text)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE asn_blocks
      SET name = v.name
      FROM (VALUES ${values}) AS v(asn, name)
      WHERE asn_blocks.asn_start <= v.asn
        AND asn_blocks.asn_end >= v.asn
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
    const parsed = parseCidr(prefix);
    if (!parsed) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    // 0.0.0.0/0, ::/0 and similarly-huge default-route entries carry no
    // useful signal and would win every longest-prefix-match tie
    // incorrectly if ever queried before a real match — drop anything
    // wider than a reasonable per-family minimum.
    const minPrefix = parsed.family === 4 ? 8 : 16;
    if (parsed.prefixLen < minPrefix) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    // IPv4-mapped "v6" announcements (::ffff:92.47.144.56/127 — real
    // example, leaked by AS9198's routers into the RIS dump) are junk that
    // can never match a query: a v4 lookup compares against family-4 rows
    // only, and no genuine v6 address sits inside ::ffff:0:0/96. Left in,
    // they inflate the announcing ASN's asn_profile counts.
    if (parsed.family === 6 && prefix.toLowerCase().startsWith("::ffff:")) {
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

async function flushBgpOriginBatch(
  rows: Array<typeof bgpOriginRangesTable.$inferInsert>,
  source: SourceRuntime,
  job: ActiveJob,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    try {
      await db.insert(bgpOriginRangesTable).values(slice).onConflictDoNothing();
      source.recordsIngested += slice.length;
      job.totalIngested += slice.length;
    } catch (err) {
      logger.warn({ err }, "bgp-origin batch insert failed");
      source.recordsSkipped += slice.length;
      job.totalSkipped += slice.length;
    }
    await persistSource(source);
  }
}

/**
 * DigitalOcean publishes their own datacenter ranges in exactly the RFC 8805
 * geofeed CSV shape (`prefix,country,region,city,postal`), so one file feeds
 * two tables: cloud_ranges (Layer 4 — this is a datacenter) and
 * geofeed_ranges (Layer 2 — precise facility city, operator-published).
 */
async function ingestDigitalOceanGeofeedCsv(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const provider = source.config.provider ?? "digitalocean";
  const confidence = source.config.confidence ?? 0.8;

  await db.delete(cloudRangesTable).where(eq(cloudRangesTable.provider, provider));
  await db
    .delete(geofeedRangesTable)
    .where(eq(geofeedRangesTable.sourceId, source.config.id));

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
    if (!prefix || !parseCidr(prefix)) {
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
  await flushGeofeedBatches(geofeedBatch, source, job);
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

  await db.delete(geofeedRangesTable).where(eq(geofeedRangesTable.sourceId, source.config.id));

  const geofeedBatch: Array<typeof geofeedRangesTable.$inferInsert> = [];

  for await (const raw of iterLines(response, source)) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [prefix, country, region, city, postal] = line.split(",");
    if (!prefix || !parseCidr(prefix)) {
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
  await flushGeofeedBatches(geofeedBatch, source, job);
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
async function ingestRpkiVrp(
  job: ActiveJob,
  source: SourceRuntime,
  response: Response,
): Promise<void> {
  const tag = source.config.source ?? source.config.id;
  const text = await readAllText(response, source);

  let parsed: { roas?: Array<{ prefix?: string; maxLength?: number; asn?: string | number }> };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse RPKI VRP JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const roas = parsed.roas ?? [];
  if (roas.length === 0) {
    throw new Error("RPKI VRP JSON contained no roas — refusing to wipe the existing table");
  }

  await db.delete(rpkiRoasTable).where(eq(rpkiRoasTable.source, tag));

  const batch: Array<typeof rpkiRoasTable.$inferInsert> = [];
  for (const roa of roas) {
    if (job.shouldStop) {
      source.status = "stopped";
      break;
    }
    const prefix = roa.prefix;
    const parsedPrefix = prefix ? parseCidr(prefix) : null;
    const asn =
      typeof roa.asn === "number" ? roa.asn : Number(String(roa.asn ?? "").replace(/^AS/i, ""));
    if (!prefix || !parsedPrefix || !Number.isFinite(asn) || asn <= 0) {
      source.recordsSkipped++;
      job.totalSkipped++;
      continue;
    }
    const maskLen = Number(prefix.split("/")[1]);
    const maxLength =
      typeof roa.maxLength === "number" && Number.isFinite(roa.maxLength)
        ? roa.maxLength
        : maskLen;
    batch.push({ prefix, maxLength, asn, source: tag });
  }
  await flushRpkiBatches(batch, source, job);
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
