# Real cost, and the audience question — deliberately left open

Written 2026-08-26.

## Real infrastructure cost

The planned server: 16GB RAM / 4 vCPU / 10Gbit port, **500 TL/month**
(≈ $10.39/month at the 2026-08-26 rate, 1 USD ≈ 48.12 TRY — verified live,
not assumed). This single box runs `ip-insight-engine` (Postgres +
collection/enrichment), the website, and `ipreadout-service` together —
confirmed explicitly, not the full 16GB dedicated to the API alone.

**What this means for pricing**: at this cost level, server spend is not
the constraint on what we can charge — almost any reasonable price point
in the competitive range found in `06-competitive-positioning.md` clears
this cost with enormous margin. The real pricing question is market
positioning and perceived value, not covering infrastructure.

**What's still a real unknown, not glossed over**: how much of that
16GB/4-vCPU is actually available to `ipreadout-service`'s own serving
process once Postgres and the engine's periodic collection/enrichment
jobs take their share. `.mmdb` serving itself is lightweight (a
memory-mapped file, small relative to 16GB) — the likely real contention
is with Postgres, not with the API server itself. **A real answer needs a
benchmark run under realistic shared load** (collection/enrichment
actually running at the same time as the API is being hit) once the
server exists — an isolated best-case test (like the phone benchmark)
would overstate real capacity.

## The audience question — deliberately deferred, not answered

Raised directly: should `ipreadout-service` position itself toward
network/threat-intel/infrastructure teams (the audience our real
differentiators — RPKI, route anomaly, neighborhood, ASN profile —
actually speak to), or toward a broader, general-purpose API-consumer
audience (the ipinfo/ipapi/ipgeolocation-style buyer)?

**Answer given: "gerçekten bilmiyorum"** — genuinely undecided, and
correctly so — there's no real customer data yet to ground a bet on
either audience.

**Working default, not a final decision**: don't force the choice now.
Structure the product so it naturally serves both without picking a side
upfront:
- A **base tier** — standard geo/ASN/usage-type, competitive with the
  table-stakes features every provider in `06-competitive-positioning.md`
  already offers. Speaks to the general-purpose audience.
- A **higher tier** — the genuinely differentiated signals (RPKI,
  route_anomaly, neighborhood, asn_reach/profile). Self-selects for the
  network/security-minded audience without requiring separate marketing
  or a branding commitment either way.

**The actual audience answer is deferred to real signal**: once live,
whichever tier/features real paying customers actually choose answers
this question with evidence instead of a guess. Revisit this doc once
that data exists — don't re-litigate the question from a standing start
before then.
