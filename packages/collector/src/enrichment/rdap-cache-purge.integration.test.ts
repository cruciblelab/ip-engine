/**
 * With `rdapEnabled` false, `enrich` removes what live RDAP queries cached —
 * and only that. RFC 5737 TEST-NET-2 (198.51.100.0/24) keeps it away from
 * real data.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const NET = "198.51.100.64/26";

async function cleanup(): Promise<void> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`DELETE FROM abuse_contacts WHERE network <<= ${NET}::inet`);
  await db.execute(sql`DELETE FROM network_names WHERE network <<= ${NET}::inet`);
  await db.execute(sql`DELETE FROM geofeed_ranges WHERE network <<= ${NET}::inet`);
}

describe.skipIf(!hasDb)("purgeRdapCache", () => {
  beforeAll(async () => {
    const {
      db,
      abuseContactsTable,
      networkNamesTable,
      geofeedRangesTable,
      RDAP_LIVE_CACHE_SOURCE,
      GEOFEED_LIVE_DISCOVERY_SOURCE_ID,
    } = await import("@workspace/db");
    await cleanup();
    await db.insert(abuseContactsTable).values([
      { network: NET, email: "rdap@example.net", source: RDAP_LIVE_CACHE_SOURCE },
      { network: NET, email: "security@example.net", source: "security-txt-test" },
    ]);
    await db.insert(networkNamesTable).values({ network: NET, name: "EXAMPLE-NET", source: RDAP_LIVE_CACHE_SOURCE });
    await db.insert(geofeedRangesTable).values([
      { network: NET, country: "DE", city: "LIVE", sourceId: GEOFEED_LIVE_DISCOVERY_SOURCE_ID },
      { network: NET, country: "FR", city: "BULK", sourceId: "rdap-purge-test-bulk" },
    ]);
  });

  afterAll(cleanup);

  it("removes RDAP-cached rows and leaves security.txt contacts and bulk geofeeds", async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const { purgeRdapCache } = await import("./rdap-cache-purge");

    const removed = await purgeRdapCache();
    expect(removed.abuseContacts).toBeGreaterThanOrEqual(1);
    expect(removed.networkNames).toBeGreaterThanOrEqual(1);
    expect(removed.geofeedRows).toBeGreaterThanOrEqual(1);

    const left = async (q: ReturnType<typeof sql>) => (await db.execute<{ v: string }>(q)).rows.map((r) => r.v);
    expect(await left(sql`SELECT email AS v FROM abuse_contacts WHERE network <<= ${NET}::inet`)).toEqual([
      "security@example.net",
    ]);
    expect(await left(sql`SELECT name AS v FROM network_names WHERE network <<= ${NET}::inet`)).toEqual([]);
    expect(await left(sql`SELECT city AS v FROM geofeed_ranges WHERE network <<= ${NET}::inet`)).toEqual(["BULK"]);
  });
});
