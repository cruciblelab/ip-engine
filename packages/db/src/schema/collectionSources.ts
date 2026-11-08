import {
  serial,
  text,
  uuid,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";
import { collectionJobsTable } from "./collectionJobs";

export const collectionSourcesTable = opsSchema.table(
  "collection_sources",
  {
    id: serial("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => collectionJobsTable.id, { onDelete: "cascade" }),
    rir: text("rir").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("pending"),
    recordsIngested: bigint("records_ingested", { mode: "number" })
      .notNull()
      .default(0),
    recordsSkipped: bigint("records_skipped", { mode: "number" })
      .notNull()
      .default(0),
    bytesDownloaded: bigint("bytes_downloaded", { mode: "number" })
      .notNull()
      .default(0),
    ipv4Count: bigint("ipv4_count", { mode: "number" }).notNull().default(0),
    ipv6Count: bigint("ipv6_count", { mode: "number" }).notNull().default(0),
    asnCount: bigint("asn_count", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    etag: text("etag"),
    lastModified: text("last_modified"),
  },
  (t) => ({
    jobIdx: index("collection_sources_job_idx").on(t.jobId),
    rirStatusIdx: index("collection_sources_rir_status_idx").on(t.rir, t.status),
  }),
);

export type CollectionSource = typeof collectionSourcesTable.$inferSelect;
export type InsertCollectionSource =
  typeof collectionSourcesTable.$inferInsert;
