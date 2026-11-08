# 97 — Live BGP feed (RIS Live) — BUILT 2026-08-23

Raised 2026-08-20 as an idea, built 2026-08-23. The design reasoning below
is kept as written *before* implementation, because most of it survived
contact with the real feed and the parts that didn't are worth seeing.
What actually shipped, and the measurements that shaped it, is in
"## What was built" at the end.

## The real gap this responds to

`origin-changes`/`hijack-scan` is honest about its own limit (see its CLI
description): it's built entirely from `history capture` snapshots, so its
resolution is the capture interval. A hijack that starts and ends between
two captures is invisible. Real numbers from 2026-08-20's `status
--detail`: only 6 captures in the system's first day of observation, each
roughly 4 hours apart. A BGP hijack that lives for minutes — the common
case — falls entirely inside that gap.

A second Claude instance (DeepSeek) was asked about this independently and
proposed BGPStream/OpenBMP + Kafka, plus (separately, rejected — see below)
mass port-scanning changed prefixes and building a passive-DNS collector.
The realtime-BGP part of that suggestion is legitimate; the founder's own
refinement of it (below) is better than DeepSeek's version.

## What's actually being proposed

**RIPE RIS Live** — a free, public WebSocket stream of raw BGP UPDATE
messages from RIPE's route collectors. No Kafka, no self-hosted route
collector, no commercial dependency. This is a genuinely different kind of
component from everything else in this codebase: every existing collector/
enrichment source is a batch job that runs, finishes, and exits. A RIS Live
consumer is a **long-running process that stays connected** — closer in
shape to `apps/server` than to `collect`/`enrich`.

Founder's proposed shape, which is sound:
1. Build it as an explicitly start/stop-able service with its own live
   status (not folded into the existing job-status model, which assumes a
   run finishes).
2. Trial it on the phone first — leave it running 3-5 hours, watch what
   happens — before deciding whether it belongs on a VDS/homelab box under
   cron/systemd control.
3. **Don't treat the phone trial's outcome as the final verdict on the
   architecture.** Explicitly stated: if the phone trial is awkward, that's
   a phone limitation, not a reason to abandon the idea — VDS/homelab was
   always the real target for an always-on process.
4. Accumulate the raw events over time (the founder's own framing: "3 gün
   aktif kaldı, mmdb publish yaptık, ilk aldığımız andan itibaren
   görebilirler" — the live feed makes the *history* richer/finer-grained;
   it does not have to change what `mmdb publish` ships). The
   customer-facing product stays the periodically-published `.mmdb` — not a
   live API. A literal live-lookup product is explicitly deferred as a
   possible future paid tier, same framing already used for the VPN-
   detection idea in `SOURCES.md`.

That product framing (accumulate now, sell "live" later as a distinct paid
tier) is the right call and consistent with how this project has scoped
every other feature — no reason to revisit it.

## Engineering considerations, if this is ever built

- **Don't write straight into `bgp_origin_ranges`.** That table is a full
  snapshot, rebuilt by `ingestRisWhoisDump` via delete-then-reinsert per
  source id every run — it's what `ip_intel`/`mmdb` are built from. Raw BGP
  updates are noisy: route flapping and transient reannouncements during
  convergence are constant and don't reflect a "stable" answer a lookup API
  should report. Mixing live single-update events into the table backing
  live customer lookups would make `asn.number` answers flicker on
  momentary noise. The live feed should land in its own append-only events
  table (a real-time analog of `ops.prefix_history`), not the snapshot
  table.
- **A change needs to persist before it counts.** Standard practice for
  BGP-hijack detection (what Cloudflare Radar and similar tools do): don't
  alert on a single UPDATE message, require the new origin to hold for some
  minimum window before treating it as real. Without this, `origin-changes`
  would go from "too slow to catch anything" to "too noisy to trust,"
  trading one honest limitation for a dishonest one.
- **Two separate flags, not one.** A prefix whose origin flaps repeatedly in
  a short window is an *instability* signal (multihoming failover,
  maintenance, misconfig — usually not malicious) — worth counting, not
  discarding, and it's the missing data source for the already-designed
  (agent-led, not yet built) network-stability/churn score mentioned in
  `docs/50-features-shipped.md`. A *hijack* signal stays tied to the
  existing, more specific `origin-changes` check (RPKI-unauthorized origin)
  and should only fire once a change has passed the persistence window
  above — flap-count alone must never be read as "hijack": the noisiest
  prefixes are usually the most legitimately multihomed ones, while real
  hijacks usually look like one clean, stable change.
- **The daily RIS whois snapshot stays** as the reconciliation source of
  truth for what `mmdb` ships — the live feed is additive (finer-grained
  history/faster hijack signal), not a replacement.
- **Termux/Android reality check for the phone trial**: Android aggressively
  kills background processes, especially with the screen off — this project
  has already hit Termux-specific gotchas twice this session (`/tmp`
  permission, wifi-range TCP resets). A multi-hour trial needs
  `termux-wake-lock` running first, or a "the feed died after 40 minutes"
  result will look like a code bug when it's actually Android's OS doing
  exactly what it's designed to do. Even with a wake lock, the phone isn't
  a reliable long-term host for this — the VDS/homelab is still the real
  destination; the phone trial is only useful for validating the
  ingestion/parsing logic, not for judging uptime.

## Explicitly rejected from the same suggestion

Two other pieces of the same DeepSeek proposal were rejected outright, not
deferred:

- **Mass port-scanning (Masscan/Zmap) of changed prefixes.** Actively
  probing third-party network space without authorization is a different
  category from everything this project does — real abuse/legal exposure,
  and a scale of operational/legal overhead (opt-out registries, abuse
  response) that only exists at companies built specifically for it
  (Shodan, Censys). Not something to bolt onto a self-hosted IP-intel tool.
- **Self-hosted passive DNS.** Real passive-DNS datasets are either paid
  commercial products or require DNS-resolver-level traffic visibility this
  project has neither — doesn't fit the "free, publicly published data
  only" principle every other source in `SOURCES.md` follows.

## Licensing — verified 2026-08-20

RIS Live falls under the same policy already tracked for the RIS whois
dumps (`docs/93`) — the RIPE NCC "RIS Commercial Use Terms and Conditions"
page (`ripe.net/analyse/internet-measurements/routing-information-service-
ris/commercial-use/`), not the stricter "RIPE Data Repository Terms and
Conditions" that governs the separate "RIS Raw Data" download product.
Confirmed by reading the commercial-use page's own boilerplate attribution
text, which names RIPEstat, **RIS Live**, RIS Raw Data, and RISwhois
individually as covered access methods.

Grants (revocable by RIPE NCC at their discretion): permission to build
paid services/products/reports/derivatives from RIS data, including RIS
Live, and to combine it with other sources into a commercial product. No
explicit restriction on redistribution beyond the conditions below.

Requires: (1) accept the RIPE NCC Website/Services Terms of Service —
not independently read yet, a remaining item; (2) RIPE NCC logo on the
product/website/report; (3) a link to `ripe.net/ris`; (4) the specific
boilerplate paragraph ("The RIPE Routing Information Service (RIS) is a
RIPE NCC service..."). Founder's plan — a dedicated public sources/
attribution page on the product site carrying the logo, link and
boilerplate, referenced from the API docs rather than repeated in every
response — is a reasonable, standard way to satisfy "on the product," but
the terms page doesn't spell out that a single linked page (vs. per-page
attribution) is sufficient; treat as likely-fine, not confirmed-fine.

A real, separate trap found while checking this: the RIS Live manual page
links to "Terms and Conditions," which resolves to the *Data Repository*
terms — a different, stricter document that explicitly prohibits
commercial use. Traced it: that link sits in a shared "Raw Datasets" site
nav section and belongs to the separate "RIS Raw Data" download product,
not RIS Live itself. Not a blocker here, but worth remembering if this
project ever also wants to use RIS Raw Data specifically — that one *is*
commercial-use-prohibited without written RIPE permission.

## What was built (2026-08-23)

`packages/collector/src/live/ris-live.ts`, two `ops` tables
(`bgp_live_sessions`, `bgp_live_events`), and four CLI verbs: `bgp-live
run` / `status` / `events` / `stop`.

### Measured first, designed second

Every scale decision came from probing the real feed before writing the
listener, not from estimates:

| Scope | Downloaded | Messages/sec |
|---|---|---|
| All collectors (firehose) | ~7 GB/hour | ~6,300 |
| One collector (rrc00) | ~3.7 GB/hour | ~1,800 |
| One peer | ~7 MB/hour | ~5 |

`--collector` and `--peer` exist so the same code runs at any of those
without a rewrite. The volume is *downloaded*, not stored — a two-minute
firehose run downloaded 209 MB and wrote 11 rows.

The in-memory baseline was measured too, since it was the main risk on a
phone: 1.5M prefix→origin entries cost **174 MB of heap** and answer
**~6.3M lookups/sec**, against the ~18k/sec the firehose demands. The map
was never the bottleneck; JSON parsing is, and at ~3 MB/sec that is a few
percent of one core.

### The design decision that mattered most

Seed the comparison baseline from `bgp_origin_ranges` at startup (the
founder's own instinct — "ilk başta hepsinin ilk verisini alabiliriz"),
rather than building state from scratch over the session. That means
changes are detected from the first second, and — more importantly — the
baseline is a *set* of known origins per prefix, so ordinary MOAS prefixes
(legitimately announced by several ASes) don't each produce a false event.

Compared against a single origin instead of a set, this would have been
unusable.

### A real false-positive mode, found by running it

The first live run seeded only IPv4 (`ris-whois-ipv4`), so every IPv6
prefix fell through to a weaker path: absent from the baseline, the
listener learns "the first origin I saw" and treats a later, equally
legitimate second origin as a change. It produced exactly the artefact you
would expect — `2605:9cc0:3d4::/48` recorded AS21664 → AS16509 while
`2605:9cc0:3c2::/48` recorded AS16509 → AS21664 in the same minute: two
halves of one ordinary Amazon MOAS arrangement, reported as two incidents.

Fixed by recording *where the baseline came from* on every event
(`baseline_source`: `"snapshot"` vs `"session"`), showing it as
`weak-baseline` in `bgp-live events`, and adding `--snapshot-only`. Not
filtered out at write time — a weak-baseline event isn't worthless, it's
just weaker, and which ones matter depends on the question.

Re-run with the full IPv4+IPv6 baseline (1.58M prefixes), the same two
minutes of feed produced: 473,179 messages, 1,225,547 prefixes checked,
**11 origin changes**, 175 prefixes not in the baseline — versus 35
changes and 194,103 unknowns on the IPv4-only seed. The lesson generalises:
**run `enrich --sources ris-whois-ipv4,ris-whois-ipv6` before a session**,
or a third of the results are noise.

### Real catches from a two-minute run

Not synthetic. Among the 11: `189.28.150.0/23` announced with origin
**AS65400** — a private-use ASN (RFC 6996) that has no business appearing
in the public table at all, i.e. a genuine leak/misconfiguration; a /16
(`190.71.0.0/16`) moving from AS3356 to AS13489 seen by 4 peers; and
several MOAS additions. That is the intended shape of output: rare,
specific, and each one needing a human read rather than an automatic
verdict.

### What it deliberately does not do

- **Does not write to `bgp_origin_ranges`.** That stays the clean daily
  snapshot everything else builds from; live single updates in it would
  make customer lookups flicker on ordinary route flap.
- **Does not call anything a hijack.** `bgp-live events` prints the raw
  observation plus current RPKI status (joined at read time, since a ROA
  can change after the announcement) and says plainly that a transfer, a
  de-aggregation and a MOAS addition all look identical to this. Same
  "raw fact, caller decides" contract as `wider_prefix_asn` and
  `route_anomaly`.
- **Does not implement the persistence window** sketched earlier in this
  document. `peer_count` turned out to do the same job better and more
  honestly: a change reported by 287 peers propagated globally, one
  reported by 1 stayed local — measured per event, not inferred from a
  timer this project would have had to pick a threshold for.

### Verified

`typecheck` clean; full suite 105/105 (7 new unit tests covering the
origin-extraction and MOAS-membership logic, including the AS_SET case,
which returns `null` rather than guessing a member). Real end-to-end runs
against the live feed as described above. Remote stop tested across two
terminals: `bgp-live stop` set the flag, the running listener finished its
flush and exited with session status `stopped` (not `failed`).

### Still open

- **Not yet run on the phone.** Needs `termux-wake-lock` first — Android
  kills background processes with the screen off, and without the wake
  lock a feed that dies at 40 minutes will look like a code bug. The
  firehose at ~7 GB/hour is fine on the founder's unlimited wifi but is a
  deliberate choice, not a default anyone should inherit.
- **No long-run data yet.** Every number above comes from runs of two
  minutes or less. What a three-hour or overnight session actually
  accumulates — event volume, memory drift, whether the connection stays
  up — is unmeasured.
