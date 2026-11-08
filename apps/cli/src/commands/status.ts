import { loadStatus, loadEnrichmentStatus, checkIngestionHealth } from "@workspace/collector";
import { historyMaturity } from "@workspace/collector/history";

export interface StatusOptions {
  /** Per-source timestamps, sizes and throughput rather than one line each. */
  detail?: boolean;
  /** Only sources whose last run genuinely failed — see the CLI option's own
   * help text for why this exists (194+ enrichment sources as of the 2026-
   * 08-24 geofeed batch makes scanning past the healthy ones for the couple
   * that broke real friction, not a cosmetic annoyance). */
  failures?: boolean;
  json?: boolean;
}

/** A source whose last run is worth an operator's attention right now:
 * genuinely `failed`, not the benign "unchanged since last run" `skipped`
 * that most sources report on most runs. */
function isRealFailure(status: string): boolean {
  return status === "failed";
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatWhen(date: Date | null): string {
  if (!date) return "never";
  const ageMs = Date.now() - date.getTime();
  const stamp = date.toISOString().replace("T", " ").slice(0, 16);
  const days = Math.floor(ageMs / 86_400_000);
  if (days >= 1) return `${stamp} (${days}d ago)`;
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours >= 1) return `${stamp} (${hours}h ago)`;
  return `${stamp} (${Math.max(0, Math.floor(ageMs / 60_000))}m ago)`;
}

function formatDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (!startedAt || !endedAt) return "—";
  const seconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  const [collection, enrichment, health, maturity] = await Promise.all([
    loadStatus(),
    loadEnrichmentStatus(),
    checkIngestionHealth(),
    historyMaturity(),
  ]);

  if (opts.failures) {
    const failedCollection = collection.sources.filter((s) => isRealFailure(s.status));
    const failedEnrichment = enrichment.sources.filter((s) => isRealFailure(s.status));

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            failureCount: failedCollection.length + failedEnrichment.length,
            collection: failedCollection,
            enrichment: failedEnrichment,
          },
          null,
          2,
        ),
      );
      return;
    }

    const total = failedCollection.length + failedEnrichment.length;
    console.log(`== Failures (${total}) ==`);
    if (total === 0) {
      console.log("  None. Every source's last run either succeeded or was a benign skip.");
      return;
    }
    for (const s of failedCollection) {
      console.log(`  [collect:${s.rir}] failed ${formatWhen(s.endedAt ?? s.startedAt)}`);
      if (s.errorMessage) console.log(`      ${s.errorMessage}`);
    }
    for (const s of failedEnrichment) {
      console.log(`  [enrich:${s.sourceId}] (${s.kind}) failed ${formatWhen(s.endedAt ?? s.startedAt)}`);
      if (s.url) console.log(`      ${s.url}`);
      // Full message here, not the [0]-truncated one line the non-failures
      // view uses elsewhere in this file — a stack trace or a server's
      // actual response body is exactly what's needed to tell "this source
      // changed its feed format" apart from "this source started blocking
      // this deployment's IP range" without re-running anything.
      if (s.errorMessage) console.log(`      ${s.errorMessage}`);
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ collection, enrichment, health, history: maturity }, null, 2));
    return;
  }

  console.log("== Collection ==");
  console.log(`Active: ${collection.isActive}`);
  if (collection.job) {
    console.log(
      `Last job: ${collection.job.status}, ${collection.job.totalIngested.toLocaleString()} ingested`,
    );
  }
  for (const s of collection.sources) {
    if (opts.detail) {
      console.log(`  [${s.rir}] ${s.status} — ${s.recordsIngested.toLocaleString()} ingested`);
      console.log(
        `      ran ${formatWhen(s.endedAt ?? s.startedAt)}, took ${formatDuration(s.startedAt, s.endedAt)}, ` +
          `${formatBytes(s.bytesDownloaded)} downloaded`,
      );
      console.log(
        `      v4 ${s.ipv4Count.toLocaleString()} · v6 ${s.ipv6Count.toLocaleString()} · ` +
          `ASN ${s.asnCount.toLocaleString()} · skipped ${s.recordsSkipped.toLocaleString()}`,
      );
      if (s.errorMessage) console.log(`      error: ${s.errorMessage.split("\n")[0]}`);
    } else {
      console.log(`  [${s.rir}] ${s.status} — ${s.recordsIngested.toLocaleString()}`);
    }
  }

  console.log("\n== Enrichment ==");
  console.log(`Active: ${enrichment.isActive}`);
  if (enrichment.job) {
    console.log(
      `Last job: ${enrichment.job.status}, ${enrichment.job.totalIngested.toLocaleString()} ingested`,
    );
  }
  for (const s of enrichment.sources) {
    if (opts.detail) {
      console.log(
        `  [${s.sourceId}] (${s.kind}) ${s.status} — ${s.recordsIngested.toLocaleString()} ingested`,
      );
      console.log(
        `      ran ${formatWhen(s.endedAt ?? s.startedAt)}, took ${formatDuration(s.startedAt, s.endedAt)}, ` +
          `${formatBytes(s.bytesDownloaded)} downloaded, skipped ${s.recordsSkipped.toLocaleString()}`,
      );
      if (s.url) console.log(`      ${s.url}`);
      if (s.errorMessage) console.log(`      error: ${s.errorMessage.split("\n")[0]}`);
    } else {
      console.log(`  [${s.sourceId}] ${s.status} — ${s.recordsIngested.toLocaleString()}`);
    }
  }

  // History is reported here rather than only under `history status` because
  // the question it answers — "is there enough history to trust anything
  // derived from it?" — is part of knowing whether this deployment is ready,
  // not a separate topic. A young database is not broken, but signals read
  // off it mean something different, and that shouldn't need looking up.
  console.log(`\n== History: ${maturity.level} ==`);
  console.log(`  ${maturity.summary}`);
  console.log(
    `  ${maturity.captureCount} capture(s) over ${maturity.observationDays} day(s); ` +
      `${maturity.baselineSize.toLocaleString()} prefixes tracked, ` +
      `${maturity.historyRows.toLocaleString()} archived change(s).`,
  );
  if (maturity.lastCaptureAt) {
    console.log(
      `  Last capture: ${formatWhen(maturity.lastCaptureAt)} — ${maturity.lastCaptureStatus}`,
    );
  }
  // A capture that keeps getting skipped is the failure mode this whole
  // subsystem exists to make visible: nothing errors, the tables just stop
  // growing. Say so here rather than leaving it to `history status`.
  if (maturity.lastCaptureStatus === "skipped") {
    console.log("  ⚠ The last capture was skipped — run `ip-insight history status` for the reason.");
  }

  console.log(`\n== Ingestion health: ${health.ok ? "OK" : "DEGRADED"} ==`);
  for (const check of health.checks) {
    if (check.status !== "ok") {
      console.log(
        `  [${check.kind}:${check.source}] ${check.status} (${
          check.recordsIngested?.toLocaleString() ?? "never"
        } < expected ${check.expectedMinimum.toLocaleString()})`,
      );
    }
  }
}
