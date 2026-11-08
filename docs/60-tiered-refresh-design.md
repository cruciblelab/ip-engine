# Tiered mmdb refresh — design and build status

> **⚠ Read `94-spgist-index-optimization.md` before building anything from
> this file (added 2026-08-09).** Every design decision below rests on the
> 4.7-hour full `ip_intel` rebuild being an immovable cost. It was not: it
> was a wrong index type. Swapping GiST for SP-GiST on the `inet` columns
> took the same full 3,168,971-row build from an extrapolated ~5.3 hours to
> a **measured 5 minutes 9 seconds**, with byte-identical output. A rebuild
> that finishes in minutes can just run at whatever cadence is wanted —
> which removes the reason most of this design exists. Nothing here is
> deleted yet, because the decisive number (a real `flatten --mode
> materialized` on the actual deployment, post-fix) has not been taken. Take
> that measurement first; then decide how much of the plan below survives.

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Planned: tiered refresh architecture on the VDS, and SaaS stays mmdb-only (2026-08-06, not built yet)](#planned-tiered-refresh-architecture-on-the-vds-and-saas-stays-mmdb-only-2026-08-06-not-built-yet)
- [Tiered mmdb refresh — design decided, not yet built (2026-08-06)](#tiered-mmdb-refresh-design-decided-not-yet-built-2026-08-06)
- [The consolidated plan for tiered refresh — what gets built, in what order, and what blocks what (2026-08-06)](#the-consolidated-plan-for-tiered-refresh-what-gets-built-in-what-order-and-what-blocks-what-2026-08-06)

---

### Planned: tiered refresh architecture on the VDS, and SaaS stays mmdb-only (2026-08-06, not built yet)

Two related architecture decisions from the founder, worth recording now so
neither gets rediscovered or contradicted later by a design that forgot
them.

**Correction to a mistake made earlier this same session:** the phone is
the *testing and data-collection* environment right now, not a preview of
what the production server will be. Reasoning about the eventual SaaS's
reliability by pointing at the phone's current uptime/Postgres-crash
pattern is reasoning about the wrong machine — the real architecture gets
decided once the VDS exists, not before.

**Decision: `ipreadout-service` (the SaaS) stays mmdb-only — it does not
call IP-Insight-Engine's own API live.** Raised directly: since the SaaS
was designed to read only a hot-reloaded `.mmdb` file (see its own
`PLAN.md` and the reasoning in `internal/lookup/reader.go`'s design), what
happens to everything built today (`route_anomaly`, and the planned
`identity_signal`) that currently only exists as a live Postgres query in
`packages/lookup`? The tempting fix — have the SaaS call IP-Insight-
Engine's own API live for these newer fields — was considered and
rejected: it would make every paying customer's request depend on a
second live service being up and fast, undoing the exact separation the
mmdb design exists for in the first place (heavy/fragile collection stays
decoupled from the fast/reliable customer-facing path). Decision instead:
**keep baking new signals into the `.mmdb` export**, the same way
`stable_since` already is — `route_anomaly` and future per-ASN signals
like `identity_signal` become export-time-computed fields, not live
API calls. The SaaS's guarantee stays "reads one local file," full stop.

**Planned refresh cadence, once the VDS exists (not built yet, no code
written for this) — two tiers, not one:**
1. **Full rebuild, daily, at a fixed scheduled time** (a specific
   reference timezone/hour still to be decided — the founder's own
   phrasing was "European or American time, or a global time, 03:00" as a
   placeholder, not a final choice). Automated, cron-driven once cron
   exists on the VDS (see the no-cron-on-the-phone note above — this is
   exactly the kind of fixed, no-longer-changing schedule that note says
   to wait for). On failure, fall back to serving the previous known-good
   build rather than a partial/broken one — same principle already
   established for the staging-deploy flow above ("never let an update
   reach the real, customer-facing instance without a check in between").
2. **A faster, narrower refresh for specifically fast-changing fields**
   (RPKI validity, `route_anomaly`'s BGP-derived state — not the slow bulk
   data like RIR allocations or ASN names, which don't meaningfully change
   hour to hour). Proposed cadence: hourly. Two implementation shapes
   floated, **neither decided yet, both need their own real design pass**:
   - **A second, smaller "overlay" `.mmdb`** holding only the fast-changing
     fields, rebuilt hourly and cheap to rebuild *because* it's small; the
     reader checks both files and merges at lookup time. More read-side
     complexity (two files, a merge step), but the hourly rebuild only
     pays for what actually changes that often.
   - **Patching the single existing `.mmdb`** more frequently instead of a
     second file. Simpler read side (still one file), but means either a
     full rebuild hourly (wasteful — most fields didn't change) or an
     in-place patch mechanism this project has no precedent for yet (the
     current `mmdb-export.ts`/`mmdb-publish.ts` pipeline is a clean
     rebuild-and-atomic-swap, not a partial patch).

Neither the exact daily time nor the overlay-vs-patch choice is decided —
both are real open design questions for whoever picks up VDS deployment
work, not settled here. Recorded so the next session starts from "here are
the two shapes considered and their tradeoffs," not from zero.

**Real measurement from the founder's own deployment (2026-08-06):
`flatten --mode materialized` alone takes ~4.7 hours.** Recorded because
every design decision about refresh cadence depends on it, and because it
is a real number from the real target hardware — not this sandbox, whose
database is far smaller and whose timings mean nothing for this question.
It reframes the problem: the bottleneck is not the 53 sequential
enrichment sources (parallelising those was considered and set aside for
this reason), it is that `export-mmdb` refuses a non-materialized
`ip_intel` and so *every* published .mmdb currently costs that 4.7 hours,
no matter how little actually changed. Two further timings still need
measuring on the same real deployment before any cadence is committed:
how long `export-mmdb` itself takes, and how long a hypothetical smaller
fast-tier relation would take to refresh.

### Tiered mmdb refresh — design decided, not yet built (2026-08-06)

Full design doc lives outside the repo (`scratchpad/design-docs/tiered-refresh-design.md`);
this is the decision and the two real bugs the design work turned up.

**Decision: a separate, smaller `ip_intel_fast` materialized view** holding
only the fast-changing fields, refreshed independently of the 4.7-hour full
`ip_intel` build, LEFT JOINed at export time. Built in stages. The
"overlay .mmdb" alternative stays a documented fallback, contingent on one
unmeasured number (below).

Three alternatives considered and why they lost:
- **Overlay .mmdb (second file, merged at read time)** — would put the
  field-precedence rule ("these keys win, unless the overlay is older")
  into Go, in the `ipreadout-service` repo, with nothing checking it
  against the SQL. That is the second implementation of the merge rules
  that building the .mmdb from `ip_intel` exists to forbid
  (`mmdb-export.ts:14-17`), and its drift symptom is a silently wrong
  answer, not a crash.
- **Export reads fast fields straight from raw tables** — rejected on
  correctness, not cost. Row selection would still come from a stale
  `ip_intel`, so a prefix announced *since* the last materialize has no row
  at all and stays invisible no matter how fresh the RPKI data is — and
  worse, resolves confidently against its enclosing prefix's legitimate
  origin. That is precisely the case the fast tier exists to catch.
- **Incremental materialize ("only recompute what changed")** — the
  biggest theoretical win (4.7h → minutes) and the one that was most
  tempting. Rejected for now on three grounds. (1) Its failure mode is
  inverted against this project's whole posture: the others fail loudly
  and boundedly, while a missed dependency here leaves a field populated,
  plausible, and frozen forever with every existing health check green.
  (2) It needs diff-based ingestion first — today every source is
  delete-then-rewrite (`enrichment.ts` ~941/1023 for BGP, and ~20 similar
  sites), so "what actually changed" is destroyed at ingest. That
  prerequisite is larger than the entire chosen design, and
  `history.ts`'s existing diff machinery is **not** reusable for it: that
  diffs `ip_intel` and refuses to run unless it is already materialized
  (`history.ts:185-190`), which is circular when the goal is to avoid
  materializing. (3) `pg_ivm` is separately disqualified — a non-core
  extension on Termux today and an unbuilt VDS later, against a view shape
  (13 LATERALs, CTE + window function) close to worst case for incremental
  view maintenance, with write amplification pointing the wrong way against
  million-row wholesale rewrites.
  Two ideas were kept out of it: a `contentHash` check to skip a rebuild
  entirely when nothing changed, and materialising `announced_prefix`.

**Key derived result to verify before building anything:** every fast
field is a property of the *announced prefix* rather than the base row, so
the fast tier needs only `bgp_origin_ranges` as its base — not the
nine-table UNION the full view uses. The design doc carries the sampled
equivalence query that must prove this first.

**The number that decides whether this works at all, still unmeasured:**
how long `export-mmdb` itself takes on the real deployment. If it exceeds
the target cadence, no amount of fast-tier work reaches hourly and the
overlay fallback comes back into play.

**Two real, pre-existing bugs found while designing this, both verified
independently against the code (tracked as follow-up work, not fixed
here):**
1. `enrich --sources <ids>` still ends in an unconditional
   `ensureIpIntel()` (`enrichment.ts` ~478-520), so refreshing one small
   source still pays the full 4.7-hour materialize. Selective enrichment
   is therefore *not* usable for a fast tier today, contrary to how it
   reads from the CLI help. Needs a flag to skip the trailing refresh.
2. `exportMmdb()` issues 129 separate `db.execute()` calls, one per prefix
   length (`mmdb-export.ts` ~176-186), each in its own implicit
   transaction and therefore its own snapshot. A refresh committing
   partway through produces a file that is pre-refresh for some prefix
   lengths and post-refresh for others — a torn export. Fix is to wrap the
   whole export in one `REPEATABLE READ` transaction. Worth noting this is
   the concurrency risk the founder anticipated when asking about a
   coordinating worker; it turned out to be real, just located in the
   export rather than the publish step (the publish symlink swap was
   already atomic).

### The consolidated plan for tiered refresh — what gets built, in what order, and what blocks what (2026-08-06)

The sections above record how the decision was reached. This one is the
plan itself, in order, so nobody has to reconstruct it from the argument.

**Chosen shape: Option C, with the salvageable parts of the rejected
options folded in rather than discarded.** What came from where:
- From **D** (incremental materialize, rejected): the `contentHash` check —
  skip a rebuild outright when a source's content did not change. Cheap,
  independent of everything else, and potentially the largest practical win
  of the whole plan, since a run where nothing changed costs nothing. Also
  from D: materialising `announced_prefix`, now a prerequisite for two
  other directions.
- From **A** (overlay .mmdb, rejected as primary): per-field-group
  freshness metadata. A *forced* that question (two files obviously need
  two timestamps); C does not force it, but it is just as valuable there
  and is the foundation of the eventual "what was refreshed when" status
  page. Also from A: it stays the documented fallback if Stage 0's export
  timing kills the single-file approach.
- From **B** (export reads raw tables, rejected on correctness): nothing
  directly — but note C already contains B's *good* idea (don't rebuild
  the nine-table view to refresh a handful of fast fields) without B's
  fatal one (driving row selection from a stale relation).
- Also reusable even though D was rejected: the dependency map enumerated
  for D's sake is the check that C's fast/slow column split is complete
  ("did we forget to put a column in the fast tier").

**Order of work, with the blocking relationships stated explicitly:**

*Prerequisites — neither is optional, and neither depends on the design
being right:*
1. **`enrich --sources` must stop triggering a full materialize.** Today
   the trailing `ensureIpIntel()` (`enrichment.ts` ~478-520) runs
   unconditionally, so refreshing one small source still costs 4.7 hours.
   **This blocks every later stage** — a fast tier is meaningless while
   touching any source costs a full rebuild.
2. **`export-mmdb` must stop being able to produce a torn file.** 129
   separate snapshots, one per prefix length (`mmdb-export.ts` ~176-186).
   This is *more* important under the chosen design, not less: two
   relations refreshing on independent cadences means more opportunity for
   an export to overlap one of them, not less.

*Then the staged build:*
- **Stage 0 — measure, build nothing.** Four cheap numbers on the *real*
  deployment (not this sandbox, whose sizes mean nothing here): how long
  `export-mmdb` alone takes; `bgp_origin_ranges` churn over 1h/6h/24h; the
  row-set equivalence check that proves the fast tier really can be based
  on `bgp_origin_ranges` alone; and the per-source `contentHash` change
  rate. Every one of them can change the design if it comes back wrong —
  particularly the export timing, which decides whether the single-file
  approach can hit any useful cadence at all. **Nothing after this starts
  until these land.**
- **Stage 1 — `ip_intel_fast` exists and is provably right, changing
  nothing else.** New view module, new CLI verb to refresh it, freshness
  recorded. The published file is untouched. Verified by a SQL equivalence
  check against `ip_intel` — hand-runnable at any hour, which matters
  given there is deliberately no cron on the phone. If the whole idea
  turns out wrong, the rollback is one `DROP MATERIALIZED VIEW`.
- **Stage 2 — `announced_prefix` on `ip_intel`.** Follows the existing
  "adding a column to ip_intel" playbook in this file. Costs one full
  rebuild — which is a free re-measurement of the 4.7-hour figure, so time
  it while it runs.
- **Stage 3 — the real change: export unions both row sets** and takes the
  fast fields from the fast tier. Gated behind a config flag in the same
  style as `mmdbHistoryFields`, so it can be toggled between hand-runs
  without a code change, and so the first file built with it on can be
  compared field-count-for-field-count against the last one built with it
  off, using the per-field check `validate()` already performs.
- **Stage 4 — pick a cadence, on the VDS, from Stage 0's numbers.** Not
  before, and not guessed. The founder's reasoning for wanting this
  tighter than daily stands on its own and is worth restating: malicious
  routing events do not conveniently last a full day, so a once-daily view
  of RPKI/BGP state has a real blind spot — but *how* much tighter is a
  measurement question, not an intuition one.
- **Stage 5 — the overlay file, only if Stage 0 says the single-file path
  cannot reach a useful cadence.**

**Two things this plan deliberately does not do**, recorded so they are
not re-proposed as oversights: it does not parallelise the 53 sequential
enrichment sources (real, but irrelevant next to a 4.7-hour materialize —
wrong bottleneck), and it does not build a coordinating worker for
mmdb writes (the publish-side swap is already atomic via `repointCurrent`,
and advisory locks already prevent overlapping cycles; the one genuine
concurrency hole was the torn export, which prerequisite 2 fixes directly).
