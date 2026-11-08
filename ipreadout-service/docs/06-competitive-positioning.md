# Competitive positioning

Researched 2026-08-25/26, live from each provider's own pricing page (not
recalled from memory — pricing pages change often enough that a stale
number would be worse than useless). This is positioning input, not a
pricing decision — pricing numbers stay deferred, as already decided
elsewhere in this plan.

## The 7 providers researched, condensed

| Provider | Free tier | Entry paid tier | Pricing model |
|---|---|---|---|
| ipinfo.io | Unlimited, country-only | $26/mo, 150k req/mo | Flat tiers |
| MaxMind | GeoLite2 DB unlimited (not the web API) | Pay-per-query: $0.0001–$0.002/query | Credit-based, not tiered |
| ip-api.com | 45 req/min, non-commercial only | ~€13.3/mo, unlimited | Flat, unusual (unlimited paid tier) |
| ipapi.com | 100 lookups/mo | $12.99/mo, 50k/mo | Flat tiers |
| ipdata.co | 1,500/day, non-commercial | $10/mo, 2,500/day | Flat tiers |
| IPQualityScore | 1,000/mo | $99/mo minimum, 5,000/mo | Flat tiers, fraud-platform pricing |
| IP2Location.io | 50,000/mo | $49/mo, 150k/mo | Flat tiers |
| ipgeolocation.io | 1,000 credits/day | $19/mo, 150k/mo | Flat tiers, credit-weighted |

Two real outliers worth remembering, not averaging away: **MaxMind's
per-query credit model** (no tiers at all below $2,500/mo volume) and
**ip-api.com's unlimited-at-one-flat-price** model are structurally
different from the "quota + overage" shape everyone else uses. Worth
deciding which shape fits us, not just what number, when pricing gets
designed for real.

## What nobody else advertises, on their own pricing pages

**Not one of the seven states a specific city-level accuracy percentage**
on their pricing/product page — they lean on uptime %, coverage %, and
request-volume stats instead. We already have real, measured numbers
with honest caveats attached (from the engine's own `docs/101`): 86.4%
exact city on Google Cloud, 78.1% T-Mobile, 76.2% Charter, 53.4% NTT,
country right 81–98% everywhere, and an explicit statement of *at what
granularity* (~/24) that accuracy holds. Being the one honest about a
number others don't publish is either a genuine differentiator or a way
to look less confident than competitors who simply don't say — worth a
real conversation about how to frame it, not an assumption either way.

## What's genuinely ours, not matched by anything researched

- **RPKI route-validity signal** — cryptographic (RFC 6480), not
  reputational. None of the seven mention anything like it.
- **`route_anomaly`** — the wider-prefix + RPKI-invalid synthesis that
  flags the shape of a possible route hijack. Nothing comparable found.
- **`neighborhood`** — flagged-neighbor counts per /24 (IPv4) / /48
  (IPv6). Not offered by anyone researched.
- **`asn_reach` / `asn_profile`** — per-ASN country footprint, RPKI
  hygiene, cloud/bot composition. MaxMind's `user_type` is the closest
  thing found anywhere, and it's a single classification, not this
  breadth.
- **A risk score that's a named, auditable composite** ("every point
  traces to a reason") rather than a black-box model — a real, deliberate
  contrast to IPQualityScore's "Fraud Fusion™"-style framing, not
  incidental.
- **`verified_bot`** against 8+ operators' own published crawler lists
  (Google, OpenAI, Anthropic, Microsoft, Apple, Perplexity, Ahrefs,
  Common Crawl) — not found as a named feature on any of the seven
  pricing pages.

## What's table stakes — we match it, nobody should expect a premium here

Geolocation (city/region/country/coordinates/timezone), ASN/ISP name,
basic Tor detection, usage-type-style classification (residential/
mobile/hosting/cdn), reverse DNS. Every competitor researched has some
version of all of this even on entry paid tiers, several on free tiers.

## What we deliberately don't have, and why — said plainly rather than glossed over

- **Residential proxy detection** (ipinfo Max, IPQualityScore SMB+,
  IP2Location Plus) — requires behavioral telemetry across many
  customers' live traffic. Already documented in the engine's own
  `SOURCES.md` as architecturally out of reach for a bulk-data project,
  not a gap to close by trying harder.
- **Named multi-provider VPN detection** (MaxMind Insights' "NordVPN,"
  etc., IP2Location's VPN/CPN/EPN breakdown) — we only cover providers
  that publish their own relay list (Mullvad). A provider that doesn't
  publish is invisible to us by design, not by oversight.
- **Company/firmographic data** (ipinfo Enterprise) — no free
  bulk-redistributable source exists; PeeringDB (the obvious candidate)
  forbids commercial use outright. Already ruled out in `SOURCES.md`.
- **Fraud-platform breadth** (IPQualityScore's device fingerprinting,
  email/phone/URL validation, mobile SDK) — a different product
  category entirely, not an IP-intelligence gap.
- **Weather/elevation/currency-style extras** (IP2Location) — not
  pursued; low signal value for what this product is actually for.

## Where this leaves positioning (not pricing)

The honest read: we are not the cheapest broad-geolocation option (ip-api.com,
ipapi.com, ipgeolocation.io compete hard on price for plain geo+ASN), and
we are not a fraud-platform competitor to IPQualityScore. The real gap in
the market this fills is closer to **"the IP API for people who also care
about routing/network trust signals"** — RPKI, route anomaly, ASN
reach/profile, neighborhood context — layered on solid, honestly-labeled
geolocation, aimed more at network engineers, threat-intel and
infrastructure teams than at the fraud/marketing-analytics buyers
IPQualityScore and ipinfo's higher tiers target.

**Not decided here**: whether to lead marketing with that routing-security
angle, price to compete on the broad-geolocation table-stakes segment
instead, or something in between. That's a real positioning call for
whenever pricing itself gets designed — this doc is the input, not the
decision.
