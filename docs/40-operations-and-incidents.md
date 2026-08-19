# Operations, hardware, and real incidents

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Running on modest/mobile hardware (e.g. Android + Termux, as a trial)](#running-on-modest-mobile-hardware-e-g-android-termux-as-a-trial)
- [A real overnight incident, fully diagnosed and fixed (2026-08-05)](#a-real-overnight-incident-fully-diagnosed-and-fixed-2026-08-05)
- [Planned: staging environment on the VDS, once it exists (not built yet)](#planned-staging-environment-on-the-vds-once-it-exists-not-built-yet)
- [Decided, and worth recording so it doesn't get rediscovered as a bug: no cron on the phone, ever — cron comes with the VDS](#decided-and-worth-recording-so-it-doesn-t-get-rediscovered-as-a-bug-no-cron-on-the-phone-ever-cron-comes-with-the-vds)
- [Sandbox instability during this session — noted honestly](#sandbox-instability-during-this-session-noted-honestly)

---

### Running on modest/mobile hardware (e.g. Android + Termux, as a trial)

Verified end-to-end on a phone: Postgres + Node under Termux, no VDS.

```bash
pkg update && pkg upgrade -y
pkg install -y postgresql nodejs-lts git unzip
npm install -g pnpm            # not a pkg package; comes from npm
termux-setup-storage
initdb $PREFIX/var/lib/postgresql
pg_ctl -D $PREFIX/var/lib/postgresql -l $PREFIX/var/lib/postgresql/log start
createuser -s postgres
createdb ip_insight            # easy to miss — initdb makes the cluster, not this database
# then, in psql: ALTER USER postgres WITH PASSWORD '...';
```

Termux's local connections default to `trust` auth, so an empty password in
`DATABASE_URL` works and the `ALTER USER` line above is optional:
`postgresql://postgres:@127.0.0.1:5432/ip_insight`.

**`sudo` does not exist on a non-rooted Termux.** Anything in these docs
written as `sudo pg_ctlcluster ...` is from the Debian-flavoured sandbox
this project is also developed in, and will never work on the phone — use
the `pg_ctl -D $PREFIX/var/lib/postgresql ...` form above. If `pg_ctl start`
reports a stale lock file after an unclean shutdown, check whether the PID
it names is actually alive (`kill -0 <pid>`) before deleting anything.

Verified from scratch against an empty database (2026-08-09): `push` brings
up 29 tables across `public` + `ops` (11 of them `ops`), with 15 SP-GiST and
79 btree indexes and no GiST — i.e. a fresh install gets the fast index
layout from `94-spgist-index-optimization.md` automatically, with nothing
extra to run.

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

**`termux-wake-lock` only stops the CPU from sleeping — it does not protect
against the OS killing a process for using too much memory (OOM-kill).**
Confirmed on the phone this week: a `flatten --refresh` was running in one
Termux session while a separate Python process ran concurrently in another
terminal; the build ended with `[Process completed (signal 9)]` — a kill,
not a crash. Signal 9 (`SIGKILL`) with no error output from the killed
process itself is the signature of the OS forcibly reclaiming memory, not
an application bug. `termux-wake-lock` does nothing to prevent this because
it only touches the CPU wake state, not memory pressure. **Rule: never run
another memory-heavy process (Python scripts, another build, another app
doing real work) at the same time as a materialized build/refresh on the
phone** — the build already uses most of the phone's available RAM by
design (large single SQL statements over millions of rows); anything else
running concurrently is what tips it into an OOM-kill. If a long build must
share the phone with other work, do the other work before starting the
build or after it finishes, not during.

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

### A real overnight incident, fully diagnosed and fixed (2026-08-05)

Worth a full account rather than just the fix — every step here turned out
to have a real, specific explanation, not "phones are flaky."

**What was tried, and why it didn't do what was expected**: the user
backgrounded a running `cycle` with `nohup ... &` before sleeping, then
tried Ctrl+C (nothing to signal — it was already backgrounded, not in the
foreground), then `exit`ed Termux. The expectation was that this would
stop the process; it didn't, because `nohup`'s entire purpose is
surviving exactly the `SIGHUP` an `exit` sends — this was working
correctly, just not in the direction assumed.

**What actually happened overnight**: Android killed the *whole* Termux
session — Postgres and the Node process together, not just the one the
user was trying to stop. Confirmed from Postgres's own crash-recovery log
on restart: `last known up at 2026-08-04 23:43:47`, `database system was
not properly shut down; automatic recovery in progress`. This is the same
Android background/battery-kill this file's own Termux section above
already documents (battery-optimization exemption + `termux-wake-lock`)
— `nohup` alone was never going to be enough against it.

**A real, previously-unnoticed gap this surfaced**: after Postgres died
at 23:43, the CLI's heartbeat kept printing `ip_intel refresh still
running` every 30s for **hours** afterward — `elapsedSec` climbing past
30,000 (~8.4h) — instead of erroring out. The underlying query apparently
hung rather than failing immediately when the local Postgres connection
died, and `withHeartbeat`'s timer is independent of the awaited query's
actual outcome, so it kept reporting "alive" long after the work had
become impossible. Net effect: the user's morning `kill` was killing an
already-doomed process, not interrupting real work — safe either way (a
killed connection just means whatever Postgres was mid-statement on gets
rolled back once Postgres itself is actually running again, same
guarantee as a clean Ctrl+C). Not fixed here (would need the DB layer to
detect a dropped connection and fail the heartbeat loop rather than
waiting on a hung promise) — recorded as a real, specific, reproducible
gap for whoever picks it up, not a vague "sometimes it just hangs."

**Restarting Postgres** (`pg_ctl -D $PREFIX/var/lib/postgresql start`)
recovered cleanly via WAL redo. No data loss from the crash itself — the
next problem was unrelated.

**The real scare: `relation "ip_blocks" does not exist`.** Not data loss
— connected to the *wrong* database. `psql -U postgres -l` showed two
databases on the same Postgres instance: `ip_insight` (owner `u0_a400`,
the real one — matches this project's actual phone `DATABASE_URL` from
day one of this deployment) and `ipdev` (owner `postgres`, completely
empty — almost certainly created once by running this file's own generic
setup snippet above literally, `ipdev` name and all, rather than this
phone's real values).

**Root cause, confirmed from the actual code, not guessed**:
`apps/cli/src/index.ts` loads `DATABASE_URL` from `~/ip-engine/.env`
whenever it isn't already exported in the shell (an exported value always
wins over `.env` — see that file's own comment). Whatever's sitting in
that `.env` is almost certainly the empty `ipdev` URL. This means **any
run without a manual `export DATABASE_URL=...` first — including an
unattended cron `cycle`**, since this file's own example cron line above
has no export in it at all — **would silently operate on the empty decoy
database instead of the real one.** This had never actually bitten before
today only because every real session so far happened to export
`DATABASE_URL` by hand first; a cron-scheduled run would have hit it on
day one.

**Verified no actual data loss** once pointed at the right database:
`ip_blocks` 655,643 rows, `bgp_origin_ranges` 1,540,923 rows, and
`pg_class.relkind = 'm'` for `ip_intel` — already materialized, exactly
where it should be. The entire overnight ordeal cost time and battery,
never data.

**Fix**: correct `DATABASE_URL` inside `~/ip-engine/.env` itself (not just
export it for one session) to `postgresql://u0_a400@localhost:5432/ip_insight`,
then confirm with `node apps/cli/dist/index.mjs status` run *without* a
manual export first — if it reports the real row counts, `.env` is fixed
for good, which is what actually matters for any future unattended cron
run.

**Lesson worth keeping**: `psql -U postgres -l` (or whichever superuser
exists) is a five-second way to rule out "wrong database" before assuming
data is lost or corrupted — it's what turned an error that looked like
catastrophic loss into a one-line config fix.

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

### Decided, and worth recording so it doesn't get rediscovered as a bug: no cron on the phone, ever — cron comes with the VDS

Stated explicitly by the founder (2026-08-05), because it was previously
discussed but never written down anywhere, and its absence was later
misread as a live operational problem: **the phone is not going to run
anything on a schedule.** `ip-insight collect` / `enrich` / `history
capture` are run **by hand, whenever the founder decides to**, at no fixed
time of day — sometimes morning, sometimes at night, as testing calls for
it, sometimes against fresh data, sometimes replaying against older data.
This is deliberate, not a gap to close: the project is still in an active
testing phase where the shape of what gets run, how often, and in what
order is itself still changing. Wiring a fixed cron schedule onto a
still-changing process would just mean editing the crontab every time the
process changes, for a phone that isn't the target production environment
anyway. Cron is planned for the VDS (see the staging-environment note
above) — once that exists, is stable, and this project stops being a
day-to-day experiment on a phone.

Why this matters for interpreting `history status` output on the phone
today: an irregular, gappy capture history — long stretches with no
capture, `ip_intel` occasionally reverting from materialized to a plain
view between manual runs, a baseline reset here and there — is the
**expected shape of a manually-run testing-phase deployment**, not a
malfunction. A design review that reads that pattern and concludes "the
history mechanism is broken, fix the operational discipline before doing
anything else" is diagnosing the wrong thing if it doesn't know this
context — which is exactly what happened once already this session (see
the stability-score design doc's Gap 4) before this note existed. Anyone
reasoning about *when* a feature that depends on continuous history (a
churn/stability score, for instance) becomes real should read the clock as
starting once cron lands on the VDS, not from whatever the phone's
manual-run history shows today.

Found while spot-checking real IPs against `ip_intel` after the first
phone `flatten --mode materialized` (worth repeating after any future
build that feels off):

- **`is_threat` reading 0 for everything was expected, not a bug — fixed
  this session.** `threat_ranges` had no source wired up: Spamhaus DROP/
  EDROP (the obvious feed) has redistribution terms unclear enough to not
  bulk-ingest without a paid licence; see `enrichment-sources.ts`'s own
  comment and SOURCES.md. FireHOL's blocklist-ipsets was investigated as
  the broad replacement and rejected — every list checked there is either
  Spamhaus/bogons under the hood, non-commercial-only, or explicitly
  restrictive (full breakdown in SOURCES.md's "Layer 6" section). abuse.ch
  Feodo Tracker (CC0, explicit) is wired up instead — narrower than FireHOL
  would have been, but real: confirmed on real data,
  `ip-insight lookup 50.16.16.211` (a QakBot C2 in the live feed) now
  returns `is_threat: true`, `risk.level: "medium"`, both from `ip_intel`
  and from a live lookup. A materialized `ip_intel` built before this
  change will still read 0 for `is_threat` everywhere until the next
  `ip-insight flatten --mode materialized --refresh` (or the next scheduled
  `enrich`, which refreshes it automatically) — same "stale until rebuilt"
  shape as the anycast-seeding fix above, not a new kind of bug.
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

### Sandbox instability during this session — noted honestly

The materialized `ip_intel` rebuild used to real-data-verify the above
died silently partway through twice in this sandbox — once after ~90
minutes with no error in Postgres's own log (just stops mid-checkpoint,
consistent with the whole container being paused/reclaimed rather than a
crash), once more after a restart. This is a sandbox-environment property,
not a code defect — the same kind of "container recycled mid-task" risk
this project's own docs already warn matters for a phone/Termux deployment,
just showing up here as a research-session inconvenience instead. Restarted
Postgres cleanly each time; `ip_intel_building`'s own `DROP ... IF EXISTS`
safety net (see the "Querying from another project" section above) meant
no partial state was ever left behind to clean up by hand.
