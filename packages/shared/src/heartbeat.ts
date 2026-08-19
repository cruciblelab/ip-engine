/**
 * Wraps a single long-running promise with a periodic "still running" log
 * line — for the specific shape of operation `collect`/`enrich`'s own
 * per-source heartbeat (see apps/cli's poll loops) can't cover: one
 * blocking statement with no sub-progress to poll at all, like building a
 * materialized `ip_intel` (a single `CREATE MATERIALIZED VIEW`, hours on a
 * full dataset, zero rows visible until it's done). Without this, that call
 * is silent for its entire duration and is indistinguishable from a hang.
 *
 * `checkAlive`/`onUnhealthy` close a real gap found in production: this
 * timer used to be pure wall-clock, with no idea whether `work()` itself
 * was still making progress or had gone silent because the connection it
 * depends on died underneath it. Confirmed happening on the phone this was
 * developed against — Android killed the whole process including Postgres,
 * and this heartbeat kept printing "still running" every 30s for hours
 * anyway, because ticking never depended on anything actually being alive.
 * A caller that passes `checkAlive` (typically a cheap `SELECT 1`) gets
 * `onUnhealthy` instead of `onTick` the moment that check fails or throws,
 * so a dead connection is reported as dead rather than silently narrated as
 * progress. Optional and additive: a caller that doesn't pass it keeps the
 * exact previous behavior.
 */
export async function withHeartbeat<T>(
  intervalMs: number,
  onTick: (elapsedSec: number) => void,
  work: () => Promise<T>,
  checkAlive?: () => Promise<boolean>,
  onUnhealthy?: (elapsedSec: number, consecutiveFailures: number) => void,
): Promise<T> {
  const start = Date.now();
  let consecutiveFailures = 0;
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    if (!checkAlive) {
      onTick(elapsedSec);
      return;
    }
    checkAlive()
      .then((alive) => {
        if (alive) {
          consecutiveFailures = 0;
          onTick(elapsedSec);
        } else {
          consecutiveFailures += 1;
          (onUnhealthy ?? onTick)(elapsedSec, consecutiveFailures);
        }
      })
      .catch(() => {
        consecutiveFailures += 1;
        (onUnhealthy ?? onTick)(elapsedSec, consecutiveFailures);
      });
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
