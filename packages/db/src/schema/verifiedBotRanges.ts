import { pgTable, serial, text, inet, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * `verified_bot_ranges` — address space a crawler's *operator* publishes as
 * its own, so "this claims to be Googlebot" can be separated from "this is
 * Googlebot".
 *
 * The question this answers is one every WAF, analytics and anti-fraud stack
 * has to ask, because the User-Agent header is a free-text field: anything
 * can call itself Googlebot, and plenty does — to bypass rate limits, to get
 * served content a scraper wouldn't be, or to poison analytics. The only
 * durable check is against a list the operator publishes themselves, which
 * is exactly what these sources are.
 *
 * Note what a hit does and does not mean. `bot = 'googlebot'` means the
 * address is inside a range Google publishes for that crawler — a strong
 * statement about the network, and nothing at all about the User-Agent the
 * request actually carried. Comparing the two is the caller's job and is the
 * entire point; this table supplies the half that can't be forged.
 *
 * Absence is not a verdict either. Only some operators publish (see
 * SOURCES.md for who does and who doesn't — DuckDuckGo, Meta, Yandex and
 * Anthropic notably don't, in machine-readable form), so a real crawler can
 * be missing here. "Not in this table" means "unverifiable from published
 * data", never "fake".
 */
export const verifiedBotRangesTable = pgTable(
  "verified_bot_ranges",
  {
    id: serial("id").primaryKey(),
    network: inet("network").notNull(),
    /** Crawler identity, lowercase and stable: "googlebot", "bingbot",
     * "gptbot", … Chosen to match the token operators use themselves. */
    bot: text("bot").notNull(),
    /** Who publishes it — "Google", "Microsoft", "OpenAI", … Kept separate
     * from `bot` because one operator runs several crawlers with quite
     * different purposes, and a caller may care about either level. */
    operator: text("operator").notNull(),
    /** Which enrichment source produced the row, for provenance and for the
     * delete-then-reinsert refresh each source does over its own rows. */
    sourceId: text("source_id").notNull(),
  },
  (t) => ({
    networkGist: index("verified_bot_ranges_network_spgist").using("spgist", t.network.op("inet_ops")),
    botIdx: index("verified_bot_ranges_bot_idx").on(t.bot),
    // Same prefix can legitimately appear for two different crawlers of the
    // same operator (Google's lists overlap), so identity is the triple.
    networkBotUnique: uniqueIndex("verified_bot_ranges_network_bot_unique").on(t.network, t.bot),
  }),
);

export type VerifiedBotRange = typeof verifiedBotRangesTable.$inferSelect;
export type InsertVerifiedBotRange = typeof verifiedBotRangesTable.$inferInsert;
