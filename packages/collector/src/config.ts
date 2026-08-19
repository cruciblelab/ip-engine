/**
 * Optional config file controlling collection/enrichment behavior — which
 * sources run by default, which RIR statuses get kept, and performance/
 * output tuning (batch size, retry/timeout, default export locations).
 *
 * Location: `ip-insight.config.json` in the current working directory, or
 * the path in `IP_INSIGHT_CONFIG` if set. No file at all is equivalent to
 * every key being absent — everything uses today's defaults.
 *
 * Precedence for source selection, applied by the caller
 * (startCollection/startEnrichment/collectRirToCsv): an explicit `sources`
 * argument (CLI --sources, or an HTTP request body's `sources` field)
 * always wins over this config; this config only fills in when the caller
 * didn't specify anything at all.
 *
 * Format:
 *   {
 *     "collection": "database_full",
 *     "collectionStatuses": "allocated,assigned",
 *     "enrichment": "arin,geonames-cities",
 *     "batchSize": 2000,
 *     "fetchRetryMaxAttempts": 4,
 *     "fetchRetryBaseDelayMs": 1000,
 *     "fetchRetryTimeoutMs": 30000,
 *     "sourceRetryMaxAttempts": 3,
 *     "exportFormat": "csv",
 *     "exportDir": ".",
 *     "summaryDir": "./summary",
 *     "checkpointingEnabled": true,
 *     "checkpointIdFormat": "uuid",
 *     "checkpointStaleAfterHours": 168,
 *     "checkpointAutoCleanupStaleJobs": false,
 *     "maintenanceSchedulerEnabled": false,
 *     "backupEnabled": false,
 *     "backupIntervalHours": 24,
 *     "backupRetentionCount": 7,
 *     "backupDir": "./backups",
 *     "sleepModeEnabled": false,
 *     "sleepModeIdleHours": 72
 *   }
 *
 * `collection`/`collectionStatuses`/`enrichment` are each either:
 *   - absent, or the literal string "database_full" → everything (null)
 *   - a comma-separated list of source ids (or, for `collectionStatuses`,
 *     RIR status values) → only those
 *
 * `collectionStatuses` filters ip_blocks/asn_blocks rows by the RIR's own
 * `status` field — real delegated-extended files carry all four of
 * "allocated" (in active use), "assigned" (end-user assignment), "reserved"
 * (held back by the RIR, not yet delegated), and "available" (unallocated,
 * free for the RIR to hand out). Every status is collected by default; this
 * lets a deployment that only cares about actually-in-use space skip
 * "reserved"/"available" rows entirely instead of storing (and later
 * filtering out at query time) blocks nobody is using yet.
 *
 * `batchSize` controls how many parsed rows accumulate before a single
 * multi-row INSERT — lower it on a memory-constrained deployment (e.g. a
 * phone running Postgres under Termux); higher batches mean fewer round
 * trips but more memory held per in-flight batch.
 *
 * `fetchRetry*` tune fetchWithRetry (shared/retry.ts) for every collection/
 * enrichment download: how many attempts, the exponential-backoff base
 * delay, and the per-attempt timeout before it's treated as a failure and
 * retried. Relevant on flaky mobile connections, where the defaults (4
 * attempts, 1s base delay, 30s timeout) may need to be more patient.
 *
 * `sourceRetryMaxAttempts` is a separate, higher-level retry: if a source
 * fails outright (not just a connection blip fetchRetry already recovered
 * from — a stream that dies mid-download partway through parsing, for
 * instance), the whole source (fetch + parse) is retried from scratch this
 * many times, with the same exponential backoff, before it's left "failed"
 * for the operator to see. Default 3.
 *
 * `exportFormat`/`exportDir`/`summaryDir` are the CLI's fallback values for
 * `export --format`/`--out` and `summary --out` when those flags aren't
 * passed explicitly — an explicit flag always overrides these.
 *
 * `checkpointingEnabled` turns on job-resume tracking: an interrupted
 * (crashed/killed) collect or enrich run gets detected the next time its
 * kind starts, so `ip-insight jobs` can list it and `ip-insight collect
 * --resume [id]` / `enrich --resume [id]` can pick up the sources that
 * never finished instead of re-running everything. `checkpointIdFormat`
 * controls how job ids are displayed/accepted: "uuid" (the real primary
 * key, default) or "sequential" ("collect-000123"/"enrich-000123", easier
 * to read off a terminal). `checkpointStaleAfterHours` hides an interrupted
 * job from the default (id-less) `jobs`/`--resume` listing once it's older
 * than this — it's still resumable by explicit id unless
 * `checkpointAutoCleanupStaleJobs` is also true, in which case stale rows
 * are deleted outright (off by default: deleting resume state is
 * irreversible, so it's opt-in).
 *
 * `maintenanceSchedulerEnabled` is the master switch for all unattended,
 * timer-driven automation (@workspace/collector's maintenance.ts) —
 * everything below this line only ever runs if it's `true`. Off by
 * default: nothing runs on a timer out of the box, full stop. The three
 * settings below only matter once it's on. This is also the one setting
 * here that needs a server restart to take effect either way — see
 * maintenance.ts's header for why, and for how to remove this automation
 * from the codebase entirely (delete one file) if you'd rather not have it
 * at all, even disabled.
 *
 * `backupEnabled`/`backupIntervalHours`/`backupRetentionCount`/`backupDir`
 * control the *automatic* `pg_dump` snapshots taken by the maintenance
 * scheduler — off by default (both this and `maintenanceSchedulerEnabled`
 * need to be true) since a dump has real time/disk cost on a large
 * database. `ip-insight backup create`/`list`/`restore` are manual
 * commands and work regardless of either setting.
 *
 * `ipIntelMode`: which form of the flattened `ip_intel` relation to keep in
 * step with the data — "view" (default; costs nothing, always current,
 * ~40-110ms per lookup), "materialized" (precomputed, one index probe per
 * lookup, but a ~10-minute rebuild after each enrichment and real disk), or
 * "off". Refreshed automatically at the end of every enrichment run, or on
 * demand via `ip-insight flatten`. See SOURCES.md for what the relation
 * contains and why it exists.
 *
 * `historyCaptureEnabled`: whether each enrichment run ends by capturing a
 * history baseline (`ops.prefix_baseline`/`ops.prefix_history` — see
 * history.ts). Off by default, and deliberately *not* gated behind
 * `maintenanceSchedulerEnabled`: this isn't timer-driven background
 * automation, it's the tail of a job the operator started, so it runs when
 * enrichment runs and never on its own.
 *
 * **This is the coupled path, and it is no longer the recommended one.**
 * `ip-insight history capture` is history's own standalone job: it takes an
 * advisory lock against overlapping runs, and it reports how many days have
 * passed since the last *successful* capture — neither of which this
 * tail-of-enrichment path does. The coupling also costs something real: a
 * capture only happens if an enrichment completes, so an enrichment killed
 * at hour four (OOM, screen lock, closed terminal — all of which have
 * happened, see DEPLOY.md) takes that day's capture down with it, and that
 * day cannot be recovered. Scheduling the standalone command separately
 * decouples the two failure modes. The setting stays supported for
 * deployments already relying on it.
 *
 * Either way, capturing at all is the difference between history that
 * accumulates and history that doesn't: every signal derived from it (how
 * recently a prefix changed hands, how volatile an ASN is) is worth exactly
 * as much as the unbroken span behind it, and a span only starts once
 * captures do. There is no way to backfill it later — an enrichment that ran
 * without capture left no record of what the data said at that moment.
 *
 * Requires `ipIntelMode: "materialized"`. Diffing a plain view rescans the
 * whole database three times per capture, so `captureBaseline()` refuses to
 * run against one; with capture enabled and mode left at "view" every run
 * records itself as `skipped` (with that reason) rather than failing the
 * enrichment — visible in `ip-insight history status`.
 *
 * `sleepModeEnabled`/`sleepModeIdleHours`: when no collect/enrich job has
 * started in this many hours, the maintenance scheduler logs a single
 * "entered sleep mode" line (and one "exited sleep mode" line on the next
 * job) to the shared log — purely informational, changes no behavior. Off
 * by default, same as the rest of this automation.
 *
 * `mmdbHistoryFields`: whether `.mmdb` export includes `stable_since` — the
 * timestamp `ops.prefix_baseline.captured_at` already carries for free
 * (`captureBaseline()` only touches it when a prefix's tracked record
 * actually changes, so it already means exactly "since when has this been
 * true"). Off by default, and meant to stay off until `ip-insight history
 * status`'s maturity level says otherwise — a `stable_since` computed from
 * three weeks of capturing is technically correct but not the claim this
 * project wants attached to a shipped file. This is the field itself, not a
 * verdict about it: it says how long a record has held, not whether that's
 * "stable" by any threshold — that judgment stays with whoever reads the
 * file. Unlike most switches above, this one is deliberately a manual,
 * human-read-the-maturity-report decision rather than an automatic gate
 * computed at export time — the operator turns it on when the data behind
 * it is actually old enough to say something.
 *
 * Re-read on every call (not cached): this is only consulted at the start
 * of a collect/enrich/export run (not on any hot path), and re-reading
 * means editing the file takes effect on the next run without restarting
 * whatever process is calling this (API server, CLI process, etc.) — this
 * includes the maintenance scheduler's periodic tick, which re-reads this
 * same config on every check, so none of the settings above need a
 * restart either. This is a deliberately different tradeoff from
 * @workspace/lookup's config, which IS cached — see that package's own
 * config.ts for why.
 */
