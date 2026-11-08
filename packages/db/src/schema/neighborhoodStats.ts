import { pgTable, serial, integer, cidr, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * `neighborhood_stats` — what else is going on in the block around an
 * address, counted from this project's own tables.
 *
 * The signal it adds: an address can be entirely unremarkable itself while
 * sitting in a /24 where a dozen neighbours are Tor exits or listed on a
 * threat feed. That concentration is real information — addresses in one
 * small block usually share an operator and a purpose — and it is invisible
 * to a lookup that only asks about the queried address.
 *
 * Deliberately **counts, not a score**. `risk.ts` explains the project's
 * position on this at length: a number named "bad neighborhood score" would
 * be a judgement dressed as a measurement, and a caller acting on it could
 * block a real user. Counts are checkable, arguable, and mean exactly what
 * they say. Whether 12 Tor exits in a /24 matters is the caller's decision,
 * and it depends on their product in ways this project cannot know.
 *
 * **Sparse on purpose.** Only blocks containing at least one flagged entry
 * get a row — the internet's other ~16 million /24s would all be zeroes, and
 * storing them would cost gigabytes to say nothing. No row means every
 * counter is zero, which is also what the lookup path reports.
 *
 * **What "entry" counts.** One row in the underlying table, not one address:
 * Tor/VPN entries are single addresses so the two coincide, but a threat
 * listing may be a whole /20. The column names say `_entries` for that
 * reason — resist renaming them to `_addresses`.
 *
 * Recomputed wholesale after each enrichment (see the `neighborhood-sql`
 * derived source), the same way `asn_reach` is: cheap enough that keeping it
 * incrementally in sync would be more code and more ways to drift.
 */
export const neighborhoodStatsTable = pgTable(
  "neighborhood_stats",
  {
    id: serial("id").primaryKey(),
    /** The surrounding block: a /24 for IPv4, a /48 for IPv6 — the
     * conventional smallest unit of "same operator, same purpose" in each
     * family. */
    block: cidr("block").notNull(),
    family: integer("family").notNull(),
    torEntries: integer("tor_entries").notNull().default(0),
    vpnEntries: integer("vpn_entries").notNull().default(0),
    threatEntries: integer("threat_entries").notNull().default(0),
    /** Published crawler ranges. Not a negative signal — included because
     * "this block is full of Googlebot" is useful context of a different
     * kind, and leaving it out would make the block look emptier than it is. */
    botEntries: integer("bot_entries").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    blockUnique: uniqueIndex("neighborhood_stats_block_unique").on(t.block),
    blockGist: index("neighborhood_stats_block_spgist").using("spgist", t.block.op("inet_ops")),
  }),
);

export type NeighborhoodStat = typeof neighborhoodStatsTable.$inferSelect;
export type InsertNeighborhoodStat = typeof neighborhoodStatsTable.$inferInsert;
