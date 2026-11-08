# Architecture & data flow

Written 2026-08-25. Captures what's already decided about how the two
projects fit together, plus the one real gap in that picture.

## Two separate things, on purpose

- **`ip-insight-engine`** — the data engine. Collects, enriches, flattens
  to `ip_intel`, and publishes a `.mmdb` snapshot (`mmdb build` / `mmdb
  publish`, already real and already built — see the engine's own
  `docs/50-features-shipped.md` and `docs/91-benchmarks-and-saas-economics.md`).
  Nothing about accounts, billing, or public API shape lives here.
- **`ipreadout-service`** — the commercial product. Owns the customer-facing
  API surface, accounts, rate limiting (`01-rate-limiting-and-abuse-protection.md`),
  and serves lookups by reading the engine's published `.mmdb` directly —
  it does not call the engine's HTTP API live, per request.
- **Separate repositories.** Confirmed explicitly, more than once in
  conversation: `ipreadout-service` will not be nested inside or share a
  repo with `ip-insight-engine`.

## Why `.mmdb`-only, not a live proxy

Two independent reasons, both already established:

1. **Cost/throughput is a solved problem for static data.** A real
   `.mmdb` (2.88M prefixes) served 32,200–37,299 req/s sustained on
   modest hardware — no network hop, no external dependency, scales with
   our own CPU only.
2. **Live-only fields have a hard, non-scaling ceiling.** Reverse DNS and
   RDAP-derived fields (abuse contact, on-demand geofeed discovery,
   network name) can't be baked into a static `.mmdb` at all, and RDAP
   specifically is capped by the RIRs themselves (the engine's own
   `rdapDailyQueryCap`, default 800/registry/24h, plus each RIR's own
   harder limits) — a ceiling that does not grow with how many paying
   customers we have. **Decision: these fields are out of scope for
   launch entirely**, revisited later behind their own opt-in parameter
   (see the rate-limiting doc).

## Server language: Go

Decided (confirmed 2026-08-25, from an earlier planning pass): `ipreadout-service`'s
own API server is written in **Go**, not Node. This isn't an arbitrary
pick — the engine repo's own `docs/91-benchmarks-and-saas-economics.md`
measured the language/runtime as mattering as much as the hardware itself:
the same Go `.mmdb`-serving server hit 26,384 req/s with a Node client vs.
82,768 req/s with a Go client, purely from client-side concurrency-model
differences. `bench-go/` (in the engine repo, built for that measurement)
already uses `github.com/oschwald/maxminddb-golang` for the actual `.mmdb`
reads — the natural starting point for `ipreadout-service`'s own reader
rather than picking a library from scratch.

**Real consequence for capacity planning**: because Go was already the
language benchmarked, the phone measurement (32,200–37,299 req/s, 8 ARM
cores) is a same-language reference point for the real target server, not
just a generic "some server somewhere" number — still needs re-measuring
on the actual 16GB/4-vCPU/10Gbit box once purchased (hardware differs,
language doesn't), but it's a meaningfully closer estimate than it would
be if the target language were still undecided.

## Hosting

**Same VDS as the engine, to start.** Decided earlier in this project's
planning, before this document existed: split onto separate
infrastructure once there's revenue to justify it, or move to a
self-hosted/homelab setup as an alternative path. Not urgent, not
blocking anything below.

## The one real open gap: how the `.mmdb` actually gets from the engine to the service

Both projects are on the same VDS for now, which makes this look trivial
— a local file path both processes can read. But this has never been
explicitly decided as a mechanism, and it stops being trivial the moment
hosting ever splits:

- Does `ipreadout-service` read the file directly off disk (same
  machine, shared path)?
- Does it watch for a new file and hot-swap, or restart on a schedule?
- What happens to in-flight requests during a swap?
- If infrastructure ever splits (see "Hosting" above), what replaces the
  shared file path — rsync, object storage, something else?

**Not decided. Worth deciding before writing the code that loads the
file**, even though today's same-VDS setup means it isn't blocking
anything yet.
