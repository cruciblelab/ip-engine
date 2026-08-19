// Must load before "./app" — that import chain reaches @workspace/db at
// module scope, which reads DATABASE_URL immediately and throws if it's
// unset. Nothing else in this codebase reads a .env file. See load-env.ts
// for why this is its own module instead of an inline dotenv call here.
import "./load-env";
import app from "./app";
import { logger } from "@workspace/shared";
import { isJobActive, requestStop, initCron, startMaintenanceScheduler, stopMaintenanceScheduler } from "@workspace/collector";
import { seedAnycastTable } from "@workspace/lookup";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start cron scheduler (reads CRON_COLLECTION / CRON_ENRICHMENT env vars).
  initCron();

  // Periodic checkpoint-cleanup / backup / sleep-mode checks — see
  // @workspace/collector's maintenance.ts for what each tick does and why
  // none of it needs a restart to pick up a config change.
  startMaintenanceScheduler();

  // Best-effort anycast seed. Safe to fail (table may not exist yet on
  // first boot before drizzle-kit push runs); we log and continue.
  seedAnycastTable()
    .then((n) => {
      if (n > 0) logger.info({ inserted: n }, "Anycast prefixes seeded");
    })
    .catch((seedErr) => {
      logger.warn({ err: seedErr }, "Anycast seed failed (non-fatal)");
    });
});

/**
 * Graceful shutdown.
 *
 * 1. Stop accepting new HTTP connections.
 * 2. Cooperatively cancel any active collection job — the collector polls
 *    the stop flag between batches, so in-flight INSERTs finish but no
 *    new batches start.
 * 3. Wait up to SHUTDOWN_GRACE_MS for things to drain, then hard-exit.
 */
const SHUTDOWN_GRACE_MS = 25_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Received shutdown signal; draining…");

  stopMaintenanceScheduler();

  server.close((err) => {
    if (err) logger.warn({ err }, "Error closing HTTP server");
  });

  if (isJobActive()) {
    logger.info("Active collection job; signalling cooperative stop");
    await requestStop();
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (isJobActive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (isJobActive()) {
    logger.warn("Job still active after grace period; exiting anyway");
  }

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
