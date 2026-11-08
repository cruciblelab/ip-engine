import { Router, type IRouter } from "express";
import { getSchedules, setSchedule, triggerNow, type CronJobName } from "@workspace/collector";

const router: IRouter = Router();

/** GET /api/cron/schedules — return all schedule states */
router.get("/cron/schedules", (_req, res): void => {
  res.json(getSchedules());
});

/** PUT /api/cron/schedules/:name — set or clear a cron expression */
router.put("/cron/schedules/:name", (req, res): void => {
  const name = req.params["name"] as CronJobName;
  if (name !== "collection" && name !== "enrichment") {
    res.status(400).json({ error: "Unknown schedule name. Use 'collection' or 'enrichment'." });
    return;
  }
  const { expression } = (req.body ?? {}) as { expression?: string | null };
  const result = setSchedule(name, expression ?? null);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(getSchedules());
});

/** POST /api/cron/trigger/:name — run a job immediately regardless of schedule */
router.post("/cron/trigger/:name", async (req, res): Promise<void> => {
  const name = req.params["name"] as CronJobName;
  if (name !== "collection" && name !== "enrichment") {
    res.status(400).json({ error: "Unknown job name. Use 'collection' or 'enrichment'." });
    return;
  }
  try {
    // Fire-and-forget; the actual job status is visible via existing status endpoints
    void triggerNow(name);
    res.json({ triggered: true, name });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
