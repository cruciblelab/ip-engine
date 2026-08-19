import { startEnrichment, loadEnrichmentStatus, loadCollectorConfig, listResumableEnrichmentJobs } from "@workspace/collector";
import { appendRunHistory } from "@workspace/shared";

export async function runEnrich(
  sourceIds: string[],
  resume?: string | true,
  skipFlatten?: boolean,
): Promise<void> {
  if (resume !== undefined) {
    const ref = resume === true ? await pickDefaultResumeRef() : resume;
    const job = await startEnrichment(undefined, {
      resumeJobRef: ref,
      skipIpIntelRefresh: skipFlatten,
    });
    console.log(`Resuming enrichment job ${job.id}.`);
    await pollUntilDone();
    return;
  }
  if (sourceIds.length === 0) {
    const cfg = loadCollectorConfig();
    if (cfg.sourcePath && cfg.enrichment) {
      console.log(
        `Using "enrichment" sources from ${cfg.sourcePath}: ${cfg.enrichment.join(", ")}`,
      );
    }
  }
  const job = await startEnrichment(sourceIds.length > 0 ? sourceIds : undefined, {
    skipIpIntelRefresh: skipFlatten,
  });
  console.log(`Enrichment job ${job.id} started.`);
  if (skipFlatten) {
    console.log(
      "--skip-flatten: ip_intel will NOT be refreshed at the end of this run. Source tables " +
        "will be newer than it, and the .mmdb export (which builds from ip_intel) keeps serving " +
        "the previous build until you run `ip-insight flatten`.",
    );
  }
  await pollUntilDone();
}

async function pickDefaultResumeRef(): Promise<string> {
  const jobs = await listResumableEnrichmentJobs();
  const candidate = jobs.find((j) => !j.stale);
  if (!candidate) {
    throw new Error(
      jobs.length > 0
        ? "All interrupted enrichment jobs are stale — resume one explicitly with its id (see `ip-insight jobs`)."
        : "No interrupted enrichment job to resume.",
    );
  }
  return candidate.id;
}

const POLL_MS = 1500;
/** How long a source's line can stay byte-for-byte identical before we print
 * a heartbeat anyway. Several enrichment sources (asn-profile, asn-reach,
 * neighborhood-stats) are one big SQL statement with no row-by-row progress
 * to report — the counter genuinely sits at 0 the entire time they run, so
 * without this the terminal goes silent for as long as that query takes and
 * looks indistinguishable from a hang. */
const HEARTBEAT_MS = 12_000;
const ACTIVE_STATUSES = new Set(["downloading", "parsing"]);

async function pollUntilDone(): Promise<void> {
  const printed = new Map<string, string>();
  const stableSince = new Map<string, number>();
  const lastHeartbeatAt = new Map<string, number>();
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const s = await loadEnrichmentStatus();
    const now = Date.now();
    for (const src of s.sources) {
      const line = `[${src.sourceId}] ${src.status} — ${src.recordsIngested.toLocaleString()} ingested${
        src.errorMessage ? ` — ERROR: ${src.errorMessage}` : ""
      }`;
      if (printed.get(src.sourceId) !== line) {
        console.log(line);
        printed.set(src.sourceId, line);
        stableSince.set(src.sourceId, now);
        lastHeartbeatAt.set(src.sourceId, now);
        continue;
      }
      if (!ACTIVE_STATUSES.has(src.status)) continue;
      const lastBeat = lastHeartbeatAt.get(src.sourceId) ?? now;
      if (now - lastBeat >= HEARTBEAT_MS) {
        const elapsedSec = Math.round((now - (stableSince.get(src.sourceId) ?? now)) / 1000);
        console.log(
          `[${src.sourceId}] ${src.status} — still running (${elapsedSec}s, no counter to move — this step is one database query, not a stream)`,
        );
        lastHeartbeatAt.set(src.sourceId, now);
      }
    }
    if (!s.isActive) {
      const doneLine = `Done. Total ingested: ${s.job?.totalIngested.toLocaleString() ?? 0}, skipped: ${
        s.job?.totalSkipped.toLocaleString() ?? 0
      }, status: ${s.job?.status ?? "unknown"}.`;
      console.log(doneLine);
      appendRunHistory(`${new Date().toISOString()} [enrich] job=${s.job?.id ?? "?"} ${doneLine}`);
      break;
    }
  }
}
