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
| `96-cli-command-reference.md` | Every `ip-insight` CLI command: what it does, its options, and exactly which tables/files it reads or writes. Reference, not a narrative — start here for "which command do I actually run for X". |
| `97-live-bgp-feed-idea.md` | **Built 2026-08-23.** The RIPE RIS Live real-time BGP feed (`bgp-live` commands) closing `origin-changes`' capture-interval gap. Measured volume/memory numbers, a real false-positive mode found by running it, and what got rejected from the same suggestion (mass port-scanning, passive DNS). |
| `99-dbip-ipv6-support.md` | **Built 2026-08-23, off by default.** IPv6 for the DB-IP Lite source: 128-bit range→CIDR splitting, the measured cost of enabling it (~8.5M extra rows), how to remove it at three levels, and the three verification bugs that surfaced while proving the splitter correct. |
| `100-bulk-copy-ingest.md` | **Built 2026-08-24, on by default.** Why the 14.7M-row `dbip-lite` load took 400s and now takes 167s: `TRUNCATE` over an unqualified `DELETE` that left the table at ~2x its real size, `COPY` over 12,000-parameter `INSERT`s, and a progress counter that cost more than the index. Includes the four optimisations the measurements rejected — one of them 26% *slower* — and why parallelism was not the answer. |
| `101-geo-accuracy-measured.md` | **The inferred city is only as good as the question you ask it.** Measured against four operators' own RFC 8805 geofeeds: ~82% exact city at /24 granularity across datacenter, consumer and mobile alike, dropping to 8% at /30. Country right 81-98% everywhere. Also records a calibration that shipped wrong and was withdrawn the same day — a per-prefix average dominated by 346,000 consumer /29s turned a weighting artifact into a public API contract. |
| `102-verified-geofeeds-batch.md` | **178 more real operator geofeeds**, found by scanning RIPE's own database once (not automated — a real compliance check ruled that out) and individually verified: real fetch, real TLS, real RFC 8805 format check. Excludes Deutsche Telekom's own feed (broken cert, 28.9M addresses) and IPXO (IP-leasing marketplace, weaker location claim) by name. Static snapshot in `verified-geofeeds-data.ts`, no config flag needed. |
| `98-web-panel-rebuild-deferred.md` | **Decision, not started.** The web panel (`apps/web`) is frozen, not incrementally patched — full rebuild deferred until IP-Insight-Engine itself is complete, then done as one pass usable by the least technical authorized person. |
| `106-source-and-license-inventory.md` | **Licensing audit, Phase 0 + Phase 1 (2026-11-08).** Phase 1 done: RouteViews replaced RIPE RIS as the default BGP source (RIPE never granted the logo), RIPE `asn.txt` fallback switched off, CAIDA (B3) downgraded to 🟡 after re-reading its AUA, RIS Live added as G4. Every source with a stable ID (A1…J2, C20.001…C20.178), loaded from the code's own registries rather than memory: 236 registered sources plus live query-time sources, software dependencies and data protection. First-pass risk ratings, with eight leads found just by listing — including that the "all five RIR files are fine" verdict quotes only APNIC's header, that the RIS logo condition is unmet, and that the repo has no LICENSE file. Not re-verified yet; verification order is at the end. |
| `107-parked-status-2026-11-14.md` | **Start here if resuming.** Project parked 2026-11-14 to test other product directions. What works (183 tests), every switch that keeps unclear/live sources off, the fixes made while parking (RPKI "not-found" with no data; tests that could wipe a materialized `ip_intel`), known gaps, open decisions, and the commands to pick it up again. |
| `105-bug-scan-2026-08-27.md` | **A deliberate bug hunt, run right after `docs/104` shipped — three findings, two of them in that just-shipped code, none caught by `tsc` or the 156-test suite.** (1) A fallback source could never refresh its own rows, freezing its names permanently — introduced by the previous fix, which stopped one condition short; fixed and verified against the real table. (2) Provenance columns hold ingester-chosen tags, not registry ids (`feodotracker` writes `abuse.ch-feodotracker`, `gcp-ip-ranges` writes `gcp`) — any cleanup comparing the two deletes everything; guarded with a refuse-if-nothing-kept invariant. (3) Not fixed: removing a source from the registry orphans its rows forever in every per-source table, and for `geofeed_ranges` a stale row *wins* resolution — with the reason it wasn't fixed today stated rather than left implicit. |
| `104-source-selection-and-stale-data.md` | **Built, all three steps (step 3: 2026-11-08).** Step 3 = RouteViews ingestion via our own MRT reader, now the default; its first real switch exposed a unique-index collision that would have left ~2% of BGP data — fixed four ways, verified on real data. Original plan text follows in the doc: Checking a real question — "if a source is switchable in config, does the old source's data still reach the `.mmdb`?" — found the answer is yes, for both configurable mechanisms this project has. `bgp_origin_ranges` rows from a deselected source are never cleaned up (each source only deletes its own); `asn_blocks.name` is worse, with no provenance column at all and no reset path, so a disabled RIPE fallback keeps serving its already-written names. Includes the admission that the shipped feature's own tests masked this by resetting to NULL first. Plans the general rule (provenance + a deselected-source purge, run after success not before), and RouteViews as the concrete new case — its license verified as naming our exact use case, unlike RIPE's. |
| `103-seo-and-attribution-discipline.md` | **Written 2026-08-24, alongside `source.html`'s first theme draft.** The real attribution-link requirements for CAIDA/GeoNames/DB-IP Lite (pulled from `SOURCES.md`, not re-derived), why they're `rel="noopener noreferrer"` and never `nofollow`, why the logo is inline SVG rather than a raster upload, and the general per-page SEO checklist (title/description, canonical, sitemap, CLS-safe images) for every future `ipreadout-service` public page. |

## Scripts and tools referenced across these files, for orientation

- `scripts/mmdb-bench/{server.mjs,loadtest.mjs}` — Node HTTP load-testing
  harness for a built `.mmdb` file. See `91-benchmarks-and-saas-economics.md`.
- `bench-go/` (outside this repo, `~/ip-engine/bench-go` on the phone) — the
  Go equivalents (server + load client + production-shaped server with
  TLS/auth/ratelimit/usage middleware), built because the Node client itself
  turned out to be the bottleneck. Same file.
- `packages/db/src/views/ip-intel.ts` — the flattened relation and its
  build/refresh/drift-detection logic. See `92-ip-intel-definition-drift-bug.md`.
