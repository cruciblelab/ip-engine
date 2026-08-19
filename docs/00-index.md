# Documentation index

`DEPLOY.md` grew into one 3,800-line file over this project's development —
useful as a append-only journal at the time, unusable as a reference once it
got this long. Split on 2026-08-07 into the files below, by category, so a
question like "what did we decide about tiered refresh" doesn't require
reading everything else first. Content was **relocated, not rewritten** —
each file's entries are verbatim from the original journal, oldest first.

`DEPLOY.md` itself is now a short pointer here, kept because `README.md`
links to it by name.

## Where things stand right now (2026-08-09, updated)

**Biggest open item: re-measure the full rebuild on the phone.** The GiST →
SP-GiST index fix (`94-spgist-index-optimization.md`) took the same
3,168,971-row `ip_intel` build from ~5.3 hours to a measured **5m09s** in
the sandbox, output verified identical. If that holds on the real
deployment, most of the tiered-refresh plan (`60-`, Tasks #57-59) stops
being worth building. Run `flatten --mode materialized` on the phone after
`push` and time it — that one number decides it.

## Earlier status (2026-08-07)

**In progress as of this note**: `flatten --refresh` was started on the
phone to fix the `ip_intel` definition-drift bug (see
`92-ip-intel-definition-drift-bug.md`) — expect ~6 hours. Check
`~/ip-engine/logs/ip-insight.log` (grep `"ip_intel refresh"`) for
completion, or just re-run `ip-insight lookup <ip>` and check
`wider_prefix_asn` is no longer always empty.

**Confirmed VDS target: 16GB RAM / 4 CPU** (~500 TL/mo). Every capacity/cost
number in `91-benchmarks-and-saas-economics.md` was measured against this
exact spec.

**Not started yet, in rough priority order:**

1. **Payment flow test run** (founder, not code) — a Paddle dry run before a
   real customer needs it live.
2. **Task #57 — Stage 0 measurements.** 2 of 4 done (`export-mmdb` timing:
   2m26s; row-set equivalence: passed after real investigation — see
   `60-tiered-refresh-design.md`). Still needed: `bgp_origin_ranges` churn
   over 1h/6h/24h, and per-source `contentHash` change rate (needs a second
   `enrich`/`cycle` run to compare against the first).
3. **`ipreadout-service` Milestone 1** — the actual SaaS core. Architecture
   decided and benchmarked (`bench-go/`), zero product code written yet.
4. Once real traffic exists: re-run `bench-go` *on the real VDS*, not this
   session's sandbox proxy, to replace every estimated number with a
   measured one.

## Files, in reading order for someone new to this project

| File | What's in it |
|---|---|
| `10-deploy-guide.md` | Sizing, first-time setup, and the "when you change X, also check Y" playbook. Start here to actually run this project. |
| `20-data-sources-and-licensing.md` | Every decision about *which* upstream data sources to use, why, and their licensing — RIPE, RDAP, PeeringDB, geofeeds, ASN classification, regional coverage. Largest file; this is where "why don't we just use X" gets answered. |
| `30-history-system.md` | The prefix-history/time-travel system: what it promises, its three real prerequisites, and how it was verified at full scale. |
| `40-operations-and-incidents.md` | Running this on modest/mobile hardware (Termux/Android), the no-cron-on-the-phone decision, and a full honest account of one real overnight incident. |
| `50-features-shipped.md` | What actually got built and shipped: `route_anomaly`, `classify-test`, the `asn_profile` API, and other completed work, each with its real verification numbers. |
| `60-tiered-refresh-design.md` | The tiered mmdb refresh design (Option C chosen), its Stage 0-5 rollout plan, and Stage 0's real measurements so far. |
| `70-session-status-snapshots.md` | Point-in-time "if you're picking this up cold, here's where things stood" notes from past sessions. Historical, not current — see this file's own top section for *current* status. |
| `80-misc-notes.md` | A handful of entries that didn't cleanly fit another category. |
| `90-delivery-and-packaging.md` | Real bugs found while packaging zips for the phone (the non-portable build, the pnpm bin-link gap, schema-drift-on-fresh-install). |
| `91-benchmarks-and-saas-economics.md` | Real `.mmdb` serving throughput (Node vs Go, nginx overhead, TLS+middleware cost) and what it means for SaaS pricing/capacity math. |
| `92-ip-intel-definition-drift-bug.md` | The most significant bug found this session: `REFRESH MATERIALIZED VIEW` never picks up a changed view definition. Root cause, fix, and why it's self-healing once deployed. |
| `93-open-issues-triage-2026-08-09.md` | Triage of an externally-produced 15-item bug list — which claims were real, which contradicted this repo's own research, and what got fixed as a result. |
| `94-spgist-index-optimization.md` | **The largest performance finding in this project.** The 4.7-hour rebuild was a wrong index type, not an inherent cost: GiST → SP-GiST on `inet` columns, ~60× end to end, plus 12.8× on customer lookups. Includes two plausible fixes that were measured and found worthless. |
| `95-mmdb-trie-subdivide-bug.md` | **The most severe correctness bug found in this project.** The `.mmdb` writer silently returned no data for any address under a wider announced prefix that had a narrower prefix nested inside it — likely affecting ≥27% of announced prefixes in every `.mmdb` ever published, not just this session's. Found by the golden-set check doing its job, fixed, verified end-to-end. |

## Scripts and tools referenced across these files, for orientation

- `scripts/mmdb-bench/{server.mjs,loadtest.mjs}` — Node HTTP load-testing
  harness for a built `.mmdb` file. See `91-benchmarks-and-saas-economics.md`.
- `bench-go/` (outside this repo, `~/ip-engine/bench-go` on the phone) — the
  Go equivalents (server + load client + production-shaped server with
  TLS/auth/ratelimit/usage middleware), built because the Node client itself
  turned out to be the bottleneck. Same file.
- `packages/db/src/views/ip-intel.ts` — the flattened relation and its
  build/refresh/drift-detection logic. See `92-ip-intel-definition-drift-bug.md`.
