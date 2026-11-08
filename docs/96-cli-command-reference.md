# 96 — CLI command reference

Every `ip-insight` command (`apps/cli/src/index.ts`), what it does, and what
it actually touches — so a command can be picked correctly without reading
the source each time. "Touches" means: which tables/files/subsystems it
reads or writes, not just its one-line description.

Almost every command needs `DATABASE_URL` set (reads/writes the same
Postgres database as the API server and web panel). The two exceptions are
called out explicitly below (`collect --csv`, `config`).

## Data pipeline (the core loop)

### `lookup <ip>` / `asn <number>`
Look up a single IP or ASN. Read-only. Touches: whichever tables
`packages/lookup` queries live (source tables directly, or `ip_intel` if a
flattened view/materialized view exists — see `flatten` below). `--json` for
raw output.

### `collect [--sources <rirs>] [--csv <dir>] [--resume [jobId]]`
Layer 1: fetches RIR delegated-extended files (ARIN/RIPE NCC/APNIC/
LACNIC/AFRINIC) and ingests them. Touches: `ip_blocks`, `asn_blocks` (via
Postgres), plus job-tracking tables for `--resume`.
**`--csv <dir>` is the one exception that needs no database at all** — it
writes plain `<rir>-ip-blocks.csv` / `<rir>-asn-blocks.csv` files instead,
with no dedup against previous runs.

### `enrich [--sources <ids>] [--resume [jobId]] [--skip-flatten]`
Layer 2: fetches everything collect doesn't (BGP origin ASN, geofeeds,
GeoNames, cloud ranges, threat lists — run `sources` to see the full id
list). Touches: one enrichment table per source id (e.g. `bgp_origin_ranges`,
`geofeed_ranges`, `cloud_ranges`, `threat_ranges`, `anonymity_ranges`, etc.),
and by default rebuilds `ip_intel` at the end (same work as `flatten`).
`--skip-flatten` skips that rebuild — useful for a narrow `--sources <one-id>`
run when `ip_intel` is materialized (rebuild can take minutes-to-hours on a
large dataset), but leaves `ip_intel`/the `.mmdb` serving stale data until you
run `flatten` yourself.

### `refresh`
Just `collect` then `enrich` back to back, no options. The full pipeline
from scratch. Touches everything both of those touch.

### `flatten [--mode <view|materialized|off>] [--refresh]`
Builds or refreshes `ip_intel`, the single table/view every downstream
consumer (lookup, export, mmdb) reads instead of joining every source table
by hand. Mode comes from `ip-insight.config.json`'s `ipIntelMode` unless
overridden. `--refresh` recomputes an existing materialized `ip_intel`
without recreating it (`REFRESH MATERIALIZED VIEW CONCURRENTLY` — since the
SP-GiST fix, minutes not hours on ~3.2M rows, see `docs/94`). `enrich`
already calls this at the end of every run (unless `--skip-flatten`); this
is for doing it standalone/on-demand.

### `export [--format csv|ndjson] [--out <file>]`
Dumps ingested IP/ASN blocks (`ip_blocks`/`asn_blocks`, not the enriched
`ip_intel`). Streams to stdout unless `--out` or config's `exportDir` is set.
Read-only.

