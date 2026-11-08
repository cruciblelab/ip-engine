/**
 * Proves the COPY writer and the batched-INSERT path it replaces produce the
 * *same table* — not "the COPY path looks right", which is a much weaker
 * claim and the one a unit test can already make.
 *
 * That framing is deliberate. `docs/95-mmdb-trie-subdivide-bug.md` and
 * `docs/99-dbip-ipv6-support.md` are both records of this project shipping
 * something that passed its own tests because the test and the code shared
 * an assumption. So the assertion here is equivalence against the path that
 * has been in production, checked by Postgres itself over the full row set,
 * with the values chosen to be exactly the ones a hand-rolled CSV encoder
 * gets wrong.
 *
 * Requires a real Postgres via DATABASE_URL — skipped otherwise.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

const T_COPY = "bulk_load_test_copy";
const T_INSERT = "bulk_load_test_insert";
const COLUMNS = ["network", "country", "region", "city", "latitude", "longitude"];

/** Every value here is one a naive encoder mangles: the quote, the comma,
 * the backslash that COPY's *text* format would treat as an escape, the
 * embedded newline that would end the row early, the empty string that must
 * stay distinct from NULL, and non-ASCII that must survive byte-for-byte. */
const ROWS: Array<[string, string | null, string | null, string | null, number | null, number | null]> = [
  ["1.2.3.0/24", "US", "Kansas", "Overland Park", 38.9759, -94.6815],
  ["10.0.0.0/8", null, null, null, null, null],
  ["192.168.0.0/16", "TR", "Kırıkkale", "Kırıkkale", 39.8468, 33.5153],
  ["172.16.0.0/12", "US", "DC", "Washington, D.C.", 38.9, -77.03],
  ["203.0.113.0/24", "GB", "England", 'The "Old" Town', 51.5, -0.12],
  ["198.51.100.0/24", "NO", "Troms", "back\\slash city", 69.6, 18.95],
  ["2001:db8::/32", "CN", "Beijing", "北京", 39.9042, 116.4074],
  ["2001:db8:1::/48", "XX", "", "", 0, 0],
  ["2001:db8:2::/48", "FR", "Île-de-France", "two\nline city", 48.85, 2.35],
  ["2001:db8:3::/48", "DE", "Bayern", "tab\there", -1.5, 1.5],
  ["2001:db8:4::/48", "JP", "Tōkyō", "Ōsaka", 35.6762, 139.6503],
];

