import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, collectionJobsTable } from "@workspace/db";
import {
  StartCollectionBody,
  ListKnownSourcesResponse,
  ResumeCollectionBody,
} from "@workspace/api-schema";
import {
  startCollection,
  stopCollection,
  loadStatus,
  jobToDto,
  KNOWN_SOURCES,
  listResumableCollectionJobs,
} from "@workspace/collector";

const router: IRouter = Router();

router.post("/collection/start", async (req, res): Promise<void> => {
  const parsed = StartCollectionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", message: parsed.error.message });
    return;
  }
  try {
    const job = await startCollection(parsed.data.sources);
    res.json(jobToDto(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.includes("already running")) {
      res.status(409).json({ error: "already_running", message });
      return;
    }
    res.status(400).json({ error: "start_failed", message });
  }
});

router.post("/collection/stop", async (_req, res): Promise<void> => {
  const job = await stopCollection();
  if (!job) {
    res.status(404).json({ error: "no_active_job", message: "No collection job is active" });
    return;
  }
  res.json(jobToDto(job));
});

router.get("/collection/status", async (_req, res): Promise<void> => {
  const status = await loadStatus();
  res.json({
    isActive: status.isActive,
    ratePerSecond: Number(status.ratePerSecond.toFixed(2)),
    job: status.job ? jobToDto(status.job) : null,
    sources: status.sources.map((s) => ({
      rir: s.rir,
      url: s.url,
      status: s.status,
      recordsIngested: s.recordsIngested,
      recordsSkipped: s.recordsSkipped,
      bytesDownloaded: s.bytesDownloaded,
      ipv4Count: s.ipv4Count,
      ipv6Count: s.ipv6Count,
      asnCount: s.asnCount,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      errorMessage: s.errorMessage,
      recordsPerSecond: Number(s.recordsPerSecond.toFixed(2)),
    })),
  });
});

router.get("/collection/jobs", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(collectionJobsTable)
    .orderBy(desc(collectionJobsTable.startedAt))
    .limit(20);
  res.json(rows.map(jobToDto));
});

router.get("/collection/jobs/resumable", async (_req, res): Promise<void> => {
  const jobs = await listResumableCollectionJobs();
  res.json(jobs.map((j) => ({ ...j, startedAt: j.startedAt.toISOString() })));
});

router.post("/collection/resume", async (req, res): Promise<void> => {
  const parsed = ResumeCollectionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", message: parsed.error.message });
    return;
  }
  try {
    let jobId = parsed.data.jobId;
    if (!jobId) {
      const candidate = (await listResumableCollectionJobs()).find((j) => !j.stale);
      if (!candidate) {
        res.status(400).json({ error: "nothing_to_resume", message: "No non-stale interrupted job to resume" });
        return;
      }
      jobId = candidate.id;
    }
    const job = await startCollection(undefined, { resumeJobRef: jobId });
    res.json(jobToDto(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.includes("already running")) {
      res.status(409).json({ error: "already_running", message });
      return;
    }
    res.status(400).json({ error: "resume_failed", message });
  }
});

router.get("/collection/sources", async (_req, res): Promise<void> => {
  const data = KNOWN_SOURCES.map((s) => ({
    rir: s.rir,
    displayName: s.displayName,
    region: s.region,
    url: s.url,
  }));
  res.json(ListKnownSourcesResponse.parse(data));
});

export default router;
