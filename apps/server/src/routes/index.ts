import { Router, type IRouter } from "express";
import { requireApiKey } from "../middlewares/apiKeyAuth";
import healthRouter from "./health";
import collectionRouter from "./collection";
import enrichmentRouter from "./enrichment";
import statsRouter from "./stats";
import exportRouter from "./export";
import lookupRouter from "./lookup";
import metricsRouter from "./metrics";
import cronRouter from "./cron";
import logsRouter from "./logs";
import ingestionHealthRouter from "./ingestion-health";
import settingsRouter from "./settings";
import backupsRouter from "./backups";

const router: IRouter = Router();

// /healthz stays unauthenticated (uptime monitors/orchestrators hit it
// without credentials) — everything mounted after this line requires
// requireApiKey since healthRouter doesn't match and falls through to it.
router.use(healthRouter);
router.use(requireApiKey);
router.use(collectionRouter);
router.use(enrichmentRouter);
router.use(statsRouter);
router.use(exportRouter);
router.use("/lookup", lookupRouter);
router.use(metricsRouter);
router.use(cronRouter);
router.use(logsRouter);
router.use(ingestionHealthRouter);
router.use(settingsRouter);
router.use(backupsRouter);

export default router;
