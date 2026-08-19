# The GiST → SP-GiST index fix (2026-08-09)

The single largest performance finding in this project's history, and the
one that reframes the entire tiered-refresh plan in
`60-tiered-refresh-design.md`. Found by questioning a premise everything
else had been built around: **that the 4.7-hour `ip_intel` materialize was
an inherent cost to be worked around, rather than a bug to be fixed.**

**This idea was not new — it was already on the list, and mis-sized.**
`70-session-status-snapshots.md` records it as audit item **#7,
"GiST→trie rewrite for the ~4.7h materialized rebuild — held, pending real
timing … the single largest-effort, highest-risk item in the audit's
list."** That sizing was wrong in both directions, which is why it sat
unstarted: it is not a rewrite and it is not high-risk. The `IP_INTEL_SELECT`
query is untouched. The entire change is the index method on 15 columns —
minutes of work, seconds of index build, and output verified byte-identical.
What was actually missing was the measurement, not the idea. Worth
remembering next time something gets deferred as "large and risky" without
anyone having measured it: the estimate itself was the blocker.

**What this does *not* speed up:** downloading and ingesting the upstream
sources. `collect` and most of `enrich` are network- and parser-bound and
are unaffected. The gain is concentrated in `ip_intel`'s build, plus
whatever containment-join work the derived enrichment sources do
(`asn-profile`, `neighborhood-stats`, `asn-reach` — `enrichment.ts` carries
13 containment operators between them).

## What was wrong

Every range table (`ip_blocks`, `bgp_origin_ranges`, `geofeed_ranges`, …)
carried a **GiST** index on its `inet` column, using the `inet_ops`
operator class. `ip_intel`'s build probes those indexes with
`x.network >>= b.network` (containment) once per base row per table —
~13 probes × 3.17M base rows ≈ 41 million probes.

GiST's `inet_ops` discriminates poorly on prefix containment. Measured
directly with `EXPLAIN (ANALYZE, BUFFERS)` against real data:

```
Bitmap Index Scan on ip_blocks_network_gist
  (actual time=0.834..0.834 rows=1 loops=1000)
  Buffers: shared hit=171569
```

**172 buffer reads to return one row.** The index was descending most of
its own tree on every probe, because a GiST bounding-box over `inet`
values barely narrows a containment search.

## The fix

Replace GiST with **SP-GiST** — a space-partitioned radix trie that splits
on address bits, which is precisely the question `>>=` asks. Same
`inet_ops` name, same operator support (`<<`, `<<=`, `>>`, `>>=`, `&&`,
equality and ordering), so it is a drop-in replacement rather than a
trade-off.

```
Bitmap Index Scan on ip_blocks_network_spgist
  (actual time=0.007..0.007 rows=1 loops=1000)
  Buffers: shared hit=6000
```

## Measured, on this project's real data (sandbox, 2026-08-09)

Sandbox held 654,878 `ip_blocks`, 1,504,886 `bgp_origin_ranges`,
1,194,701 `geofeed_ranges` — roughly half the phone's scale, real rows
throughout, not synthetic.

**Per containment probe (`ip_blocks`):**

| | GiST | SP-GiST | ratio |
|---|---|---|---|
| time | 0.834 ms | 0.007 ms | **119×** |
| index buffer reads | 171,569 / 1k probes | 6,000 / 1k probes | **29×** |

**Full `ip_intel` SELECT, per base row** (13 LATERALs, JIT's fixed ~1.4 s
startup excluded since it does not scale with row count):

| | GiST | SP-GiST | ratio |
|---|---|---|---|
| per row | 6.07 ms | 0.071 ms | **~85×** |

The three heaviest LATERALs were all inet containment probes and together
made up 67% of the GiST-era per-row cost (`bgp_origin_ranges` 2.951 ms,
`geofeed_ranges` 1.352 ms, `ip_blocks` 0.886 ms). After the change all
three sit at 0.001–0.013 ms.

**Correctness verified, not assumed.** The same 200,000-row workload was
run both ways and the full result set hashed
(`md5(string_agg(rir||city ORDER BY network))`): identical —
`4740be5ef9cc57a829b839601e603a34` under both indexes. Faster and
byte-for-byte the same answer.

