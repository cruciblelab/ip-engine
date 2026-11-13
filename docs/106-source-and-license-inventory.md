# Source & license inventory — Phase 0, and phase-by-phase progress

Started 2026-11-08. **Phase 1 (B1, B2, B4) done the same day — see the
Phase 1 log near the end.** Every data source and every other legally relevant
input this project uses, each with a stable ID so it can be referred to
in later phases ("B4", "C20.071") instead of re-described.

**Phase 0 is listing and a first risk rating, not re-verification.** Each
row's *Evidence* column says where the current license claim comes from —
frequently a past check recorded in `SOURCES.md`, sometimes nothing more
than the registry's own `license` field. Later phases re-verify against
primary sources, highest risk first.

**Not legal advice.** This is a careful reading of published terms. The
commercial-risk call on anything rated 🔴 or 🟠 — and everything in phase J
— belongs with a lawyer before paying customers exist.

## Where the list came from

Not from memory or from `SOURCES.md`: the registries were loaded from the
code itself (`KNOWN_SOURCES`, `KNOWN_ENRICHMENT_SOURCES`) and dumped.
**5 collection + 231 enrichment = 236 registered sources** at Phase 0;
Phase 1 added the two RouteViews sources (B6), so 233 enrichment / 238
total now. Phase G adds
the live, query-time sources that are not in the registry; phase I the
software dependencies (`pnpm licenses list --prod`: 117 packages).

## Risk scale

| Mark | Meaning |
|---|---|
| 🔴 | Known unresolved or unmet condition. Do not launch commercially on this as-is. |
| 🟠 | Conditional, inconsistent with another finding, or an obligation not yet met. |
| 🟡 | No written grant; relies on a "published for this purpose" argument. Reasonable, not airtight. |
| 🟢 | Explicit permissive license, or the operator explicitly states third-party use as the purpose. |
| ⚪ | No upstream — computed by us. |
| ⏸ | Registered but not used by default. Its own rating (in brackets) applies again only if someone re-enables it. |

## Summary

| Phase | Area | Items | 🔴 | 🟠 | 🟡 | 🟢 | ⚪ |
|---|---|---|---|---|---|---|---|
| A | RIR & IANA registry data | 7 (verified Phase 2) | 1 | – | 2 | 4 | – |
| B | BGP, ASN, routing | 6 (B1, B2, B4 ⏸ since Phase 1) | – | – | 3 | – | – |
| C | Geolocation | 20 items = 197 sources (C3 ⏸ since 2026-11-12) | – | – | 13 | 6 | – |
| D | Cloud / CDN ranges | 9 | – | – | 9 | – | – |
| E | Verified bots | 12 | – | – | – | 12 | – |
| F | Anonymity & threat | 3 | – | – | 1 | 2 | – |
| G | Live, query-time & internal tools | 4 (G1, G4 ⏸ since 2026-11-12) | – | – | – | 2 | – |
| H | Computed by us | 3 (+ lookup-time fields) | – | – | – | – | 3 |
| I | Software & our own license | 3 | – | 1 | – | 2 | – |
| J | Data protection (KVKK / GDPR) | 2 | – | 2 | – | – | – |

Counted by source, the 178 RIPE-scan geofeeds (C20) dominate: they are
the majority of everything registered, and all rest on one 🟡 argument.

## Found while listing — before any re-verification

These surfaced just from putting everything in one table. Each is a lead
for its phase, not a conclusion.

1. **A2–A5: one file's header was generalised to five.** `SOURCES.md`
   rates all five RIR delegated files "Yes", but the only evidence quoted
   is APNIC's own `CONDITIONS OF USE` header. The other four were never
   individually checked. A2 matters most: RIPE NCC's file sits on the
   same `ftp.ripe.net` as `asn.txt` (B4), which this project ruled
   *unresolved* precisely because of RIPE's Copyright Statement. Either
   the delegated file is genuinely different (e.g. governed by NRO
   statistics-exchange terms) or the two rulings are inconsistent. Not
   known yet which.
2. **B1/B2: the RIS attribution condition cannot currently be met.** RIS
   commercial use requires the RIPE NCC logo; logo permission was
   requested 2026-08-25 and never answered. Launching on RIS means
   non-compliance from day one, and RIS permission is revocable on
   exactly that ground. The planned exit (`docs/104`, step 3:
   RouteViews) is now the live path.
3. **B4 `asn.txt` is still running.** As the ASN-name fallback, with
   commercial use unresolved. Since `docs/104` step 1, setting
   `asnNameFallbackEnabled: false` actually removes its data instead of
   freezing it — so this one now has a one-line remedy. *Applied
   2026-11-08 — see the Phase 1 log.*
4. **I3: there is no LICENSE file.** `package.json` says `"license":
   "MIT"`, but the repository root has no license text. Without one,
   default copyright applies and nobody has been granted anything —
   which also undercuts the "self-host the same engine" positioning
   discussed for `ipreadout-service`. Whether the engine *should* be MIT
   at all is a business decision, not a formality.
5. **C2 DB-IP Lite: where must attribution appear?** DB-IP asks for
   attribution and a link "wherever results are shown". A web page is
   clear; an API response read by a customer's code, shown to *their*
   users, is not. Needs a deliberate answer. *License re-verified
   2026-11-11 (C2 verification record): commercial use confirmed in DB-IP's
   own words; what remains is implementing the attribution.*
6. **C6 Netflix: is its data only used for geolocation?** The grant is
   "only for improving the accuracy of Geo:IP lookups". Geofeed rows may
   feed signals beyond geo (e.g. a `country-conflict` flag). Needs a
   code trace.
7. **G1 RDAP abuse contacts are often personal data.** Role objects can
   carry individual names, emails and phone numbers. Caching and serving
   them is processing personal data — phase J territory. Out of scope for
   the `ipreadout-service` launch already (`.mmdb`-only), but live in the
   self-hosted engine.
8. **H: computed data still carries upstream obligations.** `asn_reach`,
   `asn_profile`, `neighborhood` have no license of their own, but they
   are derived from B1/B2 and others. "Computed by us" does not mean
   "free of attribution".

## Phase A — RIR & IANA registry data

| ID | Source | Recorded license | Evidence | Risk |
|---|---|---|---|---|
| A1 | ARIN delegated-extended | No terms stated anywhere found | FTP README + statistics pages read 2026-11-13 | 🟡 no restriction found, no explicit grant |
| A2 | RIPE NCC delegated-extended | RIPE NCC Copyright Statement | Read 2026-11-13: README points to a "conditions" file that contains none; the general statement then applies | 🔴 commercial use needs written authorisation |
| A3 | APNIC delegated-extended | Liability disclaimer only | File header, quoted, 2026-08-19 | 🟢 |
| A4 | LACNIC delegated-extended | No terms stated anywhere found | FTP README read 2026-11-13; website terms page is script-only, not readable here | 🟡 |
| A5 | AFRINIC delegated-extended | "freely available for download and use", liability disclaimer only | FTP README, quoted 2026-11-13 | 🟢 |
| A6 | IANA special-purpose IPv4 (`iana-ipv4-special`) | IANA/IETF joint statement: "may be freely used by any party for any purpose", CC0 | iana.org/help/licensing-terms read 2026-11-13 | 🟢 |
| A7 | IANA special-purpose IPv6 (`iana-ipv6-special`) | IANA/IETF joint statement: "may be freely used by any party for any purpose", CC0 | iana.org/help/licensing-terms read 2026-11-13 | 🟢 |

