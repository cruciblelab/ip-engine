/**
 * Pins the geo-source precedence chain end to end through the *live* lookup
 * path — not through `ip_intel`.
 *
 * That distinction is the reason this file exists. DB-IP Lite was first
 * wired only into `ip_intel` (which feeds the `.mmdb` export and direct SQL
 * consumers), and the four scenarios were verified there with raw SQL. The
 * live path in `lookup.ts` — what `ip-insight lookup` and the API server
 * actually use — queries the source tables directly and was left untouched,
 * so for a while the same address answered `dbip-lite` from the file and
 * `null` from the API. Found only by running a real lookup against real
 * ingested data.
 *
 * These tests therefore go through `lookupIp()` itself, so the two halves of
 * the product cannot drift apart again without something going red.
 *
 * Uses RFC 5737 / RFC 3849 documentation ranges, which are reserved for
 * exactly this and can never collide with real ingested data.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

const V4 = "198.51.100.0/24";
// A distinct address per test, all inside the /28 seeded below. lookupIp
// caches per address, and these tests deliberately change what covers an
// address between cases — reusing one address would serve a stale cached
// answer rather than the one under test. Cheaper and less invasive than
// exporting a cache-reset hook from production code purely for tests.
const V4_ADDR = "198.51.100.7";
const V4_ADDR_CONF = "198.51.100.8";
const V4_ADDR_GEOFEED = "198.51.100.9";
const V4_ADDR_ANYCAST = "198.51.100.10";
const V6 = "2001:db8:c0de::/48";
const V6_ADDR = "2001:db8:c0de::7";
const TAG = "geo-tiers-test";

describe.skipIf(!hasDb)("geo source precedence (live lookup path)", () => {
  beforeAll(async () => {
    const { db, ipBlocksTable, dbipLiteRangesTable, geofeedRangesTable, anycastRangesTable } =
      await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    // Clean first so a previous failed run can't poison this one.
    await db.execute(sql`DELETE FROM ip_blocks WHERE rir = ${TAG}`);
    // `>>=` not `<<=`: anything *containing* the documentation range counts
    // too. A stray wider geofeed left behind by unrelated manual testing
    // wins the precedence chain and silently makes these assertions test
    // something else — which is exactly what happened on the first run.
    await db.execute(
      sql`DELETE FROM geofeed_ranges WHERE network >>= ${V4}::inet OR network >>= ${V6}::inet OR source_id = ${TAG}`,
    );
    await db.execute(
      sql`DELETE FROM dbip_lite_ranges WHERE network >>= ${V4}::inet OR network >>= ${V6}::inet OR network <<= ${V4}::inet OR network <<= ${V6}::inet`,
    );
    await db.execute(
      sql`DELETE FROM anycast_ranges WHERE network >>= ${V4}::inet OR network >>= ${V6}::inet`,
    );

    await db.insert(ipBlocksTable).values([
      { network: V4, rir: TAG, status: "allocated", country: "US" },
      { network: V6, rir: TAG, status: "allocated", country: "US" },
    ]);
    // Deliberately NARROWER than the geofeed added in the precedence test:
    // a more specific inferred row must still lose to a wider real geofeed.
    await db.insert(dbipLiteRangesTable).values([
      {
        network: "198.51.100.0/28",
        country: "NL",
        region: "North Holland",
        city: "DBIP-V4-CITY",
        latitude: 52.37,
        longitude: 4.9,
      },
      {
        network: "2001:db8:c0de::/64",
        country: "NL",
        region: "North Holland",
        city: "DBIP-V6-CITY",
        latitude: 52.37,
        longitude: 4.9,
      },
    ]);
  });

  afterAll(async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`DELETE FROM ip_blocks WHERE rir = ${TAG}`);
    await db.execute(sql`DELETE FROM geofeed_ranges WHERE source_id = ${TAG}`);
    await db.execute(
      sql`DELETE FROM dbip_lite_ranges WHERE network <<= ${V4}::inet OR network <<= ${V6}::inet`,
    );
    await db.execute(
      sql`DELETE FROM anycast_ranges WHERE network <<= ${V4}::inet OR network <<= ${V6}::inet`,
    );
  });

  it("uses dbip-lite when no geofeed covers the address (IPv4)", async () => {
    const { lookupIp } = await import("./lookup");
    const r = await lookupIp(V4_ADDR);
    expect(r.geo.geo_source).toBe("dbip-lite");
    expect(r.geo.city).toBe("DBIP-V4-CITY");
    // City, region and country must come from one source together — mixing
    // DB-IP's city with the RIR's country produced a real incoherent answer
    // ("Amsterdam, North Holland, US") before this was fixed.
    expect(r.geo.country).toBe("NL");
    expect(r.geo.region).toBe("North Holland");
    expect(r.flags).toContain("geo:dbip-lite");
    // The extent of the claim, not the address asked about: the seeded row
    // is a /28 and the lookup was for a single address inside it.
    expect(r.geo.geo_network).toBe("198.51.100.0/28");
    // Inferred, so it must arrive labelled — a caller who never reads
    // confidence.geo still cannot mistake it for an operator statement.
    expect(r.flags).toContain("geo:city-approximate");
  });

  it("uses dbip-lite for IPv6 too — the whole point of the 128-bit splitter", async () => {
    const { lookupIp } = await import("./lookup");
    const r = await lookupIp(V6_ADDR);
    expect(r.geo.geo_source).toBe("dbip-lite");
    expect(r.geo.city).toBe("DBIP-V6-CITY");
    expect(r.geo.country).toBe("NL");
  });

  it("scores dbip-lite between a geofeed and a country-estimate", async () => {
    const { lookupIp } = await import("./lookup");
    const r = await lookupIp(V4_ADDR_CONF);
    // Not asserting the exact number — asserting the ordering that gives the
    // field its meaning, which is what a caller actually relies on.
    expect(r.confidence.geo).not.toBeNull();
    expect(r.confidence.geo!).toBeGreaterThan(0.2); // above country-estimate
    expect(r.confidence.geo!).toBeLessThan(0.8); // below a real geofeed
  });

  it("lets a WIDER real geofeed beat a NARROWER dbip-lite row", async () => {
    const { db, geofeedRangesTable } = await import("@workspace/db");
    const { lookupIp } = await import("./lookup");
    await db.insert(geofeedRangesTable).values({
      network: V4, // /24 — less specific than the /28 dbip row above
      country: "DE",
      city: "GEOFEED-CITY",
      sourceId: TAG,
      confidence: 0.85,
    });
    const r = await lookupIp(V4_ADDR_GEOFEED);
    expect(r.geo.geo_source).toBe("geofeed");
    expect(r.geo.city).toBe("GEOFEED-CITY");
    // Operator-published: reports its own prefix, and is the one source that
    // is NOT labelled approximate.
    expect(r.geo.geo_network).toBe(V4);
    expect(r.flags).not.toContain("geo:city-approximate");
    await db.execute(
      (await import("drizzle-orm")).sql`DELETE FROM geofeed_ranges WHERE source_id = ${TAG}`,
    );
  });

  it("suppresses the dbip-lite city entirely for an anycast address", async () => {
    const { db, anycastRangesTable } = await import("@workspace/db");
    const { lookupIp } = await import("./lookup");
    await db.insert(anycastRangesTable).values({ network: V4 });
    const r = await lookupIp(V4_ADDR_ANYCAST);
    expect(r.geo.geo_source).toBe("anycast");
    expect(r.geo.city).toBeNull();
    expect(r.geo.latitude).toBeNull();
    // No location claim is being made at all, so there is no network the
    // claim could be about.
    expect(r.geo.geo_network).toBeNull();
    await db.execute(
      (await import("drizzle-orm")).sql`DELETE FROM anycast_ranges WHERE network = ${V4}::inet`,
    );
  });
});
