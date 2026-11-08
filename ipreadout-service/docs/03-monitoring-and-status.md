# Monitoring & status

Written 2026-08-25.

## Decided

- **UptimeRobot**, free tier — confirmed sufficient for our current scale
  (two components: the Lookup API and the website), no cost.
- **Independent of our own infrastructure, on purpose.** A monitor
  running on the same VDS it's checking can't tell anyone about a total
  VDS failure — the point of an external monitor is that it keeps
  working when we don't.
- **Wiring this up is explicitly post-launch work**, not something to
  build before the service exists: "let's do this after we go live."
- **The public Status page shows real data only, or nothing.** Already
  built as a design draft with this principle: before real monitoring
  exists, the page shows an honest "monitoring begins at launch" empty
  state — no invented uptime percentage, no fabricated incident history.
  Whatever UptimeRobot reports once it's wired up is what the page shows,
  never smoothed over or backfilled.
- **We keep our own copy of the uptime/incident data, not just
  UptimeRobot's.** Stated directly: recorded into our own database so it
  can feed real internal use later — SLA calculations, historical
  reporting, decisions — rather than being permanently dependent on
  UptimeRobot's own API/storage for anything beyond the live display.

## Open

- **Exact schema/mechanism for our own uptime/incident record-keeping** —
  not designed. Likely something in the spirit of the engine's own
  `ops` schema (job/event history, separate from the data itself), but
  nothing has been sketched yet.
- **UptimeRobot integration shape** — badge embed vs. full API
  integration vs. their own hosted status page were compared, no final
  pick since this is deliberately deferred to after launch.
