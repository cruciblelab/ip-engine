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
 * `anonymity_ranges` — addresses that belong to a service whose purpose is
 * to stand between a user and the destination: Tor exits, VPN egress nodes,
 * open proxies.
 *
 * One table rather than one per kind, because the question a caller asks is
 * almost always "is this address hiding someone" rather than "is this
 * specifically Tor" — and because every source here has the same shape: a
 * published list of addresses belonging to a named operator.
 *
 * What this can and cannot tell you, stated plainly because the difference
 * decides whether this data is fit for a given purpose:
 *
 *   - It covers services that *publish* their addresses. Tor publishes its
 *     exit list by design (the network is meant to be identifiable). Several
 *     commercial VPNs publish their server lists too.
 *   - It cannot cover residential and mobile proxy networks — the ones that
 *     route through real consumer devices and are the actual problem in
 *     fraud work. Those are deliberately unpublished, and identifying them
 *     needs live behavioural telemetry across many customers' traffic, which
 *     is a fundamentally different kind of system than a bulk-data database.
 *     No amount of additional feeds fixes this; see SOURCES.md.
 *
 * `kind` is "tor" | "vpn" | "proxy". `provider` names the operator where the
 * source identifies one ("mullvad", "tor"), and `source` records which feed
 * the row came from so a refresh can replace exactly its own rows.
 */
export const anonymityRangesTable = pgTable(
  "anonymity_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider"),
    source: text("source").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("anonymity_ranges_network_gist").using("gist", t.network.op("inet_ops")),
    kindIdx: index("anonymity_ranges_kind_idx").on(t.kind),
    sourceIdx: index("anonymity_ranges_source_idx").on(t.source),
    networkSourceUnique: uniqueIndex("anonymity_ranges_network_source_unique").on(
      t.network,
      t.source,
    ),
  }),
);

export type AnonymityRange = typeof anonymityRangesTable.$inferSelect;
export type InsertAnonymityRange = typeof anonymityRangesTable.$inferInsert;
