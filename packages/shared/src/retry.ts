/**
 * Retry-with-backoff for the collector/enrichment fetch calls.
 *
 * These jobs pull from third-party public feeds (RIR delegated-stats, RIPE
 * RIS, AWS/GCP/Cloudflare/DigitalOcean, Spamhaus). None of that data is ours
 * — it's always re-fetchable — but a single transient blip (a dropped
 * mobile connection, a momentary 5xx from one upstream) used to mark the
 * whole source "failed" outright, with no attempt to recover. That's a
 * silent-data-gap risk: a source that's down for 10 seconds looks identical
 * in the job history to a source that's genuinely gone.
 *
 * This wraps `fetch` with a few retries and exponential backoff, so a
 * momentary hiccup in any one upstream — including during an IPv6 backfill
 * that has to re-pull every source — resolves itself without operator
 * intervention and without introducing any new third-party dependency.
 * Only network errors, request timeouts, 429, and 5xx are retried; a 4xx
 * (other than 429) means the request itself is wrong and retrying won't
 * help, so it fails immediately.
 */
import { logger } from "./logger";

export interface RetryOptions {
  /** Total attempts including the first — not "retries on top of". Default 4. */
  attempts?: number;
  /** Base delay for exponential backoff, doubled each attempt. Default 1000ms. */
  baseDelayMs?: number;
  /** Per-attempt timeout. Default 30s — generous, these are multi-MB downloads. */
  timeoutMs?: number;
  /** Label used only in log lines, e.g. the source id. */
  label?: string;
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with retry. Resolves to the first response that is either `ok` or
 * a non-retryable error status (so callers still see real 4xx responses
 * and can decide what to do) — only exhausts retries on network failure,
 * timeout, 429, or 5xx.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = opts.label ?? url;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (response.ok || !isRetryableStatus(response.status)) {
        if (attempt > 1) {
          logger.info({ label, attempt }, "Fetch succeeded after retry");
        }
        return response;
      }
      lastErr = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }

    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn(
        { label, attempt, attempts, delayMs: delay, err: lastErr },
        "Fetch failed, retrying",
      );
      await sleep(delay);
    }
  }

  logger.error({ label, attempts, err: lastErr }, "Fetch failed after all retries");
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
