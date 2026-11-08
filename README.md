# IP Insight Engine

Self-hosted IP-to-ASN, geolocation, and threat intelligence database. Builds
its dataset entirely from free, bulk-downloadable public sources (all 5 RIRs,
RouteViews BGP tables — or RIPE RIS, selectable — GeoNames, RFC 8805/9092 geofeeds, cloud provider ranges,
Tor/VPN egress lists, RPKI, abuse.ch Feodo Tracker)
— no third-party API or paid service is queried at lookup time. See
[SOURCES.md](./SOURCES.md) for the full list of data sources, licenses, and
the technology stack.

## Structure

```
apps/
  server/   Express API server
  cli/      `ip-insight` terminal tool (works standalone against the DB)
  web/      React web panel (talks to the API server)
packages/
  collector/  The database builder — no query/resolution opinion, just
              fetches and writes data. Shared by apps/server and apps/cli.
                collection/  RIR delegated-extended file ingestion
                enrichment/  BGP origin ASN, geofeeds, GeoNames, cloud, threat
              Also: cron.ts, export.ts, ingestion-health.ts
  lookup/     The query/resolution service — one reference implementation
              of "how to interpret the data collector builds". Separate on
              purpose: take collector+db alone and write your own
              resolution logic instead, if collector's default doesn't fit.
                lookup/      IP/ASN resolution, anycast, usage classification,
                             RPKI validity, risk scoring, connection-type guess
  shared/     Opinion-free utilities both packages above depend on: logger,
              retry, IP/CIDR helpers.
  db/       Drizzle ORM schema (public = data, ops = build machinery) +
            Postgres client + the flattened `ip_intel` relation
  api-spec/ OpenAPI spec (single source of truth) + Orval codegen config
  api-schema/  Generated Zod schemas (from api-spec)
  api-client/  Generated React Query hooks (from api-spec)
scripts/    One-off maintenance scripts
```

> **Deploying, or changing the code?** See **[DEPLOY.md](DEPLOY.md)** — it
> covers standing a server up in order (including the Postgres tuning that is
> a prerequisite, not an optimisation), measured RAM/disk requirements, and a
> change playbook listing every place a given kind of edit has to reach.
> Everything in it is written down because getting it wrong already happened.

## Run & operate

Requires `DATABASE_URL` (Postgres connection string) in the environment.

