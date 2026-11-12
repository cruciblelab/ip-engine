#!/usr/bin/env node
// Loaded first and synchronously: every command below reads DATABASE_URL (and
// other config) from process.env only when its action actually runs, via a
// dynamic `import("@workspace/db")` — but that env var has to already be set
// by then, and nothing else in this codebase reads a .env file for it. A
// shell-exported DATABASE_URL still wins over .env (dotenv's normal,
// intentional precedence — an explicit override should beat a file default),
// so this only fixes the "nothing set it at all" case: without it, a `.env`
// sitting right next to package.json is silently ignored outright.
//
// Deliberately not plain `dotenv/config` (which resolves ".env" against
// process.cwd()): every documented way of running this CLI in the monorepo
// (`pnpm --filter @workspace/cli exec/run ...`) sets cwd to this package's
// own directory, not wherever the operator's terminal happens to be — so a
// cwd-relative lookup would silently miss a .env sitting at the repo root
// (where every other setup instruction in this project's README says to put
// it) and nobody would see an error, just an unset DATABASE_URL. Anchoring to
// this file's own location instead of cwd makes it work the same way
// regardless of how/from-where the command was launched. `src/index.ts` and
// the built `dist/index.mjs` sit at the same depth, so the same relative
// path reaches the repo root from either.
import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
// Static, unlike the DB-touching imports below: `@workspace/shared`'s logger
// has no `@workspace/db` dependency of its own, so importing it here doesn't
// force a database connection onto `--help`/`--version`/etc.
import { logger } from "@workspace/shared";

// quiet: true — dotenv 16.4+ prints a rotating promotional "tip" line
// (third-party services, not related to this project) to stdout on every
// load by default. Fine for someone's personal script; not something a
// customer running this as an API/data product should see on every command.
loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  quiet: true,
});

// A downstream reader closing early (`ip-insight export | head`) makes any
// further stdout write fail with EPIPE. Writable.write() surfaces that
// asynchronously as an 'error' event, and an unhandled 'error' event is
// fatal to the whole Node process — this is expected, benign behavior
// (the reader just stopped wanting more output), not a real export failure,
// so exit quietly instead of crashing with a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

// Every command below dynamically imports what it needs *inside* its
// action, instead of statically at the top of this file. That's not just
// style: `@workspace/db` throws at module load if DATABASE_URL isn't set,
// and `@workspace/collector`/`@workspace/lookup`'s main barrels re-export
// collector.ts/lookup.ts/etc, which import `@workspace/db` too. A static
// top-level import of either
// would mean the *entire* CLI — even `--help` — requires a database, and
// it would make the DB-free `collect --csv` path (see below) impossible:
// importing anything that transitively imports `@workspace/db` defeats the
// whole point of "no database needed". Dynamic imports keep each command's
// dependencies scoped to when it actually runs.
let dbPoolLoaded: { end: () => Promise<void> } | null = null;

const program = new Command();

program
  .name("ip-insight")
  .description(
    "Self-hosted IP-to-ASN/geolocation/threat intelligence database — terminal interface. " +
      "Reads/writes the same Postgres database as the API server and web panel for most " +
      "commands (requires DATABASE_URL); `collect --csv` works without a database at all.",
  )
  .version("0.0.0");

program
  .command("lookup <ip>")
  .description("Look up a single IP address")
  .option("--json", "print raw JSON instead of a formatted summary")
  .action(async (ip: string, opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runLookup } = await import("./commands/lookup");
    await runLookup(ip, opts);
  });

program
  .command("asn <number>")
  .description("Look up an ASN")
  .option("--json", "print raw JSON instead of a formatted summary")
  .action(async (numberStr: string, opts: { json?: boolean }) => {
    const asn = Number(numberStr);
    if (!Number.isInteger(asn) || asn <= 0) {
      console.error(`Invalid ASN: ${numberStr}`);
      process.exitCode = 1;
      return;
    }
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runLookupAsn } = await import("./commands/lookup");
    await runLookupAsn(asn, opts);
  });

program
  .command("collect")
  .description(
    "Fetch RIR delegated-extended files (Layer 1: base allocation data). Runs until complete. " +
      "By default ingests into Postgres; pass --csv to skip the database entirely and write " +
      "plain CSV files instead (no DATABASE_URL needed, no dedup against previous runs).",
  )
  .option(
    "--sources <rirs>",
    "comma-separated RIR names (arin,ripencc,apnic,lacnic,afrinic) — default: all",
  )
  .option(
    "--csv <dir>",
    "skip Postgres entirely; write <rir>-ip-blocks.csv / <rir>-asn-blocks.csv into this directory",
  )
  .option(
    "--resume [jobId]",
    "resume an interrupted collection job instead of starting a new one (omit the id to resume the most recent non-stale one — see `ip-insight jobs`)",
  )
  .action(async (opts: { sources?: string; csv?: string; resume?: string | true }) => {
    const rirs = opts.sources ? opts.sources.split(",").map((s) => s.trim()) : [];
    if (opts.csv) {
      const { runCollectCsv } = await import("./commands/collect-csv");
      await runCollectCsv(rirs, opts.csv);
      return;
    }
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runCollect } = await import("./commands/collect");
    await runCollect(rirs, opts.resume);
  });