## Phase B — BGP, ASN, routing

| ID | Source (registry id) | Recorded license | Evidence | Risk |
|---|---|---|---|---|
| B1 | RIPE RIS whois IPv4 (`ris-whois-ipv4`) | RIS commercial-use terms: logo + link + paragraph | RIPE commercial-use page, 2026-08-24/25 | ⏸ replaced by B6 as default, 2026-11-08 [🔴 logo never granted] |
| B2 | RIPE RIS whois IPv6 (`ris-whois-ipv6`) | same | same | ⏸ same [🔴] |
| B3 | CAIDA AS-organizations (`caida-asn-names`) | CAIDA AUA, attribution | AUA PDF read directly, 2026-08-24; public AUA page re-read 2026-11-08 and 2026-11-13 | 🟡 for API answers; 🔴 inside a sold `.mmdb` (licence is "non-transferable", copy/modify/use only) — see "Selling the `.mmdb` itself" |
| B4 | RIPE `asn.txt` (`ripe-asn-names`) | Unresolved | RIPE Copyright Statement, quoted, 2026-08-24 | ⏸ off by default since 2026-11-08 [🔴] — see Phase 1 log |
| B5 | RPKI VRPs (`rpki-vrp`) | No terms found | rpki-client site + RFC 6480 purpose | 🟡 |

| B6 | RouteViews RIBs (`routeviews-rib-ipv4`, `routeviews-rib-ipv6`) — **default BGP source since 2026-11-08** | CC BY 4.0 + RouteViews Commercial Terms of Use: statement + link, logo, boilerplate | `routeviews.org/routeviews/licenses/` read first-hand 2026-11-08, quoted in `docs/103` | 🟡 two wording conflicts on RouteViews' own site (below) |

**B6's two conflicts.** (1) The logos page's only sentence says
"permission is given for non-commercial use", while the Commercial Terms
*require* the logo on commercial products and link to that very page. Read
together, the commercial terms grant what they require — but that is a
reading, so a written confirmation from RouteViews before launch is the
clean fix. Unlike RIPE, nothing asks for permission first, so silence does
not block. (2) The homepage's "CC BY 4.0" text links to the CC **BY-SA**
4.0 deed; the footer badge and the licenses page say BY. Almost certainly a
link mistake, but ShareAlike would oblige us to license derived databases
the same way, so it is worth including in the same message.

**B3, downgraded from 🟢 to 🟡.** Reading CAIDA's public AUA for the
RouteViews decision (2026-11-08) gave its exact grant: "a limited,
non-exclusive, non-transferable, non-assignable, and terminable license to
copy, modify, and use the data", followed by "No license is granted for any
other purpose". It says nothing about commercial use — neither allows nor
forbids it. `SOURCES.md`'s 2026-08-24 entry ("no commercial-use
restriction") is literally true but reads as more than the text gives. The
AUA also requires reporting publications to CAIDA. Whether "use" covers
serving CAIDA-derived names inside a paid API is a question for CAIDA
directly (or a lawyer) — a later phase, not answered here. Note this is the
same AUA that would have applied to CAIDA's `pfx2as`, which is exactly why
B6 reads RouteViews' raw files instead.

## Phase C — Geolocation

| ID | Source (registry id) | Recorded license | Evidence | Risk |
|---|---|---|---|---|
| C1 | GeoNames (`geonames-cities`) | CC BY 4.0 | geonames.org | 🟢 attribution shown on Sources page |
| C2 | DB-IP Lite (`dbip-lite`) | CC BY 4.0 + link back | **Re-verified 2026-11-11 with verbatim quotes and evidence** (see "C2 verification record") | 🟢 license; attribution still to be implemented in `ipreadout-service` |
| C3 | LACNIC bulk whois city (`lacnic-whois-city`) | LAC-2018-3 policy publication | Policy text, 2026-08-19 — "free to download", no explicit commercial grant | ⏸ disabled 2026-11-12 (`disabledEnrichmentSources`) [🟠] |
| C4 | Verizon (`verizon-geofeed`) | CDLA-Permissive-2.0 | License file | 🟢 |
| C5 | T-Mobile US (`tmobile-geofeed`) | Apache-2.0 | License file | 🟢 |
| C6 | Netflix (`netflix-geofeed`) | Restricted: geo accuracy only | Feed's own statement; usage traced in code 2026-11-11 | 🟢 used for geolocation only — `country-conflict` comes from block/ASN countries, not geofeeds |
| C7 | Schwarz IT (`schwarzit-geofeed`) | DL-DE→Zero-2.0 | License text | 🟢 |
| C8 | Civo (`civo-geofeed`) | No licence file | Repo states purpose | 🟡 |
| C9 | DigitalOcean (`digitalocean-geofeed`) | Published for public consumption | Operator page | 🟡 |
| C10 | Linode / Akamai (`linode-geofeed`) | Published for public consumption | Operator page | 🟡 |
| C11 | Google Cloud (`google-geofeed`) | No stated terms | RFC 8805 purpose | 🟡 |
| C12 | NTT (`ntt-geofeed`) | No stated terms | RFC 8805 purpose | 🟡 |
| C13 | Cogent (`cogent-geofeed`) | No stated terms | RFC 8805 purpose | 🟡 |
| C14 | Vultr (`vultr-geofeed`) | No stated terms | RFC 8805 purpose | 🟡 |
| C15 | Telia (`telia-geofeed`) | No stated terms | RFC 8805 purpose | 🟡 |
| C16 | GTT (`gtt-geofeed`) | No stated terms; AUP is customer-scoped | AUP read, 2026-08-05 | 🟡 |
| C17 | Charter / Spectrum (`charter-geofeed`) | No stated terms; linked PDF is a peering policy | PDF read in full, 2026-08-05 | 🟡 |
| C18 | Fastly (`fastly-geofeed`) | No stated terms; the restriction found governs a different product | Checked 2026-08-05 | 🟡 |
| C19 | Zayo, EU only (`zayo-eu-geofeed`) | No stated terms | AUP customer-scoped | 🟡 |
| C20 | 178 RIPE-scan geofeeds (`geofeed-*`) | No stated terms | `docs/102`; individually fetched, terms not individually read | 🟡 ×178 — see appendix |

Also in play at query time, not registered: RDAP-discovered geofeeds —
see G1.

## Phase D — Cloud / CDN ranges

All recorded as "published for public consumption"; none had their
provider's own terms read individually in the record.

