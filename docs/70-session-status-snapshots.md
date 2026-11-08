# Session status snapshots (handoff notes for whoever picks this up next)

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Pending: phone database reset + fresh full rebuild (planned 2026-08-02, not yet executed as of this note)](#pending-phone-database-reset-fresh-full-rebuild-planned-2026-08-02-not-yet-executed-as-of-this-note)
- [Session status as of 2026-08-03 (for whoever/whatever picks this up next)](#session-status-as-of-2026-08-03-for-whoever-whatever-picks-this-up-next)
- [Full 30-category audit completed (2026-08-03) — see separate report, not this file](#full-30-category-audit-completed-2026-08-03-see-separate-report-not-this-file)
- [Session status as of 2026-08-04 (for whoever/whatever picks this up next)](#session-status-as-of-2026-08-04-for-whoever-whatever-picks-this-up-next)
- [Standing list: continuously-open development surfaces (must be kept current)](#standing-list-continuously-open-development-surfaces-must-be-kept-current)

---

### Pending: phone database reset + fresh full rebuild (planned 2026-08-02, not yet executed as of this note)

Plan agreed for the next phone session, once the currently-running
materialized refresh is stopped:
1. `pg_dump -Fc -t ops.prefix_baseline -t ops.prefix_history` — back up the
   two irreplaceable history tables (everything else in the database is
   re-collectible from upstream, these two are not).
2. `dropdb`/`createdb` — full clean slate.
3. Install the latest zip (this one, with all 6 new items + every fix from
   this document) — `pnpm install` → `typecheck:libs` → `db push` → CLI build.
4. `pg_restore` the history backup back in.
5. `ip-insight cycle` — one fresh collect+enrich+materialize+history-capture
   pass, now covering the old sources and the 6 new ones (Linode, Feodo
   Tracker, Anthropic/CommonCrawl crawlers, Starlink heuristic, typed
   history events) together in one build, instead of layering separate
   multi-hour rebuilds on top of each other.

Reason for the reset rather than an in-place update: the phone's database
has been through several partial/killed materialized rebuilds and manual
diagnostic queries this week; starting clean removes any doubt about
lingering state, at the cost of one more full rebuild cycle.

### Session status as of 2026-08-03 (for whoever/whatever picks this up next)

Everything above this line through "Three prerequisites before real history
accumulation starts" is done, typechecked, unit-tested, and real-data
verified in this sandbox. **One thing is still pending, not yet done**:
running `ip-insight history capture` against a real, fully-built
materialized `ip_intel` to confirm the standalone capture path (lock,
gap-reporting, the new trimmed record) actually works end-to-end at real
scale, not just against the unit/integration tests. The materialized
rebuild needed for that has died twice in this sandbox from what looks
like the container itself pausing (not a code bug — see above); a third
attempt was running at the time of this note. Whoever continues this
should check whether that build finished, run `history capture`, confirm
`history status` shows a real completed capture with a sane row count, and
*then* package and deliver the zip — not before, since delivering
unverified code as "done" is exactly what this project's whole discipline
argues against.

Also pending, unrelated to the above and requested but not yet started as
of this note: a full 30-category codebase audit (bugs, crash scenarios,
bottlenecks, security, race conditions, DB design, scalability, etc.),
scoped to IP-Insight-Engine only (not `ipreadout-service`, which is
planning-only and out of scope for this audit). Being delegated to
parallel background agents rather than done inline, specifically to avoid
consuming context that's already running low in this session — see
whatever agent-completion notifications land after this note for the
actual findings.

### Full 30-category audit completed (2026-08-03) — see separate report, not this file

Three parallel background agents (security/reliability, performance/
scalability/DB, architecture/tech-debt/ops) completed a full audit of this
codebase. The full findings are delivered as a separate document
(`IP-Insight-Engine-Denetim-Raporu.md`, Turkish) rather than folded into
this file — it's large enough to be its own artifact, not a DEPLOY.md
entry. **The single most severe finding, worth stating here too since it
gates anything close to a real deployment**: `apps/server` has *no
authentication anywhere* — every route, including `POST
/api/backups/restore` (which runs `pg_restore --clean`, i.e. a full,
unauthenticated, remotely-triggerable database wipe-and-restore), is
reachable with zero credentials. Combined with an unbounded `prefixAsnCache`
(memory-exhaustion DoS, found independently by all three agents) and an
SSRF in `rdap.ts`'s geofeed-link fetch, this is a hard blocker before
`apps/server` is ever exposed beyond localhost — not before `ipreadout-service`
specifically, before *any* network exposure of this server at all. Not yet
fixed as of this note; scores and the full prioritized list live in the
separate report.

**Update (2026-08-04): the auth half of this finding is fixed.** Every
`/api/*` route except `/healthz` now requires an `X-API-Key` header — see
"Part 1, section 6" above for the required `IP_INSIGHT_API_KEY` env var and
how `apps/web`/`apps/cli` do (or, for the CLI, deliberately don't) send it.
`POST /api/backups/restore` was also hardened independently (section 7): it
takes a backup id and looks the real path up server-side instead of trusting
a client-supplied `filePath`. The `rdap.ts` SSRF finding is **also now
fixed** (see next section). The `prefixAsnCache` memory-exhaustion finding
is **not** addressed by this change — still open as of this note.

### Session status as of 2026-08-04 (for whoever/whatever picks this up next)

**Done and shipped this session, in order:**
1. Full-scale standalone `history capture` verification — done on the
   user's own phone/Termux, not this sandbox (this sandbox couldn't sustain
   the multi-hour materialize twice; the phone did, ~2.5h). Found and fixed
   a real bug live during that run: a `TRACKED_FIELDS` schema change
   against a pre-existing baseline archived every prefix as a false
   "changed" event — fixed with `HistoryPreconditionError` +
   `ip-insight history reset-baseline`, verified against a real leftover
   2.67M-row stale baseline in this sandbox.
2. Security fixes from the 30-category audit: API-key auth on `apps/server`
   (`IP_INSIGHT_API_KEY`, mandatory, fails closed), backup restore hardened
   to id-based lookup + path containment check, SSRF in `rdap.ts`'s geofeed
   fetch closed (`isPubliclyRoutable()`, now in `@workspace/shared`).
3. Six mechanical fixes: `cycle.ts`'s advisory-lock pool-connection bug
   (same class as history.ts's own earlier fix), DB pool default 10→20,
   `apps/cli`'s top-level errors now reach the log file under cron,
   `ipv4ToInt` tightened to reject malformed octets, `masklen(network)`
   index added (47x fewer buffer reads on `.mmdb` export), lookup route
   error-class conflation fixed (`InvalidIpError`, plus `/bulk`/`/asn` had
   *no* try/catch at all, now do).
4. New opt-in `.mmdb` field `stable_since` (config: `mmdbHistoryFields`,
   default off — an operator decision gated on `history status`'s maturity
   report, not an automatic threshold in code).
5. Two memory/correctness fixes: `prefixAsnCache` bounded (`LRUCache`,
   promoted to `@workspace/shared`) — and while fixing it, found the
   positive-cache path had *never actually worked* (wrong key), fixed;
   RPKI VRP ingestion switched from buffer-everything to true streaming
   (`stream-json`, new dependency) — verified against the real
   ~980K-row upstream feed, peak RSS ~220MB vs the audit's measured ~1.4GB.
6. Two query-merging fixes (`ip_intel`'s `bgp`/`wider` LATERALs, `lookup.ts`'s
   ASN-resolution chain) — both measured with real `EXPLAIN ANALYZE`, not
   assumed. **While verifying #6, found and fixed a real same-day
   regression**: the merge moved a `bigint` ASN column through raw
   `db.execute()` instead of Drizzle's typed builder, which silently
   returned it as a string — breaking every `rpki.status` check
   (`15169 === "15169"` is `false`) so every RPKI-valid announcement was
   reported "invalid". Fixed, verified against three real addresses. See
   "A real bug the #10 merge introduced" above for the full account — worth
   reading before touching `resolveAsnLocal` again.

**Deliberately not done, with reasoning already recorded above:**
- **#7** (GiST→trie rewrite for the ~4.7h materialized rebuild) — held,
  pending real timing from the actual target VDS rather than this sandbox
  or the phone, both explicitly described as temporary environments this
  session. Don't start this without asking first; it's the single
  largest-effort, highest-risk item in the audit's list.
- **Redis / shared cache layer** (audit finding #11) — rejected outright,
  not just deferred: the planned multi-server architecture distributes a
  built `.mmdb` file per server (see the `mmdb publish` command already in
  this codebase), which eliminates the cache-coherency problem Redis would
  exist to solve, rather than needing Redis to solve it.
- **Rate limiting** (#5) — deprioritized, not rejected: auth landing first
  significantly reduced its urgency (a stranger can no longer reach these
  routes at all). Worth doing before any real public exposure, not urgent
  today.
- **#13** (near-zero test coverage on `packages/lookup`, the actual product
  logic — 850 lines, one small test file), **#14** (no CI/CD at all),
  **#20** (~400 lines of mechanical duplication in `enrichment.ts`) — none
  started. Audit's own priority order: #13 highest value of the three
  (every bug this whole project has found in `lookup.ts` was found by
  hand, never by a test), #20 lowest (doesn't break anything today, just
  costs more to change later).

**A genuinely new idea from this session, not in the original audit**:
history-derived fields belong in the `.mmdb` file too eventually (so
distributed servers can answer "how long has this been stable" without a
Postgres round trip) — `stable_since` (done, see above) is the first,
cheapest one (a straight read of `ops.prefix_baseline.captured_at`, no new
computation). More elaborate ones (`country_changes_Nd`,
`was_tor_exit_within_Nd`) would need real history depth to be meaningful
first — not urgent, but worth remembering as the natural next step once
history has actually accumulated for a while.

**Zip delivered**: yes, most recently including the bigint fix above — this
is the first delivery this session that should be treated as the "current"
one; anything sent before "A real bug the #10 merge introduced" has the RPKI
false-invalid bug in it.

**Update, same day, phone-side real verification**: the bigint/RPKI fix and
the auth middleware were both confirmed working on the user's actual phone
deployment (not just this sandbox) — `lookup 8.8.8.8 --json` there now
correctly returns `rpki.status: "valid"` and `asn.number` as a real JSON
number.

One thing investigated and closed out, worth recording so it isn't
re-investigated as a mystery later: right after updating, a `lookup 8.8.8.8`
on the phone returned `found: false` with `network_name`/`rir`/`asn.name`
all null, despite `ip_blocks` looking otherwise healthy. Traced to
`found: !!blockRow` (lookup.ts) — confirmed via a direct query that the
`ip_blocks` row for `8.8.8.0/24` simply didn't exist *yet* at query time.
**Not a bug**: the user had a full `cycle` running in the background at the
time, and the row's own `ingested_at` timestamp was later than the failed
lookup — the `collect` phase just hadn't reached ARIN yet. Re-ran the exact
same lookup a few minutes later once `cycle` had progressed further:
`found: true`, `network_name`/`rir`/`asn.name` all correctly populated. No
code change needed; this is what mid-cycle querying legitimately looks
like, not a regression.

That same `cycle` run is still in progress as of this note (currently on
`ripe-asn-names`, ~110K/~120K rows in, healthy). Next real milestone once it
finishes: `history status` on the phone, to confirm the fully-fresh,
internally-consistent dataset (all source tables from the same `cycle` run,
not the mixed-vintage sandbox data this session tested most fixes against)
captures cleanly, and that `ip_intel`'s materialize step completes without
dying the way it did twice in this sandbox earlier in the engagement.

### Standing list: continuously-open development surfaces (must be kept current)

Explicit user instruction (2026-08-04): things that are "sürekli geliştirmeye
açık" — never finished, no fixed end state, just always more that could be
done — need to be listed here on their own, every time one is noticed. The
risk the user named directly: even a careful, detailed code review can miss
these, *because* they don't look like a bug or a pending task — they look
like "this works, more could be added later" — and the existing habit of
"it's in the notes somewhere, we'll come back to it" isn't reliable enough on
its own. This section exists so nothing like `asn_profile` (computed for a
long time, never once exposed to any consumer, and nobody had written down
"this is an open surface" until asked about it directly) happens again.

**Rule**: any time a review (mine or a friend's) turns up something better
described as "always more to do here" than "this is broken" or "this is
missing a step," it gets a bullet added to this list before the session
ends — not just a mention buried inside whichever Group/session-status note
it came up in. Keep entries short; point back to the fuller write-up
elsewhere in this file rather than duplicating it.

Current list:

1. **`asn_profile` (computed, never exposed)** — `computeAsnProfile()` in
   `enrichment.ts` stores per-ASN RPKI-hygiene/cloud/tor/vpn/bot aggregates
   in the `asn_profile` table; confirmed via grep that no CLI command or API
   route reads it anywhere in `apps/cli` or `apps/server` — pure "raw
   material" today. Natural extension point: a `lookup-asn <ASN>` CLI
   command, eventually API/web-panel exposure. User confirmed (2026-08-04)
   this is legitimate ongoing work, not urgent. Tracked as **Task #41** —
   **done, see "Task #41 implemented and verified" below.**
2. **ASN classification (`connection-type.ts`)** — hand-picked ASN→type
   entries (cloud/hosting/residential/etc.); already extended once
   (2026-08-02, see "ASN classification beyond hand-picked entries" above).
   There is no finite list of ASNs to classify — this grows every time a
   real lookup surfaces one that's miscategorized or missing.
3. **Candidate data sources** (see "Candidate data sources — discussed, not
   yet built, roughly prioritized", "round 2", and "Round 2 candidates,
   implemented and verified" above) — already run as a living list; new
   candidates belong under this same standing-list discipline rather than
   a one-off note that might not get revisited.
   **Implemented from round 2, final state after the 2026-08-05
   commercial-terms review (see "Orange Luxembourg + Yandex Cloud CDN
   removed" below):** 4 new RFC 8805 geofeeds (GTT, Charter/Spectrum,
   Fastly-geofeed, Zayo-EU) and Bunny.net (bare host addresses, not CIDR
   — needed its own validator, see "the 'problem' turned out smaller than
   it looked" below).
   **Checked, deliberately NOT added:** SSLBL (feed deprecated since
   2025-01-03 despite a clean CC0 license — checked the license and the
   actual data, not just the license); Orange Luxembourg (ambiguous
   robots.txt/ToS applicability, low value, operator's call to skip);
   Yandex Cloud CDN (no license issue, but Russia/Serbia-linked
   contracting entity — a jurisdictional call only the operator can make,
   not this project).
   **Still open, not reached this pass:** Cloudflare + RIPE NCC
   RPKI validator exports (redundancy), bgp.tools
   ASN classification, plus Scaleway/Backblaze/PIA as marginal calls. None
   built yet — still a research list, revisit before starting any of it.
4. **History-derived `.mmdb` fields beyond `stable_since`** —
   `country_changes_Nd`, `was_tor_exit_within_Nd`, and similar (see "A
   genuinely new idea from this session" above) are real, wanted features
   once history has real depth. Not actionable yet; revisit once
   `history status` reports enough maturity to make them meaningful.
5. **Sibling-ASN clustering / IPv6 dual-stack detection** (2026-08-03) —
   flagged as worth doing, not yet scoped into concrete tasks.
6. **`mmdb-publish.ts` field-completeness validation** (see "Real gap found
   while explaining the above" directly above) — the fix shape agreed on
   (per-field completeness ratio, not a hardcoded `network_name`/`rir`
   special case) is itself an open-ended surface: whatever fields exist in
   the mmdb export at the time this is built become the covered set, and
   any field added later (like `stable_since` today) needs the same
   check extended to it. Tracked as **Task #40** — **done, see below.**
7. **`asn_reach` missing from the standalone `ip-insight asn`/
   `GET /api/lookup/asn/:asn` lookup** — found while doing Task #41 below,
   deliberately not fixed in the same pass (see that entry for why). Same
   shape of gap `asn_profile` was: computed, already used elsewhere
   (`lookupIp()`'s per-IP ASN block), just never wired into the
   ASN-by-number path. Same fix shape too, when it's picked up: one more
   concurrent query in `lookupAsn()`, keyed by exact ASN.
8. **`withHeartbeat`'s blind spot on a dropped DB connection** — found
   2026-08-05 during the phone incident (see "A real overnight incident,
   fully diagnosed and fixed" below). If Postgres itself dies mid-query,
   the awaited query hangs rather than rejecting promptly, so the
   heartbeat timer (independent of the query's outcome) keeps printing
   "still running" indefinitely — observed for ~8 hours straight on a real
   run. Not fixed: would need the DB layer to detect and surface a dropped
   connection so the heartbeat loop can fail fast instead of waiting on a
   promise that will never settle. Low frequency (needs Postgres itself to
   die mid-statement, not just the CLI process), but a real, reproduced
   gap, not a guess.
