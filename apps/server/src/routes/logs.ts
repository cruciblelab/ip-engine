/**
 * Log file access — pulling the persistent NDJSON log (see lib/logger.ts)
 * off the device, whether the server was started from a terminal or is
 * only reachable over HTTP.
 */
import { Router, type IRouter } from "express";
import fs from "node:fs";
import { LOG_FILE_PATH } from "@workspace/shared";

const router: IRouter = Router();

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;
/** Only ever read this many trailing bytes off disk, regardless of total
 * file size — the whole point of /logs/tail is to stay cheap even once
 * the log file has grown to multiple GB. */
const TAIL_WINDOW_BYTES = 2 * 1024 * 1024;

async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const stat = await fs.promises.stat(filePath);
  const start = Math.max(0, stat.size - TAIL_WINDOW_BYTES);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start });
    stream.on("data", (c) => chunks.push(c as Buffer));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString("utf-8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}

/** GET /api/logs/export — full log file, streamed straight from disk. */
router.get("/logs/export", (_req, res): void => {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    res.status(404).json({ error: "no_log_file", message: "Log file has not been created yet." });
    return;
  }
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="api-server-${Date.now()}.log"`,
  );
  const stream = fs.createReadStream(LOG_FILE_PATH);
  stream.on("error", (err) => {
    res.status(500).json({ error: "read_failed", message: err.message });
  });
  stream.pipe(res);
});

/**
 * GET /api/logs/tail?n=200 — last N lines without downloading the whole
 * file. Bounded to the last ~2MB of the file so this stays cheap even at
 * multi-GB log sizes.
 */
router.get("/logs/tail", async (req, res): Promise<void> => {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    res.status(404).json({ error: "no_log_file", message: "Log file has not been created yet." });
    return;
  }
  const requested = Number(req.query["n"] ?? DEFAULT_TAIL_LINES);
  const n = Math.max(1, Math.min(MAX_TAIL_LINES, Number.isFinite(requested) ? requested : DEFAULT_TAIL_LINES));
  try {
    const lines = await readTailLines(LOG_FILE_PATH, n);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.send(lines.join("\n") + (lines.length ? "\n" : ""));
  } catch (err) {
    res.status(500).json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /api/logs/info — file path + current size, so callers know what they're about to pull. */
router.get("/logs/info", (_req, res): void => {
  if (!fs.existsSync(LOG_FILE_PATH)) {
    res.json({ exists: false, path: LOG_FILE_PATH, sizeBytes: 0 });
    return;
  }
  const stat = fs.statSync(LOG_FILE_PATH);
  res.json({ exists: true, path: LOG_FILE_PATH, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
});

export default router;
