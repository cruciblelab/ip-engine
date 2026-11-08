/**
 * Regression coverage for the real gap fixed 2026-08-09: `lookupAsn()`
 * queried `asn_blocks` and `asn_profile` but never `asn_reach`, so the
 * ASN-number lookup endpoint silently omitted the same rank/originated-
 * prefixes/peer-visibility data the per-IP lookup path already surfaces
 * (see `lookup.ts`'s `asn.rank`/`asn.peer_visibility`). Verified once by
 * hand against real data (AS16509/Amazon); this pins it so it can't
 * silently regress.
 *
 * Uses a sentinel ASN from the RFC 6996 private-use range, same pattern as
 * transaction-atomicity.integration.test.ts, so nothing a real
 * collect/enrich run inserts can collide with it. Requires a real Postgres
 * reachable via DATABASE_URL — skipped otherwise.
 */
import { afterEach, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const SENTINEL_ASN = 4_200_000_050;
const SENTINEL_ASN_NO_REACH = 4_200_000_051;
const SENTINEL_ASN_UNKNOWN = 4_200_000_052; // never inserted into asn_blocks

describe.skipIf(!hasDb)("lookupAsn", () => {
  afterEach(async () => {
    const { db, asnBlocksTable, asnProfileTable, asnReachTable } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");
    const asns = [SENTINEL_ASN, SENTINEL_ASN_NO_REACH, SENTINEL_ASN_UNKNOWN];
    await db.delete(asnBlocksTable).where(inArray(asnBlocksTable.asnStart, asns));
    await db.delete(asnProfileTable).where(inArray(asnProfileTable.asn, asns));
    await db.delete(asnReachTable).where(inArray(asnReachTable.asn, asns));
  });

  it("returns null for an ASN with no asn_blocks row at all", async () => {
    const { lookupAsn } = await import("./lookup");
    await expect(lookupAsn(SENTINEL_ASN_UNKNOWN)).resolves.toBeNull();
  });

  it("returns reach: null when asn_reach hasn't been computed for this ASN yet", async () => {
    const { db, asnBlocksTable } = await import("@workspace/db");
    await db.insert(asnBlocksTable).values({
      asnStart: SENTINEL_ASN_NO_REACH,
      asnEnd: SENTINEL_ASN_NO_REACH,
      rir: "test",
      name: "TEST-NO-REACH",
    });

    const { lookupAsn } = await import("./lookup");
    const result = await lookupAsn(SENTINEL_ASN_NO_REACH);
    expect(result).not.toBeNull();
    expect(result?.reach).toBeNull();
  });

  it("populates reach from asn_reach when a row exists — the actual bug fixed", async () => {
    const { db, asnBlocksTable, asnReachTable } = await import("@workspace/db");
    await db.insert(asnBlocksTable).values({
      asnStart: SENTINEL_ASN,
      asnEnd: SENTINEL_ASN,
      rir: "test",
      name: "TEST-WITH-REACH",
      type: "hosting",
      country: "US",
    });
    await db.insert(asnReachTable).values({
      asn: SENTINEL_ASN,
      rank: 1,
      originatedPrefixes: 42,
      originatedPrefixesV6: 7,
      originatedAddresses: 123_456,
      peerVisibility: 99,
    });

    const { lookupAsn } = await import("./lookup");
    const result = await lookupAsn(SENTINEL_ASN);
    expect(result).not.toBeNull();
    expect(result?.reach).toMatchObject({
      rank: 1,
      originatedPrefixes: 42,
      originatedPrefixesV6: 7,
      originatedAddresses: 123_456,
      peerVisibility: 99,
    });
    expect(typeof result?.reach?.computedAt).toBe("string");
  });

  it("still returns profile alongside reach when both are computed — the two queries don't clobber each other", async () => {
    const { db, asnBlocksTable, asnReachTable, asnProfileTable } = await import("@workspace/db");
    await db.insert(asnBlocksTable).values({
      asnStart: SENTINEL_ASN,
      asnEnd: SENTINEL_ASN,
      rir: "test",
      name: "TEST-WITH-BOTH",
    });
    await db.insert(asnReachTable).values({ asn: SENTINEL_ASN, rank: 5 });
    await db.insert(asnProfileTable).values({
      asn: SENTINEL_ASN,
      countryCount: 3,
      primaryCountry: "US",
    });

    const { lookupAsn } = await import("./lookup");
    const result = await lookupAsn(SENTINEL_ASN);
    expect(result?.reach?.rank).toBe(5);
    expect(result?.profile?.countryCount).toBe(3);
    expect(result?.profile?.primaryCountry).toBe("US");
  });
});