program
  .command("enrich")
  .description(
    "Fetch and ingest enrichment sources (BGP origin ASN, geofeeds, GeoNames, cloud ranges, threat lists). Runs until complete.",
  )
  .option(
    "--sources <ids>",
    "comma-separated enrichment source ids (see `ip-insight sources`) — default: all",
  )
  .option(
    "--resume [jobId]",
    "resume an interrupted enrichment job instead of starting a new one (omit the id to resume the most recent non-stale one — see `ip-insight jobs`)",
  )
  .option(
    "--skip-flatten",
    "do NOT refresh ip_intel when the run finishes. Normally every enrich ends by rebuilding it so it can never lag the tables it reads — but on a materialized ip_intel that costs hours regardless of how little was refreshed, which makes `--sources <one-id>` impractical for frequent narrow updates. With this flag, ip_intel (and the .mmdb built from it) keeps serving the previous build until you run `ip-insight flatten` yourself.",
  )
  .action(async (opts: { sources?: string; resume?: string | true; skipFlatten?: boolean }) => {
    const ids = opts.sources ? opts.sources.split(",").map((s) => s.trim()) : [];
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runEnrich } = await import("./commands/enrich");
    await runEnrich(ids, opts.resume, opts.skipFlatten);
  });

program
  .command("refresh")
  .description("Run collect, then enrich, back to back — the full pipeline from scratch (Postgres required).")
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runCollect } = await import("./commands/collect");
    const { runEnrich } = await import("./commands/enrich");
    await runCollect([]);
    await runEnrich([]);
  });

program
  .command("export")
  .description(
    "Export ingested IP/ASN blocks (streams to stdout unless --out or ip-insight.config.json's " +
      "\"exportDir\" is set). Defaults for --format/--out come from ip-insight.config.json when not passed.",
  )
  .option("--format <format>", "csv or ndjson")
  .option("--out <file>", "write to this file instead of stdout")
  .action(async (opts: { format?: string; out?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { loadCollectorConfig } = await import("@workspace/collector/config");
    const config = loadCollectorConfig();
    const format = opts.format === "ndjson" ? "ndjson" : opts.format === "csv" ? "csv" : config.exportFormat;
    // "." is the untouched default (no config file, or the key not set) —
    // only start defaulting to a file when the deployment actually opted
    // into a directory, so anyone without a config file keeps today's
    // "no --out means stdout" behavior exactly.
    const out = opts.out ?? (config.exportDir !== "." ? `${config.exportDir}/blocks.${format}` : undefined);
    const { runExport } = await import("./commands/export");
    await runExport({ format, out });
  });

const snapshot = program
  .command("snapshot")
  .description(
    "Versioned records of what the database said, and deltas between them — the piece a " +
      "consumer needs to keep their own copy in step without re-downloading everything daily.",
  );

snapshot
  .command("create [version]")
  .description("Record the current ip_intel as a named version (defaults to a timestamp)")
  .option("--note <text>", "free-form note stored with the snapshot")
  .action(async (version: string | undefined, opts: { note?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { createSnapshot } = await import("@workspace/collector/snapshots");
    const s = await createSnapshot(version, opts.note);
    console.log(`Snapshot "${s.version}": ${s.prefixCount.toLocaleString("en-US")} prefixes.`);
  });

snapshot
  .command("list")
  .description("List stored snapshots")
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { listSnapshots } = await import("@workspace/collector/snapshots");
    const rows = await listSnapshots();
    if (rows.length === 0) {
      console.log("No snapshots yet.");
      return;
    }
    for (const r of rows) {
      console.log(
        `${r.version.padEnd(22)} ${r.prefixCount.toLocaleString("en-US").padStart(12)} prefixes  ${r.createdAt.toISOString()}${r.note ? `  — ${r.note}` : ""}`,
      );
    }
  });

snapshot
  .command("delta <version>")
  .description("What changed in ip_intel since a snapshot: prefixes added, removed, or re-answered")
  .option("--json", "print the changed networks as JSON instead of a summary")
  .option("--limit <n>", "cap the networks listed (counts stay exact)", "100000")
  .action(async (version: string, opts: { json?: boolean; limit: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { computeDelta } = await import("@workspace/collector/snapshots");
    const d = await computeDelta(version, Number(opts.limit));
    if (opts.json) {
      console.log(JSON.stringify(d));
      return;
    }
    console.log(
      `Since "${d.fromVersion}": +${d.added.toLocaleString("en-US")} added, ` +
        `-${d.removed.toLocaleString("en-US")} removed, ` +
        `~${d.changed.toLocaleString("en-US")} changed.`,
    );
  });

snapshot
  .command("delete <version>")
  .description("Remove a snapshot and its stored hashes")
  .action(async (version: string) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { deleteSnapshot } = await import("@workspace/collector/snapshots");
    console.log((await deleteSnapshot(version)) ? `Deleted "${version}".` : `No snapshot "${version}".`);
  });

const history = program
  .command("history")
  .description(
    "Point-in-time lookups: what a prefix's record actually said on a given date, not just " +
      "whether it changed. Separate from `snapshot`, which only hashes for cheap sync — this " +
      "keeps the old record itself, for forensics/abuse investigation/dispute resolution.",
  );