**Index creation cost:** seconds. All 8 remaining range tables took 3.4 s
combined; `ip_blocks` alone 1.97 s; `ip_intel` itself (3.17M rows) 11.4 s.

### The end-to-end number, actually run rather than extrapolated

`flatten --mode materialized` over the full 3,168,971-row relation, with
SP-GiST on the source tables — the real code path, real data, including
writing every row to disk and building all four of the matview's indexes:

**5 minutes 9 seconds.**

Against the GiST-era per-row cost measured above (6.07 ms × 3.17M), the
same build is **~5.3 hours**. Roughly **60×**, end to end.

Output verified correct, not just fast: 3,168,971 rows, `country`
populated on 2,842,863, `asn`/`rpki_status` on 2,661,652, `city` on
1,400,516, `wider_prefix_asn` on 369,316 (consistent with the ~370k the
drift fix produced on the phone). Spot-checked against a known real
answer — `1.1.1.0/24 → AU, AS13335 CLOUDFLARENET, rpki valid`.

### Customer-facing lookups got faster too

`ip_intel`'s own `network` index governs the live Postgres lookup path
(`WHERE network >>= '8.8.8.8' ORDER BY masklen(network) DESC LIMIT 1`) —
what `@workspace/lookup` and the SaaS's non-mmdb fallback tier hit:

| | GiST | SP-GiST | ratio |
|---|---|---|---|
| lookup | 5.605 ms | 0.438 ms | **12.8×** |
| buffer reads | 248 | 17 | **14.6×** |

## Two things that were tried and did *not* work — recorded so they are not retried

1. **Fixing the row-count estimate.** The base subquery's `SELECT DISTINCT`
   over a 9-table `UNION ALL` is estimated by Postgres at **200 rows**
   against a real **3,168,971** — a 15,845× underestimate, and an obvious
   suspect. Materialising the base into a real, `ANALYZE`d table so the
   planner knew the true count changed the estimated cost from 4.9 million
   to 352 billion — and changed the chosen plan not at all. `LATERAL` with
   a correlated `ORDER BY … LIMIT 1` forces nested-loop execution
   regardless of what the planner knows. The bad estimate is real but was
   never the cause.
2. **Rewriting the LATERALs as `DISTINCT ON` set-based joins.** The theory
   was that one large sort would beat 3.17M small ones. Measured on
   200,000 rows: **3m02.5s vs 3m02.7s** — indistinguishable. `>>=` cannot
   hash- or merge-join, so both shapes do the same index probes; the sort
   was never the cost.

Both were plausible and both were wrong. The cost was in the index itself
the whole time, which is why measuring beat reasoning here.

## Is there anything left to squeeze out of the materialize? Measured: essentially no.

Asked directly after the fix landed. Three hypotheses, all measured on the
full 3,168,971-row relation, all on the same box:

