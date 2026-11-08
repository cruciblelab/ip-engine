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
| A | RIR & IANA registry data | 7 | – | 1 | 5 | 1 | – |
| B | BGP, ASN, routing | 6 (B1, B2, B4 ⏸ since Phase 1) | – | – | 3 | – | – |
| C | Geolocation | 20 items = 197 sources | – | 3 | 13 | 4 | – |
| D | Cloud / CDN ranges | 9 | – | – | 9 | – | – |
| E | Verified bots | 12 | – | – | – | 12 | – |
| F | Anonymity & threat | 3 | – | – | 1 | 2 | – |
| G | Live, query-time & internal tools | 4 | – | 1 | 1 | 2 | – |
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
   users, is not. Needs a deliberate answer.
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
| A1 | ARIN delegated-extended | Public, RIR terms | Generalised from A3's header | 🟡 |
| A2 | RIPE NCC delegated-extended | Public, RIR terms | Generalised from A3's header; tension with B4 | 🟠 |
| A3 | APNIC delegated-extended | Liability disclaimer only | File header, quoted, 2026-08-19 | 🟢 |
| A4 | LACNIC delegated-extended | Public, RIR terms | Generalised from A3's header | 🟡 |
| A5 | AFRINIC delegated-extended | Public, RIR terms | Generalised from A3's header | 🟡 |
| A6 | IANA special-purpose IPv4 (`iana-ipv4-special`) | "Public registry data" | Registry field only; IANA's terms not read | 🟡 |
| A7 | IANA special-purpose IPv6 (`iana-ipv6-special`) | "Public registry data" | Registry field only; IANA's terms not read | 🟡 |

## Phase B — BGP, ASN, routing

| ID | Source (registry id) | Recorded license | Evidence | Risk |
|---|---|---|---|---|
| B1 | RIPE RIS whois IPv4 (`ris-whois-ipv4`) | RIS commercial-use terms: logo + link + paragraph | RIPE commercial-use page, 2026-08-24/25 | ⏸ replaced by B6 as default, 2026-11-08 [🔴 logo never granted] |
| B2 | RIPE RIS whois IPv6 (`ris-whois-ipv6`) | same | same | ⏸ same [🔴] |
| B3 | CAIDA AS-organizations (`caida-asn-names`) | CAIDA AUA, attribution | AUA PDF read directly, 2026-08-24; public AUA page re-read 2026-11-08 | 🟡 **downgraded in Phase 1** — see note below |
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
| C2 | DB-IP Lite (`dbip-lite`) | CC BY 4.0 + link back | db-ip.com ToS + license pages, 2026-08-21 | 🟠 API attribution question |
| C3 | LACNIC bulk whois city (`lacnic-whois-city`) | LAC-2018-3 policy publication | Policy text, 2026-08-19 — "free to download", no explicit commercial grant | 🟠 |
| C4 | Verizon (`verizon-geofeed`) | CDLA-Permissive-2.0 | License file | 🟢 |
| C5 | T-Mobile US (`tmobile-geofeed`) | Apache-2.0 | License file | 🟢 |
| C6 | Netflix (`netflix-geofeed`) | Restricted: geo accuracy only | Feed's own statement | 🟠 usage trace needed |
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
| G1 | RDAP at all five RIRs — abuse contacts, geofeed discovery, network names | Same RIPE Database T&C as bulk whois (Art. 4.5); per-query + cache is "defensible, not airtight" (`SOURCES.md`). Abuse contacts may be personal data. Out of scope for the `ipreadout-service` launch. | 🟠 |
| G2 | Reverse DNS (PTR) | Public DNS | 🟢 |
| G3 | `security.txt` (RFC 9116) | Self-published for exactly this purpose | 🟢 |
| G4 | RIPE RIS Live WebSocket (`bgp-live run`, `docs/97`) — **added in Phase 1, missed in Phase 0** | RIPE RIS data, same terms as B1/B2. Internal monitoring only: `lookup` and the `.mmdb` never read `bgp_live_events`. Seeds from `bgp_origin_ranges`, so it now compares RIS Live against a RouteViews baseline — works, but `peer_count` scales differ. If it ever feeds anything customers see, B1's logo condition comes with it. | 🟡 |

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
2. **A1–A7** — re-check each RIR file and IANA registry individually;
   resolve the A2/B4 consistency question.
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