import {
  readConfigFile,
  parseListValue,
  validateAgainstKnown,
  parseNumberValue,
  parseEnumValue,
  parseStringValue,
  parseBooleanValue,
} from "@workspace/shared";
import { KNOWN_SOURCES } from "./collection/sources";
import { KNOWN_ENRICHMENT_SOURCES } from "./enrichment/enrichment-sources";

export interface CollectorConfig {
  /** RIR names to collect by default, or `null` for all (KNOWN_SOURCES). */
  collection: string[] | null;
  /** RIR status values to keep (allocated/assigned/reserved/available), or `null` for all. */
  collectionStatuses: string[] | null;
  /** Enrichment source ids to run by default, or `null` for all. */
  enrichment: string[] | null;
  /** Rows accumulated before a single multi-row INSERT. Default 2000. */
  batchSize: number;
  /** fetchWithRetry tuning for every collection/enrichment download. */
  fetchRetry: {
    maxAttempts: number;
    baseDelayMs: number;
    timeoutMs: number;
  };
  /** How many times a whole source (fetch + parse together) is retried from
   * scratch after it fails outright — separate from fetchRetry, which only
   * covers the initial connection. A stream that dies mid-download (a dropped
   * mobile connection partway through a multi-million-row feed) fails after
   * fetchRetry has already succeeded, so recovering from it means redoing the
   * whole source, not just reconnecting. Default 3. */
  sourceRetryMaxAttempts: number;
  /** Default `export --format` when not passed explicitly. */
  exportFormat: "csv" | "ndjson";
  /** Default `export --out` directory when not passed explicitly. */
  exportDir: string;
  /** Default `summary --out` directory when not passed explicitly. */
  summaryDir: string;
  /** Master switch for job-resume tracking. Default true. */
  checkpointingEnabled: boolean;
  /** How job ids are displayed/accepted. Default "uuid". */
  checkpointIdFormat: "uuid" | "sequential";
  /** Hours before an interrupted job drops out of the default listing. Default 168 (7 days). */
  checkpointStaleAfterHours: number;
  /** Whether stale interrupted jobs get deleted outright. Default false. */
  checkpointAutoCleanupStaleJobs: boolean;
  /** Master switch for all timer-driven background automation. Default false — needs a restart to change. */
  maintenanceSchedulerEnabled: boolean;
  /** Whether the maintenance scheduler takes automatic pg_dump snapshots. Default false. */
  backupEnabled: boolean;
  /** Hours between automatic backups. Default 24. */
  backupIntervalHours: number;
  /** How many automatic backups to keep before pruning the oldest. Default 7. */
  backupRetentionCount: number;
  /** Directory automatic (and manual) backups are written to. Default "./backups". */
  backupDir: string;
  /** Whether idle-time logging is on. Default false. */
  sleepModeEnabled: boolean;
  /** Hours of no collect/enrich activity before logging "entered sleep mode". Default 72. */
  sleepModeIdleHours: number;
  /** Which form of the flattened `ip_intel` relation to maintain. Default "view". */
  ipIntelMode: "view" | "materialized" | "off";
  /** Whether each enrichment run ends by capturing a history baseline. Default false. */
  historyCaptureEnabled: boolean;
  /** Whether .mmdb export includes the history-derived `stable_since` field. Default false — an operator call on data maturity, not an automatic one. */
  mmdbHistoryFields: boolean;
  /** Absolute path this was loaded from, or null if no file was found. */
  sourcePath: string | null;
}

