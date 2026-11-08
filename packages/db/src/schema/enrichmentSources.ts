import {
  serial,
  text,
  uuid,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";
import { enrichmentJobsTable } from "./enrichmentJobs";

export const enrichmentSourcesTable = opsSchema.table(
  "enrichment_sources",
  {
    id: serial("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => enrichmentJobsTable.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    kind: text("kind").notNull(),
    // Nullable: "derived" sources (see enrichment-sources.ts) compute from
    // tables already in this database and download nothing, so they have no
    // upstream URL to record.
    url: text("url"),
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
    /**
     * SHA-256 of the bytes actually downloaded this run, hex-encoded.
     *
     * Recorded for our own sake, not as any kind of attestation: comparing it
     * against the previous run's answers "did this upstream file genuinely
     * change, or did we just re-ingest an identical copy?" — a question the
     * row counts can't settle, since a source can change content without
     * changing size. It also catches a truncated or corrupted download that
     * parsed cleanly enough to look successful.
     *
     * Null for "derived" sources, which download nothing, and for runs that
     * failed before the body was read.
     */
    contentHash: text("content_hash"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
  (t) => ({
    jobIdx: index("enrichment_sources_job_idx").on(t.jobId),
  }),
);

export type EnrichmentSource = typeof enrichmentSourcesTable.$inferSelect;
export type InsertEnrichmentSource =
  typeof enrichmentSourcesTable.$inferInsert;
