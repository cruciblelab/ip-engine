# Features shipped this project (route_anomaly, classify-test, and others)

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Group B (2026-08-04): query-merging, measured, then a decision on #7](#group-b-2026-08-04-query-merging-measured-then-a-decision-on-7)
- [Two more findings fixed (2026-08-04): the memory-risk pair](#two-more-findings-fixed-2026-08-04-the-memory-risk-pair)
- [Task #40 implemented and verified (2026-08-04) — with a correction to the original finding](#task-40-implemented-and-verified-2026-08-04-with-a-correction-to-the-original-finding)
- [Task #41 implemented and verified (2026-08-04): `asn_profile` exposed via `ip-insight asn`/`GET /api/lookup/asn/:asn`](#task-41-implemented-and-verified-2026-08-04-asn-profile-exposed-via-ip-insight-asn-get-api-lookup-asn-asn)
- [Round 2 candidates, implemented and verified (2026-08-04)](#round-2-candidates-implemented-and-verified-2026-08-04)
- [`route_anomaly` shipped — plus a real lesson about handing a long verification pass to a background agent (2026-08-06)](#route-anomaly-shipped-plus-a-real-lesson-about-handing-a-long-verification-pass-to-a-background-agent-2026-08-06)
- [`classify-test` CLI command — formalizing the audit-script workflow (2026-08-06)](#classify-test-cli-command-formalizing-the-audit-script-workflow-2026-08-06)

---

### Group B (2026-08-04): query-merging, measured, then a decision on #7

Two mechanical merges — "merge redundant round trips first, then re-measure
before deciding whether the big, risky GiST→trie rewrite (#7) is actually
needed" — per the plan agreed this session.

**#8 — `ip_intel`'s `bgp`/`wider` LATERALs merged into one.** Both did their
own separate GiST probe of `bgp_origin_ranges` for the same base row (one
for the narrowest containing prefix, one for the narrowest *wider*,
different-ASN one) — redundant, since every prefix containing a given
address forms one nested chain, so both answers are two positions in a
single ordered walk of the same candidate set. Merged via a `row_number()`
CTE (materialized by Postgres since it's referenced twice), so the
expensive GiST scan runs once per base row instead of twice.

*Real-data verification*: built `ip_intel` as a view against this sandbox's
real `bgp_origin_ranges`, confirmed the known golden example
(`213.221.128.41` → AS65205 inside AS15547's wider block, RPKI invalid)
still resolves identically. `EXPLAIN (ANALYZE, BUFFERS)` on two independent
addresses:

| Address | Old (two LATERALs) | New (merged) | Reduction |
|---|---|---|---|
| 213.221.128.41 | 783 buffer hits, 20.6ms | 396 buffer hits, 8.6ms | ~49% buffers, ~58% time |
| 1.1.1.1 | 862 buffer hits, 8.0ms | 445 buffer hits, 4.7ms | ~48% buffers, ~42% time |

**#10 — `lookup.ts`'s sequential ASN-resolution chain merged, plus a country-
estimate cache.** `resolveAsnLocal` (bgp match) and `lookupAsnMeta` (org
name/type/country from `asn_blocks`) were two *strictly dependent* round
trips (the second needs the ASN number the first produces) — merged into
one statement via a `LEFT JOIN LATERAL`. More significantly: the
"wider-prefix" query that used to live in `lookupIp()` itself ran as a
*third*, fully separate query on **every single call, cache hit or not** —
`PrefixAsnEntry` (what `prefixAsnCache` actually stores) had nowhere to
carry that fact. It's now computed inside the same merged statement and
cached as `widerAsn` on the entry, so a cache hit costs zero extra queries
for it instead of one guaranteed one.

Separately, `geoForCountry()` (a `geonames_places` query keyed only by ISO
country code — same answer for every IP sharing a country, of which there
are ~250) ran as a real DB round trip on every call regardless of whether a
geofeed had already answered city/postal (it's still needed there as a
region/timezone fallback, so "skip it when geofeed answers" — the audit's
literal suggestion — would have silently broken that fallback; caching by
country code instead gets the same round-trip elimination without changing
the fallback behavior). `LRUCache` (the class from the #4 fix) was promoted
from `lookup.ts` into `@workspace/shared` so `geo-meta.ts` could reuse it
without duplicating a second copy.

*Real-data verification*: `prefixAsnCacheStats()` before/after a repeated
lookup of a real IP confirmed a genuine cache hit (`positive.hits: 0 → 1`)
with `wider_prefix_asn` identical across both calls, no separate query
firing on the cached path (structurally guaranteed — reading `.widerAsn` is
a plain field access now, not a query). `geoForCountry("TR")` timed twice:
**289ms cold (real GeoNames query, correctly resolved to Istanbul) → 0ms
cached**, results identical; an unrecognized code (`"ZZ"`) confirmed to
cache its `null` result too rather than re-querying forever.

All of Group B typechecked and passed the full test suite (68/68) after
each step, not just at the end.

**The #7 decision, with the evidence actually in hand**: the measured wins
above are real but narrow — they cut redundant *round trips* for the ASN
lookup specifically, not the underlying GiST-on-nested-CIDR weakness
itself, which independently affects each of `ip_intel`'s other ~7 LATERAL
joins (`blk`, `gf`, `cl`, `th`, `sp`, `ac`, `roa`) against their own
tables. A true before/after timing of the full ~4.7h materialized rebuild
wasn't attempted here — that costs hours either way, and this sandbox has
already twice failed to sustain a background process that long (see
above). Recommendation, not yet acted on: hold off on #7 (the GiST→trie
rewrite — the single largest-effort, highest-risk item in the whole list)
until real-scale timing exists from the *actual* target hardware (the VDS,
not this sandbox or the phone, which was always described as the
temporary environment). A multi-hour rebuild is still well inside a
24-hour capture cadence even if not fast, and the deeper rewrite's real
necessity should be judged against what the VDS actually measures, not
extrapolated from a sandbox already known to be unusually constrained.

### Two more findings fixed (2026-08-04): the memory-risk pair

- **`prefixAsnCache` unbounded growth (#4)** — the Map with no eviction that
  all three audit agents found independently. Replaced with a bounded
  `LRUCache<V>` (the class `lookupCache` already used, generalized and
  shared). Fixing this surfaced a second, worse, previously-unnoticed bug:
  positive entries were stored under `entry.prefix` while every read looked
  up by the raw queried `ip` — two different strings that never match, so
  the positive-path cache never actually hit *anything*; every resolution,
  cached or not, hit the database. Fixed by keying both positive and
  negative caches consistently by `ip`. Verified for real: called
  `lookupIp()` for a real IP, cleared the outer result cache to force
  re-entry into ASN resolution without touching the ASN cache, called it
  again — `prefixAsnCacheStats().positive.hits` went from 0 to 1 (would
  have stayed 0 under the old code).
- **RPKI VRP ingestion memory peak (#12)** — the old path buffered the
  entire response as one string, `JSON.parse`'d it into one full object
  tree, then built a third array of transformed rows — three copies of the
  same ~900K-row feed alive at once, measured at ~1.4GB peak by the audit.
  Rewritten to stream: `stream-json`'s "web" build (the flavor that
  operates on WHATWG `ReadableStream`/`TransformStream` directly, matching
  how every other reader in this file already consumes `response.body` —
  no Node-`Readable` conversion needed) pipes the body through a SAX-style
  parser, picks out the `roas` array, and yields one object at a time;
  `batch` never holds more than `BATCH_SIZE` (2000) rows, same discipline
  every line-streamed source in this file already follows. The "refuse to
  wipe the table for an empty/malformed feed" safety check (previously
  `roas.length === 0`) now works by peeking one item ahead of the delete
  instead of checking the whole array's length upfront — same guarantee,
  bounded memory. **Verified against the real upstream feed**, not a
  synthetic one: `console.rpki-client.org/vrps.json` (~100MB, ~980K ROAs),
  run end to end with RSS sampled every 2s throughout — peak **~220MB**,
  979,351 rows ingested (4,050 skipped as malformed), matching the
  pre-existing row count in this sandbox's own table. Roughly a 6-7x
  reduction from the audit's measured 1.4GB, on the actual production feed.

Also researched and documented properly rather than left as a guess (the
existing entry was thinner than every other row in the license tables):
**RPKI VRP licensing**. No written license or terms-of-use found anywhere
in the chain (`console.rpki-client.org` itself, or the underlying five RIR
repositories) — weaker evidence than a written grant, but RFC 6480's
design requires this data be openly, continuously machine-fetchable by
every relying party globally (that's the entire point of the security
model), and rpki-client's own site states its output is produced "for
consumption by other routing stacks." Treated the same as the no-license-
text-but-published-for-exactly-this-purpose geofeeds (Google/NTT/Cogent/
Vultr/Telia/DigitalOcean) already accepted in this same document — see
SOURCES.md's "Layer 7" section for the full reasoning.

### Task #40 implemented and verified (2026-08-04) — with a correction to the original finding

Built while the phone's `cycle` was mid-`materialize`, since this is pure
sandbox work with no dependency on that run.

**A correction to the original write-up first, found while implementing
it rather than assumed.** The deferred note above said a build could go
bad with "`network_name`/`rir` silently null across the board." Rereading
`mmdb-export.ts`'s `IntelRow`/`toRecord()` to build this properly: **those
two fields were never in the `.mmdb` export's column list at all** — the
file only ever carried `network_name`/`rir` (with `found: false`) as part
of the *live* `lookup.ts`/API path, which is a separate implementation
reading `ip_blocks` directly (see this project's own documented
architecture: `packages/collector` builds data, `packages/lookup` is one
interpretation of it, and `mmdb-export.ts` is a third, deliberately
narrower one — "the facts a caller acts on," not every column `ip_intel`
has). The specific two-field example that started this thread was a
conflation with the same day's separate `found: false` investigation
(a real but different, already-closed non-bug). The actual blind spot —
golden set pins down only 3 of the ~15 fields the file does carry, and
`prefix-count` can't see field content — was real regardless, so the fix
below still generalizes correctly; it's just built against the real field
list (`city`, `region`, `postal`, `location`, `geo_source`, `asn_name`,
`asn_size_rank`, `cloud_provider`, `rpki_status`, `special_purpose`,
`verified_bot_operator`, `stable_since` when enabled), not the two named
in the original note.

**What was built:**
- `mmdb-export.ts`'s `exportMmdb()` now tallies how many entries carry
  each field while it builds them (the same loop that already builds
  `entries`, one extra counter bump per key — no second pass over the
  data) and returns it as `fieldCounts: Record<string, number>`.
- `ops.mmdb_publishes` gained a `field_counts` jsonb column, written on
  every build attempt (published or rejected) alongside the existing
  `prefixes`/`checks` columns — the natural home, since `prefix-count`
  already reads this same table's previous *published* row for its own
  comparison.
- `mmdb-publish.ts`'s `validate()` adds one `field-completeness:<field>`
  check per field, comparing this build's raw count against the previous
  *published* build's count (same `minPrefixRatio`-style floor, 80% by
  default, independently overridable via a new `minFieldRatio`). Two
  fields are deliberately skipped, not failed: anything the golden set
  already asserts (computed from the golden set actually in use, not
  hardcoded — a deployment with a custom `goldenSetPath` gets the right
  skip set automatically), and any field with no previous count at all
  (a field appearing for the first time, e.g. turning `mmdbHistoryFields`
  on, or a `mmdb_publishes` row from before this feature existed — both
  read as "nothing to regress from," not a failure).

**Verified for real**, without paying for a full materialize (this
sandbox has already died twice attempting that — the phone's own real
2.5h run is the only full-scale timing this project trusts, see above).
`validate()` was exported specifically so it's testable against a real,
small, synthetic `.mmdb` and real `ops.mmdb_publishes` rows without
routing through the hours-long `exportMmdb()` path — a genuine cost/value
call given the constraint, not a substitute for real infrastructure: the
schema push, the DB round-trip, and the ratio math are all exercised
against the actual local Postgres, only the input data is synthetic.
`packages/collector/src/export/mmdb-publish.integration.test.ts`, both
passing:
1. A synthetic "previous publish" (1,000 rows; `city: 800`,
   `rpki_status: 950`, plus golden-covered `asn`/`country`/`verified_bot`
   at full and partial counts) against a candidate holding the same row
   count but `city` collapsed to 200 (25%, real regression) while
   `rpki_status` held at 940 (99%, fine): `field-completeness:city` comes
   back `ok: false`, `field-completeness:rpki_status` comes back
   `ok: true`, and — the specific thing this whole fix exists to prove —
   **no `field-completeness:asn`/`:country`/`:verified_bot` checks appear
   at all**, regardless of how far their raw counts moved, because the
   golden set already covers them.
2. A field with zero prior appearances (`stable_since`, simulating
   `mmdbHistoryFields` being switched on for the first time) produces no
   check at all rather than a false "0% of previous" failure.

Full suite still green after this (`pnpm run typecheck`, `pnpm exec
vitest run` — 9 files, 70 tests, including the 2 new ones). Not yet run
against a real full mmdb build (needs a materialized `ip_intel`, which
this sandbox can't sustain) — that's the natural next real-world check,
whenever the phone next runs `ip-insight mmdb publish` after pulling this
update: the first run after upgrading will have no `field_counts` on its
"previous" row (older builds predate the column) and skip every
field-completeness check, exactly as designed; the run *after* that is
the first one that actually exercises it live.

### Task #41 implemented and verified (2026-08-04): `asn_profile` exposed via `ip-insight asn`/`GET /api/lookup/asn/:asn`

Same sandbox-only, phone-independent work, continued right after Task #40
while the phone's `cycle` was still mid-`materialize`.

**What was built:** `lookupAsn()` (`packages/lookup/src/lookup/lookup.ts`)
used to read only `asn_blocks` (name/type/country/rir/registeredDate) —
`asn_profile` was computed every enrichment run and read by nothing. It
now also queries `asn_profile` by exact ASN number, concurrently with the
existing `asn_blocks` range query (`Promise.all` — the two don't depend on
each other, and `asn_blocks` is matched by `asnStart <= asn <= asnEnd`
while `asn_profile` is one row per exact ASN, so they were never going to
be one join anyway). New `AsnInfo.profile: AsnProfileInfo | null` field:
`countryCount`, `primaryCountry`, `rpki: {validPrefixes, invalidPrefixes,
unsignedPrefixes}`, `cloudPrefixes`, `torAddresses`, `vpnAddresses`,
`botPrefixes`, `computedAt`. `null`, not an empty object, when an ASN
hasn't been through an `asn-profile` enrichment pass yet — a real,
distinct case from "profile says zero everything."

Both the existing `ip-insight asn <number>` CLI command and
`GET /api/lookup/asn/:asn` picked this up **for free** — both just
serialize whatever `lookupAsn()` returns, no route/command code changed
beyond a doc-comment update on the API route. That's it for "eventually
API" from the original note; nothing further to build there.

**Verified for real**, sandbox Postgres came back up after an unrelated
mid-session restart (same known sandbox instability documented below —
`pg_ctlcluster 16 main start` after a stale pidfile, data intact
afterward, nothing lost):
```
$ ip-insight asn 15169 --json
{"asn":15169,"name":"GOOGLE - Google LLC, US", ...,
 "profile":{"countryCount":6,"primaryCountry":"US",
   "rpki":{"validPrefixes":1375,"invalidPrefixes":4,"unsignedPrefixes":0},
   "cloudPrefixes":0,"torAddresses":0,"vpnAddresses":0,"botPrefixes":9,
   "computedAt":"2026-07-28T09:05:21.014Z"}}

$ ip-insight asn 11 --json   # Harvard — has an asn_blocks row, never profiled
{"asn":11,"name":"HARVARD - Harvard University, US", ..., "profile":null}
```
Matches the real `asn_profile` table rows queried directly via `psql` for
the same three ASNs (15169/13335/16509) used as SOURCES.md's own worked
example. `pnpm run typecheck` and the full `vitest run` (9 files, 70
tests) both green afterward.

**A related, smaller gap noticed while doing this, not fixed here — added
to the standing list below rather than bundled in silently:** `asn_reach`
(the "how big" counterpart to `asn_profile`'s "what kind") is *already*
imported into `lookup.ts` and used inside the per-IP `lookupIp()` path
(`asn.asn_size_rank`, `wider_prefix_asn`, etc.), but the same standalone
`lookupAsn()` this task just touched still doesn't include it — so
`ip-insight asn <number>` today answers "what kind of network" but not
"how big is it" (announced prefixes, address space, route-collector
visibility), even though that data exists and is one query away, same
shape as what was just added. Left out of this task deliberately — it
wasn't what was asked, and bundling it in unrequested would have been
scope creep on a task that was already clearly scoped to `asn_profile`.

### Round 2 candidates, implemented and verified (2026-08-04)

Explicit user instruction: "yeni veri listelerini iyice incele onlarıda
ekleyelim" — review the round-2 research thoroughly and add what holds up,
rather than leaving it a research-only list indefinitely.

**Discipline applied**: every URL was fetched for real by hand before
writing any ingestion code — the round-2 research agents' summaries were
treated as leads, not verified facts, exactly the standard this whole
project holds every other source to. That check caught one real problem
before it became wasted engineering effort:

- **SSLBL (abuse.ch) — rejected, not implemented.** Licensing checked out
  fine (CC0, genuine per-dataset grant, same shape as Feodo Tracker). But
  fetching the actual file shows abuse.ch's own banner: `Last updated:
  2025-01-03`, `ATTENTION: This list has been deprecated on 2025-01-03` —
  and zero real data rows past the header. A source can pass every
  licensing check this project runs and still be worthless to ingest; the
  two questions are independent and both have to be checked. See
  SOURCES.md's Layer 6 section for the full account.
- **Yandex Cloud CDN — shape didn't match the assumption.** The research
  summary said "same `{"prefixes":[...]}` shape as AWS/GCP." Fetching it
  directly showed the real shape is a flat array of CIDR *strings*
  (`{"prefixes": ["1.2.3.0/24", ...]}`), not AWS/GCP's array of objects
  with `ip_prefix`/`ipv4Prefix` keys. Close enough to be a real trap for
  anyone who reused the GCP parser without checking — written as its own
  small parser instead (`ingestYandexCdnJson`).

**Implemented, both verified against real ingestion and a real end-to-end
`lookup`, not just a passing typecheck:**

1. **Five new RFC 8805 geofeeds** (`gtt-geofeed`, `charter-geofeed`,
   `fastly-geofeed`, `zayo-eu-geofeed`, `orange-lu-geofeed`) — pure
   registry + source-metadata additions, reusing the existing
   `rfc8805-geofeed-csv` parser and `geofeedField()`/`geofeedCountry()`
   helpers verbatim (confirmed those already handle the stray whitespace
   some of these feeds have, e.g. Zayo's `"GB-GRE "` region field — no new
   code needed there either). Real ingestion counts from this sandbox:
   Charter 428,990 rows, GTT 50,907, Fastly-geofeed 15,972, Zayo-EU 16
   (small by design — EU entities only). A real lookup on a Charter
   address (`16.98.0.5`) came back `geo_source: "geofeed"`,
   `city: "NEW PORT RICHEY"` — the new data flowing through the full
   `lookupIp()` path, not just landing in the table.
2. **Yandex Cloud CDN** (`yandex-cdn-ip-ranges`) — new `cloud` source,
   93 rows on a real run. A real lookup on a Yandex CDN address
   (`5.187.84.35`) came back `cloud_provider: "yandex"`.
3. **Orange Luxembourg — registered and enabled, not yet ingested in this
   sandbox.** The feed is real (`curl` from this same machine got a clean
   `200` with real RFC 8805 content, repeatedly) but every attempt through
   this project's own fetch path returned `HTTP 503`. Traced with a raw
   Node `fetch()` call: the real error is `upstream connect error or
   disconnect/reset before headers... Connection reset by peer` — an
   Envoy-shaped message, meaning this sandbox's own outbound proxy is
   failing its TLS handshake to this one host specifically. Every other
   new source above went through the identical fetch path, through the
   same proxy, and ingested cleanly — so this reads as host-specific proxy
   flakiness in this sandbox, not a defect in the source or the code.
   Nothing to fix here; just retry `ip-insight enrich --sources
   orange-lu-geofeed` from an environment that isn't behind this sandbox's
   proxy (the phone, or the eventual VDS) before assuming it's broken.

**Not implemented this pass, left for later per the earlier standing-list
entries** (not because anything new was found against them, just not
reached): Cloudflare/RIPE NCC RPKI validator redundancy (a bigger piece —
needs the multi-validator priority logic actually verified, not just
referenced in SOURCES.md's prose), bgp.tools ASN classification (a new
data domain, needs schema design), Scaleway/Backblaze/PIA (the "marginal,
judgment call" tier from round 2).

### `route_anomaly` shipped — plus a real lesson about handing a long verification pass to a background agent (2026-08-06)

Product decision from the founder, worth recording since it's the reason this
feature exists: after a long back-and-forth about what would actually
differentiate this project from MaxMind/ipinfo without adding cost, the
answer that stuck was "a signal nobody else exposes, built from data we
already compute on every lookup." `asn.wider_prefix_asn` (a wider, different-
ASN prefix covering this announcement) combined with `rpki.status ==
"invalid"` is exactly that — already individually documented in SOURCES.md,
never synthesised into one named field. Two design agents (product-owner-led,
one for this feature, one for a separate network-stability/churn idea gated
on 6-12 months of history this deployment doesn't have yet — see its own
section) produced real, verified design docs before any code was written;
this section covers only the `route_anomaly` implementation.

**What happened, honestly.** An implementation agent was handed the approved
design and ran in the background. It got the *code* right — `lookup.ts`,
`risk.ts`, the OpenAPI schema (plus fixing a real, separate gap it found:
`verified_bot`/`neighborhood` were live fields in `lookup.ts` but completely
absent from `openapi.yaml`), and a full codegen regen — all correct, all
still standing after review, confirmed by typecheck and the full test suite
staying green through everything that follows. Then it reached its own
verification step (§7 of its design doc: measure the real base rates at
scale) and never finished. ~13.5 hours later, checked directly: the
background transcript had produced zero new tool calls in the last hour,
and this sandbox's Postgres had crashed under it. The most likely story:
the agent's first attempt at "measure this over the full 1.5M-row
`bgp_origin_ranges` table" used a per-row correlated subquery — the exact
mistake this file's own "Writing an aggregate over range tables" note
already warns about — and either hung on that query for hours or was still
retrying when Postgres went down and took the connection with it.

**Lesson, stated plainly for next time:** a long, open-ended "measure this
at scale" verification step is a bad fit for an unsupervised background
agent with no way to notice it's stuck and no one watching a wall clock.
Code-writing and design work delegate well; a step whose entire job is
"run a query, notice if it's slow, rewrite it" does not, at least not
without an explicit time-box and a fallback instruction. Postgres restarts
happening mid-session in this sandbox (twice now) made it worse but weren't
the root cause — the query pattern was.

**Finished by hand instead**, applying this file's own established fix for
this exact trap: `TABLESAMPLE SYSTEM` at a size chosen from a measured
per-row cost (`EXPLAIN ANALYZE` on a tiny 0.05% sample showed ~2.85ms per
row for the wider-prefix LATERAL probe; 0.7% — 9,396 rows — was sized to
finish in well under a minute, not guessed). Real numbers from that sample:
wider-prefix-present 16.7%, RPKI-invalid 3.7%, both together 1.0% (94 real
matches) — same order of magnitude as the design doc's earlier ~1.4%-sample
estimate (2.90% of the wider subset there vs. ~6% here), not an exact match,
disclosed as sample variance rather than smoothed over.

**All 94 real matches read by hand** (not sampled — every row), the same
methodology this file's classifier-fix and regional-audit sections already
used. Finding: roughly a quarter of the *distinct relationships* behind
those rows were the same real-world operator on both sides — a company's
own aggregate covering its own more specific announcement, one AS number
removed (GoDaddy/GoDaddy, KPN GTT/GTT-BACKBONE, Shanghai Mobile/China
Mobile, and the single largest cluster in the sample, ~50 of the 94 raw
rows, JAZZNET/UNI2 — both "Orange Espagne SA"). This is *higher* than the
12.9% the original design doc estimated from its smaller sample — a second,
independent measurement confirming the same real gap, not a new one.

The founder's instruction at this point, in his own words, is worth keeping
verbatim in spirit: fix the gap now, with real evidence in hand, rather than
shipping it disclosed-but-open and coming back later. Implemented
`looksLikeSameOperator()` in `asn-types.ts`: strips generic company/network
vocabulary (LLC, Inc., Backbone, Communications, Telecom, a short list of
country/nationality words too common to mean "same operator" alone —
"China", "Saudi", "USA", "UK") from both ASN names and checks for any
shared distinctive word. First version used a 4-character minimum token
length and missed "KPN GTT" / "GTT-BACKBONE GTT" entirely — "GTT" is 3
characters — caught by testing against the real sample rather than assuming
the threshold was safe, same discipline this file has needed more than
once already. Fixed to a 3-character floor. Final verification: 11/11 real
pairs from the sample classified correctly, including two *disclosed,
accepted* misses (Saudi Telecom Company vs. STC, China Telecom vs. its
Chinanet backbone brand — both share only stopworded country words or
words too generic to trust alone) — the same "rare disclosed miss over an
ever-growing exception list" call `tele[ck]om`'s ITU miss and `entel`'s
Energoprojekt miss already made. When it fires, `route_anomaly.detected`
stays `true` (the raw condition is real) but `confidence` is capped at
`"medium"` with an explicit `same_operator_suspected` reason — visible, not
silently suppressed.

**Shipped off by default.** Not through `LookupFeature` (which defaults
everything on) — a new, dedicated `routeAnomalyEnabled` boolean on
`LookupConfig`, same mechanism `mmdbHistoryFields` already uses for
`stable_since`: an unproven heuristic with real, now twice-measured
false-positive modes and no outcome data to calibrate precision against
gets a manual opt-in, not a default.

`pnpm run typecheck` clean; full suite 74/74. Real end-to-end check: a live
lookup against a real address inside the sample's largest cluster
correctly returned `route_anomaly: { detected: false, confidence: null,
reasons: [] }` when the feature flag was off, and computed correctly when
forced on for a different address whose live-resolved ASN/RPKI state no
longer matched the batch sample exactly (expected — routing and RPKI state
both genuinely change over time; the sample was a snapshot, the live
lookup is current). All temporary audit output was ad-hoc `psql` this time,
not a checked-in script — nothing left behind to delete.

### `classify-test` CLI command — formalizing the audit-script workflow (2026-08-06)

Every classification pattern added this session (usage_type/asn.type in
`asn-types.ts`, connection_type patterns) went through the same manual
loop: write a throwaway `apps/cli/audit-*.ts`, run it once against the real
database, read the output, delete the script. Asked directly whether that
workflow was worth making permanent instead of hand-rolled each time —
yes, specifically because the *checking* part (does this actually help,
does an earlier rule already cover it, how many real ASNs does it touch)
is what the audit scripts existed for, and that logic doesn't change
between patterns.

Added `ip-insight classify-test <pattern>` (`apps/cli/src/commands/
classify-test.ts`): runs the candidate JS `RegExp` against the real, full
`asn_blocks.name` column (a full in-process table scan, not a Postgres-side
regex — the two dialects don't map 1:1, and this guarantees the test uses
the exact same matching semantics `classifyAsnName` itself does at
runtime), reports total matches, how many are genuinely new (currently
"other") vs already claimed by an earlier rule in `RULES` (so a pattern
that looks impressive in isolation but never actually fires, because
something else always wins first, is visible as such), and prints a sample
for manual precision review. `--json`, `--sample <n>`, `--compare-to
<pattern>` (delta against a second candidate) round it out.

Deliberately scoped to `asn_blocks.name` only — `connection-type.ts`'s
reverse-DNS half has no bulk column to test against (reverse DNS is
inherently live-only in this project, see SOURCES.md's "Supporting
signals"), so that half of pattern-writing still needs the manual,
per-address verification style already used for it.

Verified against real patterns: `tele2` → 17 matches, 16 already caught by
existing rules (14 isp, 2 mobile), 1 genuine new capture (a Croatian
operator, "tele2hr Telemach Hrvatska d.o.o."). `internet` (a candidate,
not added) → 2,209 new captures, split roughly 1,047 enterprise / 588 isp
/ 41 mobile / 33 hosting by what an earlier rule would already assign the
already-caught remainder — a genuinely useful real finding this tool
surfaced for a future, separately-verified pass, not chased further here.
`pnpm run typecheck` clean; full suite still 74/74 (no new tests needed —
this is a diagnostic CLI tool, not classification logic itself).
