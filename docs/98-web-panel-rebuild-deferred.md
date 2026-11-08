# 98 — Web panel: full rebuild deferred until the product is complete

Decision recorded 2026-08-23, prompted by an `apps/web` build failure
(`BASE_PATH environment variable is required but was not provided`) hit
while testing an unrelated CLI change. Confirmed the failure is pre-existing
and unrelated to that session's work — `apps/web/vite.config.ts` has
required `BASE_PATH` since before this session touched anything in
`apps/web`, and it was simply never documented anywhere (`README.md`,
`docs/`), so a fresh terminal with no exported env var hits it immediately.
Not fixed here — the founder's call was to stop working on `apps/web`
piecemeal at all, for a reason below, not just to patch this one variable.

## The decision

The current web panel is not being incrementally patched anymore. It was
built early, for a technical operator, and has fallen behind what the CLI
now exposes. Rather than keep bolting features onto it as they land in the
CLI/API, it gets rebuilt from scratch as one deliberate pass, **after
IP-Insight-Engine itself is functionally complete** (data pipeline, mmdb
publish, all the features already shipped and whatever's still pending) —
not before, and not concurrently.

## What the rebuild has to satisfy

Stated requirement, in the founder's own framing: usable by **the least
technical person who's authorized to touch it** — not "another engineer,"
not "the founder." Concretely, that means:

- Minimal technical surface — no jargon a non-engineer would have to learn,
  no screen that assumes familiarity with CLI concepts (jobs, sources,
  enrichment, RIR, etc.) without explaining them in place.
- Full documentation alongside every feature — not a separate manual to
  read first, but explained where it's used.
- Every operation the CLI can do that a non-technical operator would
  plausibly need (checking status, triggering a refresh, reading a lookup
  result, seeing what's costing money) needs a panel equivalent that
  doesn't require reading `docs/96-cli-command-reference.md` first.

## What this means for the CLI/API in the meantime

Nothing changes. `apps/cli` and `apps/server`'s API keep receiving whatever
this project needs (this session's DB-IP Lite source and allocation-
freshness fields, future ones) exactly as before. `apps/web` is frozen as
of this note, not maintained in step — expect it to be further behind by
the time the rebuild actually starts, which is expected and fine, since it
gets replaced rather than caught up.

## Status

Not started. No design work done yet. Revisit once IP-Insight-Engine
itself is called done — see `docs/00-index.md`'s status section for what
"done" currently means.