### `export-mmdb --out <file> [--type <name>]`
Writes `ip_intel` to a standalone `.mmdb` file at the given path — no
publish/validation/promotion, just the raw build. Reads `ip_intel` only
(run `flatten` first if it's stale). This is the low-level primitive;
**`mmdb publish` (below) is the one to actually use for a served file**,
since it adds validation and safe promotion on top of the same build.

## Serving the data

### `mmdb publish --dir <dir> [--type][--golden][--min-ratio][--retain]`
Builds a new `.mmdb`, validates it two ways — against a golden set of known
IPs (real MaxMind reader, default 4 addresses baked into the code, override
with `--golden <file>`) and against the previously-served file's prefix
count (rejects if below `--min-ratio`, default 0.8, i.e. the new file can't
have lost more than 20% of prefixes) — and **only if both pass**, repoints
`current.mmdb` at the new file. A rejected build is kept on disk (for
inspection) but never served; the previous file keeps answering requests.
Touches: reads `ip_intel`, writes timestamped `.mmdb` files + the
`current.mmdb` symlink in `--dir`, prunes old timestamped files down to
`--retain` (default 5), records the outcome in `mmdb_publishes`. This is
the command that caught both real bugs found this session (the NTT geofeed
width bug and the trie subdivide bug) — it's the safety net, not a
formality.

### `mmdb rollback --dir <dir>`
Points `current.mmdb` back at the previously-published file. For a
regression that passed validation but was still wrong in practice.
Touches: the `current.mmdb` symlink only, no rebuild.

### `mmdb status`
Last 10 publish attempts (published or rejected), with which checks failed
on each. Read-only, from `mmdb_publishes`.

## History and change tracking

### `history capture [--refresh]`
Diffs `ip_intel` against the stored baseline (`ops.prefix_baseline`):
archives anything changed/removed into `ops.prefix_history`, brings the
baseline current. Its own advisory lock — safe to schedule independently of
`enrich`, won't overlap with another capture. `--refresh` recomputes
materialized `ip_intel` first (needed only if run standalone, not right
after an `enrich`). **History cannot be backfilled** — a missed run is a
permanent gap, which is why this command prints a warning if more than a
day has passed since the last successful capture.

### `history reset-baseline --yes`
Clears `ops.prefix_baseline` only (`ops.prefix_history` untouched). For
exactly one situation: `capture` refuses to run because the tracked fields
changed shape since the baseline was last written. After this, the next
`capture` starts a clean baseline — every prefix re-inserts as "added"
rather than a false "changed" signal from the schema edit.

### `history status [--json]`
How much history exists, whether captures are keeping up (the "continuity"
line — the only place a gap is called out explicitly), and recent capture
runs including skipped ones. Read-only.

### `history at <ip> <date>`
What `<ip>`'s record said on a specific ISO 8601 date. Read-only, from
`ops.prefix_baseline` + `ops.prefix_history`.

### `history timeline <ip>`
Every record a prefix covering `<ip>` has ever held, oldest first.
Read-only, same tables as `history at`.

### `history events <ip> [--json]`
The same history as `timeline`, decomposed into typed events
(PrefixChanged/ASNChanged/GeoChanged/ThreatChanged) instead of two whole
records to diff by hand. Read-only.

### `origin-changes` (alias `hijack-scan`) `[--json]`
Prefixes whose most recent origin-ASN change (per `history capture` data)
isn't RPKI-authorized. Needs at least two captures to have anything to
compare. **Not real-time** — resolution is the capture interval, so a
hijack that starts and ends between two captures is invisible. Read-only,
built entirely from `ops.prefix_history`/`ops.prefix_baseline`, no new
collection.

## Live BGP feed (`bgp-live`)

Real-time counterpart to `origin-changes`, which can only see as finely as
the gap between two `history capture` runs. Watches the whole live BGP
feed, stores only announcements that disagree with the origins already in
`bgp_origin_ranges`. Full write-up: `docs/97-live-bgp-feed-idea.md`.

**Run `enrich` for the selected BGP source first** (`routeviews-rib-ipv4,routeviews-rib-ipv6` by default, `ris-whois-ipv4,ris-whois-ipv6` with `bgpOriginSource: "ripe-ris"`). The
baseline is seeded from `bgp_origin_ranges`; with IPv6 missing, a third of
what it reports is noise (measured — see `docs/97`).

### `bgp-live run [--duration 3h] [--collector rrc00] [--peer <ip>] [--max-data <mb>] [--flush-seconds <n>]`
Connects to RIS Live and records origin changes until stopped (Ctrl+C,
`--duration`, `--max-data`, or `bgp-live stop` from another terminal).
Touches: reads `bgp_origin_ranges` once at startup into memory (~174 MB for
1.5M prefixes), writes `ops.bgp_live_sessions` + `ops.bgp_live_events`.
**Downloads a lot, stores very little** — the full firehose is ~7 GB/hour
off the wire (one collector ~3.7 GB/h, one peer ~7 MB/h) and a two-minute
run wrote 11 rows. On a phone: run `termux-wake-lock` first or Android
kills it with the screen off.

### `bgp-live status [--json]`
Recent sessions and what each saw, including one running right now in
another terminal. Read-only.

### `bgp-live events [--limit] [--min-peers] [--snapshot-only] [--json]`
Recorded origin changes, most widely-propagated first, with current RPKI
status joined at read time. `peers` is the key column — hundreds means it
propagated globally, one means it stayed local. `weak-baseline` marks
events where the prefix wasn't in `bgp_origin_ranges`, so the "previous"
origin is only that session's first sighting (ordinary MOAS prefixes land
there); `--snapshot-only` hides them. **Not a hijack verdict** — a
transfer, a de-aggregation and a MOAS addition all look identical.

### `bgp-live stop`
Asks a running listener to finish its current flush and exit. Sets a column
the running process polls; same cooperative-stop shape as the collect/enrich
jobs.

## Snapshots (cheap sync, not forensics — that's `history`)

### `snapshot create [version] [--note <text>]`
Hashes the current `ip_intel` under a named version (default: timestamp).
Touches: a snapshot-hashes table (lighter than `history`, which keeps full
records — snapshot only keeps hashes for detecting *that* something
changed, not *what* the old value was).

### `snapshot list`
Lists stored snapshots. Read-only.

