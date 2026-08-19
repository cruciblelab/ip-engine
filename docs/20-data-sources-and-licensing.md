# Data sources, ASN classification, and licensing research

Dated entries, oldest first. Split out of the original single `DEPLOY.md` journal on 2026-08-07 for navigability — content is unedited, only relocated.

## In this file

- [Candidate data sources — discussed, not yet built, roughly prioritized](#candidate-data-sources-discussed-not-yet-built-roughly-prioritized)
- [Candidate data sources, round 2 — researched via three parallel agents (2026-08-04)](#candidate-data-sources-round-2-researched-via-three-parallel-agents-2026-08-04)
- [PeeringDB as a broader ASN-classification source — checked and rejected (2026-08-02)](#peeringdb-as-a-broader-asn-classification-source-checked-and-rejected-2026-08-02)
- [Ingestion-health thresholds — considered moving to `ip-insight.config.json`, decided against (2026-08-02)](#ingestion-health-thresholds-considered-moving-to-ip-insight-config-json-decided-against-2026-08-02)
- [ASN classification beyond hand-picked entries — extended `connection-type.ts` (2026-08-02, implemented)](#asn-classification-beyond-hand-picked-entries-extended-connection-type-ts-2026-08-02-implemented)
- [RIPE RIS commercial use, IRR route objects, and AS-PATH/customer-cone licensing — researched (2026-08-02)](#ripe-ris-commercial-use-irr-route-objects-and-as-path-customer-cone-licensing-researched-2026-08-02)
- [RIPE RIS attribution — implementation plan (2026-08-02, not yet built)](#ripe-ris-attribution-implementation-plan-2026-08-02-not-yet-built)
- [ASN-name licensing thread — deliberately deferred (2026-08-02)](#asn-name-licensing-thread-deliberately-deferred-2026-08-02)
- [Live RIPE Stat fallback in `lookup.ts` — found and removed (2026-08-03)](#live-ripe-stat-fallback-in-lookup-ts-found-and-removed-2026-08-03)
- [Sibling-ASN clustering, IPv6 dual-stack detection (2026-08-03)](#sibling-asn-clustering-ipv6-dual-stack-detection-2026-08-03)
- [SSRF in `geofeedFromRdap` — fixed (2026-08-04)](#ssrf-in-geofeedfromrdap-fixed-2026-08-04)
- [Bunny.net implemented too (2026-08-04, same day) — the "problem" turned out smaller than it looked](#bunny-net-implemented-too-2026-08-04-same-day-the-problem-turned-out-smaller-than-it-looked)
- [Orange Luxembourg + Yandex Cloud CDN removed after a deep commercial-terms review (2026-08-05)](#orange-luxembourg-yandex-cloud-cdn-removed-after-a-deep-commercial-terms-review-2026-08-05)
- [RDAP made quota-resilient, and `network_name` finally filled (2026-08-05)](#rdap-made-quota-resilient-and-network-name-finally-filled-2026-08-05)
- [`usage_type` "hosting" default replaced with honest null; ~14pt drop in unclassified ASNs (2026-08-05)](#usage-type-hosting-default-replaced-with-honest-null-14pt-drop-in-unclassified-asns-2026-08-05)
- [Regional coverage audit — geofeed and ASN classification broken down by RIR (2026-08-05, same day)](#regional-coverage-audit-geofeed-and-asn-classification-broken-down-by-rir-2026-08-05-same-day)

---

### Candidate data sources — discussed, not yet built, roughly prioritized

Prompted by "what else could we add without hitting licence problems like
Spamhaus." All below are either self-published-for-verification (same
licence-safe shape as the Tor/cloud/bot sources already in the codebase)
or have clear open licences. None of this is committed — revisit this list
before starting any of it, priorities may have shifted.

1. **Typed history change events — done.** Added `diffHistoryRecords()` /
   `changeEvents()` (`packages/collector/src/history-diff.ts` +
   `history.ts`), plus `ip-insight history events <ip>`. No new storage — it
   reads `historyTimeline()`'s existing old/new record pairs and classifies
   which of four field groups moved: `PrefixChanged` (rir/rir_status/
   network_name/registered_date — registration facts), `ASNChanged` (asn/
   asn_name/asn_type), `GeoChanged` (country/city/region/postal/lat/lon/
   geo_source), `ThreatChanged` (is_threat/threat_source/threat_category).
   A single capture can emit more than one event type — e.g. a renumbering
   that also moves the ASN emits `PrefixChanged` and `ASNChanged` together
   from the same capture, verified below. Fields outside these four
   groups (cloud/anycast/RPKI/verified-bot/anonymity/abuse-contact/
   asn-reach) intentionally produce no typed event — they still show up in
   the underlying whole-record `history timeline`/`history at` diff, same as
   before, just not decomposed, because nothing asked for that.

   The pure classification logic (`diffHistoryRecords`) is deliberately
   split into its own file with no `@workspace/db` import specifically so it
   unit-tests without `DATABASE_URL` set — `history.ts` throws at module
   load otherwise (`db`'s own import does), which would have made every test
   in the file an integration test by accident. Covered by
   `packages/collector/src/history-diff.test.ts` (6 cases: no-op, single
   group, cross-group isolation, multi-group in one capture, missing-field
   handling, `PrefixChanged` vs `ASNChanged` distinctness).

   Verified against a real two-capture cycle, not just the unit tests: with
   `ipIntelMode: materialized` and a baseline already captured, changing a
   Linode geofeed row's country/city and re-capturing produced exactly one
   `GeoChanged` event with the real before/after values; changing a
   `threat_ranges.category` produced exactly one `ThreatChanged` event;
   changing a synthetic prefix's ASN and RIR status together produced both
   `ASNChanged` and `PrefixChanged` from the same capture, correctly kept as
   two separate events rather than one blob.
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
4. **FireHOL IP Lists — investigated, deliberately not added.** This
   session's own earlier note above ("per-list licences stated explicitly,
   mostly open") turned out not to hold up under actual verification: the
   repo has no license file, its README says as much, and every individual
   list checked was either Spamhaus/bogons under the hood, non-commercial-
   only (dshield), or explicitly restrictive (greensnow, botvrij) — none
   cleared this project's own bar. Full list of what was checked in
   SOURCES.md's "Layer 6" section. Lesson for next time: "some are more
   open than others" needs to mean checking each one at the primary source,
   not trusting a one-line summary (including this document's own).
5. **abuse.ch feeds — done, and became the actual `is_threat` fix in
   FireHOL's place.** Feodo Tracker added (CC0, explicit, verified end to
   end on real data). URLhaus checked and left out: its own download files
   point at the same "commercial use may require a paid subscription" terms
   as the abuse.ch/Spamhaus platform API (abuse.ch and Spamhaus are the same
   organisation now) — the same ambiguity Spamhaus itself was excluded for.
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

### Candidate data sources, round 2 — researched via three parallel agents (2026-08-04)

Same discipline as round 1 above: every candidate below was checked at its
own primary/operator URL, not assumed from a mirror or a project's
reputation. None of this is wired up yet — this is the research pass only,
per explicit instruction to expand the list before deciding what to build.
Full per-source citations (exact URL fetched, exact terms language) live in
this session's agent transcripts, not reproduced in full here — re-verify
the specific URL before actually ingesting anything, since terms/endpoints
can change between "checked" and "built."

**New genuine candidates (real first-party file, clear enough terms or the same "no terms stated" precedent AWS/Cloudflare/GeoNames-adjacent sources already ship under):**

9. **SSLBL** (abuse.ch) — a *second*, separate abuse.ch dataset from Feodo
   Tracker: botnet C2 IP:port pairs tied to malicious SSL/TLS certificates
   (CSV/JSON/Suricata rules), small scale (hundreds to low thousands of
   rows). Own stated terms: **CC0**, "commercial and non-commercial purpose
   without any limitations" — confirmed as its own per-dataset grant,
   separate from URLhaus/ThreatFox's paid-subscription-for-commercial
   clause (abuse.ch really does set terms per dataset, not org-wide, same
   pattern Feodo Tracker's own entry above already established). Natural
   fit: extends `threat_ranges` the same way Feodo Tracker does.
10. **Yandex Cloud CDN** — `tech.cdn.yandex.net/prefixes/yc.json`, same
    `{"prefixes":[...]}` shape as AWS/GCP, 89 CIDR blocks, confirmed live.
    No terms stated (same "published for public consumption, nothing
    written" pattern as AWS/Cloudflare/Oracle/Fastly already in the
    codebase). Scope caveat: CDN edge only, not all of Yandex Cloud's
    compute/VPC ranges — those remain prose-only in Yandex's docs.
11. **Bunny.net (Bunny CDN)** — `bunnycdn.com/api/system/edgeserverlist`
    (+ `/IPv6`), confirmed live, ~120+ entries. No terms stated. Shape
    caveat: a flat array of **individual IP addresses, not CIDR blocks** —
    would need different ingestion handling than every other cloud source
    here, which are all range-based.
12. **More RFC 8805 geofeeds** — four more operators publishing at a
    stable first-party URL, found via RIPE's full-text search API
    (`apps.db.ripe.net`) surfacing their own `remarks: Geofeed` lines, not
    a third-party list:
    - **GTT** (AS3257) — `geolocation.gtt.net/gtt_geolocation.csv`.
    - **Charter/Spectrum** — CSV hosted on their own S3 bucket, 18MB,
      linked from a Spectrum-controlled page.
    - **Fastly** — `ip-geolocation.fastly.com`. Note: Fastly is *already*
      in the codebase as a Layer 4 cloud-ranges source
      (`api.fastly.com/public-ip-list`) — this would be a second, distinct
      feed from the same operator, for Layer 2 location data specifically,
      not a duplicate.
    - **Zayo** (EU entities only) — `zayo.is/eu-geofeeds`, which itself
      redirects to a Zayo-controlled Google Sheets CSV. Caveat: final host
      is Google Sheets, not zayo.com — a redistribution/hosting-reliability
      wrinkle worth a second look before ingesting, and EU-subsidiary scope
      only, not Zayo globally.
    - **Orange Luxembourg** (subsidiary only, not Orange Group) —
      `resources.orange.lu/geofeed.csv`.
    - Checked, still **not found** (no geofeed remark on their own core
      WHOIS objects, confirming the earlier F5/Telstra/Cloudflare/AWS/Azure
      finding extends to more carriers): Comcast, AT&T, BT, Deutsche
      Telekom, Telefónica, Vodafone, Rogers, Bell Canada, KDDI, SoftBank,
      China Telecom, Level3/Lumen, Telstra, Hurricane Electric.
13. **RPKI validator redundancy** (for the "multiple validators, higher-
    priority wins on disagreement" config the project already supports,
    currently only pointed at `console.rpki-client.org`):
    - **Cloudflare's RPKI portal** — `rpki.cloudflare.com/rpki.json`, same
      `roas[]`/asn/prefix/maxLength shape, confirmed live (~102MB), no
      terms stated.
    - **RIPE NCC's RPKI Validator export** —
      `rpki-validator.ripe.net/api/export.json`, same shape, confirmed
      live (~86MB). Caveat: RIPE NCC announced in 2021 it was retiring this
      in-house validator in favor of third-party tools (Routinator/
      OctoRPKI/rpki-client) — the endpoint still answers today, but its
      long-term availability isn't guaranteed, so treat as weaker than
      Cloudflare's for a dependency you'd actually build on.
14. **ASN metadata/classification alternatives** to the rejected PeeringDB/
    CAIDA sources:
    - **bgp.tools** — `bgp.tools/asns.csv` (`asn,name,class,cc`), and its
      `class` field is a genuine, directly-usable ASN business-type
      classification (e.g. "Eyeball") — exactly the PeeringDB-shaped gap
      this project already noted has no clean replacement. Caveat: no
      formal written license, only operational netiquette (a descriptive
      `User-Agent` with a real contact email is required — "requests from
      default user agents are not allowed" — and the file should be cached
      ~24h, not re-fetched per request). Worth a real look before the
      "no comprehensive ASN-classification source exists" conclusion above
      is treated as final.
    - **Team Cymru's IP-to-ASN mapping service** — marketed "Free.
      Forever.", no formal written license found. Gives ASN/prefix/
      registry mapping (metadata this project already derives locally from
      BGP data), not business-type classification — lower value than
      bgp.tools for the actual gap, listed for completeness.

**Marginal candidates — real, first-party, dedicated, but small-scale or not machine-friendly format; a judgment call, not an obvious yes:**

15. **Scaleway** — a dedicated (not scattered-examples) plain-Markdown list
    at their own docs URL: 12 IPv4 CIDRs + 1 IPv6 CIDR.
16. **Backblaze** — a dedicated Zendesk help article, explicitly labeled
    CIDR notation: 4 IPv4 CIDRs + 1 IPv6 CIDR. Stale — last updated Feb
    2022, worth confirming currency before use.
17. **PIA (Private Internet Access)** VPN server list —
    `serverlist.piaservers.net/vpninfo/servers/v6`, unauthenticated JSON
    with per-server IPs, and genuinely used openly by PIA's own official
    open-source client (`pia-foss/manual-connections`) — but not documented
    as a public API product anywhere and carries no stated terms. Weakest
    of the three VPN findings; everything else checked (NordVPN,
    Windscribe, ExpressVPN, Surfshark, TunnelBear, IVPN, CyberGhost) came
    back negative, confirming the expectation that Mullvad is close to
    alone in publishing this openly on purpose.

**Checked and rejected, recorded so it isn't re-researched later:**

- **Threat feeds**: ThreatFox and MalwareBazaar (abuse.ch — same
  paid-subscription-for-commercial clause as URLhaus, a *different*
  per-dataset grant than Feodo Tracker/SSLBL), AlienVault OTX (EULA bars
  commercial exploitation/redistribution outright), GreyNoise free tier
  (internal/non-commercial only, revocable at will), Shadowserver
  (non-profit/own-org-only/attribution-gated, not open bulk download),
  PhishTank (domain/URL data only, no IPs, and terms unclear post-Cisco
  acquisition), OpenPhish community feed (commercial reuse explicitly
  reserved for paid tiers), CIRCL BGP Ranking (AGPL software, no data
  license for the ranking data itself), CISA KEV (vulnerability data, not
  IP-level — dead end, not a rejection), CrowdSec Community Blocklist
  (capped at 3,000 IPs, requires contributing signals, commercial
  redistribution needs a paid partnership).
- **Cloud/CDN/hosting with no usable file found**: IBM Cloud (the one
  "CIDR calculator" shortlink in their own docs actually redirects to an
  unrelated third-party domain — a dead/hijacked link, not an IBM asset),
  Alibaba Cloud (WAF back-to-origin CIDRs are account-gated, no public
  file), Tencent Cloud, Huawei Cloud, Vultr (checked for a feed beyond the
  already-ingested Constant.com geofeed — nothing else exists), UpCloud,
  Contabo, LeaseWeb (their public API is customer floating-IP management,
  same non-answer shape as OVH), Akamai's CDN edge specifically (confirmed
  dynamic/per-customer, no static file — distinct from Linode/Akamai
  Connected Cloud, which is already ingested), StackPath (company fully
  shut down and liquidated June 2024 — moot), KeyCDN, Heroku, Render,
  Fly.io, Vercel (states outright "no defined range"), Netlify, Railway
  (only unofficial, "not guaranteed" community-sourced CIDRs exist),
  Wasabi (explicitly says it doesn't publish ranges, recommends hostname
  allowlisting instead).
- **ASN metadata**: RIPEstat API — rejected outright, not just deferred:
  RIPE NCC's own terms state commercial use "is not allowed unless
  permission... granted in writing" and bar re-packaging/redistributing
  RIPEstat data, a stronger and more explicit bar than the bulk-whois
  restriction already documented elsewhere in this project. MANRS
  participant list (real API, but requires a free account + API key —
  not open/anonymous, a friction rejection rather than a licensing one).
  Hurricane Electric's `bgp.he.net` (practically blocked — a direct
  programmatic request, even to `robots.txt`, returned HTTP 403; AUP is
  silent on scraping but the server enforces it anyway).

### PeeringDB as a broader ASN-classification source — checked and rejected (2026-08-02)

Separately from IXP detection above: PeeringDB also carries a per-ASN
"network type" classification (ISP, content/CDN, cable, mobile, satellite,
education, etc.) that looked like a scalable alternative to hand-picking
ASNs one at a time (the way Starlink/AS14593 was added). **Checked
PeeringDB's own Acceptable Use Policy directly (peeringdb.com/aup) and it
fails this project's licensing bar, same shape as the FireHOL/Spamhaus
rejection:**
> "The PeeringDB data may not be passed on in bulk to any other person or
> organization unless approved by PeeringDB." Bulk downloads are restricted
> to "Internet operational issues" and explicitly exclude "compiling
> marketing lists, demographic mapping, or **any other commercial
> application**."

Baking this into `ip_intel` (served to paying customers) is exactly the
commercial use it excludes. **Do not add PeeringDB data to this project.**

Looked for a clean alternative to get the same broad ASN-type coverage:
**CAIDA's AS Classification dataset is gone** — CAIDA has discontinued and
removed download access to it entirely (legacy/historical-only status, not
a licensing question, the data simply isn't downloadable anymore). No
comprehensive, cleanly-licensed source for "classify all ASNs by business
type" currently exists that this project found.

**Conclusion, decided**: no comprehensive ASN-classification source —
continue the Starlink pattern (a small, hand-curated list of specific,
individually-verified ASNs added one at a time, e.g. other satellite ISPs
if one is later worth adding) rather than attempting to replicate
PeeringDB's crowd-sourced scale from scratch, which isn't realistic at this
project's size regardless of licensing.

### Ingestion-health thresholds — considered moving to `ip-insight.config.json`, decided against (2026-08-02)

Proposal was: move `ingestion-health.ts`'s per-source minimum-row thresholds
(`COLLECTION_MINIMUMS`/`ENRICHMENT_MINIMUMS`) into the JSON config for
visibility/editability. **Decided against it:**
- Each threshold carries real, specific reasoning as an inline comment
  (e.g. "Feodo Tracker's blocklist is small by design... a real run saw
  5") — JSON has no comments, so moving them there would strip exactly the
  context that makes each number trustworthy instead of arbitrary. Same
  problem already hit once with `ip-insight.config.json` itself.
- These thresholds aren't a per-deployment tuning knob (the reason config
  exists) — they're fixed facts about each specific upstream source's real
  behavior, true for every deployment alike. They belong with the code that
  interprets them, not in operator-facing config.
- Also worth remembering: this mechanism catches a source coming back at
  (or near) **zero** — it is a fixed floor, not a comparison against the
  previous run's count, so a source dropping from e.g. 20 rows to 1 row
  would likely still read "ok" if 1 clears that source's floor. It solves
  "silently died," not "silently degraded." Flagged as a known limitation,
  not changed — building true relative/historical-drop detection is a
  bigger mechanism for a failure mode (partial degradation vs. total
  failure) that hasn't actually been observed yet.

### ASN classification beyond hand-picked entries — extended `connection-type.ts` (2026-08-02, implemented)

Fair pushback received: a short hand-curated list (just `SATELLITE_ASNS =
{14593}`) does not scale to "a solid database" of ASN classifications on
its own, and no comprehensive third-party dataset is usable (PeeringDB and
CAIDA both ruled out above — one for licensing, one for no longer
existing).

**The scalable piece was already sitting in the codebase — extended it
instead of adding a new dataset.** `connection-type.ts`'s `PATTERNS` array
classifies by pattern-matching the ASN's own self-published name text (RIR
`AS-NAME` data this project already collects — no new source, no new
license). Added three new categories the same way `hosting` was originally
added: `education`, `government`, `iot`. Also added a text pattern for
`satellite` (`\b(satellite|vsat)\b`) as a *complement* to the existing
numeric Starlink entry — Starlink stays numeric because its own name text
is inconsistent ("SPACEX-STARLINK"/"STARLINK"/"SpaceX"), but most other
satellite operators do self-describe plainly and are now caught by text.

**Verified against real data before shipping, not assumed** — dumped every
non-null `name` in the phone/sandbox's own `asn_blocks` table (101,772 real
RIR-published names) and grepped each candidate pattern for false
positives before committing to it:
- `\b(university|universidade|universidad|college|academic|school|edu)\b`
  for `education` — clean. Bare `university` alone would have silently
  missed every Brazilian/Latin American institution (`Universidade`/
  `Universidad`, not the English word) — added those explicitly.
- `\b(government|municipal|gov)\b` for `government` — clean.
  **`federal` was tested and explicitly rejected**: real data showed it
  firing on hundreds of US "Federal Credit Union" (finance) and Brazilian/
  Russian "Federal University" (education) names far more often than on
  actual government agencies — a bare keyword that looks obviously right
  and is actually a trap, same shape as the `\bcloud\b` vs `\bcloud\d*\b`
  lesson already in this file. Left out.
- `\b(iot|m2m)\b` for `iot` — clean (Cisco IoT, Bosch IoT, M2M Services,
  etc., no unrelated hits).
- `\b(satellite|vsat)\b` — reasonably clean; `\bleo\b` was tested and
  **rejected** (the human first name "Leo" dominates real ASN names —
  "Leo Scherr", "Leo Shum", "Saint Leo University" — far outnumbering LEO
  satellite operators; would have been actively wrong more often than
  right).
- Ordering matters and was checked against real collisions:
  `education`/`government` are placed **before** `corporate` in the
  pattern list because real ASN names collide ("Harvard **Business**
  School" contains a corporate keyword but is clearly education; several
  Ukrainian "**Municipal** Enterprise ..." utilities contain "enterprise"
  but are clearly government) — the more specific label wins.

Live-verified end-to-end through the real CLI against real BGP-announced
prefixes in the sandbox database (not just unit tests):
```
$ node apps/cli/dist/index.mjs lookup 192.70.171.1
ASN:       AS4511 (MIAMI-EDU - University of Miami, US) [bgp-ris]
Conn type: education (heuristic, matched "edu")

$ node apps/cli/dist/index.mjs lookup 135.84.96.1
ASN:       AS36180 (CISCO-IOT - Cisco IoT, US) [bgp-ris]
Conn type: iot (heuristic, matched "iot")
```
`packages/api-spec/openapi.yaml`'s `IpLookupConnectionType.type` enum
updated to match (`education`, `government`, `iot` added) and
`pnpm --filter @workspace/api-spec run codegen` re-run so the generated
client/schema types stay in sync — this is a real API contract change for
anyone consuming `connection_type`, not just an internal enum. Full
`pnpm run typecheck` and `pnpm test` (43/43, up from 35) both clean after
the change.

### RIPE RIS commercial use, IRR route objects, and AS-PATH/customer-cone licensing — researched (2026-08-02)

Three related licensing questions came up together; checked each against
its own primary source directly (not a paraphrase), same discipline as the
PeeringDB/CAIDA checks above.

**RIPE RIS (Routing Information Service) — usable, attribution required.**
Fetched `ripe.net/analyse/internet-measurements/routing-information-service-ris/commercial-use/`
directly. Confirmed: RIPE NCC grants a **default, no-application-needed**
permission to use RIS data (including in paid products) to any
organisation that (1) accepts RIPE NCC's Website/Services Terms of
Service, and (2) carries three specific attribution elements — the RIPE
NCC logo, a link to `ripe.net/ris`, and a ~200-word standard boilerplate
description of what RIS is. The permission is **revocable** (non-compliance
or RIPE NCC discontinuing the policy) — an ongoing attribution obligation,
not a one-time approval, but there is no gatekeeping step to clear before
using it. This is a real, usable source and materially different from
every source rejected so far (FireHOL/Spamhaus/PeeringDB) — those had
unclear or explicitly-restrictive terms; this one is explicit and
permissive, it just carries a visible-attribution condition. **Action
item, not yet built**: the required logo+link+boilerplate needs a home —
this is exactly what `ipreadout-service/PLAN.md`'s planned static
"Sources/transparency" page (Section 10) is for; add a RIPE RIS attribution
block there once that page gets built, and don't ship RIS-derived data
before it exists.

**RIPE Database / IRR route(6) objects — checked, rejected, unclear-license shape.**
This is a different RIPE NCC service from RIS above, with its own terms.
Fetched `docs.db.ripe.net/terms-conditions.html` directly. Two provisions
rule this out for a paid product: Article 4.4 bans use "for advertising,
direct marketing, marketing research or similar purposes"; Article 4.5
bans bulk "re-package, download, compile, re-distribute or re-use" of the
database "unless ... an insubstantial part ... or when permission ... is
granted by the RIPE NCC" — route/route6 objects are RIPE Database objects,
so this covers them. No permission grant exists for this the way it does
for RIS. **Do not add RIPE IRR data to this project** without first getting
that separate, explicit written permission from RIPE NCC (a business
decision, not a technical one — not pursued here).

**RADb (Merit's IRR) — checked, rejected, same shape as FireHOL.**
Fetched RADb's own Terms of Service (`radb.net/docs/terms-of-service.html`)
and Merit's linked Acceptable Use Policy (`merit.edu/support/policies/`)
directly. Neither document grants **or** prohibits bulk/commercial
redistribution — the ToS only covers registrants' upload obligations, and
the AUP is generic (no unauthorized access, no network abuse, respect
others' IP) with nothing specific to reusing RADb's own data. This is the
same "no clear stated license" shape that got FireHOL rejected earlier in
this document, not a new precedent — **absence of an explicit grant is
treated the same as absence of a license, don't ingest.** Would need to
contact Merit directly for a stated answer before revisiting.

**AS-PATH data for a real customer cone — RouteViews recommended, not yet built.**
`packages/db/src/asnReach.ts`'s own header comment already documents that
`asn_reach` is an origination-footprint metric, explicitly **not** a
customer cone, because a real customer cone requires full AS *paths*
(who transits for whom), while the RIS whois dump this project ingests
today only carries prefix → origin ASN with no path. Building an actual
customer cone is a materially bigger feature than the enrichment sources
added so far, not a config tweak:
1. **Data**: needs a source of raw BGP RIB/update dumps with full AS-PATH,
   not just origin ASN. Two license-clean candidates:
   - **RouteViews** (University of Oregon, `archive.routeviews.org`) — a
     separate, independent project from RIPE NCC entirely. Multiple
     independent secondary sources consistently describe its data as
     **CC BY 4.0** (commercial use expressly permitted, attribution via
     citing RouteViews' DOI). **Caveat, stated plainly**: the primary
     `routeviews.org` site returned HTTP 503 on every direct-fetch attempt
     during this research session, so the exact license text was not read
     first-hand the way PeeringDB's/RIPE's were — this should be
     re-verified against the primary page before actually ingesting, not
     assumed from search summaries alone. High confidence, not yet
     first-hand confirmed.
   - **RIPE RIS's own raw MRT archive** — same commercial-use grant
     already confirmed above (RIS's permission page is not scoped to any
     particular RIS data product), so the same attribution obligation
     would apply to path data pulled from RIS too.
2. **Computation**: a customer cone isn't in the raw data either way — it
   requires AS-relationship inference (customer/provider/peer per AS pair)
   from observed paths, a well-published but non-trivial algorithm (the
   Gao/CAIDA family of degree-heuristic inference algorithms), then a
   graph traversal to size each ASN's cone. This is real, scoped
   engineering — closer in size to the original `ip_intel` materialized
   view work than to adding one more enrichment source — and should be
   planned as its own phase, not bundled in with the next round of small
   source additions.

Nothing above has been built yet — this section is the research/decision
record the user asked for before any of it gets scoped into actual work.

**Decision (2026-08-02)**: customer cone (item 4 above) is confirmed
deferred to its own later phase, deliberately built additive/removable —
new tables, new enrichment source, nothing touching existing schema or
behavior — so a disappointing AS-relationship-inference result (a real
risk with this class of algorithm) can be dropped cleanly without
side effects. Revisit with a stronger model when that phase starts, given
the graph-algorithm complexity. RIPE RIS attribution (item 1) is scoped
to start now — plan below.

### RIPE RIS attribution — implementation plan (2026-08-02, not yet built)

Important framing: this is **not** a new data-ingestion task. `ris-whois-ipv4`
is already an existing, already-running enrichment source in this project
(RISwhois is literally one of RIS's own named data products, per the
boilerplate text below) — this project has been using RIS data without
yet satisfying its attribution condition. The work here is closing that
gap, not adding a source.

**Where attribution has to live**: the customer-facing surface, not this
repo. IP-Insight-Engine's own CLI/admin web panel is an internal operator
tool, not a commercial product RIPE's terms are addressed to — the
obligation attaches to `ipreadout-service`, the paid product that will
actually serve this data to customers. Concretely: the static
"Sources/Transparency" page already planned in `ipreadout-service/PLAN.md`
Section 10, which does not exist as code yet (planning only, per the
project's own "kodlamaya geçme direk" rule).

**Exact required content** (fetched verbatim from RIPE NCC directly, not
paraphrased, so nothing gets lost in translation later):
- Hyperlink to `https://www.ripe.net/ris`.
- The RIPE NCC logo — official asset + usage rules at
  `ripe.net/about-us/press-centre/ripe-ncc-brand-guidelines/` (a real brand
  guidelines PDF + downloadable logo files exist; use the official asset,
  don't recreate one).
- The mandatory boilerplate description, verbatim:
  > "The RIPE Routing Information Service (RIS) is a RIPE NCC service.
  > With the help of network operators all over the world, RIS employs a
  > globally distributed set of Remote Route Collectors (RRCs), typically
  > located at Internet Exchange Points, to collect and store Internet
  > routing data. Volunteers peer with the RRCs using the BGP protocol and
  > RIS stores the update and withdraw messages. RIS data can be accessed
  > via: - RIPEstat, the "one-stop shop" for all available information
  > about Internet number resources. RIPEstat uses individual widgets to
  > display routing and other information; - RIS Live, a real time BGP
  > streaming API allowing server-side filtering of BGP messages by prefix
  > or autonomous system; - RIS Raw Data, available for each route
  > collector, with state dumps and batches of updates made available
  > periodically; - RISwhois, that searches the latest RIS data for
  > details of an IP address using a plaintext "whois"-style interface. It
  > is useful when querying RIS data using scripts."

**Concrete steps, in order**:
1. Download the official logo asset + read the brand guidelines PDF from
   the press-centre link above (confirms sizing/spacing rules — search
   results mention "no maximum size, below 60% scale becomes unreadable"
   but the PDF should be the actual source of truth before use).
2. Accept the RIPE NCC Website/Services Terms of Service on behalf of the
   product (a one-time administrative step, not code).
3. When `ipreadout-service`'s static site gets built, add a
   "Data Sources" page/section containing: the logo (linked to
   `ripe.net/ris`), the boilerplate paragraph verbatim above, alongside
   whatever attribution the project's other sources already require
   (matches the `SOURCES.md` discipline already used in IP-Insight-Engine,
   just surfaced publicly instead of only internally).
4. Until that page exists, don't describe `ip_intel`/the lookup API as a
   finished commercial product anywhere public-facing — the attribution
   condition isn't met yet, so the compliant state today is "not yet
   commercially exposed," which matches where the project already is
   (pre-launch, phone trial only, no paying customers).

No code changes in this repo for this item — the action lives entirely in
`ipreadout-service/PLAN.md`'s Section 10 static-site scope once that
project starts being built.

### ASN-name licensing thread — deliberately deferred (2026-08-02)

This session went deep on one question — "is RIPE's `asn.txt` (the source
of every ASN holder name in this project) actually licensed for commercial
use?" — and the honest answer, after checking every RIR directly, is: not
clearly.

**Full findings, for whoever picks this up next:**
- **RIPE `asn.txt`**: not covered by RIS's favorable commercial-use grant
  (that's a different RIPE service). Governed by RIPE NCC's general
  Copyright Statement (`ripe.net/about-us/legal/copyright-statement/`),
  which frames permitted use as private/non-commercial/research/education/
  demo, with commercial use needing separate written authorisation.
  Unresolved.
- **RIPEstat Data API** (considered as an alternative source for ASN
  names): checked directly, explicitly **worse**, not better — its own
  terms flatly state commercial product use "is not allowed unless
  permission... is granted in writing by the RIPE NCC." Ruled out.
- **Team Cymru's free IP-ASN mapping service**: no formal written terms
  found for the free whois/DNS service specifically (the "Data Services
  Agreement" found is for a separate paid product). Same "no explicit
  grant found" bucket as LACNIC/RADb elsewhere in this document — not
  usable as a confirmed-clean replacement.
- **APNIC's whois/IRR data** (`apnic.db.*.gz`, which is where APNIC-region
  ASN org names live): checked by downloading the actual files —
  **explicitly restricted**. The copyright header is embedded directly in
  the data file itself: "no part of this publication may be reproduced...
  without prior permission of APNIC," and APNIC's own bulk-access page
  confirms "may not be passed on in bulk... unless approved by APNIC."
- **AFRINIC's whois/IRR data** (`afrinic.db.gz`): checked the same way —
  **the most explicit of any RIR checked this session**. Its Terms of Use
  (linked directly from a notice embedded in the data file) state the
  database "is specifically prohibited for... as part of a commercial
  service or product... even if additional data not derived from the
  AFRINIC Whois Database is incorporated therein."
- **LACNIC's whois/IRR data** (`lacnic.db.gz`, already ingested and used
  for this project's LACNIC-region city data — see Layer 2 above): the
  **one exception**. The actual downloaded file carries no restrictive
  header at all (verified directly, unlike APNIC/AFRINIC's files), and
  LACNIC's own IRR page describes an "open mirroring policy." This is
  meaningfully better news for the *existing* city-data feature than for
  the ASN-name question, but still short of an affirmative "yes, commercial
  use is fine" — no LACNIC document says that outright either. Treat as
  "no restriction found," not "confirmed permitted."
- Net: **4 of 5 RIRs** (ARIN's bulk whois is separately approval-gated,
  RIPE/APNIC/AFRINIC all restrict their org-name-bearing whois/IRR data)
  do not offer a clean bulk path to commercial ASN-name data. Building "our
  own aggregator, one clean source per RIR" — the obvious-sounding
  alternative to relying on `asn.txt` — does not actually avoid the
  problem; only LACNIC's slice of global ASN space would be covered.

**Decision: defer entirely, no code changes.** The project is still
pre-launch (phone trial only, no paying customers), so there is no live
compliance exposure today — this only matters once `ipreadout-service`
actually starts selling access. Two candidate fixes were scoped in this
document (asking RIPE/LACNIC directly for written permission, and/or a
slow rate-limited RDAP background warm-up job that never blocks a real
lookup or the periodic enrich cycle) but **neither is being built now**.
Revisit this specifically before `ipreadout-service` takes its first paying
customer, not before. Until then, `asn_name` keeps working exactly as
today — this is a forward-looking compliance item, not a bug.

**Also deferred alongside it, same reason (pre-launch, not urgent)**: the
RIPE RIS attribution static page (logo/link/boilerplate — see above), and
the customer-cone/AS-PATH feature. All three get revisited together,
closer to actual launch, added incrementally as the service needs them —
not built ahead of demand.

### Live RIPE Stat fallback in `lookup.ts` — found and removed (2026-08-03)

While checking whether "sibling ASN clustering" already existed (it didn't
— see below), a much more serious, unrelated thing turned up right next to
it: `getAsnForIp()` in `packages/lookup/src/lookup/lookup.ts` had a live
fallback, `resolveAsnLive()`, calling
`https://stat.ripe.net/data/network-info/data.json` on every lookup whose
IP had no match in the local BGP-origin table. This is RIPEstat — the
exact service checked and ruled out earlier in this document ("Use of the
RIPEstat Service for commercial purposes... is not allowed unless
permission... is granted in writing by the RIPE NCC"). Unlike the
`asn.txt`/IRR licensing questions above, which are about *bulk* data this
project holds locally, this was **live, currently-running code** making
an actual network call to a service whose terms explicitly prohibit
exactly that use — and it directly contradicted this project's own stated
design principle (README/SOURCES.md: "no live third-party API call at
query time"), so it was also an internal inconsistency, not just a
licensing gap.

**Fixed, not just flagged**: removed `resolveAsnLive()` and the
`"ripe-stat"` fallback path entirely. `getAsnForIp()` now returns the same
thing any other "not in this dataset yet" answer in this project returns —
`null` — when the local table has no coverage for an address, instead of
reaching out live. `AsnSource` narrowed from `"bgp-ris" | "ripe-stat"` to
just `"bgp-ris"`. Updated `openapi.yaml`'s `AsnLookupResult.source` enum to
match and re-ran codegen. Real-data verified: `lookup 1.1.1.1` still
resolves normally via the local table (`[bgp-ris]`, unchanged); `lookup
203.0.113.5` (TEST-NET-3, unrouted) now returns `ASN: -` cleanly with no
hang and no outbound call, instead of what would previously have been a
live query. Full `pnpm run typecheck` and `pnpm test` (43/43) clean after.

**Practical impact of the fix, so it's not mistaken for a bigger loss than
it is**: this fallback only ever fired for addresses the local BGP table
(refreshed every `enrich` run, ~daily) had no entry for yet — very
newly-announced prefixes, or genuinely obscure address space. Removing it
means those rare cases return "ASN not found" until the next `enrich` run
catches up, rather than a live-resolved answer — a minor freshness gap,
not a functional regression, and it makes reality match what this
project's own docs already claimed.

No retroactive exposure to worry about: the project has no paying
customers yet (phone trial only), so "RIPEstat's commercial-product ban"
was never actually violated against a real customer — this was a
forward-looking risk closed before it could become a real one, not cleanup
of an incident.

### Sibling-ASN clustering, IPv6 dual-stack detection (2026-08-03)

Checked whether "sibling ASN" detection (grouping multiple ASNs run by the
same operator) already existed before building it — it doesn't; the one
existing hit for "sibling" in the codebase is an unrelated cache-key
comment in `lookup.ts`. Also confirmed `hijack.ts` (`scanHijacks()`,
wired up as `ip-insight hijack-scan`) already covers the earlier-discussed
route-hijack/anomaly-detection idea in full — nothing to build there,
it already exists.

**IPv6 dual-stack — data already existed, display gap fixed.**
`asn_reach.originated_prefixes_v6` was already computed and already
returned by the API (`asn.originated_prefixes_v6`) — it just wasn't shown
anywhere in the CLI's human-readable `lookup` output, only reachable via
`--json`. Added an `IPv6:` line to `apps/cli/src/commands/lookup.ts`.
Verified on real data: `lookup 1.1.1.1` now prints "IPv6: dual-stack —
also announces 3144 IPv6 prefix(es)" for Cloudflare. No new column, no new
source — this was a visibility fix, not a new signal.

**Sibling-ASN clustering — investigated, not shipped.** The obvious naive
approach (group ASNs whose name shares the same first hyphen-delimited
token) was checked against real data before writing any code, the same way
every `connection-type.ts` category was: it fails. Real query over
`asn_blocks`:
```
split_part(name,'-',1) = 'AS'    → 1,118 unrelated ASNs
split_part(name,'-',1) = 'FR'    → 294 unrelated French registrants
split_part(name,'-',1) = 'CITY'  → 134 unrelated municipal networks
```
— country-code and generic-word prefixes (`AS`, `ASN`, `DNIC`, `FR`,
`CITY`, `NET`, `IT`, `RU`, `DE`, `THE`, ...) dominate the naive grouping,
the exact same shape of mistake `federal` and `leo` already taught this
project to check for before shipping, not after. A small number of real
brand groupings did show up cleanly (`COGENT`, `CENTURYLINK`, `CHARTER`,
`EQUINIX`, `YAHOO`, `CHINATELECOM`, `SURFNET`, `ATT`, `DECIX`) but a
trustworthy version of this feature needs a real stoplist or a smarter
match (e.g. requiring a minimum token length plus excluding known
registry-prefix conventions) — a second verification pass, not a one-shot
addition. **Not built. Documented here so the naive approach isn't
tried again without first reading this.**

### SSRF in `geofeedFromRdap` — fixed (2026-08-04)

`packages/lookup/src/lookup/rdap.ts`'s `geofeedFromRdap()` now rejects any
geofeed link that isn't `https:` or that DNS-resolves (every address, not
just the first) to a private/loopback/link-local/CGNAT/multicast/reserved
address, for both IPv4 and IPv6 (including IPv4-mapped IPv6 literals, which
unwrap and get re-checked — otherwise `::ffff:169.254.169.254` would sneak
past as "just an IPv6 address"). The range check lives in a new
`isPubliclyRoutable()` in `packages/shared/src/ip.ts`, backed by `node:net`'s
`BlockList` rather than hand-rolled bit math. Fails closed (returns `null`,
same as the existing fetch-failure path) on rejection — never throws.
Real-data-verified: a fake RDAP object pointing its geofeed link at
`169.254.169.254` (both as a literal and via a DNS hostname resolving to
it) is rejected before any `fetch()` is attempted; 14 new unit tests cover
the boundary cases. **Known residual gap, stated honestly rather than
silently left**: this doesn't pin the later `fetch()` to the exact
validated address, so a TTL=0 adaptive DNS-rebinding attacker isn't fully
closed out — only a static malicious URL (the actual reported shape) is.
Closing that fully would need a custom `undici` dispatcher with a `lookup`
override; `undici` isn't a direct dependency of this repo today, and adding
one solely for this was judged out of scope.

### Bunny.net implemented too (2026-08-04, same day) — the "problem" turned out smaller than it looked

User asked directly what the actual blocker was rather than accepting
"deferred" at face value. Investigated for real instead of guessing:
fetched `bunnycdn.com/api/system/edgeserverlist` (+ `/IPv6`) directly.

**The real finding**: Bunny's feed is a flat JSON array of *bare host
addresses* (`["89.187.188.227", ...]`, 579 of them on the IPv4 endpoint,
316 more on IPv6) — no CIDR prefix at all, unlike every other cloud
source in this codebase. `parseCidr()`, the validity gate every other
`ingest*` function in `enrichment.ts` uses, requires a `/` and returns
`null` without one — reusing it unmodified against this feed would have
silently skipped **100% of rows**, a job that reports `completed` while
ingesting nothing. That's the actual "problem" — not a hard architectural
blocker, a specific validation-function mismatch that would have been a
real, quiet bug if this feed had been wired up by copy-pasting an
existing parser without checking the fetched shape first.

**Fix, once identified, was small**: a new `ingestBunnyCdnJson`
(`enrichment.ts`) validates with `isIP()` instead of `parseCidr()`, then
stores each address as its own `/32` (IPv4) or `/128` (IPv6) — the
natural CIDR form of a single host, so nothing downstream (lookup,
`ip_intel`, the `.mmdb` export) needs to know this source is host-granular
rather than block-granular. Two source entries (`bunny-cdn-v4`/`-v6`,
mirroring the existing `cloudflare-v4`/`-v6` split-by-family pattern
exactly) reuse one parser.

**Verified for real**: 579 + 316 = 895 ingested, 0 skipped. A real lookup
on one of the ingested IPv4 addresses (`89.187.188.227`) came back
`cloud_provider: "bunny"`, `usage_type: "hosting"`. `pnpm run typecheck`
and the full `vitest run` (9 files, 70 tests) both green afterward.

`pnpm run typecheck` and the full `vitest run` (9 files, 70 tests) both
green after all of the above. Sandbox Postgres died and was restarted
twice during this session (same known instability, `pg_ctlcluster 16 main
start` after a stale pidfile both times) — data confirmed intact each
time, nothing lost.

### Orange Luxembourg + Yandex Cloud CDN removed after a deep commercial-terms review (2026-08-05)

Explicit user instruction, before deploying today's additions to the
phone: research whether the licenses actually permit commercial use — not
"does the file exist," a real terms-of-use check per source, the same
rigor that already found Netflix's real restriction and (earlier today)
SSLBL's dead-feed problem. Full per-source findings are in SOURCES.md's
"Deep commercial-terms check" note; summarized here for the decision
record.

**5 of 7 cleared outright** — GTT, Charter/Spectrum, Zayo, and Fastly's
geofeed all publish an AUP scoped to network customers/peers, never
addressing a third party consuming the published data file; Bunny.net's
ToS never mentions its edge-server-list endpoint and Bunny's own docs
describe the endpoint's purpose as third-party consumption. Charter's
linked "SFI Policy" PDF was specifically opened and read (an
ISP-interconnection/peering policy, unrelated to the geofeed) rather than
left as an unopened link that might have hidden something. Fastly's
site-wide ToS does carry a real restriction on IP geolocation data —
confirmed, on reading it, to govern a *different* Fastly product (inbound
visitor geolocation, licensed from Digital Element/NetAcuity) than the
self-published outbound geofeed this project ingests; the two are
opposite data directions, easy to conflate, confirmed distinct rather
than assumed. All 5 kept.

**2 of 7 removed, on the user's explicit call, not a rejection of the
data's legality:**
- **Orange Luxembourg** — no restriction actually found, but two loose
  ends that didn't resolve cleanly: `robots.txt` disallows crawling the
  whole site (a crawl directive, not a license, and arguably moot for a
  direct known-URL fetch — but a real signal nonetheless), and the site's
  general "no reproduction without written authorisation" clause has
  genuinely unclear applicability to a dedicated, CORS-open RFC 8805 data
  subdomain. Combined with the source's low value even if resolved (a
  small subsidiary, a handful of rows, and already blocked in this
  sandbox by an unrelated proxy issue), the user's call was to skip
  resolving the ambiguity for a source this small.
- **Yandex Cloud CDN** — no license restriction on the data at all; the
  reason for removal is a different axis entirely. Yandex Cloud's own
  terms of use show a Serbia-registered contracting shell ("Iron Hive doo
  Beograd") with underlying infrastructure explicitly run by
  "Yandex.Cloud LLC... based in the Russian Federation" — the
  Russian-consortium-retained half of the 2024 Yandex/Nebius split, not
  the now-Amsterdam-listed successor. This is a business/compliance
  question about depending on Russian-Federation-operated infrastructure,
  not a copyright question — outside what this project can clear on any
  given deployment's behalf, and the value was small regardless (93 rows,
  CDN edge only). User's call was to skip it.

**What actually changed in code**: `orange-lu-geofeed` and
`yandex-cdn-ip-ranges` removed from `sources-registry.ts` and
`enrichment-sources.ts` (with comments pointing here and to SOURCES.md,
not silently deleted), the now-unused `yandex-cdn-json` parser type and
`ingestYandexCdnJson()` function removed from `enrichment.ts` entirely,
and this sandbox's 93 already-ingested Yandex `cloud_ranges` test rows
deleted for consistency (the real phone deployment never ingested either
of these — both were sandbox-only, never shipped). `pnpm run typecheck`
green afterward.

**Both are reversible, not permanently closed**: recorded in SOURCES.md's
"Deliberately not included" list specifically so a future deployment with
different context (resolved Orange Luxembourg ambiguity, or a
deployment for which the Yandex jurisdictional question doesn't apply)
can revisit either one without re-deriving this research from scratch.

**What ships to the phone now, from today's session**: Task #40 (mmdb
field-completeness check), Task #41 (`asn_profile` via CLI/API), 4 new
RFC 8805 geofeeds (GTT, Charter/Spectrum, Fastly, Zayo-EU), and Bunny.net
— all commercial-terms-cleared, all real-data-verified. Ready to zip
whenever the user wants it.

### RDAP made quota-resilient, and `network_name` finally filled (2026-08-05)

Started from a real observation, not a hypothetical: a `lookup` on
`149.112.112.112` (Quad9) returned `network_name: "QUAD9-AS-1 - Quad9,
US"`, while ARIN's own RDAP record for that block says
`PCH-PUBLIC-RESOLVER`. Chasing that turned up two separate real problems
and one architectural worry worth writing down properly.

**Finding 1: `ip_blocks.network_name` has always been null on every row.**
Not "sparse" as this file's own older comment claimed — literally
`654,878 total, 0 non-null`, verified by query. The reason is structural:
the RIR delegated-extended statistics files carry country/type/start/
count/date/status and **no name field at all**, so nothing has ever been
able to populate that column. `lookup.ts` read it, always got null, and
silently fell through to the ASN org name — which answers a different
question and was already being returned verbatim as `asn.name` in the same
response. The "network name" was a duplicate of the ASN name for every
lookup this project has ever served.

**Finding 2: geofeed discovery had no staleness refresh at all.** The
abuse contact has had one since it was written (`abuseContactMaxAgeDays`,
with a good comment explaining why it matters). Geofeed discovery's
condition was just `!geofeedRow` — so the first geofeed ever discovered
for a prefix was the only one it would ever serve, permanently, and an
operator republishing a corrected feed would never be observed. Same class
of bug the abuse-contact TTL was written to prevent, in the function
directly beside it.

**The worry, and what was actually done about it.** The user's concern was
sharper than "is RDAP allowed": if live queries are rate-limited, coverage
becomes *uneven* — big well-known networks are fine (they publish their
own geofeeds and cloud ranges, all bulk-ingested), while small and
obscure networks, which have no bulk source at all, are exactly the ones
that need RDAP and exactly the ones that lose out when quota runs dry.
That is a real and correct diagnosis: turning RDAP off entirely would not
"lose a little data", it would lose data *precisely where this project has
no alternative source*, while the well-covered networks stayed fine.

Before designing around it, the bulk alternatives were re-checked at each
registry rather than assumed from this file's own earlier notes — results
now in SOURCES.md's "RDAP-based live discovery" table. Short version: ARIN
has no free bulk product, RIPE/APNIC's dumps are contractually closed to a
commercial product (this project already moved *off* them for that
reason), AFRINIC's require approval and forbid redistribution outright,
and LACNIC's — the one already ingested — was opened and had every field
enumerated: `aut-num, city, country, created, inetnum, remarks, source,
status`, i.e. it does not contain names or contacts at all. There is no
bulk path being neglected here.

**So: keep RDAP, make it not be the fragile part.** Four changes:

1. **Route each query to the registry that actually holds the address.**
   `rdap.ts` had a single hardcoded RIPE entry point and relied on RDAP
   redirects for everything else — correct, but it spent RIPE's quota on
   ARIN/APNIC/LACNIC/AFRINIC space. Now each RIR's own endpoint is used,
   selected from the `rir` already read from `ip_blocks` (so routing is
   free). All five endpoints were confirmed live against a real address in
   their own space before being wired up — note the URL *paths* differ per
   registry, this is not a hostname swap. Effect: five independent
   allowances instead of one shared one.
2. **A self-imposed per-registry budget** (`rdapDailyQueryCap`, default
   800 per registry per rolling 24h). Refuses a query *before* making it
   once spent, so the limit that bites is this project's own — degrading
   exactly like an existing timeout does (cached data or nothing, never an
   error) — rather than a RIR blocking the host and coverage silently
   collapsing. `0` disables live RDAP entirely, for a deployment wanting
   zero request-time third-party dependency.
3. **The missing geofeed TTL** (`geofeedDiscoveryMaxAgeDays`, default 30,
   matching the abuse contact's). Deliberately scoped to rows this path
   owns: a geofeed row published by a *bulk* source (Cogent, Charter,
   Google…) is re-ingested by `enrich`, so re-fetching it live would spend
   budget re-deriving data a cheaper path already keeps current.
4. **`network_names`, a new table, filled as a by-product.** The name is
   read off the RDAP response abuse/geofeed *already fetched* — never a
   reason to fetch one, so it costs zero additional queries. It needed its
   own table rather than backfilling `ip_blocks.network_name` because
   `collect` deletes and rewrites `ip_blocks` wholesale every run.

**Two bugs found in this work, by testing rather than review**, both worth
recording since both were mine:
- `cap: 0` would still have allowed the first query through, because the
  window-reset branch ran before the cap check. Fixed; the "refuses every
  query at cap 0, including the very first" test exists specifically to
  pin it.
- The network name was initially read from the cache only — but the cache
  is read in the parallel block *above* the RDAP call, so a prefix's first
  lookup would have shown the old ASN-name fallback and only self-corrected
  on the second. Fixed to prefer the freshly-fetched value, matching what
  the abuse contact beside it already did.

**Verified against real registries, not mocks:**
```
ARIN     8.8.8.8       -> name="GOGL"           cidr=8.8.8.0/24
RIPENCC  193.0.6.139   -> name="RIPE-NCC"       cidr=193.0.0.0/21
APNIC    1.1.1.1       -> name="APNIC-LABS"     cidr=1.1.1.0/24
LACNIC   200.3.14.1    -> name="200.3.12.0 - 200.3.15.255"
AFRINIC  196.10.0.1    -> name="ORG-MCDS1-AFRINIC"
```
and end to end through the CLI: `lookup 149.112.112.112` now returns
`network_name: "PCH-PUBLIC-RESOLVER"` — matching ARIN's own record — on
the *first* lookup; a second address in the same /24 from a fresh process
is answered from `network_names` with no RDAP call; `193.0.6.139` returns
`RIPE-NCC`. LACNIC's range-as-name is correctly rejected (no junk row
written, response falls through to the ASN name), which is what that
filter exists for.

`pnpm run typecheck` clean; full suite 74 tests / 10 files green,
including 4 new ones covering the budget — most importantly that
exhausting one registry leaves the other four untouched, which is the
entire point of change #1.

**Needs a schema push on the phone** (`pnpm --filter @workspace/db run
push`) for the new `network_names` table — the only piece of today's work
that isn't code-only.

### `usage_type` "hosting" default replaced with honest null; ~14pt drop in unclassified ASNs (2026-08-05)

Started from a real observation, same as the RDAP work above: a `lookup`
on `88.244.230.253` (the founder's own home TTNet wifi connection) came
back `usage_type: "hosting"`, and `risk.reasons` carried a "datacenter"
entry — for a residential DSL/fiber line, tested from the phone that was
actually on it.

**Root cause was structural, not a missing pattern.** `classifier.ts` had
*two* separate places that turned "no pattern matched this ASN name" into
a confidently-labelled `"hosting"`: `ASN_TO_USAGE.other` (step 4, the
primary path — runs before anything else gets a chance) and a step-6
"final fallback" that did the same thing redundantly. Both were reasoned
as a "conservative default", commented as such in the code. Measured
against this project's own top 3000 ASNs by announced address space
(`asn_reach.originatedAddresses`, i.e. weighted by real query volume
rather than a flat random sample of every ASN including obscure ones):
**48.3%** fell through with no pattern match, and every one of them was
being called "hosting" — China Telecom, Korea Telecom, BT, Rostelecom,
Turk Telekom, Turkcell, MTN, and most of the world's carriers whose names
don't happen to match an English/Western brand pattern. Not conservative;
a specific wrong answer asserted with confidence, on nearly half of major
world ASNs, feeding straight into `risk.ts`'s datacenter flag.

Initial instinct was to just make the two null sites return null and
broaden the PTR pattern. Pushed back on directly: converting "hosting" to
null everywhere doesn't fix an inconsistency, it just changes what's
inconsistent, and the request was explicit that this needed to be a real,
comprehensive fix — checked for the same failure pattern elsewhere in the
codebase, not just patched at the two sites already found. That's what
led to actually measuring the 48.3% figure above instead of assuming the
size of the problem, and to re-checking `ASN_TO_USAGE` a second time
(where the *bigger* half of the bug was hiding, in step 4, not the step-6
fallback that looked like the obvious culprit).

**Fix, in two parts:**

1. **`asn-types.ts`'s pattern set broadened, each addition verified
   against real data before shipping** — same discipline
   `connection-type.ts` already established (see its header comment) and
   the same discipline the RDAP work above used:
   - An unbounded `tele[ck]om` substring (no leading `\b`, so it catches
     mid-word fusions like "Rostelecom" and suffix variants like
     "Telekomunikasyon"/"Telecomunicaciones"/"Telecomunicações" in one
     pattern instead of an enumerated list per language). Checked for
     false positives explicitly, per a direct request to look for exactly
     this risk: all 213 matches in the top-3000 sample were read by hand,
     not sampled — 207 genuine telecom operators (97.2% precision), 6
     false positives, all one identifiable class (a state/university
     *telecom department*, not an access ISP — "Florida ... Division of
     Telecommunications", "Indiana Higher Education Telecommunication
     System") plus one accepted rare miss (the UN's International
     Telecommunication Union, not chased further — matches
     `connection-type.ts`'s own precedent of rejecting an over-broad
     `federal` keyword after finding it false-positived on US credit
     unions and Brazilian universities).
   - A government/education carve-out rule (`department|division|
     higher\s*education|state\s*of`) placed *ahead* of the telecom rule so
     it intercepts exactly that false-positive class first. Independently
     verified against the same sample: 98 matches, 100% genuine government
     agencies (dozens of US DoD `DNIC-AS*` blocks, ~15 US state
     governments, Australian/Canadian/Chinese/Vietnamese departments),
     zero false positives.
   - `comunicac` — the Portuguese/Spanish equivalent of the existing
     `communications` keyword, and the actual regulatory term ("Serviço
     de Comunicação Multimídia") Brazil uses for an ISP license. Checked
     against the *full* `asn_blocks.name` column, not just the sample:
     657 matches not already covered by the telecom rule, all small/
     regional Latin American ISPs, zero false positives.
   - Ten named brand exceptions for major carriers whose name carries no
     generic telecom keyword at all (Turkcell, MTN, Telia, Vimpelcom/
     Beeline's many Russian subsidiary AS names, CANTV, Comcel, Telconet,
     ETB, VTR, Wana). Each checked individually against the full
     `asn_blocks.name` column for collisions before being added — this is
     what caught three that looked safe but weren't: `elisa` (Elisa Oyj,
     Finland) collides with the first name "Elisa" on unrelated small
     registrations; `tdc` (TDC Holding, Denmark) collides with a New
     Zealand district council and an unrelated US payments company;
     `beeline` collides with the Beeline vendor-management-software
     company, unrelated to Beeline the Vimpelcom mobile brand. All three
     left out.
   - The removed bare `telekom` keyword from the mobile pattern (it
     matched Deutsche Telekom's *and* Turk Telekom's names alike — the
     former is mobile, the latter is fixed-line/DSL and was being
     misclassified as a mobile carrier; Deutsche Telekom's actual mobile
     arm stays covered by the existing `t-mobile` pattern).

   Net effect on the same top-3000 sample: unclassified ("other") ASNs
   dropped from 48.3% to 33.9%.

2. **The two null-forcing sites actually made to return null**, once the
   pattern coverage above meant they'd be hit far less often:
   `ASN_TO_USAGE`'s `other` entry removed entirely (step 4 now
   contributes nothing when `classifyAsnName` returns "other", instead of
   mapping it to "hosting"), and the step-6 fallback block removed and
   replaced with a comment explaining why, citing the measurement above.
   `ClassificationResult.usageType`'s type changed to `UsageType | null`
   to match. `reverseDnsSignal`'s residential pattern broadened to include
   `dynamic|dyn|pppoe|cpe|dhcp|client|customer|home` — this is what
   actually classifies the triggering address correctly, since its ASN
   name (TTNet) still isn't caught by any name pattern but its PTR
   (`...dynamic.ttnet.com.tr`) now is. The CLI's usage-type display line
   was made null-safe (`?? "unknown"`); `Lookup.tsx` and the DB schema
   were already null-safe and needed no change.

**Verified end to end against the real triggering address:**
```
lookup 88.244.230.253 --json
  usage_type: "residential"        (was "hosting")
  usage_type_flags.hosting: false  (was true)
  risk.score: 0, risk.reasons: []  (was inflated by the "datacenter" reason)
```
`pnpm run typecheck` clean; full suite 74 tests / 10 files green (no test
changes needed — none had encoded the old "other → hosting" behavior as
an assertion). All temporary audit scripts (`apps/cli/audit-*.ts`, used to
run the pattern-precision checks against the real database) deleted after
use, per the project's normal practice — nothing about this fix is
one-shot code that needs to stay.

Not chased further, deliberately: the remaining 33.9% "other" in the
top-3000 sample is real, but each further pattern is a new precision
audit against real data (as the ones above were), not a quick add — the
same reasoning `connection-type.ts`'s rejected `federal` keyword and this
fix's own `elisa`/`tdc`/`beeline` near-misses already demonstrate. Revisit
if a specific missed operator surfaces again, the same way this whole fix
started from one real address.

### Regional coverage audit — geofeed and ASN classification broken down by RIR (2026-08-05, same day)

Prompted by a direct question, worth recording in its own words because
the answer mattered more than the framing: if this project is meant to be
used everywhere, by everyone, the way a general-purpose service is — what
happens if data quality quietly tracks "where the operator is based"
instead of being consistent worldwide? Concretely: someone in Europe
building a product that expands into Africa needs the African data to be
as trustworthy as the European data, not a second-class version of it.
That can't be answered by intuition, only by measuring — the same
discipline the `usage_type` fix above used, applied one level up: not
"did we fix the bug we found" but "is there a *regional* pattern in what's
still broken".

**Method.** RIR (ARIN/RIPENCC/APNIC/LACNIC/AFRINIC) as a region proxy,
since it's already a column on every relevant table and each RIR's
service region is a real geographic bloc (ARIN: North America, RIPENCC:
Europe + Middle East + Central Asia, APNIC: Asia-Pacific, LACNIC: Latin
America + Caribbean, AFRINIC: Africa). Two independent measurements:
geofeed coverage (Layer 2, precise city-level data) and ASN-name
classification's unclassified rate (the `usage_type` work above).

**Geofeed coverage, measured two ways to cross-check.** A naive per-row
correlated-EXISTS spatial join (654k `ip_blocks` rows × GiST lookups into
1.19M `geofeed_ranges` rows) timed out past two minutes — abandoned in
favor of aggregating each table independently by country and joining on a
small country→primary-RIR lookup table, which runs in single-digit
seconds. Address-space-weighted and row-count views agreed on the
direction even though the address-space number for LACNIC came out over
100% (a country→RIR mapping artifact — some countries have blocks under
more than one RIR historically, so the weighted sum isn't exact — noted
rather than silently trusted). Row counts, less sensitive to that
artifact: **AFRINIC 939 geofeed rows across 55 countries; ARIN ~599,000
rows across 22 countries.** Publisher-source counts were similar across
all five RIRs (8-15 each) — this is not a gap in which publishers this
project ingests, it's that RFC 8805 geofeed self-publishing is simply far
less common among African network operators today. Not fixable by
ingesting harder; there's no bulk alternative here any more than there
was in the RDAP work two sections up. Already handled honestly, not
silently: an address with no geofeed already falls back to
`geo_source: "country-estimate"` rather than fabricating a city. Written
up in SOURCES.md's Layer 2 section so it's a stated fact of the product,
not a gap someone has to rediscover by noticing thin coverage in the wild.

**ASN classification, where the finding cut against the intuition that
started this whole audit.** Broke the top-8000-by-announced-address-space
sample (same traffic-weighting used for the `usage_type` fix) down by
RIR: AFRINIC's unclassified rate was **25.8%** — the *lowest* of all five,
not the highest. LACNIC came in worst at **57.5%**, RIPENCC second-worst
at **45.0%**. Reading a sample of what LACNIC/RIPENCC were actually
missing (not guessing) showed the cause wasn't missing brand names — it
was missing generic *non-English words* the pattern set only had in
English:
- `\bmovil\b` (Spanish "móvil"/mobile) and `telefon` (Spanish/Portuguese
  "teléfono"/telephone, the root behind the already-listed "Telefónica"
  brand but not the many independent phone cooperatives that also use the
  word) — 6 and 162 real matches in the full `asn_blocks` table, zero
  false positives.
- `universit(a|á|à)` and `universitaet` (Spanish "universidad"/
  "universitaria", Italian "università", German "Universität") — the
  bare English "university" pattern already existed but only for English.
  This is the exact class of gap `connection-type.ts` already found and
  fixed for its own purposes (its header comment records rejecting a
  university-only-in-English pattern for the same reason) — `asn-types.ts`
  had simply never had the same pass done to it. 84 + 23 real matches
  across Latin American university-affiliated networks (many of them
  literally named "Corporación/Fundación/Institución Universitaria ...")
  and German academic networks, zero false positives.
- `iletisim` (Turkish "iletişim"/communications) — RIPENCC's region
  includes Turkey, and Turkish ISP/telecom legal names standardly end in
  "... İletişim Hizmetleri A.Ş." the way Brazilian ones end in "...
  Comunicação Multimídia Ltda" (the `comunicac` fix from the section
  above). 114 real matches, zero false positives — directly relevant
  given this project's own home-connection test case earlier today was a
  Turkish ISP.
- Five more named brands verified the same way as the ones already listed
  above (`tele2`, `telenet`, `telmex`, `entel`, `altice`) — `telmex`
  alone (América Móvil's Mexican fixed-line brand) accounted for 11 real
  matches across six countries and had somehow been missed entirely
  despite being one of Latin America's largest carriers. `entel` is a
  disclosed single exception to the zero-collision bar used everywhere
  else in this file: 8 of 9 matches were genuine Entel (Chile/Peru)
  entities, the 9th an unrelated Serbian engineering firm
  ("Energoprojekt ENTEL a.d. Beograd") — kept anyway, the same call as
  `tele[ck]om`'s already-accepted ITU miss, because correctly labelling a
  top-tier Chilean carrier across many AS entries outweighs one
  low-severity mislabel (ISP instead of enterprise, not something wildly
  wrong like a hospital or bank).
- Two plain regex bugs, not new keywords: `holdings`/`enterprise`/
  `communications`/`data center` were each written matching only one
  grammatical number, so "Holding" (singular), "Enterprises" (plural),
  "Communication" (singular), and "Data Centers" (plural) were all
  silently missed by patterns that only listed the other form. Found via
  a real example each ("Liberty Global Europe Holding B.V.", "Equinix
  ... Acquisition Enterprises B.V.", "Cellcom Fixed Line Communication
  L.P", "Scala Data Centers").

Net effect on the same top-8000 sample: LACNIC 57.5% → 50.2%, RIPENCC
45.0% → 43.5%. Smaller than the first pass's 14-point drop, and worth
being honest about why: most of the full-table match counts above
(162/114/231) are small regional operators that don't carry much
announced address space individually, so they barely move a
traffic-weighted top-8000 metric even though they're now classified
correctly. That's not the audit failing — a metric that only rewards
fixing the biggest carriers would itself be a bias worth naming, and was
exactly what this pass was checking for.

**A bug in this fix, caught by testing rather than assumed safe.** The
first version of the `universidad`/`universitaria` pattern only covered
the `-t-` root (`universit(a|á|à)|universitaet`) and was verified against
84+23 real "Universitaria"/"Universität" matches, which all looked
genuine — easy to call it done there. A direct sanity check against
"Universidad Nacional Autónoma de México" (one of Latin America's
best-known universities, picked specifically because if any name should
be caught by a university pattern it's this one) still came back "other".
Cause: plain Spanish "Universidad" has no "t" in it at all — spelled
U-n-i-v-e-r-s-i-**d**-a-d, not the "-t-" root at all, a different word from
"Universitaria"/"Universitario" that only happens to share a prefix.
Fixed by adding `universidad` (which, as a 11-character prefix, also
covers the Portuguese "-e" spelling "universidade" for free) as a second,
independent alternative — 231 real matches in the full table once added,
zero false positives, and this is what accounts for most of LACNIC's
extra 5-point drop above the number first measured. Recorded here for the
same reason the RDAP `cap: 0` bug was recorded in the section above: an
audit that stops at "the sample I checked looks right" instead of
deliberately probing the most obvious real-world case would have shipped
this with the gap still open.

`pnpm run typecheck` clean; full suite still 74/74. All temporary audit
scripts deleted after use, same as every other measurement in this file.

**Bottom line for whoever reads this next:** two different kinds of
regional gap exist in this project, and they need different responses.
Geofeed sparsity in AFRINIC's region is a real-world data-availability gap
this project cannot code its way out of — the honest response is
transparency (`country-estimate`, documented plainly) not a workaround.
ASN-classification misses in LACNIC/RIPENCC were a *pattern-set* gap this
project's own code created by only handling telecom terminology in
English — that one *was* fixable, and the fix (adding the missing
language, not adding an exhaustive brand list) is the same shape as every
other fix in this file: verify against real data before shipping, verify
precision not just recall, and disclose what's still imperfect rather
than claiming completeness.
