# Deploy guide

How to stand this project up and change it safely. Split out of `DEPLOY.md` on 2026-08-07.

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

## Part 2 — The change playbook

Each entry is a change you will make, and the places it has to reach. These
are written down because in every case, missing one of them produced a bug
that looked like something else.
