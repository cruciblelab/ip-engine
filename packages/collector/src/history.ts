/**
 * Time travel — "what did this address look like on a given date" — answered
 * from two tables that together implement a Slowly-Changing-Dimension:
 *
 *   - `ops.prefix_baseline` — one row per prefix, the current record, kept
 *     up to date in place.
 *   - `ops.prefix_history` — every record a prefix held *before* its most
 *     recent change, each stamped with the half-open `[valid_from, valid_to)`
 *     window it was true for.
 *
 * `captureBaseline()` is the write path, meant to run after each `enrich`:
 * it diffs the live `ip_intel` against the stored baseline, archives the old
 * record for anything that changed or disappeared, then brings the baseline
 * up to date. An unchanged prefix is untouched — no new history row, and
 * `captured_at` is left alone — which is what makes storage cost track
 * actual churn instead of how often this runs.
 *
 * `queryAt()` and `historyTimeline()` are the read path.
 *
 * This is a different tool from `snapshots.ts` in this same package: a
 * snapshot answers "what changed since version X" from a content hash, cheap
 * to keep but unable to say what a prefix used to say. This module keeps the
 * actual old record, specifically so it can answer that question.
 */
import { sql, desc, eq } from "drizzle-orm";
import { db, pool, ipIntelState, refreshIpIntel, historyCapturesTable } from "@workspace/db";
import { logger, withHeartbeat } from "@workspace/shared";
import {
  diffHistoryRecords,
  type PrefixRecord,
  type HistoryChangeEvent,
  type HistoryChangeEventType,
} from "./history-diff";

export type { PrefixRecord, HistoryChangeEvent, HistoryChangeEventType };
export { diffHistoryRecords };

export interface CaptureResult {
  changed: number;
  removed: number;
  added: number;
  baselineSize: number;
}

/**
 * The 18 of `ip_intel`'s 34 columns actually carried into
 * `ops.prefix_baseline`/`ops.prefix_history`. Excluded, and why:
 *
 *  - `asn_size_rank`/`asn_originated_prefixes`/`asn_originated_addresses`/
 *    `asn_peer_visibility` — recomputed by every `enrich` run regardless of
 *    whether the underlying network changed at all. Left in, these would
 *    be the majority source of "changed" rows in history — pure per-run
 *    churn, not a real event to remember.
 *  - `asn_name`/`asn_type` — `asn_name` comes from RIPE NCC's `asn.txt`,
 *    whose commercial-use terms are unresolved as of this writing (see
 *    DEPLOY.md, "ASN-name licensing thread"). Not committed to permanently-
 *    accumulating storage while that question is still open — a live
 *    lookup can serve it today and stop tomorrow if the answer turns out
 *    unfavorable; a year of archived history cannot un-store it.
 *  - `region`/`postal`/`latitude`/`longitude` — redundant with `city` for
 *    change-detection purposes: the same geofeed row carries all four
 *    together (RFC 8805 is one CSV line per prefix — see SOURCES.md), so
 *    in practice they move in lockstep with it. Tracking `city` alone
 *    catches the same real-world event without three extra fields' worth
 *    of storage confirming what `city` already said.
 *  - `threat_category`, `rpki_authorized_asns`, `anonymity_providers`,
 *    `abuse_email`, `abuse_org`, `family`, `special_purpose_*`,
 *    `is_globally_reachable` — administrative, derived-redundant with a
 *    scalar already kept, or genuinely static. Nothing here is a fact
 *    worth a permanent copy at this project's current size.
 *
 * Keep this list and `history-diff.ts`'s `CHANGE_EVENT_FIELDS` in sync: a
 * field tracked here that no typed event reads is dead weight in every
 * archived row; a field a typed event reads that isn't tracked here is a
 * silent gap — it compiles, always reads `null`, and never fires. Neither
 * failure mode throws, which is exactly why it needs a comment instead of
 * a test alone.
 */
