import {
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  inet,
  index,
  bigserial,
} from "drizzle-orm/pg-core";
import { opsSchema } from "./ops-schema";

/**
 * `ops.bgp_live_sessions` — one row per `bgp-live run`, so a listener that
 * ran overnight can be reviewed afterwards without reading log files, and so
 * `bgp-live status` in a second terminal can see a running one's progress.
 *
 * Lives in `ops` rather than `public` for the reason that schema exists:
 * this is machinery for *building* the database, not something a consumer
 * asking about an IP address ever needs.
 *
 * The counters matter more than they look. A session that processed 60
 * million messages and recorded 4 events is the *expected* shape — a real
 * origin change is rare against the volume of ordinary BGP churn, so
 * "recorded almost nothing" is a healthy result and "recorded thousands"
 * means either a genuinely bad day on the internet or a bug in the change
 * detection. Without the denominator (`messages_received`) stored alongside
 * the numerator, neither reading is possible after the fact.
 */
export const bgpLiveSessionsTable = opsSchema.table(
  "bgp_live_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "running" | "completed" | "stopped" | "failed" */
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** RIS collector subscribed to, or null for all of them (the firehose). */
    collector: text("collector"),
    /** How many prefix→origin pairs were preloaded from `bgp_origin_ranges`
     * before listening started. This is the baseline every live announcement
     * is compared against; a session that seeded 0 would report every
     * announcement on the internet as a change, so it is recorded rather
     * than assumed. */
    seededPrefixes: integer("seeded_prefixes").notNull().default(0),
    /** Raw WebSocket messages received. The denominator described above. */
    messagesReceived: bigint("messages_received", { mode: "number" }).notNull().default(0),
    /** Individual announced prefixes examined (one message can carry many). */
    prefixesExamined: bigint("prefixes_examined", { mode: "number" }).notNull().default(0),
    /** Distinct origin changes written to `bgp_live_events`. */
    changesRecorded: integer("changes_recorded").notNull().default(0),
    /** Announcements for prefixes absent from the seed entirely. Counted,
     * not recorded as events: the seed comes from a dump that is up to a day
     * old, so "not in the dump" is usually just a new or de-aggregated
     * prefix, not a signal. Kept as a number so an abnormal spike is still
     * visible. */
    unknownPrefixes: bigint("unknown_prefixes", { mode: "number" }).notNull().default(0),
    /** Set by `bgp-live stop` from another terminal; the running listener
     * polls this and shuts down cleanly. Same cooperative-stop shape the
     * collection/enrichment jobs already use, rather than signalling across
     * processes. */
    stopRequested: timestamp("stop_requested", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
  (t) => ({
    startedIdx: index("bgp_live_sessions_started_idx").on(t.startedAt),
  }),
);

/**
 * `ops.bgp_live_events` — an origin change observed live, i.e. a prefix
 * announced by an ASN that this project's own BGP table (the daily RIS
 * whois dump, via `bgp_origin_ranges`) does not list as one of its origins.
 *
 * **Deliberately not written into `bgp_origin_ranges`.** That table is a
 * full snapshot rebuilt wholesale each run and is what `ip_intel` and every
 * published `.mmdb` are built from; feeding single live updates into it
 * would make a customer's `asn` answer flicker on ordinary route flap. This
 * table is append-only observation, read by its own CLI verbs, and joins
 * nothing on the lookup hot path.
 *
 * **An event here is not a hijack.** It is "somebody announced this prefix
 * from an origin our daily snapshot didn't have", which covers legitimate
 * transfers, new de-aggregations, multi-origin (MOAS) prefixes whose second
 * origin the dump missed, and misconfigurations — as well as the real
 * thing. `peer_count` is the column that separates them in practice: a
 * change genuinely propagated across the internet is seen by hundreds of
 * RIS peers, while a leak contained to one network is seen by a handful.
 * Combine with `rpki_status` (see the `bgp-live events` command, which
 * joins it at read time) before treating anything as suspicious — exactly
 * the same "raw fact, caller decides" contract `wider_prefix_asn` and
 * `route_anomaly` already follow.
 */
export const bgpLiveEventsTable = opsSchema.table(
  "bgp_live_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id").notNull(),
    network: inet("network").notNull(),
    /** The origin this project's snapshot has for the prefix, when it has
     * exactly one. Null when the seed held several (a MOAS prefix) — see
     * `known_asns`, which always carries the full set. */
    previousAsn: bigint("previous_asn", { mode: "number" }),
    /** Every origin the seed listed for this prefix. Stored so an event can
     * be judged later without re-reading a snapshot that has since been
     * rebuilt. */
    knownAsns: bigint("known_asns", { mode: "number" }).array(),
    /** The origin actually observed in the live announcement. */
    observedAsn: bigint("observed_asn", { mode: "number" }).notNull(),
    /**
     * Where `known_asns` came from, and the difference matters a lot:
     *
     *  - `"snapshot"` — from `bgp_origin_ranges`, i.e. a full day of RIS
     *    observation across every collector. If a prefix is MOAS, the
     *    snapshot almost certainly already lists both origins, so an event
     *    against it means a genuinely new origin. This is the trustworthy
     *    kind.
     *  - `"session"` — the prefix was absent from the snapshot, so the
     *    baseline is just "the first origin this session happened to see".
     *    A MOAS prefix will produce an event the first time its second,
     *    equally legitimate origin appears. Real example from the first
     *    live run (2026-08-23): `2605:9cc0:3d4::/48` recorded AS21664 →
     *    AS16509 while `2605:9cc0:3c2::/48` recorded AS16509 → AS21664 in
     *    the same minute — two halves of one ordinary Amazon MOAS
     *    arrangement, not two incidents.
     *
     * Kept as a column rather than filtered out at write time because a
     * `"session"` event is not worthless — it is just weaker, and which
     * ones matter depends on what the reader is asking. `bgp-live events`
     * shows it on every row and can filter on it.
     */
    baselineSource: text("baseline_source").notNull().default("snapshot"),
    /** Full AS path as received — the forensic record. The origin alone
     * cannot distinguish a hijack from a customer's provider change; the
     * path shows who propagated it. */
    asPath: bigint("as_path", { mode: "number" }).array(),
    /** How many distinct RIS peers reported this same (prefix, origin)
     * during the session. 1 means one router saw it; several hundred means
     * it reached the global table. The single most useful column here. */
    peerCount: integer("peer_count").notNull().default(1),
    /** The first peer to report it, kept for the same forensic reason as
     * `as_path` — a change first seen from one specific network is a
     * different story from one that appeared everywhere at once. */
    firstPeer: text("first_peer"),
    firstPeerAsn: bigint("first_peer_asn", { mode: "number" }),
    collector: text("collector"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // SP-GiST, not GiST — same measured reason every other inet index in
    // this project switched (see docs/94).
    networkSpgist: index("bgp_live_events_network_spgist").using(
      "spgist",
      t.network.op("inet_ops"),
    ),
    sessionIdx: index("bgp_live_events_session_idx").on(t.sessionId),
    firstSeenIdx: index("bgp_live_events_first_seen_idx").on(t.firstSeenAt),
    observedAsnIdx: index("bgp_live_events_observed_asn_idx").on(t.observedAsn),
  }),
);

export type BgpLiveSession = typeof bgpLiveSessionsTable.$inferSelect;
export type BgpLiveEvent = typeof bgpLiveEventsTable.$inferSelect;
