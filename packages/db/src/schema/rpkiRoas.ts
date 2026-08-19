import {
  bigint,
  pgTable,
  serial,
  text,
  inet,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `rpki_roas` — Route Origin Authorisations: the prefix holder's signed
 * statement of which ASN is allowed to announce their address space, and up
 * to what prefix length.
 *
 * This is the one source in this project that can contradict another. Every
 * other layer answers "what is true about this address"; RPKI answers "is
 * what `bgp_origin_ranges` says about this address *authorised*". A prefix
 * covered by a ROA but announced from a different ASN — or announced more
 * specifically than `max_length` allows — is RPKI-invalid, which is the
 * signature of a route hijack or a misconfiguration. That is a genuinely
 * different kind of signal from "this block is on a threat list", and it is
 * cryptographically backed rather than reputational.
 *
 * Rows are validated ROA payloads (VRPs) as published by a relying-party
 * validator, not raw signed objects: doing the cryptographic validation
 * ourselves would mean shipping an RPKI validator, and the outputs of public
 * validators are published precisely so consumers don't have to.
 *
 * Multiple sources are supported deliberately (`source`), because the
 * project's stated model for this layer is that an operator lists the
 * validators they trust in priority order: where two disagree about a
 * prefix, the higher-priority source wins; where only one has data, that
 * one is used as-is.
 */
export const rpkiRoasTable = pgTable(
  "rpki_roas",
  {
    id: serial("id").primaryKey(),
    prefix: inet("prefix").notNull(),
    /** Longest prefix length this ROA authorises. Equals masklen(prefix)
     * when the ROA permits no more-specific announcement. */
    maxLength: integer("max_length").notNull(),
    // bigint, not integer: 4-byte ASNs (RFC 6793) run to 4294967295, while
    // Postgres `integer` is signed 32-bit and stops at 2147483647. The
    // private-use range 4200000000-4294967294 (RFC 6996) is above that line
    // and does appear in real routing and RPKI data — an `integer` column
    // fails the whole insert batch when it does.
    asn: bigint("asn", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    prefixGist: index("rpki_roas_prefix_spgist").using("spgist", t.prefix.op("inet_ops")),
    asnIdx: index("rpki_roas_asn_idx").on(t.asn),
    sourceIdx: index("rpki_roas_source_idx").on(t.source),
    roaUnique: uniqueIndex("rpki_roas_unique").on(t.prefix, t.maxLength, t.asn, t.source),
  }),
);

export type RpkiRoa = typeof rpkiRoasTable.$inferSelect;
export type InsertRpkiRoa = typeof rpkiRoasTable.$inferInsert;
