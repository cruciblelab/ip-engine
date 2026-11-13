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
  MMDB_RECORD_FIELDS,
  RESALE_DEFAULT_EXCLUDED_FIELDS,
  RESALE_DEFAULT_DROP_COUNTRY_FALLBACK_RIRS,
} from "./export/resale-profile";
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
  /**
   * Whether the `dbip-lite` enrichment source also ingests the IPv6 half of
   * DB-IP's file. Default **false**, and that default is a measured cost
   * decision rather than caution for its own sake.
   *
   * Measured against the real file on 2026-08-23: the IPv6 half is 4,274,502
   * ranges which expand to **8,477,693 CIDR rows** (1.98x, since a range that
   * is not power-of-two aligned needs several prefixes to cover exactly).
   * Every one of those also becomes a base row in `ip_intel`, on top of the
   * ~6.25M the IPv4 half already contributes — so turning this on roughly
   * doubles this source's footprint, and with it the cost of every
   * `flatten`/`history capture` that follows.
   *
   * That is a real trade, not a free improvement: IPv6 geo coverage is
   * genuinely sparser than IPv4's, so this fills proportionally more gaps —
   * but it is paid for in rebuild time on whatever machine runs the pipeline.
   * Left off so the cost is opted into deliberately, the same call
   * `mmdbHistoryFields` and `routeAnomalyEnabled` already make.
   *
   * Turning it off again is a plain toggle: the next run simply stops
   * inserting IPv6 rows (the source fully replaces its own table each run,
   * so old ones do not linger). Nothing else in the codebase changes
   * behaviour — see `packages/shared/src/ipv6-range.ts` for how to remove
   * the supporting code entirely if it is never wanted.
   */
  dbipLiteIpv6: boolean;
  /**
   * Whether full-refresh enrichment sources load their rows with
   * `COPY ... FROM STDIN` instead of batched `INSERT`s. Default **true** —
   * unlike `dbipLiteIpv6`, which buys coverage at a cost, this only ever
   * removes work, so shipping it off by default would mean shipping a
   * measured 5x slowdown nobody asked for.
   *
   * Measured against the real 14.7M-row `dbip-lite` load (see
   * `docs/100-bulk-copy-ingest.md` for the per-change attribution): COPY
   * replaces ~7,350 `INSERT`s of 12,000 bind parameters each, `TRUNCATE`
   * replaces an unqualified `DELETE` that left the table permanently
   * bloated to ~1.9x its real size, and the per-batch progress `UPDATE` is
   * throttled to once every 2 seconds instead of once every 2,000 rows.
   *
   * The flag exists because this rewrites the hot write path of a source
   * that takes a long time to re-run: set it to `false` and
   * `ingestDbIpLiteCsv` takes the original path byte for byte, with nothing
   * in `bulk-load.ts` executing at all. It also switches itself off
   * automatically when `DB_POOL_MAX` is 1, where holding a connection for
   * the whole COPY would deadlock against the progress updates.
   *
   * See `packages/collector/src/enrichment/bulk-load.ts` for how to remove
   * the supporting code entirely if it is never wanted.
   */
  bulkCopyIngest: boolean;
  /**
   * Which ASN-name source writes unconditionally (always the current
   * answer, always wins) — the other becomes the fallback, only filling
   * ASNs the primary has no entry for, never overwriting it. Default
   * `"caida"`: measured 2026-08-24 (`docs/20-data-sources-and-licensing.md`)
   * at 84% of `asn.txt`'s ASN coverage, 96.4% name agreement on the overlap,
   * and — the actual reason it's primary — a commercial-use license that is
   * clean rather than unresolved. Set to `"ripe"` if that licensing question
   * ever gets a written answer that makes it the better default; the
   * fallback mechanics work identically either direction, since which one
   * is "primary" is exactly the write-unconditionally-vs-only-if-missing
   * distinction, not execution order.
   */
  asnNamePrimary: "caida" | "ripe";
  /**
   * Whether the non-primary ASN-name source runs at all. Default `false`
   * (changed from `true` on 2026-11-08, `docs/106` item B4).
   *
   * With the default `asnNamePrimary: "caida"`, the fallback is RIPE's
   * `asn.txt`, whose commercial-use terms have never been confirmed in
   * writing. Turning it on closes a real, measured coverage gap
   * (concentrated in Brazil/China/Latin America — `docs/20`), but it puts
   * data with an unresolved license into a product that is sold. Until
   * that question has a written answer, the coverage gap is the accepted
   * cost. The source stays registered, so flipping this back is a one-line
   * config change, not a code change.
   *
   * When off it is a genuine no-op: the fallback's own ingest function
   * checks this before doing anything and returns immediately, marked
   * `skipped` — no download, no parse, no write, same shape as every other
   * opt-out in this file. `asn_blocks.name` is then exactly whatever
   * `asnNamePrimary` alone provides, gaps included — and names the
   * fallback wrote on earlier runs are removed by
   * `purgeDeselectedAsnNameSources` after the next successful run.
   */
  asnNameFallbackEnabled: boolean;
  /**
   * Which BGP route-collector project supplies `bgp_origin_ranges` (the
   * prefix → origin-ASN mapping). Default `"routeviews"` since 2026-11-08
   * (was `"ripe-ris"`; `docs/106` Phase 1 log).
   *
   * **Exclusive, not primary/fallback** — deliberately unlike
   * `asnNamePrimary` above. The two ASN-name sources cover *disjoint* sets,
   * so combining them adds real coverage; two BGP collector projects
   * observe *overlapping* prefixes, where combining them is a merge with no
   * principled way to rank the overlap (and `bgp_origin_ranges`' own
   * `(network, asn)` unique index makes identical pairs collide rather than
   * coexist). Only one runs; the other does nothing.
   *
   * The reason a second option exists at all is licensing, not coverage.
   * RIPE RIS's *data* terms are fine, but its commercial-use conditions
   * require displaying the RIPE NCC logo, which needs written permission a
   * non-member has to request (`docs/103`) — requested 2026-08-25, never
   * answered. RouteViews' license names selling derivative works to third
   * parties explicitly, with no permission step, so it became the default.
   * Measured against RIS on the same day's data: same best origin on
   * 99.90% (v4) / 99.97% (v6) of shared prefixes; 98.71% of random routed
   * IPv4 addresses get the same answer from both. `"ripe-ris"` stays
   * available if RIPE ever grants the logo.
   *
   * Switching is safe against stale data: `purgeDeselectedBgpOriginSource`
   * removes the deselected project's rows, but only after the selected one
   * has completed a run — so pointing this at a source that doesn't exist
   * yet leaves the current data untouched rather than emptying the table.
   * See `docs/104`.
   */
  bgpOriginSource: "ripe-ris" | "routeviews";
  /**
   * Enrichment sources switched off without removing them from the code.
   * Comma-separated registry ids, e.g. `"lacnic-whois-city"`; `"none"` or
   * absent means none. A disabled source is skipped without downloading,
   * and at the start of every enrichment run its earlier rows are removed
   * where that can be done completely (geofeed sources — see
   * `disabled-sources.ts`); for others the run warns that old rows may
   * remain. Re-enable by deleting the id from this list.
   *
   * Added 2026-11-12 for the licensing audit (`docs/106`): sources whose
   * commercial-use terms are unclear are turned off this way rather than
   * deleted, so the decision stays reversible.
   */
  disabledEnrichmentSources: string[];
  /**
   * Whether `bgp-live run` (RIPE RIS Live, `docs/97`) may run. Default
   * false since 2026-11-12: it is RIPE RIS data (`docs/106` G4) and a live,
   * long-running collection, both kept out of the commercial product.
   */
  bgpLiveEnabled: boolean;
  /**
   * The lookup config's `rdapEnabled`, read here too (same key, same
   * default) so `enrich` can act on it: while false, each run removes what
   * earlier live RDAP queries cached — abuse contacts, network names,
   * discovered geofeeds (`rdap-cache-purge.ts`).
   */
  rdapEnabled: boolean;
  /**
   * Where `cycle` publishes the resale `.mmdb` after each run (the copy that
   * could be sold — `export/resale-profile.ts`, `docs/106`). Null/absent:
   * not built. Off by default — set it once selling the file is decided.
   * Use a directory of its own, not the served file's.
   */
  resaleMmdbDir: string | null;
  /** `.mmdb` fields left out of the resale file. Default
   * `"asn_name,rpki_status"`: CAIDA's licence is non-transferable (B3), and
   * the RPKI terms (B5) are not read yet. */
  resaleMmdbExcludeFields: string[];
  /** RIRs whose registry-only `country` is left out of the resale file.
   * Default `"ripencc"` (A2: RIPE's Copyright Statement). */
  resaleMmdbDropCountryFallbackRirs: string[];
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
  dbipLiteIpv6: false,
  bulkCopyIngest: true,
  asnNamePrimary: "caida" as const,
  asnNameFallbackEnabled: false,
  bgpOriginSource: "routeviews" as const,
  disabledEnrichmentSources: [] as string[],
  bgpLiveEnabled: false,
  rdapEnabled: false,
  resaleMmdbDir: null as string | null,
  resaleMmdbExcludeFields: RESALE_DEFAULT_EXCLUDED_FIELDS,
  resaleMmdbDropCountryFallbackRirs: RESALE_DEFAULT_DROP_COUNTRY_FALLBACK_RIRS,
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
      dbipLiteIpv6: DEFAULTS.dbipLiteIpv6,
      bulkCopyIngest: DEFAULTS.bulkCopyIngest,
      asnNamePrimary: DEFAULTS.asnNamePrimary,
      asnNameFallbackEnabled: DEFAULTS.asnNameFallbackEnabled,
      bgpOriginSource: DEFAULTS.bgpOriginSource,
      disabledEnrichmentSources: DEFAULTS.disabledEnrichmentSources,
      bgpLiveEnabled: DEFAULTS.bgpLiveEnabled,
      rdapEnabled: DEFAULTS.rdapEnabled,
      resaleMmdbDir: DEFAULTS.resaleMmdbDir,
      resaleMmdbExcludeFields: DEFAULTS.resaleMmdbExcludeFields,
      resaleMmdbDropCountryFallbackRirs: DEFAULTS.resaleMmdbDropCountryFallbackRirs,
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
  const disabledEnrichmentSources =
    validateAgainstKnown(
      parseListValue(file.obj["disabledEnrichmentSources"], "disabledEnrichmentSources", "none"),
      KNOWN_ENRICHMENT_SOURCES.map((s) => s.id),
      "disabledEnrichmentSources",
    ) ?? [];
  const bgpLiveEnabled = parseBooleanValue(
    file.obj["bgpLiveEnabled"],
    "bgpLiveEnabled",
    DEFAULTS.bgpLiveEnabled,
  );
  const rdapEnabled = parseBooleanValue(file.obj["rdapEnabled"], "rdapEnabled", DEFAULTS.rdapEnabled);
  const resaleDirRaw = parseStringValue(file.obj["resaleMmdbDir"], "resaleMmdbDir", "");
  const resaleMmdbDir = resaleDirRaw.trim() === "" ? null : resaleDirRaw.trim();
  // "none" means an explicitly empty list; absent means the default.
  const resaleMmdbExcludeFields =
    file.obj["resaleMmdbExcludeFields"] === undefined
      ? DEFAULTS.resaleMmdbExcludeFields
      : (validateAgainstKnown(
          parseListValue(file.obj["resaleMmdbExcludeFields"], "resaleMmdbExcludeFields", "none"),
          [...MMDB_RECORD_FIELDS],
          "resaleMmdbExcludeFields",
        ) ?? []);
  const resaleMmdbDropCountryFallbackRirs =
    file.obj["resaleMmdbDropCountryFallbackRirs"] === undefined
      ? DEFAULTS.resaleMmdbDropCountryFallbackRirs
      : (validateAgainstKnown(
          parseListValue(file.obj["resaleMmdbDropCountryFallbackRirs"], "resaleMmdbDropCountryFallbackRirs", "none"),
          KNOWN_SOURCES.map((s) => s.rir),
          "resaleMmdbDropCountryFallbackRirs",
        ) ?? []);
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
  const dbipLiteIpv6 = parseBooleanValue(
    file.obj["dbipLiteIpv6"],
    "dbipLiteIpv6",
    DEFAULTS.dbipLiteIpv6,
  );
  const asnNamePrimary = parseEnumValue(
    file.obj["asnNamePrimary"],
    "asnNamePrimary",
    ["caida", "ripe"] as const,
    DEFAULTS.asnNamePrimary,
  );
  const asnNameFallbackEnabled = parseBooleanValue(
    file.obj["asnNameFallbackEnabled"],
    "asnNameFallbackEnabled",
    DEFAULTS.asnNameFallbackEnabled,
  );
  const bgpOriginSource = parseEnumValue(
    file.obj["bgpOriginSource"],
    "bgpOriginSource",
    ["ripe-ris", "routeviews"] as const,
    DEFAULTS.bgpOriginSource,
  );
  const bulkCopyIngest = parseBooleanValue(
    file.obj["bulkCopyIngest"],
    "bulkCopyIngest",
    DEFAULTS.bulkCopyIngest,
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
    dbipLiteIpv6,
    bulkCopyIngest,
    asnNamePrimary,
    asnNameFallbackEnabled,
    bgpOriginSource,
    disabledEnrichmentSources,
    bgpLiveEnabled,
    rdapEnabled,
    resaleMmdbDir,
    resaleMmdbExcludeFields,
    resaleMmdbDropCountryFallbackRirs,
    sourcePath: file.sourcePath,
  };
}
