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
 * `network_names` — the registry's own name for an allocation, e.g.
 * `PCH-PUBLIC-RESOLVER` for Quad9's `149.112.112.0/24` or `RIPE-NCC` for
 * `193.0.0.0/21`.
 *
 * **Why this is a separate table and not `ip_blocks.network_name`.** That
 * column exists, is read by `lookup.ts`, and is null on every single row —
 * verified, not assumed: the RIR delegated-extended statistics files this
 * project builds `ip_blocks` from carry only country/type/start/count/date/
 * status, no name field of any kind. There has never been a source to fill
 * it from. It cannot simply be backfilled here either, because `collect`
 * deletes and rewrites `ip_blocks` wholesale on every run — anything
 * written there from a different source would vanish on the next collect.
 *
 * So the name comes from RDAP, the same per-address live path that already
 * answers abuse contact and geofeed discovery (`@workspace/lookup`'s
 * rdap.ts), and lands here where `collect` cannot overwrite it. Confirmed
 * present in the RDAP response of all five RIRs against real addresses
 * before this table was added — this is not an ARIN-only field.
 *
 * **This costs no extra RDAP traffic.** It is read off a response the
 * lookup already fetched for abuse/geofeed, never fetched on its own
 * account — see the `network_name` handling in rdap.ts. A deployment with
 * `abuse_contact` and geofeed discovery both disabled simply never
 * populates this table, which is correct: it is a by-product of those
 * lookups, not a reason to start making them.
 *
 * Refreshed on the same staleness rule as the other RDAP-derived caches
 * (`ingested_at` + the configured max age), so a renamed or re-delegated
 * network is eventually observed rather than pinned to whatever the first
 * lookup happened to see.
 */
export const networkNamesTable = pgTable(
  "network_names",
  {
    id: serial("id").primaryKey(),
    /** The prefix the RDAP object itself describes, not the queried
     * address — so every address inside it is answered by one cached row
     * rather than each triggering its own lookup. */
    network: inet("network").notNull(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("network_names_network_spgist").using("spgist", t.network.op("inet_ops")),
    networkSourceUnique: uniqueIndex("network_names_network_source_unique").on(
      t.network,
      t.source,
    ),
  }),
);

export type NetworkName = typeof networkNamesTable.$inferSelect;