| path | time |
|---|---|
| full rebuild (staging build + atomic rename), starting from a plain view | 5m09s |
| full rebuild, starting from an existing materialized view | **5m46s** |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY` | **6m15s** |
| the 3 derived enrichment sources (`asn-reach`, `neighborhood-stats`, `asn-profile`) | ~50s |

`REFRESH … CONCURRENTLY` really is the slower of the two refresh paths now
that the underlying build is fast — but by **29 seconds (8%)**, not the
large margin the first (unfair, different starting state) comparison
suggested. That does not justify swapping a proven code path: `CONCURRENTLY`
preserves the relation's identity, grants, and OID, where staging+rename
drops and recreates. **Left as is.** Revisit only if the gap widens.

Peak disk is ~2× the relation either way — `CONCURRENTLY` materialises a new
copy plus a diff, staging+rename holds old and new simultaneously. Neither
is the cheap option; size the VDS for 2× regardless.

**Running score for this session's optimization hypotheses:** row-estimate
fix 0%, `DISTINCT ON` rewrite 0%, refresh-strategy swap 8%, index type
~6000%. The one that mattered was the one that had been sitting unmeasured
behind a "large-effort, high-risk" label. That is the lesson worth keeping,
not any of the individual results.

### The one real lever left on the materialize: it runs on a single core

Checked directly by watching `pg_stat_activity` during a live refresh —
every backend was `client backend`, **not one `parallel worker`**. On the
4-core VDS, three cores sit idle for the whole 6 minutes.

Why, and whether it can be fixed — measured, not assumed:

- `CREATE MATERIALIZED VIEW … AS` and `CREATE TABLE … AS` both *do* plan
  parallel workers (verified: `Workers Planned: 4` on a test query). The
  write itself is not the blocker.
- The real `IP_INTEL_SELECT` plans exactly **one** `Gather`, and it sits in
  the base `SELECT DISTINCT … UNION ALL` — a small fraction of the work.
  Everything above it, including all 13 LATERALs across 3.17M rows, runs
  serially: once the plan gathers to compute the DISTINCT, it is back to a
  single process.
- It *can* be parallelised. With the base materialised into a real table
  first and the planner nudged (`parallel_setup_cost=0`,
  `min_parallel_table_scan_size=0`), the same query plans a
  `Parallel Seq Scan on _base_test` with 4 workers feeding the LATERALs.

So the ceiling is roughly **6 min → ~2 min** on 4 cores. **Deliberately not
built.** It needs `rebuildIpIntel()` restructured around an extra staging
table, with its own disk cost and failure mode, to save ~4 minutes on a job
that runs once a day — while `collect` and `enrich` remain entirely
unmeasured beside it. Recorded here so it is a known, verified lever rather
than a rediscovery, and so the next person does not have to re-derive that
it is possible. Revisit if the refresh ever needs to be hourly, or after
the collect/enrich numbers land and this turns out to be the largest
remaining piece after all.

## Confirmed on the real phone, not just the sandbox (2026-08-19)

First full `cycle` run on the phone after a from-scratch Termux reinstall
(SP-GiST indexes present from the fresh `push`, per `40-operations-and-
incidents.md`), 3,199,286 rows — real production scale, not the sandbox's
slightly smaller 3,168,971. Computed from the log's own timestamps
(`ip_intel refresh still running` heartbeats, 30s apart, plus the
completion line):

- `ip_intel` refresh (`REFRESH MATERIALIZED VIEW CONCURRENTLY` — this ran
  from an already-current stamp, not a forced full rebuild): **8m9s
  (489s)**.
- Everything else in `enrich` (~50 downloaded sources + 3 derived SQL
  sources): 2433s − 489s = **32m24s**.
- `collect`: **85s**.
- Full `cycle`: **2518s (41m58s)** — matches 85+1944+489 exactly.

Phone runs ~30% slower than the sandbox's 6m15s `REFRESH CONCURRENTLY`
figure (weaker CPU/storage, expected) — still **~40× faster than the
5-6 hour pre-fix baseline**, on the real target-shaped hardware, not an
extrapolation.

**This measurement predates a real Postgres tuning fix, not yet
re-measured**: the phone's log showed `checkpoints are occurring too
frequently (14 seconds apart)` throughout — `max_wal_size` still at its
1GB default against a workload that dirties ~540MB per checkpoint cycle,
forcing constant fsync churn during exactly the heavy-write phases
measured above. Set to 4GB and restarted (2026-08-19).

**The phone's own before/after comparison was too confounded to trust**:
the second `cycle` run (789s materialize, worse than the first) also
ingested 2.75× more rows and finished `completed_with_errors` — a source
exhausted its retries. Too many variables changed at once to credit or
blame `max_wal_size` from that pair alone.

**So it was isolated properly, in the sandbox, same box/data, one
variable**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` on the full
3.17M-row relation, back to back, only `max_wal_size` changed between
runs.

| `max_wal_size` | time |
|---|---|
| 1GB (default) | 4m53s |
| 4GB | **3m45s** |

**~23% faster, real and isolated.** The setting is worth keeping. It just
wasn't the explanation for the phone's second run looking worse — that
was the extra load and the failed source.

## What a daily refresh actually costs now

All measured on one box at production scale — the sandbox's `ip_intel` holds
3,168,971 rows against the phone's 3,203,416, so these are not scaled-down
numbers. Hardware differs from the eventual 16GB/4-core VDS; the *shape*
transfers, the absolute seconds should be re-taken there.

