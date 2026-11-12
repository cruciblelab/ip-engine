/**
 * RIS Live — real-time BGP origin-change detection.
 *
 * Closes the one gap `origin-changes`/`hijack-scan` documents about itself:
 * it is built from `history capture` snapshots, so its resolution is the
 * capture interval, and a change that starts and ends between two captures
 * is invisible. Real numbers from the deployment on 2026-08-20: 6 captures
 * in a day, roughly 4 hours apart. Most real BGP incidents live for minutes.
 *
 * ## How it works, and why this shape
 *
 * RIPE's RIS Live is a free public WebSocket feed of raw BGP UPDATE
 * messages from RIS route collectors. Everything below is driven by three
 * measurements taken against the real feed before any of this was written
 * (2026-08-23):
 *
 *  - **Volume.** The full firehose runs ~6,300 messages/sec, ~17,600
 *    announced prefixes/sec, ~7 GB/hour of raw JSON off the wire. That is
 *    downloaded, not stored — the storage side of this file is tiny by
 *    design. A single collector is ~3.7 GB/hour, a single peer ~7 MB/hour;
 *    `collector` and `peer` exist so the same code runs at any of those
 *    scales without a rewrite.
 *  - **Signal rate.** Of those ~17,600 prefixes/sec, the ones that disagree
 *    with what this project already knows are a tiny fraction. Storing
 *    every message would be millions of rows an hour and would answer
 *    nothing; storing only disagreements is what makes this cheap.
 *  - **State cost.** The comparison baseline is every prefix→origin pair
 *    from `bgp_origin_ranges` — 1.5M rows — held in memory. Measured at
 *    174 MB heap and ~6.3M lookups/sec, against the ~18k lookups/sec the
 *    feed demands. The map is nowhere near the bottleneck; JSON parsing is,
 *    and at ~3 MB/sec that is a few percent of one core.
 *
 * ## What counts as an event
 *
 * A prefix announced by an origin ASN that `bgp_origin_ranges` does not
 * list for it. Deliberately compared against the *set* of known origins,
 * not a single one: MOAS prefixes (legitimately announced by more than one
 * AS) are ordinary, and treating the second origin as a change would bury
 * the real signal under them.
 *
 * Not written into `bgp_origin_ranges` — see `bgp_live_events`' schema
 * comment for why that table must stay a clean snapshot.
 *
 * ## Duplicate suppression
 *
 * One real change is reported by every peer that sees it, which for a
 * globally propagated change is hundreds of messages within seconds. Those
 * are collapsed into one row whose `peer_count` grows — which turns the
 * duplication into the most useful column in the table rather than noise.
 */
import { loadCollectorConfig } from "../config";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  bgpLiveEventsTable,
  bgpLiveSessionsTable,
  type BgpLiveSession,
} from "@workspace/db";
import { logger } from "@workspace/shared";

const RIS_LIVE_URL = "wss://ris-live.ripe.net/v1/ws/";
/** RIPE asks clients to identify themselves; not required, but it is their
 * feed and being identifiable is the polite minimum for using it. */
const CLIENT_ID = "ip-insight-engine";

export interface RisLiveOptions {
  /** RIS collector to subscribe to (e.g. "rrc00"). Omit for all of them. */
  collector?: string;
  /** Restrict to a single peer IP — the cheapest possible scope. */
  peer?: string;
  /** Stop automatically after this many seconds. */
  durationSeconds?: number;
  /** Stop if this much has been downloaded, as a guard for metered links. */
  maxBytes?: number;
  /** How often to write buffered events and refresh the session counters. */
  flushSeconds?: number;
  /** Called after each flush so a CLI can print progress. */
  onProgress?: (stats: RisLiveStats) => void;
}

export interface RisLiveStats {
  sessionId: string;
  seededPrefixes: number;
  messagesReceived: number;
  prefixesExamined: number;
  changesRecorded: number;
  unknownPrefixes: number;
  bytesReceived: number;
  elapsedSeconds: number;
}

/** A pending or already-written event, keyed by `prefix|observedAsn`. */
interface PendingEvent {
  network: string;
  knownAsns: number[];
  observedAsn: number;
  /** "snapshot" (baseline from bgp_origin_ranges) or "session" (baseline
   * learned from this run's own first sighting) — see the column's comment
   * in bgpLive.ts for why the distinction is load-bearing. */
  baselineSource: "snapshot" | "session";
  asPath: number[];
  peers: Set<string>;
  firstPeer: string | null;
  firstPeerAsn: number | null;
  collector: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Row id once written; undefined until the first flush persists it. */
  rowId?: number;
}

