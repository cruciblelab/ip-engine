/**
 * The self-imposed RDAP query budget (rdap.ts).
 *
 * Pure logic, no network and no database — deliberately: the behaviour
 * worth pinning here is *when a request is refused before being made*,
 * which is exactly the part a live test could never observe without
 * actually burning a real registry's quota to prove it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { claimRdapBudget, __resetRdapBudgets, rdapBudgetStats } from "./rdap";

describe("RDAP per-registry query budget", () => {
  beforeEach(() => {
    __resetRdapBudgets();
  });

  it("allows exactly `cap` queries, then refuses", () => {
    for (let i = 0; i < 5; i++) {
      expect(claimRdapBudget("ARIN", 5)).toBe(true);
    }
    expect(claimRdapBudget("ARIN", 5)).toBe(false);
    expect(claimRdapBudget("ARIN", 5)).toBe(false);
  });

  // The entire reason for routing per-registry rather than through one
  // entry point: exhausting one registry's allowance must not affect the
  // other four. Before this change every query spent RIPE's budget, so a
  // burst of ARIN-space lookups could starve genuine RIPE-space ones.
  it("keeps registries independent — exhausting one leaves the others untouched", () => {
    for (let i = 0; i < 3; i++) {
      expect(claimRdapBudget("ARIN", 3)).toBe(true);
    }
    expect(claimRdapBudget("ARIN", 3)).toBe(false);

    for (const rir of ["RIPENCC", "APNIC", "LACNIC", "AFRINIC"]) {
      expect(claimRdapBudget(rir, 3)).toBe(true);
    }
  });

  // `cap: 0` is a supported setting, not a degenerate one: it means "never
  // make a live RDAP call at all", for a deployment that wants zero
  // third-party dependency at request time. The window-reset branch must
  // not hand out a free first query in that case.
  it("refuses every query at cap 0, including the very first", () => {
    expect(claimRdapBudget("ARIN", 0)).toBe(false);
    expect(claimRdapBudget("ARIN", 0)).toBe(false);
    expect(rdapBudgetStats()).toHaveLength(0);
  });

  it("reports per-registry usage for observability", () => {
    claimRdapBudget("ARIN", 10);
    claimRdapBudget("ARIN", 10);
    claimRdapBudget("APNIC", 10);

    const stats = Object.fromEntries(rdapBudgetStats().map((s) => [s.rir, s.used]));
    expect(stats["ARIN"]).toBe(2);
    expect(stats["APNIC"]).toBe(1);
    expect(stats["LACNIC"]).toBeUndefined();
  });
});

// `rdapEnabled` (lookup config, default false since 2026-11-12, docs/106
// G1). The test runs against the repository's own ip-insight.config.json,
// which sets it false — the shipped configuration, not a mocked one. What
// matters is the same thing the budget tests pin: the request is never
// made, not merely that its answer is discarded.
describe("rdapEnabled: false", () => {
  it("returns nothing without making any network request or spending budget", async () => {
    const { vi } = await import("vitest");
    const { loadLookupConfig } = await import("../config");
    const { fetchRdapObject } = await import("./rdap");
    expect(loadLookupConfig().rdapEnabled).toBe(false);

    __resetRdapBudgets();
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await fetchRdapObject("192.0.2.1", "ARIN")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(rdapBudgetStats().find((s) => s.rir === "ARIN")?.used ?? 0).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
