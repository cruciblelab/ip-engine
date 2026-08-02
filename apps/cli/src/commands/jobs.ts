import {
  listResumableCollectionJobs,
  listResumableEnrichmentJobs,
  loadCollectorConfig,
} from "@workspace/collector";

function fmtAge(startedAt: Date): string {
  const hours = (Date.now() - startedAt.getTime()) / 3_600_000;
  if (hours < 1) return "< 1h ago";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export async function runJobs(): Promise<void> {
  const config = loadCollectorConfig();
  if (!config.checkpointingEnabled) {
    console.log("Checkpointing is disabled (checkpointingEnabled: false in config) — nothing to list.");
    return;
  }

  const [collectJobs, enrichJobs] = await Promise.all([
    listResumableCollectionJobs(),
    listResumableEnrichmentJobs(),
  ]);

  if (collectJobs.length === 0 && enrichJobs.length === 0) {
    console.log("No interrupted jobs — nothing to resume.");
    return;
  }

  const printGroup = (label: string, jobs: typeof collectJobs, resumeCmd: string) => {
    if (jobs.length === 0) return;
    console.log(`\n${label}:`);
    for (const j of jobs) {
      const staleTag = j.stale
        ? ` (stale, older than ${config.checkpointStaleAfterHours}h — resume only by explicit id)`
        : "";
      console.log(
        `  ${j.displayId}  started ${fmtAge(j.startedAt)}  ${j.sourcesCompleted}/${j.sourcesTotal} sources done${staleTag}`,
      );
    }
    console.log(`  → ${resumeCmd} --resume [id]  (id optional — defaults to the most recent non-stale one)`);
  };

  printGroup("Interrupted collection jobs", collectJobs, "ip-insight collect");
  printGroup("Interrupted enrichment jobs", enrichJobs, "ip-insight enrich");
}