/**
 * Loads every prefix→origin pair this project already knows into memory.
 *
 * Streamed in pages rather than one 1.5M-row result set: the driver
 * materialises a full result before handing it over, so a single query
 * would spike memory well above the 174 MB the finished map costs, on a
 * device where that headroom is the whole question.
 */
async function seedKnownOrigins(): Promise<Map<string, number | number[]>> {
  const known = new Map<string, number | number[]>();
  const PAGE = 200_000;
  let lastId = 0;
  for (;;) {
    const { rows } = await db.execute<{ id: number; network: string; asn: string }>(sql`
      SELECT id, network::text AS network, asn
      FROM bgp_origin_ranges
      WHERE id > ${lastId}
      ORDER BY id
      LIMIT ${PAGE}
    `);
    if (rows.length === 0) break;
    for (const r of rows) {
      // bigint arrives as a string on this raw path — same coercion the
      // rest of this codebase documents for ASN columns.
      const asn = Number(r.asn);
      const existing = known.get(r.network);
      if (existing === undefined) {
        known.set(r.network, asn);
      } else if (typeof existing === "number") {
        if (existing !== asn) known.set(r.network, [existing, asn]);
      } else if (!existing.includes(asn)) {
        existing.push(asn);
      }
      lastId = r.id;
    }
    if (rows.length < PAGE) break;
  }
  return known;
}

export function isKnownOrigin(entry: number | number[] | undefined, asn: number): boolean {
  if (entry === undefined) return false;
  return typeof entry === "number" ? entry === asn : entry.includes(asn);
}

export function knownAsList(entry: number | number[] | undefined): number[] {
  if (entry === undefined) return [];
  return typeof entry === "number" ? [entry] : entry;
}

/**
 * The origin ASN of an announcement: the last element of the AS path.
 *
 * Returns null rather than guessing for the two shapes that have no single
 * answer — an empty path (iBGP/malformed) and an AS_SET tail, which is a
 * *set* of origins by definition. Picking the first member of an AS_SET
 * would manufacture a specific claim the protocol did not make, which is
 * exactly the kind of confident wrong answer this project avoids
 * elsewhere; AS_SETs are also rare and deprecated (RFC 6472).
 */
export function originFromPath(path: unknown): number | null {
  if (!Array.isArray(path) || path.length === 0) return null;
  const tail = path[path.length - 1];
  if (typeof tail !== "number") return null;
  return Number.isFinite(tail) && tail > 0 ? tail : null;
}