const TRACKED_FIELDS = [
  "asn",
  "country",
  "city",
  "geo_source",
  "rpki_status",
  "is_threat",
  "threat_source",
  "is_tor",
  "is_vpn",
  "is_cloud",
  "cloud_provider",
  "is_anycast",
  "rir",
  "rir_status",
  "network_name",
  "registered_date",
  "verified_bot",
  "verified_bot_operator",
] as const;

/** `jsonb_build_object('asn', i.asn, 'country', i.country, ...)` over
 * `TRACKED_FIELDS`, built once so the `live` CTE and the baseline upsert
 * below can never drift into building two different shapes of "the same"
 * record — which would make every comparison between them meaningless. */
const TRACKED_RECORD_SQL = sql.raw(
  `jsonb_build_object(${TRACKED_FIELDS.map((f) => `'${f}', i.${f}`).join(", ")})`,
);

/**
 * Thrown by `captureBaseline()` for a state it refuses to diff — as opposed
 * to a genuine query failure partway through. `runCapture()` below files
 * these under "skipped" (a benign, actionable, wait-and-retry situation)
 * rather than "failed" (an actual error). Used instead of a message-prefix
 * check (what this used to be) because a hand-matched string prefix is one
 * typo away from misclassifying a real failure as benign or vice versa —
 * see this same file's history for why that distinction matters enough to
 * get its own table column.
 */
export class HistoryPreconditionError extends Error {}

/**
 * True if `ops.prefix_baseline` holds a row whose JSON key set doesn't
 * match today's `TRACKED_FIELDS` — i.e. it was written before the last time
 * that list changed shape (a field added, removed, or renamed). Checked
 * against one sampled row, not all of them: shape is a property of *when* a
 * row was captured, not of any individual prefix, so the baseline is either
 * uniformly current or uniformly stale, never a mix.
 *
 * Why this matters: comparing an old-shape record to a new-shape one with
 * `IS DISTINCT FROM` is *always* true, regardless of whether any tracked
 * value actually changed — the JSON objects differ in which keys they have
 * at all. Left unchecked, the first capture after any `TRACKED_FIELDS` edit
 * would archive every single prefix as "changed" — pure schema noise
 * misfiled as real-world drift, permanently, since history can't be
 * un-recorded. Confirmed happening on real production-scale data (a
 * 1.24M-row baseline) the first time this project's `TRACKED_FIELDS` list
 * was edited after data already existed.
 */
