import { Router, type IRouter } from "express";
import { loadCollectorConfig, buildDatabaseSummary } from "@workspace/collector";
import { loadLookupConfig } from "@workspace/lookup";

const router: IRouter = Router();

router.get("/settings", async (_req, res): Promise<void> => {
  const collector = loadCollectorConfig();
  const lookup = loadLookupConfig();
  res.json({
    sourcePath: collector.sourcePath ?? lookup.sourcePath,
    collection: collector.collection,
    collectionStatuses: collector.collectionStatuses,
    enrichment: collector.enrichment,
    batchSize: collector.batchSize,
    fetchRetryMaxAttempts: collector.fetchRetry.maxAttempts,
    fetchRetryBaseDelayMs: collector.fetchRetry.baseDelayMs,
    fetchRetryTimeoutMs: collector.fetchRetry.timeoutMs,
    exportFormat: collector.exportFormat,
    exportDir: collector.exportDir,
    summaryDir: collector.summaryDir,
    checkpointingEnabled: collector.checkpointingEnabled,
    checkpointIdFormat: collector.checkpointIdFormat,
    checkpointStaleAfterHours: collector.checkpointStaleAfterHours,
    checkpointAutoCleanupStaleJobs: collector.checkpointAutoCleanupStaleJobs,
    maintenanceSchedulerEnabled: collector.maintenanceSchedulerEnabled,
    backupEnabled: collector.backupEnabled,
    backupIntervalHours: collector.backupIntervalHours,
    backupRetentionCount: collector.backupRetentionCount,
    backupDir: collector.backupDir,
    sleepModeEnabled: collector.sleepModeEnabled,
    sleepModeIdleHours: collector.sleepModeIdleHours,
    lookupFeatures: lookup.features,
    cacheSize: lookup.cacheSize,
    cacheTtlMinutes: lookup.cacheTtlMinutes,
    reverseDnsTimeoutMs: lookup.reverseDnsTimeoutMs,
    bulkLookupConcurrency: lookup.bulkLookupConcurrency,
  });
});

router.get("/summary", async (_req, res): Promise<void> => {
  const summary = await buildDatabaseSummary();
  res.json(summary);
});

export default router;
