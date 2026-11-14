/**
 * With no RPKI data loaded (the source disabled, or never run), ip_intel's
 * `rpki_status` must be unknown (NULL), not 'not-found' — which would claim
 * every prefix on the internet has no ROA. Found in a real build made with
 * an empty rpki_roas (docs/107).
 *
 * Everything — the emptied rpki_roas, the test rows, the TEMP VIEW — lives
 * in one transaction that is rolled back (test-support/scratch-ip-intel.ts),
 * so a database holding real RPKI data keeps it.
 */
import { describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
const NET = "192.0.2.0/24"; // RFC 5737 TEST-NET-1
const TAG = "rpki-empty-test";

describe.skipIf(!hasDb)("rpki_status without RPKI data", () => {
  // The definition is evaluated against whatever else the database holds;
  // on a full real dataset that takes longer than vitest's 5 s default.
  it("is NULL when rpki_roas is empty, 'not-found' once any ROA exists", { timeout: 300_000 }, async () => {
    const { sql } = await import("drizzle-orm");
    const { withScratchIpIntel } = await import("../test-support/scratch-ip-intel");

    const [whenEmpty, whenLoaded] = await withScratchIpIntel(async (tx) => {
      await tx.execute(sql`DELETE FROM rpki_roas`);
      await tx.execute(sql`INSERT INTO ip_blocks (network, rir, status, country) VALUES (${NET}::inet, ${TAG}, 'allocated', 'US')`);
      await tx.execute(sql`INSERT INTO bgp_origin_ranges (network, asn, peer_count, source) VALUES (${NET}::inet, 64500, 1, ${TAG})`);
      const status = async () => {
        const { rows } = await tx.execute<{ rpki_status: string | null }>(sql`
          SELECT rpki_status FROM ip_intel_scratch WHERE network = ${NET}::inet
        `);
        return rows[0]?.rpki_status ?? null;
      };
      const empty = await status();
      // A ROA somewhere else entirely: RPKI data now exists, none covers NET.
      await tx.execute(sql`INSERT INTO rpki_roas (prefix, max_length, asn, source) VALUES ('198.18.0.0/15'::inet, 15, 64511, ${TAG})`);
      return [empty, await status()];
    });

    expect(whenEmpty).toBeNull();
    expect(whenLoaded).toBe("not-found");
  });
});
