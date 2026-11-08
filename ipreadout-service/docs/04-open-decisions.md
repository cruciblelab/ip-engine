# Open decisions

Written 2026-08-25, updated the same day after a full pass through every
item. Each entry now says what's decided and what (if anything) is still
genuinely open under it — nothing here should read as "fully resolved"
unless it explicitly says so.

## 1. Accounts & API keys

**Decided (principle):** use established open-source libraries/tooling
rather than building auth from scratch — "sıfırdan yapmak daha riskli."
**Open:** which library/tool specifically (not picked), and the actual
signup flow, key rotation/revocation mechanics, multi-key-per-account
support.

## 2. Billing & payment

**Decided:** manual for now — no automated subscription/payment system at
launch. Explicitly: "otomatik ödeme sistemi olmayacak, abonelik için
erken." Payment-system research (which processor, how it works) needs to
happen before any automation is built.
**Open:** the plan shape (quota+overage / per-request / seats) itself
still isn't picked — deferred along with the rest of pricing.

## 3. Terms of Service & Privacy Policy

**Decided (timing):** written at actual public launch — when the domain
goes live on the real VDS, not before.
**Open:** the content itself needs a real legal review, not an
AI-drafted document — unchanged from the original flag.

## 4. Data retention & logging

**Decided:** general operational logs are kept, but **the actual queried
IP addresses (what a customer looked up) are never stored** — a
deliberate privacy choice, not an oversight. Logs are retained "up to a
certain point," i.e. there is a cap.
**Open:** the exact retention duration/size limit hasn't been given a
number yet.

## 5. API versioning

**Decided:** yes, versioned, starting at `v1`.
**Open:** error-format consistency (a single envelope across all
endpoints) wasn't addressed separately — worth confirming it's still
wanted, since it was originally bundled with the versioning question.

## 6. CORS

**Decided:** browsers may call the API directly without an API key —
unauthenticated (keyless) calls from a page's own JavaScript are fine,
because they fall under the same 100 req/min-per-IP keyless limit
already designed in `01-rate-limiting-and-abuse-protection.md`. No
extra exposure from allowing it.
**Recommended, not yet explicitly confirmed:** API-key-authenticated
calls should stay server-to-server only, not made from browser
JavaScript — embedding a real key in public page source lets anyone
steal it from "view source" and spend the account's quota. The API can
still work if someone does this anyway; it just shouldn't be the
documented/recommended pattern.

## 7. The `.mmdb` transfer & rollback mechanism

**Decided, in real detail:**
- The engine places the new `.mmdb` file directly into the path
  `ipreadout-service` reads from (same VDS, shared filesystem — no
  network transfer needed today).
- The previous 3–5 versions are kept as rolling backups before being
  overwritten.
- If validation fails **before** the swap, the new file is never put in
  place — the service keeps serving the last good one.
- If a problem is detected **after** the swap, the service reverts to
  the previous good version automatically.
- Every step of this is logged.

**Worth knowing before building any of this from scratch**: the engine
repo already has a `mmdb rollback` CLI subcommand (`apps/cli`, alongside
`mmdb build`/`publish`/`status`) — the rollback logic described above may
already exist in some form there. Check before reimplementing.

## 8. Live-field opt-in parameter

**Decided (shape):** a query parameter per field, e.g. `?reverse_dns=true`
— exact parameter name(s) not finalized. Using one **counts as extra
consumption** against the caller's rate limit/quota, more than an
ordinary lookup — consistent with `01-rate-limiting-and-abuse-protection.md`'s
"separate, stricter limit for live requests."
**Open:** final parameter names; the exact "extra consumption" weighting
(2x? a separate bucket entirely?).

## 9. Low-and-slow abuse pattern detection

**Decided (signal):** flag request sequences with **suspiciously regular,
near-identical timing intervals sustained over a long duration** —
real/organic traffic (and even a legitimate load test) has natural
variance; a long run of near-perfectly-periodic requests is the
tell.
**Open:** the actual algorithm/threshold (how regular is "too regular,"
over what window) — nothing implemented yet.

## 10. Final brand name & domain

**Still open.** Domain specifically confirmed **not** finalized yet
("domain tam kesinleşmedi"). Brand name status unchanged from before —
"IPReadout" remains a working name, not confirmed permanent.

## New idea surfaced this round (not originally on this list)

**Auto-detect the caller's own IP, plus a v4/v6 selector.** Raised while
answering the CORS question — a genuinely different, separate feature
idea: calling the lookup endpoint with no IP specified returns
information about the caller's *own* address (the same pattern
ipinfo.io-style "what is my IP" APIs use), with a parameter (something
like `-v4`/`-v6`, exact shape undecided) to pick which family when the
caller has both. Worth designing properly and adding to the Docs page —
tracked in its own file: `05-api-conveniences.md`.
