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
import { db, ipIntelState, historyCapturesTable } from "@workspace/db";
import { logger } from "@workspace/shared";
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
 * Diff `ip_intel` against `ops.prefix_baseline` and archive/update accordingly.
 *
 * Runs as one transaction so a reader never sees a baseline that's mid-update
 * (some prefixes already rolled forward, others not yet) — every query either
 * sees the state from before this call or the state after, never a partial
 * step. All three statements below build `to_jsonb(ip_intel) - 'network'` in
 * SQL rather than pulling rows into this process to compare, for the same
 * reason `snapshots.ts` hashes server-side: a few million rows crossing the
 * wire to be diffed in JS would be slower and would leave the answer
 * dependent on how JS happens to serialise a JSONB value.
 */
export async function captureBaseline(): Promise<CaptureResult> {
  const state = await ipIntelState();
  if (state === "off") {
    throw new Error("ip_intel does not exist — run `ip-insight flatten` before capturing history.");
  }
  if (state === "view") {
    throw new Error(
      "ip_intel is a plain view — diffing it three times over rescans the whole database each " +
        "time. Run `ip-insight flatten --mode materialized` first.",
    );
  }

  return db.transaction(async (tx) => {
    // 1. Archive the old record for every prefix that changed or vanished,
    //    stamped with the window it was actually true for. Must run before
    //    the baseline itself is touched, or the "old" record would already
    //    be gone.
    const archived = await tx.execute<{ change: string }>(sql`
      WITH live AS (
        SELECT network, (to_jsonb(i) - 'network') AS record FROM ip_intel i
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
      SELECT i.network, (to_jsonb(i) - 'network'), now()
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
    // `captureBaseline` throws for exactly two preconditions, both of which
    // are "ip_intel isn't in a shape this can diff" rather than a failure of
    // the capture itself. Matched by prefix, NOT `includes("ip_intel")`: a
    // genuine query failure (deadlock, disk full) carries the failed SQL in
    // its message, and that SQL says `FROM ip_intel` — an `includes` check
    // would file real failures under "skipped", the benign-config bucket,
    // which is precisely the silent failure this table exists to expose.
    // Both precondition messages begin with the relation name; drizzle's
    // query failures begin with "Failed query:".
    const isPrecondition = message.startsWith("ip_intel");
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
    await db.execute<{ history_rows: number; baseline_size: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM ops.prefix_history) AS history_rows,
        (SELECT count(*)::int FROM ops.prefix_baseline) AS baseline_size
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

  return {
    level,
    summary,
    captureCount,
    observationDays,
    historyRows,
    baselineSize,
    lastCaptureAt: latest?.startedAt ?? null,
    lastCaptureStatus: latest?.status ?? null,
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
