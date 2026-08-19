import {
  uuid,
  text,
  timestamp,
  bigint,
  serial,
  index,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

export const collectionJobsTable = opsSchema.table(
  "collection_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic counter, independent of `id` — only used to render a
     * human-friendly display id ("collect-000123") when
     * `checkpointIdFormat` is "sequential"; the uuid `id` stays the real
     * primary key and foreign-key target either way. */
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
    statusIdx: index("collection_jobs_status_idx").on(t.status),
    startedIdx: index("collection_jobs_started_idx").on(t.startedAt),
  }),
);

export type CollectionJob = typeof collectionJobsTable.$inferSelect;
export type InsertCollectionJob = typeof collectionJobsTable.$inferInsert;
