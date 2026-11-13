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
 * `abuse_contacts` — who to tell when traffic from a prefix is a problem.
 *
 * Every RIR requires the holder of an allocation to publish a contact for
 * abuse reports, and RIPE and APNIC carry it in their bulk whois dumps as
 * an `abuse-c:` reference resolving to a role object's `abuse-mailbox:`.
 * That makes it bulk-ingestible here rather than a per-query whois call,
 * which is the whole point: several commercial providers sell this as a
 * premium field precisely because looking it up live is slow and rate
 * limited.
 *
 * Populated from the same bulk dumps the geofeed discovery source reads, so
 * it costs one extra parser rather than another multi-hundred-megabyte
 * download.
 *
 * Coverage is uneven by design, not by omission: ARIN does not publish a
 * comparable free bulk dump (its Bulk Whois is a separate, approval-gated
 * programme this project deliberately does not use — see SOURCES.md), so
 * North American space will mostly be absent. An empty result means "not in
 * the dumps we can legally ingest", never "this network has no abuse
 * contact".
 */
/**
 * `source` of rows `lookup/rdap.ts` caches from live RDAP queries, in both
 * `abuse_contacts` and `network_names`. While `rdapEnabled` is false, every
 * `enrich` run removes them (`enrichment/rdap-cache-purge.ts`): RDAP abuse
 * contacts can be personal data, and live collection is kept out of the
 * product (`docs/106` G1). `security.txt` rows are self-published contacts
 * and are left alone.
 */
export const RDAP_LIVE_CACHE_SOURCE = "rdap-live";

export const abuseContactsTable = pgTable(
  "abuse_contacts",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    email: text("email"),
    phone: text("phone"),
    org: text("org"),
    source: text("source").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("abuse_contacts_network_spgist").using("spgist", t.network.op("inet_ops")),
    sourceIdx: index("abuse_contacts_source_idx").on(t.source),
    networkSourceUnique: uniqueIndex("abuse_contacts_network_source_unique").on(
      t.network,
      t.source,
    ),
  }),
);

export type AbuseContact = typeof abuseContactsTable.$inferSelect;
export type InsertAbuseContact = typeof abuseContactsTable.$inferInsert;
