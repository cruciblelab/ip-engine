/**
 * Regression test for a real bug: `seedAnycastTable()` was only ever called
 * from `apps/server`'s startup, so a CLI-only deployment (collect/enrich/
 * flatten, `apps/server` never started) silently never populated
 * `anycast_ranges` — `ip_intel.is_anycast` came back `false` even for
 * 1.1.1.1/8.8.8.8, confirmed on real data. Fixed by moving this function
 * (and the curated list backing it) into `@workspace/db` and calling it at
 * the top of every `enrich` run (see `packages/collector/src/enrichment/
 * enrichment.ts`) instead of only from the server.
 *
 * Requires a real Postgres reachable via DATABASE_URL — skipped otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("seedAnycastTable", () => {
  afterEach(async () => {
    // Leave the table re-seeded afterward — an empty anycast_ranges table
    // is exactly the bug this test guards against, not a state to leave
    // a real database in.
    const { seedAnycastTable } = await import("./anycast-seed");
    await seedAnycastTable();
  });

  it("populates an empty anycast_ranges table from the curated list", async () => {
    const { db, anycastRangesTable } = await import("./index");
    const { seedAnycastTable, CURATED_ANYCAST_RANGES } = await import("./anycast-seed");

    await db.delete(anycastRangesTable);
    const inserted = await seedAnycastTable();
    expect(inserted).toBe(CURATED_ANYCAST_RANGES.length);

    const rows = await db.select().from(anycastRangesTable);
    expect(rows.length).toBe(CURATED_ANYCAST_RANGES.length);
    expect(rows.some((r) => r.network === "1.1.1.0/24")).toBe(true);
  });

  it("is idempotent — calling it again inserts nothing new", async () => {
    const { db, anycastRangesTable } = await import("./index");
    const { seedAnycastTable } = await import("./anycast-seed");

    await seedAnycastTable();
    const before = await db.select().from(anycastRangesTable);
    const insertedSecondCall = await seedAnycastTable();
    const after = await db.select().from(anycastRangesTable);

    expect(insertedSecondCall).toBe(0);
    expect(after.length).toBe(before.length);
  });
});
