import {
  serial,
  text,
  integer,
  bigint,
  inet,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * `ops.snapshots` — a named, dated record of what the database contained.
 *
 * The problem it solves: this database is rebuilt from upstream files that
 * change daily, and "the answer changed" is otherwise indistinguishable from
 * "the answer was always wrong". A snapshot pins a version so a consumer can
 * say which build produced a result, reproduce it, and diff two builds
 * against each other.
 *
 * `stats` holds per-table row counts and per-source freshness as free-form
 * JSON rather than columns, because the set of tables is exactly the thing
 * that changes between releases and a rigid schema here would need migrating
 * every time a source is added.
 */
export const snapshotsTable = opsSchema.table(
  "snapshots",
  {
    id: serial("id").primaryKey(),
    /** Operator-supplied or auto-generated, e.g. "2026-07-26" or "v3". */
    version: text("version").notNull(),
    /** Prefixes captured in `snapshot_prefixes` for this version. */
    prefixCount: integer("prefix_count").notNull().default(0),
    /** Row counts per table, last-run timestamps per source, and anything
     * else worth recording about how this build was produced. */
    stats: jsonb("stats"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUnique: uniqueIndex("snapshots_version_unique").on(t.version),
  }),
);

/**
 * `ops.snapshot_prefixes` — one row per prefix in `ip_intel` at snapshot
 * time, storing a hash of that prefix's record rather than the record
 * itself.
 *
 * Storing the hash instead of the data is the whole point: a full copy of
 * `ip_intel` per snapshot would multiply the database size by the number of
 * snapshots kept, while a 64-bit hash per prefix is a few tens of megabytes
 * and answers the only question a delta needs — "is this prefix's answer the
 * same as last time".
 *
 * That trade has one honest consequence: a delta can say a prefix changed
 * and what it says *now*, but it cannot reconstruct what it said *then*.
 * Reconstructing history needs the `backups` path (a real pg_dump), not
 * this.
 */
export const snapshotPrefixesTable = opsSchema.table(
  "snapshot_prefixes",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id").notNull(),
    network: inet("network").notNull(),
    /** 64-bit content hash of the flattened record for this prefix. */
    recordHash: bigint("record_hash", { mode: "number" }).notNull(),
  },
  (t) => ({
    snapshotIdx: index("snapshot_prefixes_snapshot_idx").on(t.snapshotId),
    snapshotNetworkUnique: uniqueIndex("snapshot_prefixes_snapshot_network_unique").on(
      t.snapshotId,
      t.network,
    ),
  }),
);

export type Snapshot = typeof snapshotsTable.$inferSelect;
export type InsertSnapshot = typeof snapshotsTable.$inferInsert;
export type SnapshotPrefix = typeof snapshotPrefixesTable.$inferSelect;