async function baselineShapeMismatch(): Promise<boolean> {
  const { rows } = await db.execute<{ record: PrefixRecord }>(
    sql`SELECT record FROM ops.prefix_baseline LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return false; // empty baseline — nothing to mismatch against yet
  const existingKeys = new Set(Object.keys(row.record));
  return (
    existingKeys.size !== TRACKED_FIELDS.length ||
    TRACKED_FIELDS.some((f) => !existingKeys.has(f))
  );
}

/**
 * Clear `ops.prefix_baseline` so the next `captureBaseline()` starts fresh
 * under the current `TRACKED_FIELDS` shape, with no synthetic "changed"
 * events — every prefix simply re-inserts as "added". Exists for exactly
 * one situation: `baselineShapeMismatch()` caught a `TRACKED_FIELDS` change
 * and `captureBaseline()` refused to run. `ops.prefix_history` (the actual
 * archived record of real change) is never touched here — this only resets
 * the current-state side of the table pair.
 */
export async function resetBaseline(): Promise<void> {
  await db.execute(sql`DELETE FROM ops.prefix_baseline`);
}

/**
 * Diff `ip_intel` against `ops.prefix_baseline` and archive/update accordingly.
 *
 * Runs as one transaction so a reader never sees a baseline that's mid-update
 * (some prefixes already rolled forward, others not yet) — every query either
 * sees the state from before this call or the state after, never a partial
 * step. All three statements below build the same `TRACKED_RECORD_SQL`
 * (18 of `ip_intel`'s 34 columns — see `TRACKED_FIELDS` above for the full
 * list and why each excluded column is excluded) directly in SQL rather than
 * pulling rows into this process to compare, for the same reason
 * `snapshots.ts` hashes server-side: a few million rows crossing the wire to
 * be diffed in JS would be slower and would leave the answer dependent on
 * how JS happens to serialise a JSONB value.
 */
export async function captureBaseline(): Promise<CaptureResult> {
  const state = await ipIntelState();
  if (state === "off") {
    throw new HistoryPreconditionError(
      "ip_intel does not exist — run `ip-insight flatten` before capturing history.",
    );
  }
  if (state === "view") {
    throw new HistoryPreconditionError(
      "ip_intel is a plain view — diffing it three times over rescans the whole database each " +
        "time. Run `ip-insight flatten --mode materialized` first.",
    );
  }
  if (await baselineShapeMismatch()) {
    throw new HistoryPreconditionError(
      "ops.prefix_baseline was captured under an older TRACKED_FIELDS shape than the code " +
        'running now. Diffing it as-is would archive every tracked prefix as "changed" — a ' +
        "false signal from the schema change, not real drift. Run " +
        "`ip-insight history reset-baseline --yes` first: it clears the baseline only " +
        "(ops.prefix_history is untouched), so the next capture starts a clean, event-free " +
        "baseline under the current shape.",
    );
  }

  return db.transaction(async (tx) => {
    // 1. Archive the old record for every prefix that changed or vanished,
    //    stamped with the window it was actually true for. Must run before
    //    the baseline itself is touched, or the "old" record would already
    //    be gone.
    const archived = await tx.execute<{ change: string }>(sql`
      WITH live AS (
        SELECT i.network, ${TRACKED_RECORD_SQL} AS record FROM ip_intel i
      ), stale AS (
        SELECT b.network, b.record, b.captured_at,
               (l.network IS NULL) AS was_removed
        FROM ops.prefix_baseline b
        LEFT JOIN live l ON l.network = b.network
        WHERE l.network IS NULL OR l.record IS DISTINCT FROM b.record
      ), inserted AS (
        INSERT INTO ops.prefix_history (network, valid_from, valid_to, record)
        SELECT network, captured_at, now(), record FROM stale
        RETURNING 1
      )
      SELECT CASE WHEN was_removed THEN 'removed' ELSE 'changed' END AS change
      FROM stale
    `);

    // 2. Drop baseline rows for prefixes `ip_intel` no longer has at all.
    await tx.execute(sql`
      DELETE FROM ops.prefix_baseline b
      WHERE NOT EXISTS (SELECT 1 FROM ip_intel i WHERE i.network = b.network)
    `);

    // 3. Bring the baseline current. New prefixes insert; changed prefixes
    //    update; unchanged prefixes hit the WHERE clause on the DO UPDATE and
    //    are skipped entirely, so `captured_at` keeps meaning "when this
    //    record last actually changed" rather than "when this last ran".
    const upserted = await tx.execute<{ inserted: boolean }>(sql`
      INSERT INTO ops.prefix_baseline (network, record, captured_at)
      SELECT i.network, ${TRACKED_RECORD_SQL}, now()
      FROM ip_intel i
      ON CONFLICT (network) DO UPDATE
        SET record = EXCLUDED.record, captured_at = EXCLUDED.captured_at
        WHERE ops.prefix_baseline.record IS DISTINCT FROM EXCLUDED.record
      RETURNING (xmax = 0) AS inserted
    `);

    const removed = archived.rows.filter((r) => r.change === "removed").length;
    const changed = archived.rows.length - removed;
    const added = upserted.rows.filter((r) => r.inserted).length;

    const [{ count: baselineSize }] = (
      await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM ops.prefix_baseline`)
    ).rows;

    logger.info({ changed, removed, added, baselineSize }, "Baseline captured");
    return { changed, removed, added, baselineSize };
  });
}