| ID | Source (registry id) | Risk |
|---|---|---|
| D1 | AWS (`aws-ip-ranges`) | 🟡 |
| D2 | Google Cloud (`gcp-ip-ranges`) | 🟡 |
| D3 | Azure Service Tags (`azure-ip-ranges`) — Microsoft download-centre terms may apply | 🟡 |
| D4 | Cloudflare IPv4 (`cloudflare-v4`) | 🟡 |
| D5 | Cloudflare IPv6 (`cloudflare-v6`) | 🟡 |
| D6 | Oracle Cloud (`oracle-ip-ranges`) | 🟡 |
| D7 | Fastly (`fastly-ip-ranges`) | 🟡 |
| D8 | Bunny.net IPv4 (`bunny-cdn-v4`) — ToS silent, support docs state third-party purpose | 🟡 |
| D9 | Bunny.net IPv6 (`bunny-cdn-v6`) | 🟡 |

## Phase E — Verified bots

Each operator publishes the list so third parties can verify its crawler;
third-party consumption is the stated purpose.

| ID | Registry id | Operator | Risk |
|---|---|---|---|
| E1 | `googlebot` | Google | 🟢 |
| E2 | `google-special-crawlers` | Google | 🟢 |
| E3 | `google-user-triggered` | Google | 🟢 |
| E4 | `bingbot` | Microsoft | 🟢 |
| E5 | `applebot` | Apple | 🟢 |
| E6 | `gptbot` | OpenAI | 🟢 |
| E7 | `oai-searchbot` | OpenAI | 🟢 |
| E8 | `chatgpt-user` | OpenAI | 🟢 |
| E9 | `perplexitybot` | Perplexity | 🟢 |
| E10 | `ahrefsbot` | Ahrefs | 🟢 |
| E11 | `anthropic-crawlers` | Anthropic | 🟢 |
| E12 | `ccbot` | Common Crawl | 🟢 |

## Phase F — Anonymity & threat

| ID | Source (registry id) | Recorded license | Risk |
|---|---|---|---|
| F1 | Tor exit list (`tor-exit-nodes`) | CC0 / public domain | 🟢 |
| F2 | Mullvad relays (`mullvad-relays`) | Public API, no terms recorded | 🟡 terms unread; polling volume note |
| F3 | abuse.ch Feodo Tracker (`feodotracker`) | CC0, dataset-specific grant | 🟢 |

## Phase G — Live, query-time sources (not in the registry)

| ID | Source | Notes | Risk |
|---|---|---|---|
| G1 | RDAP at all five RIRs — abuse contacts, geofeed discovery, network names | Same RIPE Database T&C as bulk whois (Art. 4.5); per-query + cache is "defensible, not airtight" (`SOURCES.md`). Abuse contacts may be personal data. Out of scope for the `ipreadout-service` launch. | ⏸ `rdapEnabled: false` since 2026-11-12 [🟠] |
| G2 | Reverse DNS (PTR) | Public DNS | 🟢 |
| G3 | `security.txt` (RFC 9116) | Self-published for exactly this purpose | 🟢 |
| G4 | RIPE RIS Live WebSocket (`bgp-live run`, `docs/97`) — **added in Phase 1, missed in Phase 0** | RIPE RIS data, same terms as B1/B2. Internal monitoring only: `lookup` and the `.mmdb` never read `bgp_live_events`. Seeds from `bgp_origin_ranges`, so it now compares RIS Live against a RouteViews baseline — works, but `peer_count` scales differ. If it ever feeds anything customers see, B1's logo condition comes with it. | ⏸ `bgpLiveEnabled: false` since 2026-11-12 [🟡] |

**Live and long-running collection stays out of the customer product
(operator decision, 2026-11-12).** The customer gets the `.mmdb`, built
from `ip_intel`. Checked what reaches it:

- **Long-running collection** (history: `prefix_history`, `origin-changes`,
  the `.mmdb`'s `stable_since`): `stable_since` is the only field that can
  reach the file, and `mmdbHistoryFields` is off by default. Nothing else.
- **Live collection** (G1 RDAP, G2 reverse DNS, G3 `security.txt`, G4 RIS
  Live): none of their fields are in the `.mmdb` — **except one path, found
  and closed on 2026-11-12.** When the engine's own lookup finds no geofeed
  for an address, `lookup/rdap.ts` discovers one over RDAP and caches it in
  `geofeed_ranges`. `ip_intel` read that table without looking at
  `source_id`, so live-discovered rows reached the customer file. Worse,
  DB-IP's prune treated them as coverage and deleted the DB-IP answer
  underneath. Fixed both: `ip_intel` and the prune now ignore rows tagged
  `GEOFEED_LIVE_DISCOVERY_SOURCE_ID` (`schema/geofeedRanges.ts`); the
  engine's own live lookups still use them. Pinned by
  `dbip-prune.integration.test.ts`, which failed 3/3 against the old code
  (the customer view answered with the live row's city) and passes on the
  new.

  On an existing database: DB-IP rows already pruned under live rows stay
  missing until DB-IP is ingested again — run
  `ip-insight enrich --sources dbip-lite` once after updating.

## Phase H — Computed by us

| ID | Item | Derived from | Risk |
|---|---|---|---|
| H1 | `asn-reach` | the selected BGP source (B6 by default) | ⚪ inherits its attribution |
| H2 | `neighborhood-stats` | F1, F2, F3, E* | ⚪ |
| H3 | `asn-profile` | B6 (or B1/B2), B5, A*, D*, F*, E* | ⚪ inherits upstream attribution |

Also lookup-time, not stored: risk score, usage/connection type,
allocation freshness, route anomaly, country-estimate fallback (built on
C1 + A*).

## Phase I — Software and our own license

| ID | Item | Finding | Risk |
|---|---|---|---|
| I1 | 117 production npm packages | 102 MIT, 8 ISC, 4 BSD-3, 1 BSD-2, 2 Apache-2.0 — no copyleft | 🟢 |
| I2 | Apache-2.0 deps (`drizzle-orm`, `drizzle-zod`) | NOTICE obligations apply when redistributing; not when only running a service | 🟢 |
| I3 | Our own license | `package.json` says MIT; **no LICENSE file exists** | 🟠 |

## Phase J — Data protection

| ID | Item | Notes | Risk |
|---|---|---|---|
| J1 | IP addresses as personal data | Treated as personal data under GDPR (and, in Turkey, KVKK) in many contexts. An IP-intelligence API processes data *about* addresses by definition. | 🟠 lawyer |
| J2 | Customer query logs | Already decided: queried IPs are not stored (`ipreadout-service/docs/04`). Retention cap still unset. | 🟠 lawyer |

## Proposed verification order

By risk, not by letter:

1. ~~**B1, B2, B4** — the three 🔴.~~ **Done 2026-11-08** (Phase 1 log).
   Follow-up left from it: B6's confirmation message to RouteViews, and
   B3's question to CAIDA (can go in Phase 2's batch of questions).
2. ~~**A1–A7**~~ **Done 2026-11-13** (Phase 2 log): A3, A5, A6, A7 🟢;
   A1, A4 🟡; A2 🔴 — consistent with B4. A2 decision pending.
3. **I3** — decide the license, then add the file.
4. **C2, C3, C6** — the three 🟠 in geolocation.
5. **D1–D9, F2, B5, B3** — read each provider's actual terms (B3 added in
   Phase 1).