history
  .command("capture")
  .description(
    "Diff ip_intel against the stored baseline: archive anything changed or removed, bring the " +
      "baseline current. This is history's own standalone job — safe to schedule on its own, " +
      "separate from `enrich`: it takes its own lock so two runs can't overlap, and it reports " +
      "how long it has been since the last successful capture (history cannot be backfilled, so " +
      "a missed day is permanently unobserved). Pass --refresh when running it independently of " +
      "an enrichment, so it diffs current data rather than a stale materialized view.",
  )
  .option(
    "--refresh",
    "refresh materialized ip_intel first — needed when this runs on its own schedule rather than right after an enrich (adds the full refresh time, hours on a large dataset)",
  )
  .action(async (opts: { refresh?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runStandaloneCapture } = await import("@workspace/collector/history");
    const outcome = await runStandaloneCapture({ refreshFirst: opts.refresh });

    if (outcome.skippedLocked) {
      // Not an error: with any periodic schedule this is the expected
      // outcome whenever a capture runs long. Exit 0 so cron stays quiet.
      console.log("Another capture is already running — nothing to do.");
      return;
    }
    if (outcome.daysSinceLastCapture !== null && outcome.daysSinceLastCapture > 1) {
      console.warn(
        `Warning: ${outcome.daysSinceLastCapture} days since the last successful capture. ` +
          "Change in that window was never recorded and cannot be recovered.",
      );
    }
    const { status, result, message } = outcome;
    if (status !== "completed" || !result) {
      console.error(`Capture ${status}: ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Baseline captured: ${result.baselineSize.toLocaleString("en-US")} prefixes ` +
        `(+${result.added.toLocaleString("en-US")} added, ~${result.changed.toLocaleString("en-US")} changed, ` +
        `-${result.removed.toLocaleString("en-US")} removed → archived to history).`,
    );
  });

history
  .command("reset-baseline")
  .description(
    "Clear ops.prefix_baseline only (ops.prefix_history is untouched) — for exactly one " +
      "situation: `history capture` refused to run because TRACKED_FIELDS changed shape since " +
      "the baseline was last written, and diffing as-is would archive every tracked prefix as " +
      "\"changed\", a false signal from the schema edit, not real drift. After this, the next " +
      "`history capture` starts a clean, event-free baseline under the current shape — every " +
      "prefix simply re-inserts as \"added\".",
  )
  .option("--yes", "confirm clearing the baseline")
  .action(async (opts: { yes?: boolean }) => {
    if (!opts.yes) {
      console.error("Pass --yes to confirm clearing ops.prefix_baseline.");
      process.exitCode = 1;
      return;
    }
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { resetBaseline } = await import("@workspace/collector/history");
    await resetBaseline();
    console.log("ops.prefix_baseline cleared. Run `ip-insight history capture` to rebuild it.");
  });

history
  .command("status")
  .description(
    "How much history exists and whether it is enough to derive anything from, plus the last " +
      "capture runs — including ones that were skipped, which is the usual reason history " +
      "silently stops accumulating.",
  )
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { historyMaturity, listCaptures } = await import("@workspace/collector/history");
    const [maturity, captures] = await Promise.all([historyMaturity(), listCaptures(10)]);

    if (opts.json) {
      console.log(JSON.stringify({ maturity, captures }, null, 2));
      return;
    }

    const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

    console.log(`Maturity: ${maturity.level}`);
    console.log(`  ${maturity.summary}`);
    console.log(
      `  ${maturity.captureCount} capture(s) over ${maturity.observationDays} day(s); ` +
        `${maturity.baselineSize.toLocaleString("en-US")} prefixes tracked, ` +
        `${maturity.historyRows.toLocaleString("en-US")} archived change(s).`,
    );
    // The continuity check. Everything above describes what was collected;
    // this is the only line that says whether anything is *missing* — and a
    // gap is unrecoverable, so it is worth its own line every time.
    if (maturity.daysSinceLastCapture === null) {
      console.log("  Continuity: no capture has completed yet.");
    } else if (maturity.daysSinceLastCapture > 1) {
      console.log(
        `  Continuity: GAP — ${maturity.daysSinceLastCapture} days since the last successful ` +
          "capture. That window's change was never observed and cannot be backfilled.",
      );
    } else {
      console.log("  Continuity: current (captured within the last day).");
    }
    console.log(
      `  Storage: ${mb(maturity.historyBytes)} history + ${mb(maturity.baselineBytes)} baseline` +
        (maturity.projectedAnnualHistoryBytes !== null
          ? ` (history growing toward ~${mb(maturity.projectedAnnualHistoryBytes)}/year at the rate so far)`
          : " (too early to project growth)"),
    );
    // On-disk size counts pages a rolled-back or deleted row still occupies
    // until VACUUM reclaims them. A capture that died mid-transaction (see
    // the interrupted sweep in history.ts) leaves exactly that: real
    // megabytes behind zero rows. Said out loud rather than left as an
    // apparent contradiction between the two lines above.
    if (maturity.historyRows === 0 && maturity.historyBytes > 1_048_576) {
      console.log(
        `    ...though history holds 0 rows: that ${mb(maturity.historyBytes)} is space from ` +
          "rolled-back/deleted rows, not yet reclaimed. `VACUUM FULL ops.prefix_history` frees it.",
      );
    }
    if (captures.length === 0) {
      console.log("\nNo capture has ever run.");
      return;
    }
    console.log("\nRecent captures:");
    for (const c of captures) {
      const when = c.startedAt.toISOString().replace("T", " ").slice(0, 19);
      const counts =
        c.status === "completed"
          ? ` +${c.added ?? 0} ~${c.changed ?? 0} -${c.removed ?? 0}`
          : "";
      const why = c.errorMessage ? ` — ${c.errorMessage.split("\n")[0]}` : "";
      console.log(`  ${when}  [${c.trigger}] ${c.status}${counts}${why}`);
    }
  });

history
  .command("at <ip> <date>")
  .description("What did <ip>'s record say on <date> (ISO 8601, e.g. 2026-01-15 or 2026-01-15T12:00:00Z)?")
  .action(async (ip: string, date: string) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const at = new Date(date);
    if (Number.isNaN(at.getTime())) {
      console.error(`Invalid date "${date}"`);
      process.exitCode = 1;
      return;
    }
    const { queryAt } = await import("@workspace/collector/history");
    const row = await queryAt(ip, at);
    if (!row) {
      console.log(`No record for ${ip} at ${at.toISOString()} (no baseline/history covers that address).`);
      return;
    }
    console.log(
      JSON.stringify(
        {
          network: row.network,
          validFrom: row.validFrom.toISOString(),
          validTo: row.validTo?.toISOString() ?? null,
          ...row.record,
        },
        null,
        2,
      ),
    );
  });

