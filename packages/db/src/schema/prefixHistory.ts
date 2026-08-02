import { serial, inet, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * Time travel — "what did this address look like on a given date" — is a
 * different question from the `snapshots`/`snapshot_prefixes` pair
 * elsewhere in this schema, even though both watch `ip_intel` for change.
 * `snapshots` answers "what changed since version X" cheaply, using a hash,
 * for a consumer doing an incremental sync — it was never meant to answer
 * "what did it actually say back then", and a hash can't: you can't recover
 * content from it. This pair exists specifically to answer that second
 * question, which forensics, abuse investigation, and dispute resolution
 * all actually need.
 *
 * `ops.prefix_baseline` — the last known full record per prefix, always
 * current. `ops.prefix_history` — every record a prefix has held *before*
 * its most recent change, each stamped with the [valid_from, valid_to) it
 * was true for.
 *
 * Storage grows with churn, not with the size of the database or how often
 * history is recorded: an unchanged prefix produces nothing, however many
 * times it is checked. That is the deliberate trade against the simpler
 * alternative (a full `ip_intel` copy per snapshot) — the naive version
 * would multiply the database's size by the number of snapshots kept; this
 * one costs one baseline copy (bounded, ~the size of `ip_intel` itself) plus
 * however much of the address space is actually unstable.
 */
export const prefixBaselineTable = opsSchema.table(
  "prefix_baseline",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    /** Same shape `mmdb-export.ts` builds — the facts worth remembering,
     * not the provenance/debugging columns. */
    record: jsonb("record").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    networkUnique: uniqueIndex("prefix_baseline_network_unique").on(t.network),
    networkGist: index("prefix_baseline_network_gist").using("gist", t.network.op("inet_ops")),
  }),
);

export const prefixHistoryTable = opsSchema.table(
  "prefix_history",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    /** [validFrom, validTo) — half-open, so a query for `t` matches with
     * `validFrom <= t AND t < validTo`, and the instant of change belongs
     * to the new record rather than being ambiguous between two rows. */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    record: jsonb("record").notNull(),
  },
  (t) => ({
    networkGist: index("prefix_history_network_gist").using("gist", t.network.op("inet_ops")),
    validRangeIdx: index("prefix_history_valid_range_idx").on(t.network, t.validFrom, t.validTo),
  }),
);

export type PrefixBaseline = typeof prefixBaselineTable.$inferSelect;
export type PrefixHistoryRow = typeof prefixHistoryTable.$inferSelect;
