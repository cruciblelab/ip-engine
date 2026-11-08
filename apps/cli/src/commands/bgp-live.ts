import { db, bgpLiveEventsTable, bgpLiveSessionsTable, rpkiRoasTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { runRisLive, requestRisLiveStop } from "@workspace/collector/live/ris-live";

/** "3h", "45m", "90s", or a bare number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)([smh]?)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}" — use e.g. 30s, 45m, 3h`);
  const n = Number(m[1]);
  const unit = m[2] || "s";
  return unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
}

export async function runBgpLiveRun(opts: {
  duration?: string;
  collector?: string;
  peer?: string;
  maxData?: string;
  flushSeconds?: string;
}): Promise<void> {
  const durationSeconds = opts.duration ? parseDuration(opts.duration) : undefined;
  const maxBytes = opts.maxData ? Number(opts.maxData) * 1048576 : undefined;

  // Said up front rather than discovered from a data bill: the numbers are
  // this project's own measurements against the real feed (see ris-live.ts).
  const scope = opts.peer
    ? `peer ${opts.peer} (~7 MB/hour)`
    : opts.collector
      ? `collector ${opts.collector} (~3.7 GB/hour)`
      : "ALL collectors — the full firehose (~7 GB/hour downloaded)";
  console.log(`Scope: ${scope}`);
  if (durationSeconds) console.log(`Will stop automatically after ${fmtDuration(durationSeconds)}.`);
  if (maxBytes) console.log(`Will stop if more than ${fmtBytes(maxBytes)} is downloaded.`);
  console.log("Seeding the comparison baseline from bgp_origin_ranges (this takes a moment)...\n");

  const stats = await runRisLive({
    collector: opts.collector,
    peer: opts.peer,
    durationSeconds,
    maxBytes,
    flushSeconds: opts.flushSeconds ? Number(opts.flushSeconds) : undefined,
    onProgress: (s) => {
      const rate = s.elapsedSeconds > 0 ? Math.round(s.messagesReceived / s.elapsedSeconds) : 0;
      console.log(
        `[${fmtDuration(s.elapsedSeconds)}] ${s.messagesReceived.toLocaleString("en-US")} msgs ` +
          `(${rate.toLocaleString("en-US")}/s, ${fmtBytes(s.bytesReceived)}) — ` +
          `${s.prefixesExamined.toLocaleString("en-US")} prefixes checked — ` +
          `${s.changesRecorded} origin change(s) recorded` +
          `, ${s.unknownPrefixes.toLocaleString("en-US")} not in baseline`,
      );
    },
  });

  console.log(`\nSession ${stats.sessionId} finished after ${fmtDuration(stats.elapsedSeconds)}.`);
  console.log(`  baseline:          ${stats.seededPrefixes.toLocaleString("en-US")} prefixes`);
  console.log(
    `  messages:          ${stats.messagesReceived.toLocaleString("en-US")} (${fmtBytes(stats.bytesReceived)} downloaded)`,
  );
  console.log(`  prefixes checked:  ${stats.prefixesExamined.toLocaleString("en-US")}`);
  console.log(`  origin changes:    ${stats.changesRecorded}`);
  console.log(`  not in baseline:   ${stats.unknownPrefixes.toLocaleString("en-US")}`);
  console.log(`\nSee them with:  ip-insight bgp-live events`);
  // Recording almost nothing is the healthy outcome, and saying so here
  // stops a correct run from reading like a broken one.
  if (stats.changesRecorded === 0) {
    console.log(
      "\n(Zero recorded is a normal result for a short run — a real origin change is rare\n" +
        " against ordinary BGP churn. The message count above is what proves the feed worked.)",
    );
  }
}

export async function runBgpLiveStatus(opts: { json?: boolean }): Promise<void> {
  const sessions = await db
    .select()
    .from(bgpLiveSessionsTable)
    .orderBy(desc(bgpLiveSessionsTable.startedAt))
    .limit(10);

  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log("No bgp-live session has ever run.");
    return;
  }
  for (const s of sessions) {
    const when = s.startedAt.toISOString().replace("T", " ").slice(0, 19);
    const secs = Math.round(((s.endedAt ?? new Date()).getTime() - s.startedAt.getTime()) / 1000);
    console.log(
      `${when}  ${s.status.padEnd(9)} ${fmtDuration(secs).padStart(7)}  ` +
        `${s.messagesReceived.toLocaleString("en-US").padStart(12)} msgs  ` +
        `${String(s.changesRecorded).padStart(5)} change(s)  ` +
        `[${s.collector ?? "all collectors"}]`,
    );
    if (s.errorMessage) console.log(`      error: ${s.errorMessage}`);
    if (s.status === "running") {
      console.log(`      running now — stop it with: ip-insight bgp-live stop`);
    }
  }
}

export async function runBgpLiveEvents(opts: {
  limit?: string;
  minPeers?: string;
  snapshotOnly?: boolean;
  json?: boolean;
}): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : 50;
  const minPeers = opts.minPeers ? Number(opts.minPeers) : 1;

  // RPKI is joined at read time rather than stored on the event: a ROA can
  // be published or withdrawn after the announcement was seen, and the
  // question "is this authorised" is only meaningful against the current
  // set. Same reason the event row keeps the raw observation and nothing
  // derived from it.
  const rows = await db
    .select({
      network: sql<string>`${bgpLiveEventsTable.network}::text`,
      knownAsns: bgpLiveEventsTable.knownAsns,
      observedAsn: bgpLiveEventsTable.observedAsn,
      baselineSource: bgpLiveEventsTable.baselineSource,
      peerCount: bgpLiveEventsTable.peerCount,
      firstSeenAt: bgpLiveEventsTable.firstSeenAt,
      lastSeenAt: bgpLiveEventsTable.lastSeenAt,
      asPath: bgpLiveEventsTable.asPath,
      firstPeerAsn: bgpLiveEventsTable.firstPeerAsn,
      rpkiAuthorized: sql<boolean>`EXISTS (
        SELECT 1 FROM ${rpkiRoasTable} r
        WHERE r.prefix >>= ${bgpLiveEventsTable.network}
          AND r.asn = ${bgpLiveEventsTable.observedAsn}
          AND masklen(${bgpLiveEventsTable.network}) <= r.max_length
      )`,
      rpkiCovered: sql<boolean>`EXISTS (
        SELECT 1 FROM ${rpkiRoasTable} r WHERE r.prefix >>= ${bgpLiveEventsTable.network}
      )`,
    })
    .from(bgpLiveEventsTable)
    .where(
      opts.snapshotOnly
        ? sql`${bgpLiveEventsTable.peerCount} >= ${minPeers} AND ${bgpLiveEventsTable.baselineSource} = 'snapshot'`
        : sql`${bgpLiveEventsTable.peerCount} >= ${minPeers}`,
    )
    .orderBy(desc(bgpLiveEventsTable.peerCount), desc(bgpLiveEventsTable.firstSeenAt))
    .limit(limit);

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No origin-change events recorded yet.");
    return;
  }

  console.log(
    `${rows.length} event(s), most widely-seen first. "peers" is how many RIS peers reported it —`,
  );
  console.log(
    "a change seen by hundreds propagated globally; one seen by a handful stayed local.\n",
  );
  for (const r of rows) {
    const rpki = !r.rpkiCovered ? "no-roa" : r.rpkiAuthorized ? "RPKI-ok" : "RPKI-INVALID";
    const known = (r.knownAsns ?? []).map((a) => `AS${a}`).join("/") || "-";
    // "weak-baseline" is not decoration — it means the previous origin was
    // this session's own first sighting rather than a day of RIS data, so
    // an ordinary MOAS prefix can land here looking like a change.
    const baseline = r.baselineSource === "session" ? " weak-baseline" : "";
    console.log(
      `${r.network.padEnd(20)} ${known} -> AS${r.observedAsn}  ` +
        `${String(r.peerCount).padStart(4)} peers  [${rpki}${baseline}]  ` +
        `${r.firstSeenAt.toISOString().replace("T", " ").slice(0, 19)}`,
    );
    if (r.asPath && r.asPath.length > 0) {
      console.log(`    path: ${r.asPath.join(" ")}`);
    }
  }
  const weak = rows.filter((r) => r.baselineSource === "session").length;
  console.log(
    "\nNone of this is a hijack verdict on its own — a transfer, a new de-aggregation and a\n" +
      "MOAS prefix the daily dump missed all look like this too. RPKI-INVALID plus a high peer\n" +
      "count is the combination worth looking at first.",
  );
  if (weak > 0) {
    console.log(
      `\n${weak} of these are marked weak-baseline: the prefix was not in bgp_origin_ranges, so\n` +
        "the \"previous\" origin is only whatever this session saw first — an ordinary MOAS prefix\n" +
        "produces one of these the first time its second legitimate origin appears. Re-run with\n" +
        "--snapshot-only to see just the events measured against the full daily snapshot.",
    );
  }
}

export async function runBgpLiveStop(): Promise<void> {
  const stopped = await requestRisLiveStop();
  if (!stopped) {
    console.log("No bgp-live session is currently running.");
    return;
  }
  console.log(
    `Stop requested for session ${stopped.id}. The running listener will finish its current\n` +
      "flush and exit within a few seconds (it polls for this between flushes).",
  );
}
