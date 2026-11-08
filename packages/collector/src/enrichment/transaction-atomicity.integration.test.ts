/**
 * Regression test for a real bug: `computeAsnProfile`/`computeNeighborhoodStats`/
 * `computeAsnReach` each did a `DELETE FROM x` followed by a separate
 * `INSERT ... SELECT`, with nothing tying the two together — a crash
 * between them (killed process, OOM) left that one derived table empty
 * until the next successful enrichment run, instead of merely stale. Fixed
 * by wrapping each pair in `db.transaction(...)`.
 *
 * This test doesn't re-run the real (expensive, data-dependent) enrichment
 * SQL — it proves the underlying guarantee those fixes now rely on:
 * `db.transaction` actually rolls back a delete when a later statement in
 * the same transaction throws, using `asn_reach` (the simplest of the three
 * derived tables) as the real table under test.
 *
 * Requires a real Postgres reachable via DATABASE_URL — skipped otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
// Sentinel ASNs picked from the private-use range (RFC 6996) so nothing a
// real enrichment run inserts could collide with them.
const SENTINEL_ASN = 4_200_000_001;
const NEVER_COMMITTED_ASN = 4_200_000_002;

describe.skipIf(!hasDb)("delete+insert transaction atomicity", () => {
  let cleanupAsns: number[] = [];

  afterEach(async () => {
    if (cleanupAsns.length === 0) return;
    const { db, asnReachTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    await db.delete(asnReachTable).where(inArray(asnReachTable.asn, cleanupAsns));
    cleanupAsns = [];
  });

  it("rolls back the delete when the insert after it throws", async () => {
    const { db, asnReachTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    await db.insert(asnReachTable).values({ asn: SENTINEL_ASN, rank: 1 });
    cleanupAsns.push(SENTINEL_ASN, NEVER_COMMITTED_ASN);

    await expect(
      db.transaction(async (tx) => {
        await tx.delete(asnReachTable).where(eq(asnReachTable.asn, SENTINEL_ASN));
        await tx.insert(asnReachTable).values({ asn: NEVER_COMMITTED_ASN, rank: 1 });
        throw new Error("simulated crash mid-computation");
      }),
    ).rejects.toThrow("simulated crash mid-computation");

    // The delete must not have taken effect...
    const [survivor] = await db.select().from(asnReachTable).where(eq(asnReachTable.asn, SENTINEL_ASN));
    expect(survivor).toBeDefined();
    // ...and the insert that came after it in the same transaction must not
    // have either — proving the two statements really share one outcome.
    const [phantom] = await db
      .select()
      .from(asnReachTable)
      .where(eq(asnReachTable.asn, NEVER_COMMITTED_ASN));
    expect(phantom).toBeUndefined();
  });
});
