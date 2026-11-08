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
    /**
     * Which enrichment source wrote `name` — the source's own id
     * (`caida-asn-names` / `ripe-asn-names`), or null for a name written
     * before this column existed.
     *
     * Exists because `asnNamePrimary`/`asnNameFallbackEnabled` make the
     * ASN-name source configurable, and without provenance a config change
     * could not be acted on: nothing else records which source a given name
     * came from, and nothing ever set `name` back to null, so switching the
     * primary or disabling the fallback stopped *adding* that source's data
     * without ever removing what it had already written. Its rows kept being
     * served — and for `ripe-asn-names`, whose commercial-use licensing is
     * unresolved (`docs/20`), "still being served after being switched off"
     * is a licensing question, not just a stale-data one.
     *
     * `purgeDeselectedAsnNameSources` (enrichment.ts) is what consumes this:
     * after a run in which every currently-active ASN-name source completed,
     * any name whose source is no longer active is set back to null. See
     * `docs/104` for the full reasoning, including why the purge runs after
     * a successful run rather than before one.
     */
    nameSource: text("name_source"),
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