history
  .command("timeline <ip>")
  .description("Every record a prefix covering <ip> has held, oldest first")
  .action(async (ip: string) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { historyTimeline } = await import("@workspace/collector/history");
    const rows = await historyTimeline(ip);
    if (rows.length === 0) {
      console.log(`No history for ${ip}.`);
      return;
    }
    for (const r of rows) {
      const span = `${r.validFrom.toISOString()} → ${r.validTo?.toISOString() ?? "now"}`;
      console.log(`${r.network.padEnd(20)} ${span}`);
    }
  });

history
  .command("events <ip>")
  .description(
    "Typed change events (PrefixChanged/ASNChanged/GeoChanged/ThreatChanged) for the prefix " +
      "covering <ip> — the same old/new pair `history timeline` shows, decomposed into which " +
      "specific fact changed instead of two whole records to diff by hand.",
  )
  .option("--json", "Output as JSON")
  .action(async (ip: string, opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { changeEvents } = await import("@workspace/collector/history");
    const events = await changeEvents(ip);
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log(`No typed change events for ${ip}.`);
      return;
    }
    for (const e of events) {
      console.log(`${e.occurredAt.toISOString()}  ${e.type.padEnd(13)} ${e.network}`);
      console.log(`  from: ${JSON.stringify(e.from)}`);
      console.log(`  to:   ${JSON.stringify(e.to)}`);
    }
  });

program
  .command("origin-changes")
  .alias("hijack-scan")
  .description(
    "Prefixes whose most recently recorded origin ASN change is not RPKI-authorized — built " +
      "entirely from `history capture`'s data, no separate collection. Requires at least two " +
      "`history capture` runs to have anything to compare (the first capture has no prior state). " +
      "NOT a real-time hijack detector: its resolution is the capture interval, so a hijack that " +
      "starts and ends between two captures is invisible here. For real-time detection use " +
      "Cloudflare Radar's free public BGP hijack API instead. What this answers that a live feed " +
      "cannot: which prefixes are sitting on an unauthorized origin long-term, once history has " +
      "accumulated for months.",
  )
  .option("--json", "print findings as JSON instead of a summary")
  .action(async (opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { scanHijacks } = await import("@workspace/collector/hijack");
    const findings = await scanHijacks();
    if (opts.json) {
      console.log(JSON.stringify(findings));
      return;
    }
    if (findings.length === 0) {
      console.log("No suspicious origin changes found.");
      return;
    }
    for (const f of findings) {
      console.log(
        `[${f.confidence.toUpperCase()}] ${f.network.padEnd(20)} ` +
          `AS${f.previousAsn ?? "?"} → AS${f.currentAsn ?? "?"} ` +
          `(${f.changedAt.toISOString()}, rpki: ${f.rpkiStatus ?? "?"})`,
      );
    }
    console.log(
      `\n${findings.length} finding(s): ${findings.filter((f) => f.confidence === "high").length} high, ` +
        `${findings.filter((f) => f.confidence === "medium").length} medium confidence.`,
    );
  });