| step | before (GiST) | now (SP-GiST) |
|---|---|---|
| `collect` — RIR files, download + ingest | **not measured** | unchanged (network-bound) |
| `enrich` — ~50 downloaded sources | **not measured** | unchanged (network-bound) |
| `enrich` — 3 derived SQL sources | — | **~50 s** |
| `ip_intel` refresh | **~5-6 h** | **6 m 15 s** |
| `export-mmdb` | — | **1 m 16 s** (62.3 MB, 2,846,513 prefixes) |
| `mmdb publish` (validate + symlink swap) | — | seconds |
| **database + export subtotal** | **~5-6 hours** | **~8.5 minutes** |

The two blanks are the honest gap, and they are now the *only* thing
standing between this table and a full daily-cost figure. `cycle` prints
per-step timings, so the next real run fills them in at no extra cost.

**None of this is on the customer request path.** The served artifact is the
`.mmdb` file (measured separately at ~37k req/s per core, see
`91-benchmarks-and-saas-economics.md`); the refresh pipeline runs beside it
and swaps the file atomically via `repointCurrent`. "Daily cost" here means
how long the machine is busy rebuilding, not customer-visible downtime —
there is none.

**Resource cost during the refresh, worth sizing for:**
- Peak disk ≈ 2× the `ip_intel` relation, whichever refresh path is used.
- `export-mmdb` still needs `--max-old-space-size=4096` — `mmdb-writer.ts`
  holds the full entry set in memory before serialising. Known, unfixed at
  the architecture level, and the clearest remaining "less resource" item.
- Output file: 62.3 MB.

## Where the remaining time actually goes — and the one justification that just died

With the materialize at ~6 minutes, `60-tiered-refresh-design.md`'s closing
note needs revisiting. It records, as a deliberate non-goal:

> it does not parallelise the 53 sequential enrichment sources (real, but
> irrelevant next to a 4.7-hour materialize — **wrong bottleneck**)

That reasoning was sound when the materialize was 4.7 hours. It is no longer
sound. Fifty-three sequentially-fetched upstream sources against a ~6-minute
materialize makes the downloads the likely dominant cost of a full `cycle` —
i.e. the *right* bottleneck now, and the most promising remaining work.

Deliberately not started on that basis alone: there is still no trustworthy
standalone timing for `collect` and `enrich` on real hardware, and this
session has now produced three measured hypotheses that returned nothing.
`cycle` reports per-step timings; the next full run on the phone produces
that breakdown for free. **Take that measurement, then decide.**

## What this means for the tiered-refresh plan

`60-tiered-refresh-design.md` designs a two-tier architecture
(`ip_intel_fast` + the full view, independent cadences, export unioning
both) whose entire justification is the 4.7-hour full rebuild. If that
number collapses by an order of magnitude, **most of that plan may no
longer be worth building** — a full rebuild that finishes in minutes can
simply run at whatever cadence is wanted, with no fast tier, no freshness
metadata per field group, no export-side union, and none of the
correctness risk that comes with them.

Do not delete that design yet. Re-measure `flatten --mode materialized` on
the real deployment with SP-GiST in place first, then decide. The
measurement is the input to that decision, exactly as Stage 0 always
intended — this just changes what the number is likely to be.

## What changed in the code

All 15 `inet` GiST indexes across `packages/db/src/schema/*.ts` became
SP-GiST, renamed `*_gist` → `*_spgist`. `packages/db/src/views/ip-intel.ts`
builds the materialized view's own `network` index as SP-GiST too — that
one governs customer-facing lookup latency (`WHERE network >>= '1.1.1.1'`),
not the build.

## Deploying this to an existing database

Two separate things, because they live in different places:

1. **Source tables** — `pnpm --filter @workspace/db push` drops the GiST
   indexes and creates SP-GiST ones. This is what makes the *build* fast.
2. **`ip_intel` itself** — its index was created by `rebuildIpIntel()`, not
   by the schema, so `push` does not touch it. Either rebuild, or just
   swap the index in place (far cheaper, no rebuild needed):

   ```sql
   CREATE INDEX ip_intel_network_spgist ON ip_intel USING spgist (network inet_ops);
   DROP INDEX ip_intel_network_gist;
   ```

Note the `IP_INTEL_SELECT_HASH` drift check (see
`92-ip-intel-definition-drift-bug.md`) will *not* fire for this change, and
correctly so: the SELECT text is untouched, the rows are identical, only
the index method changed. Nothing needs rebuilding for correctness.
