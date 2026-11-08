# 100 — COPY-based bulk ingest (`bulkCopyIngest`)

Built 2026-08-24, in response to a real complaint: with `dbipLiteIpv6` on,
the `dbip-lite` source on the real (Termux/Android) deployment ran long
enough that the operator sat watching it for two hours and stopped it
unfinished.

The obvious reading of that was "we need to parallelise this". The
measurements said something else, and this document exists mainly to record
what they said — including the four optimisations that turned out to be
worthless or actively harmful, which is the part worth having written down.

## Headline

The whole `ip-insight enrich --sources dbip-lite` command, run down each
path against the real 87 MB DB-IP file with `dbipLiteIpv6` on — download,
gzip decode, CSV parse, range→CIDR splitting, write, geofeed prune:

| | wall clock | table + indexes | rows |
|---|---|---|---|
| Before | **960.2s** (16m 0s) | 2,823 MB | 14,727,355 |
| After | **254.6s** (4m 15s) | 2,487 MB | 14,727,355 |
| | **3.8x faster** | | *identical md5* |

Isolated to the write path alone, on the same 14.7M rows, it is 400.2s →
167.2s (2.4x) and 4,867 MB → 2,490 MB. The end-to-end gain is larger than
the write-path gain because the old path's `DELETE` cost and its bloat are
both charged to the surrounding run.

The size column matters as much as the time one, and is the less obvious
finding — see "The bloat was the hidden half" below. Note also that the
2,823 MB figure is a *single* cycle; the old path grows it further on each
subsequent run, which is how the real deployment reached 2,512 MB holding
rows that need about 1,000 MB.

## Where the time actually went

Attribution sweep over 3,000,000 real rows, each row adding exactly one
change to the row above it, so every line is "what did this one thing buy".

| | time | vs. before | change |
|---|---|---|---|
| V0 | 75.1s | — | the path that was in production |
| V1 | 52.4s | 1.4x | `TRUNCATE` instead of an unqualified `DELETE` |
| V2 | 35.5s | 2.1x | progress `UPDATE` throttled to once per 2s |
| V3 | 36.1s | 2.1x | SP-GiST index built *after* the load |
| V4u | 23.1s | 3.3x | `unnest()` arrays instead of 12,000-parameter `INSERT` |
| V4c | 14.3s | 5.2x | `COPY … FROM STDIN` instead of `INSERT` |
| V5 | 15.1s | 5.0x | drop the unused `id` PK and `ingested_at` columns |
| V6 | 15.2s | 4.9x | `synchronous_commit = off` for the load |
| V7 | 19.1s | 3.9x | `maintenance_work_mem = 256MB` for the index build |

Three things in that table are worth more than the speedup itself.

**Three of the seven proposed changes were rejected by their own
measurement.** V6 does nothing (COPY already amortises commits, so there are
no per-row commits left to relax). V7 is **26% slower**, not faster. V3 — the
one predicted to be the single biggest win, on the reasoning that maintaining
an index row-by-row must cost more than building it once — is a wash at 3M,
and was re-measured at the full 14.7M in case it only pays off once the index
stops fitting in `shared_buffers`. It does not: 189.9s with the index rebuilt
after, against 162.1s with it live. It is slower at both sizes.

**The progress counter cost more than the index.** 1,500 extra `UPDATE`
round-trips per 3M rows — one per batch, purely so the CLI could print a
moving number — cost 17 seconds, about a third of the whole load. Throttling
it to once every two seconds changes nothing an operator can perceive.

**`unnest()` gets most of the way there without a new dependency.** Worth
recording because it was the fallback if `pg-copy-streams` had been
unacceptable: 3.3x against COPY's 5.2x. COPY won and the dependency was
taken, but the cheaper option exists and is a two-line change.

## The bloat was the hidden half

The old path began with `DELETE FROM dbip_lite_ranges` — no `WHERE`, 14.7M
rows. That writes a WAL record per row and leaves every one of them behind as
a dead tuple. In steady state the table settles at roughly twice the size of
the data it holds. Measured on the real deployment's database: **2,512 MB
allocated to hold 14.7M rows that need about 1,000 MB**, with
`n_live_tup = 0` and no vacuum ever recorded.

That is not just wasted disk on a phone. `ip_intel`'s base `UNION`
sequentially scans this heap, so the bloat was being paid *again* on every
`flatten` — which is the same `ip_intel` refresh that ran for 66 minutes
without finishing on the real deployment and started this whole thread.
`TRUNCATE` reclaims the space instead of accumulating it, and is O(1) rather
than O(rows).

## What is shipped, and what is not

Shipped: `TRUNCATE`, `COPY … FROM STDIN` (CSV format), and the throttled
progress row. That is the 400.2s → 167.2s result above.

**Not shipped: dropping the unused `id serial PRIMARY KEY` and `ingested_at`
columns.** Neither is read by any query in the codebase (`grep` confirms:
`dbipLiteRangesTable.id` and `.ingestedAt` appear nowhere outside the schema
definition), and the `id` btree alone is 315 MB. But V5 shows it buys **no
time at all** — it is a storage change, not a speed one — and every sibling
range table (`geofeed_ranges`, `bgp_origin_ranges`, …) carries the same two
columns, so removing them from just this one trades a convention for 491 MB.
It also needs a `drizzle-kit push` on the deployment, which is a manual step
with its own failure mode. Recorded here as a deliberate, measured decision
rather than an oversight; the numbers to revisit it with are V5's.

