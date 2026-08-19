# Working notes

Assistant's own running notes for this project — carried between sessions so
decisions and their reasoning survive, and so the direction doesn't drift
without anyone noticing.

Unlike `SOURCES.md` (which documents what the project *is*, for anyone
reading the code), this file records *why things are the way they are*, what
is still open, and what I might be misremembering. Written to be re-read at
the start of a session before touching anything.

Last updated: 2026-07-27.

---

## ⚠️ Known memory gaps — read this first

This project has been built across a long conversation that has been
**compacted several times**: earlier stretches exist only as a summary, not
as the original exchange. Concretely, that means:

- **Reasoning behind early decisions may be lossy.** Anything from before
  the RDAP/licensing rework is reconstructed from a summary. If a past
  decision looks wrong, the honest move is to re-derive it from the code and
  ask, not to assume the summary captured the full reasoning.
- **Testing done on the operator's real phone (Termux/Android)** — DB
  connectivity, real `collect`/`enrich` runs, load testing with autocannon
  on a Poco X6 Pro — happened in an earlier segment. The *outcomes* are
  recorded; the details of what exactly was measured largely are not.
- **Numbers quoted in this file are from actual runs** unless marked as an
  estimate. If a number appears with no run behind it, it is a guess and
  should say so.

If asked about something from before and I don't actually remember it, say
so rather than reconstructing something plausible.

---

## What this product is

A **SaaS IP-intelligence API** (an ipinfo-style competitor). Not open
source in practice, not a data product.

Two constraints that drive almost every licensing decision:

1. **API-only.** Customers get lookup *responses*. The database itself is
   never shared, sold, or exported to them.
2. **Pre-revenue, still in development.** Nothing is launched. The stated
   plan is to tighten licensing before going live, and to possibly rent a
   VDS early *just to start accumulating history*, since history cannot be
   backfilled.

The MIT licence on the code is not in tension with running a closed SaaS —
MIT permits exactly that. Code licence ≠ data licence; they are separate
questions and `SOURCES.md` handles the data side.

---

## Licensing posture (the through-line)

The single organising idea: **individual, per-query lookups are a different
legal object from bulk redistribution.**

- Bulk RIPE/APNIC whois ingestion was **removed** and replaced with live,
  per-address **RDAP** (`packages/lookup/src/lookup/rdap.ts`), for abuse
  contact and geofeed discovery both.
- **Spamhaus DROP/EDROP removed** — free to use, but the name can't appear
  in marketing and access is revocable. Not worth an unresolved dependency.
- `SourceLicense` metadata sits next to each source definition in
  `enrichment-sources.ts` so the compliance matrix can't drift from the code.

**Calibration I had to correct myself on, and must not repeat:** I once said
a single query response is "by definition insubstantial, so it falls squarely
within the exception." That was overclaiming. There is **no defined numeric
boundary** for "insubstantial part" in any RIR's terms. The honest framing,
which I have used since and should keep using: *per-query RDAP is a much
stronger, defensible position than bulk-scraping a whois dump — not an
airtight guarantee.*

The same failure mode showed up twice more from other assistants the operator
consulted, and both times the right move was to name it rather than go along:

- One argued that because RADb's FTP is publicly downloadable with no
  subscription, commercial reuse is therefore fine. **Open access ≠ licence
  to reuse.** RADb's own ToS says "there are no authorized, 3rd-party
  resellers of RADb service", which that argument simply skipped past.
- The same source then suggested adding an attribution line would make it
  "100% safe". **Attribution is a condition inside an existing licence, not
  a way to conjure one.**
- It also proposed stripping `source: RIPE` records out of RADb's mirror and
  treating them as public domain. They aren't — RIPE's IRR objects are under
  the same RIPE Database T&C this whole architecture exists to respect.
  Fetching them via a mirror changes the path, not the licence.

---

## Data sources — current state

**Verified with real ingestion runs** (numbers are actual, from the sandbox
DB):

| Thing | Rows | Note |
|---|---|---|
| `ip_blocks` | 654,789 | RIR delegated-extended stats |
| `geofeed_ranges` | 711,361 | after adding direct-URL publishers |
| ↳ `lacnic-whois-city` | 517,323 | LACNIC's own public city file |
| ↳ direct-URL publishers | 174,025 | 10 sources, added 2026-07-27 |
| ↳ `rdap-live` cache | 739 | grows organically with query traffic |
| `abuse_contacts` | 110,742 | **110,741 are stale** — see below |
| `asn_blocks` | 116,804 | |
| `geonames_places` | 69,515 | |

**Direct-URL geofeeds added** (one HTTP GET each, no RIR, no rate limit):
Cogent 97,401 · Verizon 53,014 · Telia 17,365 · T-Mobile 3,035 · Google 1,151
· NTT 932 · Netflix 605 · Vultr 492 · Schwarz IT 21 · Civo 9.