6. **C8–C20** — the "no stated terms" geofeeds. 187 sources, one argument.
7. **J1, J2, G1** — needs a lawyer; prepare the questions, don't answer them.

## Phase 1 log — B1, B2, B4 (done 2026-11-08)

### B4 — done

`asnNameFallbackEnabled` now defaults to `false` (`config.ts` DEFAULTS
and `ip-insight.config.json`). With `asnNamePrimary: "caida"`, that means
`ripe-asn-names` is skipped entirely — no download, no write — and the
names it wrote on earlier runs are removed by
`purgeDeselectedAsnNameSources` once the next enrichment run completes.

What this costs, stated plainly: ASNs that CAIDA's dataset has no entry
for get no holder name. Measured 2026-08-24, CAIDA covers 84% of the ASNs
`asn.txt` covers; the gap is concentrated in Brazil, China and Latin
America (`docs/20`). Those lookups will return the ASN number with an
empty name.

What it does not do: resolve the licensing question. `asn.txt`'s terms
are exactly as unresolved as before; the product just no longer depends
on them. The source stays registered so it can come back with a
one-line config change if RIPE ever confirms the terms in writing.

### B1/B2 — done: RouteViews is the default BGP source

**Why.** RIS commercial use requires the RIPE NCC logo; RIPE never answered
the 2026-08-25 permission request. Launching on RIS meant not meeting a
condition from day one. RouteViews' terms name selling derivative works and
need no permission step.

**What changed.** `bgpOriginSource` now defaults to `"routeviews"`. Two new
sources (`routeviews-rib-ipv4` from route-views2, `routeviews-rib-ipv6` from
route-views6) read the newest raw MRT RIB with our own reader. The RIS
sources stay registered and are skipped — without downloading — unless
`"ripe-ris"` is selected. Engineering detail, including a serious bug found
during the first real switch and its four fixes: `docs/104`, "Step 3".

**Why raw RIBs and not CAIDA's ready-made `pfx2as`.** Same RouteViews data,
but re-published under CAIDA's AUA (see the B3 note): an extra license
layer that is silent on commercial use. Raw files = one license.

**Measured, not assumed** — same day's data (RIS dump ~14:57 UTC,
RouteViews RIBs 12:00 UTC), same prefix filter and same "longest prefix,
then most peers" rule as `lookup.ts`:

| | IPv4 | IPv6 |
|---|---|---|
| Prefixes: RIS / RouteViews / both | 1,252,409 / 1,164,498 / 1,140,790 | 309,532 / 267,946 / 267,699 |
| Same best origin on shared prefixes | 99.90% | 99.97% |
| RIS prefixes seen by ≥10 RIS peers that RouteViews lacks | 1.66% | 0.95% |
| RIS prefixes seen by ≥50 RIS peers that RouteViews lacks | 0.31% | 0.10% |
| Random routed addresses, prefix-weighted: same / differ / RIS-only / RV-only | 96.60 / 2.49 / 0.29 / 0.61 % | 97.81 / 0.84 / 1.31 / 0.04 % |
| Random routed IPv4 addresses, address-weighted: same / differ / RIS-only / RV-only | 98.71 / 0.56 / 0.41 / 0.33 % | — |
| Max peers per prefix | RIS 441, RouteViews 20 | RIS 417, RouteViews 20 |

