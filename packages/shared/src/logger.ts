import pino from "pino";
import path from "node:path";
import fs from "node:fs";

const isProduction = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? "info";

/**
 * Every run — whether started from the CLI or hit over HTTP by the API
 * server/web panel — writes the same structured log line to disk, not just
 * whatever scrollback the terminal happens to keep. `pino/file` is a
 * built-in pino transport (no extra dependency; this project already
 * bundles its worker via esbuild-plugin-pino), so this is just wiring, not
 * new infrastructure.
 *
 * No rotation: it's a single append-only NDJSON file. That's a deliberate
 * simplification — rotation libraries are another dependency and another
 * thing to misconfigure — but it does mean the file grows unbounded. Use
 * GET /api/logs/export (see routes/logs.ts) to pull it off-device, and
 * delete/rename it yourself if it gets larger than you want to keep around.
 */
const logDir = process.env.LOG_DIR ?? path.join(process.cwd(), "logs");
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  // Best-effort. If this fails, the pino/file target below will throw at
  // first write and pino logs that failure to stderr — we don't hide it,
  // but we also don't want a read-only filesystem to crash the whole server
  // over logging, so the console target keeps working regardless.
}
export const LOG_FILE_PATH = path.join(logDir, "ip-insight.log");

const targets: pino.TransportTargetOptions[] = [
  {
    target: "pino/file",
    level,
    options: { destination: LOG_FILE_PATH, mkdir: true, append: true },
  },
  isProduction
    ? { target: "pino/file", level, options: { destination: 1 } } // raw JSON to stdout
    : { target: "pino-pretty", level, options: { colorize: true, destination: 1 } },
];

export const logger = pino({
  level,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  transport: { targets },
});

/**
 * One human-readable line per finished collect/enrich run, appended here in
 * plain text — separate from `ip-insight.log`'s NDJSON, which has one entry
 * per log call and is meant for grepping, not skimming. This file exists so
 * "did anything go wrong this week, and how many times did I actually run
 * this" is answerable with `cat`/`tail`, not by parsing JSON: a spot check
 * after several runs a day (a manual routine, an accidental double-run,
 * a retry storm) should take one glance, not a jq pipeline. Same append-
 * only, no-rotation tradeoff as the main log — see its own comment above.
 */
export const RUN_HISTORY_PATH = path.join(logDir, "run-history.log");

export function appendRunHistory(line: string): void {
  try {
    fs.appendFileSync(RUN_HISTORY_PATH, line.endsWith("\n") ? line : `${line}\n`);
  } catch (err) {
    logger.warn({ err }, "Failed to append to run-history.log");
  }
}
