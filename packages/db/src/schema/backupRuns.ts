import {
  uuid,
  text,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * History of `pg_dump` snapshots — both the automatic periodic ones (see
 * `@workspace/collector`'s maintenance scheduler, gated by the config file's
 * `backupEnabled`/`backupIntervalHours`) and manually-triggered ones
 * (`ip-insight backup create`). `filePath` is what `ip-insight backup
 * restore` takes as its argument; `backupRetentionCount` prunes both the
 * file on disk and its row here, oldest first.
 */
export const backupRunsTable = opsSchema.table(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    filePath: text("file_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    errorMessage: text("error_message"),
  },
  (t) => ({
    startedIdx: index("backup_runs_started_idx").on(t.startedAt),
  }),
);

export type BackupRun = typeof backupRunsTable.$inferSelect;
export type InsertBackupRun = typeof backupRunsTable.$inferInsert;
