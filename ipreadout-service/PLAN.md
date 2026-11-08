# ipreadout-service — plan

Started fresh 2026-08-25. An earlier version of this file (with its
`bench-go/` benchmarks) was lost before it could be committed — this is a
deliberate restart, written down as decisions happen instead of held in
conversation, specifically to not lose it a second time.

Zero product code exists yet. Everything below is design, not
implementation. Will live in its own separate repository once building
starts — not nested inside `ip-insight-engine`.

## Category docs

Each topic gets its own file under `docs/`, written as decisions are made
rather than all at once — see each file for what's actually decided vs.
still open.

- [`docs/01-rate-limiting-and-abuse-protection.md`](docs/01-rate-limiting-and-abuse-protection.md) — access tiers (keyless/free/paid), Redis-backed limits, the keyless-wide DDoS shutoff, Cloudflare's role, and the still-undesigned low-and-slow abuse detector.
- [`docs/02-architecture-and-data-flow.md`](docs/02-architecture-and-data-flow.md) — why `.mmdb`-only (not a live proxy to the engine), hosting (same VDS to start), and the undecided `.mmdb` transfer mechanism.
- [`docs/03-monitoring-and-status.md`](docs/03-monitoring-and-status.md) — UptimeRobot (free tier, post-launch), the Status page's real-data-only rule, and keeping our own uptime/incident records.
- [`docs/04-open-decisions.md`](docs/04-open-decisions.md) — **read this one first if picking up this plan cold.** Every architectural question raised so far, each marked with what's actually decided vs. still open: accounts/API keys, billing, ToS/privacy timing, data retention, versioning, CORS, the `.mmdb` rollback design, live-field parameters, abuse-pattern detection, brand/domain.
- [`docs/05-api-conveniences.md`](docs/05-api-conveniences.md) — customer-facing API behavior decisions: auto-detecting the caller's own IP, an IPv4/IPv6 selector.
- [`docs/06-competitive-positioning.md`](docs/06-competitive-positioning.md) — real, live-fetched pricing/features from 7 competitors (ipinfo, MaxMind, ip-api.com, ipapi.com, ipdata.co, IPQualityScore, IP2Location.io, ipgeolocation.io), what's genuinely unique to us (RPKI, route anomaly, neighborhood, honest accuracy numbers), what's table stakes, and what we deliberately don't have. Positioning input, not a pricing decision.
- [`docs/07-cost-and-audience.md`](docs/07-cost-and-audience.md) — real server cost (500 TL/mo ≈ $10.39, shared across the engine + website + service — cost isn't the pricing constraint), and the target-audience question, deliberately deferred until real customer signal exists rather than guessed now.

## Standing architectural facts (referenced by more than one category doc)

- **`ip-insight-engine` publishes a `.mmdb` snapshot; `ipreadout-service`
  serves lookups directly from that file** — no live proxy call back to
  the engine per request. Measured throughput from a real `.mmdb`: 32,200–
  37,299 req/s sustained (engine repo's own `docs/91-benchmarks-and-saas-economics.md`).
- **`ipreadout-service`'s own server is written in Go**, not Node —
  reconfirmed 2026-08-25 (this was one of the facts from the earlier,
  lost planning pass). See `docs/02-architecture-and-data-flow.md` for why
  this isn't arbitrary: the language measurably outperformed Node in the
  engine's own benchmark, same server, client-side only.
- **Live-only fields** (reverse DNS, RDAP-derived abuse contact / geofeed
  discovery / network name) are not part of the `.mmdb` and are out of
  scope for launch — see the rate-limiting doc for why (RDAP's hard,
  non-scaling quota ceiling).
- **BGP origin data comes from RouteViews, not RIPE RIS** (since
  2026-11-08). RIPE never answered the 2026-08-25 logo-permission email,
  so the engine switched its default to RouteViews, whose commercial terms
  need no permission step. The Sources page must carry RouteViews' three
  required parts (statement + link, logo, boilerplate) — exact text in the
  engine repo's `docs/103-seo-and-attribution-discipline.md`, not
  duplicated here. One open point before launch: a written confirmation
  that the RouteViews logo may be used commercially (`docs/106`, B6).

## Not yet reconstructed

An earlier session gathered a "proven core" of facts for this plan before
this file itself was lost — those specific facts are not recovered here
and may need a separate pass to reconstruct, if they still matter. This
restart only contains what's been decided in the current conversation
thread; treat the absence of something here as "not yet captured," not as
"decided against."
