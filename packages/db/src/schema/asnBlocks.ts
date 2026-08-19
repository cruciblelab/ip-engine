import {
  bigint,
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `asn_blocks` mirrors RIR ASN allocations.
 *
 * `type` is filled by the classification engine (see lib/asn-types.ts):
 *   - hosting    (cloud / colocation / datacenter)
 *   - isp        (consumer broadband, cable, fiber, dsl)
 *   - mobile     (mobile / wireless carriers)
 *   - enterprise (corporate / private network)
 *   - cdn        (CDN / edge providers)
 *   - other      (fallback when no signal is strong enough)
 */
export const asnBlocksTable = pgTable(
  "asn_blocks",
  {
    id: serial("id").primaryKey(),
    // bigint, not integer: 4-byte ASNs (RFC 6793) run to 4294967295, while
    // Postgres `integer` is signed 32-bit and stops at 2147483647. The
    // private-use range 4200000000-4294967294 (RFC 6996) is above that line
    // and does appear in real routing and RPKI data — an `integer` column
    // fails the whole insert batch when it does.
    asnStart: bigint("asn_start", { mode: "number" }).notNull(),
    asnEnd: bigint("asn_end", { mode: "number" }).notNull(),
    country: text("country"),
    rir: text("rir").notNull(),
    status: text("status"),
    name: text("name"),
    type: text("type"),
    registeredDate: date("registered_date"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    asnIdx: index("asn_blocks_start_idx").on(t.asnStart),
    countryIdx: index("asn_blocks_country_idx").on(t.country),
    rirIdx: index("asn_blocks_rir_idx").on(t.rir),
    nameIdx: index("asn_blocks_name_idx").on(t.name),
    typeIdx: index("asn_blocks_type_idx").on(t.type),
    rangeUnique: uniqueIndex("asn_blocks_range_unique").on(
      t.rir,
      t.asnStart,
      t.asnEnd,
    ),
  }),
);

export type AsnBlock = typeof asnBlocksTable.$inferSelect;
export type InsertAsnBlock = typeof asnBlocksTable.$inferInsert;
