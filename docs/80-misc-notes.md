# Everything that didn't fit a clean category

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Six more audit findings fixed (2026-08-04)](#six-more-audit-findings-fixed-2026-08-04)
- [A real bug the #10 merge introduced — found, fixed same day](#a-real-bug-the-10-merge-introduced-found-fixed-same-day)
- [Real gap found while explaining the above — not yet fixed, explicitly deferred](#real-gap-found-while-explaining-the-above-not-yet-fixed-explicitly-deferred)
- [Both tiered-refresh prerequisites implemented (2026-08-06)](#both-tiered-refresh-prerequisites-implemented-2026-08-06)

---

### Six more audit findings fixed (2026-08-04)

The "quick, low-risk, no design decision needed" half of the audit's
remaining 17 open items:

- **`cycle.ts`'s advisory lock had the exact bug `history.ts` was already
  fixed for**: acquire/release via `db.execute()` (a fresh pooled
  connection per call) instead of one dedicated connection held for the
  lock's lifetime. Rewritten to match `runStandaloneCapture`'s pattern.
  Verified for real: held the lock from a separate `psql` session, confirmed
  `cycle` correctly detected it and exited cleanly; then ran a real (small-
  scope) cycle end to end and confirmed the lock was actually free
  afterward via a fresh `pg_try_advisory_lock` check.
- **DB pool default raised 10 → 20** (`packages/db/src/index.ts`): a single
  cold `lookupIp()` call fans out to 11-16 concurrent queries on its own,
  already above pg's own default. `DB_POOL_MAX` still overrides either
  direction, for a phone/Termux deployment that wants it lower.
- **`apps/cli`'s top-level error handler now also calls `logger.error`**,
  not just `console.error` — the documented cron entry redirects
  stdout/stderr to `/dev/null` on the assumption "everything meaningful
  goes through the logger," which was false for anything failing before a
  command's own logging starts (bad `DATABASE_URL`, a config parse error).
- **`ipv4ToInt` tightened** to the same digit-only-regex discipline
  `parseCidr` already used, instead of `Number()` coercion silently
  accepting `"1e2.2.3.4"`, `"0x10.2.3.4"`, `"1.2.3."` as valid addresses.
- **`masklen(network)` functional index added** to materialized `ip_intel`
  — `.mmdb` export's 129-page-by-mask-length loop was doing a full
  sequential scan every page. Measured directly on identical synthetic
  data: `Seq Scan` (569 buffer reads) → `Index Scan` (12 buffer reads).
- **`apps/server/src/routes/lookup.ts` conflated client input errors with
  infrastructure failures** (both landed as an unlogged 400 with the raw
  error text exposed) — the same wrong pattern `/self-check` had already
  been fixed to avoid. New `InvalidIpError` (mirroring `PrefixCheckInputError`)
  lets `/ip`, `/bulk`, `/asn` all follow `/self-check`'s already-correct
  split. Turned up something worse while fixing it: `/bulk` and `/asn` had
  **no try/catch at all** — any thrown error fell through to Express's
  default handler, unlogged. Verified live against a real Postgres outage
  (pointed `DATABASE_URL` at a nonexistent database): both routes now
  return a generic 500 and the failure actually appears in the log.

All six typechecked, tested (68/68 passing including new tests), and — where
the finding was a real behavioral/performance claim rather than a type
error — verified against real or realistic data, not just "it compiles."

### A real bug the #10 merge introduced — found, fixed same day

Caught only because a full, real `lookup 8.8.8.8 --json` was requested and
actually read end to end, not because any test caught it: switching
`resolveAsnLocal` from Drizzle's typed `.select()` builder to a raw
`db.execute(sql\`...\`)` call (necessary for the merged CTE query) silently
lost Drizzle's automatic `bigint(..., { mode: "number" })` coercion for the
`asn` column. node-postgres hands `bigint` values back as **strings** on
the raw-query path (to avoid precision loss above 2^53) — so
`asnEntry.asnNumber` became `"15169"` instead of `15169`.

The fallout: `rpki.status`'s validity check compares
`roaRows[].asn === asnEntry.asnNumber` with strict equality, and
`15169 === "15169"` is `false` in JavaScript — **every RPKI-valid
announcement was silently reported "invalid"**, and `asn.number` in every
API response was a JSON string instead of a number (a real contract break
for any consumer expecting the documented type). Neither was caught by
`pnpm test` — the suite doesn't hit a real database, so a type coming back
wrong from the actual driver was invisible to it.

Fixed with an explicit `Number()` conversion (the same pattern
`mmdb-export.ts` already documents for this exact bigint-ASN case — safe
specifically because ASNs are 32-bit, well inside what a JS number
represents exactly) and verified against three real addresses:

| Address | ASN | Before (broken) | After (fixed) |
|---|---|---|---|
| 8.8.8.8 | 15169 | invalid | **valid** — matches its real ROA |
| 1.1.1.1 | 13335 | invalid | **valid** — matches its real ROA |
| 213.221.128.41 | 65205 (wider 15547) | invalid | **invalid** — a genuine hijack-shaped mismatch, correctly flagged both times |

Lesson worth keeping: any future move from Drizzle's typed builder to raw
`db.execute()` needs an explicit check for `bigint`/`numeric` columns in
what's being selected — the coercion Drizzle provides silently disappears,
and nothing in this codebase's test suite would catch it since none of it
runs against a live database.

### Real gap found while explaining the above — not yet fixed, explicitly deferred

Investigating the `found: false` non-bug above (a `lookup` mid-`cycle` racing
`ip_blocks`'s own insert) surfaced a genuine, separate finding while
discussing `mmdb-publish.ts`'s validation: **its three automatic checks
(`readable`, `golden:<ip>`, `prefix-count`) would not have caught today's
exact scenario if it had happened during an `.mmdb` build instead of a
manual `lookup`.**

Read `mmdb-publish.ts` in full to confirm this rather than guess:
- `DEFAULT_GOLDEN_SET` only ever asserts `asn`/`country`/`verified_bot` on
  its 4 addresses (see the file — `expect: {asn, country}`,
  `expect: {asn}`, `expect: {verified_bot}`, `expect: {country, asn}`).
  **`network_name` and `rir` are not checked by any golden case.**
- `prefix-count` only compares row counts against the previously published
  file (floor: 80%). A field going bulk-null doesn't change row count, so
  this check is blind to it too.
- Conclusion, verified against the actual code, not assumed: a build where
  every prefix has the right ASN/country but `network_name`/`rir` are
  silently null across the board would pass all three checks and get
  published — a customer-facing regression with zero automatic detection.

**Explicit decision, not yet acted on**: the user's own call (relayed
through a technically-engaged third party who independently confirmed this
by reading the code) was to record this now and *not* implement a fix yet —
wait for the current `cycle` to finish and do another round of real testing
first. When this is picked back up, the agreed shape of the fix (also from
that discussion, worth keeping rather than re-deriving) is: **don't
special-case just `network_name`/`rir`** — generalize into a field-
completeness ratio check (same shape as `prefix-count`'s row-ratio
comparison, but per-field: what fraction of records have each critical
field non-null this build vs. the previously published one) covering every
field the golden set *doesn't* already pin down, not just the two found
today. Framed as important but not urgent: lower priority than the auth
work (this system isn't internet-exposed yet), but something to close
before any VDS/SaaS exposure, since the `.mmdb` file is the only thing a
paying consumer ever actually sees — a silent defect there compounds
unnoticed in exactly the way this whole audit-and-fix pass has been trying
to eliminate elsewhere.

### Both tiered-refresh prerequisites implemented (2026-08-06)

The two blockers named in the plan above are done. Neither depends on the
tiered design being right, which is why they went first.

**1. `enrich --skip-flatten`.** `startEnrichment()` gained a
`skipIpIntelRefresh` option, threaded onto `ActiveJob` (and through
`resumeEnrichment`, which the typechecker caught — it builds its own
`ActiveJob` and would otherwise have silently kept the old behaviour on
the resume path). The trailing `ensureIpIntel()` is now gated on it.

Deliberately opt-in and loud, never a default: the unconditional refresh
exists so `ip_intel` can never silently lag the tables it reads, and that
guarantee is worth keeping for every ordinary run. What it could not
survive was cost — ~4.7 hours paid in full even by a run that touched one
small source, which is what made `--sources <one-id>` useless for the
frequent narrow refreshes the fast tier needs. So the skip is available,
but the caller has to ask, and both the CLI and the job log say plainly
that `ip_intel` is now behind the source tables and name `ip-insight
flatten` as the fix. Stale-but-coherent-and-announced is the trade being
made available; hiding it is not.

**2. `exportMmdb()` now reads all 129 pages in one `repeatable read`
transaction.** Previously each per-masklen `db.execute()` took its own
snapshot — 129 separate implicit transactions — so a refresh committing
partway through yielded a file that was pre-refresh for some prefix
lengths and post-refresh for others. Nothing would have caught it: the
result is a structurally valid .mmdb whose rows merely disagree with each
other, so `validate()`'s per-field counts pass and the torn build gets
published. `repeatable read` rather than `serializable` because this is a
read-only scan that needs a stable snapshot and nothing else;
`serializable` would add predicate locking and a real
serialization-failure retry path for a guarantee unused here.

Worth recording why this mattered enough to fix before the design work:
it is the concurrency hole the founder anticipated when asking about a
coordinating worker. That instinct was right, but the location was not
where it looked — the *publish* step was already safe (`repointCurrent()`
swaps by atomic rename), and overlapping cycles were already prevented by
advisory locks. The genuine window was in the export, and it widens as
soon as a second relation starts refreshing on its own cadence, which is
exactly what the tiered plan introduces.

**Verification status, stated exactly:** `pnpm run typecheck` clean; full
suite 74/74; `enrich --help` shows the new flag with its warning text; and
`export-mmdb` still correctly refuses a plain-view `ip_intel` with the
same guard message, which proves the code path ahead of the new
transaction is intact.

**Since exercised for real, on the phone (2026-08-07), and it closed the
gap above.** After a full `cycle` (collect + enrich, 29,775s, materialized
`ip_intel` at 3,203,416 rows) finished, `export-mmdb --out ~/current.mmdb`
ran the 129-page transaction loop against real materialized data:
`scanned: 3,203,416, kept: 2,880,315, 175,449 distinct records, 5,096,013
tree nodes, 63.3 MB file`. No torn output, no error — the transaction
wrap works as designed. The gap between scanned and kept (322,101 rows)
is prefixes whose record ended up empty after `toRecord()`'s null-drop —
expected, not a bug.

**One real problem this run did surface, unrelated to the transaction
change**: the first attempt (plain `node .../index.mjs export-mmdb ...`,
no heap flag) crashed with `FATAL ERROR: Ineffective mark-compacts near
heap limit — JavaScript heap out of memory` around ~1GB of V8 heap, well
under the phone's actual ~11GB RAM — this is `mmdb-writer.ts` holding
every entry in memory before serializing (it has to: the tree's node
count must be known before it can be written, see that file's header),
colliding with Node's default heap ceiling, which under-estimates
available memory on this phone rather than the phone genuinely running
out. Postgres handled the client dying mid-transaction correctly ("could
not receive data from client... unexpected EOF... open transaction" —
the transaction aborted cleanly, nothing torn). Fixed by running with
more heap headroom: `node --max-old-space-size=4096 .../index.mjs
export-mmdb ...` succeeded on the retry. Worth remembering as a standing
instruction for this phone specifically, not just this one run — any
future `export-mmdb` invocation should use `--max-old-space-size=4096`
(or higher; 2.88M kept entries is already close to what crashed at the
default, and this number only grows) until/unless `mmdb-writer.ts` is
changed to stream rather than buffer the whole entry set, which nothing
here has attempted.