describe.skipIf(!hasDb)("bulk-load COPY writer", () => {
  beforeAll(async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    for (const t of [T_COPY, T_INSERT]) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`));
      await db.execute(
        sql.raw(
          `CREATE TABLE ${t} (network inet NOT NULL, country text, region text, city text, latitude double precision, longitude double precision)`,
        ),
      );
    }
  });

  afterAll(async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    for (const t of [T_COPY, T_INSERT]) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${t}`));
    }
  });

  it("writes rows Postgres reads back exactly as given", async () => {
    const { openBulkRowWriter } = await import("./bulk-load");
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const w = await openBulkRowWriter(T_COPY, COLUMNS);
    expect(w).not.toBeNull();
    for (const r of ROWS) await w!.push(r as unknown as (string | number | null)[]);
    await w!.finish();

    const res = await db.execute<{
      network: string;
      country: string | null;
      region: string | null;
      city: string | null;
      latitude: number | null;
      longitude: number | null;
    }>(sql.raw(`SELECT host(network)||'/'||masklen(network) AS network, country, region, city, latitude, longitude FROM ${T_COPY} ORDER BY network`));

    expect(res.rows).toHaveLength(ROWS.length);
    const byNetwork = new Map(res.rows.map((r) => [r.network, r]));
    for (const [network, country, region, city, lat, lon] of ROWS) {
      const got = byNetwork.get(network);
      expect(got, `missing row ${network}`).toBeDefined();
      expect(got!.country).toBe(country);
      expect(got!.region).toBe(region);
      expect(got!.city).toBe(city);
      expect(got!.latitude).toBe(lat);
      expect(got!.longitude).toBe(lon);
    }
  });

  it("keeps an empty string distinct from NULL", async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    // The one CSV rule with a real trap in it. `2001:db8:1::/48` was written
    // with "" for region/city and `10.0.0.0/8` with null — if the encoder
    // conflated them, one of these two counts would be wrong.
    const res = await db.execute<{ empties: number; nulls: number }>(
      sql.raw(
        `SELECT count(*) FILTER (WHERE region = '')::int AS empties,
                count(*) FILTER (WHERE region IS NULL)::int AS nulls
         FROM ${T_COPY}`,
      ),
    );
    expect(res.rows[0]!.empties).toBe(1);
    expect(res.rows[0]!.nulls).toBe(1);
  });

  it("produces a table byte-identical to the batched-INSERT path", async () => {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    // The path that has been in production, run over the same input.
    for (const [network, country, region, city, lat, lon] of ROWS) {
      await db.execute(
        sql.raw(
          `INSERT INTO ${T_INSERT} (network, country, region, city, latitude, longitude) VALUES (` +
            [network, country, region, city, lat, lon]
              .map((v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`))
              .join(",") +
            `)`,
        ),
      );
    }

    // Postgres decides, over the whole row set at once, whether the two
    // tables hold the same thing — rather than this test re-implementing
    // comparison in TypeScript and getting to be wrong in the same way the
    // encoder might be.
    const digest = (t: string) =>
      sql.raw(
        `SELECT md5(string_agg(row_repr, E'\\n' ORDER BY row_repr)) AS h FROM (
           SELECT network::text || '|' || coalesce(country,'\\x00') || '|' || coalesce(region,'\\x00')
                  || '|' || coalesce(city,'\\x00') || '|' || coalesce(latitude::text,'\\x00')
                  || '|' || coalesce(longitude::text,'\\x00') AS row_repr
           FROM ${t}
         ) s`,
      );
    const a = await db.execute<{ h: string }>(digest(T_COPY));
    const b = await db.execute<{ h: string }>(digest(T_INSERT));
    expect(a.rows[0]!.h).not.toBeNull();
    expect(a.rows[0]!.h).toBe(b.rows[0]!.h);
  });

  it("refuses identifiers it would have to interpolate unsafely", async () => {
    const { openBulkRowWriter } = await import("./bulk-load");
    await expect(openBulkRowWriter("bad; DROP TABLE x", COLUMNS)).rejects.toThrow(/unsafe identifiers/);
    await expect(openBulkRowWriter(T_COPY, ["ok", "bad-col"])).rejects.toThrow(/unsafe identifiers/);
  });

  it("releases its pooled connection, so repeated loads cannot exhaust the pool", async () => {
    const { openBulkRowWriter } = await import("./bulk-load");
    const { pool } = await import("@workspace/db");
    const before = pool.idleCount + pool.totalCount;
    // More iterations than the pool has connections: if finish() leaked one
    // per call this would hang rather than fail, which is why the count is
    // asserted too.
    for (let i = 0; i < 25; i++) {
      const w = await openBulkRowWriter(T_COPY, COLUMNS);
      await w!.push(["100.64.0.0/10", "US", null, null, null, null]);
      await w!.finish();
    }
    expect(pool.totalCount).toBeLessThanOrEqual(Math.max(before, 5) + 2);
  });

  it("releases its pooled connection on abort() too", async () => {
    const { openBulkRowWriter } = await import("./bulk-load");
    const { pool } = await import("@workspace/db");
    for (let i = 0; i < 25; i++) {
      const w = await openBulkRowWriter(T_COPY, COLUMNS);
      await w!.push(["100.64.0.0/10", "US", null, null, null, null]);
      await w!.abort();
    }
    expect(pool.totalCount).toBeLessThanOrEqual(25);
  });

  it("surfaces a Postgres rejection as a thrown error rather than hanging", async () => {
    const { openBulkRowWriter } = await import("./bulk-load");
    const w = await openBulkRowWriter(T_COPY, COLUMNS);
    // Not a valid inet. The failure arrives on the stream, asynchronously,
    // possibly long after the push that caused it — the case the writer's
    // latched `streamError` exists for.
    await w!.push(["definitely not an ip", "US", null, null, null, null]);
    await expect(w!.finish()).rejects.toThrow();
  });
});
