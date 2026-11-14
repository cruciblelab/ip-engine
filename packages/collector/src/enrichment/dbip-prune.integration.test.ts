/**
 * Live-collected geofeed rows must not reach what customers receive.
 *
 * `lookup/rdap.ts` caches geofeeds it discovers at query time in
 * `geofeed_ranges` under `GEOFEED_LIVE_DISCOVERY_SOURCE_ID`. Before
 * 2026-11-12 those rows flowed into `ip_intel` — and from there into the
 * customer `.mmdb` — exactly like bulk-ingested ones, and DB-IP's prune
 * deleted the fallback answer underneath them. Both halves are pinned here:
 *
 *  1. `ip_intel` ignores live rows: an address under one answers from DB-IP,
 *     not from the live row, and the live row's prefix gets no base row.
 *  2. The DB-IP prune ignores live rows, so that DB-IP answer still exists.
 *
 * A bulk geofeed row sits beside the live one as the control: it must still
 * win over DB-IP, and DB-IP rows under it must still be pruned.
 *
 * Uses RFC 5737 TEST-NET-3 (203.0.113.0/24), reserved for documentation, so
 * it cannot collide with real ingested data.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

const BLOCK = "203.0.113.0/24";
const LIVE_HALF = "203.0.113.0/25";
const BULK_HALF = "203.0.113.128/25";
const TAG = "live-geofeed-exclusion-test";

async function cleanup(): Promise<void> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`DELETE FROM ip_blocks WHERE rir = ${TAG} OR network <<= ${BLOCK}::inet`);
  await db.execute(sql`DELETE FROM geofeed_ranges WHERE network <<= ${BLOCK}::inet OR network >>= ${BLOCK}::inet`);
  await db.execute(sql`DELETE FROM dbip_lite_ranges WHERE network <<= ${BLOCK}::inet OR network >>= ${BLOCK}::inet`);
}

describe.skipIf(!hasDb)("live-discovered geofeeds stay out of the customer data", () => {
  beforeAll(async () => {
    const { db, ipBlocksTable, geofeedRangesTable, dbipLiteRangesTable, GEOFEED_LIVE_DISCOVERY_SOURCE_ID } =
      await import("@workspace/db");
    await cleanup();
    await db.insert(ipBlocksTable).values({ network: BLOCK, rir: TAG, status: "allocated", country: "US" });
    // One DB-IP row per half, so the prune's effect on each half is visible.
    await db.insert(dbipLiteRangesTable).values([
      { network: LIVE_HALF, country: "NL", region: "North Holland", city: "DBIP-UNDER-LIVE", latitude: 52.37, longitude: 4.9 },
      { network: BULK_HALF, country: "NL", region: "North Holland", city: "DBIP-UNDER-BULK", latitude: 52.37, longitude: 4.9 },
    ]);
    await db.insert(geofeedRangesTable).values([
      { network: LIVE_HALF, country: "DE", city: "LIVE-CITY", sourceId: GEOFEED_LIVE_DISCOVERY_SOURCE_ID },
      { network: BULK_HALF, country: "FR", city: "BULK-CITY", sourceId: TAG },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  // The prune scans all of dbip_lite_ranges, which on a database holding a
  // real DB-IP load is millions of rows — vitest's 5 s default is too short.
  it("prunes DB-IP only under the bulk geofeed, never under the live one", { timeout: 300_000 }, async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const { pruneDbIpCoveredByGeofeeds } = await import("./dbip-prune");

    await pruneDbIpCoveredByGeofeeds();

    const { rows } = await db.execute<{ city: string }>(
      sql`SELECT city FROM dbip_lite_ranges WHERE network <<= ${BLOCK}::inet ORDER BY city`,
    );
    expect(rows.map((r) => r.city)).toEqual(["DBIP-UNDER-LIVE"]);
  });

  // Queried through a rolled-back TEMP VIEW of the ip_intel definition, never
  // the real ip_intel — see test-support/scratch-ip-intel.ts for why.
  it("ip_intel answers from DB-IP under the live row and from the bulk geofeed beside it", async () => {
    const { sql } = await import("drizzle-orm");
    const { withScratchIpIntel } = await import("../test-support/scratch-ip-intel");

    const [underLive, underBulk] = await withScratchIpIntel(async (tx) => {
      const at = async (ip: string) => {
        const { rows } = await tx.execute<{ city: string | null }>(sql`
          SELECT city FROM ip_intel_scratch
          WHERE network >>= ${ip}::inet ORDER BY masklen(network) DESC LIMIT 1
        `);
        return rows[0];
      };
      return [await at("203.0.113.5"), await at("203.0.113.200")];
    });

    expect(underLive?.city).toBe("DBIP-UNDER-LIVE");
    expect(underBulk?.city).toBe("BULK-CITY");
  });

  it("gives the live row's answer no row in ip_intel", async () => {
    const { sql } = await import("drizzle-orm");
    const { withScratchIpIntel } = await import("../test-support/scratch-ip-intel");
    // The live /25 still exists as a DB-IP range, so a base row for that
    // prefix is expected — what must not happen is any row carrying the
    // live geofeed's answer.
    const n = await withScratchIpIntel(async (tx) => {
      const { rows } = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM ip_intel_scratch
        WHERE network <<= ${BLOCK}::inet AND city = 'LIVE-CITY'
      `);
      return rows[0]?.n;
    });
    expect(n).toBe(0);
  });
});