export interface HistoryRow {
  network: string;
  validFrom: Date;
  validTo: Date | null;
  record: PrefixRecord;
}

/**
 * What did `ip` look like at `at`? Longest-prefix match over the union of
 * the current baseline (valid from its `captured_at` up to now, since
 * nothing has superseded it yet) and archived history rows whose window
 * covers `at` — the same precedence rule `ip_intel` itself uses, applied to
 * a fixed point in time instead of to right now.
 */
export async function queryAt(ip: string, at: Date): Promise<HistoryRow | null> {
  // Postgres refuses ORDER BY on an expression (masklen(...)) directly over a
  // UNION — "only result column names", not functions of them — so the
  // union is wrapped in a subquery and the ordering/limit applied outside it.
  // `db.execute()` returns raw driver values rather than drizzle's schema-
  // aware column mapping — a timestamptz comes back as a string, not a
  // Date, unlike a `.select()` query against a typed table. Wrapped in
  // `new Date(...)` below rather than trusted as already being one.
  const result = await db.execute<{
    network: string;
    valid_from: string;
    valid_to: string | null;
    record: PrefixRecord;
  }>(sql`
    SELECT * FROM (
      SELECT network::text, captured_at AS valid_from, NULL::timestamptz AS valid_to, record
      FROM ops.prefix_baseline
      WHERE network >>= ${ip}::inet AND captured_at <= ${at}
      UNION ALL
      SELECT network::text, valid_from, valid_to, record
      FROM ops.prefix_history
      WHERE network >>= ${ip}::inet AND valid_from <= ${at} AND ${at} < valid_to
    ) candidates
    ORDER BY masklen(network::inet) DESC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    network: row.network,
    validFrom: new Date(row.valid_from),
    validTo: row.valid_to ? new Date(row.valid_to) : null,
    record: row.record,
  };
}

/**
 * Every record ever held by a prefix covering `ip`, oldest first — the
 * baseline's current record plus every archived one. Multiple base prefixes
 * can appear here (e.g. a /24 later split into /25s); each row carries its
 * own `network` so the caller can tell them apart rather than the timeline
 * silently blending two different prefixes' history together.
 */
export async function historyTimeline(ip: string): Promise<HistoryRow[]> {
  const result = await db.execute<{
    network: string;
    valid_from: string;
    valid_to: string | null;
    record: PrefixRecord;
  }>(sql`
    SELECT network::text, valid_from, valid_to, record
    FROM ops.prefix_history
    WHERE network >>= ${ip}::inet
    UNION ALL
    SELECT network::text, captured_at AS valid_from, NULL::timestamptz AS valid_to, record
    FROM ops.prefix_baseline
    WHERE network >>= ${ip}::inet
    ORDER BY valid_from ASC
  `);
  return result.rows.map((r) => ({
    network: r.network,
    validFrom: new Date(r.valid_from),
    validTo: r.valid_to ? new Date(r.valid_to) : null,
    record: r.record,
  }));
}

/**
 * Every typed change event for prefixes covering `ip`, oldest first — the
 * same old/new record pair `ops.prefix_history` already stores, decomposed
 * by `diffHistoryRecords()` (see history-diff.ts) into the four facts a
 * consumer actually asks about instead of two opaque JSON blobs they'd
 * otherwise have to diff themselves.
 *
 * `historyTimeline()`'s records are diffed pairwise instead of read as
 * opaque blobs. A pair is only diffed when both sides share the same
 * `network`: `historyTimeline`'s own doc explains a base prefix can change
 * shape (e.g. a /24 later split into /25s), and treating that boundary
 * change as a field-level diff would blend two genuinely different
 * prefixes' facts together — the same blending `historyTimeline` itself was
 * built to avoid.
 */
export async function changeEvents(ip: string): Promise<HistoryChangeEvent[]> {
  const timeline = await historyTimeline(ip);
  const events: HistoryChangeEvent[] = [];
  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1]!;
    const curr = timeline[i]!;
    if (prev.network !== curr.network) continue;
    events.push(...diffHistoryRecords(curr.network, curr.validFrom, prev.record, curr.record));
  }
  return events;
}

export type CaptureTrigger = "auto" | "manual";

export interface RecordedCapture {
  status: "completed" | "failed" | "skipped";
  result: CaptureResult | null;
  /** Why it was skipped or how it failed — null on success. */
  message: string | null;
}

/**
 * `captureBaseline()` with a row in `ops.history_captures` around it.
 *
 * Two things this adds beyond bookkeeping, both aimed at the same problem —
 * history is only worth the unbroken span behind it, and a capture that
 * quietly stopped running looks exactly like a database where nothing has
 * changed:
 *
 *  - **Never throws.** The automatic caller runs at the tail of an
 *    enrichment job that has already succeeded; a history problem must not
 *    retroactively fail that job, the same rule the `ip_intel` refresh
 *    above it already follows.
 *  - **`skipped` is a real outcome, not an error.** The most likely reason a
 *    capture can't run is `ipIntelMode: "view"` — a configuration state, not
 *    a fault. Recording it as `skipped` with the reason attached means
 *    `ip-insight history status` can say "nothing has been captured for 3
 *    weeks *because* the mode is wrong", which is the actionable version of
 *    the same fact.
 */
export async function runCapture(trigger: CaptureTrigger): Promise<RecordedCapture> {
  // A process that died mid-capture leaves its row at "running" forever, and
  // `history status` would faithfully report that forever — the same
  // orphan problem the job tables already solve with interrupted-detection.
  // Swept here, at the start of the next run, rather than by a background
  // timer: this project runs no timers unless asked to (see maintenance.ts),
  // and the next capture is the first moment anyone would look. The 6-hour
  // threshold is far past any real capture's runtime but safely away from
  // declaring a slow concurrent run dead.
  await db
    .update(historyCapturesTable)
    .set({
      status: "failed",
      endedAt: new Date(),
      errorMessage: "interrupted — process exited mid-capture (swept by a later run)",
    })
    .where(
      sql`${historyCapturesTable.status} = 'running' AND ${historyCapturesTable.startedAt} < now() - interval '6 hours'`,
    );

  const [run] = await db.insert(historyCapturesTable).values({ trigger }).returning();
  if (!run) throw new Error("Failed to create history_captures row");

  try {
    const result = await captureBaseline();
    await db
      .update(historyCapturesTable)
      .set({ status: "completed", endedAt: new Date(), ...result })
      .where(eq(historyCapturesTable.id, run.id));
    return { status: "completed", result, message: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `captureBaseline` throws `HistoryPreconditionError` for every state it
    // refuses to diff (ip_intel missing/a plain view, or a stale-shape
    // baseline) — that class check, not a string match, is what tells a
    // benign precondition apart from a genuine query failure (deadlock, disk
    // full) below.
    const isPrecondition = err instanceof HistoryPreconditionError;
    const status = isPrecondition ? "skipped" : "failed";
    await db
      .update(historyCapturesTable)
      .set({ status, endedAt: new Date(), errorMessage: message })
      .where(eq(historyCapturesTable.id, run.id));
    if (isPrecondition) {
      logger.warn({ trigger, reason: message }, "History capture skipped");
    } else {
      logger.error({ err, trigger }, "History capture failed");
    }
    return { status, result: null, message };
  }
}

/* ------------------------------------------------------------------------ */
/* Standalone capture — history as its own system, not enrichment's tail     */
/* ------------------------------------------------------------------------ */

/**
 * Arbitrary but fixed 64-bit key for `pg_advisory_lock`, distinct from
 * `cycle`'s. Any process holding this is, by definition, another capture.
 */
const HISTORY_LOCK_KEY = 8_421_509_143_770_113n;

/** Last capture that actually completed — the only kind that moves history
 * forward. A `failed`/`skipped` run leaves the gap exactly where it was. */
async function lastSuccessfulCaptureAt(): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: historyCapturesTable.startedAt })
    .from(historyCapturesTable)
    .where(eq(historyCapturesTable.status, "completed"))
    .orderBy(desc(historyCapturesTable.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export interface StandaloneCaptureOptions {
  /**
   * Refresh a materialized `ip_intel` before diffing it. Off by default:
   * the refresh is the expensive part (hours on a full dataset) while the
   * capture itself is minutes, and the common case — capturing after an
   * `enrich` that already refreshed it — needs no second refresh. Turn it
   * on when running history on its own schedule, separate from enrichment.
   */
  refreshFirst?: boolean;
}

export interface StandaloneCaptureOutcome extends RecordedCapture {
  /** Whole days since the last *completed* capture; null if this is the
   * first one. This is the number that decides whether the history is
   * continuous or has holes in it. */
  daysSinceLastCapture: number | null;
  /** True when another capture already held the lock and this call did
   * nothing at all — not a failure, and deliberately not an error exit. */
  skippedLocked: boolean;
}

/**
 * History capture as a standalone operation, safe to run from cron on its
 * own schedule instead of riding along at the end of every enrichment.
 *
 * Why this exists as a separate entry point rather than just calling
 * `runCapture()` directly — three things that only matter once history is
 * its own scheduled system:
 *
 *  - **It takes its own lock.** Two overlapping captures would both archive
 *    the same superseded records, duplicating history rows. `cycle` already
 *    guards its own overlap this way; a separately-scheduled capture needs
 *    the same guard, and its own key so the two don't block each other
 *    (they touch different things and are safe to overlap with each other).
 *  - **It reports the gap.** History cannot be backfilled: a day with no
 *    capture is a day whose changes are permanently unobserved, and the
 *    failure is invisible — a database that stopped capturing looks
 *    identical to one where nothing changed. Returning the gap lets the
 *    caller say so out loud, every run, instead of it surfacing months
 *    later as "why is there no history?".
 *  - **It can refresh what it diffs.** Decoupled from enrichment, the
 *    materialized `ip_intel` this diffs may be stale, and diffing a stale
 *    view records nothing while looking perfectly successful — the worst
 *    shape of failure for this particular job.
 *
 * The lock is taken on one dedicated pooled connection, held for the whole
 * call and released with it. `db.execute()` borrows an arbitrary connection
 * per statement, so locking and unlocking through it can land on different
 * sessions — the unlock would quietly no-op and the lock would survive until
 * that connection happened to close.
 */
export async function runStandaloneCapture(
  opts: StandaloneCaptureOptions = {},
): Promise<StandaloneCaptureOutcome> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [HISTORY_LOCK_KEY.toString()],
    );
    if (!locked.rows[0]?.locked) {
      logger.warn(
        "History capture skipped: another capture is already running (advisory lock held).",
      );
      return {
        status: "skipped",
        result: null,
        message: "another capture is already running",
        daysSinceLastCapture: null,
        skippedLocked: true,
      };
    }

    try {
      const previous = await lastSuccessfulCaptureAt();
      const daysSinceLastCapture = previous
        ? Math.floor((Date.now() - previous.getTime()) / 86_400_000)
        : null;
      if (daysSinceLastCapture !== null && daysSinceLastCapture > 1) {
        // Stated as loudly as a warning can be stated, because this is the
        // one failure mode that costs something unrecoverable.
        logger.warn(
          { daysSinceLastCapture, lastCaptureAt: previous },
          `${daysSinceLastCapture} days since the last successful capture — change in that window was never observed and cannot be backfilled.`,
        );
      }

      if (opts.refreshFirst) {
        const state = await ipIntelState();
        if (state === "materialized") {
          logger.info("Refreshing materialized ip_intel before capture");
          const rows = await withHeartbeat(
            30_000,
            (elapsedSec) => logger.info({ elapsedSec }, "ip_intel refresh still running"),
            () => refreshIpIntel(),
            () =>
              db
                .execute(sql`SELECT 1`)
                .then(() => true)
                .catch(() => false),
            (elapsedSec, consecutiveFailures) =>
              logger.warn(
                { elapsedSec, consecutiveFailures },
                "ip_intel refresh: database connection check failed — the build may be stuck on a dead connection, not just slow",
              ),
          );
          logger.info({ rows }, "ip_intel refreshed");
        } else {
          // Not fatal on its own — `captureBaseline()` below rejects a
          // non-materialized ip_intel with its own actionable message, and
          // duplicating that decision here would let the two drift apart.
          logger.warn({ state }, "--refresh asked for, but ip_intel is not materialized");
        }
      }

      const recorded = await runCapture("manual");
      return { ...recorded, daysSinceLastCapture, skippedLocked: false };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [HISTORY_LOCK_KEY.toString()])
        .catch((err: unknown) => logger.debug({ err }, "History: advisory unlock failed"));
    }
  } finally {
    client.release();
  }
}

export type MaturityLevel = "empty" | "baseline-only" | "immature" | "developing" | "mature";

export interface HistoryMaturity {
  level: MaturityLevel;
  /** Human-readable statement of what the level means for derived signals. */
  summary: string;
  /** Successful captures recorded so far. */
  captureCount: number;
  /** Days between the first successful capture and now — how long this
   * deployment has been *watching*, which is the number that matters for a
   * "changed recently" signal, not how many rows happen to have changed. */
  observationDays: number;
  /** Archived (superseded) records — the actual change events observed. */
  historyRows: number;
  /** Prefixes currently tracked. */
  baselineSize: number;
  lastCaptureAt: Date | null;
  lastCaptureStatus: string | null;
  /** Whole days since the last *completed* capture — null if none ever
   * completed. Anything above 1 means history has a hole in it. */
  daysSinceLastCapture: number | null;
  /** On-disk size of the archived history, including its indexes. */
  historyBytes: number;
  /** On-disk size of the current baseline, including its indexes. This one
   * is bounded (one row per prefix); only `historyBytes` grows over time. */
  baselineBytes: number;
  /**
   * Naive extrapolation of `historyBytes` to twelve months at the rate
   * observed so far, or null before there is enough observation to divide
   * by. Deliberately naive: it assumes churn stays at the observed average,
   * which the first weeks of a deployment systematically understate (a
   * brand-new baseline has had nothing to change *from* yet). Read it as an
   * order of magnitude for capacity planning, not a forecast.
   */
  projectedAnnualHistoryBytes: number | null;
}

/**
 * How much history exists, and whether it is enough to derive anything from.
 *
 * The distinction this encodes is the whole reason it exists: a signal like
 * "this prefix changed hands recently" is not merely *weaker* on a young
 * database, it is actively misleading — a deployment three days old has seen
 * almost no changes, so every address looks stable, and a caller reading that
 * as "verified stable" would have it exactly backwards. The honest answer at
 * that point is "not enough data yet", which is what `level` is for.
 *
 * Thresholds are deliberately round and conservative rather than derived from
 * anything: 30 days is roughly the point where routine renumbering and
 * re-delegation show up at all, 90 where a per-prefix rate starts to mean
 * something. They are judgement calls, in the same spirit as `risk.ts`'s
 * hand-set weights, and are meant to be argued with.
 */
export async function historyMaturity(): Promise<HistoryMaturity> {
  const [counts] = (
    await db.execute<{
      history_rows: number;
      baseline_size: number;
      history_bytes: string;
      baseline_bytes: string;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM ops.prefix_history) AS history_rows,
        (SELECT count(*)::int FROM ops.prefix_baseline) AS baseline_size,
        pg_total_relation_size('ops.prefix_history') AS history_bytes,
        pg_total_relation_size('ops.prefix_baseline') AS baseline_bytes
    `)
  ).rows;

  const completed = await db
    .select({ startedAt: historyCapturesTable.startedAt })
    .from(historyCapturesTable)
    .where(eq(historyCapturesTable.status, "completed"))
    .orderBy(historyCapturesTable.startedAt);

  const [latest] = await db
    .select({ startedAt: historyCapturesTable.startedAt, status: historyCapturesTable.status })
    .from(historyCapturesTable)
    .orderBy(desc(historyCapturesTable.startedAt))
    .limit(1);

  const historyRows = counts?.history_rows ?? 0;
  const baselineSize = counts?.baseline_size ?? 0;
  const captureCount = completed.length;
  const first = completed[0]?.startedAt ?? null;
  const observationDays = first
    ? Math.floor((Date.now() - first.getTime()) / 86_400_000)
    : 0;

  const { level, summary } = classifyMaturity({
    captureCount,
    observationDays,
    historyRows,
    baselineSize,
  });

  const historyBytes = Number(counts?.history_bytes ?? 0);
  const baselineBytes = Number(counts?.baseline_bytes ?? 0);
  const lastCompleted = completed[completed.length - 1]?.startedAt ?? null;

  return {
    level,
    summary,
    captureCount,
    observationDays,
    historyRows,
    baselineSize,
    lastCaptureAt: latest?.startedAt ?? null,
    lastCaptureStatus: latest?.status ?? null,
    daysSinceLastCapture: lastCompleted
      ? Math.floor((Date.now() - lastCompleted.getTime()) / 86_400_000)
      : null,
    historyBytes,
    baselineBytes,
    // Guarded on a week rather than a day: dividing by one or two days of
    // observation extrapolates a single day's churn to a year and produces
    // a number wrong by an order of magnitude, which is worse than showing
    // nothing at all.
    projectedAnnualHistoryBytes:
      observationDays >= 7 ? Math.round((historyBytes / observationDays) * 365) : null,
  };
}