Researched but **deliberately not added** — no fixed URL could be confirmed,
so don't assume one exists and don't invent it: **F5, Telstra, Cloudflare,
AWS, Azure**. (The "AWS geofeed" on GitHub is a third-party converter, not
AWS's own.)

**Per-publisher terms were checked individually** (2026-07-27), not assumed
from the file being public. Verizon = CDLA-Permissive-2.0, T-Mobile =
Apache-2.0, Schwarz IT = DL-DE→Zero-2.0, Civo = no licence file, and
Google/NTT/Cogent/Vultr/Telia/DigitalOcean state nothing at all.

**One real catch: Netflix's feed restricts use** — *"may be used only for
improving the accuracy of Geo:IP lookups."* Our use is inside that grant, so
it stays, but I had initially labelled it "published for public consumption,
no conditions", which was wrong and is now corrected in both
`enrichment-sources.ts` and `SOURCES.md`. **Consequence to remember: if
geofeed data ever feeds something other than geolocation** — risk scoring,
an "is this Netflix infrastructure" flag, any dataset resale — that would
step outside the grant and needs revisiting. Currently `geofeed_ranges` only
feeds `geo`, so this holds.

**Global context worth remembering:** only ~1,907 ASes worldwide publish a
geofeed at all — roughly 0.25% of inetnums. Geofeed is inherently a niche
signal; low coverage is normal, not a bug in our ingestion.

### Outstanding data cleanup — ✅ RESOLVED 2026-07-28

*(Kept for the lesson; the rows are gone. See "Stale data from removed
sources — PURGED" further down for the counts.)*

`abuse_contacts` held **110,741 rows with `source: 'ripe'`** from the
retired bulk-whois scan, plus ~19,274 stale `geofeed_ranges` rows from the
old RIPE/APNIC discovery. The ingestion code was gone, but **the rows were
still there** — so the database contained exactly the bulk copy the
architecture was changed to avoid. All purged before building neighborhood
context on top of them.

---

## Threat intelligence — the unsolved one

`threat_ranges` is **empty** and there is currently no good answer.

What research established:

- **Spamhaus DROP is proprietary analyst work** — "a tiny subset of the
  SBL", investigators tracking hijacked/criminally-leased netblocks. Not an
  aggregation of public feeds, so it can't be reconstructed from them.
- **abuse.ch is not an escape hatch** — it appointed Spamhaus as its
  licensee in 2022; commercial use routes back through Spamhaus.
- **AlienVault OTX** is explicitly non-commercial in its EULA. **GreenSnow**
  forbids republication. **CINS**, **Blocklist.de**, **DShield** are
  ambiguous or unconfirmed.
- **ET Open** is genuinely MIT-licensed *for the ruleset*. But I downloaded
  the files and checked: `emerging-drop.rules` is literally relabelled
  Spamhaus DROP, `emerging-botcc.rules` is abuse.ch, `emerging-ciarmy.rules`
  is CINS, `emerging-dshield.rules` is DShield. **Adding those would
  re-import every source we rejected, one layer removed.**
  The one clean piece is `compromised-ips.txt` (BSD licence text embedded in
  `emerging-compromised.rules`) — but it is **583 IPs**, sourced from a
  single small SSH-bruteforce project. Real, safe, and nearly negligible.

**Conclusion:** genuine Spamhaus-grade threat data is a *budget* decision
(licence Spamhaus Technology or ET Pro), not an engineering one. Deferred by
the operator until revenue exists. Don't re-litigate this without new
information.

---

## Direction: derive our own signals instead

Agreed direction — stop looking for someone else's blocklist, compute our own
signals from data we already collect. Zero licensing exposure, and it's the
only durable differentiator.

Already shipped as proof this works: **`hijack.ts`** finds prefixes whose most
recent ASN transition wasn't RPKI-authorised, using nothing but
`prefix_history` + `prefix_baseline`. No external feed involved.

Planned (needs history depth first):

1. **"Recently changed = risky"** — prefixes whose ASN/country changed in the
   last N days. Genuinely new, genuinely ours. *Highest value.*
2. **ASN reach anomaly** — a small/new ASN suddenly announcing large space.
   Needs `asn_reach` to be historised first; it currently gets recomputed and
   overwritten each run, so there's no time series yet. **This is a real
   prerequisite that doesn't exist yet — don't promise this signal as though
   it's close.**
3. **Suspicious-infrastructure score** — largely *already exists* as
   `risk.ts`. What it needs is the new inputs above, not a parallel score.

### On score design (a correction worth keeping)

An outside suggestion proposed eight scores: ASN Stability, Prefix Stability,
Network Reputation, Routing Trust, Infrastructure Trust, Abuse Confidence,
Announcement Volatility, Historical Ownership. Problems, in order of severity:

- **Two are uncomputable from our data.** "Reputation" and "Abuse Confidence"
  require observed behaviour (traffic, complaints) we do not have. Naming a
  score "reputation" when it actually means "datacenter with no PTR" would
  mislead customers — and mislabelling is the one failure mode here with real
  liability attached, because a customer may block a real user on it.
- **Most of the rest overlap.** Stability / Volatility / Routing Trust would
  all be computed from the same `prefix_history` + `asn_reach` data. Eight
  near-duplicate numbers are worse than two distinct ones: unmaintainable,
  and customers can't tell them apart.
- **The "explainable output" it pitched already exists.** `risk.ts` returns
  `score` + `reasons[]` and has done from the start.

`risk.ts`'s own header states the philosophy and it should be defended: this
project holds published bulk data, not behavioural telemetry, and no number
of extra feeds turns one into the other. The score means *"how many
independent signals say be careful"* — not a fraud probability. Keep it
transparent and hand-weighted rather than chasing a black-box number we
cannot calibrate.

---

## History subsystem (built 2026-07-27)

The bottleneck for everything above is **time**: none of these signals work
on a young database. So the infrastructure landed first, deliberately.

- `historyCaptureEnabled` (config, default **off**) — runs `captureBaseline()`
  at the tail of every enrichment, strictly *after* the `ip_intel` refresh
  (capture diffs that relation; running before would archive the previous
  run's data as if it were this one's).
- `ops.history_captures` — one row per run: when, `auto` vs `manual`,
  changed/added/removed counts, status, error. Exists because history that
  silently stopped accumulating looks identical to a database where nothing
  changed.
- **`skipped` is a first-class status**, not a failure. The likeliest reason
  a capture can't run is `ipIntelMode: "view"` (capture requires
  `materialized`), which is a config state, not a fault. Recorded with its
  reason so `history status` can say "nothing captured for 3 weeks *because*
  the mode is wrong."
- `runCapture()` **never throws** — an enrichment that already succeeded must
  not be retroactively failed by a history problem. Same rule the `ip_intel`
  refresh follows.
- `historyMaturity()` → `empty` / `baseline-only` / `immature` (<30d) /
  `developing` (<90d) / `mature`.

**Why maturity levels matter (don't water this down):** on a young database,
"this prefix hasn't changed" is not a *weak* signal, it's an actively
**misleading** one — almost nothing has changed yet, so everything looks
stable, and a caller reading that as "verified stable" has it backwards. The
30/90-day thresholds are judgement calls, in the same spirit as `risk.ts`'s
hand-set weights, and are meant to be argued with.

Operator's stated intent: surface maturity inside `status` as an extra
section, and **not expose these derived signals in the SaaS API at first** —
hold them back until the data is actually mature.

### What history actually archives (and the bug that made it not work)

`ip_intel` includes `abuse_email`, `abuse_org` and the geofeed-derived
`country`/`city`/`region`/`postal`/`geo_source`. So `prefix_history` already
archives before/after for those — the "record what a company published
before they changed it" idea is largely built, not new work.

**But it was silently useless until 2026-07-27.** The RDAP cache had no
expiry: `needAbuseRdap = wantAbuse && !abuseRow` meant a prefix was queried
once, ever. A holder changing their abuse contact would never reach us, so
`ip_intel` never changed, so history faithfully recorded that nothing had
happened. The archive would have been a record of our own staleness.

Fixed with `abuseContactMaxAgeDays` (default 30): a cached row past that age
is re-fetched, the fresh value wins for that request, and `ingested_at` is
renewed on write (without that last part the TTL could never clear). Verified
by ageing a row 60 days and poisoning its email — the next lookup re-fetched
and served the correct value.

**Honest limit of the archive as *evidence*:** we store the derived record,
not the original document. We can say "on date X our record said
abuse@example.com"; we cannot produce the RDAP response or security.txt file
that said so. If the legal-evidence angle is ever taken seriously, archiving
the raw fetched document with a timestamp (and ideally a hash) is a separate
piece of work — don't oversell what the current tables can support.

### Postgres tuning is a prerequisite, not an optimisation

Discovered while first testing auto-capture: `flatten --mode materialized`
ran for **54+ minutes without finishing** on the sandbox. Cause was not the
view definition — the database was still on Postgres *stock defaults*
(`work_mem` 4MB, `shared_buffers` 128MB) on a 16GB / 4-core machine, so the
CIDR joins across ~654k `ip_blocks` × ~711k `geofeed_ranges` spilled to disk
continuously.

This matters for the VDS plan: **materialized mode is effectively unusable
on an untuned Postgres**, and `historyCaptureEnabled` requires materialized
mode. So tuning is a prerequisite for history to accumulate at all, not a
nice-to-have. Settings applied in the sandbox, as a starting point to scale
to whatever the VDS has:

```
shared_buffers = 25% of RAM
effective_cache_size = 75% of RAM
maintenance_work_mem = 1GB
work_mem = 128MB          # per-operation — multiply by parallel workers
max_parallel_workers_per_gather = <cores>
random_page_cost = 1.1    # SSD
```

Re-measure after tuning before quoting any figure; the old "~10 minutes" in
`config.ts`'s comment predates the geofeed additions and may no longer hold
either way.

**Correction (same day, later):** tuning was necessary but *not sufficient* —
the tuned rebuild ran **4.7 hours** on the 4-core sandbox (measured, not
estimated: 17,014s). The captures themselves are cheap by comparison, also
measured at full 2.67M-prefix scale: first baseline 2m18s, a no-change
capture 1m48s. So the daily cycle's real cost is the matview rebuild, not
the capture. The real cost is
intrinsic to the view: its base is the DISTINCT union of every table's
prefixes (~2.5M rows counting bgp_origin_ranges' ~1.5M), and each base row
runs ~12 LATERAL GiST containment probes. Adding 174k geofeed rows grew both
the base and the probed index. Two consequences worth remembering:
- **No downtime during the build** — `ensureIpIntel` builds under the
  staging name `ip_intel_building` and swaps via RENAME in a transaction, so
  lookups keep serving the old copy for the whole hour. The cost is CPU-time
  only. Daily enrich+capture remains workable; just budget ~1h of background
  build per cycle at current data size (faster on stronger hardware, slower
  on the phone).
- If build time ever actually hurts, the lever is the view's base (e.g.
  excluding bgp_origin_ranges' /24 confetti from the base, at a precision
  cost) — not Postgres settings. Don't reach for config again first.

### Cadence: daily, and that ceiling is not ours to raise

Capture frequency is capped by **upstream refresh rate**, not by choice: RIR
delegated-stats and RIPE RIS dumps are daily. Running hourly would re-download
identical files, observe nothing, and pay the full materialisation cost each
time. Storage is *not* the argument against it — `prefix_history` grows with
churn, not with how often capture runs — compute is.

Corollary worth remembering: short-lived hijacks (hours) are invisible to us
at *any* cadence, because our BGP source is itself a daily snapshot. Catching
those needs a live BGP feed (RIS Live / BGPStream), which is a different
architecture and is not planned.

---

## Positioning language — decided, applies from day one

Settled 2026-07-27 while discussing whether to make the history archive
"evidence grade". Conclusion: **the risk is not in storing the data, it is in
what we claim about it.** So the technical work is worth doing and the
vocabulary is not.

- **Never** use "evidence", "verified", "certified", "proof" about archived
  history — in marketing, docs, field names, or API responses. Say
  "observational record" / "what our record showed on date X".
- **Show the gaps.** `ops.history_captures` records skipped/failed runs. A
  documented gap is honest; a hidden one is what makes an archive look
  unreliable or selective if it ever matters.
- **Marketing and terms must agree.** A disclaimer buried in the ToS while
  the front page promises certainty is the worst of both worlds — the
  overall impression is what gets judged, not the fine print.
- We store the *derived record*, not the original document. We can say what
  our record said; we cannot produce the RDAP response or security.txt that
  said it. Don't imply otherwise.
- A disclaimer reduces reliance claims but does not stop a subpoena, and does
  not cover knowingly serving data we know to be wrong.

**Deferred to launch** (no domain, no terms page, no API yet — do not build
these early):

- Terms accepted at signup — this is the part that actually binds, not a
  string in a response body.
- A short notice field in API responses (`"notice": "Observational record —
  see /terms"`), config-driven and off by default, so it costs nothing until
  there is a real URL to point at. Full disclaimer text per response was
  considered and rejected: ~300 bytes on every lookup of a high-volume API,
  and clients strip it anyway.
- Proper legal review before taking money. Not worth spending on now.

## The line between this project and the future service

Decided 2026-07-28, and it governs what belongs here:

**This repo is the data engine.** Collection, enrichment, derived tables,
history. Its output is a Postgres database.

**The public API will be rewritten in Go or Rust** as a separate service on
the same VDS, reading from that database. `apps/server` (Express) is
therefore a development/admin tool, not the production API — don't invest in
it as though it were.

Practical consequence, and the rule to apply when picking work: **build
data, not endpoints.** Anything that can be a table or a column belongs
here; anything that is a request/response shape belongs to the Go/Rust
layer and should not be half-built here first.

Calibration recorded so the rewrite isn't over-sold to ourselves: Go/Rust
buys real wins in memory, concurrency and tail latency, and makes hardening
simpler. It does not by itself buy an order of magnitude in throughput — the
measured time in a warm-cache lookup is mostly Postgres, not the runtime.
The leverage is in cache design and query shape, whatever the language.

## Feature roadmap proposed 2026-07-28 — with the operator's verdicts

Full reasoning was given in conversation; compact record here. All are
license-clean and sit on existing architecture.

1. **Verified bot detection** — ✅ **BUILT 2026-07-28.** 10 operator feeds,
   2,080 prefixes ingested and verified against real addresses (Googlebot,
   Bingbot, Applebot, GPTBot all resolve; Cloudflare's 1.1.1.1 correctly
   nulls). New `verified_bot_ranges` table, `bot-prefixes-json` parser (one
   parser for all ten — they share Google's JSON shape), `verified_bot`
   lookup feature, and two `ip_intel` columns. URLs live in
   `sources-registry.ts` like every other source, so an operator moving a
   file is a one-line edit — or a `sources.registry.json` override with no
   code change at all. Original text of this item follows.

   **Verified bot detection** — approved, build here. Google/Bing/
   Apple/DuckDuckGo publish official crawler IP JSONs for exactly this
   purpose. Reuses the cloud-ranges ingestion pattern + optional rDNS
   double-check (Google's documented method) via existing reverse-dns.ts.
   Pure ingestion → data-engine work.
2. **Change monitoring / webhooks** — ❌ **rejected by the operator:** it
   turns the product into a monitoring service (delivery guarantees, retries,
   on-call, per-subscriber cost) rather than a lookup API. Sound call — the
   cost is ongoing and operational, not one-off. Don't revive without a
   deliberate decision to be in that business.
3. **ASN aggregate view** — ✅ **BUILT 2026-07-28** as `asn_profile` +
   `asn-profile-sql` derived source. 84,989 ASNs. Deliberately a *separate*
   table from `asn_reach`: that one is size, this one is composition, and
   merging them would blur what each column means. Runtime **45 min** on the
   sandbox (2,708s) — acceptable for a daily batch, dominated by the RPKI
   pass which genuinely must visit all 1.5M prefixes.

   **Performance lesson worth keeping:** the first draft asked the question
   from the wrong side — for each of 1.5M prefixes, probe cloud/bot/
   anonymity/ip_blocks — about 9M GiST lookups, and it did not finish in ten
   minutes. Rewritten to drive each CTE from the *smallest* table in its
   join (anonymity 2.5k rows, bot 2.1k, cloud 61k). Same answer, thousands
   of probes instead of millions. When a containment aggregate is slow, the
   fix is almost always which side drives it.

   **A zero that looked like a bug and wasn't:** Amazon showed
   `cloud_prefixes = 0`. Cause was simply that `cloud_ranges` held no AWS
   rows in the sandbox at that moment — after ingesting them the same ASN
   showed 12,891. Worth remembering before "fixing" a derived count: check
   whether its input exists. (The stored profile numbers for cloud were
   computed pre-AWS-load and are stale until the next run; harmless in a
   sandbox, but a full recompute is what a real deployment gets nightly.)

   Original text follows. **ASN aggregate view** — approved. Per-ASN rollup as a second
   "derived" source; all inputs already ingested. Build the *table* here;
   the endpoint belongs to the Go/Rust layer.
4. **Neighborhood context** — ✅ **BUILT 2026-07-28.** `neighborhood_stats`
   (sparse, /24 + /48 rollup), `neighborhood-sql` derived source recomputed
   with `asn_reach`, `neighborhood` lookup feature. 1,406 blocks from real
   data. Demonstration that it earns its place: `185.220.101.64` is itself
   clean (risk 15) but sits in a /24 with 141 Tor exits — invisible to any
   per-address lookup. **Deliberately not wired into `risk.ts`**: the counts
   are reported, the judgement is the caller's, for the reasons risk.ts's own
   header gives. Original text follows.

   **Neighborhood context** — approved, operator's favourite. Counts
   of threat/VPN/hosting flags in the surrounding block, own data only.
   Precompute into a table (the Go layer should only read). Name it
   "context", never "bad neighborhood score" (see positioning section).
5. **Provenance + freshness** — ⏸️ **deferred to a proper status page**, not
   now. Data already exists (`content_hash`, per-source timestamps).
6. **History/timeline** — ✅ **infrastructure already built and running**;
   keep capturing so the clock accumulates. The API surface itself is
   Go/Rust-layer work. Label output with maturity level.
7. **Free operator self-check report** — ✅ **BUILT 2026-07-28**, once the
   SaaS-launch conversation made "there's a site to put it on" true.
   `packages/lookup/src/lookup/prefix-check.ts`, `checkPrefix(cidr)`, wired
   to `POST /api/lookup/self-check` (body `{"prefix": "203.0.113.0/24"}`
   — a path param can't hold a `/`). No new table: reuses the geofeed
   containment query, the RPKI-validity join `computeAsnProfile` already
   has, and the exact RDAP/cache-write abuse-contact chain `lookup.ts` uses
   on a cache miss — same write-through cache, so a self-check on a prefix
   a real lookup already touched costs nothing extra, and vice versa.
   Report is `{geofeed, rpki, abuseContact, reverseDns}` — counts and facts,
   never a single score, same discipline as `risk.ts`/`neighborhood_stats`.

   Bounded to /16 (IPv4) / /32 (IPv6) or narrower — wide enough for any real
   operator's own allocation, narrow enough that the query cost and the
   abuse surface of a public, no-auth endpoint stay small. Verified against
   real data: `8.8.8.0/24` (mostly RPKI-unsigned, no abuse contact — Google
   doesn't publish one via RDAP vcard), `1.1.1.0/24` (RPKI valid, abuse
   contact resolves live via RDAP on first call, ~30ms from cache on the
   second — the write-through cache actually working), `193.0.0.0/21`
   (RIPE NCC's own block — abuse contact resolves to "RIPE NCC Operations",
   1 RPKI-valid + 1 RPKI-invalid announced range, a real example worth
   using in the free tool's own demo), `201.90.109.0/24` (a real Brazilian
   geofeed row — city "Belém" correctly matched). `2606:40::/32` confirmed
   the IPv6 path: RPKI checked normally, `reverseDns.supported: false` with
   an honest reason (no 128-bit address arithmetic in this codebase yet,
   see `ipv4CidrToRange`'s own header — not silently wrong, explicitly
   unsupported). Four bad-input cases (`/8` too wide, IPv6 `/16` too wide,
   non-CIDR text, invalid octet) all rejected with a clear message, over
   real HTTP via curl, not just the function directly.

   The public-facing page itself (the actual "enter your prefix" form) is
   future site work, same as item 5 above — this entry is the data-engine
   half: the query is built, tested against real data, and reachable over
   HTTP now.

Explicit don'ts recorded in conversation: no MMDB/dump sales (API-only
posture), no "reputation/fraud probability" naming, no residential-proxy
claims without data to back them.

## Running it unattended (`ip-insight cycle`)

Built 2026-07-28. One pass = collect → enrich (→ ip_intel refresh → history
capture, if enabled). This is what a scheduler should call; `collect &&
enrich` in a crontab is *not* equivalent — see the file header for why
(overlap, `&&` skipping enrich after a failed collect, and console output
belonging to a terminal that isn't there).

**The cron entry must `cd` into the project directory.** Everything
important is resolved relative to the working directory:

| Resolved from cwd | If cwd is wrong |
|---|---|
| `ip-insight.config.json` | every setting silently takes its default |
| `logs/ip-insight.log` | logs land somewhere nobody reads |

`cycle` therefore logs `cwd`, the config file it actually loaded (or that it
found none), `ipIntelMode` and `historyCaptureEnabled` as its very first
line, and warns explicitly when no config was found. A misconfigured
schedule is visible in the morning instead of six weeks later. Overrides
exist if a `cd` is impractical: `IP_INSIGHT_CONFIG` and `LOG_DIR`.

Recommended entry (daily, adjust the hour):

```cron
0 3 * * *  cd /srv/ip-insight && /usr/bin/node apps/cli/src/index.ts cycle >> /dev/null 2>&1
```

Redirecting to `/dev/null` is safe *because* everything meaningful is in
`logs/ip-insight.log`; a non-zero exit still marks the run as failed for any
supervisor that checks. Overlap is handled in-process by a Postgres advisory
lock (session-scoped, so a crash releases it — deliberately not a lock
file, which would survive the crash and block every later run).

Settings a real deployment wants, and which are *not* the shipped defaults:
`{"ipIntelMode": "materialized", "historyCaptureEnabled": true}`. Both are
off by default on purpose — materialized costs hours to build (measured 4.7h
on 4 cores) and capture requires it.

## Capacity — measured 2026-07-28 (4 vCPU / 16 GB sandbox, tuned Postgres)

Real measurements, not estimates, except where marked:

| Path | Latency | Throughput, 1 core |
|---|---|---|
| MMDB read | 0.55 µs | **1,808,092 /s** |
| In-process LRU hit | 0.0016 ms | 612,751 /s |
| Postgres, concurrency 32, no live calls | 3.23 ms | 310 /s |
| Postgres, serial, no live calls | 7.82 ms | 128 /s |
| Postgres **with live RDAP fallback** | 294 ms | 3 /s |

**The finding that matters: live fallbacks cost ~95x.** With `geo` enabled,
every address without a cached geofeed row triggers a live RDAP call; same
for `reverse_dns` (800 ms timeout), `abuse_contact` and security.txt. This
is not a bug — those features do exactly what they were built to do — but it
makes the *current default* the slow path, since no config file means every
feature on. Low traffic hides it completely; it only appears under load.

**Consequence for the API layer: invert that default.** Fast path (mmdb or
cached DB) by default, live enrichment strictly opt-in via parameter, with
its own tighter rate limit. Operator's own framing, and it's right — it also
splits naturally into two priceable products.

**For 10,000 req/s the database is not on the request path at all.** Postgres
at 310/s/core would need ~32 cores just for lookups; mmdb at 1.8M/s/core uses
about 0.6% of one. At that point the bottleneck is HTTP + JSON serialisation
(Node ~30-50k req/s/core, Go/Rust 100k+), which is where the Go rewrite
actually pays — not in the lookup itself.

Sizing for 10k/s: **4 vCPU / 8 GB** is comfortable (2 vCPU plausible in Go).
The mmdb is memory-mapped, so it lives in page cache rather than heap. The
build machine is separate and wants more RAM for the matview rebuild, but
carries no request traffic.

### Correction from the 2026-07-28 HTTP load test (autocannon, real server)

The 310/s/core Postgres figure above is misleading for *uncached, scattered*
traffic, and the difference matters enough to record. Measured over real
HTTP against the built Express server (4-vCPU sandbox, load generator on
the same box, non-live features all on):

| Scenario | Result |
|---|---|
| Hot path — same IP, LRU cache hit | **~1,800 req/s**, p50 15 ms |
| Cold path — 200 random routed IPs, cache forced off (`cacheSize: 1`) | **~46 req/s**, p90 3.3 s |
| Same, DB pool raised 10 → 50 | ~60 req/s — barely moved |

The pool wasn't the bottleneck; the queries are. A cold lookup fires a
dozen containment probes against 1.5M-row GiST indexes, and random IPs
have zero page locality. The earlier 310/s figure came from a warm,
repeated-IP measurement — real cache-miss traffic is ~5-20x slower.
Real-world traffic (Zipf-distributed, 50k-entry cache) lands somewhere
between 60 and 1,800 on this box.

Consequences, none of which change the plan — they confirm it:
1. **Postgres-per-request cannot serve the paid API even at hundreds of
   req/s of unique-IP traffic.** The mmdb fast path isn't an optimisation,
   it is the serving architecture. (Already decided; now proven.)
2. The Express server stays what it is — dev/admin tool. Fine at admin
   traffic levels even cold.
3. If a future feature *must* hit Postgres per request (live enrichment
   tier), it needs its own much lower rate limit — the 46/s cold number is
   the budget ceiling for the whole box, not per customer.

### MMDB path — now measured properly (2026-07-28), replacing the synthetic numbers

Built a real file from real rows (1,504,886 BGP prefixes, records joined to
`asn_blocks` for genuine country/rir/name variety — not the identical-record
synthetic that made the earlier figures meaningless):

| Measure | Synthetic (old, wrong) | Real |
|---|---|---|
| Bytes/entry | 8 | **17.3** |
| File size | — | **24.9 MB** for 1.5M entries, 4 fields |
| Read, scattered IPs | 0.55 µs / 1.8M per core | **1.82 µs / 548k per core** |
| **Over HTTP** (Node + `node:http`, single process) | never measured | **~18,900 req/s**, p50 1 ms, p99 4 ms |
| RSS serving it | — | **171 MB** (heap only 23 MB — the file is mmap'd) |

Notes that matter for sizing:
- **Scattered addresses cost 3.3x a repeated one** (1.82 µs vs 0.55 µs) —
  no page locality. Same lesson as the Postgres number; benchmark with
  random real IPs or the figure flatters itself.
- **File size scales with field count.** 24.9 MB is a *4-field* record. The
  production export carries ~20, and dedup gets weaker as records get more
  distinct (here 1.5M entries collapsed to 84,989 distinct records because
  most prefixes share an ASN). The earlier 50-100 MB guess for the real
  export still looks about right — confirm on the VDS.
- **The HTTP number is conservative**: single Node process (one core for
  JS), with the load generator competing for CPU on the same box. A real
  deployment gets a separate client and can run one process per core.
- **171 MB RSS is the whole serving cost.** Not heap — the mmdb is memory
  mapped, so it lives in page cache and the OS can evict it. This is why
  "serve from mmdb" doesn't need a big-RAM box.

**Conclusion, now on measurement rather than inference: 18,900 req/s from
one Node process on 4 vCPU means the 10,000 req/s target is already met
before writing a line of Go.** The Go/Rust rewrite is still right for tail
latency, memory and hardening — but it is not what gets us to 10k. The
architecture choice (serve the file, not the database) is what does, and
that is a ~400x difference, not a tuning one.

**MMDB file size was an estimate, now superseded by the table above.** The
8 bytes/entry figure was misleading: the synthetic benchmark used an
identical record for every entry and the format deduplicated it away.
MaxMind's own GeoLite2-City is ~60-70 MB for ~3-4M networks with a similar
record shape, so expect roughly **50-100 MB** for our 2.67M — confirm with a
real export on the VDS before relying on it.

## Publishing the served .mmdb (built 2026-07-28)

`ip-insight mmdb publish|rollback|status`. The rule: **a new file serves only
after it answers correctly**, not merely after the build didn't throw.

Why that distinction is the whole point — the failure that actually happens
is not a crashed build, it's a build that succeeds and is wrong. A source
returns empty, a collect half-finishes, and the result is a structurally
valid MaxMind file containing a fraction of the data. Nothing errors.
Promotion on "write succeeded" would ship it.

Gate, in order: build to a timestamped file (never overwrite) → reopen with
the **real `maxmind` reader**, deliberately not our own writer's code, so a
writer bug cannot validate itself → golden set of known answers → prefix
count against the currently-serving file (floor 80%) → only then repoint
`current.mmdb`, by symlink rename, which is atomic. A rejected candidate
stays on disk to be inspected and the previous file keeps serving.

`rollbackMmdb` is separate on purpose: validation cannot catch everything,
and a regression noticed two hours later needs a way back that is a rename
rather than another multi-hour rebuild. Retention is count-based (default 5)
and never prunes the file `current` points at — age-based would delete
exactly what you need after a long outage.

**The gate paid for itself immediately** by rejecting the first two real
candidates over bugs I had just introduced:

1. **`asn` was a string in the file.** It is a `bigint` column, and
   node-postgres returns bigints as strings to protect precision above 2^53.
   Consumers (and MaxMind's own ASN database) expect a number. Coerced in
   `toRecord`; safe here specifically because ASNs are 32-bit.
2. **`verified_bot` never reached the file.** Adding a column to `ip_intel`
   is a *three*-place change — the SELECT, the `IntelRow` interface, and
   `toRecord`'s explicit field list. I did two of the three. The field
   existed in the database and was silently absent from the artifact.

Second one is the lesson: `toRecord` is an allowlist, so a new `ip_intel`
column reaches the served file only if explicitly added there.

`neighborhood` is deliberately **not** in the file: it is keyed by /24 block
rather than by prefix, so putting it in a per-prefix row would mean
denormalising it misleadingly.

## Open threads

- **RADb** — email sent to `support@radb.net` (2026-07-27, ~21:00 TRT) asking
  whether bulk FTP data may be used in a commercial API, whether a fee or
  agreement applies, and whether attribution is required. **Awaiting reply.
  Do not integrate RADb before it arrives.** Loss if the answer is no is
  small: it would only have added abuse contacts for large/transit networks
  that register route objects, most of which RDAP already covers.
- **Spamhaus** — deferred until there's a budget. Re-add only under a
  Spamhaus Technology licence.
- **RIPE NCC / APNIC confirmation emails** — **closed 2026-07-28, no email
  needed.** They were drafted back when this project ingested the bulk
  RIPE/APNIC whois dumps; that ingestion was removed and replaced with
  per-query RDAP, so the emails now ask about a thing we no longer do.
  Nothing in the current architecture waits on an answer. If RIPE is ever
  contacted it should be an *operational* question at real volume ("we run
  N RDAP queries/day, is that acceptable"), not a licensing one — and
  RIPE's RDAP documentation states no rate limit today. **I listed these as
  a pending action item on 2026-07-28 and that was wrong** — this same
  section already said they were optional. Don't re-raise them.
- **IANA RDAP bootstrap** — currently every RDAP query enters via
  `rdap.db.ripe.net` and follows the 301 redirect to the correct RIR
  (verified working for ARIN/APNIC/LACNIC). Using IANA's bootstrap file to go
  direct would save one round trip. Small optimisation, not decided, low
  priority.
- **API keys / rate limiting / enumeration protection** — explicitly deferred
  by the operator until closer to launch. Not an oversight.
- **`asn_reach` historisation** — prerequisite for derived signal #2 above.
  Not started.
- **Raw-document archiving** (store the fetched RDAP response / security.txt
  body itself, with a hash, not just the derived record). Discussed, not
  built. Would be the only way to back a claim about what a source *said*
  rather than what we recorded. Note the positioning section above before
  building it — the technical piece is fine, the vocabulary around it is
  where the risk is.

## Stale data from removed sources — PURGED 2026-07-28

Previously flagged as "must not ship"; done. Found while about to build
neighborhood context on top of `threat_ranges` and discovering all 1,668 rows
in it were **Spamhaus DROP data from 2026-07-22**, ingested before that
source was removed for licensing reasons. Building a feature on data we had
decided we cannot use would have been a real mistake, so the purge happened
then rather than "later on the VDS":

| Table | Removed | Left |
|---|---|---|
| `threat_ranges` (spamhaus_drop) | 1,668 | 0 |
| `abuse_contacts` (bulk RIPE) | 110,741 | 1 (live RDAP cache) |
| `geofeed_ranges` (bulk RIPE/APNIC discovery) | 19,274 | 692,114 |

Lesson: a removed *source* doesn't remove its *rows*. Check the table
contents, not just the source list, before building anything on top.

## Bugs found in the 2026-07-27 review pass

Recorded so the same classes get checked again rather than rediscovered:

1. **RDAP fetched twice per lookup.** `fetchAbuseContactViaRdap` and
   `fetchGeofeedViaRdap` each did their own `fetchRdapObject(ip)` — two
   requests to the same RIR for one address, reading different fields of the
   same document. Restructured to `fetchRdapObject` + two pure extractors.
2. **Reverse DNS resolved twice.** `lookup.ts` already resolves the PTR;
   `security-txt.ts` resolved it again internally. Now passed in.
3. **security.txt could hammer one domain.** Cached per `/32`, so 256
   addresses in a `/24` meant 256 HTTPS requests to the same server for an
   identical file — wasteful, and looks like scraping from the other end.
   Added a process-lifetime domain→result cache (including negative results,
   which are the common case).
4. **Malformed geofeed fields reached the API.** Cogent's published feed
   contains `MONGOLIA` in the country column and `HK ` with trailing space;
   these were stored and served as-is, breaking the documented "2-letter ISO
   code" contract. Added `packages/shared/src/geofeed-fields.ts`, used by all
   three parse sites. Invalid country → null, rest of the row kept.
5. **Abuse-contact cache never expired** — see the history section above.

Lesson worth keeping: three of these came from *not looking at real data*.
The country-code bug was found by querying the ingested rows for anomalies,
not by reading code. Do that after adding any source.

Second pass, same day (each verified with a live test, not just typecheck):

6. **Gzip downloads bypassed the content hasher.** `iterLinesGzip` counts
   `bytesDownloaded` in its own `on("data")` handler, separate from the
   three read paths that were patched — so RIS dumps and LACNIC (the
   *largest* files ingested) would have digested as the empty-stream hash
   and read "identical" on every run. One line added in the handler.
7. **Real capture failures could be filed as "skipped".** The precondition
   check was `message.includes("ip_intel")` — but drizzle query-failure
   messages embed the failed SQL, which says `FROM ip_intel`. A deadlock or
   full disk during capture would have landed in the benign-config bucket,
   the exact silent failure `history_captures` exists to expose. Now
   `startsWith("ip_intel")` (preconditions start with the relation name;
   drizzle failures start with "Failed query:").
8. **Crash mid-capture left a forever-"running" row** that `status` would
   report as running indefinitely. Now swept to `failed`/"interrupted" at
   the start of the next run (6h threshold), mirroring the job tables'
   interrupted-detection. Verified by planting a 7h-old running row.

9. **Materialized-swap TOCTOU lost a 4.7-hour build at its last step.**
   `ensureIpIntel` read what `ip_intel` currently was *before* starting the
   staging build, then used that stale answer hours later to decide the swap's
   DROP. In the window, an enrichment run finished and recreated `ip_intel`
   as a plain view — so the swap skipped/mis-keyworded the drop and the
   RENAME died with "relation already exists", discarding the whole build.
   (Postgres refuses cross-relkind drops even with IF EXISTS, so "drop both
   kinds blindly" is not an option.) Fixed by re-reading `relkind` from
   `pg_class` *inside* the swap transaction. The stranded 680MB staging
   matview survived the failed transaction, so the swap was completed
   manually without paying for a rebuild.

10. **Enrichment could silently destroy the materialized `ip_intel`.** It
    called `ensureIpIntel(config.ipIntelMode)` — i.e. it *enforced* the
    configured form every run, so any run seeing `"view"` dropped a
    materialized `ip_intel` without warning. Hours of build, gone in a
    statement. The dangerous part is that nobody has to choose "view" for
    this to fire: the config is resolved from the working directory, so a
    cron entry missing a `cd` finds no file, takes all defaults, and the
    default *is* `"view"`. A scheduled job would quietly destroy the thing it
    exists to maintain. Now enrichment refreshes whatever form already
    exists and only uses the configured mode when `ip_intel` is absent;
    changing form requires `ip-insight flatten --mode X`, which says so by
    name. Mismatches are logged rather than acted on. Verified: with config
    `"view"` and a materialized relation present, the relation survived and
    the mismatch was logged. (Found by destroying the real 2.67M-row build
    with exactly this mechanism during testing — the history baseline
    survived, the matview did not.)

11. **A pinned `lookupFeatures` list silently swallows every new signal.**
    `verified_bot` was built, ingested and correct in the database, and the
    API returned `null` for known Googlebot addresses. Cause: the shipped
    `ip-insight.config.json` enumerates features explicitly, so anything not
    in that list is off — correct behaviour, invisible symptom. Any
    deployment that pinned its feature list will keep missing new signals
    until someone edits the file. Worth remembering when shipping a feature
    and "it doesn't work" is the first report. (Omitting `lookupFeatures`
    entirely means "all", including future additions — the safer default for
    a deployment that wants everything.)

Known cosmetic limitation, deliberately not fixed: the Azure source's hash
covers the scraped download page *plus* the JSON body, so if Microsoft's
page HTML churns, Azure's hash changes even when the data didn't. Harmless
for corruption detection, noisy for change detection — revisit only if the
hash is ever used to skip re-ingestion.

## mmdb metadata type bug — found 2026-07-29, via a third independent reader

While benchmarking Go vs Rust vs Node for the future API service (see the
sibling `ipreadout-service/PLAN.md`), the Rust `maxminddb` crate crashed
opening a real test file: `expected u32, got type 5`.

**Cause.** `encodeValue`'s generic number encoder in `mmdb-writer.ts` picks
the *smallest* MaxMind DB type that fits a value — correct for arbitrary
data-section record fields, wrong for the metadata section, whose field
types are fixed by the spec regardless of value. A database with fewer than
65,536 nodes (any small or test export) got `node_count` encoded as
`uint16` instead of the mandated `uint32`. Node's `maxmind` package and Go's
`oschwald/maxminddb-golang` both decode leniently and never noticed; Rust's
crate validates the type tag strictly and correctly rejected the file.

**Blast radius:** every `.mmdb` this project has ever built with fewer than
65,536 nodes was spec-noncompliant — including any custom golden-set file
DEPLOY.md tells an operator to build ("build your own from real data"),
which could silently fail for a customer using a stricter reader than ours.
The production export (millions of nodes) was very likely fine by
coincidence, not by correctness.

**Fix.** New `encodeForcedUint`/`encodeMetadata` in `mmdb-writer.ts` give
metadata fields (`node_count`, `record_size`, `ip_version`,
`binary_format_*_version`, `build_epoch`) their spec-mandated type tags
explicitly, independent of value size. Data-section encoding (`encodeValue`,
used for every actual record) is untouched — this was scoped to metadata
only. Verified against all three independent readers afterward: Node, Go,
and Rust all opened the fixed file and returned identical, correct records.

**The lesson, again:** this is the third bug in this project found by
testing against independent real consumers rather than our own code path —
after `MONGOLIA` (looking at rows) and the missing `verified_bot` field
(the publish gate's golden set). Here it was a *third* reader implementation
that caught what our own two (Go's gate, the JS package) missed. One
consumer validating a format isn't enough evidence the format is right.

## The RPKI false-hijack bug — found 2026-07-28, worst one in the project so far

Found by doing what this file keeps telling me to do: **look at an actual
row.** The operator asked what a real mmdb record contains, so I built
`ip_intel` as a view and printed the row for `66.249.66.1`. It said
`rpki_status: "invalid"` — for one of **Google's own published Googlebot
ranges**, whose authorized ASN in the same row was its own ASN. That is a
sentence that cannot be true.

**Cause.** RFC 6811 validates a *route*: the pair (announced prefix, origin
AS). The view was validating the pair (**this base row's prefix**, origin
AS). Those are the same thing only when the base row happens to be a real
BGP announcement. Most base rows are not — the base UNION deliberately
includes Tor /32s, published crawler /24-/27s, geofeed sub-prefixes, cloud
ranges — all *narrower* than the announcement covering them. So the
max-length test asked "is a /27 announcement authorized?" about an
announcement nobody ever made, got no, and returned `invalid`.

**Blast radius, measured not guessed: 2,799 of 2,916 sampled rows — 96% —
carried a false `invalid`.** Every Tor exit node and every verified-bot
range inside an RPKI-signed network. `invalid` is not a soft signal; it is
the signature of a route hijack, and `risk.ts` treats it as one. We would
have been shipping a hijack accusation about Google, and about most of the
Tor network, in the API *and* baked into every .mmdb built from it.

**Fix.** The `bgp` LATERAL now also returns `x.network` (the announced
prefix), and both ROA tests use `bgp.network` instead of `b.network` — the
covering test and the max-length test. One-line-ish change, four-word root
cause: *validate the route, not the row.*

**Verified both directions**, which mattered more than the fix itself,
because a fix that turns everything `valid` would be worse than the bug:

| Case | Before | After | Why |
|---|---|---|---|
| `66.249.66.1` (Googlebot /27) | invalid ❌ | **valid** ✅ | announcement is 66.249.64.0/20, ROA maxlen 20 |
| `1.6.168.1` | — | **invalid** ✅ | genuine max-length violation: ROA is /22 maxlen 22, announced /24 |
| `134.233.42.0` | — | **not-found** ✅ | no ROA covers it at all — the normal case |
| `1.1.1.1`, `185.220.101.64` | valid | valid | unchanged |

**Lesson, and it is the same one as `MONGOLIA` and the `asn` string:** this
passed typecheck, passed every test that existed, produced no error, and was
wrong in a way only visible by reading one real row. The three worst bugs in
this project were all found by printing real output, never by reading code.

**Related observation, deliberately NOT changed:** where a prefix has two
origins (a MOAS — `134.255.199.0/24` is announced by AS48678 with 342 peers
*and* AS64516 with 1), the view picks the dominant origin and validates
that. So the suspicious second origin doesn't reach `rpki_status`. That is
the view's documented "most-visible origin wins" rule and MOAS detection
belongs in `hijack.ts`, not here — but it means **`rpki_status: valid` does
not mean "no hijack attempt exists for this prefix"**. Worth stating plainly
in SOURCES.md before anyone sells it as one.

## Bugs found in the 2026-07-28 hardening pass (post self-check build)

All found by suspecting the newest code (`prefix-check.ts`) and *running*
the edge cases, not by reading. All fixed and re-verified over real HTTP.

1. **`parseCidr` accepted garbage prefix lengths.** `Number("")` is `0`, so
   a truncated line `"1.2.3.0/"` parsed as a **match-everything /0**; and
   `"24.5"`, `" 24"`, `"+24"` all passed `Number()` but fail the eventual
   Postgres `::inet` cast — the exact batch-insert failure the function
   exists to prevent. Fixed with a `/^\d{1,3}$/` gate on the prefix part.
   This hardened all ~20 ingestion call sites at once, not just self-check.
2. **Self-check rDNS sampling walked out of the block.** Input with host
   bits set (`8.8.8.255/24`) sampled starting at `8.8.9.0` — five PTR
   queries in *someone else's network*, reported as if they were the
   caller's. Two-part fix: `ipv4Samples` masks to the aligned network
   address itself (must not rely on its caller), and `checkPrefix`
   canonicalises input once via Postgres's own `network()` (both families)
   so the queries and the reported `prefix` label always agree — the
   containment operators ignore host bits, so the data was right but the
   label lied.
3. **Infrastructure errors leaked to the public endpoint.** The route
   returned any `Error.message` with a 400 — including drizzle's
   "Failed query: <full SQL>" if the DB hiccuped. Now `PrefixCheckInputError`
   → 400 with the caller-facing message; anything else → logged, generic
   500. This endpoint is meant to be public and unauthenticated, so it gets
   stricter treatment than the operator-facing routes.
4. **28 IPv4-mapped junk announcements in `bgp_origin_ranges`.**
   `::ffff:92.47.144.56/127` and 27 siblings (AS9198 leaking v4-mapped
   "v6" routes into the RIS dump). Can never match any query — v4 lookups
   compare family-4 rows only; no real v6 address is `::ffff:`-mapped —
   but they inflate that ASN's `asn_profile` announcement counts. Filter
   added at RIS ingestion; existing rows deleted (a filter, like a removed
   source, does not remove already-ingested rows).
5. *(doc rot)* `lookup/config.ts`'s comment said "fifteen signals … all
   sixteen by default" while the real list holds seventeen and never
   mentioned `neighborhood`. The numeral is gone; the comment now defers to
   `ALL_LOOKUP_FEATURES` as the authority.

Also given a deliberate pass and left alone: `abuse_contacts` pick now has
`ORDER BY masklen DESC` (was a nondeterministic `LIMIT 1`); mmdb prune's
count-based retention can in principle prune the rollback target if 5+
rejected candidates are newer than the previous published file — accepted,
documented behaviour (count-based on purpose, see prune()'s header), only
worth revisiting if rejects ever become routine.

---

## Working agreement with the operator

Stated plainly and worth honouring:

> "Körü körüne tamam demene gerek yok — mantıksız olan, haksız yada saçma
> olan yerleri düzelt ki doğrusunu öğreneyim."

So: push back with reasons, don't agree by default, and correct outside
advice (theirs, ChatGPT's, Gemini's) when it's wrong. This has already caught
several real errors and is the most useful thing I do here.

Two habits that go with it:

- **Verify before claiming.** Fetch the file, run the query, read the actual
  terms. Several confident-sounding claims in this project turned out wrong
  when actually checked — including some of mine.
- **Say "I couldn't confirm this."** Named-but-unverified geofeed publishers
  were left out rather than guessed at; that's the standard to hold.

Deliverables go out as **zips via the file-send tool**. This project is *not*
the GitHub repo this session is nominally scoped to, and nothing here should
be pushed there.
