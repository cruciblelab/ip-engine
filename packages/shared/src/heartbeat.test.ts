/**
 * Regression coverage for the real gap fixed 2026-08-09: `withHeartbeat`
 * used to be pure wall-clock, so a dead Postgres connection kept getting
 * reported as "still running" for hours (see docs/93-open-issues-triage
 * and docs/40-operations-and-incidents.md's overnight incident). These
 * tests pin the `checkAlive`/`onUnhealthy` contract directly rather than
 * re-verifying it by hand against a real DB each time.
 *
 * No DATABASE_URL needed — `withHeartbeat` takes plain callbacks, so this
 * never touches @workspace/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHeartbeat } from "./heartbeat";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Never resolves on its own — the test controls completion by resolving
 * the returned `resolve` function once it's done asserting mid-flight
 * behavior. */
function pendingWork<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withHeartbeat without checkAlive", () => {
  it("keeps calling onTick on the interval — unchanged previous behavior", async () => {
    const onTick = vi.fn();
    const { promise, resolve } = pendingWork<string>();
    const result = withHeartbeat(1_000, onTick, () => promise);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenNthCalledWith(1, 1);
    expect(onTick).toHaveBeenNthCalledWith(2, 2);

    resolve("done");
    await expect(result).resolves.toBe("done");
  });

  it("stops ticking once work() resolves", async () => {
    const onTick = vi.fn();
    await withHeartbeat(1_000, onTick, async () => "immediate");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("propagates work()'s rejection instead of swallowing it", async () => {
    const onTick = vi.fn();
    const failure = new Error("boom");
    const rejecting = withHeartbeat(1_000, onTick, () => Promise.reject(failure));
    await expect(rejecting).rejects.toBe(failure);
  });

  it("stops ticking once work() has rejected — the timer isn't leaked", async () => {
    const onTick = vi.fn();
    await withHeartbeat(1_000, onTick, () => Promise.reject(new Error("boom"))).catch(
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTick).not.toHaveBeenCalled();
  });
});

describe("withHeartbeat with checkAlive", () => {
  it("calls onTick (not onUnhealthy) while checkAlive resolves true", async () => {
    const onTick = vi.fn();
    const onUnhealthy = vi.fn();
    const checkAlive = vi.fn().mockResolvedValue(true);
    const { promise, resolve } = pendingWork<string>();

    withHeartbeat(1_000, onTick, () => promise, checkAlive, onUnhealthy);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkAlive).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(1);
    expect(onUnhealthy).not.toHaveBeenCalled();

    resolve("done");
  });

  it("calls onUnhealthy (not onTick) the moment checkAlive resolves false", async () => {
    const onTick = vi.fn();
    const onUnhealthy = vi.fn();
    const checkAlive = vi.fn().mockResolvedValue(false);
    const { promise, resolve } = pendingWork<string>();

    withHeartbeat(1_000, onTick, () => promise, checkAlive, onUnhealthy);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).not.toHaveBeenCalled();
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy).toHaveBeenCalledWith(1, 1);

    resolve("done");
  });

  it("treats a checkAlive rejection the same as a false result", async () => {
    const onTick = vi.fn();
    const onUnhealthy = vi.fn();
    const checkAlive = vi.fn().mockRejectedValue(new Error("connection lost"));
    const { promise, resolve } = pendingWork<string>();

    withHeartbeat(1_000, onTick, () => promise, checkAlive, onUnhealthy);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).not.toHaveBeenCalled();
    expect(onUnhealthy).toHaveBeenCalledWith(1, 1);

    resolve("done");
  });

  it("increments consecutiveFailures across repeated unhealthy ticks, then resets on recovery", async () => {
    const onTick = vi.fn();
    const onUnhealthy = vi.fn();
    const checkAlive = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { promise, resolve } = pendingWork<string>();

    withHeartbeat(1_000, onTick, () => promise, checkAlive, onUnhealthy);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onUnhealthy).toHaveBeenNthCalledWith(1, 1, 1);
    expect(onUnhealthy).toHaveBeenNthCalledWith(2, 2, 2);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(3);

    resolve("done");
  });

  it("falls back to onTick when onUnhealthy isn't provided — additive, not breaking", async () => {
    const onTick = vi.fn();
    const checkAlive = vi.fn().mockResolvedValue(false);
    const { promise, resolve } = pendingWork<string>();

    withHeartbeat(1_000, onTick, () => promise, checkAlive);

    await vi.advanceTimersByTimeAsync(1_000);
    // No separate onUnhealthy: the unhealthy tick still surfaces via onTick
    // rather than vanishing silently. onTick is called with the same
    // (elapsedSec, consecutiveFailures) shape onUnhealthy would have
    // received — callers relying on the old one-arg onTick signature
    // simply ignore the second argument, same as before this feature existed.
    expect(onTick).toHaveBeenCalledWith(1, 1);

    resolve("done");
  });
});
