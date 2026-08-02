import { Router, type IRouter } from "express";
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

router.use(healthRouter);
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
