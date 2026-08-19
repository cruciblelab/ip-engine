import {
  uuid,
  text,
  timestamp,
  bigint,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

export const enrichmentJobsTable = opsSchema.table(
  "enrichment_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** See collectionJobsTable.seq — same purpose, for "enrich-000123". */
    seq: serial("seq").notNull(),
    status: text("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    totalIngested: bigint("total_ingested", { mode: "number" })
      .notNull()
      .default(0),
    totalSkipped: bigint("total_skipped", { mode: "number" })
      .notNull()
      .default(0),
    errorMessage: text("error_message"),
  },
  (t) => ({
    statusIdx: index("enrichment_jobs_status_idx").on(t.status),
    startedIdx: index("enrichment_jobs_started_idx").on(t.startedAt),
  }),
);

export type EnrichmentJob = typeof enrichmentJobsTable.$inferSelect;
export type InsertEnrichmentJob = typeof enrichmentJobsTable.$inferInsert;
