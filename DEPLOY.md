# Deploying and changing this project

Two things live here:

1. **[Part 1 — Standing it up](#part-1--standing-it-up)**: a fresh server to a
   running daily cycle, in order, with the traps that cost real time.
2. **[Part 2 — The change playbook](#part-2--the-change-playbook)**: when you
   edit X, these are the other places that must change. Every entry exists
   because getting it wrong already happened once.

`README.md` explains what the commands do. This explains what to run, in what
order, and what breaks if you don't.

---

## Sizing

Measured on a real database (654k allocations, 1.5M BGP prefixes, 692k
geofeed rows, 2.67M-prefix history baseline):

| Component | Size |
|---|---|
| Whole database | **4.2 GB** |
| ↳ `prefix_baseline` (history) | 2.6 GB |
| ↳ `rpki_roas` | 323 MB |
| ↳ `prefix_history` | 302 MB, grows with churn |
| ↳ `bgp_origin_ranges` | 272 MB |
| Materialized `ip_intel` | ~870 MB |

| Goal | RAM | Disk |
|---|---|---|
| Collect + serve, no history | 2 GB | 25 GB |
| **Accumulate history** | **8 GB** (16 comfortable) | **60–80 GB** |

**1 GB is not enough for history, and the reason is a chain worth
understanding:** history capture requires `ip_intel` to be *materialized*,
and building that materialized view is join-heavy. On a tuned 16 GB / 4-core
machine it took **4.7 hours** (measured). On 1 GB, `shared_buffers` lands
around 256 MB and every join spills to disk continuously — expect days, or
never. A 1 GB box can collect and serve, but it cannot accumulate the
history that is the whole reason to start early.

The 8 GB figure is **inferred, not measured** — 16 GB was measured, 4 and 8
were not. Time your first materialized build and replace this number.

Disk: don't size for the 4.2 GB database alone. Budget for it, plus the
materialized view, plus history growth, plus `backupRetentionCount` (default
7) full `pg_dump` files, plus temp space during builds.

---

## Part 1 — Standing it up

### 1. Postgres, and tune it before anything else

**This is a prerequisite, not an optimisation.** Stock Postgres defaults
(`work_mem` 4 MB, `shared_buffers` 128 MB) assume a machine from another era.
On stock settings the materialized build ran **54 minutes without finishing**
here; tuned, the same build completed. Do this first or you will misdiagnose
everything after it as "the code is slow".

```sql
ALTER SYSTEM SET shared_buffers = '2GB';        -- ~25% of RAM
ALTER SYSTEM SET effective_cache_size = '6GB';  -- ~75% of RAM
ALTER SYSTEM SET maintenance_work_mem = '1GB';
ALTER SYSTEM SET work_mem = '64MB';             -- per operation, ×parallel workers
ALTER SYSTEM SET max_parallel_workers_per_gather = 4;  -- = cores
ALTER SYSTEM SET random_page_cost = 1.1;        -- SSD
```
Then restart Postgres. Scale to the box you actually have.

### 2. Code and schema

```bash
pnpm install
pnpm run typecheck:libs          # builds dist/ — packages resolve through it
echo "DATABASE_URL=postgresql://user:pass@localhost:5432/ipdb" > .env
pnpm --filter @workspace/db push
```

`.env` is gitignored. Keep it that way — it holds the database password.

### 3. Config — the two settings that are off by default

```json
{
  "ipIntelMode": "materialized",
  "historyCaptureEnabled": true
}
```

in `ip-insight.config.json` at the repo root. Both default to off on
purpose: materialized costs hours to build, and capture requires it. A
deployment that wants history must set both, and nothing warns you if you
forget — history simply never accumulates.

### 4. First run, in this order

```bash
ip-insight collect          # RIR allocations
ip-insight enrich           # everything else; ends by building ip_intel
ip-insight history capture  # first baseline
ip-insight status --detail  # confirm
```

**The `enrich` step will appear to hang for hours.** It is building the
materialized view. Time it — that number sets your daily schedule.

`history status` will say `baseline-only` after the first capture. That is
correct: one capture establishes the baseline and by definition observes no
change. The second one is the first that can record anything.

### 5. The daily cycle

```cron
0 3 * * *  cd /srv/ip-insight && /usr/bin/node apps/cli/src/index.ts cycle >> /dev/null 2>&1
```

**The `cd` is not optional.** Config and log paths resolve from the working
directory. Cron runs from the user's home. Without the `cd`:
- `ip-insight.config.json` is not found → every setting takes its default
- `ipIntelMode` defaults to `"view"` → *(enrichment refuses to convert an
  existing materialized view, so it survives — but nothing else you set applies)*
- logs land in `~/logs/` where nobody looks

`cycle` logs `cwd` and the config file it actually loaded as its first line,
precisely so a wrong cron entry is visible the next morning. If a `cd` is
impractical, set `IP_INSIGHT_CONFIG` and `LOG_DIR` instead.

`>> /dev/null` is safe because everything meaningful goes to
`logs/ip-insight.log`. A non-zero exit still marks the run failed.

Overlap is handled in-process by a Postgres advisory lock — a second cycle
exits quietly rather than running concurrently. Repeated skips in the log
mean the schedule is tighter than one pass takes.

### 6. Publishing the served file

```bash
ip-insight mmdb publish --dir /srv/mmdb
```

Build the golden set from **your own** data before relying on it. The
built-in default asserts a handful of well-known addresses; if your database
disagrees with any of them the publish will reject, which is the mechanism
working, not a bug. Check with `ip-insight lookup <ip> --json` and write your
own `--golden` file.

Point your serving process at `/srv/mmdb/current.mmdb` — a symlink, repointed
by atomic rename, so a reader never sees a partial file.

`ip-insight mmdb rollback --dir /srv/mmdb` returns to the previous file
without a rebuild.

### 7. Checking it stayed working

```bash
ip-insight status --detail   # sources, freshness, history maturity
ip-insight history status    # captures, including skipped ones and why
ip-insight mmdb status       # what is serving, what was rejected
```

The failure mode to watch for is not an error — it is silence. A capture
that keeps recording `skipped`, or an mmdb candidate that keeps being
`rejected`, means the data quietly stopped moving forward while everything
appeared fine.

---

## Part 2 — The change playbook

Each entry is a change you will make, and the places it has to reach. These
are written down because in every case, missing one of them produced a bug
that looked like something else.

### Adding a data source

1. **URL** → `packages/collector/src/sources-registry.ts`. Never inline a URL
   anywhere else — this file exists so an upstream moving a file is a
   one-line edit, and so a deployment can override it via
   `sources.registry.json` without touching code.
2. **Source definition** → `enrichment-sources.ts`: id, `kind`, `parser`,
   and a `license` entry. Fill the licence in properly; "published publicly"
   is not a licence, and at least one publisher (Netflix) restricts use in a
   way that matters.
3. **Parser** → `enrichment.ts`: a `case` in the switch plus the function.
   Reuse an existing parser if the format matches — ten verified-bot feeds
   share one parser because they share Google's JSON shape.
4. **Health floor** → `ingestion-health.ts`, so a source silently returning
   nothing is caught.
5. **Run it, then look at the rows.** Not the log line — the rows:
   ```sql
   SELECT * FROM <table> WHERE source_id = '<new>' LIMIT 20;
   ```
   A real feed contained `MONGOLIA` in a two-letter country column. Typechecks
   pass, ingestion reports success, and the API serves a value that breaks its
   own contract.

### Adding a column to `ip_intel`

**Three places, and missing the third is silent:**

1. `packages/db/src/views/ip-intel.ts` — the `SELECT`, and the base UNION if
   the new table's prefixes are narrower than surrounding ones.
2. `mmdb-export.ts` — the `IntelRow` interface **and** `toRecord()`.
   `toRecord` is an allowlist: a column absent from it never reaches the
   served file.
3. Rebuild: `ip-insight flatten --mode materialized`.

This has already gone wrong: `verified_bot` was added to the view and the
interface but not to `toRecord`, so it existed in the database and was
missing from the artifact. The publish gate caught it. Without that gate it
would have shipped.

### Adding a lookup feature

1. `packages/lookup/src/config.ts` — the `LookupFeature` union **and**
   `ALL_LOOKUP_FEATURES`.
2. `lookup.ts` — the result type, the query, the assembly, and the
   `found: false` default.
3. **A deployment with a pinned `lookupFeatures` list will not get it.**
   Omitting the setting entirely means "all, including future additions" —
   that is the safer default. A feature can be complete, correct, and invisible
   because a config file enumerates the old set.

### Adding a schema table

1. `packages/db/src/schema/<name>.ts`, then export it from `schema/index.ts`.
2. `pnpm --filter @workspace/db push`.
3. If a derived source computes it, add the parser to the union in
   `enrichment-sources.ts` and a handler entry in `enrichment.ts`'s
   `derivedHandlers` map.

### Writing an aggregate over range tables

Drive from the **smallest** table in the join. The first version of the ASN
profile asked, for each of 1.5M prefixes, four questions of other tables —
~9M index probes, and it did not finish in ten minutes. Rewritten to drive
from the small side (2.5k anonymity rows, 61k cloud), the same answer takes
thousands. When a containment aggregate is slow, the fix is almost always
which side drives it, not indexes or settings.

### Before shipping any change

```bash
pnpm run typecheck        # the whole monorepo, not one package
pnpm test                 # unit tests always; integration tests too if DATABASE_URL is set
```

Then **run it against real data and look at the output.** Every serious bug
in this project's history passed typecheck: a country column holding
`MONGOLIA`, an ASN serialised as `"15169"` instead of `15169`, RDAP fetched
twice per lookup, a hash that silently covered nothing for the largest
sources. None were type errors. All were visible in one query or one lookup.
The test suite exists for a narrower job than "run it against real data" —
it doesn't replace that step, it locks in the specific regressions that
already happened once (see "Tests" in README.md) so they can't happen again
silently.

---

## Traps worth knowing once

- **A removed source does not remove its rows.** Deleting a source from the
  code leaves everything it ingested in place. `threat_ranges` held 1,668
  rows of a feed removed for licensing reasons, weeks after the code was
  gone. Check the table, not the source list.
- **`db.execute()` returns driver values, not schema types.** A timestamptz
  comes back as a string, not a `Date`, regardless of what the generic says.
  Wrap in `new Date(...)`.
- **`bigint` columns arrive as strings**, to protect precision above 2^53.
  Coerce deliberately where a number is expected.
- **Config is read from the working directory.** True for the CLI, the log
  path, and the sources registry. It is the single most common reason
  something behaves differently in cron than in your shell.
- **`--resume` used to only find a job if something had already marked it
  `interrupted` — fixed.** That marking (`sweepOrphanedCollectionJobs`/
  `sweepOrphanedEnrichmentJobs`) only ran at the top of a **fresh**
  `collect`/`enrich` call, never on the resume path — including the id-less
  `--resume`, which resolves its default job entirely through
  `listResumable*Jobs()` without calling `startCollection`/`startEnrichment`
  at all. A job that crashed and was resumed with the very next command
  (the most common time to call `--resume`) reported `"No interrupted job
  to resume."` because nothing had swept it yet. Fixed by sweeping inside
  `startCollection`/`startEnrichment` **before** branching on
  `resumeJobRef` (`collection/collector.ts`, `enrichment/enrichment.ts`),
  and additionally inside `listResumable*Jobs()` itself, since that's what
  the id-less path actually calls. Covered by
  `packages/collector/src/collection/resume-sweep.integration.test.ts`.
- **Resume granularity is a whole source, never a byte offset.** A source
  already `completed`/`skipped` is left alone on resume; anything else is
  reset and rerun from scratch. Fine for most sources; means a slow single
  source (e.g. `asn-profile`) restarts from zero if it was the one running
  when the crash happened.
- **A few derived enrichment tables used to not be crash-atomic — fixed.**
  `asn_profile`, `neighborhood_stats`, and `asn_reach` were each computed as
  a `DELETE FROM x` followed by a separate `INSERT ... SELECT`, with nothing
  tying the two together. A crash between them left that one table empty
  until the next successful run. Every other table (raw/source data) uses
  `ON CONFLICT DO NOTHING` inserts and never had this gap. Fixed by wrapping
  each pair in `db.transaction()` (`packages/collector/src/enrichment/
  enrichment.ts`). Covered by `packages/collector/src/enrichment/
  transaction-atomicity.integration.test.ts` (proves the rollback guarantee
  the fix relies on, against the real `asn_reach` table).
- **`sourceRetryMaxAttempts` (whole-source retry with exponential backoff)
  works today but was missing from the Settings API response, the Settings
  UI, and the OpenAPI schema** in a build that has the editable-Settings
  panel — it's a real config key, just invisible there. Set it directly in
  `ip-insight.config.json` in the meantime. Worth re-adding to
  `buildSettingsResponse()`/`Settings.tsx`/the OpenAPI `Settings` schema in
  any checkout that has that panel code.
- **`anycast_ranges` used to only get seeded by `apps/server` starting up —
  fixed.** `ip_intel`'s `is_anycast` column joins against this table; the
  ~20-entry curated list (Cloudflare/Google/Quad9/OpenDNS public DNS, IANA
  root servers) that populates it was only ever written by `seedAnycastTable()`,
  called exclusively from `apps/server`'s startup. A CLI-only deployment —
  `collect`/`enrich`/`flatten`, never `apps/server` — silently never seeded
  it, so `ip_intel.is_anycast` came back `false` even for 1.1.1.1/8.8.8.8,
  while `ip-insight lookup` still answered correctly (it has its own
  in-memory copy of the same list as a fast-path fallback, independent of
  the DB table). Confirmed on real data: 1.1.1.1 showed `is_anycast: f` in
  `ip_intel` with an empty `anycast_ranges` table, `t` after reseeding.
  Fixed by moving the curated list and `seedAnycastTable()` into
  `@workspace/db` (`anycast-seed.ts` — `@workspace/lookup` now builds its
  in-memory list from the same data instead of duplicating it) and calling
  it at the top of every `enrich` run, so a CLI-only deployment self-heals
  without ever needing `apps/server`. **Consequence for any materialized
  `ip_intel` built before this fix**: its `is_anycast` column (and anything
  derived from it) is wrong for every real anycast address. Fix: re-run
  `ip-insight flatten --mode materialized --refresh` (another full rebuild —
  there's no cheaper partial-column fix) to correct it. If a history
  baseline was already captured against the bad data, the next capture will
  report every anycast address as "changed" — that's the bug being
  corrected showing up as a one-time false change, not a real network
  event; expected, not a sign of a new problem.
- **"No feed exists for X" is a fact with a timestamp, not a permanent
  property of the operator — re-check at the primary source before trusting
  an earlier pass's negative finding.** SOURCES.md previously documented
  Anthropic and Common Crawl as checked-and-rejected for verified-bot
  ranges: Anthropic's own docs stated "we do not currently publish IP
  ranges" and Common Crawl had no equivalent file. Both now do
  (`claude.com/crawling/bots.json`, `index.commoncrawl.org/ccbot.json`,
  added this session) — the operators changed their minds, the document
  didn't get stale on purpose. Re-verified directly against each operator's
  own domain rather than a third-party "AI crawler IP list" aggregator site:
  several of those returned plausible, specific-looking CIDRs that didn't
  match the real files when checked against the primary source, which is
  its own trap — a confident-sounding secondary source is not verification.
- **Node's built-in `fetch` does not read `HTTPS_PROXY`/`https_proxy` —
  `curl` does, silently, which makes a "the feed doesn't work" impression
  when it's actually only this process's networking.** Only surfaces in an
  environment that requires an outbound proxy (a sandboxed dev container,
  a locked-down corporate network); a normal server with direct internet
  egress never hits this. If `enrich` reports a source failing with a
  connect/reset error that an equivalent `curl` to the same URL doesn't
  reproduce, suspect this before the upstream. Not worked around in product
  code — it would be a needless dependency for every real deployment, which
  runs with ordinary direct egress.

### Running on modest/mobile hardware (e.g. Android + Termux, as a trial)

Verified end-to-end on a phone: Postgres + Node under Termux, no VDS.

```bash
pkg install postgresql nodejs-lts git unzip
termux-setup-storage
initdb $PREFIX/var/lib/postgresql
pg_ctl -D $PREFIX/var/lib/postgresql -l $PREFIX/var/lib/postgresql/log start
createuser -s postgres
# then, in psql: ALTER USER postgres WITH PASSWORD '...';
```

Don't skip the schema push — it's easy to forget on a from-scratch box and
the failure (`relation "ops.collection_jobs" does not exist`) looks like a
DB connection problem, not a missing-migration problem:
```bash
export DATABASE_URL=postgresql://postgres:...@localhost:5432/ipdev
pnpm --filter @workspace/db run push
```
(`drizzle.config.ts` reads `process.env.DATABASE_URL` directly — it does not
load `.env` itself, so exporting it in-shell is required for this one command.)

Tune Postgres to the device's real RAM, not the desktop defaults above — e.g.
for an ~11 GB phone: `shared_buffers=1536MB`, `effective_cache_size=5GB`,
`maintenance_work_mem=512MB`, `work_mem=32MB`. `shared_buffers` needs a full
`pg_ctl restart`, not just a config reload, to take effect.

**Android will kill Termux in the background or when the screen locks** —
this is Android's battery/process management, not a bug in this project. Fix:
grant Termux a battery-optimization exemption (Android Settings → Apps →
Termux → Battery → Unrestricted; MIUI/Samsung/Huawei/Oppo have their own
extra "autostart"/"protected apps" toggle on top of stock Android's), and
consider `termux-wake-lock` for long unattended runs.

Real network flakiness (mobile data/Wi-Fi handoffs, not code bugs) showed up
as sources like `ripencc`/`ris-whois-ipv4`/`lacnic-whois-city` failing
mid-stream with `TypeError: terminated` / `SocketError: other side closed`.
`sourceRetryMaxAttempts` (see above) retries the whole source with backoff;
raising it from the default 3 to 5–6 rode out a flaky phone connection that
a fixed VDS network wouldn't need.

Long single-SQL-query enrichment sources (`asn-profile`, `asn-reach`,
`neighborhood-stats`) can run 30–70+ minutes with the ingested-counter
sitting at 0 the whole time — the CLI now prints a "still running (Ns, no
change yet)" heartbeat line every 12s so this doesn't look like a hang.
Confirm aliveness independently with `top` (state `R`, growing `TIME+`) if
in doubt.

`ip-insight flatten` (and the automatic `ip_intel` refresh at the end of
every `enrich` once `ipIntelMode: materialized` is on) has no `--resume` —
unlike `collect`/`enrich`, it isn't job-tracked at all, just one blocking
SQL statement. If Termux gets killed mid-build (screen lock, background
kill, closing the terminal running it), there is nothing to resume: just
re-run the exact same command. The build path always starts with `DROP
MATERIALIZED VIEW IF EXISTS ip_intel_building` (the staging table it builds
under before the atomic rename — see `packages/db/src/views/ip-intel.ts`),
so a half-finished attempt from last time is cleaned up automatically:
safe to rerun from scratch every time, no manual cleanup needed. Run
`termux-wake-lock` first and don't background/lock the screen for the
whole duration — this one still fully restarts from zero on every kill,
so losing it mid-build (has happened) costs the entire elapsed time.

`ip-insight flatten --refresh` used to be silent too, even after the
heartbeat above was added — **fixed.** `--refresh` calls `refreshIpIntel()`
directly, a completely separate code path from the `ensureIpIntel(mode)`
path the heartbeat was wrapped around, so adding it in one place didn't
cover the other. `REFRESH MATERIALIZED VIEW CONCURRENTLY` recomputes the
whole relation (not an incremental diff), so `--refresh` can take just as
long as the original build — now has the same 30s heartbeat.

### Planned: staging environment on the VDS, once it exists (not built yet)

Discussed, not yet set up — for when the phone trial ends and the VDS is
provisioned. The goal: never let an update reach the real, customer-facing
instance without a check in between, and never have two things (an
automated push and a manual copy) touching the same production files
without a single source of truth.

- **A fully separate staging deployment** on the same VDS: its own
  directory (e.g. `/srv/ip-insight-staging`), its own database (e.g.
  `ipdev_staging` — never the production database, so a test can't corrupt
  real collected data), its own `.env`.
- **Reachable only via a private URL**: a non-public port or subdomain plus
  a long random token in the URL (not just a guessable port), so it isn't
  discoverable by anyone who doesn't already have the link.
- **Flow**: a change is pushed to GitHub and deployed to staging in the
  same step → the operator opens the private staging URL in a browser (no
  terminal needed) and checks it → on explicit "push it", the identical
  build is promoted to the production directory/service and restarted →
  one more check against the live URL to confirm parity.
- **Single source of truth**: production is only ever updated this way —
  never a direct one-off manual edit on the box in parallel with an
  automated deploy. Whichever of the two happens outside this flow is what
  causes drift and "wait, which version is actually live" confusion.

### Verification pass after the first materialized build — two things that look like bugs and aren't

Found while spot-checking real IPs against `ip_intel` after the first
phone `flatten --mode materialized` (worth repeating after any future
build that feels off):

- **`threat_flagged` / `is_threat` reading 0 for everything is expected,
  not a bug.** `threat_ranges` has no source wired up by default —
  Spamhaus DROP/EDROP (the obvious feed) has redistribution terms unclear
  enough to not bulk-ingest without a paid licence; see
  `enrichment-sources.ts`'s own comment and SOURCES.md. The table and
  `ip_intel` join are ready; nothing populates them until a licensed (or
  clearly-licensed free) threat feed is wired up. See the "candidate data
  sources" list below.
- **A `geo_source` mismatch between `ip_intel` and `ip-insight lookup` for
  the same IP, right after running `lookup` — expected, not a bug.**
  Geofeed discovery beyond the known batch sources runs live, per-address,
  on a cache miss inside `lookup` itself (an RDAP check for a
  self-published geofeed — see `enrichment-sources.ts`'s "geofeed" entry),
  and caches what it finds straight into `geofeed_ranges`
  (`source_id: 'geofeed-discovery:rdap-live'`). A materialized `ip_intel`
  is a snapshot from its last build, so anything discovered live afterward
  is invisible to it until the next `flatten --refresh`. Confirmed on real
  data: an Albanian ISP's block showed `country-estimate` in `ip_intel`
  and `geofeed` (with a full city) from `lookup` moments later —
  `geofeed_ranges` had the new row timestamped right at the `lookup` call.

### Candidate data sources — discussed, not yet built, roughly prioritized

Prompted by "what else could we add without hitting licence problems like
Spamhaus." All below are either self-published-for-verification (same
licence-safe shape as the Tor/cloud/bot sources already in the codebase)
or have clear open licences. None of this is committed — revisit this list
before starting any of it, priorities may have shifted.

1. **Typed history change events** (`PrefixChanged`/`ASNChanged`/
   `GeoChanged`/`ThreatChanged`) — no new data needed, `ops.prefix_history`
   already holds the old/new record pair; this is decomposing the existing
   whole-record diff into typed fields. Directly extends the history
   feature that's the whole point of turning `historyCaptureEnabled` on.
2. **More verified-bot feeds — done.** Re-checked Anthropic, Meta, and
   Common Crawl at their primary sources rather than trusting this list:
   Anthropic (`claude.com/crawling/bots.json`, one combined feed for
   ClaudeBot/Claude-User/Claude-SearchBot) and Common Crawl
   (`index.commoncrawl.org/ccbot.json`) now publish machine-readable lists
   in the same JSON shape the existing `bot-prefixes-json` parser already
   handles — no new parser needed. Meta still doesn't (still only
   whois/AS32934); left out, same as before. See the "Verified bots
   re-checked" entry below and SOURCES.md's "Verified bots" section for the
   full reasoning and real ingested counts.
3. **Starlink / satellite `connection_type` — done.** Added `satellite` to
   `ConnectionType` and a fixed AS14593 allowlist checked by ASN number
   (not name text — Starlink's holder name varies across whois data, the
   ASN doesn't) in `connection-type.ts`, ahead of the text-pattern loop.
4. **FireHOL IP Lists** (github.com/firehol/blocklist-ipsets) — the actual
   fix for `threat_flagged` reading 0; per-list licences stated explicitly,
   mostly open. Real effort (new parser), real payoff (closes an expected-
   but-missing feature).
5. **abuse.ch feeds** (Feodo Tracker, URLhaus) — malware C2/distribution
   IPs, a specific complement to FireHOL's broader aggregation. Do after
   FireHOL, not instead of it.
6. **More VPN / hosting providers — checked, one added, three declined.**
   Linode publishes a real RFC 8805 geofeed (`geoip.linode.com`) — added,
   reusing the DigitalOcean geofeed parser as-is, 5,445 rows on a real run.
   ProtonVPN, Cloudflare WARP, Hetzner, and OVH were all checked and none
   publish a genuine first-party feed the way Mullvad/AWS/GCP/DigitalOcean/
   Linode do (ProtonVPN's unauthenticated API was shut off and Proton says
   so explicitly; Cloudflare doesn't publish WARP egress ranges at all;
   Hetzner/OVH have no published IP-range file, only unconfirmed third-party
   mirrors) — see SOURCES.md's Layer 4/5 sections for the specifics of what
   was checked. Not added, matching the Spamhaus precedent: no citable
   first-party source, so no feed, not a guess dressed up as one.
7. **Team Cymru Bogon list** — probably **not** worth adding: likely
   substantially redundant with data already collected (`ip_blocks.status
   = 'available'` from the RIR files plus the IANA special-purpose
   registry already cover most of what a bogon list is). Check for a real
   gap before building anything here.
8. **PeeringDB / IXP detection** — deprioritized: IXP peering-LAN addresses
   are infrastructure space, essentially never seen in real end-user
   request traffic, so this signal would rarely fire for the fraud-
   prevention/geolocation/licensing use cases this project actually
   targets. Niche value for the effort.
