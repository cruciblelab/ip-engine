import {
  pgTable,
  serial,
  bigint,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * `asn_profile` — what *kind* of network an ASN is, as distinct from how big
 * it is.
 *
 * `asn_reach` already answers the size question (prefixes announced, address
 * space, route-collector visibility). This answers the other one a caller
 * actually asks: is this a hosting provider or an access network, does it
 * operate in one country or forty, does it sign its routes. None of that is
 * derivable from size, and all of it is already in this database — spread
 * across five tables and one join away from being useless to anyone who
 * isn't holding a SQL prompt.
 *
 * The signal most worth having here is **RPKI hygiene**. An ASN that signs
 * its announcements and keeps them valid is making a checkable, ongoing
 * operational commitment; one whose announcements are largely unsigned isn't
 * — and one carrying *invalid* announcements has a live problem. That is a
 * real, cryptographically-backed distinction between networks, and unlike a
 * reputation score it isn't anyone's opinion.
 *
 * Counted in **prefixes, not addresses**, throughout. A /8 and a /24 are one
 * prefix each here: the question is "how much of what this network announces
 * is signed", and weighting by size would let a single large legacy block
 * drown out the answer.
 *
 * Recomputed wholesale after each enrichment, alongside `asn_reach` and
 * `neighborhood_stats` — see the `asn-profile-sql` derived source.
 */
export const asnProfileTable = pgTable(
  "asn_profile",
  {
    id: serial("id").primaryKey(),
    /** bigint for the same reason as asn_reach: 4-byte ASNs exceed int32. */
    asn: bigint("asn", { mode: "number" }).notNull(),

    /** Distinct countries this ASN's announced space is registered in. 1 for
     * a domestic ISP, dozens for a global carrier or cloud. */
    countryCount: integer("country_count").notNull().default(0),
    /** The country holding most of its prefixes — a rough "where is this
     * network from", not a claim about where its traffic originates. */
    primaryCountry: text("primary_country"),

    /** Announced prefixes with a ROA authorising this ASN. */
    rpkiValidPrefixes: integer("rpki_valid_prefixes").notNull().default(0),
    /** Announced prefixes a ROA covers but does *not* authorise for this ASN
     * — a live routing problem, not a missing signature. */
    rpkiInvalidPrefixes: integer("rpki_invalid_prefixes").notNull().default(0),
    /** Announced prefixes no ROA covers. The majority of the internet; not a
     * fault, just unsigned. */
    rpkiUnsignedPrefixes: integer("rpki_unsigned_prefixes").notNull().default(0),

    /** Prefixes overlapping a published cloud/CDN range — the clearest
     * available signal of "datacenter network" versus "access network". */
    cloudPrefixes: integer("cloud_prefixes").notNull().default(0),
    /** Listed Tor exits inside this ASN's space. */
    torAddresses: integer("tor_addresses").notNull().default(0),
    /** Listed VPN egress addresses inside this ASN's space. */
    vpnAddresses: integer("vpn_addresses").notNull().default(0),
    /** Published crawler ranges inside it — context, not a negative signal. */
    botPrefixes: integer("bot_prefixes").notNull().default(0),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    asnUnique: uniqueIndex("asn_profile_asn_unique").on(t.asn),
  }),
);

export type AsnProfile = typeof asnProfileTable.$inferSelect;
export type InsertAsnProfile = typeof asnProfileTable.$inferInsert;
