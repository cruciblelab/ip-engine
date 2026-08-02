/**
 * Wraps a single long-running promise with a periodic "still running" log
 * line — for the specific shape of operation `collect`/`enrich`'s own
 * per-source heartbeat (see apps/cli's poll loops) can't cover: one
 * blocking statement with no sub-progress to poll at all, like building a
 * materialized `ip_intel` (a single `CREATE MATERIALIZED VIEW`, hours on a
 * full dataset, zero rows visible until it's done). Without this, that call
 * is silent for its entire duration and is indistinguishable from a hang.
 */
export async function withHeartbeat<T>(
  intervalMs: number,
  onTick: (elapsedSec: number) => void,
  work: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const timer = setInterval(() => {
    onTick(Math.round((Date.now() - start) / 1000));
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
