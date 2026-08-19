import {
  pgTable,
  serial,
  text,
  inet,
  doublePrecision,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `ip_blocks` is the core RIR allocation table.
 *
 * `network` is a native Postgres `inet` column, not a hand-rolled
 * (family, start_addr, end_addr) triple. This is what makes IPv4 *and*
 * IPv6 the same code path: containment queries use Postgres's own
 * `<<=`/`>>=` operators (GiST index, opclass `inet_ops` — see the
 * `networkGist` index below) instead of manual integer-range arithmetic,
 * and `family(network)` / `masklen(network)` are available whenever the
 * family or prefix length is needed instead of separate stored columns.
 * IPv4 addresses are never wrapped in `::ffff:.../96` form here — see
 * `lib/ip-normalize.ts`, used consistently at every entry point (ingestion
 * *and* lookup) so the two can't drift into different behavior for that
 * representation.
 *
 * Classification columns (added by the classification engine, all nullable
 * so existing inserts from the collector do not need to know about them):
 *   - usage_type:                residential | mobile | hosting | cdn |
 *                                enterprise | vpn | proxy
 *   - classification_confidence: 0..1, derived from the strongest signal
 *                                that produced the usage_type
 *   - flags:                     denormalized array of tags surfaced to
 *                                callers (anycast, vpn, proxy, hosting,
 *                                cdn, residential, mobile, threat, etc.)
 *   - network_name:              human-friendly org / network holder
 *                                name (typically copied from the ASN
 *                                holder once enrichment runs)
 */
export const ipBlocksTable = pgTable(
  "ip_blocks",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    country: text("country"),
    rir: text("rir").notNull(),
    status: text("status"),
    registeredDate: date("registered_date"),
    networkName: text("network_name"),
    usageType: text("usage_type"),
    classificationConfidence: doublePrecision("classification_confidence"),
    flags: text("flags").array(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("ip_blocks_network_spgist").using("spgist", t.network.op("inet_ops")),
    countryIdx: index("ip_blocks_country_idx").on(t.country),
    rirIdx: index("ip_blocks_rir_idx").on(t.rir),
    usageIdx: index("ip_blocks_usage_idx").on(t.usageType),
    networkUnique: uniqueIndex("ip_blocks_network_unique").on(t.rir, t.network),
  }),
);

export type IpBlock = typeof ipBlocksTable.$inferSelect;
export type InsertIpBlock = typeof ipBlocksTable.$inferInsert;
