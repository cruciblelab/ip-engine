import {
  pgTable,
  serial,
  text,
  inet,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const threatRangesTable = pgTable(
  "threat_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    source: text("source").notNull(),
    category: text("category"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("threat_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    sourceIdx: index("threat_ranges_source_idx").on(t.source),
    networkUnique: uniqueIndex("threat_ranges_network_unique").on(t.source, t.network),
  }),
);

export type ThreatRange = typeof threatRangesTable.$inferSelect;
export type InsertThreatRange = typeof threatRangesTable.$inferInsert;
