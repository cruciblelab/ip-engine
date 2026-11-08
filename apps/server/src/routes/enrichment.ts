import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, enrichmentJobsTable } from "@workspace/db";
import { StartEnrichmentBody, ResumeEnrichmentBody } from "@workspace/api-schema";
import {
  startEnrichment,
  stopEnrichment,
  loadEnrichmentStatus,
  enrichmentJobToDto,
  listEnrichmentSources,
  listResumableEnrichmentJobs,
} from "@workspace/collector";

const router: IRouter = Router();

router.post("/enrichment/start", async (req, res): Promise<void> => {
  const parsed = StartEnrichmentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_body", message: parsed.error.message });
    return;
  }
  try {
    const job = await startEnrichment(parsed.data.sources);
    res.json(enrichmentJobToDto(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("already running")) {
      res.status(409).json({ error: "already_running", message });
      return;
    }
    res.status(400).json({ error: "bad_request", message });
  }
});

router.post("/enrichment/stop", async (_req, res): Promise<void> => {
  const row = await stopEnrichment();
  if (!row) {
    res.status(404).json({ error: "no_active_job" });
    return;
  }
  res.json(enrichmentJobToDto(row));
});

router.get("/enrichment/status", async (_req, res): Promise<void> => {
  const status = await loadEnrichmentStatus();
  res.json({
    isActive: status.isActive,
    job: status.job ? enrichmentJobToDto(status.job) : null,
    sources: status.sources.map((s) => ({
      sourceId: s.sourceId,
      kind: s.kind,
      url: s.url,
      status: s.status,
      recordsIngested: s.recordsIngested,
      recordsSkipped: s.recordsSkipped,
      bytesDownloaded: s.bytesDownloaded,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      errorMessage: s.errorMessage,
    })),
  });
});

router.get("/enrichment/jobs", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(enrichmentJobsTable)
    .orderBy(desc(enrichmentJobsTable.startedAt))
    .limit(25);
  res.json(rows.map(enrichmentJobToDto));
});

router.get("/enrichment/jobs/resumable", async (_req, res): Promise<void> => {
  const jobs = await listResumableEnrichmentJobs();
  res.json(jobs.map((j) => ({ ...j, startedAt: j.startedAt.toISOString() })));
});

router.post("/enrichment/resume", async (req, res): Promise<void> => {
  const parsed = ResumeEnrichmentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", message: parsed.error.message });
    return;
  }
  try {
    let jobId = parsed.data.jobId;
    if (!jobId) {
      const candidate = (await listResumableEnrichmentJobs()).find((j) => !j.stale);
      if (!candidate) {
        res.status(400).json({ error: "nothing_to_resume", message: "No non-stale interrupted job to resume" });
        return;
      }
      jobId = candidate.id;
    }
    const job = await startEnrichment(undefined, { resumeJobRef: jobId });
    res.json(enrichmentJobToDto(job));
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.includes("already running")) {
      res.status(409).json({ error: "already_running", message });
      return;
    }
    res.status(400).json({ error: "resume_failed", message });
  }
});

router.get("/enrichment/sources", async (_req, res): Promise<void> => {
  res.json(
    listEnrichmentSources().map((s) => ({
      id: s.id,
      displayName: s.displayName,
      description: s.description,
      kind: s.kind,
      // `?? null` rather than passing through: a derived source has no URL,
      // and an undefined value would be dropped entirely by JSON.stringify —
      // leaving the field missing from a response the schema declares it
      // required (nullable) in.
      url: s.url ?? null,
      provider: s.provider ?? null,
      source: s.source ?? null,
    })),
  );
});

export default router;