const ALL = "database_full";
const KNOWN_RIR_STATUSES = ["allocated", "assigned", "reserved", "available"];

const DEFAULTS = {
  batchSize: 2000,
  fetchRetryMaxAttempts: 4,
  fetchRetryBaseDelayMs: 1000,
  fetchRetryTimeoutMs: 30_000,
  sourceRetryMaxAttempts: 3,
  exportFormat: "csv" as const,
  exportDir: ".",
  summaryDir: "./summary",
  checkpointingEnabled: true,
  checkpointIdFormat: "uuid" as const,
  checkpointStaleAfterHours: 168,
  checkpointAutoCleanupStaleJobs: false,
  maintenanceSchedulerEnabled: false,
  backupEnabled: false,
  backupIntervalHours: 24,
  backupRetentionCount: 7,
  backupDir: "./backups",
  sleepModeEnabled: false,
  sleepModeIdleHours: 72,
  ipIntelMode: "view" as const,
  historyCaptureEnabled: false,
  mmdbHistoryFields: false,
};

export function loadCollectorConfig(): CollectorConfig {
  const file = readConfigFile();
  if (!file) {
    return {
      collection: null,
      collectionStatuses: null,
      enrichment: null,
      batchSize: DEFAULTS.batchSize,
      fetchRetry: {
        maxAttempts: DEFAULTS.fetchRetryMaxAttempts,
        baseDelayMs: DEFAULTS.fetchRetryBaseDelayMs,
        timeoutMs: DEFAULTS.fetchRetryTimeoutMs,
      },
      sourceRetryMaxAttempts: DEFAULTS.sourceRetryMaxAttempts,
      exportFormat: DEFAULTS.exportFormat,
      exportDir: DEFAULTS.exportDir,
      summaryDir: DEFAULTS.summaryDir,
      checkpointingEnabled: DEFAULTS.checkpointingEnabled,
      checkpointIdFormat: DEFAULTS.checkpointIdFormat,
      checkpointStaleAfterHours: DEFAULTS.checkpointStaleAfterHours,
      checkpointAutoCleanupStaleJobs: DEFAULTS.checkpointAutoCleanupStaleJobs,
      maintenanceSchedulerEnabled: DEFAULTS.maintenanceSchedulerEnabled,
      backupEnabled: DEFAULTS.backupEnabled,
      backupIntervalHours: DEFAULTS.backupIntervalHours,
      backupRetentionCount: DEFAULTS.backupRetentionCount,
      backupDir: DEFAULTS.backupDir,
      sleepModeEnabled: DEFAULTS.sleepModeEnabled,
      sleepModeIdleHours: DEFAULTS.sleepModeIdleHours,
      ipIntelMode: DEFAULTS.ipIntelMode,
      historyCaptureEnabled: DEFAULTS.historyCaptureEnabled,
      mmdbHistoryFields: DEFAULTS.mmdbHistoryFields,
      sourcePath: null,
    };
  }

  const collection = validateAgainstKnown(
    parseListValue(file.obj["collection"], "collection", ALL),
    KNOWN_SOURCES.map((s) => s.rir),
    "collection",
  );
  const collectionStatuses = validateAgainstKnown(
    parseListValue(file.obj["collectionStatuses"], "collectionStatuses", ALL),
    KNOWN_RIR_STATUSES,
    "collectionStatuses",
  );
  const enrichment = validateAgainstKnown(
    parseListValue(file.obj["enrichment"], "enrichment", ALL),
    KNOWN_ENRICHMENT_SOURCES.map((s) => s.id),
    "enrichment",
  );

  const batchSize = parseNumberValue(file.obj["batchSize"], "batchSize", DEFAULTS.batchSize, {
    min: 1,
    max: 100_000,
  });
  const fetchRetry = {
    maxAttempts: parseNumberValue(
      file.obj["fetchRetryMaxAttempts"],
      "fetchRetryMaxAttempts",
      DEFAULTS.fetchRetryMaxAttempts,
      { min: 1, max: 20 },
    ),
    baseDelayMs: parseNumberValue(
      file.obj["fetchRetryBaseDelayMs"],
      "fetchRetryBaseDelayMs",
      DEFAULTS.fetchRetryBaseDelayMs,
      { min: 1, max: 60_000 },
    ),
    timeoutMs: parseNumberValue(
      file.obj["fetchRetryTimeoutMs"],
      "fetchRetryTimeoutMs",
      DEFAULTS.fetchRetryTimeoutMs,
      { min: 1000, max: 600_000 },
    ),
  };
  const sourceRetryMaxAttempts = parseNumberValue(
    file.obj["sourceRetryMaxAttempts"],
    "sourceRetryMaxAttempts",
    DEFAULTS.sourceRetryMaxAttempts,
    { min: 1, max: 20 },
  );
  const exportFormat = parseEnumValue(
    file.obj["exportFormat"],
    "exportFormat",
    ["csv", "ndjson"] as const,
    DEFAULTS.exportFormat,
  );
  const exportDir = parseStringValue(file.obj["exportDir"], "exportDir", DEFAULTS.exportDir);
  const summaryDir = parseStringValue(file.obj["summaryDir"], "summaryDir", DEFAULTS.summaryDir);

  const ipIntelMode = parseEnumValue(
    file.obj["ipIntelMode"],
    "ipIntelMode",
    ["view", "materialized", "off"] as const,
    DEFAULTS.ipIntelMode,
  );

  const checkpointingEnabled = parseBooleanValue(
    file.obj["checkpointingEnabled"],
    "checkpointingEnabled",
    DEFAULTS.checkpointingEnabled,
  );
  const checkpointIdFormat = parseEnumValue(
    file.obj["checkpointIdFormat"],
    "checkpointIdFormat",
    ["uuid", "sequential"] as const,
    DEFAULTS.checkpointIdFormat,
  );
  const checkpointStaleAfterHours = parseNumberValue(
    file.obj["checkpointStaleAfterHours"],
    "checkpointStaleAfterHours",
    DEFAULTS.checkpointStaleAfterHours,
    { min: 1, max: 8760 },
  );
  const checkpointAutoCleanupStaleJobs = parseBooleanValue(
    file.obj["checkpointAutoCleanupStaleJobs"],
    "checkpointAutoCleanupStaleJobs",
    DEFAULTS.checkpointAutoCleanupStaleJobs,
  );
  const maintenanceSchedulerEnabled = parseBooleanValue(
    file.obj["maintenanceSchedulerEnabled"],
    "maintenanceSchedulerEnabled",
    DEFAULTS.maintenanceSchedulerEnabled,
  );
  const backupEnabled = parseBooleanValue(
    file.obj["backupEnabled"],
    "backupEnabled",
    DEFAULTS.backupEnabled,
  );
  const backupIntervalHours = parseNumberValue(
    file.obj["backupIntervalHours"],
    "backupIntervalHours",
    DEFAULTS.backupIntervalHours,
    { min: 1, max: 8760 },
  );
  const backupRetentionCount = parseNumberValue(
    file.obj["backupRetentionCount"],
    "backupRetentionCount",
    DEFAULTS.backupRetentionCount,
    { min: 1, max: 1000 },
  );
  const backupDir = parseStringValue(file.obj["backupDir"], "backupDir", DEFAULTS.backupDir);
  const sleepModeEnabled = parseBooleanValue(
    file.obj["sleepModeEnabled"],
    "sleepModeEnabled",
    DEFAULTS.sleepModeEnabled,
  );
  const sleepModeIdleHours = parseNumberValue(
    file.obj["sleepModeIdleHours"],
    "sleepModeIdleHours",
    DEFAULTS.sleepModeIdleHours,
    { min: 1, max: 8760 },
  );
  const historyCaptureEnabled = parseBooleanValue(
    file.obj["historyCaptureEnabled"],
    "historyCaptureEnabled",
    DEFAULTS.historyCaptureEnabled,
  );
  const mmdbHistoryFields = parseBooleanValue(
    file.obj["mmdbHistoryFields"],
    "mmdbHistoryFields",
    DEFAULTS.mmdbHistoryFields,
  );

  return {
    collection,
    collectionStatuses,
    enrichment,
    batchSize,
    fetchRetry,
    sourceRetryMaxAttempts,
    exportFormat,
    exportDir,
    summaryDir,
    checkpointingEnabled,
    checkpointIdFormat,
    checkpointStaleAfterHours,
    checkpointAutoCleanupStaleJobs,
    maintenanceSchedulerEnabled,
    backupEnabled,
    backupIntervalHours,
    backupRetentionCount,
    backupDir,
    sleepModeEnabled,
    sleepModeIdleHours,
    ipIntelMode,
    historyCaptureEnabled,
    mmdbHistoryFields,
    sourcePath: file.sourcePath,
  };
}