program
  .command("export-mmdb")
  .description(
    "Write the flattened database to a MaxMind DB (.mmdb) file — the deployment format for " +
      "volume: a memory-mapped trie readable by the MaxMind library that already exists for " +
      "every language, with no database on the request path. Built from `ip_intel`, so the " +
      "file and the API can never disagree; run `ip-insight flatten` first.",
  )
  .requiredOption("--out <file>", "path to write the .mmdb to")
  .option("--type <name>", "database_type recorded in the file metadata")
  .action(async (opts: { out: string; type?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { writeFileSync } = await import("node:fs");
    const { exportMmdb } = await import("@workspace/collector/export/mmdb-export");
    const result = await exportMmdb({ databaseType: opts.type });
    writeFileSync(opts.out, result.buffer);
    console.log(
      `Wrote ${opts.out}: ${(result.buffer.length / 1024 / 1024).toFixed(1)} MB, ` +
        `${result.rows.toLocaleString("en-US")} prefixes, ` +
        `${result.recordCount.toLocaleString("en-US")} distinct records, ` +
        `${result.nodeCount.toLocaleString("en-US")} tree nodes` +
        (result.skipped > 0 ? `, ${result.skipped} skipped (unparseable network)` : ""),
    );
  });

program
  .command("flatten")
  .description(
    "Create/refresh `ip_intel`, the single flattened relation a consumer can query with one " +
      "statement instead of joining the per-source tables by hand. Form comes from " +
      "ip-insight.config.json's \"ipIntelMode\" (view | materialized | off) unless --mode is passed. " +
      "`enrich` already does this at the end of every run; this is for doing it on demand.",
  )
  .option("--mode <mode>", "view, materialized, or off — overrides ipIntelMode for this run")
  .option("--refresh", "recompute a materialized ip_intel without recreating it")
  .action(async (opts: { mode?: string; refresh?: boolean }) => {
    const { pool, ensureIpIntel, refreshIpIntel, ipIntelState } = await import("@workspace/db");
    dbPoolLoaded = pool;
    if (opts.refresh) {
      // Same shape as the materialized build below: one blocking statement
      // (`REFRESH MATERIALIZED VIEW CONCURRENTLY`), no sub-progress to
      // report, can take just as long as the original build since it
      // recomputes the whole thing rather than an incremental diff.
      const { withHeartbeat: heartbeatRefresh } = await import("@workspace/shared");
      console.log(
        "Refreshing materialized ip_intel — recomputes the whole relation, not an incremental " +
          "diff, so this can take as long as the original build. Silence below isn't a hang; a " +
          "line prints every 30s to confirm it's alive.",
      );
      const rows = await heartbeatRefresh(
        30_000,
        (elapsedSec) => console.log(`  still refreshing... (${elapsedSec}s elapsed)`),
        () => refreshIpIntel(),
        () =>
          pool
            .query("SELECT 1")
            .then(() => true)
            .catch(() => false),
        (elapsedSec, consecutiveFailures) =>
          console.log(
            `  WARNING: database connection check failed (${consecutiveFailures}x) at ${elapsedSec}s — ` +
              "the refresh may be stuck on a dead connection, not just slow.",
          ),
      );
      console.log(
        rows === null
          ? "ip_intel is not materialized — nothing to refresh (a plain view is always current)."
          : `Refreshed ip_intel: ${rows.toLocaleString("en-US")} rows.`,
      );
      return;
    }
    const { loadCollectorConfig } = await import("@workspace/collector/config");
    const mode = opts.mode ?? loadCollectorConfig().ipIntelMode;
    if (mode !== "view" && mode !== "materialized" && mode !== "off") {
      console.error(`Invalid --mode "${mode}" (expected view, materialized, or off)`);
      process.exitCode = 1;
      return;
    }
    const { withHeartbeat } = await import("@workspace/shared");
    if (mode === "materialized") {
      console.log(
        "Building materialized ip_intel — one long statement with no sub-progress to report. " +
          "With the SP-GiST indexes `push` creates on the source tables, this is typically " +
          "minutes, not hours (measured: 5-13 min on ~3.2M rows — see docs/94 for the full " +
          "before/after). Still no sub-progress either way, so a line prints every 30s to " +
          "confirm it's alive rather than hung.",
      );
    }
    const rows = await withHeartbeat(
      30_000,
      (elapsedSec) => console.log(`  still building... (${elapsedSec}s elapsed)`),
      () => ensureIpIntel(mode),
      () =>
        pool
          .query("SELECT 1")
          .then(() => true)
          .catch(() => false),
      (elapsedSec, consecutiveFailures) =>
        console.log(
          `  WARNING: database connection check failed (${consecutiveFailures}x) at ${elapsedSec}s — ` +
            "the build may be stuck on a dead connection, not just slow.",
        ),
    );
    const state = await ipIntelState();
    console.log(
      state === "off"
        ? "ip_intel dropped."
        : `ip_intel is now a ${state === "materialized" ? "materialized view" : "view"}` +
            (rows !== null ? ` (${rows.toLocaleString("en-US")} rows)` : "") +
            ".\nQuery it with:  SELECT * FROM ip_intel WHERE network >>= '1.1.1.1' ORDER BY masklen(network) DESC LIMIT 1;",
    );
  });

program
  .command("sources")
  .description("List available collection (--sources for `collect`) and enrichment (--sources for `enrich`) source ids")
  .action(async () => {
    const { KNOWN_SOURCES, listEnrichmentSources } = await import("@workspace/collector");
    dbPoolLoaded = (await import("@workspace/db")).pool;
    console.log("== Collection sources (RIR) ==");
    for (const s of KNOWN_SOURCES) {
      console.log(`  ${s.rir.padEnd(10)} ${s.displayName} (${s.region})`);
    }
    console.log("\n== Enrichment sources ==");
    for (const s of listEnrichmentSources()) {
      console.log(`  ${s.id.padEnd(22)} ${s.displayName} [${s.kind}]`);
    }
  });

program
  .command("config")
  .description(
    "Show the effective ip-insight.config.json (or IP_INSIGHT_CONFIG) settings — no database needed",
  )
  .action(async () => {
    const { loadCollectorConfig } = await import("@workspace/collector/config");
    const { loadLookupConfig } = await import("@workspace/lookup/config");
    const cfg = loadCollectorConfig();
    const lookupCfg = loadLookupConfig();
    if (!cfg.sourcePath && !lookupCfg.sourcePath) {
      console.log(
        "No config file found (looked for ./ip-insight.config.json, or $IP_INSIGHT_CONFIG). " +
          "Default: collect/enrich everything, all lookup features on, unless overridden.",
      );
      return;
    }
    console.log(`Config file: ${cfg.sourcePath ?? lookupCfg.sourcePath}`);
    console.log(`  collection:            ${cfg.collection ? cfg.collection.join(", ") : "(all — database_full)"}`);
    console.log(`  collectionStatuses:    ${cfg.collectionStatuses ? cfg.collectionStatuses.join(", ") : "(all)"}`);
    console.log(`  enrichment:            ${cfg.enrichment ? cfg.enrichment.join(", ") : "(all — database_full)"}`);
    console.log(`  lookupFeatures:        ${lookupCfg.features ? lookupCfg.features.join(", ") : "(all)"}`);
    console.log(
      `  rdapEnabled:           ${lookupCfg.rdapEnabled}` +
        (lookupCfg.rdapEnabled
          ? "  (lookups may query RIR RDAP live: abuse contacts, network names, geofeed discovery)"
          : "  (no live RDAP queries — lookups answer from local tables only, docs/106 G1)"),
    );
    console.log(`  batchSize:             ${cfg.batchSize}`);
    console.log(
      `  fetchRetry:            ${cfg.fetchRetry.maxAttempts} attempts, ${cfg.fetchRetry.baseDelayMs}ms base delay, ${cfg.fetchRetry.timeoutMs}ms timeout`,
    );
    console.log(
      `  sourceRetryMaxAttempts: ${cfg.sourceRetryMaxAttempts}`,
    );
    console.log(`  exportFormat:          ${cfg.exportFormat}`);
    console.log(`  exportDir:             ${cfg.exportDir}`);
    console.log(`  summaryDir:            ${cfg.summaryDir}`);
    console.log(`  cacheSize:             ${lookupCfg.cacheSize}`);
    console.log(`  cacheTtlMinutes:       ${lookupCfg.cacheTtlMinutes}`);
    console.log(`  reverseDnsTimeoutMs:   ${lookupCfg.reverseDnsTimeoutMs}`);
    console.log(`  bulkLookupConcurrency: ${lookupCfg.bulkLookupConcurrency}`);
    console.log(`  checkpointingEnabled:  ${cfg.checkpointingEnabled}`);
    console.log(`  checkpointIdFormat:    ${cfg.checkpointIdFormat}`);
    console.log(`  checkpointStaleAfterHours:      ${cfg.checkpointStaleAfterHours}`);
    console.log(`  checkpointAutoCleanupStaleJobs: ${cfg.checkpointAutoCleanupStaleJobs}`);
    console.log(`  maintenanceSchedulerEnabled:    ${cfg.maintenanceSchedulerEnabled}`);
    console.log(`  backupEnabled:         ${cfg.backupEnabled}`);
    console.log(`  backupIntervalHours:   ${cfg.backupIntervalHours}`);
    console.log(`  backupRetentionCount:  ${cfg.backupRetentionCount}`);
    console.log(`  backupDir:             ${cfg.backupDir}`);
    console.log(`  sleepModeEnabled:      ${cfg.sleepModeEnabled}`);
    console.log(`  sleepModeIdleHours:    ${cfg.sleepModeIdleHours}`);
    console.log(`  ipIntelMode:           ${cfg.ipIntelMode}`);
    // Printed with its cost, not as a bare boolean: the whole reason this
    // defaults off is that turning it on roughly doubles the dbip-lite
    // source's row count and every rebuild that reads it.
    console.log(
      `  dbipLiteIpv6:          ${cfg.dbipLiteIpv6}` +
        (cfg.dbipLiteIpv6
          ? "  (IPv6 ranges ingested — ~8.5M extra rows)"
          : "  (IPv4 only; enabling adds ~8.5M rows, see docs/99)"),
    );
    // Worth printing even though it defaults on: it is the difference
    // between a dbip-lite load that takes minutes and one that takes an
    // hour, so an operator investigating a slow run needs to see whether
    // something switched it off.
    console.log(
      `  bulkCopyIngest:        ${cfg.bulkCopyIngest}` +
        (cfg.bulkCopyIngest
          ? "  (COPY-based bulk load — the fast path, see docs/100)"
          : "  (batched INSERTs — the old path, measured ~5x slower, see docs/100)"),
    );
    console.log(
      `  asnNamePrimary:        ${cfg.asnNamePrimary}` +
        `  (unconditional writes; the other ASN-name source only fills what this one has no entry for)`,
    );
    console.log(
      `  asnNameFallbackEnabled: ${cfg.asnNameFallbackEnabled}` +
        (cfg.asnNameFallbackEnabled
          ? "  (the non-primary source still runs, closing coverage gaps)"
          : "  (the non-primary source is fully skipped — no download, no ASN-name gap-filling)"),
    );
    console.log(
      `  bgpOriginSource:       ${cfg.bgpOriginSource}` +
        `  (exclusive — the other collector project does not run; switching purges its rows once the selected one completes)`,
    );
    console.log(
      `  disabledEnrichmentSources: ${cfg.disabledEnrichmentSources.length ? cfg.disabledEnrichmentSources.join(", ") : "(none)"}` +
        "  (skipped without downloading; their geofeed rows are removed at the start of each enrich run)",
    );
    console.log(
      `  bgpLiveEnabled:        ${cfg.bgpLiveEnabled}` +
        (cfg.bgpLiveEnabled ? "  (bgp-live run allowed — RIPE RIS Live)" : "  (bgp-live run refuses — RIPE RIS Live kept off, docs/106 G4)"),
    );
  });

program
  .command("summary")
  .description(
    "Write a JSON snapshot of what's in the database (block counts by RIR/family/status, enrichment table sizes, last run per source) and print it. " +
      "Default --out comes from ip-insight.config.json's \"summaryDir\" when not passed.",
  )
  .option("--out <dir>", "output directory for db-summary.json")
  .action(async (opts: { out?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { loadCollectorConfig } = await import("@workspace/collector/config");
    opts.out = opts.out ?? loadCollectorConfig().summaryDir;
    const { runSummary } = await import("./commands/summary");
    await runSummary(opts.out);
  });

const backup = program
  .command("backup")
  .description(
    "Manage pg_dump database backups (requires the pg_dump/pg_restore binaries on PATH). " +
      "ip-insight.config.json's backupEnabled/backupIntervalHours/backupRetentionCount control " +
      "automatic snapshots taken by a running server; these subcommands work regardless.",
  );

backup
  .command("create")
  .description("Take a backup snapshot now")
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBackupCreate } = await import("./commands/backup");
    await runBackupCreate();
  });