What RouteViews misses is mostly what few RIS peers see; most "differ"
cases are one table having a more specific prefix the other lacks. Only
one collector per family is used (CAIDA's long-standing choice); adding
more RouteViews collectors could narrow the gap — not measured yet.

**Customer-visible effects.** `asn.source` in the API now says
`"bgp-routeviews"` (it was hardcoded `"bgp-ris"`, which would have been
false after the switch). `asn.peer_visibility` drops to RouteViews' scale
(max ~20 instead of ~440); its API description now says so.

**Attribution now owed (the Sources page).** RouteViews' statement with a
link, the RouteViews logo, and its boilerplate paragraph — verbatim in
`docs/103`. The RIS paragraph and the RIPE logo placeholder only apply if
`"ripe-ris"` is selected again.

**Still open for B6:** the two wording conflicts above. Suggested: one short
message to RouteViews through their site's Contact page asking (a) that the
logo may be used on a commercial product's Sources page, as their
commercial terms require, and (b) whether the license is CC BY or CC BY-SA.

### Found during Phase 1, added to the inventory

- **G4 — RIS Live**, missed in Phase 0. Internal only; rated 🟡.
- **B3 downgraded** to 🟡 after reading CAIDA's AUA wording first-hand.

## C2 verification record — DB-IP Lite (2026-11-11)

**Why this was re-checked.** A free "Lite" edition of a paid product that
allows commercial use — including building a competing IP-geolocation
service — sounded too good to be true. The 2026-08-21 check (`SOURCES.md`)
had reached the same conclusion, but recorded no verbatim text and kept no
copies. This record fixes that.

**Method.** The pages were downloaded directly from db-ip.com on
2026-11-11 around 19:29 UTC and read in full, not summarised. Quotes below
are copied exactly. Independent third-party copies exist on the Internet
Archive (links at the end).

### 1. The suspicious-looking clause exists, and applies to the paid product only

`db-ip.com/tos.php`, section "Licensing terms" — for the **paid** license:

> "This license explicitly prohibits usage of the database to offer free or
> commercial IP geolocation API services or any other related service that
> would duplicate or compete with the services offered by DB-IP."

The very next sentence:

> "The terms above do not apply to the free database downloads which are
> licensed under the terms of the Creative Commons Attribution 4.0
> International License, and to the provided open source code which is
> licensed under the terms of the GNU Lesser General Public License."

So the non-compete is real, and it is the *paid* customers who are bound by
it. The free download is explicitly outside it.

### 2. DB-IP says commercial use of the free download is allowed, in its own words

`db-ip.com/faq.php`, question "Can I use the DB-IP database or API in a
commercial product ?":

> "Our free database downloads are licensed under a Creative Commons
> license, you are allowed to use the database in a commercial product and
> redistribute it as long as you comply with the rest of the licensing
> terms."

### 3. The license and the attribution requirement

`db-ip.com/db/download/ip-to-city-lite` and `db-ip.com/db/lite.php`, both
with the same wording:

> "IP to City Lite database by DB-IP is licensed under a Creative Commons
> Attribution 4.0 International License."
>
> "You are free to use this IP to City Lite database in your application,
> provided you give attribution to DB-IP.com for the data."
>
> "In the case of a web application, you must include a link back to
> DB-IP.com on pages that display or use results from the database."

The snippet they offer: `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>`.
The link points to `creativecommons.org/licenses/by/4.0/` — plain BY, not
ShareAlike, on every page checked.

### 4. Why the free edition exists — and why it isn't suspicious after all

The same pages say what the Lite edition gives up. The download page:
"a subset of the IP to Location commercial database with reduced accuracy
and number of records". The FAQ: the Lite databases "have reduced accuracy
and do not undergo the same QA process". Upgrading is advertised with
"No attribution required", "Better accuracy", "More records", "Daily
releases", "Technical support". The free edition is DB-IP's advertising:
every user has to show "IP Geolocation by DB-IP" with a link. That is the
price, and it is why commercial use is allowed.

### 5. What if DB-IP changes its terms later

The Creative Commons legal code itself (`creativecommons.org/licenses/by/4.0/legalcode.en`):

> "the Licensor hereby grants You a worldwide, royalty-free,
> non-sublicensable, non-exclusive, irrevocable license"
>
> "the Licensor may also offer the Licensed Material under separate terms or
> conditions or stop distributing the Licensed Material at any time;
> however, doing so will not terminate this Public License."

So a file downloaded under CC BY 4.0 stays licensed under CC BY 4.0 even if
DB-IP changes terms later; new terms could only apply to *later* files. The
one way to lose the license is our own non-compliance (Section 6):

> "if You fail to comply with this Public License, then Your rights under
> this Public License terminate automatically."

— reinstated automatically if the violation is cured within 30 days of
discovering it. **In practice: attribution is the whole obligation, and
missing it is the only real risk.**

### 6. Things that come with it

- **GeoNames.** DB-IP's ToS, "Acknowledgement": "Part of the data provided
  in the DB-IP products and services is sourced from the GeoNames database
  which is distributed under the Creative Commons Attribution license."
  GeoNames is already credited by us (C1), so this adds nothing new — but
  the GeoNames credit must stay on any page that carries DB-IP data.
- **No license text inside the file.** The downloaded CSV is bare data
  (first line `0.0.0.0,0.255.255.255,ZZ,ZZ,,,0,0`); the terms live only on
  the website, which is why keeping dated copies matters.
- **The November 2026 release**, as published on the download page:
  7,777,816 records; CSV SHA1 `254ef60b261cb4fb613362058b388a480d2a6b92`.

### 7. Evidence kept

Copies of the six pages as downloaded, with SHA-256 fingerprints. Kept
**outside this repository** on purpose: they are DB-IP's and Creative
Commons' copyrighted pages, and this repository is public.

| Page | SHA-256 of the downloaded copy |
|---|---|
| `db-ip.com/tos.php` | `658bac4a705f55c639be4f1ece3c24a1bee2f23ba054bdd52a5e03d253302401` |
| `db-ip.com/faq.php` | `e7000d54fd3cecaa29f861f789ed7fb6dcb0e41f98dd48c204d8ef76409bc0ff` |
| `db-ip.com/db/download/ip-to-city-lite` | `af2415b434d5567245ad1c9448b27dedf058bace29bddda1adc44066c4510038` |
| `db-ip.com/db/lite.php` | `f137b0b9693e1f5c3f5dd119451a16549e5c4c6beca77c4e1a8ea0f53865bd66` |
| `db-ip.com/db/ip-to-city-lite` | `e309a81fd79ca366639597ac02f1147e4596e5d94a995421f08bcafa1d854894` |
| `creativecommons.org/licenses/by/4.0/legalcode.en` | `58230517b7895aa219ff46a6ed63e67057a1582fb9ea054b16728a8c13525650` |

A fingerprint only proves a copy hasn't changed since we made it, not what
the site said. The independent proof is the Internet Archive, which holds
its own copies (existence and dates confirmed via its availability API on
2026-11-11; the archive refuses connections from this build environment, so
their *contents* were not read here — open them in a browser):

- ToS: <https://web.archive.org/web/20261103001311/https://db-ip.com/tos.php>
- ToS, older: <https://web.archive.org/web/20241218114935/https://db-ip.com/tos.php>, <https://web.archive.org/web/20210117070408/https://db-ip.com/tos.php>
- Download page: <https://web.archive.org/web/20261103064713/https://db-ip.com/db/download/ip-to-city-lite>
- Lite page: <https://web.archive.org/web/20261103001310/https://db-ip.com/db/lite.php>
- FAQ: <https://web.archive.org/web/20261027143451/https://db-ip.com/faq.php>

### 8. What is left for C2

Only the attribution itself, in `ipreadout-service`:
- Every web page that shows a result (demo/lookup page, Sources page):
  "IP Geolocation by DB-IP" linking to `https://db-ip.com`, plus the
  GeoNames credit.
- The API: DB-IP's terms name web pages explicitly and ask for
  "attribution to DB-IP.com for the data" otherwise. The safe reading:
  credit in the API documentation and on the Sources page, and an
  attribution field in API responses whose geolocation came from DB-IP.
  Over-attributing costs nothing; under-attributing is the one thing that
  ends the license.

## Product configuration — what is off, and how to turn it back on (2026-11-12)

Operator decision: anything with unclear terms is **disabled, not
deleted**, and live or long-running collection stays out of the
commercial product. Every switch is in `ip-insight.config.json`; none
needs a code change to reverse.

| Setting | Value | Turns off | Why |
|---|---|---|---|
| `bgpOriginSource` | `"routeviews"` | B1/B2 RIPE RIS | RIPE logo permission never granted |
| `asnNameFallbackEnabled` | `false` | B4 RIPE `asn.txt` | Commercial terms unresolved |
| `disabledEnrichmentSources` | `"lacnic-whois-city"` | C3 LACNIC city | No explicit commercial grant |
| `rdapEnabled` | `false` | G1 live RDAP (abuse contacts, network names, geofeed discovery) | RIPE DB terms "defensible, not airtight"; abuse contacts can be personal data; live collection |
| `bgpLiveEnabled` | `false` | G4 RIS Live (`bgp-live run`) | RIPE RIS data; live collection |
| `historyCaptureEnabled` | `false` | History captures after each `enrich` | Long-running collection; never in the `.mmdb` (`mmdbHistoryFields` stays `false`) |

**`disabledEnrichmentSources`** (new): comma-separated registry ids. A
listed source is skipped without downloading — even when named in
`--sources` — and at the start of each `enrich` its rows are removed from
`geofeed_ranges`, so it also leaves `ip_intel` and the `.mmdb`. Removal is
complete only for geofeed sources that write nowhere else
(`disabled-sources.ts`); for any other kind the run warns that earlier
rows may remain. If geofeed rows were removed and DB-IP isn't in the same
run, it warns too: DB-IP's rows under them were pruned earlier and come
back only with `enrich --sources dbip-lite`.

Verified on real data (sandbox, 2026-11-12): with LACNIC disabled, an
`enrich` skipped it, removed its 521,779 rows and printed the DB-IP
warning; `2.152.8.5` went from "Bogotá D.C, CO [geofeed]" to no location,
then — after `enrich --sources dbip-lite` — to "Bogotá, Bogota D.C., CO
(4.71099, -74.0721) [dbip-lite]". `bgp-live run` refuses with the reason.
`rdapEnabled: false` is pinned by a test asserting no network request is
made and no budget spent; since 2026-11-13 it also makes every `enrich`
remove what earlier RDAP queries cached (abuse contacts, network names,
discovered geofeeds; `security.txt` contacts stay) —
`rdap-cache-purge.integration.test.ts`. `pnpm test`: 175/175.

**Still on, deliberately:** B6 RouteViews and B3 CAIDA (turning them off
removes ASN, ASN names, size rank and RPKI status from the product — terms
read as permitting our use, see their rows), A1–A7 RIR/IANA files (the
product's base; their individual verification is Phase 2), and every 🟡
"published for this purpose" source. Cached RDAP abuse contacts are removed
by the next `enrich` (see above).

## Phase 2 log — A1–A7, RIR and IANA files (2026-11-13)

Each RIR's own delegated-extended file, its FTP README, and its website
were read directly. Copies with SHA-256 fingerprints are kept outside this
public repository (`phase2-rir-2026-11-13`, delivered privately).

| ID | What the RIR itself says | Verdict |
|---|---|---|
| A3 APNIC | In the file header and README: "The files are freely available for download and use on the condition that APNIC will not be held responsible for any loss or damage arising from the use of the information contained in these reports." | 🟢 |
| A5 AFRINIC | Same sentence in its README, naming AFRINIC. | 🟢 |
| A1 ARIN | Nothing in the file or README. The README describes the format as "a published RIR standard, on which other parties are expected to rely"; the statistics page says the files "are available for use". The joint RIR statement describes the purpose as "to facilitate research on and analysis of the global use of Internet number resources". No restriction found — and no explicit commercial grant either. | 🟡 |
| A4 LACNIC | Nothing in the file or README. Its website terms page renders only with JavaScript and could not be read from here. | 🟡 — read the page in a browser |
| A2 RIPE NCC | The stats README says "the conditions for its use are set out in" `_README-ripe-stats.txt`; that file holds only a format description. With no stated permission, the RIPE NCC Copyright Statement applies: "RIPE NCC Materials" are anything on a `ripe.net` domain (`ftp.ripe.net` included), and "may not be used, reproduced and made available to third parties without prior written authorisation from the RIPE NCC", except "for private purposes, for public non-commercial purpose, for research, for educational or demonstration purposes, or if the materials in question specifically state that use of the material is permissible". A commercial product is none of those. | 🔴 |
| A6/A7 IANA | "IANA and IETF intend that the Protocol Registries may be freely used by any party for any purpose", with copyright dedicated to the public domain (CC0). | 🟢 |

**The Phase 0 question "is A2 consistent with B4?" — yes, both are
restricted.** `asn.txt` and the delegated stats sit on the same server
under the same statement; neither says anything that permits commercial
use. The NRO's combined file (`nro-delegated-stats`) is no way around it:
it is hosted on `ftp.ripe.net` too.

(RIPE's separate "RIPE Data Repository Terms and Conditions" — no
commercial use, no redistribution — govern an account-gated research
archive, not these public FTP files. Not applied here, but it shows the
direction RIPE takes with data it publishes.)

**What A2 feeds.** `ip_blocks` rows for the RIPE region (Europe, Middle
East, Central Asia — Turkey included): the engine's "Network / Allocated /
RIR" lines, and, in the `.mmdb`, `country` only as the last fallback
(after geofeed and DB-IP, `geo_source: country-estimate`). With
`dbipLiteIpv6: false`, that fallback is the main country source for RIPE
IPv6. **Not decided yet** — options in the summary for the operator.

## Selling the `.mmdb` itself (2026-11-13)

Selling answers through an API and selling the file are different acts:
the file *is* a copy of the data, handed over. Field by field, what can go
in a file that is sold:

| `.mmdb` field | Comes from | In a sold file |
|---|---|---|
| `country`, `city`, `region`, `location` | Geofeeds (C4–C20), DB-IP Lite (C2), RIR country as last fallback (A1–A5) | Geofeeds 🟡 (RFC 8805 publishes them for geolocation providers); DB-IP 🟢 — its FAQ: "allowed to use the database in a commercial product and redistribute it"; RIR fallback 🟢/🟡 except RIPE 🔴 |
| `postal` | Geofeeds | 🟡 |
| `asn` | RouteViews (B6) | 🟢 CC BY 4.0, attribution must travel with the file |
| `asn_name` | CAIDA (B3) | 🔴 — the AUA grants "a limited, non-exclusive, **non-transferable**, non-assignable, and terminable license to copy, modify, and use the data … No license is granted for any other purpose". Handing a copy to a buyer is not covered |
| `asn_size_rank` | Computed from RouteViews | 🟢 (inherits RouteViews attribution) |
| `rpki_status` | RPKI VRPs (B5) + RouteViews | ⚪ **unknown — B5 terms not yet read.** Must be checked before any sale |
| `cloud_provider`, `is_cloud` | Provider lists (D1–D9) | 🟡 |
| `verified_bot`, `verified_bot_operator` | Operators' own lists (E1–E12) | 🟢 |
| `special_purpose` | IANA (A6/A7) | 🟢 CC0 |
| `is_tor`, `is_threat` | Tor list, Feodo (F1, F3) | 🟢 CC0 |
| `is_vpn` | Mullvad (F2) | 🟡 terms unread |
| `is_anycast`, `geo_source` | Ours | 🟢 |

**A CC BY constraint that matters for a paid file.** CC BY 4.0, Section
2(a)(5)(B): "You may not offer or impose any additional or different
terms or conditions on, or apply any Effective Technological Measures to,
the Licensed Material if doing so restricts exercise of the Licensed
Rights by any recipient of the Licensed Material." And for a database
built on one: "the Adapter's License You apply must not prevent
recipients of the Adapted Material from complying with this Public
License." In plain terms: a buyer may lawfully take the DB-IP-, RouteViews-
and GeoNames-derived parts of a sold file and share them on; our licence
cannot forbid that. The file can carry our own terms for what is ours,
not for those parts. A lawyer should word the customer licence.

**What this means for selling a file.** A file without `asn_name` and
without the RIPE country fallback is sellable once B5 (RPKI) is read —
with attribution inside the file and its documentation. Its value is
mostly convenience: geography is at DB-IP Lite's level outside geofeed
coverage, and DB-IP Lite is a free download. What the file adds is one
daily build combining operator geofeeds, ASN, RPKI status, verified bots,
cloud, Tor and threat flags, with the source of every location stated.
No market data was gathered on what that sells for; any price would be a
guess.

## Appendix — C20: the 178 RIPE-scan geofeeds, individually

All share one legal footing: self-published RFC 8805 file, no stated terms (`docs/102`).

| ID | Registry id | Host |
|---|---|---|
| C20.001 | `geofeed-a1-by` | www.a1.by |
| C20.002 | `geofeed-acedatacenter-com` | acedatacenter.com |
| C20.003 | `geofeed-addressn-com` | geo.addressn.com |
| C20.004 | `geofeed-adsl-cat` | adsl.cat |
| C20.005 | `geofeed-aeza-net` | aeza.net |
| C20.006 | `geofeed-analytics-wavenet-co-uk` | analytics.wavenet.co.uk |
| C20.007 | `geofeed-anydigital-sg` | www.anydigital.sg |
| C20.008 | `geofeed-arelion-com` | api.arelion.com |
| C20.009 | `geofeed-ariskisp-com` | ariskisp.com |
| C20.010 | `geofeed-as13030-net` | as13030.net |
| C20.011 | `geofeed-as207592-net` | www.as207592.net |
| C20.012 | `geofeed-as29119-net` | geofeed.as29119.net |
| C20.013 | `geofeed-as34244-net` | as34244.net |
| C20.014 | `geofeed-as34758-net` | as34758.net |
| C20.015 | `geofeed-as35518-net` | www.as35518.net |
| C20.016 | `geofeed-as42708-net` | as42708.net |
| C20.017 | `geofeed-as46261-net` | as46261.net |
| C20.018 | `geofeed-as56971-net` | as56971.net |
| C20.019 | `geofeed-as6453-net` | lg.as6453.net |
| C20.020 | `geofeed-as8220-net` | www.as8220.net |
| C20.021 | `geofeed-aspireripedb-blob-core-windows-net` | aspireripedb.blob.core.windows.net |
| C20.022 | `geofeed-assets-ip-only-net` | assets.ip-only.net |
| C20.023 | `geofeed-axioma24-ru` | geofeed.axioma24.ru |
| C20.024 | `geofeed-bae81f955b-cdn-adyen-com` | bae81f955b.cdn.adyen.com |
| C20.025 | `geofeed-bahnhof-net` | geofeed.bahnhof.net |
| C20.026 | `geofeed-beget-com` | geofeed.beget.com |
| C20.027 | `geofeed-bezeq-co-il` | www.bezeq.co.il |
| C20.028 | `geofeed-bikab-com` | geofeed.bikab.com |
| C20.029 | `geofeed-bredband2-net` | geofeed.bredband2.net |
| C20.030 | `geofeed-breitlandnet-de` | geo.breitlandnet.de |
| C20.031 | `geofeed-chillishot-net` | geofeed.chillishot.net |
| C20.032 | `geofeed-clodocloud-com` | geofeed.clodocloud.com |
| C20.033 | `geofeed-cloud-com-tr` | cloud.com.tr |
| C20.034 | `geofeed-clouvider-com` | clouvider.com |
| C20.035 | `geofeed-code200noc-github-io` | code200noc.github.io |
| C20.036 | `geofeed-code200noc-github-io-2` | code200noc.github.io |
| C20.037 | `geofeed-com-in-net` | com-in.net |
| C20.038 | `geofeed-config-zscaler-com` | config.zscaler.com |
| C20.039 | `geofeed-datagroup-ua` | geo.datagroup.ua |
| C20.040 | `geofeed-docs-google-com` | docs.google.com |
| C20.041 | `geofeed-dolsat-pl` | www.dolsat.pl |
| C20.042 | `geofeed-dravanet-net` | geofeed.dravanet.net |
| C20.043 | `geofeed-dtag-iot-ipgeolocation-s3-eu-central-1-amazonaws-com` | dtag-iot-ipgeolocation.s3.eu-central-1.amazonaws.com |
| C20.044 | `geofeed-edcl-io` | geofeed.edcl.io |
| C20.045 | `geofeed-edis-at` | www.edis.at |
| C20.046 | `geofeed-eso-org` | www.eso.org |
| C20.047 | `geofeed-etelecom-ru` | etelecom.ru |
| C20.048 | `geofeed-eunetworks-com` | geofeed.eunetworks.com |
| C20.049 | `geofeed-eurofiber-com` | geofeed.eurofiber.com |
| C20.050 | `geofeed-exoscale-prefixes-sos-exo-io` | exoscale-prefixes.sos.exo.io |
| C20.051 | `geofeed-extendbroadband-com` | www.extendbroadband.com |
| C20.052 | `geofeed-f5-com` | www.f5.com |
| C20.053 | `geofeed-fibergroep-nl` | fibergroep.nl |
| C20.054 | `geofeed-first-server-net` | geofeed.first-server.net |
| C20.055 | `geofeed-flagman-zp-ua` | www.flagman.zp.ua |
| C20.056 | `geofeed-forcepoint-com` | www.forcepoint.com |
| C20.057 | `geofeed-fornex-com` | fornex.com |
| C20.058 | `geofeed-forsakringskassan-se` | geofeed.forsakringskassan.se |
| C20.059 | `geofeed-g-snowd-com` | g.snowd.com |
| C20.060 | `geofeed-gcore-lu` | geofeed.gcore.lu |
| C20.061 | `geofeed-geofeeds-cyberzonehub-com` | geofeeds.cyberzonehub.com |
| C20.062 | `geofeed-geoip-i3d-net` | geoip.i3d.net |
| C20.063 | `geofeed-geoip-wookra-com` | geoip.wookra.com |
| C20.064 | `geofeed-geolocation-as931-net` | geolocation.as931.net |
| C20.065 | `geofeed-geolocation-itm8-com` | geolocation.itm8.com |
| C20.066 | `geofeed-gf-data-ee` | gf.data.ee |
| C20.067 | `geofeed-gigaclear-net` | gigaclear.net |
| C20.068 | `geofeed-gist-githubusercontent-com` | gist.githubusercontent.com |
| C20.069 | `geofeed-gitlab-com` | gitlab.com |
| C20.070 | `geofeed-gitlab-com-2` | gitlab.com |
| C20.071 | `geofeed-go-elevate-uk` | go.elevate.uk |
| C20.072 | `geofeed-hetzner-com` | www.hetzner.com |
| C20.073 | `geofeed-hkglobalnetwork-com` | geofeed.hkglobalnetwork.com |
| C20.074 | `geofeed-hoster-kz` | geofeed.hoster.kz |
| C20.075 | `geofeed-hoznian-github-io` | hoznian.github.io |
| C20.076 | `geofeed-hydracom-co-uk` | hydracom.co.uk |
| C20.077 | `geofeed-ib-systems` | ib.systems |
| C20.078 | `geofeed-ic-km-ua` | ic.km.ua |
| C20.079 | `geofeed-ikbnet-at` | geofeed.ikbnet.at |
| C20.080 | `geofeed-imagine-ie` | geo.imagine.ie |
| C20.081 | `geofeed-inalan-gr` | geofeed.inalan.gr |
| C20.082 | `geofeed-infopact-nl` | geofeed.infopact.nl |
| C20.083 | `geofeed-interciti-ru` | interciti.ru |
| C20.084 | `geofeed-interlir-com` | interlir.com |
| C20.085 | `geofeed-internext-cz` | internext.cz |
| C20.086 | `geofeed-invapi-hostkey-com` | invapi.hostkey.com |
| C20.087 | `geofeed-ip-as-com` | ip-as.com |
| C20.088 | `geofeed-ip-serveriai-lt` | ip.serveriai.lt |
| C20.089 | `geofeed-ipbroker-info` | ipbroker.info |
| C20.090 | `geofeed-ipdb-omnicorpnet-com` | ipdb.omnicorpnet.com |
| C20.091 | `geofeed-ipinfo-bizlinktel-com` | ipinfo.bizlinktel.com |
| C20.092 | `geofeed-iploc-quantaronet-com` | iploc.quantaronet.com |
| C20.093 | `geofeed-ipnet-ua` | ipnet.ua |
| C20.094 | `geofeed-ispconfig-digi-ro` | ispconfig.digi.ro |
| C20.095 | `geofeed-ispconfig-digi-ro-2` | ispconfig.digi.ro |
| C20.096 | `geofeed-itglobal-com` | geofeed.itglobal.com |
| C20.097 | `geofeed-iver-com` | geofeed.iver.com |
| C20.098 | `geofeed-kamatera-com` | www.kamatera.com |
| C20.099 | `geofeed-keminet-net` | geofeed.keminet.net |
| C20.100 | `geofeed-lanta-net-ru` | geo.lanta-net.ru |
| C20.101 | `geofeed-luminabroadband-com` | luminabroadband.com |
| C20.102 | `geofeed-market-fibercop-com` | market.fibercop.com |
| C20.103 | `geofeed-massresponse-com` | massresponse.com |
| C20.104 | `geofeed-media-bezeqint-net` | media.bezeqint.net |
| C20.105 | `geofeed-megaport-com` | lg.megaport.com |
| C20.106 | `geofeed-meta-nextpertise-nl` | meta.nextpertise.nl |
| C20.107 | `geofeed-minio-uzdc-uz` | minio.uzdc.uz |
| C20.108 | `geofeed-mkpnet-ru` | mkpnet.ru |
| C20.109 | `geofeed-mvps-net` | www.mvps.net |
| C20.110 | `geofeed-net-sky` | geofeed.net.sky |
| C20.111 | `geofeed-net3-ai` | geofeed.net3.ai |
| C20.112 | `geofeed-netcrafters-tech` | netcrafters.tech |
| C20.113 | `geofeed-network-thg-com` | geofeed.network.thg.com |
| C20.114 | `geofeed-netz-mwn-de` | geofeed.netz.mwn.de |
| C20.115 | `geofeed-nevalink-net` | nevalink.net |
| C20.116 | `geofeed-noc-ilan-net-il` | noc.ilan.net.il |
| C20.117 | `geofeed-obj3220-public-dk6-clu4-obj-storagefactory-io` | obj3220.public-dk6.clu4.obj.storagefactory.io |
| C20.118 | `geofeed-opengeofeed-org` | opengeofeed.org |
| C20.119 | `geofeed-paltel-ps` | www.paltel.ps |
| C20.120 | `geofeed-podaon-com` | geofeed.podaon.com |
| C20.121 | `geofeed-portal-proxybr-com-br` | portal.proxybr.com.br |
| C20.122 | `geofeed-power-servers-net` | geofeed.power-servers.net |
| C20.123 | `geofeed-powernet-com-ru` | geofeed.powernet.com.ru |
| C20.124 | `geofeed-prefixbroker-com` | www.prefixbroker.com |
| C20.125 | `geofeed-r-kom-de` | geofeed.r-kom.de |
| C20.126 | `geofeed-rapidseedbox-com` | geofeed.rapidseedbox.com |
| C20.127 | `geofeed-raw-githubusercontent-com` | raw.githubusercontent.com |
| C20.128 | `geofeed-raw-githubusercontent-com-10` | raw.githubusercontent.com |
| C20.129 | `geofeed-raw-githubusercontent-com-11` | raw.githubusercontent.com |
| C20.130 | `geofeed-raw-githubusercontent-com-2` | raw.githubusercontent.com |
| C20.131 | `geofeed-raw-githubusercontent-com-3` | raw.githubusercontent.com |
| C20.132 | `geofeed-raw-githubusercontent-com-4` | raw.githubusercontent.com |
| C20.133 | `geofeed-raw-githubusercontent-com-5` | raw.githubusercontent.com |
| C20.134 | `geofeed-raw-githubusercontent-com-6` | raw.githubusercontent.com |
| C20.135 | `geofeed-raw-githubusercontent-com-7` | raw.githubusercontent.com |
| C20.136 | `geofeed-raw-githubusercontent-com-8` | raw.githubusercontent.com |
| C20.137 | `geofeed-raw-githubusercontent-com-9` | raw.githubusercontent.com |
| C20.138 | `geofeed-redcom-ru` | redcom.ru |
| C20.139 | `geofeed-retn-net` | www.retn.net |
| C20.140 | `geofeed-ripe-unyc-io` | ripe.unyc.io |
| C20.141 | `geofeed-ruvds-com` | ruvds.com |
| C20.142 | `geofeed-s3-wifirst-net` | s3.wifirst.net |
| C20.143 | `geofeed-sa-zain-com` | sa.zain.com |
| C20.144 | `geofeed-sakura-as` | geo.sakura.as |
| C20.145 | `geofeed-sanaplus-ua` | sanaplus.ua |
| C20.146 | `geofeed-sapphire-networks-com` | sapphire-networks.com |
| C20.147 | `geofeed-secure-wireline-com-au` | secure.wireline.com.au |
| C20.148 | `geofeed-selectel-ru` | geofeed.selectel.ru |
| C20.149 | `geofeed-smartape-ru` | smartape.ru |
| C20.150 | `geofeed-stat-maxnet-ua` | stat.maxnet.ua |
| C20.151 | `geofeed-status-serv-host` | status.serv.host |
| C20.152 | `geofeed-suregeoip-sure-com` | suregeoip.sure.com |
| C20.153 | `geofeed-syn-uk` | syn.uk |
| C20.154 | `geofeed-tele2-net` | geofeed.tele2.net |
| C20.155 | `geofeed-teledata-de` | www.teledata.de |
| C20.156 | `geofeed-telia-net` | lg.telia.net |
| C20.157 | `geofeed-the-hosting` | the.hosting |
| C20.158 | `geofeed-time-net-it` | geofeed.time-net.it |
| C20.159 | `geofeed-timeweb-net` | geofeed.timeweb.net |
| C20.160 | `geofeed-trooli-com` | geofeed.trooli.com |
| C20.161 | `geofeed-truespeed-net-uk` | geofeed.truespeed.net.uk |
| C20.162 | `geofeed-ttc-kz` | ttc.kz |
| C20.163 | `geofeed-tviy-net-ua` | tviy.net.ua |
| C20.164 | `geofeed-unive-it` | www.unive.it |
| C20.165 | `geofeed-vdsina-com` | vdsina.com |
| C20.166 | `geofeed-vdsina-ru` | vdsina.ru |
| C20.167 | `geofeed-velia-net` | www.velia.net |
| C20.168 | `geofeed-vernet-lv` | www.vernet.lv |
| C20.169 | `geofeed-virtono-com` | virtono.com |
| C20.170 | `geofeed-vsenet-de` | geofeed.vsenet.de |
| C20.171 | `geofeed-vsys-host` | vsys.host |
| C20.172 | `geofeed-whgi-net` | geofeed.whgi.net |
| C20.173 | `geofeed-wiredisp-com` | geofeed.wiredisp.com |
| C20.174 | `geofeed-wnet-global` | geofeed.wnet.global |
| C20.175 | `geofeed-ws-sdn-net` | ws-sdn.net |
| C20.176 | `geofeed-zen-co-uk` | zen.co.uk |
| C20.177 | `geofeed-zenlayer-net` | geofeed.zenlayer.net |
| C20.178 | `geofeed-zf-com` | geofeed.zf.com |
