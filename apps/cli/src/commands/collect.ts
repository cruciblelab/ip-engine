import { startCollection, loadStatus, loadCollectorConfig, listResumableCollectionJobs } from "@workspace/collector";
import { appendRunHistory } from "@workspace/shared";

function fmtRate(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k/s` : `${n.toFixed(0)}/s`;
}

/** Polls collection status to completion, printing a progress line per
 * source as it changes. Runs in-process — the job itself (started by
 * startCollection) keeps running as long as this process is alive, so the
 * CLI staying up *is* what drives it to completion, same as the API
 * server would if left running. */
export async function runCollect(rirs: string[], resume?: string | true): Promise<void> {
  if (resume !== undefined) {
    // `--resume` with no id: pick the most recent non-stale interrupted job.
    const ref =
      resume === true
        ? await pickDefaultResumeRef()
        : resume;
    const job = await startCollection(undefined, { resumeJobRef: ref });
    console.log(`Resuming collection job ${job.id}.`);
    await pollUntilDone();
    return;
  }
  if (rirs.length === 0) {
    const cfg = loadCollectorConfig();
    if (cfg.sourcePath && cfg.collection) {
      console.log(
        `Using "collection" sources from ${cfg.sourcePath}: ${cfg.collection.join(", ")}`,
      );
    }
  }
  const job = await startCollection(rirs.length > 0 ? rirs : undefined);
  console.log(`Collection job ${job.id} started.`);
  await pollUntilDone();
}

async function pickDefaultResumeRef(): Promise<string> {
  const jobs = await listResumableCollectionJobs();
  const candidate = jobs.find((j) => !j.stale);
  if (!candidate) {
    throw new Error(
      jobs.length > 0
        ? "All interrupted collection jobs are stale — resume one explicitly with its id (see `ip-insight jobs`)."
        : "No interrupted collection job to resume.",
    );
  }
  return candidate.id;
}

const POLL_MS = 1500;
/** How long a source's line can stay byte-for-byte identical before we print
 * a heartbeat anyway. Covers the exponential-backoff wait between retries
 * (source sits at "pending" for up to tens of seconds — see collector.ts's
 * runSourceWithRetry) as much as an unusually slow upstream: either way, a
 * silent terminal for that long looks indistinguishable from a hang. */
const HEARTBEAT_MS = 12_000;
const ACTIVE_STATUSES = new Set(["pending", "downloading", "parsing"]);

async function pollUntilDone(): Promise<void> {
  const printed = new Map<string, string>();
  const stableSince = new Map<string, number>();
  const lastHeartbeatAt = new Map<string, number>();
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const s = await loadStatus();
    const now = Date.now();
    for (const src of s.sources) {
      const line = `[${src.rir}] ${src.status} — ${src.recordsIngested.toLocaleString()} ingested${
        src.status === "running" ? ` (${fmtRate(src.recordsPerSecond)})` : ""
      }${src.errorMessage ? ` — ERROR: ${src.errorMessage}` : ""}`;
      if (printed.get(src.rir) !== line) {
        console.log(line);
        printed.set(src.rir, line);
        stableSince.set(src.rir, now);
        lastHeartbeatAt.set(src.rir, now);
        continue;
      }
      if (!ACTIVE_STATUSES.has(src.status)) continue;
      const lastBeat = lastHeartbeatAt.get(src.rir) ?? now;
      if (now - lastBeat >= HEARTBEAT_MS) {
        const elapsedSec = Math.round((now - (stableSince.get(src.rir) ?? now)) / 1000);
        console.log(`[${src.rir}] ${src.status} — still running (${elapsedSec}s, no change yet)`);
        lastHeartbeatAt.set(src.rir, now);
      }
    }
    if (!s.isActive) {
      const doneLine = `Done. Total ingested: ${s.job?.totalIngested.toLocaleString() ?? 0}, skipped: ${
        s.job?.totalSkipped.toLocaleString() ?? 0
      }, status: ${s.job?.status ?? "unknown"}.`;
      console.log(doneLine);
      appendRunHistory(`${new Date().toISOString()} [collect] job=${s.job?.id ?? "?"} ${doneLine}`);
      break;
    }
  }
}
