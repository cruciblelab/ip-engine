# Configurable source selection, and the stale-data-from-a-deselected-source gap

Written 2026-08-26 as a plan. **Steps 1 and 2 were built and verified
the same day — see the "shipped" sections at the end. Step 3 (RouteViews
ingestion itself) was built 2026-11-08 after RIPE's logo answer never
came, and RouteViews is now the default — "Step 3: shipped" at the very
end.**

Prompted by a direct question while considering adding RouteViews as a
selectable alternative to RIPE RIS: *if the source is switchable in
config, does data left over from the previously-selected source still end
up in the `.mmdb`?*

**Checked against the real code rather than reasoned about. The answer is
yes — for both configurable-source mechanisms this project currently has.
This is a real gap, not a hypothetical one.**

## Finding 1 — `bgp_origin_ranges`: a deselected source's rows are never cleaned up

`ingestRisWhoisDump` (`packages/collector/src/enrichment/enrichment.ts:1136-1138`)
refreshes by deleting **only its own** rows before reinserting:

```ts
await db
  .delete(bgpOriginRangesTable)
  .where(eq(bgpOriginRangesTable.source, source.config.id));
```

That is correct behaviour for a source refreshing itself, and the table
does carry a real provenance column (`source`, default `"ripe-ris"` —
`packages/db/src/schema/bgpOriginRanges.ts:54`). But it means the only
thing that ever deletes `ripe-ris` rows is the `ripe-ris` ingestion
itself. Switch the config to RouteViews and:

1. RouteViews deletes `WHERE source = 'routeviews'` (nothing, first run)
   and inserts its rows.
2. **Every `ripe-ris` row stays in the table**, frozen at whatever date
   that source last ran, because nothing runs to clean it.
3. `ip_intel` — and therefore the `.mmdb` — reads the *whole table* with
   a longest-prefix match. A stale `ripe-ris` /24 will out-rank a fresh
   `routeviews` /20 and answer the query.

So the switch wouldn't just fail to remove old data; the old data could
actively win. Exactly the concern raised.

## Finding 2 — `asn_blocks.name`: worse, because there's no provenance at all

The already-shipped `asnNamePrimary` / `asnNameFallbackEnabled` mechanism
(CAIDA primary, RIPE `asn.txt` fallback) has the same class of problem in
a harder form:

- `asn_blocks` has **no source column** — just `name: text("name")`
  (`packages/db/src/schema/asnBlocks.ts:38`). Nothing records which
  source wrote a given name.
- Nothing ever sets `name` back to `NULL`. Grepped: the single write is
  the `SET name = v.name` UPDATE in `flushAsnNames`
  (`enrichment.ts:1055`). There is no reset path anywhere.

