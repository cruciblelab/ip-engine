# 99 — DB-IP Lite IPv6 support (opt-in, `dbipLiteIpv6`)

Built 2026-08-23, the deferred half of the DB-IP Lite source added earlier
the same day (see `SOURCES.md`, "Implemented — DB-IP Lite as a middle
geo-confidence tier"). That entry recorded IPv6 as postponed because
turning `ip_start,ip_end` address pairs into `inet` rows needs 128-bit
range→CIDR splitting, and this project only had the 32-bit version.

**This is a gap in one source, not a project-wide IPv6 stance.**
`ip_blocks`, `bgp_origin_ranges` and `geofeed_ranges` have always carried
both families in the same native `inet` column.

## Off by default, and why that is a measured decision

`dbipLiteIpv6` defaults to **false**. Real numbers behind that, measured
against the actual DB-IP file on 2026-08-23:

| | IPv4 half | IPv6 half |
|---|---|---|
| Ranges in the file | ~4.0M | **4,274,502** |
| Rows after CIDR splitting | 6,249,662 | **8,477,693** (1.98x expansion) |

Every one of those rows also becomes a base row in `ip_intel` — the same
mechanism that took `ip_intel` from ~3.2M to 8,766,736 prefixes when the
IPv4 half landed, and produced a `history capture` slow enough to be
reported as a problem. Enabling IPv6 roughly doubles this source again.

That is a real trade, not a free win. IPv6 geo coverage from operator
geofeeds is genuinely sparser than IPv4's, so this fills proportionally
more gaps — but it is paid for in rebuild time on whatever machine runs
the pipeline. Left off so the cost is opted into deliberately, the same
call `mmdbHistoryFields` and `routeAnomalyEnabled` already make.

Enable with `"dbipLiteIpv6": true` in `ip-insight.config.json`, then re-run
`ip-insight enrich --sources dbip-lite`. `ip-insight config` prints the
current setting with its cost next to it.

## Removing it

Three levels, each self-contained:

1. **Turn it off** — set `dbipLiteIpv6: false` (or delete the key). The next
   run stops inserting IPv6 rows. Because this source fully replaces its own
   table each run, previously-ingested IPv6 rows disappear on that run too;
   nothing needs cleaning up by hand.
2. **Remove the wiring** — in `enrichment.ts`'s `ingestDbIpLiteCsv`: the
   `wantIpv6` line, the `if (family === 6 && !wantIpv6)` branch, and the
   `family === 6` arm of the CIDR conversion. Then the flag itself, which
   lives at five sites in `packages/collector/src/config.ts` (interface
   field, `DEFAULTS`, the no-config-file branch, the `parseBooleanValue`
   call, the returned object), the key in `ip-insight.config.json`, and the
   display line in `apps/cli/src/index.ts`'s `config` command.
3. **Remove the code** — delete `packages/shared/src/ipv6-range.ts`, its two
   test files, and the `export * from "./ipv6-range"` line in
   `packages/shared/src/index.ts`. Also drop the `pg`/`@types/pg`
   **devDependencies** added to `packages/shared/package.json` purely for the
   Postgres-oracle test (they are dev-only on purpose — `@workspace/shared`
   must stay importable from DB-free code paths like `collect --csv`).

That list is the result of an actual `grep` audit across `packages/` and
`apps/`, not an assumption — the first draft of these instructions missed
the CLI display line and the config-flag sites, which is exactly the failure
mode this discipline exists to prevent. The only other hit is a comment in
`config.ts` pointing here.

Nothing else references any of it. IPv4 ingestion, every lookup, `ip_intel`,
`.mmdb` export and the whole `bgp-live` path are untouched by all three
steps, because none of them ever call in.

### Removing the whole DB-IP Lite tier (not just IPv6)

A separate, larger removal, listed here because the audit above surfaced its
true blast radius too: `packages/db/src/schema/dbipLiteRanges.ts` (+ its
`index.ts` export), the `dbip` LATERAL join and its three `geo_source`
references in `packages/db/src/views/ip-intel.ts`, the `dbip-lite` entries in
`enrichment-sources.ts` and `sources-registry.ts`, `ingestDbIpLiteCsv` and
its dispatch case in `enrichment.ts`, the `dbip_lite` lookup feature in
`packages/lookup/src/config.ts`, the query and geo-chain branch in
`packages/lookup/src/lookup/lookup.ts`, `geo-tiers.integration.test.ts`, and
the `dbip-lite` enum value in `packages/api-spec/openapi.yaml` (then
re-run codegen). Or simply drop `dbip_lite` from `lookupFeatures` and stop
running the source — the cheap version, which leaves geo back at
geofeed/country-estimate.

## How it was verified

Range→CIDR splitting is bit math, and `docs/95-mmdb-trie-subdivide-bug.md`
is this project's record of what bit math that "looks right" can silently
do. So the splitter is a deliberate structural port of the proven
`rangeToCidrs` in `ip.ts` — same loop, same invariants, only the numeric
type and width changed — and it was checked four ways:

1. **Unit tests** (`ipv6-range.test.ts`, 17 cases): parse/format round-trip
   across all 128 bit positions, `::` compression in every position,
   embedded-IPv4 tails, malformed-input rejection, and an *exhaustive*
   exact-coverage check over every range in 0..40 × 0..40 plus every 16-bit
   group boundary.
2. **Postgres as an independent oracle**
   (`ipv6-range.integration.test.ts`): the emitted CIDR strings are handed
   to Postgres, which decides using its own `inet` implementation whether
   they tile the requested range exactly. A bug would have to exist
   identically in two unrelated implementations to survive this.
3. **Real data at scale**: 20,000 ranges sampled across the real 4.27M-row
   file, split by the real code, verified by Postgres — **39,306 CIDRs, all
   exact, 0 unparseable**. (Run as a temporary test against a local copy of
   the file; not kept in the suite, since it depends on an 87 MB download.)
4. **The whole file parsed**: all 4,274,502 IPv6 rows parsed with zero
   failures during the volume measurement above.

### Three bugs found — all of them in the verification, none in the splitter

Worth recording, because it is the argument for bothering with an
independent oracle at all:

- A test asserted `::ffff:01.2.3.4` should be rejected; the parser accepted
  it. Checked what the actual consumer does — Postgres rejects it outright
  ("invalid input syntax for type inet") — so **the test was right and the
  parser was tightened** to refuse leading-zero octets. Note this makes it
  deliberately stricter than `ipv4ToInt` in `ip.ts`, which still accepts
  them; that function is on the RIR path, whose files do not contain the
  form, and changing it is a separate task with its own blast radius.
- The Postgres check reported correct splits as non-contiguous. Cause:
  `inet` equality includes the netmask, so `2001:db8::4/127` and
  `2001:db8::4/126` — the same address, which is exactly what adjacent
  blocks look like — compare unequal. Fixed by comparing `host()` text.
- The Postgres check then reported a wrong start address. Cause: `host()`
  returns *text*, and `min()` over text is lexicographic, where `::1000`
  sorts below `::259`. Fixed by taking `min`/`max` over `inet` (numeric)
  and using `host()` only for the equality. Both traps are now written
  into the query's own comment so the next reader does not rediscover them.

The splitter itself was correct from the first run and never changed.

## A separate, larger bug this work uncovered

While verifying the IPv6 path end to end, a real gap in the *original*
DB-IP Lite integration surfaced — one that had nothing to do with IPv6 and
would have shipped silently.

DB-IP Lite had been wired into `ip_intel` only. That relation feeds the
`.mmdb` export and direct SQL consumers, and the four precedence scenarios
were verified against it with raw SQL, which passed. But `packages/lookup`
— the live path behind `ip-insight lookup` and the API server's
`/lookup/ip/{ip}` — queries the source tables directly rather than reading
`ip_intel`, and it had never been touched. The result: the same address
answered `Overland Park, Kansas [dbip-lite]` from the published file and
`city: null, geo_source: null` from the API.

Caught only by running a real `lookup` against real ingested data, which is
also why the earlier instruction to check for `[dbip-lite]` in the CLI
output would have come back empty.

Fixed by adding the tier to the live path with the same precedence
(geofeed > dbip-lite > country-estimate), the same anycast suppression, a
confidence of 0.5 (between the geofeed's ~0.85 and the country-estimate's
0.2), and its own `dbip_lite` lookup feature so it can be switched off.
`geo_source: "dbip-lite"` was added to the OpenAPI enum and the generated
clients regenerated — it is part of a public API contract, not an internal
detail.

`geo-tiers.integration.test.ts` now pins all five behaviours *through
`lookupIp()` itself*, so the two halves of the product cannot drift apart
again without a test going red.

**A second, smaller bug came out of the same test.** The first version
preferred the RIR's country while taking DB-IP's city, which on real data
produced `2001:4:112::` → "Amsterdam, North Holland, **US**": city and
region from DB-IP (the instance genuinely is in Amsterdam), country from
ARIN (which administers AS112). Each half defensible, the combination
nonsense. Now whichever source supplies the city supplies the country with
it — matching what the geofeed branch already did.

## Cost/shape of the data, for reference

- 63.7% of IPv6 ranges need exactly one CIDR (already power-of-two aligned).
- 98% need eight or fewer.
- 0.28% need more than 16.
- Worst real case observed across all 4.27M ranges: **105 CIDRs**, for
  `2a19:3e0:ff70::2 – 2a1b:3e0:1300::3`. Pinned as a test case.

That measured ceiling is why there is no artificial cap on pieces-per-range:
one would never fire on real data, and skipping a range for being awkwardly
aligned would lose real coverage for nothing. The loop is inherently bounded
anyway — each iteration consumes at least one address and the block size can
at most double 128 times.

Throughput: ~34,000 ranges/sec (parse + split), ~125 seconds for the whole
IPv6 half — against an ingestion step whose IPv4 half already takes ~14
minutes, so the BigInt arithmetic is not the bottleneck.
