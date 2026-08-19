# The history/time-travel system

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [History promoted to a standalone system + hijack claim walked back (2026-08-03)](#history-promoted-to-a-standalone-system-hijack-claim-walked-back-2026-08-03)
- [Three prerequisites before real history accumulation starts (2026-08-03)](#three-prerequisites-before-real-history-accumulation-starts-2026-08-03)
- [Full-scale materialize + history capture — finally verified for real (2026-08-04)](#full-scale-materialize-history-capture-finally-verified-for-real-2026-08-04)

---

### History promoted to a standalone system + hijack claim walked back (2026-08-03)

Two connected changes, both prompted by an honest look at what this project
can and can't claim.

**First, a correction to something stated earlier in this session.** When
asked whether anyone else does routing-level inconsistency detection, the
answer given was that no competitor appeared to offer RPKI-based hijack
detection. **That was wrong, and it was wrong because only three general
IP-reputation APIs were checked (MaxMind minFraud, IPQualityScore,
AbstractAPI) — none of which are in the BGP-security business at all.**
Checking the actual field afterwards: **Cloudflare Radar runs real-time BGP
origin-hijack detection, free, with a public API**, processing live BGP
messages from ~170 full-feed peers and scoring against RPKI *and* IRR *and*
bogon lists *and* AS relationships. Kentik and Qrator Radar are also in
this space. This project's `hijack.ts` is a far weaker thing than any of
them, and presenting it as a differentiator would not survive a customer
spending five minutes searching. (Cloudflare Radar's data is CC BY-NC —
free to consume, not licensed for commercial redistribution, so it is not
usable as a *source* here either. It is a competitor to point at honestly,
not a feed to ingest.)

**`hijack-scan` renamed to `origin-changes`** (old name kept as an alias so
nothing breaks), with its header comment and CLI description rewritten to
say outright what it is not: its resolution is the capture interval, so a
hijack that starts and ends between two captures — most real ones — is
structurally invisible to it. It sees state changes, never events. The
docs now point at Cloudflare Radar for real-time detection instead of
competing with it. What it legitimately answers, and only after months of
accumulated captures: which prefixes are sitting on an unauthorized origin
*long-term*, quietly, with no incident-shaped spike for a live detector to
fire on.

**Second, history is now its own scheduled system rather than the tail of
an enrichment.** The reasoning: history is the only thing here that cannot
be rebuilt from upstream. Everything else re-downloads; a day without a
capture is permanently unobserved. Tying that to the end of a multi-hour
enrichment means an enrichment killed at hour four (OOM, screen lock,
closed terminal — all documented above as having actually happened) takes
that day's capture down with it.

Added `runStandaloneCapture()` in `history.ts`, driven by
`ip-insight history capture [--refresh]`:
- **Its own advisory lock** (key distinct from `cycle`'s), taken on one
  dedicated pooled connection and held for the call. Note the subtlety:
  `db.execute()` borrows an arbitrary connection per statement, so
  lock-then-unlock through it can land on *different* sessions — the unlock
  silently no-ops and the lock survives until that connection closes.
  `cycle.ts` has this same latent issue; the new code takes a dedicated
  client instead.
- **Gap reporting on every run** — days since the last *completed* capture
  (`failed`/`skipped` runs don't move history forward, so they don't close
  a gap). Surfaced both as a warning from `history capture` and as a
  permanent `Continuity:` line in `history status`, printed whether or not
  anything is wrong.
- **`--refresh`** to refresh materialized `ip_intel` first, since a capture
  scheduled independently of enrichment would otherwise diff a stale view
  and record nothing *while reporting success* — the worst failure shape
  for this particular job.
- `historyCaptureEnabled` (the coupled path) still works and stays off by
  default; `config.ts` now documents it as the legacy path and says why.

**Real-data proof this was needed, from this sandbox's own database**:
`history status` reported 9 capture attempts but only **2 completed, both
on 2026-07-28, two minutes apart** — every attempt since was `skipped`
because `ipIntelMode` was left at `view`. 6 days of silent non-capture,
0 archived changes, and nothing anywhere said so until the new
`Continuity: GAP — 6 days` line was added. That is precisely the invisible
failure this change exists to prevent, caught in real data rather than
hypothesised.

**Also found and fixed while verifying**: the new storage metric read
`302.1 MB history` against a table holding **zero rows** — dead pages from
the interrupted captures above, not yet reclaimed by VACUUM. A size figure
that contradicts the row count one line above it is exactly the kind of
misleading number this project avoids, so `history status` now detects that
case and says so, with the `VACUUM FULL` that fixes it.

### Three prerequisites before real history accumulation starts (2026-08-03)

Before letting `history capture` run daily for months, three things needed
fixing first — each one is a change that can't be applied retroactively
once real history exists, which is why they came before, not after.

**1. Geofeed collapse guard.** A real question came up: can
`ip_intel.country` (which reads `COALESCE(geofeed_country, RIR_country)`)
flap between two values across enrichment runs for reasons that have
nothing to do with the real world — which would inject false
"country changed" noise directly into history? Traced the actual code:
a pure network failure (timeout, connection reset) is already safe —
`fetchWithRetry` retries the request, `runSourceWithRetry` retries the
whole source, and if every attempt still fails, the old rows are left
completely untouched (the `DELETE` only ever runs after a response has
already started streaming successfully). The real gap was narrower: a
publisher's server returning HTTP 200 with a genuinely empty or truncated
body — not a network failure, so the retry logic doesn't see it as one.
`ingestion-health.ts`'s per-source minimum-row floors would eventually
flag this, but only as an after-the-fact report (`ip-insight status`),
never blocking the bad data from being committed in the first place.

Fixed: `replaceGeofeedRows()` in `enrichment.ts` now compares a new batch's
row count against that source's existing count *before* touching the
table. Below 50% of the previous count, the whole replace is skipped —
old rows stay exactly as they were, logged as a failure, nothing deleted,
nothing inserted. Wired into both `ingestRfc8805GeofeedCsv` (the ten
direct-URL operator feeds) and `ingestDigitalOceanGeofeedCsv`
(DigitalOcean/Linode). **Not yet applied to `ingestLacnicWhoisCity`** —
that parser streams and flushes incrementally rather than buffering the
whole file first (LACNIC's dump is large enough that buffering it all
before deciding would be a real behavior change, not a safe drop-in), so
giving it the same guard is a separate, slightly bigger piece of work.
Flagged here rather than rushed.

**2. History record trimmed from 34 columns to 18, and reconciled with
what `history-diff.ts` actually reads.** The original plan (pick "the
meaningful fields" by inspection) collided with reality: several fields
the plan wanted to drop turned out to already be read by
`CHANGE_EVENT_FIELDS` in `history-diff.ts` (`asn_name`, `asn_type`,
`region`, `postal`, `latitude`, `longitude`, `threat_category`). Dropping
them silently would have compiled fine and just quietly stopped detecting
part of what `ASNChanged`/`GeoChanged`/`ThreatChanged` claim to track —
exactly the kind of gap that "passes typecheck, wrong at runtime" this
project's own stated standard exists to catch before it ships.

Reconciled instead of dropped silently. Final 18 tracked fields (see
`TRACKED_FIELDS` in `history.ts`): `asn`, `country`, `city`, `geo_source`,
`rpki_status`, `is_threat`, `threat_source`, `is_tor`, `is_vpn`,
`is_cloud`, `cloud_provider`, `is_anycast`, `rir`, `rir_status`,
`network_name`, `registered_date`, `verified_bot`,
`verified_bot_operator`. Three typed-event groups were deliberately
*narrowed* to match, each with a stated reason, not silently:
- `ASNChanged` → `asn` only (was `asn`/`asn_name`/`asn_type`). `asn_name`
  comes from `asn.txt`, whose commercial-use terms are unresolved (see
  the licensing thread above) — not committed to permanently-accumulating
  storage while that's still open. A live lookup can serve it today and
  stop tomorrow; a year of archived history cannot un-store it.
- `GeoChanged` → `country`/`city`/`geo_source` (was 7 fields). The dropped
  four come from the same geofeed CSV row `city` does (RFC 8805, one line
  per prefix), so they move in lockstep with it in practice — tracking
  `city` alone catches the same real-world event.
- `ThreatChanged` → `is_threat`/`threat_source` (was +`threat_category`).
  The one threat feed wired up today (Feodo Tracker) carries little
  category variation to begin with.

Explicitly dropped, permanently: the four `asn_reach`-derived numbers
(`asn_size_rank`, `asn_originated_prefixes`, `asn_originated_addresses`,
`asn_peer_visibility`) — these recompute on *every* `enrich` run
regardless of whether the network actually changed, and left in would
have been the majority source of "changed" rows in history: pure per-run
churn, not a real event. Also dropped: `rpki_authorized_asns`/
`anonymity_providers` (arrays, redundant with the scalar `rpki_status`/
`is_tor`/`is_vpn` already kept), `abuse_email`/`abuse_org`
(administrative), `family`/`special_purpose_*`/`is_globally_reachable`
(genuinely static, never a real event).

Added a test making the `asn_name` exclusion explicit
(`history-diff.test.ts`: "does NOT fire ASNChanged for an org-name-only
change") so it reads as a documented decision to whoever finds it later,
not as a gap. Updated the four existing tests that referenced now-dropped
fields to match the new, narrower, intentional behavior.

**3. New signal, safe to add now that 1 and 2 are done first.** Sequencing
mattered here specifically: adding a new `ip_intel` column *used to* mean
every one of 2.67M rows would show up as "changed" in the next capture
(the old record was `to_jsonb(ip_intel) - 'network'` — everything, so any
new column changes every row's JSON). With `TRACKED_FIELDS` now an
explicit allowlist instead, a new `ip_intel` column is invisible to
history unless it's deliberately added to that list — schema changes to
`ip_intel` stopped being a one-time history-polluting event.

Added `wider_prefix_asn` (both to `ip_intel` and, separately, to
`packages/lookup`'s live path — the two are intentionally independent
implementations of the same interpretation logic per this project's own
architecture, so a new signal needs adding to both, not one): the origin
ASN of the narrowest prefix that strictly contains this address's own
announcement, when that origin differs from the address's own ASN.
Exposed as a raw fact (`asn.wider_prefix_asn` in the API response, a
`wider-prefix-other-asn` flag) and a CLI line, not folded into `risk` —
same reasoning `country-conflict` and `neighborhood_stats` already follow
in this project: report the fact, let the caller judge it, because the
same shape means different things in different contexts.

Real-data verified, both directions:
```
$ node apps/cli/dist/index.mjs lookup 213.221.128.41
RPKI:      invalid (authorized: AS15547)
⚠ Sub-prefix: inside AS15547's wider announcement — combined with the
  RPKI-invalid status above, this is the shape of an unauthorized
  announcement

$ node apps/cli/dist/index.mjs lookup 149.232.235.1
RPKI:      not-found
Sub-prefix:  inside AS30781's wider announcement
```
The second case deliberately prints quietly, no `⚠` — RPKI not-found plus
a wider different-ASN prefix is ordinary internet structure (measured on a
4,000-prefix sample of this database: ~27% of announced prefixes have a
wider-different-ASN covering prefix; narrowed to RPKI-invalid specifically
*and* a wider-different-ASN prefix, that drops to ~2.4%, roughly 1 in 40).
Alarming on every hit would have made the real ~1-in-40 case easy to
ignore in the noise — exactly the mistake this project's `hijack.ts` header
comment already warns against for RPKI-invalid-alone.

`pnpm run typecheck` and `pnpm run test:unit` (39/39) clean after all
three changes.

### Full-scale materialize + history capture — finally verified for real (2026-08-04)

After two silent deaths in this sandbox from what looked like container
suspension (see above), the user ran the actual verification on their own
phone/Termux deployment instead — a real, independent environment, not
this sandbox. Both halves succeeded on real production-scale data:

- `flatten --mode materialized` (from a plain view, forcing a true rebuild
  under the current `IP_INTEL_SELECT`, not just a `REFRESH`): **1,238,514
  rows, ~8,940s (~2.5h)**. Confirms the multi-hour cost this file already
  documented is real and reproducible outside this sandbox too, not a
  sandbox-specific pathology.
- `history capture` against that freshly-materialized `ip_intel`: completed
  in the expected minutes-not-hours range, exercising the standalone
  lock/heartbeat/gap-reporting path this session built earlier, at the full
  real row count. This was the last unverified piece of the standalone
  history redesign — it's now confirmed working end-to-end at scale.

**A real bug surfaced by this run, not a sandbox artifact**: the phone's
`ops.prefix_baseline` had been captured under an earlier, wider
`TRACKED_FIELDS` shape (before this session's schema trim). Diffing that
against a freshly-shaped live record made *every one* of the 1,238,514
prefixes register as "changed" — 100%, all schema noise, zero real drift —
because the JSON key sets simply didn't match, not because any tracked
value differed. Caught before it did lasting damage only because the user
noticed the suspicious 100% figure and asked about it rather than trusting
it. Fixed properly rather than just cleaned up once: `captureBaseline()`
now samples the baseline's shape before diffing and refuses to run (a new
`HistoryPreconditionError`, filed as `skipped` not `failed`) if it doesn't
match today's `TRACKED_FIELDS`, with a message pointing at the new
`ip-insight history reset-baseline --yes` command (clears
`ops.prefix_baseline` only, `ops.prefix_history` untouched). Verified for
real against the actual stale 2.67M-row baseline left over in this
sandbox's own dev DB from earlier sessions: `captureBaseline()` now throws
the precondition error instead of silently polluting history, and a
reset-then-recapture cycle produces a clean, event-free baseline
afterward. The user separately cleaned up the polluted rows on their own
phone via a manual `DELETE FROM ops.prefix_history` before this code fix
existed — their `ops.prefix_baseline` was correct throughout and was never
touched by that cleanup.

**Lesson for next time `TRACKED_FIELDS` changes**: this failure mode will
recur for *any* future edit to that list on a database with pre-existing
history, by design of what a "shape mismatch" means — the new precondition
check exists specifically so it fails loud and actionable instead of
silently polluting the archive again.
