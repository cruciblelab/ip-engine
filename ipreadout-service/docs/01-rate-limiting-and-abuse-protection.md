# Rate limiting & abuse protection

Written 2026-08-25, capturing a design conversation before it gets lost the
way `PLAN.md` and `bench-go/` were lost once already. **Nothing here is
built** — `ipreadout-service` has zero product code as of this writing.
This is the decided design, plus what's still genuinely open, kept
separate so the two never blur together.

## Where this lives, architecturally

`ip-insight-engine` and `ipreadout-service` are two separate projects —
**separate repositories**, not one nested inside the other. Everything in
this file is `ipreadout-service`'s own layer. The engine's job stops at
publishing a `.mmdb` snapshot (`mmdb build` / `mmdb publish`, already real,
already built — see the engine's own `docs/91-benchmarks-and-saas-economics.md`).
`ipreadout-service` reads directly from that snapshot to answer lookups —
it does **not** proxy live HTTP calls back to the engine on every request.

**Why this matters for cost, with a real number behind it:** serving
straight from a `.mmdb` file was measured at 32,200–37,299 sustained
req/s on modest hardware (Go server, real 2.88M-prefix file, 8 ARM cores —
see the engine doc above). No network hop, no external rate limit, no
per-request cost beyond our own CPU. That's the number every decision
below assumes as the baseline cost of an ordinary lookup.

**Live fields are the one exception, and they're deliberately NOT in
scope for launch.** Fields that need a live query per request (reverse
DNS, RDAP-derived abuse-contact/geofeed-discovery/network-name) don't
come from the `.mmdb` at all — and RDAP specifically has a real, hard
ceiling that doesn't grow with customer count: the engine's own
`rdapDailyQueryCap` defaults to 800 queries/registry/24h, and RIPE/LACNIC
enforce their own limits on top of that regardless of what we set
ourselves. Decision: live fields ship later, opt-in, behind their own
parameter and their own (stricter) rate limit — not part of the initial
`ipreadout-service` surface. Exact parameter name and shape: **not decided
yet.**

## The three access tiers

### 1. Keyless (no account, no signup) — a real product feature, not just a safety valve

Anyone can call the API without an API key, up to a limit, as a genuine
"try it before you register" path — this is meant to be marketed, not
just tolerated.

- **100 requests/minute per IP.** (Corrected mid-conversation from an
  earlier "100/second" — that was a mistake, the real number is per
  *minute*.)
- Counted in Redis, keyed per IP.
- **System-wide circuit breaker**: if aggregate keyless traffic spikes
  abnormally above its recent rolling average — a DDoS-shaped signal —
  **all** keyless access is disabled at once, for everyone, not just the
  IP that triggered it. This was a deliberate choice, confirmed
  explicitly rather than assumed: a single bad actor pausing the free
  tier for everyone else is the accepted tradeoff for keeping the
  mechanism simple.
- That shutoff is a real, visible event: it gets reported on the Status
  page (`ipreadout-service`'s public status page, matching the "never
  fabricate, never hide a real incident" rule already set for that page)
  — never a silent internal-only log line.
- **Open / not decided yet:**
  - What counts as "abnormal above average" — no threshold or algorithm
    picked yet (a rolling window? how many standard deviations? over
    what time span?).
  - Whether the shutoff auto-recovers once traffic normalizes, or needs
    a manual re-enable.

### 2. Registered, free tier (has an account, hasn't paid)

- **500 requests/minute AND 10 requests/second**, both apply at once —
  the per-second number catches a sudden burst, the per-minute number
  catches sustained load a burst-only check would miss. Per account/API
  key, not per IP (an authenticated caller is identified by key, not
  address).
- Same Redis-backed counting mechanism as the keyless tier.

### 3. Paid plans

**Explicitly deferred** — "let's not move to paid plans yet" was said
directly. No tiers, no numbers, no feature gating by plan has been
discussed. Do not infer anything here from the free-tier numbers above.

## A second, different kind of abuse: not volume, pattern

Called out explicitly as distinct from the DDoS/volume circuit breaker
above: **long-running, sustained, low-and-slow request patterns that
don't spike in volume but still exist purely to waste capacity** — e.g.
one caller grinding through requests for hours with no apparent purpose,
never fast enough to trip a rate limit, never enough of a spike to look
like a DDoS. Identified as a real, separate detection problem worth
solving. **Design not started** — no algorithm, no signal set, no
threshold. This section exists so the *need* isn't lost before the
*design* happens.

## Cloudflare — the outer layer, not a replacement for the above

Confirmed directly against Cloudflare's own material (2026-08-25), not
assumed:

- **L3/L4 (network-layer, volumetric) DDoS mitigation is unmetered and
  automatic on every plan, including Free.** Covers API traffic the same
  as any other traffic through the proxy — nothing API-specific needs
  configuring for this layer to apply.
- **L7 (application-layer) protection**: basic coverage on Free by
  default; more granular/advanced L7 rules are a Business/Enterprise
  feature.
- **Rate-limiting rules**: sources were inconsistent on exactly what
  Free/Pro include today (some material says rate limiting is now bundled
  into more plans than it used to be) — **re-check Cloudflare's current
  plan page directly when it's time to actually configure this**, don't
  trust this document's snapshot of a fast-moving pricing page.

**How the two systems relate**: Cloudflare sits in front as the blunt,
high-volume filter (stops a large flood before it reaches our servers at
all); the Redis-based tiers and the (not-yet-designed) pattern detector
above are the fine-grained, application-aware layer behind it. Neither
replaces the other.

## Summary table

| Tier | Limit | Identified by | Enforcement |
|---|---|---|---|
| Keyless | 100 req/min | IP address | Redis counter; system-wide shutoff on abnormal spike |
| Registered, free | 500 req/min + 10 req/s | API key | Redis counter |
| Paid | Not designed | — | — |
| Live-field requests (opt-in) | Separate, stricter — not yet numbered | API key + parameter | Not designed |
| Pattern-based (low-and-slow) abuse | Not designed | — | — |

## What's genuinely decided vs. open, at a glance

**Decided:**
- Three access tiers exist (keyless / registered-free / paid-deferred).
- The two numeric limits above (100/min keyless; 500/min + 10/s
  registered-free).
- Redis as the counting mechanism.
- A keyless-wide (not per-IP) shutoff on detected abuse, reported on the
  Status page.
- `.mmdb`-only serving for launch; no live-proxy architecture to the
  engine.
- Live fields are out of scope for launch, ship later behind their own
  gate.
- Separate repositories for the engine and the service.

**Open:**
- Abnormal-traffic threshold/algorithm for the keyless shutoff.
- Auto-recovery vs. manual re-enable after a shutoff.
- The live-field opt-in parameter's name and shape, and its own rate
  limit numbers.
- The low-and-slow abuse pattern detector — entirely undesigned.
- Paid-tier limits and feature gating.
- Cloudflare's exact current rate-limiting entitlement per plan (re-check
  at implementation time).
