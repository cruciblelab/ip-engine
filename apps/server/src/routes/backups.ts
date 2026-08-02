import { Router, type IRouter } from "express";
import { RestoreBackupEndpointBody } from "@workspace/api-schema";
import { listBackups, runBackup, restoreBackup, loadCollectorConfig } from "@workspace/collector";

const router: IRouter = Router();

router.get("/backups", async (_req, res): Promise<void> => {
  const rows = await listBackups();
  res.json(
    rows.map((b) => ({
      id: b.id,
      status: b.status,
      startedAt: b.startedAt.toISOString(),
      endedAt: b.endedAt ? b.endedAt.toISOString() : null,
      filePath: b.filePath,
      sizeBytes: b.sizeBytes,
      errorMessage: b.errorMessage,
    })),
  );
});

router.post("/backups", async (_req, res): Promise<void> => {
  const config = loadCollectorConfig();
  const result = await runBackup(config);
  if (!result) {
    res.status(500).json({ error: "backup_failed", message: "Backup failed — see server logs (pg_dump may be missing)" });
    return;
  }
  const [row] = await listBackups();
  res.json({
    id: row?.id ?? "",
    status: "completed",
    startedAt: row?.startedAt ? row.startedAt.toISOString() : new Date().toISOString(),
    endedAt: row?.endedAt ? row.endedAt.toISOString() : new Date().toISOString(),
    filePath: result.filePath,
    sizeBytes: result.sizeBytes,
    errorMessage: null,
  });
});

router.post("/backups/restore", async (req, res): Promise<void> => {
  const parsed = RestoreBackupEndpointBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", message: parsed.error.message });
    return;
  }
  if (!parsed.data.confirm) {
    res.status(400).json({ error: "not_confirmed", message: "Set confirm: true to proceed with this destructive restore" });
    return;
  }
  try {
    await restoreBackup(parsed.data.filePath);
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(400).json({ error: "restore_failed", message });
  }
});

export default router;