export async function runRisLive(opts: RisLiveOptions = {}): Promise<RisLiveStats> {
  // Off unless the config says otherwise (docs/106 G4): RIPE RIS data, and a
  // live collection, both kept out of the commercial product.
  if (!loadCollectorConfig().bgpLiveEnabled) {
    throw new Error(
      "bgp-live is disabled (bgpLiveEnabled: false in ip-insight.config.json). " +
        "It reads RIPE RIS Live, which is kept off pending RIS's licensing conditions — see docs/106 G4.",
    );
  }
  const flushMs = (opts.flushSeconds ?? 15) * 1000;

  logger.info("ris-live: seeding known origins from bgp_origin_ranges...");
  const known = await seedKnownOrigins();
  logger.info({ seeded: known.size }, "ris-live: seed loaded");
  if (known.size === 0) {
    throw new Error(
      "bgp_origin_ranges is empty — every announcement would look like a change. " +
        "Run `ip-insight enrich` for the BGP sources of the selected bgpOriginSource first " +
        "(ris-whois-ipv4,ris-whois-ipv6 or routeviews-rib-ipv4,routeviews-rib-ipv6).",
    );
  }

  const [session] = await db
    .insert(bgpLiveSessionsTable)
    .values({
      collector: opts.collector ?? null,
      seededPrefixes: known.size,
    })
    .returning();
  if (!session) throw new Error("Failed to create bgp_live_sessions row");

  const stats: RisLiveStats = {
    sessionId: session.id,
    seededPrefixes: known.size,
    messagesReceived: 0,
    prefixesExamined: 0,
    changesRecorded: 0,
    unknownPrefixes: 0,
    bytesReceived: 0,
    elapsedSeconds: 0,
  };

  const pending = new Map<string, PendingEvent>();
  /** Prefixes added to `known` from the live feed rather than the snapshot.
   * Their baseline is one sighting, not a day of observation, so an event
   * against them is marked weaker — see PendingEvent.baselineSource. */
  const learnedPrefixes = new Set<string>();
  const startedAt = Date.now();
  let stopping = false;
  let stopReason: "completed" | "stopped" | "failed" = "completed";
  let failure: string | null = null;

  const ws = new WebSocket(`${RIS_LIVE_URL}?client=${CLIENT_ID}`);

  const finish = (reason: typeof stopReason, message?: string): void => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    if (message) failure = message;
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };

  ws.onopen = (): void => {
    const data: Record<string, unknown> = { type: "UPDATE", require: "announcements" };
    if (opts.collector) data["host"] = opts.collector;
    if (opts.peer) data["peer"] = opts.peer;
    ws.send(JSON.stringify({ type: "ris_subscribe", data }));
    logger.info(
      { collector: opts.collector ?? "all", peer: opts.peer ?? "all" },
      "ris-live: subscribed",
    );
  };

  ws.onerror = (event: Event): void => {
    const message = (event as unknown as { message?: string }).message ?? "websocket error";
    logger.error({ err: message }, "ris-live: websocket error");
    finish("failed", message);
  };

  ws.onclose = (): void => {
    // A close we did not ask for is a failure, not a clean finish — without
    // this the session row would read "completed" for a feed that dropped
    // after ten minutes of a three-hour run.
    if (!stopping) finish("failed", "connection closed by the other side");
  };

  ws.onmessage = (event: MessageEvent): void => {
    const raw = typeof event.data === "string" ? event.data : "";
    stats.bytesReceived += raw.length;
    stats.messagesReceived++;

    if (opts.maxBytes !== undefined && stats.bytesReceived >= opts.maxBytes) {
      logger.warn({ bytes: stats.bytesReceived }, "ris-live: byte budget reached, stopping");
      finish("stopped");
      return;
    }

    let parsed: { type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed.type !== "ris_message" || !parsed.data) return;
    const d = parsed.data;
    if (d["type"] !== "UPDATE") return;

    const observedAsn = originFromPath(d["path"]);
    if (observedAsn === null) return;
    const announcements = d["announcements"];
    if (!Array.isArray(announcements)) return;

    const peer = typeof d["peer"] === "string" ? d["peer"] : null;
    const peerAsn = d["peer_asn"] !== undefined ? Number(d["peer_asn"]) : null;
    const host = typeof d["host"] === "string" ? d["host"] : null;
    const asPath = Array.isArray(d["path"])
      ? (d["path"].filter((x) => typeof x === "number") as number[])
      : [];

    for (const ann of announcements) {
      const prefixes = (ann as { prefixes?: unknown })?.prefixes;
      if (!Array.isArray(prefixes)) continue;
      for (const prefix of prefixes) {
        if (typeof prefix !== "string") continue;
        stats.prefixesExamined++;

        const entry = known.get(prefix);
        if (entry === undefined) {
          // Absent from a snapshot up to a day old: usually a new or
          // de-aggregated prefix, not a signal. Counted, not recorded —
          // and learned, so it doesn't re-count on every reannouncement.
          stats.unknownPrefixes++;
          known.set(prefix, observedAsn);
          learnedPrefixes.add(prefix);
          continue;
        }
        if (isKnownOrigin(entry, observedAsn)) continue; // the hot path

        const key = `${prefix}|${observedAsn}`;
        const existing = pending.get(key);
        if (existing) {
          if (peer) existing.peers.add(peer);
          existing.lastSeenAt = new Date();
          continue;
        }
        const now = new Date();
        pending.set(key, {
          network: prefix,
          knownAsns: knownAsList(entry),
          observedAsn,
          baselineSource: learnedPrefixes.has(prefix) ? "session" : "snapshot",
          asPath,
          peers: new Set(peer ? [peer] : []),
          firstPeer: peer,
          firstPeerAsn: peerAsn !== null && Number.isFinite(peerAsn) ? peerAsn : null,
          collector: host,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }
  };

  /** Writes new events, updates peer counts on already-written ones, and
   * refreshes the session row so `bgp-live status` elsewhere sees progress. */
  const flush = async (): Promise<void> => {
    const toInsert: PendingEvent[] = [];
    const toUpdate: PendingEvent[] = [];
    for (const e of pending.values()) {
      if (e.rowId === undefined) toInsert.push(e);
      else toUpdate.push(e);
    }

    if (toInsert.length > 0) {
      try {
        const inserted = await db
          .insert(bgpLiveEventsTable)
          .values(
            toInsert.map((e) => ({
              sessionId: session.id,
              network: e.network,
              previousAsn: e.knownAsns.length === 1 ? e.knownAsns[0]! : null,
              knownAsns: e.knownAsns,
              observedAsn: e.observedAsn,
              baselineSource: e.baselineSource,
              asPath: e.asPath,
              peerCount: e.peers.size || 1,
              firstPeer: e.firstPeer,
              firstPeerAsn: e.firstPeerAsn,
              collector: e.collector,
              firstSeenAt: e.firstSeenAt,
              lastSeenAt: e.lastSeenAt,
            })),
          )
          .returning({ id: bgpLiveEventsTable.id });
        inserted.forEach((row, i) => {
          const target = toInsert[i];
          if (target) target.rowId = row.id;
        });
        stats.changesRecorded += inserted.length;
      } catch (err) {
        logger.warn({ err }, "ris-live: event insert failed, will retry next flush");
      }
    }

    for (const e of toUpdate) {
      try {
        await db
          .update(bgpLiveEventsTable)
          .set({ peerCount: e.peers.size || 1, lastSeenAt: e.lastSeenAt })
          .where(eq(bgpLiveEventsTable.id, e.rowId!));
      } catch (err) {
        logger.warn({ err }, "ris-live: event update failed");
      }
    }

    stats.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    try {
      await db
        .update(bgpLiveSessionsTable)
        .set({
          messagesReceived: stats.messagesReceived,
          prefixesExamined: stats.prefixesExamined,
          changesRecorded: stats.changesRecorded,
          unknownPrefixes: stats.unknownPrefixes,
        })
        .where(eq(bgpLiveSessionsTable.id, session.id));
    } catch (err) {
      logger.warn({ err }, "ris-live: session counter update failed");
    }

    opts.onProgress?.({ ...stats });
  };

  /** Cooperative stop, same shape the collection/enrichment jobs use: the
   * running process polls a column another terminal can set, rather than
   * either process needing to signal the other. */
  const checkStopRequest = async (): Promise<void> => {
    try {
      const [row] = await db
        .select({ stopRequested: bgpLiveSessionsTable.stopRequested })
        .from(bgpLiveSessionsTable)
        .where(eq(bgpLiveSessionsTable.id, session.id))
        .limit(1);
      if (row?.stopRequested) {
        logger.info("ris-live: stop requested, shutting down");
        finish("stopped");
      }
    } catch {
      /* a transient DB hiccup must not kill a long run */
    }
  };

  const flushTimer = setInterval(() => {
    void flush();
    void checkStopRequest();
  }, flushMs);

  const durationTimer =
    opts.durationSeconds !== undefined
      ? setTimeout(() => {
          logger.info({ seconds: opts.durationSeconds }, "ris-live: duration reached");
          finish("completed");
        }, opts.durationSeconds * 1000)
      : null;

  const onSigint = (): void => {
    logger.info("ris-live: interrupted, finishing cleanly");
    finish("stopped");
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  await new Promise<void>((resolve) => {
    const originalClose = ws.onclose;
    ws.onclose = (ev: CloseEvent): void => {
      originalClose?.call(ws, ev);
      resolve();
    };
  });

  clearInterval(flushTimer);
  if (durationTimer) clearTimeout(durationTimer);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigint);

  // Final flush outside the interval so nothing observed in the last window
  // is lost — the whole point of the run is the events, and dropping the
  // final few because the socket closed first would be a silent data loss.
  await flush();

  stats.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  await db
    .update(bgpLiveSessionsTable)
    .set({
      status: stopReason,
      endedAt: new Date(),
      errorMessage: failure,
      messagesReceived: stats.messagesReceived,
      prefixesExamined: stats.prefixesExamined,
      changesRecorded: stats.changesRecorded,
      unknownPrefixes: stats.unknownPrefixes,
    })
    .where(eq(bgpLiveSessionsTable.id, session.id));

  return stats;
}

/** Marks the most recent running session for shutdown. Returns null when
 * none is running. */
export async function requestRisLiveStop(): Promise<BgpLiveSession | null> {
  const [running] = await db
    .select()
    .from(bgpLiveSessionsTable)
    .where(and(eq(bgpLiveSessionsTable.status, "running"), isNull(bgpLiveSessionsTable.endedAt)))
    .orderBy(sql`started_at DESC`)
    .limit(1);
  if (!running) return null;
  await db
    .update(bgpLiveSessionsTable)
    .set({ stopRequested: new Date() })
    .where(eq(bgpLiveSessionsTable.id, running.id));
  return running;
}
