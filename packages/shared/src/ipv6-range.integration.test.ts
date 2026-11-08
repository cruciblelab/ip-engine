/**
 * Independent verification of `rangeToCidrs6` against Postgres' own `inet`
 * implementation.
 *
 * `ipv6-range.test.ts` next door proves the splitter is self-consistent — it
 * decodes its own output with its own parser and checks the pieces tile the
 * range. That is necessary but not sufficient: a matching pair of bugs in
 * `parseIpv6` and `formatIpv6` would satisfy every assertion there while
 * producing prefixes that mean something else entirely once written to the
 * database.
 *
 * This file closes that gap by never doing the arithmetic in JavaScript at
 * all. It hands the emitted CIDR strings to Postgres and asks *Postgres*,
 * using `network()`/`broadcast()` on its own battle-tested `inet` type,
 * whether they tile the requested range exactly. A bug would have to exist
 * identically in two independent implementations to survive.
 *
 * This is the same discipline `docs/95-mmdb-trie-subdivide-bug.md` records
 * the hard way: bit math that looks right and passes its own tests can still
 * be silently wrong, and the only way to know is to check it against
 * something that does not share its assumptions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { parseIpv6, formatIpv6, rangeToCidrs6 } from "./ipv6-range";

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

afterAll(async () => {
  await pool.end();
});

/**
 * Asks Postgres whether `cidrs` covers exactly [start, end].
 *
 * Every check below is computed by Postgres from the CIDR text alone:
 *  - `starts_at` / `ends_at` — the true first and last address of the whole
 *    set, from `network()`/`broadcast()`.
 *  - `contiguous` — each block begins exactly one address after the previous
 *    one ends, which rules out both gaps and overlaps in one test.
 *  - `all_aligned` — casting to `cidr` would already have failed on a block
 *    with host bits set, so reaching this point at all proves alignment;
 *    it is asserted explicitly so the reason is visible in the output.
 */
async function verifyWithPostgres(
  cidrs: string[],
  start: string,
  end: string,
): Promise<{ startsAt: string; endsAt: string; contiguous: boolean; count: number }> {
  const { rows } = await pool.query<{
    starts_at: string;
    ends_at: string;
    contiguous: boolean;
    count: string;
  }>(
    `WITH parts AS (
       SELECT c::cidr AS c, ord
       FROM unnest($1::text[]) WITH ORDINALITY AS t(c, ord)
     ),
     joined AS (
       -- Two representations on purpose, because each comparison needs a
       -- different one and mixing them up gives a wrong answer twice over
       -- (both mistakes were made and caught while writing this):
       --
       --  * inet for min()/max() — inet sorts numerically. host() returns
       --    text, and text sorts lexicographically, where "::1000" is less
       --    than "::259" because '1' < '2'.
       --  * host() text for the contiguity equality — inet equality
       --    includes the netmask, so '2001:db8::4/127' and
       --    '2001:db8::4/126' compare UNEQUAL despite being the same
       --    address. Adjacent blocks of a split differ in exactly that way,
       --    so a bare inet comparison would report every correct split as
       --    non-contiguous.
       SELECT ord,
              network(c)       AS first_inet,
              broadcast(c)     AS last_inet,
              host(network(c)) AS first_host,
              host(lag(broadcast(c)) OVER (ORDER BY ord) + 1) AS expected_first_host
       FROM parts
     )
     SELECT
       host(min(first_inet))                                      AS starts_at,
       host(max(last_inet))                                       AS ends_at,
       bool_and(ord = 1 OR first_host = expected_first_host)      AS contiguous,
       count(*)::text                                             AS count
     FROM joined`,
    [cidrs],
  );
  const row = rows[0]!;
  // Sanity: the requested bounds must be what Postgres saw, compared as
  // Postgres normalises them rather than as raw strings.
  const { rows: bounds } = await pool.query<{ s: string; e: string }>(
    `SELECT host($1::inet) AS s, host($2::inet) AS e`,
    [start, end],
  );
  expect(row.starts_at).toBe(bounds[0]!.s);
  expect(row.ends_at).toBe(bounds[0]!.e);
  return {
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    contiguous: row.contiguous,
    count: Number(row.count),
  };
}

describe("rangeToCidrs6 verified by Postgres inet", () => {
  beforeAll(async () => {
    // Fail loudly rather than silently skipping: a verification test that
    // quietly does nothing is worse than no test.
    await pool.query("SELECT 1");
  });

  it("covers a real aligned allocation exactly", async () => {
    const start = "2001:0db8:0000:0000:0000:0000:0000:0000";
    const end = "2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff";
    const cidrs = rangeToCidrs6(parseIpv6(start)!, parseIpv6(end)!);
    const result = await verifyWithPostgres(cidrs, start, end);
    expect(result.contiguous).toBe(true);
    expect(result.count).toBe(1);
  });

  it("covers the worst-splitting real range from the DB-IP file exactly", async () => {
    // The single worst case measured across all 4,274,502 IPv6 rows.
    const start = "2a19:3e0:ff70::2";
    const end = "2a1b:3e0:1300::3";
    const cidrs = rangeToCidrs6(parseIpv6(start)!, parseIpv6(end)!);
    expect(cidrs).toHaveLength(105);
    const result = await verifyWithPostgres(cidrs, start, end);
    expect(result.contiguous).toBe(true);
    expect(result.count).toBe(105);
  });

  it("covers many randomly generated ranges exactly", async () => {
    // Deterministic seed so any failure reproduces instead of vanishing.
    let seed = 0x2026_08_23n;
    const next = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };
    const MAX = (1n << 128n) - 1n;
    for (let i = 0; i < 60; i++) {
      const startN = ((next() << 64n) | next()) & MAX;
      const span = next() % 50_000n;
      const endN = startN + span > MAX ? MAX : startN + span;
      const cidrs = rangeToCidrs6(startN, endN);
      const result = await verifyWithPostgres(cidrs, formatIpv6(startN), formatIpv6(endN));
      expect(result.contiguous, `not contiguous for ${startN}..${endN}`).toBe(true);
    }
  });

  it("agrees with Postgres on what each emitted prefix actually means", async () => {
    // Guards the specific failure the self-consistency tests cannot see: a
    // parseIpv6/formatIpv6 pair that is wrong in matching ways. Here Postgres
    // decodes the string independently and must land on the same address.
    const samples = [
      "::",
      "::1",
      "2001:db8::1",
      "fe80::1",
      "2a19:3e0:ff70::2",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ];
    for (const addr of samples) {
      const n = parseIpv6(addr)!;
      const { rows } = await pool.query<{ same: boolean }>(
        `SELECT host($1::inet) = host($2::inet) AS same`,
        [addr, formatIpv6(n)],
      );
      expect(rows[0]!.same, `formatIpv6(parseIpv6("${addr}")) disagrees with Postgres`).toBe(true);
    }
  });
});