backup
  .command("list")
  .description("List backup history")
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBackupList } = await import("./commands/backup");
    await runBackupList();
  });

backup
  .command("restore <file>")
  .description("Restore the database from a backup file — DESTRUCTIVE, overwrites current data")
  .option("--yes", "confirm the destructive restore")
  .action(async (file: string, opts: { yes?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBackupRestore } = await import("./commands/backup");
    await runBackupRestore(file, opts.yes ?? false);
  });

const mmdb = program
  .command("mmdb")
  .description(
    "Build, validate and publish the served .mmdb. Promotion is gated on the new file answering " +
      "correctly, not merely on the build not throwing — a file that writes cleanly and contains " +
      "a fraction of the data is the failure that actually happens.",
  );

mmdb
  .command("publish")
  .description(
    "Build a new .mmdb, verify it with the real MaxMind reader against a golden set and against " +
      "the currently-served file's size, and only then repoint current.mmdb. A rejected candidate " +
      "is kept on disk and the previous file keeps serving.",
  )
  .requiredOption("--dir <dir>", "directory holding the timestamped files and current.mmdb")
  .option("--type <name>", "database_type recorded in the file metadata")
  .option("--golden <file>", "JSON file of golden cases, replacing the built-in defaults")
  .option("--min-ratio <n>", "reject below this fraction of the previous file's prefix count (default 0.8)")
  .option("--retain <n>", "timestamped files to keep (default 5)")
  .action(async (opts: { dir: string; type?: string; golden?: string; minRatio?: string; retain?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { publishMmdb } = await import("@workspace/collector/export/mmdb-publish");
    const r = await publishMmdb({
      dir: opts.dir,
      databaseType: opts.type,
      goldenSetPath: opts.golden,
      minPrefixRatio: opts.minRatio ? Number(opts.minRatio) : undefined,
      retain: opts.retain ? Number(opts.retain) : undefined,
    });
    for (const c of r.checks) console.log(`  [${c.ok ? "ok" : "FAIL"}] ${c.name} — ${c.detail}`);
    if (r.status === "published") {
      console.log(`\nPublished ${r.filePath} (${(r.sizeBytes / 1048576).toFixed(1)} MB, ${r.prefixes.toLocaleString("en-US")} prefixes).`);
      return;
    }
    console.error(`\nRejected — current.mmdb unchanged. Candidate kept at ${r.filePath} for inspection.`);
    process.exitCode = 1;
  });

mmdb
  .command("rollback")
  .description("Point current.mmdb back at the previously published file — for a regression validation didn't catch.")
  .requiredOption("--dir <dir>", "directory holding the .mmdb files")
  .action(async (opts: { dir: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { rollbackMmdb } = await import("@workspace/collector/export/mmdb-publish");
    console.log(`current.mmdb now points at ${await rollbackMmdb(opts.dir)}`);
  });

mmdb
  .command("status")
  .description("What is serving, and every candidate that was rejected before it could.")
  .action(async () => {
    const { pool, db, mmdbPublishesTable } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { desc } = await import("drizzle-orm");
    const rows = await db.select().from(mmdbPublishesTable).orderBy(desc(mmdbPublishesTable.startedAt)).limit(10);
    if (rows.length === 0) {
      console.log("No .mmdb has ever been published.");
      return;
    }
    for (const r of rows) {
      const when = r.startedAt.toISOString().replace("T", " ").slice(0, 19);
      const size = r.sizeBytes ? `${(r.sizeBytes / 1048576).toFixed(1)}MB` : "—";
      console.log(`  ${when}  ${r.status.padEnd(9)} ${size.padStart(8)}  ${r.prefixes?.toLocaleString("en-US") ?? "—"} prefixes`);
      const failed = (r.checks as Array<{ name: string; ok: boolean; detail: string }> | null)?.filter((c) => !c.ok);
      for (const c of failed ?? []) console.log(`      failed: ${c.name} — ${c.detail}`);
      if (r.errorMessage) console.log(`      error: ${r.errorMessage.split("\n")[0]}`);
    }
  });

program
  .command("cycle")
  .description(
    "One unattended pass: collect, then enrich (which refreshes ip_intel and captures history " +
      "if enabled). Built for cron — refuses to overlap with a running cycle, continues past a " +
      "failed phase instead of stopping, and logs everything to logs/ip-insight.log so the run " +
      "is reviewable after the terminal is gone. Exits non-zero if any phase failed.",
  )
  .option("--sources <rirs>", "comma-separated RIR names for the collect phase — default: all")
  .option(
    "--enrich-sources <ids>",
    "comma-separated enrichment source ids for the enrich phase — default: all",
  )
  .action(async (opts: { sources?: string; enrichSources?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runCycle } = await import("./commands/cycle");
    await runCycle(opts);
  });

program
  .command("status")
  .description(
    "Show current/last collection and enrichment job status, history maturity, and ingestion health",
  )
  .option(
    "--detail",
    "Per-source timestamps, download sizes, durations and URLs instead of one line each",
  )
  .option(
    "--failures",
    "Only sources whose last run genuinely failed (not the benign 'unchanged since last run' " +
      "skip) — full untruncated error message and URL for each, so a source that started " +
      "blocking this deployment or changed its feed format is easy to spot after a `cycle` " +
      "without scrolling past everything that's fine. Implies --detail scope; combine with " +
      "--json to script an alert on a nonzero count.",
  )
  .option("--json", "Output everything as JSON")
  .action(async (opts: { detail?: boolean; failures?: boolean; json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runStatus } = await import("./commands/status");
    await runStatus(opts);
  });

program
  .command("resources")
  .description(
    "What this is actually costing right now: database size (largest tables/materialized views " +
      "first — history included), log file and backup directory sizes, plus system RAM/load and " +
      "any running node/postgres processes (best-effort via `ps aux`).",
  )
  .option("--json", "Output everything as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runResources } = await import("./commands/resources");
    await runResources(opts);
  });

program
  .command("classify-test <pattern>")
  .description(
    "Test a candidate ASN-name classification pattern (for asn-types.ts's RULES) against the real, " +
      "full asn_blocks.name column — formalizes the throwaway audit-*.ts script this project has " +
      "hand-written every time a new pattern was added. Reports total matches, how many are new " +
      "captures (currently unclassified) vs already caught by an earlier rule, and a sample for " +
      "manual precision review. Scoped to asn_blocks.name only — reverse-DNS patterns " +
      "(connection-type.ts) have no bulk column to test against, see that file's own header comment.",
  )
  .option("--flags <flags>", "RegExp flags, default \"i\"", "i")
  .option("--sample <n>", "How many new-capture samples to print", (v) => Number(v), 30)
  .option("--compare-to <pattern>", "A second pattern to report a match-count delta against")
  .option("--json", "Output everything as JSON")
  .action(
    async (
      pattern: string,
      opts: { flags?: string; sample?: number; compareTo?: string; json?: boolean },
    ) => {
      const { pool } = await import("@workspace/db");
      dbPoolLoaded = pool;
      const { runClassifyTest } = await import("./commands/classify-test");
      await runClassifyTest(pattern, opts);
    },
  );

const bgpLive = program
  .command("bgp-live")
  .description(
    "Watch RIPE's live BGP feed (RIS Live) and record origin changes as they happen — the " +
      "real-time counterpart to `origin-changes`, which can only see as finely as the gap " +
      "between two `history capture` runs. Watches everything, stores only what disagrees with " +
      "the origins already in `bgp_origin_ranges`.",
  );

bgpLive
  .command("run")
  .description(
    "Connect to RIS Live and record origin changes until stopped. Seeds its comparison " +
      "baseline from `bgp_origin_ranges` at startup (so it detects changes from the first " +
      "second rather than after warming up), then holds it in memory — measured at ~174 MB " +
      "for 1.5M prefixes. Downloads a lot and stores very little: the full firehose is about " +
      "7 GB/hour off the wire, of which the part worth keeping is a handful of rows.",
  )
  .option("--duration <time>", "stop automatically after e.g. 30s, 45m, 3h")
  .option("--collector <rrc>", "subscribe to one RIS collector (e.g. rrc00) instead of all — about 3.7 GB/hour rather than 7")
  .option("--peer <ip>", "subscribe to a single peer — the cheapest scope, about 7 MB/hour, but sees far less")
  .option("--max-data <mb>", "stop once this many MB have been downloaded — a guard for metered connections")
  .option("--flush-seconds <n>", "how often to write buffered events and refresh counters (default 15)")
  .action(async (opts: { duration?: string; collector?: string; peer?: string; maxData?: string; flushSeconds?: string }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBgpLiveRun } = await import("./commands/bgp-live");
    await runBgpLiveRun(opts);
  });