- `pnpm --filter @workspace/server run dev` — API server (port 8080 → `/api`)
- `pnpm --filter @workspace/web run dev` — web panel (port 24920 → `/`). Vite's dev server proxies `/api` to the API server (default `http://localhost:8080`, override with `API_PROXY_TARGET`) — production instead expects a reverse proxy putting both on one origin.
- `pnpm --filter @workspace/cli run build && DATABASE_URL=... node apps/cli/dist/index.mjs --help` — terminal tool (works without the API server running; see commands below)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from `packages/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

The web panel (`apps/web`) covers everything the CLI/API do: Dashboard, Collection,
Enrichment, Lookup (full per-IP breakdown — network status, geo source, per-facet
confidence, reverse DNS), Jobs (list + resume interrupted collect/enrich runs),
Backups (create/list/restore with a type-to-confirm dialog), Scheduler, and a
read-only Settings page showing every effective config value. It's a reasonable
starting point if you're building your own panel against this project's API —
see `packages/api-spec/openapi.yaml` for the full contract.

### `ip-insight` CLI

Reads/writes the same database as the API server — no server process
required.

- `ip-insight lookup <ip>` / `ip-insight asn <number>`
- `ip-insight collect [--sources arin,ripencc,apnic,lacnic,afrinic]`
- `ip-insight enrich [--sources <ids>]` (see `ip-insight sources` for the list)
- `ip-insight refresh` — collect, then enrich, back to back
- `ip-insight export --format csv|ndjson [--out file]`
- `ip-insight flatten [--mode view|materialized|off] [--refresh]` — create/refresh `ip_intel`, the single flattened relation for querying this database from another project (see "Querying from another project" below). `enrich` already does this at the end of every run.
- `ip-insight status` — job history + ingestion health
- `ip-insight config` — show the effective `ip-insight.config.json` settings (no database needed)
- `ip-insight summary [--out ./summary]` — write a `db-summary.json` snapshot (block counts by RIR/family/status, enrichment table sizes, last run per source) and print it; also logged to `logs/ip-insight.log`
- `ip-insight resources [--json]` — what this is actually costing right now: database size (every table/materialized view, largest first — so "how much space does history take" is one glance, not a manual `pg_total_relation_size` query), log/backup file sizes, system RAM and load average, and any running node/postgres processes with their CPU/RSS (best-effort via `ps aux` — useful for confirming a long enrichment step is still alive, not stuck)
- `ip-insight jobs` — list interrupted collect/enrich jobs (crashed/killed mid-run) that can be resumed
- `ip-insight collect --resume [jobId]` / `ip-insight enrich --resume [jobId]` — resume an interrupted job instead of starting fresh (see "Checkpoint/resume" below)
- `ip-insight backup create` / `ip-insight backup list` / `ip-insight backup restore <file> --yes` — manual `pg_dump`/`pg_restore` snapshots (see "Backups" below)
- `ip-insight cycle` — one unattended collect → enrich pass (refreshes `ip_intel` and captures history if enabled), built for cron: refuses to overlap a running cycle, keeps going past a failed phase instead of stopping, exits non-zero if anything failed
- `ip-insight origin-changes [--json]` (alias: `hijack-scan`) — every prefix whose most recent BGP-origin change isn't RPKI-authorized; built entirely from `history capture`'s data, needs at least two captures to compare. **Not a real-time hijack detector** — see "History is its own system" below
- `ip-insight history capture [--refresh]` — history's own standalone job: diff `ip_intel` against the stored baseline, archive what changed, bring the baseline current. Takes its own lock, and warns how many days since the last successful capture. Refuses to run (as a `skipped` precondition, not a crash) if the stored baseline was captured under an older field shape than the code running now — see `reset-baseline` below
- `ip-insight history reset-baseline --yes` — clears `ops.prefix_baseline` only (`ops.prefix_history` is untouched). For the one situation above: after editing which fields history tracks, the old baseline's records don't have the same JSON shape as a fresh one, so diffing them would archive *every* prefix as "changed" — a false signal from the schema edit, not real drift. This clears that stale baseline so the next capture starts clean
- `ip-insight history status [--json]` — how much history exists, whether it's enough to derive anything from yet, whether there's a **gap** in it, what it costs on disk and where that's heading, plus recent capture runs (including skipped ones — the usual reason history silently stops accumulating)
- `ip-insight history at <ip> <date>` — what `<ip>`'s record actually said on a given ISO 8601 date
- `ip-insight history timeline <ip>` — every record a prefix covering `<ip>` has held, oldest first
- `ip-insight history events <ip> [--json]` — typed change events (`PrefixChanged`/`ASNChanged`/`GeoChanged`/`ThreatChanged`) for the prefix covering `<ip>`
- `ip-insight snapshot create [version] [--note text]` / `snapshot list` / `snapshot delta <version> [--json]` / `snapshot delete <version>` — versioned records of what `ip_intel` said, and cheap deltas between them, for a consumer keeping their own copy in sync without re-downloading everything daily
- `ip-insight export-mmdb --out <file> [--type name]` — write the flattened database to a MaxMind DB (`.mmdb`) file, the deployment format for volume serving; run `ip-insight flatten` first
- `ip-insight mmdb publish --dir <dir> [--golden file] [--min-ratio n] [--retain n]` — build, validate against a golden set and the previously-served file's size, and only then promote a new `.mmdb`; a rejected candidate never goes live and the previous file keeps serving
- `ip-insight mmdb rollback --dir <dir>` — point `current.mmdb` back at the previously published file
- `ip-insight mmdb status` — what's currently serving, and every candidate that was rejected before it could

`lookup`/`enrich`/`refresh`/`export`/`status` all need `DATABASE_URL` set (they
talk to Postgres, same as the API server). **`ip-insight collect --csv <dir>`**
is the one exception: pass `--csv` and it skips Postgres entirely, writing
`<rir>-ip-blocks.csv` / `<rir>-asn-blocks.csv` straight to disk — no database
setup needed at all, for anyone who just wants the raw RIR allocation data
quickly. Trade-off: no dedup/conflict-merge across repeated runs like the
Postgres path has — each run just re-fetches and re-writes the files.

#### Default sources: `ip-insight.config.json`

`collect`/`enrich` (both the CLI and the API server) default to every
source when no `--sources`/`sources` is given. To make "this deployment
only ever collects X, Y, Z" a persistent setting instead of retyping
`--sources` every time, drop an `ip-insight.config.json` next to where you
run the command (or point `IP_INSIGHT_CONFIG` at one):

```json
{
  "collection": "arin,ripencc",
  "collectionStatuses": "allocated,assigned",
  "enrichment": "database_full"
}
```

#### Overriding source URLs: `sources.registry.json`

Every URL this project fetches from (each RIR file, each enrichment feed)
has one default, defined in `packages/collector/src/sources-registry.ts`.
This project is MIT-licensed and meant to be forked/self-hosted freely —
including as the base of someone else's product — so those defaults are
overridable without touching source or rebuilding: drop a
`sources.registry.json` next to where you run the command (or point
`IP_INSIGHT_SOURCES_REGISTRY` at one), overriding only the keys you need:

```json
{ "enrichment": { "geonames-cities": "https://mirror.internal/cities5000.zip" } }
```

Unspecified keys keep using the built-in defaults — a shallow merge per
section (`collection`/`enrichment`), not a full replace. Read once at
process start (restart to pick up an edit), same tradeoff as
`@workspace/lookup`'s config.

Each key is either the literal string `"database_full"` (everything — the
default with no file at all) or a comma-separated list of ids. Unrecognized
ids are logged as a warning and ignored, not a hard failure. An explicit
`--sources`/`sources` argument always overrides the config file for that
one call.

`collectionStatuses` filters by the RIR's own `status` field on each
record — `allocated` (in active use), `assigned` (end-user assignment),
`reserved` (held back by the RIR), `available` (unallocated, free for the
RIR to hand out). All four are collected by default; set this to skip
`reserved`/`available` rows entirely if a deployment only cares about
space that's actually in use. That status is also returned per-lookup as
`network.status` (see below).

#### Lookup response shape: `lookupFeatures`

`lookupIp` (both the CLI and the API) computes fifteen optional signals per
query: `asn`, `network_status` (the RIR status above), `geo`,
`reverse_dns`, `threat`, `usage_type`, `cloud_provider`, `anycast`,
`special_purpose` (IANA reserved-range detection), `asn_reach` (how much
address space the ASN announces, and how widely it's seen — derived locally
from the BGP table), `anonymity` (published Tor/VPN egress lists),
`abuse_contact`, `rpki` (is the observed BGP origin cryptographically
authorised), `risk` (transparent composite of the others, with reasons), and
`connection_type` (heuristic guess, never authoritative). All fifteen are on
by default. See SOURCES.md for what each one can and cannot tell you. To skip some — smaller response, and for
`reverse_dns` specifically a real per-query latency win (it's a live DNS
call otherwise made on every lookup) — add to the same config file:

```json
{ "lookupFeatures": "asn,network_status,geo" }
```

A disabled feature's fields come back exactly as they already do when
there's simply no data for that facet (`null`, or the "nothing found"
shape) — this never changes the response contract, only which fields end
up populated. Cached for the process's lifetime (unlike the collection
settings above, which re-read the file every run) — restart to pick up an
edit, since `lookupIp` is the hot path this project is built around
(sub-5ms cached, sub-20ms cold).

#### Performance / resource / reliability settings

All optional, all with sane defaults — set only what a given deployment
needs to change. Collector-side keys re-read the config file every run;
lookup-side keys are cached for the process's lifetime (same split as
above).

```json
{
  "batchSize": 2000,
  "fetchRetryMaxAttempts": 4,
  "fetchRetryBaseDelayMs": 1000,
  "fetchRetryTimeoutMs": 30000,
  "exportFormat": "csv",
  "exportDir": ".",
  "summaryDir": "./summary",
  "cacheSize": 50000,
  "cacheTtlMinutes": 360,
  "reverseDnsTimeoutMs": 800,
  "bulkLookupConcurrency": 32
}
```

Collector/enrichment (re-read every run):
- `batchSize` — rows per bulk insert during `collect`/`enrich`. Lower it on
  a memory- or connection-constrained Postgres instance; raise it for
  fewer, larger round-trips on a beefier box.
- `fetchRetryMaxAttempts` / `fetchRetryBaseDelayMs` / `fetchRetryTimeoutMs`
  — retry policy for every outbound fetch (RIR files, geofeeds, cloud/threat
  lists): how many attempts, the base delay before retrying (doubles each
  attempt), and the per-attempt timeout. Tune up on a flaky network, down
  for faster failure in CI.
- `exportFormat` / `exportDir` — default `--format`/`--out` for
  `ip-insight export` when the flags aren't passed. `exportDir: "."` (the
  default) preserves the existing "no `--out` means stdout" behavior;
  setting it to a real directory writes `<exportDir>/blocks.<format>`
  instead.
- `summaryDir` — default `--out` for `ip-insight summary` when not passed.

Lookup (cached for process lifetime — restart to pick up an edit):
- `cacheSize` / `cacheTtlMinutes` — the in-memory LRU cache `lookupIp`
  checks before touching Postgres. Lower `cacheSize` on a memory-constrained
  deployment; lower `cacheTtlMinutes` if the underlying data changes often
  enough that a stale cached answer matters more than the extra DB
  round-trips.
- `reverseDnsTimeoutMs` — how long a single PTR lookup is allowed to block
  a request before giving up (never throws, and disabling the
  `reverse_dns` feature skips it entirely — see above).
- `bulkLookupConcurrency` — how many IPs `lookupBulk` resolves in parallel.

Database connection pool (env var, not the JSON config file — `packages/db`
deliberately doesn't depend on collector/lookup's config-reading code):
- `DB_POOL_MAX` — max Postgres connections in the pool (defaults to the
  driver's own default, currently 10). Raise it under high concurrent load;
  lower it if Postgres itself is connection-limited.

Run `ip-insight config` to see the effective value of every setting above.

#### Checkpoint/resume

```json
{
  "checkpointingEnabled": true,
  "checkpointIdFormat": "uuid",
  "checkpointStaleAfterHours": 168,
  "checkpointAutoCleanupStaleJobs": false
}
```

If a `collect`/`enrich` process is killed mid-run (crash, `kill -9`, power
loss — not a graceful `Ctrl+C`/`SIGTERM`, which already finishes cleanly),
its job row is left looking "running" forever. The next time that job type
starts fresh (no `--resume`), it's detected and relabeled "interrupted" —
`ip-insight jobs` lists it, and `ip-insight collect --resume [jobId]` /
`ip-insight enrich --resume [jobId]` picks it back up: sources that already
finished are left alone, everything else re-runs from scratch (a source is
the smallest resumable unit — no mid-file byte-offset resume). Running
`collect`/`enrich` without `--resume` always starts a brand new job and
never silently continues an old one, regardless of what's sitting
interrupted.

- `checkpointingEnabled` — master switch. `false` disables all of the above
  (no tracking overhead, `jobs`/`--resume` say so and do nothing).
- `checkpointIdFormat` — `"uuid"` (the real primary key, default) or
  `"sequential"` (`collect-000123`/`enrich-000123`, easier to type off a
  terminal). Either form works with `--resume`.
- `checkpointStaleAfterHours` — how long an interrupted job stays in the
  default `jobs` listing / id-less `--resume`; older ones are still
  resumable, just by explicit id only.
- `checkpointAutoCleanupStaleJobs` — if `true`, jobs past that age are
  deleted outright (no longer resumable at all, even by id) instead of
  just hidden. Off by default since deleting resume state can't be undone.

A one-shot CLI process only sweeps for interrupted jobs when you next run
`collect`/`enrich` yourself. The rest of this section (backups, sleep mode)
is about a second, independent thing: a *background* scheduler that a
running `apps/server` can optionally run on a timer.

#### Background automation — off by default

```json
{ "maintenanceSchedulerEnabled": false }
```

Everything below this — automatic backups, sleep-mode logging, and the
periodic (as opposed to "next time you run collect/enrich") version of the
stale-job sweep above — is unattended, timer-driven code that only exists
if `apps/server` is told to run it. It's **off by default**: with no config
file, or with this key absent/`false`, `apps/server` never starts the
timer at all — nothing runs in the background, period. Turning it on (or
off) needs a server restart; every setting below it, once it's running,
still applies live on its next tick with no restart needed.

If you'd rather this automation not exist in the codebase at all, even
disabled, it's isolated to one file on purpose: delete
`packages/collector/src/maintenance.ts`, remove its two call sites
(`startMaintenanceScheduler()`/`stopMaintenanceScheduler()`) in
`apps/server/src/index.ts`, and rebuild. Everything else — `ip-insight
jobs`, `collect`/`enrich --resume`, `ip-insight backup create/list/restore`
— lives elsewhere (`collection/collector.ts`, `enrichment/enrichment.ts`,
`backup.ts`) and keeps working exactly the same.

#### Backups

```json
{
  "backupEnabled": false,
  "backupIntervalHours": 24,
  "backupRetentionCount": 7,
  "backupDir": "./backups"
}
```

`ip-insight backup create` takes a `pg_dump -Fc` snapshot into `backupDir`
right now; `ip-insight backup list` shows history; `ip-insight backup
restore <file> --yes` runs `pg_restore --clean --if-exists` against it —
**destructive**, it overwrites whatever's currently in the database, which
is why `--yes` is required (omitting it just prints a warning and exits).
These three are manual commands and always work, regardless of
`maintenanceSchedulerEnabled`/`backupEnabled` — they need the `pg_dump`/
`pg_restore` binaries on `PATH` (the `postgresql-client` package on
Debian/Ubuntu), and their absence is logged once, not a crash.

Setting `backupEnabled: true` *and* `maintenanceSchedulerEnabled: true` has
a running `apps/server` take these same snapshots automatically, once per
`backupIntervalHours`, pruning down to `backupRetentionCount` (oldest
deleted first, both the file and its `ip-insight backup list` row).

#### Sleep mode

```json
{
  "sleepModeEnabled": false,
  "sleepModeIdleHours": 72
}
```

Purely informational, and — like the rest of this section — only runs if
`maintenanceSchedulerEnabled` is also `true`: a running `apps/server` logs
one line when no `collect`/`enrich` job has started in
`sleepModeIdleHours` ("entered sleep mode") and one more the next time a
job starts ("exited sleep mode"). Changes no behavior — just makes an
unusually quiet deployment visible in the log instead of looking silently
broken.

All of the settings in this section are re-read on every maintenance
tick — no restart needed to pick up an edit, except
`maintenanceSchedulerEnabled` itself (see above).

## History is its own system

History is the one thing here that cannot be rebuilt from upstream. Every
other table can be re-downloaded and re-derived at any time; a day that
passed without a capture is a day whose changes nobody recorded, and no
amount of later work recovers it. That asymmetry is why history is run as
its own scheduled job rather than as a step inside something else:

```bash
ip-insight history capture --refresh    # daily, on its own schedule
ip-insight history status               # is it actually still running?
```

- **It holds its own lock.** Two overlapping captures would archive the same
  superseded records twice. A separately-scheduled job needs that guard.
- **It reports gaps, every run.** A database that quietly stopped capturing
  looks exactly like one where nothing changed — the same numbers, no
  errors. `history status` therefore prints a `Continuity:` line whether or
  not anything is wrong, and `history capture` warns when more than a day
  has passed since the last *successful* capture.
- **`--refresh` when it runs independently.** The capture diffs the
  materialized `ip_intel`; diffing a stale one records nothing while
  reporting success. Pass `--refresh` when this isn't running right after an
  enrichment. (That refresh is the expensive part — hours on a full dataset;
  the capture itself is minutes.)

The older `historyCaptureEnabled: true` config, which appends a capture to
the end of every enrichment, still works and is still off by default. It is
no longer the recommended path: it has neither the lock nor the gap
reporting, and it ties the capture's fate to a multi-hour job — an
enrichment killed at hour four takes that day's capture with it.

### What long-term history is, and isn't, good for

Worth stating plainly so the feature isn't oversold:

**For real-time BGP hijack detection, use [Cloudflare
Radar](https://radar.cloudflare.com/) instead.** It is free, has a public
API, processes live BGP messages from ~170 full-feed peers, and scores
against RPKI, IRR, bogon lists and AS relationships together. This project
cannot compete with that and does not try: `origin-changes` compares two
captures, so its resolution is the capture interval. A hijack that starts
and ends between two captures — which is what most real ones look like — is
invisible here.

What months of accumulated captures answer that a live feed does not: *has
this prefix been stable for a year, or changed hands five times? Was this
address a Tor exit six months ago? Which prefixes are sitting on an
unauthorized origin quietly, with no incident-shaped spike to trigger an
alert?* Those are questions about history rather than about right now, and
they only become answerable once the history is actually there — which is
the entire reason the continuity guarantees above matter more than any
feature built on top of them.

## Querying from another project

The database is meant to be taken and used elsewhere, so it is arranged for
a reader who did not build it.

**`public` is data, `ops` is machinery.** Job history, per-source download
progress and backup bookkeeping live in a separate `ops` schema. `public`
holds only the tables worth querying (currently seventeen). Nothing in `ops` is needed to
answer a question about an address — drop the schema entirely if you only
want the data.

**Schema changes and `ip_intel`.** The view depends on the columns it
selects, so Postgres refuses to `ALTER` those columns while it exists. Run
`ip-insight flatten --mode off` before a schema migration and
`ip-insight flatten` after — or expect `cannot alter type of a column used
by a view` from `db push`.

**`ip_intel` is the one-query answer.** The `public` tables are organised by
source (one per feed), which is right for building and auditing and wrong
for using: answering "what do I know about this address" against them means
seven containment queries plus this project's precedence rules rewritten in
your language. `ip_intel` flattens all of it into one relation:

```sql
SELECT * FROM ip_intel
WHERE network >>= '1.1.1.1'
ORDER BY masklen(network) DESC
LIMIT 1;
```

RIR allocation, geofeed city/coordinates, BGP origin ASN with its name and
reach metrics, cloud/anycast/threat/special-purpose flags — one row, any
language, precedence included.

Set `"ipIntelMode"` in `ip-insight.config.json`:

| Mode | Lookup | Build | Storage |
|---|---|---|---|
| `view` (default) | ~40-110ms warm | under a second | none |
| `materialized` | one index probe | ~10+ min full rebuild | flattened rows on disk |
| `off` | — | — | — |

`enrich` brings it up to date at the end of every run; `ip-insight flatten`
does it on demand. A materialized refresh runs `CONCURRENTLY`, so readers
keep seeing the previous contents instead of blocking through a rebuild.

Note the plain view is slower than `@workspace/lookup`'s own sub-20ms path,
structurally: the view runs its range scans as sequential nested loops where
`lookupIp` fires them concurrently. For latency rather than convenience, use
the package or the API.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- CLI: Commander
- DB: PostgreSQL (native `inet`/GiST indexes for unified IPv4/IPv6 containment queries) + Drizzle ORM
- Validation: Zod, drizzle-zod
- API codegen: Orval (from the OpenAPI spec in `packages/api-spec/openapi.yaml`)
- Cron: node-cron (schedules stored in-process; env vars `CRON_COLLECTION` / `CRON_ENRICHMENT` set defaults)
- Frontend: React 19 + Vite + Tailwind CSS v4 + TanStack Query + Recharts

## Cron scheduler

Schedules are managed via the `/schedule` page in the web panel, or via API:
- `GET /api/cron/schedules` — list schedules
- `PUT /api/cron/schedules/:name` — set expression (name: `collection` | `enrichment`)
- `POST /api/cron/trigger/:name` — run immediately

Environment variables for default schedules on startup:
- `CRON_COLLECTION` — e.g. `0 2 * * *` (daily at 2am UTC)
- `CRON_ENRICHMENT` — e.g. `0 3 * * *` (daily at 3am UTC)

## Architecture decisions

### Every optional feature must be removable without breaking anything

A standing rule for this codebase, not advice. Any feature that is not core
to "answer a question about an IP address" gets built so it can be switched
off and, if wanted, deleted outright — with the rest of the system carrying
on unchanged. Concretely that means three things, and a feature is not
finished until all three are true:

1. **A config flag that makes it a genuine no-op.** Off must be
   indistinguishable from never having been built — not "runs but discards
   the result". Unproven or expensive features default to off, so the cost
   is opted into deliberately.
2. **Its own file(s), imported from one place.** No feature logic scattered
   through shared code paths. If deleting the file leaves dangling imports
   in five modules, it was not modular.
3. **Removal instructions written down**, in the file's own header comment
   and in its `docs/` entry — which file to delete, which import line to
   drop, which call site to remove, and an explicit statement of what keeps
   working afterwards.

Existing examples to copy: `maintenance.ts` (all background automation, one
file, off by default, header explains the two call sites to remove); the
`ops` Postgres schema (all build-time machinery, droppable without touching
a single lookup); `packages/shared/src/ipv6-range.ts` (128-bit address
math, one consumer, `dbipLiteIpv6` flag, three documented removal levels in
`docs/99`); `routeAnomalyEnabled` and `mmdbHistoryFields` (heuristics and
maturity-gated fields, both default-off booleans);
`packages/collector/src/enrichment/bulk-load.ts` (the COPY ingest path,
`bulkCopyIngest` flag — and the one example here that defaults *on*, because
it only ever removes work; see `docs/100`).

The reason is not tidiness. This project is meant to be taken apart and
reused — a consumer who wants the database without the automation, or the
lookups without the live BGP feed, should be able to remove what they do
not want in an afternoon rather than untangling it.

- RIR data is streamed line-by-line; records are batched for bulk inserts.
- IP lookup uses an LRU cache for sub-5ms responses on repeated queries.
- Enrichment (cloud ranges, threat feeds, ASN names, geofeeds, GeoNames) is
  decoupled from collection and can run independently.
- Cron state is in-process; expressions survive server restarts via env vars.
- The canonical table merges all sources into a single authoritative range
  view with conflict detection (currently IPv4-only by design — IPv6 support
  there needs 128-bit sweep-line arithmetic, a separate undertaking).
- All persistent logs (NDJSON, `logs/ip-insight.log` by default) are shared
  across the CLI and API server — pull them with `GET /api/logs/export` or
  read the file directly.
- `logs/run-history.log` is a separate, plain-text, one-line-per-finished-run
  log (`[collect]`/`[enrich]`, job id, ingested/skipped counts, final status),
  appended by the CLI's `collect`/`enrich` commands when a job finishes. It
  exists so "how many times did this actually run, and did anything fail"
  is a `tail logs/run-history.log`, not a `jq` pipeline over the NDJSON log —
  useful for a weekly skim when running manually (e.g. a phone/Termux trial)
  rather than on a fixed cron schedule. Same no-rotation tradeoff as the main
  log: it grows unbounded, trim it yourself if it gets large.
- History capture and mmdb publishing are **not automatic** unless you wire
  them up yourself (cron entries, or `historyCaptureEnabled`/scheduled
  publish in a build that has that panel/cron support). Running `collect`/
  `enrich` alone does not archive a baseline or publish a served file — see
  "Background automation — off by default" above.

## Tests

```bash
pnpm test              # unit tests always; integration tests too if DATABASE_URL is set
pnpm run test:unit      # unit tests only, no database needed
pnpm run test:integration  # integration tests only (requires DATABASE_URL)
```

Vitest. Two kinds of test file, told apart by name:

- `*.test.ts` — pure unit tests, no database. Currently covers
  `packages/shared/src/config-file.ts`'s parse helpers (the functions every
  `ip-insight.config.json` key is validated through).
- `*.integration.test.ts` — require a real Postgres via `DATABASE_URL`
  (the same one `pnpm --filter @workspace/db run push` was run against);
  self-skip cleanly when it's unset rather than failing, via
  `describe.skipIf(!process.env.DATABASE_URL)` and a dynamic `@workspace/db`
  import deferred until inside the test (a static top-level import would
  crash at module load with no `DATABASE_URL`, before the skip could apply).

This project's primary correctness check has always been "run it against
real data and look at the output" (see DEPLOY.md) — that stays true, and
these tests don't replace it. What they're for instead: locking in the
handful of *specific* regressions that already happened once, so a future
change can't silently reintroduce them. Right now that's two integration
tests, each named for the bug it guards:
- `collection/resume-sweep.integration.test.ts` — `--resume` called right
  after a crash used to report nothing to resume, because the sweep that
  marks a crashed job resumable only ran on the fresh-start path.
- `enrichment/transaction-atomicity.integration.test.ts` — a few derived
  tables (`asn_profile`, `neighborhood_stats`, `asn_reach`) used to delete
  and rebuild without a transaction, so a crash between the two left the
  table empty instead of stale.

Not a general test-everything mandate: add a new one the same way, when a
bug is fixed, named for the bug — not as a coverage-percentage exercise.

## Gotchas

- First run: `ip-insight collect` (or the Collection page in the web panel)
  to download all RIR data, then `ip-insight enrich` (or the Enrichment page).
  `ip-insight refresh` does both back to back.
- DB schema changes: run `pnpm --filter @workspace/db run push` after editing
  schema files in `packages/db/src/schema/`.
- After OpenAPI spec changes: run `pnpm --filter @workspace/api-spec run codegen`
  before touching frontend code.
- `ip-insight backup create`/automatic backups need `pg_dump`/`pg_restore` on
  `PATH` (`apt install postgresql-client` on Debian/Ubuntu) — without them,
  backups are silently unavailable (logged once), everything else still works.
