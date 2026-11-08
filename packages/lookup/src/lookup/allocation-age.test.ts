import { describe, it, expect } from "vitest";
import { allocationAgeDays, isFreshAllocation, FRESH_ALLOCATION_DAYS } from "./allocation-age";

/** Fixed "today" so these assertions don't change meaning tomorrow. */
const NOW = new Date("2026-08-21T09:30:00Z");

describe("allocationAgeDays", () => {
  it("returns null for every shape of no-date, which is the common case", () => {
    // Not an error path: every `reserved`/`available` RIR block has no date.
    for (const empty of [null, undefined, ""]) {
      expect(allocationAgeDays(empty, NOW)).toBeNull();
    }
  });

  it("counts whole days from a YYYY-MM-DD string", () => {
    expect(allocationAgeDays("2026-08-21", NOW)).toBe(0);
    expect(allocationAgeDays("2026-08-20", NOW)).toBe(1);
    expect(allocationAgeDays("2026-07-22", NOW)).toBe(30);
    expect(allocationAgeDays("2025-08-21", NOW)).toBe(365);
  });

  it("accepts a Date object too — pg hands back either depending on the query path", () => {
    expect(allocationAgeDays(new Date("2026-08-20T00:00:00Z"), NOW)).toBe(1);
  });

  it("ignores the time of day on both sides rather than rounding across it", () => {
    // The real trap this guards: a lookup at 09:30 UTC comparing against a
    // date-only value must not come out a day short because of the clock.
    const lateInDay = new Date("2026-08-21T23:59:00Z");
    const earlyInDay = new Date("2026-08-21T00:00:01Z");
    expect(allocationAgeDays("2026-08-20", lateInDay)).toBe(1);
    expect(allocationAgeDays("2026-08-20", earlyInDay)).toBe(1);
  });

  it("returns null rather than a plausible-looking age for malformed input", () => {
    // `new Date()` would happily accept most of these and produce a real
    // number — the whole reason the parser is a strict regex.
    for (const bad of ["not-a-date", "2026", "Aug 21 2026", "21-08-2026", "2026-8-1"]) {
      expect(allocationAgeDays(bad, NOW)).toBeNull();
    }
  });

  it("rejects impossible dates instead of letting Date.UTC roll them over", () => {
    expect(allocationAgeDays("2026-02-30", NOW)).toBeNull(); // would become Mar 2
    expect(allocationAgeDays("2026-13-01", NOW)).toBeNull(); // would become Jan 2027
    expect(allocationAgeDays("2026-00-10", NOW)).toBeNull();
  });

  it("returns null for a future date rather than a negative age", () => {
    expect(allocationAgeDays("2026-08-22", NOW)).toBeNull();
    expect(allocationAgeDays("2030-01-01", NOW)).toBeNull();
  });

  it("handles a real leap day", () => {
    expect(allocationAgeDays("2024-02-29", new Date("2024-03-01T12:00:00Z"))).toBe(1);
  });
});

describe("isFreshAllocation", () => {
  it("is false for an unknown age — unknown is not fresh", () => {
    expect(isFreshAllocation(null)).toBe(false);
  });

  it("fires strictly inside the window", () => {
    expect(isFreshAllocation(0)).toBe(true);
    expect(isFreshAllocation(FRESH_ALLOCATION_DAYS - 1)).toBe(true);
    expect(isFreshAllocation(FRESH_ALLOCATION_DAYS)).toBe(false);
    expect(isFreshAllocation(FRESH_ALLOCATION_DAYS + 1)).toBe(false);
  });

  it("does not fire for the overwhelming majority case (3+ year old space)", () => {
    expect(isFreshAllocation(1095)).toBe(false);
    expect(isFreshAllocation(15_000)).toBe(false);
  });
});
