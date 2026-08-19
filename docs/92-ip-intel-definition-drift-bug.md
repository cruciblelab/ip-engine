# The ip_intel definition-drift bug — found, fixed, self-healing

Split out of `DEPLOY.md` on 2026-08-07.

---

## Real bug found and fixed: `REFRESH MATERIALIZED VIEW` never picks up a changed view definition (2026-08-07)

Found via the Stage 0 row-set equivalence check above, not by inspection —
worth recording the investigation, not just the fix, since every simpler
explanation was ruled out by direct measurement first: query-level
non-determinism (same recompute run twice, same connection → 0 disagreements),
tie-breaking ambiguity at the top rank (0/330 sampled bases had one), and
tie-breaking ambiguity anywhere in the candidate list (0/330 again). Only
after eliminating all three did looking at one concrete mismatched row
(`stored_wider_asn` NULL vs recomputed 137443, same `bgp_origin_ranges` —
confirmed unmodified since 22:49 on 2026-08-06, well before this refresh
ran) point at the relation's own stored definition — and
`SELECT definition FROM pg_matviews WHERE matviewname = 'ip_intel'`
confirmed it: the phone's materialized `ip_intel` was still running the
`wider`-LATERAL shape `ip-intel.ts`'s own comment names as *replaced* by
the current `bgp`/`candidates` LATERAL, from before that refactor.

**Root cause**: `refreshIpIntel()` ran `REFRESH MATERIALIZED VIEW
CONCURRENTLY ip_intel` — which recomputes *data* against whatever `SELECT`
was captured at `CREATE` time. Postgres has no mechanism to notice
`IP_INTEL_SELECT` changed in the source file since then. Every `enrich`/
`cycle` run refreshed data through the *old* query, correctly and
silently, for as long as the relation existed — which on this phone was
since before this session's `wider_prefix_asn` refactor, meaning `route_anomaly`
and possibly other recently-added `ip_intel` columns had never actually
reflected current logic despite this session's `cycle` runs completing
successfully and `export-mmdb` producing files that looked entirely
healthy (right row counts, no errors, `validate()`'s field-completeness
check green — none of which can detect "the definition is stale," only
"did a field go bulk-null").

**Fix, in `packages/db/src/views/ip-intel.ts`**: `IP_INTEL_SELECT_HASH`
(a sha256 of the SELECT text, computed once at module load) gets stamped
via `COMMENT ON MATERIALIZED VIEW ip_intel IS '<hash>'` at the end of
every full build, inside the same transaction as the staging-to-live
rename. `refreshIpIntel()` now checks the stored comment
(`obj_description('ip_intel'::regclass, 'pg_class')`) against the current
hash before choosing a path: match → the cheap `REFRESH ... CONCURRENTLY`
as before; mismatch (including no comment at all, which just means a
relation built before this fix existed) → a full rebuild through the
existing staging-and-swap machinery (refactored out of `ensureIpIntel`
into a shared `rebuildIpIntel()` so both the mode-change path and this
drift-triggered path use one implementation). `ensureIpIntel()`'s
materialized branch now just calls `refreshIpIntel()`, which makes the
right call itself.

**A real bug caught in the fix itself, before it shipped**: the first
version wrote `sql\`COMMENT ON MATERIALIZED VIEW ip_intel IS ${hash}\`` —
parameterized, the pattern used everywhere else in this codebase. Verified
against a real Postgres rather than assumed safe: `COMMENT ON ... IS $1`
is a syntax error (`COMMENT ON` has no parameter placeholder in its
grammar). Fixed with `sql.raw()` and the hash inlined as a literal —
safe specifically because the value is always this project's own
`sha256(...).digest("hex")` output, 64 characters from `[0-9a-f]`, which
cannot contain a quote or backslash to break out with. Would not have been
safe for a value from anywhere else.

**Verified**: `pnpm run typecheck` clean; full suite 74/74 unaffected;
the comment/hash mechanism itself checked against a real Postgres with a
trivial materialized view standing in for `ip_intel` (the real view's own
query hit an unrelated sandbox planner-statistics problem — see below —
that made it impractical to exercise end-to-end here) — confirmed a
`REFRESH` leaves the stamped comment untouched, and a rebuild correctly
re-stamps it to the new hash.

**Unrelated sandbox artifact found while verifying this, worth recording
so it isn't mistaken for a real bug later**: this sandbox's Postgres
produced catastrophically bad row estimates (millions of estimated rows
against `bgp_origin_ranges` etc.) for `IP_INTEL_SELECT` even with every
base table at 0 live rows, confirmed via `pg_stat_user_tables`, and an
`ANALYZE` didn't fix it. Sandbox-specific — the phone's real Postgres (real
row counts, real `ANALYZE` history) is not expected to have this, and
nothing about it relates to the actual `ip_intel` definition-drift fix
above.

**What the founder needs to do — nothing beyond a normal refresh, by
design.** This bug is self-healing once the fixed code is deployed: the
very next `refreshIpIntel()` call (from a `cycle`, an `enrich`, or
`ip-insight flatten --refresh`) finds no matching stamp on the phone's
current `ip_intel`, since it was built before this fix existed, and
automatically takes the full-rebuild path instead of a cheap refresh — no
special command needed. The unavoidable cost: this rebuild pays the full
materialize time again (the ~6h07m this session's own `cycle` log shows
for this exact step, or the previously-documented ~4.7h baseline) — real
and not avoidable, since it's the only way to get every column computed
under logic that may have been stale for a while, not just
`wider_prefix_asn`.