### `snapshot delta <version> [--json] [--limit <n>]`
What changed in `ip_intel` since a snapshot: added/removed/re-answered
counts and (up to `--limit`) the actual networks. Read-only.

### `snapshot delete <version>`
Removes a snapshot and its stored hashes.

## Operational / diagnostic (safe to run anytime, mostly read-only)

### `sources`
Lists every collection source id (RIR) and enrichment source id, for use
with `collect --sources`/`enrich --sources`. Read-only (touches DB only to
resolve `listEnrichmentSources`, no source tables).

### `config`
Prints the effective `ip-insight.config.json` settings, including
`dbipLiteIpv6` and `bulkCopyIngest` with their cost annotations — the
second is worth checking first when an ingest is unexpectedly slow, since
switching it off costs a measured 2.4x (see `docs/100`). Also prints
`asnNamePrimary` (`"caida"` or `"ripe"` — whichever writes unconditionally)
and `asnNameFallbackEnabled` (whether the other one still runs to fill
gaps, or is skipped entirely — default `false` since 2026-11-08, because
with CAIDA as primary the fallback is RIPE's `asn.txt`, whose commercial
terms are unresolved; see `docs/106` B4, and `docs/20`'s CAIDA entry for
the measured 84%-coverage/96.4%-agreement numbers), and `bgpOriginSource`. **No database
needed at all** — the other DB-free exception besides `collect --csv`.

### `summary [--out <dir>]`
Writes + prints a JSON snapshot of what's in the database: block counts by
RIR/family/status, enrichment table sizes, last run per source. Read-only,
default output dir from config's `summaryDir`.

### `status [--detail] [--failures] [--json]`
Current/last collection and enrichment job status, history maturity,
ingestion health. Read-only. `--detail` adds per-source timestamps,
download sizes, durations, URLs. `--failures` shows nothing else — only
sources whose last run genuinely `failed` (never the benign "unchanged
since last run" skip), each with its full untruncated error message and
URL. Added once the geofeed batch in `docs/102` took the source count past
190: scrolling `--detail`'s output looking for the couple that broke is
real friction at that count. `--failures --json` gives `{failureCount,
collection: [...], enrichment: [...]}` — script it into a `cycle` cron
job to alert only when a source starts blocking this deployment or
changes its feed format, without re-running anything to find out which
one.

### `resources [--json]`
What the deployment is actually costing: DB size (largest tables/
materialized views first, history included), log/backup directory sizes,
system RAM/load, running node/postgres processes (best-effort `ps aux`).
Read-only, no writes anywhere.

### `jobs`
Lists interrupted collect/enrich jobs (crashed/killed mid-run) that
`--resume` can pick up. Read-only.

### `classify-test <pattern> [--flags][--sample][--compare-to][--json]`
Tests a candidate ASN-name classification regex against the real, full
`asn_blocks.name` column — for developing new rules in `asn-types.ts`
before committing them. Read-only, no effect on served data either way.

## Backup / restore

### `backup create`
Takes a `pg_dump` snapshot now (needs `pg_dump` on PATH). Independent of
the automatic scheduled backups a running server takes per
`backupEnabled`/`backupIntervalHours`/`backupRetentionCount` in config —
this subcommand works regardless of whether that scheduler is on.

### `backup list`
Lists backup history. Read-only.

### `backup restore <file> --yes`
**Destructive** — overwrites the entire current database from a backup
file (`pg_restore`). Requires `--yes` to confirm; refuses to run without it.

## Scheduled / unattended

### `cycle [--sources <rirs>] [--enrich-sources <ids>]`
One unattended pass: `collect` then `enrich` (which refreshes `ip_intel`
and captures history if enabled) — built for cron. Refuses to overlap with
a running cycle (own lock), continues past a failed phase instead of
aborting the whole run, logs everything to `logs/ip-insight.log`, exits
non-zero if any phase failed. This is the command a scheduled job/cron
entry should call — not `collect`+`enrich` chained manually — because of
the overlap lock and the continue-past-failure behavior.

---

**Quick map — which command to reach for:**

| Goal | Command |
|---|---|
| Get fresh RIR + enrichment data | `cycle` (scheduled) or `refresh` (manual, once) |
| Rebuild the flattened table after a narrow `enrich --sources` | `flatten` |
| Publish a new served `.mmdb` safely | `mmdb publish --dir <dir>` |
| Undo a bad `.mmdb` publish | `mmdb rollback --dir <dir>` |
| See what changed on a prefix over time | `history timeline` / `history events` |
| Check for unauthorized long-term BGP origin changes | `origin-changes` |
| Catch origin changes as they happen, minute by minute | `bgp-live run` then `bgp-live events` |
| Sync a downstream consumer without full re-download | `snapshot create` + `snapshot delta` |
| Check what a deployment is costing right now | `resources` |
| Recover a crashed run | `jobs` then `collect --resume` / `enrich --resume` |
