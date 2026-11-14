# 107 — Parked: where the engine stands (2026-11-14)

The operator decided on 2026-11-14 to park this project and test other
product directions first. This file is the handover: what works, what was
decided, what is open, and how to pick it up again. Nothing below is a
plan to continue — only what someone resuming needs to know.

## Why it was parked

Not because the engine failed. Because the licensing audit (`docs/106`)
kept finding the same structural problem: the most valuable raw data in
this sector is published "to use, not to resell" — RIPE NCC's delegated
stats and RPKI repository, CAIDA's AS names, ARIN's RPKI — and the
features customers pay most for (VPN/proxy/fraud detection) need private
telemetry, not public data. What remains clean is real but mostly
convenience: geolocation at DB-IP Lite's level outside operator geofeeds,
ASN context, verified bots, cloud ranges.

The most promising direction found, if this is resumed: **bot and service
identity** — "is this a person, or whose machine is it and what does it
do?" built from operators' own published lists (crawlers, webhooks,
monitoring, privacy relays, clouds) plus measured hosting detection. Not
started; each list needs its own licence check first.

## State of the engine

Works end to end and is tested (`pnpm test`: 183/183, 2026-11-14):

- **Pipeline:** `collect` (5 RIRs), `enrich` (233 sources), `flatten`
  (`ip_intel`), `mmdb publish` (validated, atomic promotion), `cycle`
  (all of it, cron-safe).
- **BGP origin from RouteViews** (own MRT reader) — RIPE RIS off.
- **Two `.mmdb` profiles:** `standard` (served) and `resale` (the copy
  that could be sold; `docs/106`, "Selling the `.mmdb` itself").
- **Every license-unclear or live source is switched off by config, not
  deleted** — the table in `docs/106`, "Product configuration", plus, as
  of today:

| Setting | Value | Turns off |
|---|---|---|
| `disabledEnrichmentSources` | `"lacnic-whois-city,rpki-vrp"` | LACNIC city (C3); RPKI (B5 — RIPE's repository terms forbid "services based on the data", ARIN's RPA doesn't cover it) |
| `lookupFeatures` | every feature except `rpki` | The RPKI block in API answers |

## Fixed while parking (2026-11-14)

- **`rpki_status` claimed "no ROA" for everything when no RPKI data was
  loaded.** Both `ip_intel` and the live lookup now return unknown (NULL)
  when `rpki_roas` is empty. Pinned by `rpki-empty.integration.test.ts`.
- **Disabling `rpki-vrp` now removes its rows** (`disabled-sources.ts`),
  like geofeed sources. Verified: 2 rows → 0 on the next `enrich`.
- **Tests could destroy a materialized `ip_intel`.** A test added on
  2026-11-12 called `ensureIpIntel("view")`, which replaces whatever
  `ip_intel` is — running `pnpm test` on the operator's database would
  have thrown away hours of build. It actually happened in the sandbox.
  Tests now query a TEMP VIEW of the same definition inside a rolled-back
  transaction (`test-support/scratch-ip-intel.ts`). Verified: a
  materialized `ip_intel` of 8,097,762 rows was still materialized with
  the same row count after a full test run.

## Known, not fixed

- **`mmdb publish`'s per-field check misses a field that vanishes
  completely.** It loops over the new build's fields, so a column that
  went to zero is never compared. Partial drops are caught; total loss is
  not. Needs a deliberate list of intentionally absent fields before it
  can be tightened (otherwise disabling RPKI would be rejected).
- **Disabling a source removes its data only for geofeed and RPKI
  sources.** Others warn instead (`docs/105` #3 is the wider version:
  a source removed from the registry orphans its rows).

## Decisions still open

| Item | Question |
|---|---|
| Product fields | Which lookup fields leave the product: `usage_type` (measured misleading), `risk` (built from thin inputs), `threat` "clean" (Feodo only), `is_vpn` (Mullvad only), live `reverse_dns`. Proposed in the 2026-11-13 discussion, not applied |
| A2 RIPE delegated stats | 🔴 for commercial use. Already dropped from the resale file; still feeds the engine's `ip_blocks`/`asn_blocks` (network/allocation lines, ASN country and registration date — and the rows CAIDA's names attach to) |
| B3 CAIDA AS names | 🟡 in API answers, 🔴 in a sold file |
| A4 LACNIC | Its terms page needs a browser (script-only) |
| B5 APNIC/LACNIC/AFRINIC RPKI | Terms unread (RPKI is off anyway) |
| B6 RouteViews | Optional written confirmation of logo use / CC BY vs BY-SA |
| I3 | Our own licence (old repo branch had Apache-2.0, `package.json` says MIT) |
| J1/J2 | KVKK/GDPR — lawyer |

## Market check that was planned

Forum posts (international and Turkish) with a sample table and
questions. Two rules agreed: use well-known service addresses (8.8.8.8,
1.1.1.1, a published Googlebot or cloud address) — never a private
person's IP with a location, which is personal data — and add an
attribution line for RouteViews and DB-IP. Ask what people use and pay
today and what they struggle with, rather than "would you pay X".

## Resuming

On the phone (`~/ip-engine-yeni`), after `git pull`:

```
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/cli run build
node apps/cli/dist/index.mjs config
node apps/cli/dist/index.mjs enrich
```

`config` should list `disabledEnrichmentSources: lacnic-whois-city,
rpki-vrp`. The `enrich` removes the RPKI rows and rebuilds `ip_intel`
with the corrected `rpki_status` rule. Where to read first: `docs/106`
(sources, licences, every switch), `docs/104` (source selection and the
two incidents on the RouteViews switch), this file.
