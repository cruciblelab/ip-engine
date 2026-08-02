import { Router, type IRouter } from "express";
import { checkIngestionHealth } from "@workspace/collector";

const router: IRouter = Router();

/**
 * GET /api/ingestion/health — did the last completed run of each source
 * come back with a plausible amount of data? See lib/ingestion-health.ts
 * for why this exists: retries handle transient blips, this catches the
 * case where every retry failed and a source silently completed at (or
 * near) zero rows.
 */
router.get("/ingestion/health", async (_req, res): Promise<void> => {
  const result = await checkIngestionHealth();
  res.status(result.ok ? 200 : 503).json(result);
});

export default router;
