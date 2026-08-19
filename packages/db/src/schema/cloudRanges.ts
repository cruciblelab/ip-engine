import {
  pgTable,
  serial,
  text,
  inet,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const cloudRangesTable = pgTable(
  "cloud_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    provider: text("provider").notNull(),
    service: text("service"),
    region: text("region"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("cloud_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    providerIdx: index("cloud_ranges_provider_idx").on(t.provider),
    networkUnique: uniqueIndex("cloud_ranges_network_unique").on(t.provider, t.network),
  }),
);

export type CloudRange = typeof cloudRangesTable.$inferSelect;
export type InsertCloudRange = typeof cloudRangesTable.$inferInsert;
