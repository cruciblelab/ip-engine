import {
  pgTable,
  serial,
  text,
  inet,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `anycast_ranges` stores well-known anycast prefixes (Cloudflare 1.1.1.1,
 * Google Public DNS 8.8.8.8, Quad9 9.9.9.9, root DNS, etc.). The table is
 * pre-seeded from a static list (see lib/anycast.ts) but kept in the
 * database so operators can extend it without redeploying.
 *
 * An IP that falls inside any of these ranges is reported with
 * `geo.geo_source = "anycast"` and `anycast = true` in the lookup response.
 */
export const anycastRangesTable = pgTable(
  "anycast_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    label: text("label"),
    operator: text("operator"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("anycast_ranges_network_gist").using("gist", t.network.op("inet_ops")),
    networkUnique: uniqueIndex("anycast_ranges_network_unique").on(t.network),
  }),
);

export type AnycastRange = typeof anycastRangesTable.$inferSelect;
export type InsertAnycastRange = typeof anycastRangesTable.$inferInsert;