Concretely: run with CAIDA primary + RIPE fallback (RIPE fills ~19k ASNs
CAIDA doesn't cover), then set `asnNameFallbackEnabled: false`. Those
19k RIPE-written names **stay in the table permanently**. "Turn the
fallback off" silently means "stop adding new fallback data", not "stop
serving fallback data" — and since the RIPE-fallback exists specifically
because its commercial licensing is unresolved, that gap has a licensing
dimension, not just a correctness one.

### Worth stating plainly: my own testing masked this

The three end-to-end scenarios run when that feature shipped each began
with a manual `UPDATE asn_blocks SET name = NULL`. Every scenario passed
**and every scenario was correct in isolation** — but that reset is
exactly what real operation never does. Setting up a clean test hid the
one failure mode that only appears when config changes on an already-
populated database. Recorded here rather than quietly fixed: the test was
right about what it tested and wrong about what it implied.

## The general rule this needs

Any table a config switch can change the source of needs both:

1. **Provenance** — a `source` column recording which source wrote each
   row (or each field, for `asn_blocks.name` → a `name_source` column).
   `bgp_origin_ranges` already has this; `asn_blocks` does not.
2. **A deselected-source purge** — an explicit step that removes data
   belonging to sources that are no longer active, not merely refraining
   from adding more of it:
   - `bgp_origin_ranges`: `DELETE ... WHERE source NOT IN (<active set>)`
   - `asn_blocks`: `SET name = NULL WHERE name_source NOT IN (<active set>)`

The purge has to be driven by *the currently-configured set*, not by each
source cleaning up after itself — because a deselected source, by
definition, does not run.

### When the purge runs — after success, not before

Two orderings, and the safer one matches an instinct already stated for
the `.mmdb` handoff ("if something goes wrong, don't ship it / roll
back"):

- **Purge first, then ingest** — a failed ingest leaves the table with
  neither the old data nor the new. This project already documents this
  exact flaw for its delete-then-reinsert sources in `SOURCES.md`
  ("if a run exhausts all retries partway through, the table is left
  holding partial data").
- **Ingest first, purge only after the new source has completed
  successfully** — the old data keeps serving until there is verified
  new data to replace it. Slightly stale beats empty.

**Recommended: the second.** It costs one transient period where both
sources' rows coexist, which is acceptable precisely because it's
transient and bounded by a successful run.

## What this means for the `.mmdb`

Nothing extra. The `.mmdb` is built from `ip_intel`, which is built from
these tables — fix the tables and the `.mmdb` is correct by construction.
There is no separate `.mmdb`-side filtering to write, and there should
not be: a second place that decides which source counts is a second place
to get it wrong.

## RouteViews as the concrete new case

Licensing verified directly against RouteViews' own terms page
(2026-08-26) — and unlike the RIPE `asn.txt` situation, the license
**names our exact use case** rather than requiring interpretation:
*"When selling services, products, reports, or other derivative works
based on RouteViews Data to third parties, you agree to provide
attribution..."* CC BY 4.0, self-serve, no approval email required.
Requirements: attribution statement, the RouteViews logo, and a specific
boilerplate paragraph — the same shape as RIPE RIS's requirements, minus
the "email us for permission first" step that currently has us waiting.

Two things to verify before building, neither assumed here:

- **Data format.** RouteViews publishes MRT-format RIB dumps, not a
  ready-made `prefix → origin ASN` text file like RIPE's
  `riswhoisdump`. A processed prefix-to-AS dataset derived from
  RouteViews exists (published by CAIDA), which would be far less work
  than an MRT parser — **but that is a different CAIDA dataset from the
  as-organizations one whose AUA this project already verified, and its
  terms have not been checked.** Check them before relying on it; do not
  assume the earlier CAIDA verification carries over.
- **Real coverage comparison.** Published research (RIPE Labs / CAIDA
  authors) states RouteViews gives "a more complete view of the Internet
  in terms of IP prefix coverage" than RIPE RIS, with comparable
  collector counts (29 vs 24). That is a general academic finding, not a
  measurement of *our* pipeline — measure it the way CAIDA-vs-`asn.txt`
  was measured (download both, compare real coverage and agreement)
  before claiming parity or improvement anywhere customer-facing.

## Config shape

Follow the shipped `asnNamePrimary` / `asnNameFallbackEnabled` pattern for
consistency — same five wiring sites in `config.ts`, same CLI `config`
output treatment.

**Decided: exclusive — one source or the other, never both.** Unlike the
ASN-name case, this is not a primary/fallback pair and not a merge. A
single setting picks the BGP origin source; the other one does not run at
all.

The reasoning matters for anyone reading this later, because "merge" would
otherwise look attractive (more collector peers = more observed prefixes,
which is what modern BGP collection platforms do): **the purpose of having
two sources here is not coverage, it is a lawful escape hatch.** RIPE RIS
is the current source and its data terms are fine; the open question is
only the logo permission (`docs/103`). If that comes back negative — or
never comes back — RouteViews replaces it outright, because RouteViews'
license names our exact use case with no permission step. Blending two
sources would mean still depending on RIPE while claiming to have an
alternative, which defeats the point.

Exclusivity also makes the purge trivial and unambiguous: the active set
is exactly one source, so

```sql
DELETE FROM bgp_origin_ranges WHERE source <> '<selected>'
```

...is the whole cleanup, with no set arithmetic to get wrong. It also
sidesteps the `(network, asn)` unique index
(`bgpOriginRanges.ts:60-63`), which would have made two sources reporting
identical pairs collide rather than coexist.

Config field shape follows the shipped pattern:
`bgpOriginSource: "ripe-ris" | "routeviews"`, default `"ripe-ris"` — a
plain enum, no companion boolean, since there is no second tier to
enable or disable.

## Order of work

1. Add `name_source` to `asn_blocks` + the purge for it — this fixes an
   already-shipped mechanism that is live today, and is independent of
   whether RouteViews is ever added.
2. Add `bgpOriginSource` + the exclusive-source purge for
   `bgp_origin_ranges`. Testable immediately with only `ripe-ris`
   defined: setting it to a second value should empty the table's
   `ripe-ris` rows, which proves the purge without needing RouteViews
   ingestion to exist yet.
3. Only then: RouteViews ingestion itself, after its data-format and
   coverage questions are answered with real files.

Step 1 is worth doing regardless — it is a real correctness (and
licensing) gap in shipped behaviour, not preparation for a feature that
might not happen. Step 2 is the switch mechanism; step 3 is what the
switch switches *to*, and only becomes urgent if RIPE's answer forces it.

**Testing note, given how the last round went wrong**: verify each of
these against a database that was already populated by the *other*
source, without a manual reset first. A test that starts from a clean
table cannot detect a stale-data bug — that is precisely the mistake
recorded above.

---

# Step 1: shipped (2026-08-26)

`asn_blocks` provenance + the deselected-source purge are built, and
verified end to end against the real database.

## What was built

- **`asn_blocks.name_source`** (`packages/db/src/schema/asnBlocks.ts`) —
  records which enrichment source wrote `name`.
- **`flushAsnNames`** writes `name` and `name_source` in the same
  statement, never two — provenance that lags the value it describes is
  provenance that can end up wrong.
- **`purgeDeselectedAsnNameSources`** (`enrichment.ts`), called from
  `runJob` after every source has run. Both safety properties from the
  plan above are implemented as written: it skips itself unless every
  currently-active source completed in that job, and it runs after the
  writes rather than before them.

## The bug the test found, and why the test found it

The first implementation was wrong, and the failure mode is worth
recording because it is subtle and it invalidates an assumption stated
confidently in the plan above.

A fallback source writes under `WHERE name IS NULL`. That guard means it
**cannot re-stamp a row it wrote on an earlier run** — that row has a
name now, so the guard skips it. So the fallback's own past output stays
permanently unattributed, and the purge — which treats "no provenance" as
"no active source claims this" — deleted it.

Measured, not theorised: a full default run (both sources active, nothing
misconfigured) **destroyed 14,647 real ASN names** that `ripe-asn-names`
had written in an earlier session. Self-healing on the next run, since
those rows became null and the fallback refilled them — but a purge that
deletes live data from an *active* source is a data-loss bug, not a
cosmetic one.

**Fix**: `onlyIfMissing` now means `name IS NULL OR name_source IS NULL`.
A fallback can adopt its own unattributed rows, so after one full run
"no provenance" genuinely means "no active source covers this" — the
condition the purge was always assuming.

**Why this was caught at all**: because the run was done against a
database already populated by both sources, with no manual reset — the
exact discipline this document demanded before any of it was written. The
three scenarios that shipped the original `asnNamePrimary` feature each
began with `UPDATE asn_blocks SET name = NULL`, and every one of them
passed. A clean starting table cannot detect a stale-data bug; that is
the whole point.

## Verification

Real Postgres, real files, no manual resets between runs. Starting state:
117,083 rows, 102,617 named, 0 with provenance.

| Run | Config | Result |
|---|---|---|
| 1 — first implementation | default (caida primary, fallback on) | **Failed**: purge cleared 14,647 live rows. Named dropped 102,617 → 87,989. Bug above. |
| 1b — after the fix | same | `ripe-asn-names` 19 → **14,664** (fallback re-claimed its own rows). Named back to 102,634. **Zero** named rows without provenance. Purge cleared nothing — correct, both sources active. |
| 2 — the actual feature | `asnNameFallbackEnabled: false` | Purge logged `active: ["caida-asn-names"], cleared: 14664` — exactly the fallback's row count. Final: 87,970 caida-attributed, 29,113 unnamed, 117,083 total. |

Run 1b also demonstrates the recovery path for run 2: it started from
rows the buggy purge had nulled and refilled them to 14,664, which is the
same path re-enabling the fallback takes.

`pnpm test`: 156/156.

## Known state after these runs

The sandbox database currently holds the run-2 result (fallback's names
purged) while the config has been restored to the default
(`asnNameFallbackEnabled: true`). Those two disagree until the next
enrichment run repopulates the fallback's rows — expected, not a defect,
and it resolves itself on the next `enrich`.

---

# Step 2: shipped (2026-08-27)

`bgpOriginSource` and the exclusive-source purge for `bgp_origin_ranges`
are built and verified. RouteViews ingestion itself is still step 3 — the
*switch* exists, what it switches to does not yet.

## What was built

- **`bgpOriginSource: "ripe-ris" | "routeviews"`** in `config.ts`, default
  `"ripe-ris"`, wired at all five standard sites and printed by
  `ip-insight config`.
- **`BGP_ORIGIN_SOURCE_IDS`** — maps a *project* to the enrichment *source
  ids* that write its rows.
- **`purgeDeselectedBgpOriginSource`** (`enrichment.ts`), called from
  `runJob` alongside the ASN-name purge.

## Two bugs caught before they ran

Both found by checking the real database rather than trusting the plan's
own description of it, and both would have destroyed the table.

**1. The config value is not what the column stores.** `bgpOriginSource`
names a project (`"ripe-ris"`); `bgp_origin_ranges.source` stores the
source id that wrote each row (`"ris-whois-ipv4"` / `"ris-whois-ipv6"` —
one project, two sources, one per address family). The first version
compared them directly. `DELETE ... WHERE source <> 'ripe-ris'` matches
**every row in the table** — all 1.6M of them. The guard would also never
have fired, since no source has the id `"ripe-ris"`, so the function would
have looked harmless in testing while being one registry rename away from
deleting everything. Fixed with the explicit project→ids map, and
`notInArray` over the full id list.

**2. An empty id list deletes everything.** `routeviews` has no sources
registered yet, so its id list is `[]`. The "did every active source
complete?" guard passes *vacuously* on an empty list (nothing is missing
from nothing), and `notInArray(source, [])` matches every row. Selecting
the not-yet-built project would therefore have emptied the table — the
exact opposite of the plan's stated safety property. Fixed with an
explicit empty-list check ahead of the guard.

Neither bug was caught by types or by the test suite. Both came from
looking at what the table actually contains (`SELECT source, count(*)`)
before trusting code written against what it was assumed to contain.

## Verification

| Test | Setup | Result |
|---|---|---|
| A — the dangerous path | `bgpOriginSource: "routeviews"` (no sources registered), ran an unrelated small source | Purge skipped. All 1,617,412 rows intact. Pointing the setting at a project that doesn't exist yet leaves current data serving, exactly as the config's doc comment promises. |
| B — the purge firing | `bgpOriginSource: "ripe-ris"`, seeded 1,000 rows with `source = 'routeviews'` to stand in for a previously-selected project's leftovers, then ran both ris-whois sources | Logged `active: "ripe-ris", cleared: 1000` — exactly the seeded rows. Final table: `ris-whois-ipv4` 1,252,458 + `ris-whois-ipv6` 312,251, zero `routeviews`. Real data refreshed and untouched. |

`pnpm test`: 156/156 (run four times — one earlier run had a single
failure immediately after the 1.5M-row ingestion, not reproducible across
three consecutive clean runs afterwards; recorded rather than ignored, but
no evidence it relates to this change).

## What step 3 needs

`BGP_ORIGIN_SOURCE_IDS.routeviews` is `[]` and must be filled with the
real source ids when RouteViews ingestion is built — an entry that
doesn't match the registry's actual ids reintroduces bug 1 above. The
open questions from the plan (MRT format vs. a processed prefix-to-AS
dataset and its separate licensing, plus a real coverage comparison
against RIPE RIS) are unchanged and still unanswered.

---

# Step 3: shipped (2026-11-08) — RouteViews, and the new default

RouteViews ingestion is built, measured against RIS on real data, switched
on end to end in Postgres, and is now the default (`bgpOriginSource:
"routeviews"`). The decision record (why RIS had to go: the logo permission
RIPE never answered) is `docs/106`, Phase 1 log. This section is the
engineering record.

## The two open questions above, answered

**Data format: raw MRT RIBs, read by our own parser — not CAIDA's
`pfx2as`.** CAIDA's dataset is RouteViews data re-published under CAIDA's
general AUA, which grants a "limited, non-exclusive, non-transferable,
non-assignable, and terminable license to copy, modify, and use the data"
and adds "No license is granted for any other purpose" — no mention of
commercial use either way. Using it would put that AUA *on top of*
RouteViews' CC BY. Reading the raw files keeps exactly one license in play,
the one that names our use case. The cost was writing an MRT reader:
`packages/collector/src/enrichment/mrt.ts`, ~280 lines, TABLE_DUMP_V2 RIB
records and the AS_PATH attribute only, with 15 unit tests on hand-built
bytes (`mrt.test.ts`).

**Coverage: measured, not assumed.** Same day's files (RIS dump vs.
route-views2/route-views6 14:00 UTC RIBs), same prefix filter, same
"longest prefix, then most peers" rule `lookup.ts` uses. Script and output:
`scratchpad` tools, numbers copied into `docs/106`'s Phase 1 log. Short
version: same best origin on 99.90% (v4) / 99.97% (v6) of shared prefixes;
for uniformly random routed IPv4 addresses, 98.71% same answer, 0.41% only
RIS can answer, 0.33% only RouteViews can.

## What was built

- `routeviews-rib-ipv4` / `routeviews-rib-ipv6` registry entries, parser
  `routeviews-mrt-rib`. The registry URL is the collector's archive root;
  `resolveLatestRouteViewsRib` lists `YYYY.MM/RIBS/` for this month and
  last, and takes the newest RIB at least an hour old (the newest one in
  the listing can still be being written).
- `ingestRouteViewsRib`: streams the `.bz2` through `unbzip2-stream`
  (MIT, pure JS — no system `bzip2` needed on Termux) into the MRT reader,
  one row per (prefix, origin ASN) with `peer_count` = distinct RouteViews
  peers. Deletes its own old rows only after the RIB download has started
  successfully.
- `BGP_ORIGIN_SOURCE_IDS.routeviews` filled in, and the map moved to
  `enrichment-sources.ts` so `ingestion-health.ts` can use it too.
- **A real gate.** Until now "exclusive" was only true by accident — the
  RIS sources ran no matter what `bgpOriginSource` said, because there was
  nothing else. `runSource` now skips a deselected project's sources
  *before* fetching anything.
- `lookup.ts`: `asn.source` is read from the matched row's `source` column
  (`"bgp-ris"` / `"bgp-routeviews"`) instead of the hardcoded `"bgp-ris"`,
  which would have kept naming RIPE in every API response after the
  switch. OpenAPI spec and generated clients updated; `peer_visibility`'s
  description no longer says "RIPE RIS route collectors" (it was wrong
  even for RIS — it counts peers, not collectors) and now warns that the
  scale differs (RIS ~440 peers, RouteViews ~20).

## The bug the first real switch found

The first end-to-end switch looked like a success and wasn't:

| | Reported | Actually in the table |
|---|---|---|
| `routeviews-rib-ipv4` | 1,170,244 ingested | **24,527** |
| `routeviews-rib-ipv6` | 273,003 ingested | **180** |

The unique index was `(network, asn)`. While the RIS rows were still in
the table, every RouteViews row with the same prefix and origin — almost
all of them — hit `ON CONFLICT DO NOTHING` and vanished, but was still
counted as ingested. The purge then saw "RouteViews completed, RouteViews
has rows", deleted the RIS rows, and left ~1.7% of the data. In
production that would have been the day ASN data disappeared for nearly
every address.

Step 2's test B didn't catch it because its stand-in "routeviews" rows were
1,000 seeded fakes that never collided with real RIS pairs. The plan above
even names the collision ("identical pairs collide rather than coexist")
— as an argument against merging, without following it through to the
switch itself.

Four fixes, all in place:

1. **Unique index is now `(network, asn, source)`** (`bgpOriginRanges.ts`)
   — each source owns its rows, so two projects coexist for the one run in
   which the purge removes the old one. Needs a schema push
   (`pnpm --filter @workspace/db run push`) on any existing database.
2. **`flushBgpOriginBatch` counts what Postgres inserted** (`rowCount`),
   not what it offered. Conflict-dropped rows now show up as skipped.
3. **The purge refuses unless the table holds at least what the selected
   sources reported writing** in this job — "some rows exist" let 24,527
   stand in for 1.4M.
4. **The purge runs right after the BGP sources**, not at the end of the
   job, so `asn-reach` / `neighborhood-stats` / `asn-profile` (registered
   later) never aggregate both projects' rows at once.

## Verification (real data, real Postgres, 2026-11-08)

| Run | Config | Result |
|---|---|---|
| 1 | `ripe-ris`, all four BGP sources requested | RIS: 1,273,438 + 320,438 rows. Both RouteViews sources `skipped` with no download. Leftover RouteViews rows from the failed attempt purged (24,707). |
| 2 | `routeviews`, same four requested | RIS sources `skipped`, no download. RouteViews: 1,170,234 + 272,998 rows — **table matches the reported counts exactly**. Then RIS's 1,593,876 rows purged. 154 s total on the sandbox, of which ~110 s is the IPv4 RIB (77 MB `.bz2`). |
| lookup | after run 2 | `8.8.8.8` → AS15169, `88.255.0.1` → AS9121, `2001:4860:4860::8888` → AS15169, all `asn.source: "bgp-routeviews"`, confidence 0.95. |

Also: every one of the 1,443,100 prefix strings the reader produced was
checked against Python's `ipaddress` — all valid with host bits zero, all in
canonical text form. `pnpm test`: 171/171 (156 before + 15 MRT tests).

## Also fixed on the way

- `runSource` relabelled a parser's own `"skipped"` as `"completed"`, so
  the disabled ASN-name fallback reported a run that never happened. It
  now stays `"skipped"`.
- `ingestion-health` only checks the selected BGP project's sources (a
  deselected project's old "ok" says nothing about what is being served),
  with floors for the two RouteViews sources.

## Not done, on purpose

- **One collector per family** (route-views2, route-views6), the choice
  CAIDA's own long-running dataset makes. RouteViews runs many more
  collectors; adding some would close part of the 0.41% RIS-only gap, at
  a multiple of the download. Measure before deciding.
- **AS paths are now in hand and unused.** `asn_reach`'s schema comment
  says a real customer cone needs full AS paths from MRT dumps — this
  reader already walks them to find the origin. Not a reason to build the
  cone now, just a note that the hard input exists.
- **`bgp-live` (RIS Live) is still RIPE RIS.** It is not customer-facing —
  `lookup` and the `.mmdb` never read its tables — so it was left alone.
  `docs/106` G4.

---

# Step 3 addendum (2026-11-12): the switch on a real phone database

The four fixes above held in the sandbox, where the schema push ran. On
the operator's phone it didn't, and the switch emptied the table anyway.

**What happened.** `pnpm --filter @workspace/db run push` reads
`DATABASE_URL` from the shell only; the CLI reads it from the repo-root
`.env`. With the address only in `.env`, push stopped with "DATABASE_URL,
ensure the database is provisioned" — one line in a long setup, easy to
miss — and the old `(network, asn)` unique index stayed. The RouteViews
run then hit the original collision: 1.42M rows refused, ~27k written.
Fix 3 above ("the table must hold at least what the sources reported")
**did not catch it**, because fix 2 had made "reported" honest: 27k
reported, 27k present, so the purge deleted all 1.59M RIS rows. Result:
`ASN: -` for nearly every address, and the operator's `enrich` total of
"skipped: 5,547,034" (≈1.42M refused + DB-IP's ~4.13M skipped IPv6 rows).

Reproduced exactly in the sandbox by restoring the old index before
switching: 1,418,983 refused, 26,725 rows left, RIS purged.

**The guard was checking the wrong thing.** Fix 3 protects against rows
vanishing *after* they were written. This was rows never written. Both
need guarding, and the root cause — an old schema — needs a check of its
own rather than inference from row counts.

**Fixed (2026-11-12):**

1. **Schema check before any BGP ingest** (`bgpOriginSchemaProblem` in
   `enrichment.ts`): if `bgp_origin_ranges` lacks the
   `(network, asn, source)` unique index, or still has the old
   `(network, asn)` one, every BGP source fails at once with an
   explanation naming the push command — before deleting anything. Not
   retried (retrying cannot fix a schema; it only delayed the message by
   two minutes of backoff). Verified on the reproduced broken database:
   both RouteViews sources refused in 3 s, table untouched.
2. **The purge checks the schema too**, and separately refuses if any
   selected source had more than 1% of its rows refused as conflicts
   (new `conflictDropped` counter; RIS's own duplicates are ~150 in 1.27M,
   RouteViews has none). This second check was not separately exercised —
   with check 1 in place the situation can't arise in a test without
   bypassing it — so it is defence in depth, not a verified path.
3. **`push` now reads the repo-root `.env`** when `DATABASE_URL` isn't set
   in the shell (`drizzle.config.ts`), same precedence as the CLI.
   Verified with the variable unset and the address only in `.env`: push
   ran without prompts and replaced the index; the existing rows survived.

**Recovering a database in this state:** `push` (now works with `.env`),
then `ip-insight enrich --sources routeviews-rib-ipv4,routeviews-rib-ipv6`.
In the sandbox this restored 1,172,030 + 273,638 rows; `46.104.60.90`
went from `ASN: -` to `AS20978` (TT Mobil, matching ipinfo.io).
`pnpm test`: 174/174.