bgpLive
  .command("status")
  .description("Recent bgp-live sessions and what each one saw — including one running right now")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBgpLiveStatus } = await import("./commands/bgp-live");
    await runBgpLiveStatus(opts);
  });

bgpLive
  .command("events")
  .description(
    "Origin changes recorded so far, most widely-propagated first, with current RPKI status " +
      "joined at read time. Not a hijack verdict — see the note the command prints.",
  )
  .option("--limit <n>", "how many to show (default 50)")
  .option("--min-peers <n>", "only events reported by at least this many RIS peers")
  .option(
    "--snapshot-only",
    "hide weak-baseline events (prefixes absent from bgp_origin_ranges, where the \"previous\" origin is only this session's first sighting — ordinary MOAS prefixes land there)",
  )
  .option("--json", "Output as JSON")
  .action(async (opts: { limit?: string; minPeers?: string; snapshotOnly?: boolean; json?: boolean }) => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBgpLiveEvents } = await import("./commands/bgp-live");
    await runBgpLiveEvents(opts);
  });

bgpLive
  .command("stop")
  .description("Ask a running listener (in another terminal) to finish cleanly")
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runBgpLiveStop } = await import("./commands/bgp-live");
    await runBgpLiveStop();
  });

program
  .command("jobs")
  .description(
    "List interrupted collect/enrich jobs (crashed/killed mid-run) that can be resumed with --resume",
  )
  .action(async () => {
    const { pool } = await import("@workspace/db");
    dbPoolLoaded = pool;
    const { runJobs } = await import("./commands/jobs");
    await runJobs();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    // Drizzle's own query-failure errors set `.message` to just the query
    // text and params — the actual database-side reason (a real Postgres
    // error, a connection failure, ...) lives on `.cause` and was silently
    // dropped here before, leaving every DB error looking like "Failed
    // query: <sql>" with no way to tell what actually went wrong.
    if (err instanceof Error && err.cause) {
      console.error("Caused by:", err.cause instanceof Error ? err.cause.message : err.cause);
    }
    // console.error alone is invisible to a cron run: DEPLOY.md's documented
    // cron entry redirects stdout/stderr to /dev/null on the assumption that
    // "everything meaningful goes to the log file" — true for every command
    // that gets as far as its own action (they all log through `logger`),
    // false for anything that fails before that point (bad DATABASE_URL, a
    // config parse error, an advisory lock acquired but never released by a
    // killed prior run) or throws past the action's own error handling.
    // `logger` dual-writes to logs/ip-insight.log regardless of how the
    // shell redirected stdout/stderr, which is the only way this is visible
    // the next morning instead of just... not.
    logger.error({ err }, "CLI command failed");
    process.exitCode = 1;
  } finally {
    // The pg Pool keeps idle connections open, which would otherwise keep
    // the process alive forever after a one-shot CLI command finishes. Only
    // relevant if this run actually touched the database (e.g. not for
    // `collect --csv`, `--help`, or `--version`).
    if (dbPoolLoaded) {
      await dbPoolLoaded.end().catch(() => undefined);
    }
  }
}

void main();
