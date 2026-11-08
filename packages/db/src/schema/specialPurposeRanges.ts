import {
  pgTable,
  serial,
  text,
  inet,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * IANA's IPv4/IPv6 special-purpose address registries (RFC 6890 and
 * friends) — private/loopback/documentation/multicast/etc. ranges. Static,
 * rarely-changing reference data: lets a lookup say "this isn't a routable
 * internet address, here's why" instead of just returning empty RIR/geo/ASN
 * fields and leaving the caller to guess why.
 */
export const specialPurposeRangesTable = pgTable(
  "special_purpose_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    name: text("name").notNull(),
    rfc: text("rfc"),
    isForwardable: boolean("is_forwardable"),
    isGloballyReachable: boolean("is_globally_reachable"),
    isReservedByProtocol: boolean("is_reserved_by_protocol"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    networkGist: index("special_purpose_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    networkUnique: uniqueIndex("special_purpose_ranges_network_unique").on(t.network),
  }),
);

export type SpecialPurposeRange = typeof specialPurposeRangesTable.$inferSelect;
export type InsertSpecialPurposeRange = typeof specialPurposeRangesTable.$inferInsert;