**Not shipped: parallelism.** The request that started this was for a
parallel system. Collection already is parallel — all five RIRs download and
ingest concurrently (`collector.ts`'s `Promise.allSettled`). Enrichment is
not: `enrichment.ts`'s `runJob` walks its ~60 sources strictly sequentially,
and that is a genuine, separate opportunity — but it is a dependency-ordering
problem, not a `Promise.all`, because at least three orderings are load-
bearing (`geonames-cities` before `lacnic-whois-city`; `asn-reach` /
`neighborhood-stats` / `asn-profile` last, since they aggregate over tables
the earlier sources fill; and `dbip-lite`'s geofeed prune wants the geofeed
sources to have run). Left for its own change. It would not have helped here
in any case: one source writing 14.7M rows to one flash device is not a
concurrency problem.

## CSV, not COPY's text format

`COPY … WITH (FORMAT text)` assigns meaning to backslashes, so every field
needs `\` `\n` `\r` `\t` escaped and a miss corrupts data *silently* — the
row still loads, with the wrong values in the wrong columns. CSV format has
exactly one metacharacter: every value is emitted quoted, an embedded quote
is doubled, and NULL is the only unquoted form (which is why it can never
collide with a real empty string). One rule, no edge cases.

The real DB-IP file contains city names with commas ("Washington, D.C."),
quotes, and non-ASCII throughout, so this is not hypothetical.

## Failure behaviour changed, deliberately

The old path caught a rejected `INSERT` batch, counted its 2,000 rows as
`recordsSkipped`, and kept going. A COPY is all-or-nothing: one bad value
fails the whole load.

That is the right trade *here* specifically because every value in this
stream is generated by this codebase — the CIDRs come from `rangeToCidrs` /
`rangeToCidrs6`, the coordinates are already `Number.isFinite`-filtered — so
a rejection means a bug in that generation, not bad upstream data. Silently
dropping 2,000 rows in response to a bug is worse than failing loudly.
`runSourceWithRetry` still retries the whole source three times, and the
table it leaves behind is empty either way, exactly as a mid-run crash on the
old path also left it.

## How it was verified

1. **Unit tests** (`bulk-load.test.ts`, 11 cases) pin the CSV encoding rules
   directly: quotes, commas, backslashes, embedded newlines and tabs,
   non-ASCII, non-finite numbers, and the empty-string/NULL distinction.
2. **Integration tests** (`bulk-load.integration.test.ts`, 7 cases) push
   those same nasty values through a real `COPY` into a real Postgres and
   read them back — including a check that the resulting table is
   **md5-identical to the same rows written by the `INSERT` path**, computed
   by Postgres over the whole row set rather than compared in TypeScript.
   Also covers pool-connection release on both `finish()` and `abort()`, and
   that a Postgres rejection surfaces as a thrown error rather than a hang.
3. **Equivalence over 14,727,156 real rows**, both sides calling real
   production code — the COPY writer on one, drizzle's
   `db.insert(dbipLiteRangesTable).values()` in `BATCH_SIZE` batches on the
   other — with Postgres computing an order-independent md5 over the entire
   resulting table on each side:

       INSERT path : 14727156 rows / md5 7eba0ba7910edbe380ca49eb17a2ba45
       COPY path   : 14727156 rows / md5 7eba0ba7910edbe380ca49eb17a2ba45
       RESULT: IDENTICAL

4. **The whole `ingestDbIpLiteCsv` function, end to end, down both paths**,
   driven by the real `ip-insight enrich --sources dbip-lite` against the
   real 87 MB DB-IP file — so `TRUNCATE`, the writer lifecycle, the throttled
   progress row and the geofeed prune are all exercised together rather than
   in isolation:

       COPY   path (254.6s): 14727355 rows / md5 3dd801a173bf851d61fa7aab1f7c80d0
       INSERT path (960.2s): 14727355 rows / md5 3dd801a173bf851d61fa7aab1f7c80d0
       => FULL-PIPELINE RESULT: IDENTICAL

   This run is also the proof that the escape hatch is real rather than
   asserted: the 960.2s side is `bulkCopyIngest: false` on the shipped code,
   taking the original path and producing the original result.
5. **Full-scale benchmark** against the real 14.7M-row dataset, which is
   where every number in this document comes from — not extrapolated from a
   small sample.

A first attempt at (4) drove the real upstream download twice and the 87 MB
transfer died mid-stream in the sandbox, leaving a 2.77M-row partial table
and a meaningless comparison. Rerun against a local copy of the same file,
with only the download URL redirected — everything downstream of it,
including the gzip decode and the range→CIDR splitting, is the real code.

### A real bug the tests found

`abort()` returned its pooled connection with a plain `release()` while the
COPY was still mid-protocol. pg says so out loud — *"Calling client.query()
when the client is already executing a query"* — and the abort test was the
only one of the seven that emitted it. Left alone, a failed ingest would hand
a connection in an indeterminate state back to the pool for the next caller
to use. Fixed by releasing with an error, which closes the connection instead
of reusing it.

Worth noting how it surfaced: not from a failing assertion, but from a
deprecation warning in output that was otherwise all green.

## Removing it

Set `"bulkCopyIngest": false` in `ip-insight.config.json` and the original
`DELETE` + batched-`INSERT` path runs byte for byte, with nothing in
`bulk-load.ts` executing at all. It also switches itself off automatically
when `DB_POOL_MAX` is 1, where holding one connection for the whole COPY
would deadlock against the progress updates on the shared pool.

Full removal instructions — all three levels, from the flag to deleting the
files — are in `packages/collector/src/enrichment/bulk-load.ts`'s header
comment, which is the file they describe removing.
