# Open-issues triage (2026-08-09)

A separate Claude session produced a 15-item "everything still wrong"
sweep across `docs/`. Triaged here rather than accepted verbatim — two
items directly contradicted already-completed research in this repo.

## Revisited 2026-08-19 — the "verified wrong" call below was too confident

The original 2026-08-09 triage entry (kept below, struck through in spirit
not in fact) leaned on `SOURCES.md`'s table without independently checking
the primary sources. Asked to actually verify against RIPE/LACNIC's own
pages, not just re-read this project's prior notes — the right call, since
this project's own notes have been wrong before (see the `92-` drift bug,
found by not trusting an assumption either). Live-checked 2026-08-19:

- **RIR delegated-extended stats**: solid. The file's own `CONDITIONS OF
  USE` header is a liability disclaimer only, no commercial restriction —
  confirmed by fetching `delegated.txt` directly.
- **RIPE RIS whois dumps**: solid, and more specific than previously
  written down — RIPE NCC's dedicated commercial-use page requires **all
  three** of the RIPE NCC logo, a link to `ripe.net/ris`, and a specific
  boilerplate paragraph. Already tracked as a launch blocker in
  `ipreadout-service/PLAN.md`; nothing new here except confirming it's
  accurate.
- **`asn.txt`**: the original claim ("false, already Yes") **overstated
  this one**. It was grouped with RIS under one row as if they shared the
  same evidence — they don't. No dedicated commercial-use policy exists
  for `asn.txt` anywhere checked; it sits in the "no explicit restriction
  found" class, same as the RPKI ROA row, not the stronger RIS class.
  `SOURCES.md` now splits these into two rows and says so plainly.
- **LACNIC bulk data**: real disambiguation needed that hadn't been made
  before. LACNIC runs two different "bulk" products — an application-gated
  restrictive one (no marketing, no redistribution), and `lacnic.db.gz`
  under policy LAC-2018-3, a separate freely-downloadable file. This
  project uses the second, correctly — but that policy's own text
  ("available for the community to download freely") isn't an explicit
  commercial grant either, same weaker evidence class as `asn.txt`.

Net: still fine to use both, on the same "publicly published, no
restriction found" basis this project already accepts for RPKI ROAs and
some geofeeds — but the earlier "already Yes, confirmed" framing implied
more certainty than existed. `SOURCES.md`'s Commercial Use table has the
full sourced detail as of 2026-08-19.

## Confirmed accurate — verified firsthand this session

- `mmdb-writer.ts` builds the whole entry set in memory before
  serializing — real, hit the default Node heap ceiling on the phone at
  ~2.88M rows (`FATAL ERROR: ... JavaScript heap out of memory`), worked
  around with `--max-old-space-size=4096`, not fixed at the architecture
  level. See `91-benchmarks-and-saas-economics.md`.
- `export-mmdb`'s 129-page torn-export risk was real and is now closed
  (transaction wrap) — but the same *class* of risk reopens once more than
  one relation refreshes on an independent cadence, which is exactly what
  the tiered-refresh plan introduces. Not yet relevant since Stage 1+
  hasn't started.
- `ip_intel`'s definition-drift bug (`REFRESH MATERIALIZED VIEW` never
  picking up a changed source query) — this session's main finding, see
  `92-ip-intel-definition-drift-bug.md`. Fixed, verified against real data
  on the phone 2026-08-09: `wider_prefix_asn` went from effectively always
  NULL to populated on 370,876 of 2,722,935 rows after the drift-triggered
  rebuild completed (~7h15m).

## Fixed 2026-08-09 (same day, after triage)

- **Heartbeat not detecting a dead Postgres connection** — real, confirmed
  by code reading (the 30s timer was pure wall-clock). Fixed in
  `packages/shared/src/heartbeat.ts`: `withHeartbeat` now takes optional
  `checkAlive`/`onUnhealthy` callbacks — a failed/thrown `checkAlive` (a
  cheap `SELECT 1`) fires `onUnhealthy` instead of the normal tick, so a
  dead connection logs as dead instead of narrating fake progress for
  hours. Backward-compatible (both params optional). Wired into all 3 call
  sites: `enrichment.ts`, `history.ts`, and both `withHeartbeat` uses in
  `apps/cli/src/index.ts`'s `flatten` command (the latter two use
  `pool.query("SELECT 1")` since that command only has the raw `pool`,
  not `db`, in scope).
- **`asn_reach` missing from the ASN-number lookup endpoint** — real,
  confirmed: `lookupAsn()` queried `asnBlocksTable`/`asnProfileTable` but
  never `asnReachTable`, even though the per-IP lookup path already
  surfaces the same data (`asn.rank`/`asn.peer_visibility` etc.). Fixed:
  added `AsnReachInfo` (rank, originatedPrefixes, originatedPrefixesV6,
  originatedAddresses, peerVisibility, computedAt) and a `reach` field on
  `AsnInfo`, populated by a third parallel query alongside the existing
  two. Verified against real data: `AS16509` (Amazon) now returns
  `reach.rank: 1`, `originatedPrefixes: 20745` — previously silently
  absent. `openapi.yaml`'s `AsnLookupResult` schema doesn't document
  `profile` either (pre-existing gap, not touched here) — this endpoint
  isn't consumed by the generated `api-client`/web panel yet, only the
  CLI's raw JSON output.

Both: `pnpm run typecheck` clean, 74/74 tests, rebuilt
(`apps/cli`/`apps/server` `dist/`).

## Found 2026-08-19 — real, unfixed: a source that fails all retries can leave partial data

`ris-whois-ipv4` and `lacnic-whois-city` both exhausted all 6 retry
attempts on the phone (`"terminated"` — the same mid-stream connection-drop
class covered by `runSourceWithRetry`'s own doc comment, just persistent
enough this time to outlast every attempt). Traced through
`ingestRisWhoisDump`: it issues a standalone `DELETE FROM bgp_origin_ranges
WHERE source = ...` (auto-commits immediately), then streams the download
and commits insert batches as it goes — not wrapped in one transaction,
deliberately, since buffering a multi-million-row body in memory to insert
atomically isn't affordable (same tradeoff already made and documented for
RPKI VRP ingestion).

The retry doc comment's guarantee ("a redo never leaves duplicate or
half-old-half-new data behind") is true *across* retries of the same run,
but says nothing about what happens when every retry fails: the delete
from the last attempt has already committed, and whatever batches streamed
in before the connection died are also already committed. The result is
neither "old data preserved" nor "empty" — it's an arbitrary partial
subset, silently. `ip_intel`'s next baseline diff on the phone
(`removed: 41288, added: 1` between two consecutive cycles) is consistent
with exactly this happening to `ris-whois-ipv4`.

**Resolved for `ris-whois-ipv4` specifically, 2026-08-19**: re-ran, this
time healthy — 1,241,384 rows, no failure. Root cause, per the founder's
own account: they physically moved ~2-3km from the wifi AP mid-download,
which drops and later re-establishes the connection — exactly the class of
event `"other side closed"` describes, not a bug. Confirms the retry
mechanism does recover cleanly once the network is actually stable; the
earlier partial-data concern was real as an architecture gap but the
phone's specific incident had a mundane physical explanation.

`lacnic-whois-city` did **not** recover on the same retry — a third
consecutive "giving up" logged, ~1h49m after the second, ruling out a
single transient blip as the sole explanation for this one specifically.
Not treated as urgent: it's one city-level geo signal among many (LACNIC
region only), not core routing/ASN data, and the just-rebuilt `ip_intel`
already reflects the now-healthy `bgp_origin_ranges`. Left to retry on the
next natural cycle; revisit only if it keeps failing across multiple days.

**Not fixed here.** The real fix is the same pattern already used for
`ip_intel` itself (stage into a side table, atomic swap only on full
success) rather than delete-then-stream-insert in place — a real, scoped
change to every streaming-ingest source, not a quick patch. Recorded so it
isn't silently rediscovered; immediate workaround is operational: re-run
`enrich --sources <failed-id>` for whichever source's retries were
exhausted, and verify with `SELECT source, count(*) FROM
bgp_origin_ranges GROUP BY source` before trusting the next `ip_intel`
build.

## Fixed 2026-08-19 — real, found via `mmdb publish`'s own golden-set check catching it

The safety net worked exactly as designed: a `mmdb publish` run on the
phone rejected its candidate file over one failed golden case
(`193.0.6.139`, expected `NL`/`AS3333`, country came back wrong) rather
than silently promoting a bad file. Traced to the actual row: NTT's
(AS2914) own published geofeed contained one line that parsed as
`206.163.25.0/2` — syntactically valid CIDR, so nothing rejected it, but
semantically absurd (a /2 covers a quarter of all IPv4 space). Because
`ip_intel.country` is `COALESCE(geofeed, RIR country)`, that one bad line
silently overrode the correct country for every address whose first two
bits matched — RIPE NCC's own 193.0.0.0/21 included — to whatever the
bad line said (`US`, `Minneapolis`).

Root cause: `ingestRfc8805GeofeedCsv`/`ingestDigitalOceanGeofeedCsv` only
checked that a line's prefix was syntactically parseable, never that it
was a plausible *width* for a geo-location entry. `bgp_origin_ranges`
already had exactly this class of guard (drop anything wider than /8 v4,
/16 v6, for default-route-sized junk) — geofeed ingestion didn't. Fixed by
adding the same floor (`isGeofeedPrefixTooWide`), shared across both
ingest functions. Verified against the real bad line (rejected) and normal
geofeed entries (`/24`, boundary `/7` vs `/8`) — all correct.

**Only fixes future ingestion.** The bad row already sitting in the
phone's `geofeed_ranges` needs a one-time manual delete before the next
successful `mmdb publish`:
```sql
DELETE FROM geofeed_ranges WHERE source_id = 'ntt-geofeed' AND masklen(network) < 8;
```
Confirmed isolated to this one row (`SELECT count(*) FROM geofeed_ranges
WHERE masklen(network) <= 8` returned 1) — not a systemic parsing failure
across other publishers.

## Plausible, not re-verified this session — from earlier work

- Validation blind spot in `mmdb-publish.ts` (only a few fields checked,
  not all).
- A past RPKI ASN string-vs-number comparison bug reported as already
  fixed.

Not independently re-checked here — plausible given prior session
patterns, but shouldn't be repeated as confirmed-this-session fact without
looking at the actual code again.

## Not new information

Infra risks (no production box yet, `flatten` has no resume, VDS not
provisioned) and product-side gaps (`ipreadout-service` unbuilt, zero
customers) — all already tracked in `00-index.md`'s status section and
Task #57-59.
