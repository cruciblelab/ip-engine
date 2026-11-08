import { uuid, text, timestamp, bigint, integer, jsonb, index } from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * One row per attempt to publish a new `.mmdb` — the record of what is
 * actually being served, and of every candidate that was rejected before it
 * could be.
 *
 * The serving path reads a file, not this table; this exists so the question
 * "is today's file live, and if not, why not?" has an answer that doesn't
 * involve reading logs. A rejected build is the interesting case: nothing
 * broke, the previous file kept serving, and without a record of it the only
 * visible symptom weeks later is data that quietly stopped changing.
 *
 * `status`:
 *  - `published` — validated and promoted; this is what `current.mmdb` points at.
 *  - `rejected`  — built, but failed validation. Previous file still serving.
 *  - `failed`    — the build itself errored; no candidate file exists.
 */
export const mmdbPublishesTable = opsSchema.table(
  "mmdb_publishes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Absolute path of the candidate file, kept even when rejected so it can
     * be inspected rather than guessed about. */
    filePath: text("file_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Prefixes written into the file. */
    prefixes: integer("prefixes"),
    /** How many records carried each field, keyed by field name (e.g.
     * `{"country": 2481032, "city": 1904221, ...}`). Only ever read back
     * from the most recent *published* row, to give the next build's
     * field-completeness check something to compare against — a field
     * whose count craters between two builds with similar `prefixes`
     * totals is a build that quietly went wrong in one column, which
     * `prefixes` alone can't see. Absent on rows written before this
     * column existed; treated the same as a brand-new field (nothing to
     * compare, check skipped rather than failed). */
    fieldCounts: jsonb("field_counts"),
    /** Every validation check and its outcome — the reason a build was
     * rejected, in the same row as the build. */
    checks: jsonb("checks"),
    errorMessage: text("error_message"),
  },
  (t) => ({
    startedIdx: index("mmdb_publishes_started_idx").on(t.startedAt),
  }),
);

export type MmdbPublish = typeof mmdbPublishesTable.$inferSelect;