function classifyMaturity(f: {
  captureCount: number;
  observationDays: number;
  historyRows: number;
  baselineSize: number;
}): { level: MaturityLevel; summary: string } {
  if (f.baselineSize === 0) {
    return {
      level: "empty",
      summary:
        "No baseline captured yet — nothing to compare against. Run `ip-insight history capture` (or enable historyCaptureEnabled) after an enrichment.",
    };
  }
  // A single capture establishes the baseline and by definition observes no
  // change; the second one is the first that can produce a history row at all.
  if (f.captureCount < 2 || f.historyRows === 0) {
    return {
      level: "baseline-only",
      summary:
        "Current state is tracked, but no change has been observed yet. Derived signals (how recently a prefix changed) have nothing to report — this is normal until at least two captures have run.",
    };
  }
  if (f.observationDays < 30) {
    return {
      level: "immature",
      summary: `Only ${f.observationDays} day(s) of observation. Change-based signals exist but under-report: most prefixes simply haven't been watched long enough to have changed. Do not read "no recent change" as "stable" yet.`,
    };
  }
  if (f.observationDays < 90) {
    return {
      level: "developing",
      summary: `${f.observationDays} days of observation. Change-based signals are usable but still biased toward under-reporting; a per-prefix change rate needs roughly 90 days before it means much.`,
    };
  }
  return {
    level: "mature",
    summary: `${f.observationDays} days of observation across ${f.historyRows.toLocaleString()} recorded changes — change-based signals can be read at face value.`,
  };
}

/** Most recent capture runs, newest first — what `ip-insight history status` lists. */
export async function listCaptures(limit = 20): Promise<Array<typeof historyCapturesTable.$inferSelect>> {
  return db
    .select()
    .from(historyCapturesTable)
    .orderBy(desc(historyCapturesTable.startedAt))
    .limit(limit);
}
