import { uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * One row per `captureBaseline()` run — the answer to "did history actually
 * get recorded, and what happened?" without reading log files.
 *
 * This exists because history is the one part of this project whose value
 * comes from *not* being interrupted: every signal derived from
 * `prefix_history` (how recently a prefix changed hands, how volatile an
 * ASN's announcements are) is worth exactly as much as the unbroken time
 * span behind it. A capture that silently failed for three weeks doesn't
 * announce itself — the tables just quietly stop growing — so each run
 * records what it did, including the ones that were skipped and why.
 *
 * `trigger` distinguishes runs that fired automatically at the end of an
 * enrichment (`historyCaptureEnabled` in the config file) from ones a human
 * started with `ip-insight history capture`. `status` includes `skipped`,
 * which is not a failure: a capture that can't run because `ip_intel` isn't
 * materialized is a configuration state worth recording rather than an
 * error worth alarming about.
 */
export const historyCapturesTable = opsSchema.table(
  "history_captures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "running" | "completed" | "failed" | "skipped" */
    status: text("status").notNull().default("running"),
    /** "auto" (end of an enrichment run) | "manual" (`history capture`) */
    trigger: text("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Prefixes whose record differed from the stored baseline. */
    changed: integer("changed"),
    /** Prefixes that vanished from `ip_intel` entirely. */
    removed: integer("removed"),
    /** Prefixes seen for the first time. */
    added: integer("added"),
    /** Total baseline size after the run — the "how much do we track" number. */
    baselineSize: integer("baseline_size"),
    /** Why a run failed, or why it was skipped. */
    errorMessage: text("error_message"),
  },
  (t) => ({
    startedIdx: index("history_captures_started_idx").on(t.startedAt),
  }),
);

export type HistoryCapture = typeof historyCapturesTable.$inferSelect;
export type InsertHistoryCapture = typeof historyCapturesTable.$inferInsert;
