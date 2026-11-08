/**
 * Real-Postgres test for the field-completeness check added 2026-08-04 —
 * see mmdb-publish.ts's `validate()` for why row/prefix counts alone can't
 * catch a field going silently bulk-null. Goes through `validate()` against
 * a real, small, synthetic `.mmdb` and a real `ops.mmdb_publishes` row
 * rather than `publishMmdb()` end-to-end, which needs a fully materialized
 * `ip_intel` (hours on a full dataset) — this exercises the same DB
 * read/write path and ratio logic at a fraction of the cost.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, mmdbPublishesTable } from "@workspace/db";
import { buildMmdb } from "./mmdb-writer";
import { validate, DEFAULT_GOLDEN_SET } from "./mmdb-publish";

describe("mmdb-publish field-completeness check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmdb-field-test-"));
  const insertedIds: string[] = [];

  afterAll(async () => {
    for (const id of insertedIds) {
      await db.delete(mmdbPublishesTable).where(eq(mmdbPublishesTable.id, id));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags a field that went bulk-null while row count stayed put, and leaves golden-covered fields alone", async () => {
    // A "previous publish" with healthy field coverage across 1,000 rows.
    const [previous] = await db
      .insert(mmdbPublishesTable)
      .values({
        status: "published",
        prefixes: 1000,
        fieldCounts: { asn: 1000, country: 1000, verified_bot: 5, city: 800, rpki_status: 950 },
      })
      .returning();
    if (!previous) throw new Error("seed insert failed");
    insertedIds.push(previous.id);

    // A real, tiny, readable .mmdb — validate()'s first check re-opens the
    // file with the actual MaxMind reader, so this has to be a real one, not
    // a stub. Content doesn't matter to the field-completeness check itself
    // (it only reads the fieldCounts argument), just needs to exist.
    const built = buildMmdb(
      [{ network: "8.8.8.8/32", record: { asn: 15169, country: "US" } }],
      { databaseType: "test", description: { en: "test" } },
    );
    const candidate = path.join(dir, "candidate.mmdb");
    fs.writeFileSync(candidate, built.buffer);

    // Same row count as before (1000), but `city` collapsed to 200/800
    // (25%, well under the 80% floor) while `rpki_status` held steady and
    // `asn`/`country` — both golden-covered — also collapsed. The check
    // should catch `city`, ignore `asn`/`country` entirely (golden already
    // covers them), and pass `rpki_status`.
    const fieldCounts = { asn: 10, country: 10, verified_bot: 5, city: 200, rpki_status: 940 };
    const checks = await validate(candidate, 1000, fieldCounts, { dir });

    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

    expect(byName["field-completeness:city"]?.ok).toBe(false);
    expect(byName["field-completeness:rpki_status"]?.ok).toBe(true);
    // asn/country are asserted by DEFAULT_GOLDEN_SET, so no separate
    // field-completeness check should exist for them regardless of how much
    // their raw counts moved.
    expect(byName["field-completeness:asn"]).toBeUndefined();
    expect(byName["field-completeness:country"]).toBeUndefined();
    expect(DEFAULT_GOLDEN_SET.some((g) => "asn" in g.expect)).toBe(true);

    // verified_bot is also golden-covered (DEFAULT_GOLDEN_SET's 66.249.66.1
    // case) — skipped here too, same as asn/country, regardless of count.
    expect(byName["field-completeness:verified_bot"]).toBeUndefined();

    // prefix-count itself still runs unaffected by any of the above.
    expect(byName["prefix-count"]?.ok).toBe(true);
  });

  it("skips a field with no previous count instead of failing it", async () => {
    const [previous] = await db
      .insert(mmdbPublishesTable)
      .values({
        status: "published",
        prefixes: 500,
        fieldCounts: { asn: 500, country: 500 },
      })
      .returning();
    if (!previous) throw new Error("seed insert failed");
    insertedIds.push(previous.id);

    const built = buildMmdb(
      [{ network: "1.1.1.1/32", record: { asn: 13335 } }],
      { databaseType: "test", description: { en: "test" } },
    );
    const candidate = path.join(dir, "candidate2.mmdb");
    fs.writeFileSync(candidate, built.buffer);

    // `stable_since` never appeared in the previous build (e.g.
    // mmdbHistoryFields just got turned on) — must not be treated as a
    // 100%-to-0% collapse.
    const fieldCounts = { asn: 5, country: 500, stable_since: 300 };
    const checks = await validate(candidate, 500, fieldCounts, { dir });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

    expect(byName["field-completeness:stable_since"]).toBeUndefined();
  });
});
