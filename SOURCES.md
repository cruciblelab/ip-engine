# Data Sources & Technologies

IP-Insight-Engine is a self-hosted IP intelligence database. Every signal it
serves is built from free, bulk-downloadable public data, ingested and
indexed locally — there is no live third-party API call at query time. This
document lists every upstream source and the technology used to consume it,
so the project (or its database file) can be understood, audited, and run
independently by anyone.

## Design principle

Each layer below adds a distinct, independently-verifiable signal. Lower
layers are cheap/universal but coarse (country-level); higher layers are
precise but only available for the address space that publishes them. The
lookup path always prefers the most precise available layer and is honest
about which layer answered — it never fills a gap with a guess dressed up
as a fact.

## Layer 1 — RIR allocation + BGP origin ASN

- **Regional Internet Registry (RIR) delegated-extended files** — the five
  RIRs (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC) jointly publish daily
  "who holds this block, in which country, since when" records for all
  allocated IPv4/IPv6 space. Free, bulk, no auth. This is the base
  `ip_blocks` table.
- **RIPE RIS whois dumps** (`riswhoisdump.IPv4.gz` / `.IPv6.gz`) —
  real BGP tables aggregated from RIPE's Routing Information Service route
  collectors, published daily. Maps every announced prefix to its observed
  origin ASN. Used instead of a live per-request ASN API (e.g. RIPEstat)
  so resolution is uniform and doesn't depend on which ASNs happen to be
  cached/popular on a third party's service. Populates `bgp_origin_ranges`.
- **RIPE NCC `asn.txt`** — global ASN number → holder name list, for
  human-readable ASN names.

## Layer 2 — Geofeeds (operator-published location)

- **RFC 8805 geofeeds** — the standard format operators use to
  self-publish which city/region a prefix is actually used in. Far more
  trustworthy than inferring a city from the registration country, because
  it comes from the network operator itself.
- **RFC 9092 geofeed discovery** — rather than hand-adding feeds one at a
  time, a prefix's `geofeed:` reference is discovered live via RDAP the
  first time a lookup needs it (a cache miss on `geofeed_ranges`), then
  cached so no later lookup for the same prefix repeats the discovery. This
  used to run as a batch scan of RIPE/APNIC's bulk whois dumps instead;
  that scan found ~3,600 feeds in one run (RIPE ~3,066, APNIC ~542) but
  meant bulk-downloading and redistributing whois data whose terms don't
  clearly permit that for a commercial product (RIPE Database T&C Art.
  4.5 — see "Commercial use" below), so it was replaced with the live,
  per-address lookup instead. RDAP's `geofeed1` extension surfaces the same
  reference the old scan found (a `links` entry with `rel: "geofeed"`),
  verified against real data: querying RDAP for a prefix already known (from
  the retired bulk scan) to publish a geofeed returns the identical CSV URL.
  This is also the only source of **postal codes** in the project — RFC
  8805 carries them and nothing else here does.
  A feed is only trusted for the address range the RDAP object itself
  describes. RFC 9092 permits a publisher to describe only their own space,
  and enforcing that is what stops one operator's feed claiming another's
  prefixes.
  Worth calibrating expectations against: the historical batch scan
  measured coverage of announced IPv4 prefixes with a real operator-
  published city at 15.1% (up from 13.5% before discovery existed at all).
  The live/on-demand version covers exactly what's actually been looked
  up rather than the whole address space proactively — coverage grows with
  real query traffic instead of being front-loaded by a scan, and the
  remaining gap either way is where commercial providers use crowdsourced
  measurement infrastructure this project has no equivalent of.
- **Regional coverage is real-world uneven, and worth stating plainly rather
  than leaving implicit.** Checked directly (2026-08-05), because "coverage
  looks fine overall" can still mean "fine for well-published regions,
  thin for others": grouping `geofeed_ranges` by RIR (AFRINIC/APNIC/ARIN/
  LACNIC/RIPENCC, as a region proxy), AFRINIC-registered space carries only
  939 geofeed rows across 55 different countries — against ARIN's ~599,000
  rows across just 22. Same publisher-count range per RIR (8-15), so this
  isn't a gap in which publishers get ingested; it's that RFC 8805
  publishing itself is far less common among African network operators
  today than American, European, or large Latin American ones. Not
  something this project can fix by ingesting harder — there is no bulk
  alternative for African geolocation any more than there was for the RDAP
  gap discussed below. What the project *can* and does do about it: never
  paper over the gap with a guess. An address with no geofeed falls back
  to `geo_source: "country-estimate"`, honestly, rather than a fabricated
  city — the same contract `usage_type`/`connection_type` follow elsewhere
  in this file. A consumer building a product for an African market should
  read that field and budget for coarser precision there, not assume city-
  level accuracy on parity with a European or North American address.
- **LACNIC bulk whois dump** (`lacnic.db.gz`) — uniquely among the five
  RIRs, LACNIC's bulk whois carries a structured `city:` field directly on
  `inetnum`/`inet6num` records (not present in RIPE's privacy-stripped bulk
  dump, and only free-text in APNIC's `descr:`). Parsed directly — no
  scraping, no live queries. Encoding note: this file is ISO-8859-1
  (Latin-1), not UTF-8 (confirmed by inspecting raw bytes of accented city
  names). City names from this source are resolved to coordinates via the
  GeoNames gazetteer (Layer 3).
- **Direct-URL RFC 8805 geofeeds** — a batch of large network operators
  publish their geofeed at a fixed, publicly-known address rather than one
  a RIR points at: Google Cloud, NTT (AS2914), Cogent (AS174), Verizon,
  T-Mobile US (AS21928), Netflix, Vultr/Constant.com (AS20473), Civo,
  Schwarz IT, Telia Sweden (AS3301), GTT (AS3257), Charter/Spectrum, and
  Fastly (a second, distinct feed from the same operator as its Layer 4
  cloud-range entry below — one file for CDN detection, a separate one for
  location), plus Zayo (European operating companies only, not Zayo
  globally). Fetched and ingested exactly like DigitalOcean's own geofeed
  above — one HTTP GET, no RIR involved at any point, so no rate limit and
  no redistribution-terms question to reason about. Verified against real
  ingestion: the original ten sources totalled 174,025 rows (Cogent and
  Verizon the bulk of it); the four added 2026-08-04 totalled 495,905 more
  (Charter alone — 428,990 — dwarfs the rest: GTT 50,907, Fastly 15,972,
  Zayo 16). A handful of other often-cited publishers (F5, Telstra,
  Cloudflare, AWS, Azure) were checked and *not* added: no fixed URL could
  be confirmed for them, see the "RDAP-based live discovery" note below
  for why the long tail of smaller operators can't be covered this same
  way.

  **Deep commercial-terms check, deliberately separate from the "does the
  file exist" check above (2026-08-05).** Prompted by this deployment
  being genuinely commercial: checking that a file is public isn't the
  same question as checking whether its operator said anything, anywhere,
  restricting commercial use of it — the same gap that would have missed
  Netflix's real restriction if that source had only been "file exists,
  ingest it" checked. Seven round-2 candidates were checked individually
  at their own terms-of-use/AUP/legal pages, not assumed from the RFC
  8805 "self-published for consumption" reasoning alone — five cleared
  and are the sources listed above (plus Bunny.net, Layer 4), two did
  not:
  - **GTT, Charter/Spectrum, Zayo**: each publishes an Acceptable Use
    Policy, but every one of them is explicitly scoped to *network
    customers/peers* ("clients who use the Service", ISP interconnection
    procedures) — none addresses a third party consuming the published
    geofeed file at all. Charter's linked PDF ("Charter SFI Policy") was
    specifically checked in full rather than left as an unopened link: it
    turned out to be an IP-interconnection/peering policy for other ISPs,
    unrelated to the geofeed. Silent, same footing as the original ten
    geofeeds. Cleared.
  - **Fastly**: found a real, quotable restriction — *"IP geolocation
    information... is intended to be used only in connection with your
    Fastly services"* — but confirmed it governs a different Fastly
    product (inbound visitor geolocation, licensed from Digital
    Element/NetAcuity, the opposite data direction) from
    `ip-geolocation.fastly.com`, which is Fastly self-publishing *its
    own* IP space for others to ingest. Confirmed distinct, not assumed;
    silent on the geofeed itself. Cleared.
  - **Bunny.net** (Layer 4): ToS makes no mention of the edge-server-list
    endpoint; Bunny's own support docs independently describe the
    endpoint's purpose as third-party consumption (firewall/allowlist
    configuration by anyone running behind Bunny) — silent, same
    "published to be consumed" reasoning as the cloud-range sources
    above. Cleared.
  - **Orange Luxembourg — checked, deliberately NOT added.**
    `resources.orange.lu/robots.txt` disallows crawling everything except
    the bare root (`Disallow: /`) — a real finding, though a
    crawler-politeness directive rather than a license, and arguably moot
    for a direct known-URL fetch rather than a crawl (the file is also
    served with `Access-Control-Allow-Origin: *`, suggesting deliberate
    machine-consumption intent). Separately, orange.lu's general site
    terms carry a standard marketing-copy clause — *"Any reproduction or
    representation... is prohibited without prior written authorisation
    from Orange"* — whose applicability to a dedicated, CORS-open RFC
    8805 data subdomain is genuinely unclear, not clearly in- or
    out-of-scope. Combined with its low value even if it worked (a small
    subsidiary, few rows, and this project's own sandbox couldn't reach
    it through its outbound proxy anyway — `upstream connect error...
    Connection reset by peer`, an Envoy-level TLS handshake failure
    specific to that one host, not a problem with the source), the
    operator's call was to skip it rather than resolve the ambiguity for
    a source this small. Revisit if it becomes worth resolving.
  - **Yandex Cloud CDN (Layer 4) — checked, deliberately NOT added.** No
    license restriction found on the data itself, but a real, separate
    jurisdictional consideration: the contracting entity in Yandex
    Cloud's own terms of use is a Serbia-registered shell (*"Iron Hive
    doo Beograd"*) with underlying infrastructure explicitly run by
    *"Yandex.Cloud LLC... based in the Russian Federation"* — this is the
    Russian-consortium-retained "Yandex Cloud" post the 2024 Nebius
    split, not the now-Amsterdam-listed successor. A commercial
    deployment depending on continuous access to Russian-Federation-
    operated infrastructure is a business/compliance question, not a
    copyright one — this project can verify the license is silent, but
    not that the dependency itself is acceptable for any given
    deployment's regulatory exposure, and the value here was small
    regardless (93 rows, CDN edge only). Operator's call was to skip it.
    Revisit if a deployment's own context clears this.

## Layer 3 — Geocoding (city name → coordinates)

- **GeoNames** (`cities5000.zip`, CC BY 4.0 license) — a free geographical
  database of ~25 million place names, covering every populated place
  above ~500 population plus all administrative capitals, maintained by
  Marc Wick / Unxos GmbH since 2005 and itself built by aggregating
  official government gazetteers, postal databases, and other public
  geo-data worldwide. Downloaded once as a static bulk file and kept
  entirely local — never queried live. Used only to turn a city *name*
  (from LACNIC's `city:` field today) into real latitude/longitude and
  admin1/admin2 codes.
  Matching is deliberately exact (case-insensitive, ASCII-normalized) with
  no fuzzy/typo tolerance: real whois text contains real typos (e.g. one
  LACNIC record spells "Guamtemala City"), and a fuzzy matcher would
  occasionally match the *wrong* nearby city — worse than an honest
  "no match" (null coordinates), which is what this project always
  prefers over a confident-looking wrong answer.
  We deliberately did **not** build a self-hosted GeoNames-equivalent
  (i.e. our own gazetteer of official government sources): GeoNames
  already does this well, is free, bulk-downloadable, and has no query-time
  dependency once ingested — rebuilding it would duplicate years of
  aggregation work for no accuracy gain within this project's scope.
  GeoNames also backs the **country-estimate fallback**: when an IP has no
  geofeed/LACNIC-city hit at all, the lookup returns the most populous
  GeoNames place for its RIR-registered country (e.g. Johannesburg for a
  South African allocation) instead of leaving city/coordinates empty —
  most commercial IP-info providers return something similar in this
  situation. This is always marked `geo_source: "country-estimate"` with a
  low `confidence.geo` score (0.15–0.2), distinct from a real geofeed hit
  (0.75+) — never blended together, so a caller can always tell a coarse
  guess from operator-published fact.

## Layer 4 — Datacenter / cloud detection

Per-provider published IP ranges, distinguishing "this address belongs to
a cloud/CDN datacenter" from "this address is a residential/business
connection" — a datacenter IP's registration country/geofeed describes the
facility, not an end user, so this layer is checked first and flagged
distinctly rather than blended into the geo answer.

- AWS (`ip-ranges.amazonaws.com/ip-ranges.json`)
- Google Cloud (`gstatic.com/ipranges/cloud.json`)
- Azure (Service Tags JSON — Microsoft dates the filename and rotates it
  weekly, so the parser resolves the current link from the download page
  before fetching)
- Cloudflare (`cloudflare.com/ips-v4`, `/ips-v6`)
- Oracle Cloud (`docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json`)
- Fastly (`api.fastly.com/public-ip-list`)
- DigitalOcean (via its geofeed, also feeding Layer 2)
- Linode / Akamai Connected Cloud (`geoip.linode.com`, same dual-purpose RFC
  8805 geofeed shape as DigitalOcean — reuses that parser, one file feeding
  both this table and Layer 2's `geofeed_ranges`. Verified on a real run:
  5,445 rows.)
- Bunny.net CDN (`bunnycdn.com/api/system/edgeserverlist`, IPv4 and IPv6
  separately, added 2026-08-04) — the one entry in this table that isn't a
  provider-published CIDR block: the feed is a flat JSON array of bare
  host addresses (`["89.187.188.227", ...]`), one per edge server, no
  prefix at all. Stored as each address's own `/32` (IPv4) or `/128`
  (IPv6) — the natural CIDR form of a single host — rather than skipped;
  `parseCidr()` (which every other source in this table uses to validate)
  requires a `/` and would silently reject 100% of these rows unchanged,
  so this source validates with `isIP()` instead. Verified on a real run:
  579 IPv4 + 316 IPv6 = 895 addresses, zero skipped; a real lookup on one
  of them came back `cloud_provider: "bunny"`.

Named hosting/VPS providers whose ASN name carries only a brand, not a
generic word like "hosting" or "cloud" (Hetzner, OVH, Vultr, DigitalOcean,
Contabo, LeaseWeb, Linode, and others) are recognised from data this
project already has — `bgp_origin_ranges` + `asn_blocks` — no separate feed
needed; see the connection-type heuristic below.

**Hetzner and OVH checked this session, deliberately not added as a
separate cloud_ranges feed.** Neither publishes a first-party IP-range
file the way AWS/GCP/DigitalOcean/Linode do (`hetzner.com/ip-ranges` and
similar guessed paths 404; OVH's public API (`api.ovh.com/1.0/ip.json`) is
customer IP-block management, not a published list of OVH's own
infrastructure ranges). The only candidates found were third-party
BGP-derived mirrors of unconfirmed accuracy and no stated license — not
"published by the operator for public consumption", the bar every other
row in this table clears. Both are already covered, at ASN-name-heuristic
precision, by the pattern above.

## Layer 5 — Anonymity services

Addresses belonging to services whose purpose is to stand between a user and
the destination.

- **Tor exit list** — the Tor Project's own bulk list of current exit
  relays, published deliberately because the network is designed to be
  identifiable at the exit. Complete for Tor in a way no proxy list can be
  for proxies.
- **VPN provider server lists** — currently Mullvad, which publishes every
  relay's egress address through a public API. One provider is one
  provider: this layer marks traffic leaving a VPN whose operator publishes
  and is silent about the ones that don't.

Both populate `anonymity_ranges`, gated by the `anonymity` lookup feature.
The honest limit, stated once here and again in the table's own comment:
**residential and mobile proxy networks are not covered and cannot be.**
They route through real consumer devices, publish nothing, and are
identified only by behavioural telemetry across many customers' live
traffic — a different kind of system than a bulk-data database. Absence
from this layer is not evidence of absence.

**ProtonVPN and Cloudflare WARP checked this session, deliberately not
added.** Both fail the same test Mullvad passes — a genuine, operator-
published, public API meant for exactly this kind of consumption:

- **ProtonVPN** did once have an unauthenticated `api.protonvpn.ch/vpn/
  logicals` endpoint that third-party projects scraped for exactly this
  purpose, but Proton has since locked it behind app-version/session
  requirements and explicitly said so: "what you were using previously was
  not officially supported." No replacement public list exists. The
  GitHub mirrors that still circulate are built by continuing to poll the
  now-unsupported private client API, not from anything Proton publishes.
- **Cloudflare WARP** has no published egress-IP list at all — the one
  concrete IPv4 range findable in Cloudflare's own docs
  (`162.159.192.0/24`) appears in a *firewall-allowlist* context alongside
  other ranges the client connects *to* (WireGuard/MASQUE endpoints), not
  a confirmed customer-facing egress range, and Cloudflare's own blog post
  on how WARP assigns exit IPs ("GeoExit") explicitly describes the
  allocation strategy without disclosing the ranges. Cloudflare's docs are
  explicit that Zero Trust client egress IPs specifically are *not*
  published ("contact your account team" for a dedicated one). Guessing
  which of Cloudflare's general anycast edge ranges (already ingested as
  the `cloudflare-v4`/`cloudflare-v6` cloud source) WARP traffic actually
  egresses through, without a citable confirmation, would risk exactly the
  kind of wrong-not-just-incomplete signal this project avoids elsewhere
  (e.g. Mullvad excluding inactive relays for the same reason).

## Layer 6 — Threat / abuse signal

- **Threat feed — `threat_ranges` is populated again, by abuse.ch Feodo
  Tracker.** Spamhaus DROP/EDROP was used here previously: free to use, but
  its redistribution terms aren't clear enough to bulk-ingest for a
  commercial product without a paid Spamhaus Technology licence (see
  "Commercial use" below), so it was removed. This session investigated
  **FireHOL's blocklist-ipsets** (github.com/firehol/blocklist-ipsets) as
  the obvious broad replacement and deliberately did **not** wire it up —
  every candidate list checked there fails the same bar Spamhaus did:
    - `firehol_level1`/`level2`/`level3` are themselves composites that
      include `spamhaus_drop` and/or `fullbogons` (Team Cymru — see "not in
      scope" note below) directly, or `dshield` (SANS ISC — **CC BY-NC-SA,
      non-commercial only**, the same problem class as the CAIDA AS-Rank
      data this project already excluded for the same reason).
    - `greensnow` states outright "reproduction or republication strictly
      prohibited". `botvrij` states "you cannot resell the data... as part
      of a larger package". `blocklist.de`, `bruteforceblocker` (danger.rulez.sk),
      CINS/`ciarmy`, and Emerging Threats state no redistribution/commercial
      terms at all — the exact "ambiguous, so excluded" bucket Spamhaus
      itself is in.
    - The repository itself carries no license file and its own README
      says as much: "a few of these lists may have special licences
      attached... check their source site" — there is no single license to
      point to for "FireHOL" as a whole, only per-upstream-source terms,
      none of which cleared the bar on inspection.

  **abuse.ch's Feodo Tracker is wired up instead** (`feodotracker` source,
  `feodotracker-json` parser) — narrower than FireHOL would have been
  (currently/recently-active botnet C2 addresses only: Dridex, Emotet,
  QakBot, and other Feodo-family malware — a handful to a few dozen rows,
  not thousands), but its own terms of service are an explicit,
  dataset-specific **CC0** grant ("used for both, commercial and
  non-commercial purpose without any limitations"), unambiguous in a way
  nothing else checked this session was. Deliberately the *non-aggressive*
  blocklist — Feodo Tracker's own page recommends against the aggressive/
  historical variant for exactly the false-positive reason Mullvad already
  excludes inactive relays here (a years-stale "C2" IP has likely been
  reassigned to someone ordinary since). Verified end to end on real data:
  5 rows ingested, and `50.16.16.211` (a QakBot C2 in the feed) correctly
  came back `is_threat: true` / `risk.level: "medium"` from both
  `ip_intel` and `ip-insight lookup` — confirming the fix, not just the
  ingest.

  **abuse.ch's URLhaus was evaluated alongside Feodo Tracker and NOT
  added.** Its own CSV/JSON downloads carry the header
  `# Terms Of Use: https://urlhaus.abuse.ch/api/`, which states commercial
  use "may require a paid subscription for the enhanced abuse.ch commercial
  API" — the same ambiguous-for-a-commercial-product terms Spamhaus was
  excluded for (abuse.ch and Spamhaus are the same organisation today).
  Feodo Tracker's page is explicit that its CC0 grant is specific to Feodo
  Tracker's own datasets, not a blanket abuse.ch policy, so the two
  genuinely differ rather than this being an inconsistent call.

  **abuse.ch's SSLBL was checked (2026-08-04) and NOT added — not a
  licensing rejection, a dead-feed rejection.** Its own stated terms are
  clean (CC0, same as Feodo Tracker — a genuine, separate per-dataset
  grant, correctly distinct from URLhaus's paid-subscription clause
  above). But fetching the actual file directly rather than trusting that
  license check alone shows it starting with its own banner: `# Last
  updated: 2025-01-03` and `# ATTENTION: This list has been deprecated on
  2025-01-03` — and past the header, zero real data rows. abuse.ch retired
  this feed over a year before this project checked it. A source can clear
  every licensing bar this project sets and still be worth nothing to
  ingest; the two questions are independent, and both have to be checked,
  not just the one this project usually spends the most effort on.

  The `threat_ranges` table and lookup path (`threat` feature) stay
  otherwise unchanged — a deployment with a Spamhaus/URLhaus licence, or
  another feed with clear terms, can still add to it with no schema change.
- **Abuse contacts** — who to notify about traffic from a prefix. Used to
  be resolved from a RIPE bulk-whois batch scan (`inetnum` → `abuse-c:`
  handle → `role` object's `abuse-mailbox:`); now a live, per-address RDAP
  lookup instead, triggered on a cache miss against `abuse_contacts` and
  cached there for next time (see `@workspace/lookup`'s `rdap.ts`) — same
  reasoning as geofeed discovery in Layer 2: RDAP is the protocol every RIR
  runs specifically for individual queries, a bulk whois dump is a
  different product whose redistribution terms this project cannot meet
  commercially. Coverage genuinely improved along the way: the retired
  batch scan was RIPE-only (ARIN publishes no equivalent free bulk dump),
  while RDAP is answered by every RIR, so North American space that used to
  come back empty now resolves too. Gated by the `abuse_contact` lookup
  feature; an empty result now means "this RIR's RDAP object has no abuse
  role, or the request timed out" — never "this network has no abuse
  contact" outright.
- **`security.txt` (RFC 9116)** — a small, bonus, independent signal tried
  only when RDAP itself came back empty (see `@workspace/lookup`'s
  `security-txt.ts`). This has nothing to do with any RIR at all: it's a
  file an organisation chooses to publish on its own domain, so there's no
  registry, no rate limit, and no redistribution terms to reason about —
  the whole reasoning that governs RDAP above doesn't even apply here.
  The tradeoff is real, low coverage: it's domain-based rather than
  IP-based (needs a reverse-DNS hit first, then a best-effort guess at the
  registrable domain from the resulting hostname — wrong for multi-part
  public suffixes like `.co.uk`, which just degrades to another miss, never
  a wrong answer), and measured adoption across the web is under 1-2% of
  domains (see the "Commercial use" table below for the cited figures). It
  can only ever add coverage on top of RDAP, never replace it.

## Verified bots (crawler identity)

- **Operator-published crawler ranges** — the `User-Agent` header is free
  text, so anything can call itself Googlebot, and plenty does: to slip past
  rate limits, to be served content a scraper wouldn't be, or to distort
  analytics. The only durable check is against a list the operator publishes
  itself, and ten of them do, all at fixed URLs in the same JSON shape Google
  defined (`{"prefixes":[{"ipv4Prefix"|"ipv6Prefix"}]}`) — so one parser
  serves every one, and a new operator adopting the convention costs a
  registry URL and a source entry, no code.

  Ingested, with the row counts from a real run:

  | Crawler | Operator | Prefixes |
  |---|---|---|
  | Google user-triggered fetchers | Google | 1,054 |
  | Googlebot | Google | 315 |
  | ChatGPT-User | OpenAI | 286 |
  | Google special crawlers | Google | 270 |
  | AhrefsBot | Ahrefs | 51 |
  | OAI-SearchBot | OpenAI | 35 |
  | Bingbot | Microsoft | 28 |
  | GPTBot | OpenAI | 21 |
  | Anthropic (ClaudeBot / Claude-User / Claude-SearchBot, combined) | Anthropic | 20 |
  | Applebot | Apple | 12 |
  | PerplexityBot | Perplexity | 8 |
  | CCBot | Common Crawl | 6 |

  Populates `verified_bot_ranges`, exposed as the `verified_bot` lookup
  feature and as `ip_intel.verified_bot` / `.verified_bot_operator`.

  **What a hit means, and what it doesn't.** A match says the address is
  inside a range the operator publishes — a strong statement about the
  network, and *nothing* about the User-Agent the request actually carried.
  Comparing the two is the caller's job and is the entire point: this
  supplies the half that can't be forged.

  **Anthropic and Common Crawl re-checked this session — the answer changed.**
  An earlier pass of this project checked both and found nothing to ingest:
  Anthropic's own documentation stated outright "we do not currently publish
  IP ranges", and Common Crawl had no equivalent file either. Re-verified
  directly against each operator's current site (not a third-party
  aggregator — several of those returned plausible-looking but unconfirmed
  numbers that didn't match the real files) before adding: Anthropic now
  publishes `https://claude.com/crawling/bots.json` (one combined list for
  all three of its crawlers — no per-crawler split, unlike Google), and
  Common Crawl publishes `https://index.commoncrawl.org/ccbot.json`. Both use
  the same JSON shape Google defined, so the existing parser covers them with
  no new code. This is the concrete reason every source in this table is
  re-checked at the primary source rather than assumed from what a prior pass
  (or this document) already says — "no feed exists" is a fact with a
  timestamp, not a permanent property of the operator.

  **Absence is still not a verdict** for what's left. Checked and
  deliberately not added, because no machine-readable list could be
  confirmed: **DuckDuckGo** (HTML page only), **Meta/Facebook**
  (documentation directs you to whois AS32934, re-checked this session — still
  no first-party JSON/CSV file, only third-party mirrors of unconfirmed
  provenance), **Yandex** and **Baidu** (reverse-DNS verification only),
  **Semrush**. A real crawler from any of these is simply missing here, so
  `verified_bot: null` means "unverifiable from published data", never
  "fake".

## Neighborhood context (derived)

- **Per-block counts of flagged neighbours** — an address can be entirely
  unremarkable itself while sitting in a /24 where a hundred neighbours are
  Tor exits. Addresses in one small block usually share an operator and a
  purpose, so that concentration is real information, and it is invisible to
  a lookup that only asks about the queried address.

  Computed locally from tables this project already holds (`anonymity_ranges`,
  `threat_ranges`, `verified_bot_ranges`) — no download, no upstream licence.
  Rolled up to a /24 for IPv4 and a /48 for IPv6, recomputed after each
  enrichment alongside `asn_reach`. Populates `neighborhood_stats`, exposed
  as the `neighborhood` lookup feature.

  Real example from a live run — the same /24, two addresses:

  | Address | Itself | Its /24 |
  |---|---|---|
  | `185.220.101.64` | clean, risk 15 | **141 Tor exits** |
  | `185.220.101.1` | Tor exit, risk 35 | 141 Tor exits |
  | `8.8.8.8` | clean, risk 5 | nothing flagged |

  **Counts, never a score, and deliberately not fed into `risk`.** A number
  called "bad neighborhood score" would be a judgement dressed as a
  measurement, and a caller acting on it could block a real user — the same
  reasoning `risk.ts` sets out for itself. Whether 141 Tor exits nearby
  matters depends on the caller's product in ways this project cannot know,
  so it reports the count and stops there.

  **The table is sparse**: only blocks containing at least one flagged entry
  get a row, so `neighborhood: null` is the ordinary, clean answer rather
  than missing data. And an "entry" is one listed range, not one address —
  Tor/VPN listings are single addresses so the two coincide, but a threat
  listing may cover a whole prefix.

## ASN profile (derived)

- **What kind of network an ASN is**, as distinct from how big it is —
  `asn_reach` already answers size (prefixes, address space, collector
  visibility). This answers the question a caller actually asks: does it
  operate in one country or forty, is it datacenter or access space, and
  does it sign its routes.

  Computed locally from tables already held (`bgp_origin_ranges`,
  `rpki_roas`, `ip_blocks`, `cloud_ranges`, `anonymity_ranges`,
  `verified_bot_ranges`) — no download, no upstream licence. Populates
  `asn_profile`, recomputed with the other derived sources.

  **RPKI hygiene is the signal worth having.** An ASN that signs its
  announcements is making a checkable, ongoing operational commitment; one
  carrying *invalid* announcements has a live problem. Unlike a reputation
  score this is cryptographic, not anyone's opinion. Measured across the
  whole table on a real run — 84,989 ASNs:

  | | ASNs |
  |---|---|
  | Signed, nothing invalid | 50,033 |
  | Carrying invalid announcements | 2,956 |
  | Entirely unsigned | 32,000 |

  Real rows, to show the shape:

  | ASN | Countries | RPKI valid / invalid / unsigned | Cloud | Bot |
  |---|---|---|---|---|
  | AS16509 Amazon | 71 | 20,647 / 11 / 87 | 12,891 | 2 |
  | AS13335 Cloudflare | 38 | 5,366 / 4 / 175 | 4,622 | 0 |
  | AS15169 Google | 6 | 1,375 / 4 / 0 | — | 9 |
  | AS9121 Türk Telekom | 2 | 1,214 / 25 / 0 | — | 0 |
  | AS3320 Deutsche Telekom | 28 | 539 / 4 / 436 | — | 0 |

  **Counted in prefixes, not addresses**, throughout: the question is what
  share of what a network announces is signed, and weighting by size would
  let one large legacy block drown out the answer. And *unsigned* is not
  *invalid* — most of the internet is unsigned, which is normal, while
  invalid means a live routing contradiction.

## Layer 7 — Route origin authorisation (RPKI)

- **Validated ROA payloads** (`console.rpki-client.org`) — which ASN each
  prefix holder has cryptographically authorised to announce their space,
  and to what prefix length. This is the only layer here that can
  *contradict* another: every other source says what is true about an
  address, while RPKI says whether what `bgp_origin_ranges` observed is
  **authorised**. A prefix covered by a ROA but announced from a different
  ASN is RPKI-invalid — the signature of a hijack or a misconfiguration,
  and cryptographically backed rather than reputational.
  Populates `rpki_roas`, gated by the `rpki` lookup feature. Note that
  "not-found" (no ROA covers the prefix) is still the majority of the
  address space and is not a problem — only "invalid" is.
  Multiple validators can be configured; where two disagree the
  higher-priority source wins, and where only one has data it is used as-is.

## Supporting signals

- **Reverse DNS (PTR)** — a live `dns.promises.reverse()` lookup at query
  time (the one signal in this project that is inherently live, since PTR
  records aren't bulk-distributable). Bounded with an 800ms timeout; never
  blocks or fails a lookup.
- **RDAP** (`rdap.arin.net`, `rdap.db.ripe.net`, `rdap.apnic.net`,
  `rdap.lacnic.net`, `rdap.afrinic.net`) — live per-address lookups for
  abuse contact (Layer 6), geofeed discovery (Layer 2), and network name
  (below), triggered on a cache miss and cached for next time. Each query
  goes directly to the registry that holds the address, chosen from the
  `rir` already known from `ip_blocks`; see "RDAP-based live discovery"
  below for why that matters and how rate limits are handled. Bounded by a
  timeout, never blocks or fails a lookup, same contract as reverse DNS
  above.
- **Network name** (`network_names`) — the registry's own name for an
  allocation: `PCH-PUBLIC-RESOLVER` for Quad9's `149.112.112.0/24`,
  `RIPE-NCC` for `193.0.0.0/21`. Read off the RDAP response that abuse or
  geofeed discovery already fetched, so it costs **no additional query**
  against any registry's quota, and cached by prefix.
  This exists because there is no bulk source for it at all: the RIR
  delegated-extended statistics files this project builds `ip_blocks` from
  carry country/type/start/count/date/status and no name field of any
  kind, so `ip_blocks.network_name` has been null on every row this project
  has ever held. Before this, `network.network_name` in a lookup response
  fell through to the ASN's org name — which answers a different question
  (who runs the AS, not what the allocation is called) and simply
  duplicated `asn.name` in the same response.
  A registry whose RDAP `name` is just the address range restated as text
  (real behaviour on some LACNIC objects, e.g. `"200.3.12.0 -
  200.3.15.255"`) is rejected rather than stored: it carries nothing the
  `network` field doesn't already say.
- **IANA special-purpose address registries** (IPv4 + IPv6, RFC 6890) —
  the static, rarely-changing list of private/loopback/documentation/
  multicast/etc. ranges. These are never RIR-allocated, so without this a
  lookup on e.g. `10.0.0.0/8` would just come back empty with no
  explanation; this source lets it say why. Populates
  `special_purpose_ranges`, gated by the `special_purpose` lookup feature.
- **ASN reach metrics** (derived — no upstream source) — per-ASN announced
  prefix count, announced IPv4 address space, and route-collector
  visibility, aggregated locally out of `bgp_origin_ranges` with a single
  SQL statement (~2s over ~1.5M routes, ~85k originating ASNs). Populates
  `asn_reach`, joined by ASN number, gated by the `asn_reach` lookup
  feature.
  This deliberately replaced CAIDA's AS Rank, which was used here
  previously: CAIDA's data is licensed for non-profit research/education,
  internal evaluation, or government use only — not for inclusion in a
  commercial product or service, which is exactly what this project exists
  to let people build (see "Commercial use" below).
  The two metrics are not equivalent and the difference matters when
  reading the numbers. CAIDA computes a **customer cone** ("how many
  networks sit beneath this one in the transit hierarchy"), which requires
  AS *paths* — obtainable only from full MRT routing dumps, not from the
  RIS whois dump this project ingests (prefix → origin ASN, no path). What
  `asn_reach` measures instead is **origination footprint**: how much
  address space a network announces itself. Both are correct about
  different things, and they genuinely disagree: Cloudflare (AS13335)
  ranks 358th by announced IPv4 space here while ranking far higher by
  customer cone, because it is a CDN — little address space, enormous
  presence.
  `peer_visibility` is the column that speaks to reach rather than size,
  and it ranks the network very differently again: the most widely seen
  ASNs are the DNS root-server operators and anycast infrastructure
  (AS25152/K-root, AS112, AS20144/L-root, AS8674/Netnod — all seen by
  420-450 collectors), none of which crack the top 7,000 by address space.
  Three different questions, three different orderings; the table answers
  all three separately rather than collapsing them into one "importance"
  score it cannot honestly compute.
  Read `rank` as "rank by announced IPv4 address space", never as "rank by
  importance".

## Using the database from another project

Two things make this database readable from outside the project that built
it.

### `public` holds data; `ops` holds machinery

Everything about *building* the database — job history, per-source download
progress, backup bookkeeping — lives in a separate `ops` schema. `public`
contains only tables worth querying:

```
public:  ip_blocks  asn_blocks  bgp_origin_ranges  geofeed_ranges
         cloud_ranges  threat_ranges  anycast_ranges
         special_purpose_ranges  asn_reach  asn_profile
         neighborhood_stats  anonymity_ranges  verified_bot_ranges
         rpki_roas  abuse_contacts  network_names
         geonames_places  geonames_admin1
ops:     collection_jobs  collection_sources
         enrichment_jobs  enrichment_sources  backup_runs
         prefix_baseline  prefix_history  snapshots  snapshot_prefixes
         mmdb_publishes  history_captures
```

Nothing in `ops` is needed to answer a question about an address. Drop the
whole schema if you only want the data.

### `ip_intel` — the one-query answer

The `public` tables above are organised by *source*: one per feed, each
holding what that feed alone knows. Good for building and auditing, bad for
using — answering "what do I know about this address" means seven
containment queries plus this project's layer-precedence rules
reimplemented in whatever language you're working in.

`ip_intel` flattens all of it into one relation:

```sql
SELECT * FROM ip_intel
WHERE network >>= '1.1.1.1'
ORDER BY masklen(network) DESC
LIMIT 1;
```

One statement, any language, precedence included. It carries the RIR
allocation, geofeed city/coordinates, BGP origin ASN with its name and
reach metrics, cloud/anycast/threat/special-purpose flags — the same
signals `@workspace/lookup` resolves, minus the two that can't be
precomputed (reverse DNS is live per query; the country-estimate fallback
is a lookup-time choice, not a fact about the prefix).

It exists in one of two forms, chosen by `ipIntelMode` in
`ip-insight.config.json`, and `enrich` brings it up to date at the end of
every run:

| `ipIntelMode` | Lookup cost | Build cost | Storage |
|---|---|---|---|
| `view` (default) | ~40-110ms warm, up to ~1s on first touch of cold pages | none — created in under a second | none |
| `materialized` | one GiST index probe | full rebuild, ~10+ min on the full dataset | the flattened rows on disk |
| `off` | — | — | — |

The plain view is slower than `@workspace/lookup`'s own sub-20ms path for a
structural reason worth knowing: the view runs its seven range scans as
sequential nested loops, while `lookupIp` fires them concurrently. If you
need lookup latency rather than convenience, use the package (or the API),
not the view.

`materialized` is the shape commercial IP databases ship — everything
precomputed, one index probe per query. Refreshes run `CONCURRENTLY`, so
readers keep seeing the previous contents rather than blocking for the
length of a rebuild. Run it on demand with `ip-insight flatten --refresh`.

## Derived and heuristic signals

Two fields here are computed rather than ingested, and both are labelled so
a consumer can never mistake them for sourced fact.

- **Risk score** (`risk`) — a composite of the signals above: RPKI validity,
  how many independent threat feeds list the address, Tor/VPN membership,
  datacenter vs consumer space, missing PTR. Every point traces to a named
  reason returned alongside the score.
  It is deliberately *not* a fraud probability. Commercial risk scores are
  models trained on live traffic outcomes; this project holds bulk published
  data and no outcome data at all, so a calibrated score is not something it
  could honestly produce. What it can offer instead is a score you can
  re-derive yourself from fields you can see — auditable rather than
  accurate-sounding. Treat it as one input beside a specialist service.
- **Usage type** (`usage_type`) — residential/mobile/hosting/cdn/enterprise/
  vpn/proxy, derived from anycast, cloud-range, threat-list, ASN-name, and
  PTR signals in that precedence order (`classifier.ts`). Returns `null`
  when nothing matched, never a default. This was not always true: until
  2026-08-05 the ASN-name step and a final fallback both turned "no pattern
  matched" into a confidently-labelled `"hosting"` — reasoned as a
  "conservative default" but measured, on this project's own top 3000 ASNs
  by announced address space, to be the opposite: 48.3% of them (China
  Telecom, Korea Telecom, Rostelecom, Turk Telekom, Turkcell, MTN, and most
  of the world's carriers whose names don't match an English/Western brand
  pattern) were being called "hosting", which fed straight into `risk.ts`'s
  "datacenter" flag for every one of those addresses — including ordinary
  residential customers, caught on this project's own founder's home ISP
  connection during testing. Two fixes: (1) `asn-types.ts`'s pattern set was
  broadened considerably — an unbounded `tele[ck]om` substring rule that
  covers roughly 97% of the world's telecom operators by legal-name root
  alone (verified: 213 matches in the top-3000 sample, 97.2% precision, the
  6 false positives being government/education telecom departments now
  caught by a carve-out rule placed ahead of it), a `comunicac` substring
  covering Portuguese/Spanish "comunicação(ões)"/"comunicación(es)" — the
  actual Brazilian regulatory term for an ISP license and the equivalent
  Latin American phrasing (657 real, zero-false-positive matches across the
  full `asn_blocks` table), named exceptions for major carriers whose brand
  name carries no generic keyword at all (Turkcell, MTN, Telia, Vimpelcom/
  Beeline's Russian subsidiaries, CANTV, Comcel, Telconet, ETB, VTR, Wana —
  each individually checked against the full ASN-name column for
  collisions; a few candidates with the same surface pattern, "elisa" as a
  common first name and "tdc" colliding with a New Zealand district council
  and an unrelated payments company, were found unsafe and left out), and a
  government/education carve-out ahead of the telecom rule so a state's
  internal telecom department doesn't get classified as an access ISP. This
  brought "other" from 48.3% down to 33.9% of the same top-3000 sample. (2)
  Both places "no match" used to become `"hosting"` (`ASN_TO_USAGE.other`
  and the final fallback) now leave `usage_type: null` instead — the same
  honest-absence contract `connection_type` below already followed.
  `reverseDnsSignal`'s residential pattern was also broadened to catch
  `dynamic`/`pppoe`/`dhcp`/`cpe`/`client`/`customer`/`home` PTR hostnames,
  which is what actually classifies the founder's own dynamic-PTR home
  connection correctly now.
  **Follow-up regional audit (same day):** broke the same measurement down
  by RIR as a region proxy, expecting Africa to be worst-covered. The
  opposite was true — AFRINIC had the *lowest* unclassified rate (25.8%),
  while LACNIC (57.5%) and RIPENCC (45.0%, whose service region includes
  the Middle East and Central Asia, not just Europe) were the worst. The
  cause wasn't missing brand names, it was missing generic non-English
  words: Spanish "móvil" (mobile) and "teléfono" (telephone), Spanish/
  Portuguese/Italian/German "universidad"/"universitaria"/"università"/
  "Universität", and Turkish "iletişim" (communications, the exact Turkish
  counterpart to the `comunicac` fix above) were all absent from the
  pattern set, each verified against the full `asn_blocks` table before
  being added (162/114/231+107/6 real matches respectively, effectively
  zero false positives — full numbers and the one disclosed exception,
  `entel` colliding with an unrelated Serbian firm in 1 of 9 cases, are in
  `asn-types.ts`'s comments). The university fix is worth a specific
  mention: an initial version covering only the "-t-" root
  (universitaria/università/universitaet) looked done against its own
  sample, but a direct check against "Universidad Nacional Autónoma de
  México" — picked deliberately as an obvious real-world case, not a
  random spot check — still returned "other", because plain Spanish
  "Universidad" has no "t" in it at all, a different root that only
  shares a prefix. Fixed by adding `universidad` as its own alternative
  (231 more real matches, also covering the Portuguese "-e" spelling for
  free). Two plain regex bugs were also found this way and fixed:
  `holdings`/`enterprise`/`communications`/`data center` were only ever
  matched in one grammatical number, silently missing "Holding",
  "Enterprises", "Communication", and "Data Centers".
- **Connection type** (`connection_type`) — a guess at the access network
  (cellular/DSL/cable/fibre/corporate/hosting/satellite/education/government/
  iot) from patterns in the ASN name and PTR record. There is no free bulk
  source for this; MaxMind sells a separate database. Returns `null` when
  nothing matches — never a default — and always carries
  `confidence: "heuristic"`.
- **Wider-prefix, other-ASN** (`asn.wider_prefix_asn`) — the origin ASN of
  the narrowest announced prefix that strictly contains this address's own
  announcement, when that origin differs from the address's own ASN.
  Derived locally from `bgp_origin_ranges` alone (a self-join), no new
  source. A raw fact, not a verdict, exactly like `country-conflict`
  above: on its own this is ordinary internet structure (a transit
  provider's aggregate covering a customer's prefix) — measured on a real
  sample of this database, true for roughly a quarter of announced
  prefixes. Combined with `rpki.status == "invalid"` on the same address,
  it's the textbook shape of an unauthorized sub-prefix announcement
  (route hijack, or a misconfigured provider switch — this field can't
  tell the two apart, only that the pattern is present); measured on the
  same sample, that combination drops to roughly 1 in 40. Exposed as its
  own field and flag (`wider-prefix-other-asn`) rather than folded into
  `risk` or a combined score — see the note on why `risk`/`neighborhood`
  report raw counts/reasons instead of judgments, same reasoning applies
  here.
- **Route anomaly** (`route_anomaly`, off by default) — the server-side
  synthesis of `wider_prefix_asn` + `rpki.status == "invalid"` described
  above, so a caller doesn't have to know both fields exist and combine them
  itself. `detected` is true only when both hold; `confidence` is `"medium"`
  or `"high"` (never `"low"` — there's no natural weaker tier once the
  already-rare compound condition has fired), graded up by three
  corroborating, already-cheap checks: the address is threat-listed, its
  neighborhood shows Tor/VPN/threat entries, or its own ASN has a chronically
  clean RPKI record elsewhere (so this one invalid announcement is the
  outlier, not business as usual for that network) — `asn_profile`, one
  indexed point lookup, gated to only run on the already-rare `detected`
  path. Deliberately named `route_anomaly`, not `hijack_risk`: this project
  already walked back a "hijack" framing once for `packages/collector/src/
  hijack.ts` after finding Cloudflare Radar/Kentik/Qrator already own
  real-time BGP-hijack detection at a scale (170+ full-feed peers) this
  project cannot match; this field answers a narrower, still-useful question
  from data already computed on every lookup, not a claim to compete with
  that.
  Re-measured directly against this database (2026-08-06, a 9,396-prefix
  sample — 0.7% of `bgp_origin_ranges`, sized to what a single query
  actually completes in under a minute against a 1.5M-row table without the
  correlated-subquery trap `asn_profile`/`neighborhood_stats` already
  documented once): wider-prefix-present 16.7%, RPKI-invalid 3.7%, both
  together 1.0% (94 real matches) — the same order of magnitude as the
  `wider_prefix_asn` bullet's "roughly 1 in 40" above, not an exact match to
  it (sample variance between independent measurements, expected and
  disclosed rather than smoothed over).
  All 94 real matches were read by hand, not sampled, cross-referenced
  against real ASN names. Roughly a quarter of the *distinct relationships*
  behind those 94 rows (not distinct rows — one relationship,
  "JAZZNET Orange Espagne SA" covered by "UNI2-AS Orange Espagne SA", alone
  accounted for about half the raw rows) turned out to be same-operator
  pairs: a company's own aggregate over its own more specific announcement,
  one level removed through a second AS number — "GoDaddy.com, LLC" covered
  by its own "AS-26496-GO-DADDY-COM-LLC", "KPN GTT Communications Inc."
  covered by "GTT-BACKBONE GTT Communications Inc.", Shanghai Mobile covered
  by its parent China Mobile. Not a hijack in the interesting sense. Caught
  by `looksLikeSameOperator()` (`asn-types.ts`): strips generic company/
  network vocabulary from both ASN names and checks for a shared distinctive
  word: when it fires, `route_anomaly.detected` stays true (the raw
  wider-prefix + RPKI-invalid condition really is present) but `confidence`
  is capped at `"medium"` with an explicit `same_operator_suspected` reason,
  never silently hidden. Verified against all 11 same/different pairs found
  in the real sample: 11/11 correct, including two disclosed misses left
  deliberately unfixed (a country/nationality word like "Saudi" or "China"
  is excluded as a match signal — too common across unrelated companies —
  which means "Saudi Telecom Company" vs "STC" and "China Telecom" vs its
  "Chinanet" backbone brand share no usable token; same "rare disclosed miss
  over an ever-growing exception list" call this project already makes for
  `tele[ck]om`'s ITU miss and `entel`'s Energoprojekt miss in `asn-types.ts`).
  `risk.score` gains a small, asymmetric weight (`route_anomaly_high`, +15)
  only when `route_anomaly` reaches `"high"` — never `"medium"`, and never on
  top of the `rpki_invalid` weight it already implies, so a same-operator
  pair or an ordinary customer-route ROA lag (the majority of real matches)
  never inflates the general risk score.
  Ships **off by default** (`routeAnomalyEnabled` in `packages/lookup/src/
  config.ts` — deliberately its own boolean flag, not folded into the
  `LookupFeature` list that defaults everything on, same mechanism and same
  reasoning `stable_since`/`mmdbHistoryFields` already use for an unproven
  heuristic with no outcome data to calibrate precision/recall against).
- **Stable since** (`stable_since`, `.mmdb` only, opt-in) — the date this
  prefix's tracked record (see `history.ts`'s `TRACKED_FIELDS`) last
  actually changed, straight from `ops.prefix_baseline.captured_at`. No new
  computation: that column already means exactly this, since a capture only
  touches it when something changed. Off by default and meant to stay off
  behind `ip-insight.config.json`'s `mmdbHistoryFields` until history has
  actually accumulated enough to say something — a value computed three
  weeks into collecting is technically correct but not a claim this project
  wants shipped. States how long a record has held, nothing more; whether
  that counts as "stable" is left to whoever reads the file.

## Where each field's classification logic actually lives

Asked directly (2026-08-06) so it's answered once and looked up, not
re-derived from scratch each time a new pattern needs adding: across the
whole project, only **three files hold hand-written word/pattern lists**
that classify something from text. Everything else is either an externally-
ingested list (membership only, no text pattern) or pure computation over
already-classified fields.

**Hand-written classification (word/pattern lists we maintain):**
- `packages/lookup/src/lookup/asn-types.ts` — `usage_type`
  (residential/mobile/hosting/cdn/enterprise) and `asn.type`, both from the
  same `RULES` array matched against the ASN holder name.
- `packages/lookup/src/lookup/connection-type.ts` — `connection_type`
  (cellular/dsl/cable/fiber/satellite/education/government/iot/...), a
  separate `PATTERNS` array matched against ASN name and/or reverse DNS.
- `packages/db/src/anycast-seed.ts` — `anycast` detection's curated seed:
  21 hand-picked, individually-verified well-known anycast prefixes
  (Cloudflare/Google/Quad9/OpenDNS public DNS, IANA root letters).

**Externally-ingested lists (table membership, no text pattern):**
`cloud_ranges`, `threat_ranges`, `anonymity_ranges` (Tor exit list + VPN
provider ranges), `verified_bot_ranges`, `rpki_roas`, `geofeed_ranges`,
`special_purpose_ranges`, `ip_blocks`/`asn_blocks` (RIR delegated stats),
`abuse_contacts`/`network_names` (RDAP, live-discovered). None of these
match against holder-name text — a row either is or isn't in the table for
a given address.

**Pure computation (combines already-classified fields, classifies
nothing itself):** `risk` (WEIGHTS-based scoring over other fields'
outputs), `confidence` (per-field scores), `neighborhood` (counts over
ingested tables), `route_anomaly` (synthesises `wider_prefix_asn` +
`rpki.status`, plus `looksLikeSameOperator()`'s name-token check — the
one place computation and hand-written text matching overlap, since that
specific check is itself a small pattern list living in `asn-types.ts`
alongside the others).

So: adding a new *classification* word or brand means editing one of
exactly three files above — never more, never a hidden fourth place — and
every edit to any of them should be verified against this project's real
database before shipping, the same discipline every entry in this file's
changelog already follows.

## Deliberately not built

Three things commercial providers offer that this project does not, with
the reason, so nobody has to re-derive it:

- **Residential / mobile proxy detection.** Requires behavioural telemetry
  across many customers' live traffic. No feed exists to ingest, because
  the networks in question exist specifically to be unlisted.
- **Reverse-IP / hosted domains.** Requires a continuously refreshed
  internet-wide DNS crawl. The corpora that exist are either commercial or
  of unclear redistribution status.
- **Firmographics** (company sector, size, revenue). No free
  bulk-redistributable source; PeeringDB, the obvious candidate, forbids
  commercial use outright.

These are architectural limits, not a backlog. Adding more feeds does not
reach them.

## Architecture: one database, three interfaces, two layers

The database-building logic and the query-interpretation logic are
deliberately separate packages, not just separate files:

- **`packages/collector`** — the actual database builder. Fetches RIR
  files, RIPE RIS BGP tables, geofeeds, GeoNames, LACNIC whois, cloud
  ranges, and threat feeds, and writes them into Postgres (or, for RIR
  data, straight to CSV with no database at all — see `collect --csv`).
  Contains zero query/resolution opinion.
- **`packages/lookup`** — one reference implementation of "how to
  interpret this data": layer precedence on conflict, confidence scoring,
  anycast/usage-type classification, the canonical merge/conflict view.
  A consumer who wants different resolution logic for their own use case
  (e.g. different weighting for DDoS traffic analysis vs. content
  localization) can take `packages/collector` + `packages/db` alone and
  never touch this package.
- **`packages/shared`** — tiny, opinion-free utilities (logging, retry,
  IP/CIDR math) both of the above depend on.

`apps/server` (Express) and `apps/cli` (the `ip-insight` terminal tool,
built on Commander) both import these packages directly and talk to the
same Postgres database; `apps/web` talks to the API server. Concretely,
this means:

- `ip-insight collect` / `enrich` / `lookup` / `export` / `status` work
  standalone, with only `DATABASE_URL` set — no API server needs to be
  running. `ip-insight collect --csv <dir>` needs no database at all.
- The API server exposes the same operations over HTTP for the web panel
  or any other client.
- Take just the Postgres database (or the whole repo) and run either
  interface independently; there's no logic duplicated between them to
  drift out of sync.

## Technology stack

- **TypeScript** monorepo (pnpm workspaces).
- **PostgreSQL 16** with native `inet`/`cidr` types and GiST indexes
  (`inet_ops` opclass) for unified IPv4/IPv6 containment queries
  (`network >>= '1.2.3.4'::inet`, ordered by `masklen(network) desc` for
  longest-prefix-match) — one query path for both address families.
- **Drizzle ORM** for schema and queries.
- **yauzl** for ZIP extraction (GeoNames' export files use the streaming/
  data-descriptor ZIP variant — sizes aren't in the local file header, so a
  real ZIP reader is needed rather than a hand-rolled parser).
- **pino** for structured logging, dual-writing to console and a local
  NDJSON log file with export endpoints.
- **Express** for the API server.

## Licensing summary

**Governing assumption:** this project's own deployment model is API-only —
customers get lookup *responses*, never a copy of the database or any bulk
export of upstream source data. That framing matters throughout this
section: several of the harder licensing questions below (RIPE Database
T&C's redistribution clause in particular) are about *bulk redistribution*
of a source's data, not about running your own service that answers
per-query questions informed by it. A self-hoster who instead dumps and
ships the raw tables to third parties takes on materially more licensing
risk than what's analyzed here and should re-review each source's terms
under that different use case.

| Source | License |
|---|---|
| RIR delegated-extended stats | Public, RIR terms of use |
| RIPE RIS whois dumps | Public, RIPE NCC terms of use |
| RIPE ASN names | Public, RIPE NCC terms of use |
| LACNIC bulk whois | Public, LACNIC terms of use |
| GeoNames | CC BY 4.0 (attribution required — see geonames.org) |
| AWS / GCP / Cloudflare / Oracle / Fastly / Bunny.net IP ranges | Published by each provider for public use |
| DigitalOcean / Linode geofeeds | RFC 8805, published by DigitalOcean / Linode |
| Direct-URL geofeeds (Google, NTT, Cogent, Verizon, T-Mobile, Netflix, Vultr, Civo, Schwarz IT, Telia, GTT, Charter/Spectrum, Fastly, Zayo-EU) | RFC 8805, each published by the operator itself at a fixed URL — no RIR involved |
| ASN reach metrics | Derived locally from the RIS data above — no separate upstream license |
| Feodo Tracker (abuse.ch) botnet C2 list | CC0 — dataset-specific grant, see "Layer 6" above |
| Azure Service Tags | Published by Microsoft for public consumption |
| Tor exit list | Published by the Tor Project for exactly this purpose |
| Verified-bot ranges (12 crawlers) | Published by each operator specifically so third parties can verify the crawler's identity |
| Mullvad relay list | Published by Mullvad through their public API |
| Abuse contact / geofeed (live RDAP) | Per-query lookups against each RIR's standards-mandated RDAP service (RFC 7480–7484); not a bulk data product — see "RDAP-based live discovery" below |
| Abuse contact (security.txt, RFC 9116) | Self-published by each organisation on its own domain; no RIR involved, no registry, no redistribution terms |
| RPKI validated ROA payloads | No terms found; published for machine consumption by design (RFC 6480) — see note above |

Any redistribution of this project's database should preserve GeoNames
attribution (CC BY 4.0) and respect each RIR's and provider's terms of use
for their respective bulk files. Spamhaus DROP/EDROP and RIPE/APNIC bulk
whois for geofeeds/abuse-contacts were removed from this project (see
"Threat intelligence and abuse contacts" and "Geolocation feeds" above) —
they are not wired up and nothing here depends on them; re-adding Spamhaus
would require a Spamhaus Technology commercial license first. FireHOL's
blocklist-ipsets and abuse.ch's URLhaus were investigated and deliberately
left unwired for the same class of reason — see "Layer 6" above for what
was checked in each.

**RPKI VRPs (`console.rpki-client.org`), checked specifically rather than
assumed:** no license file, terms-of-use page, or `robots.txt` restriction
found anywhere in the chain. Weaker evidence than a written grant (compare
Verizon's explicit CDLA-Permissive-2.0 geofeed below) but the reasoning
holds up: `console.rpki-client.org` doesn't originate this data, it runs
the free/open-source `rpki-client` (an OpenBSD project) against the five
RIRs' own RPKI repositories and republishes the validated output. Those
repositories exist, by RFC 6480's own design, to be fetched by every relying
party globally, continuously, without gating — that's the entire security
model (a router that can't fetch current ROAs can't validate anything).
rpki-client's own site states its output is produced "for consumption by
other routing stacks", i.e. third-party machine consumption is the stated
purpose, not a tolerated side effect. Same category of evidence as the
Google/NTT/Cogent/Vultr/Telia/DigitalOcean geofeeds below (no license text,
published at a stable public URL for exactly this kind of consumption) —
treated the same way for the same reason, not a special exception.

### RDAP-based live discovery

Abuse-contact, geofeed-discovery and network-name lookups that fall back to
RDAP (`rdap.ts`) query the relevant RIR's RDAP server once, per IP, at
request time — the same kind of individual, machine-readable lookup any
RDAP client (a WHOIS replacement) is designed for, and explicitly not a
bulk export. This is a meaningfully different object from a bulk whois dump
in both intent and technical shape, which is why it sidesteps the
redistribution restrictions that apply to dumps like RIPE's. That said,
"how much aggregate RDAP traffic before it stops looking like individual
lookups and starts looking like systematic redistribution" has no defined
numeric line in any RIR's terms — this is a much stronger, defensible
position than bulk-scraping RIPE's whois dump, not an airtight guarantee.
Results are cached (`abuse_contacts`, `geofeed_ranges`, `network_names`)
purely to avoid re-querying the same prefix repeatedly, not redistributed
onward.

**Why there is no bulk alternative for these three signals — checked at
each registry, not assumed.** The obvious question is why any of this is
live rather than downloaded once like everything else in this document.
Every RIR was checked individually:

| Registry | Bulk whois | Why it can't serve these fields |
|---|---|---|
| **ARIN** | None free | Bulk Whois is a separate, approval-gated programme this project deliberately does not use. |
| **RIPE, APNIC** | Yes, and genuinely richer (network names included) | RIPE Database T&C Art. 4.5 does not permit bulk use in a commercial product. This project **used** to scan these dumps for exactly these fields and moved to RDAP specifically to stop doing that — see the Layer 2/6 notes above. |
| **LACNIC** | Yes, already ingested | Inspected the real file's every field: `aut-num, city, country, created, inetnum, remarks, source, status`. There is no name or contact field to extract — the `city:` this project already takes is the most it carries. |
| **AFRINIC** | Yes, on request | Its own terms: bulk access is request/approval-based and "redistribution of the provided bulk data is strictly forbidden" — same category as ARIN and RIPE. |

So all five are either unavailable, contractually closed to a commercial
product, or simply don't contain the fields. RDAP isn't a shortcut taken
over a bulk file — for these three signals it is the only lawful source
this project has.

**Living within RIR rate limits, deliberately rather than by accident.**
RIRs rate-limit RDAP per client address (RIPE blocks for the day past
roughly a thousand personal-data queries; LACNIC is stricter). Three
things keep this workable, and all three are properties of the design
rather than hopes:

1. **Queries go to the registry that actually holds the address.** Each
   RIR's own RDAP endpoint is used directly (`rdap.arin.net`,
   `rdap.db.ripe.net`, `rdap.apnic.net`, `rdap.lacnic.net`,
   `rdap.afrinic.net` — every one verified live before being wired up),
   selected from the `rir` already known from `ip_blocks`, so routing
   costs nothing extra. This used to be a single RIPE entry point relying
   on redirects: correct, but it spent one registry's quota on lookups for
   address space it doesn't hold. Five registries mean five independent
   allowances.
2. **A self-imposed per-registry budget** (`rdapDailyQueryCap`, default
   800/registry/24h) refuses a query *before* making it once a registry's
   allowance is spent, so the limit that bites is this project's own
   gracefully-degrading one rather than a RIR cutting the host off. A
   refused lookup degrades exactly like a timeout already does — cached
   data, or nothing, never an error. Setting it to `0` disables live RDAP
   entirely, for a deployment that wants zero request-time third-party
   dependency.
3. **Caching is the actual answer to volume.** A prefix is queried once,
   not once per address in it, and re-queried only when its cached row
   passes `abuseContactMaxAgeDays` / `geofeedDiscoveryMaxAgeDays`
   (both 30 days by default). Real request traffic concentrates heavily on
   a small number of large networks, so steady-state RDAP volume is far
   below what per-request live lookups would suggest.

The honest limit: this is *lazy* refresh. A prefix nobody queries is never
re-checked, so a cached answer can be up to the configured max age old.
That is a deliberate trade — RDAP budget is spent on address space
somebody actually asked about, rather than on proactively re-scanning
space nobody has looked at.

## Commercial use

This project is MIT-licensed, but **the code's license says nothing about
the data**. Anyone building a paid product on top of it inherits each
upstream source's own terms. As above, this analysis assumes an API-only
deployment (lookup responses only, no database/bulk-export redistribution
to customers) — that assumption is what keeps most rows below a clean
"yes." Every source currently wired up was chosen so that it can be used
commercially:

| Source | Commercial use | Condition |
|---|---|---|
| RIR delegated-extended stats (all 5) | Yes | The open statistics-exchange files, published for anyone. Verified against the file's own header (`CONDITIONS OF USE` in `delegated.txt`, checked live 2026-08-19): only a liability disclaimer ("APNIC will not be held responsible for any loss or damage arising from the use of the information"), no commercial restriction at all. Not to be confused with ARIN's *Bulk Whois* programme, which is a separate, approval-gated product this project does not use. |
| RIPE RIS whois dumps (`riswhoisdump.IPv4/IPv6.gz`) | Yes, with a specific attribution requirement | Checked against RIPE NCC's own dedicated commercial-use page (`ripe.net/.../ris/commercial-use/`, checked live 2026-08-19), not assumed: no registration needed, permission granted by default, but **all three** of (1) the RIPE NCC logo, (2) a link to `ripe.net/ris`, and (3) RIPE's specific boilerplate paragraph describing RIS must be displayed — already tracked as a launch blocker in `ipreadout-service/PLAN.md`. Permission is revocable if these conditions lapse. |
| RIPE NCC `asn.txt` (ASN → holder name) | Probably yes, but on weaker evidence than the row above — **do not treat as the same grant** | Checked live 2026-08-19: no dedicated commercial-use policy exists for this file the way one exists for RIS. It ships from the same `ftp.ripe.net` server as RIS and the stats files but under neither's documented terms — no in-file license header either (checked the file's own first lines). RIPE NCC's general Copyright Statement restricts *advertising/marketing* use of "RIPE NCC Materials" specifically, which reads as aimed at branded/written website content rather than this kind of raw data file, but that reading isn't confirmed by a page that names `asn.txt` directly. Same evidentiary class as the RPKI ROA row below — no explicit restriction found, but also no explicit grant, unlike RIS's page. Previously grouped with RIS under one "Yes" row in this table, which overstated how solid this specific case is; split out and downgraded 2026-08-19. |
| LACNIC bulk data (`lacnic.db.gz`) | Probably yes, but same weaker evidence class as `asn.txt` above | **Important disambiguation, checked live 2026-08-19**: LACNIC operates two different things that share the word "bulk." Its application-gated "Bulkwhois" service is genuinely restrictive — technical/operational use only, no marketing, no redistribution without written consent. `lacnic.db.gz` is **not that product**: it's published under policy LAC-2018-3, a specific policy establishing a freely downloadable geolocation file, fetched directly with no application. The policy's own text: assignments "will be published in a file... available for the community to download freely" — confirms this is the right, unrestricted file, but that sentence is not an explicit commercial-use grant either. |
| GeoNames | Yes | CC BY 4.0 — **attribution is required** and must survive redistribution |
| AWS / GCP / Cloudflare / DigitalOcean / Linode / Oracle / Fastly / Bunny.net ranges | Yes | Published by each provider for public consumption |
| Direct-URL geofeeds — see the per-publisher breakdown below | Mostly yes, one conditional | Each self-published at a fixed URL; no RIR lookup, no rate limit. Terms were checked individually rather than assumed — **Netflix's carries a use restriction**, see below. A few commonly-cited publishers (F5, Telstra, Cloudflare, AWS, Azure) were researched but not added: no fixed URL could be confirmed, don't assume one. |
| IANA special-purpose registries | Yes | Public registry data |
| Azure Service Tags | Yes | Published by Microsoft for public use |
| Tor exit list | Yes | Published by the Tor Project |
| Verified-bot ranges (Google ×3, OpenAI ×3, Bing, Apple, Perplexity, Ahrefs, Anthropic, Common Crawl) | Yes | Each operator publishes these expressly so third parties can verify the crawler — consuming them is the documented purpose, not a tolerated side use. |
| Mullvad relay list | Yes | Public API; check Mullvad's terms before high-volume polling |
| Abuse contact / geofeed (live RDAP) | Yes, under the API-only assumption above | Per-query RDAP lookups, not a bulk redistribution product; discovered geofeed CSVs are third-party URLs — each publisher's own terms apply to their feed once fetched |
| Abuse contact (security.txt, RFC 9116) | Yes | Bonus fallback only, tried after RDAP comes back empty; self-published on the organisation's own domain, so no RIR/registry terms apply at all. Coverage is low by nature: an arXiv-cited measurement (Feb 2025) found adoption under 1-2% of domains generally, and it needs a reverse-DNS hit first — a miss here is normal, never a wrong answer. |
| RPKI validated ROA payloads | Yes | No written license found — see the researched note above (RFC 6480's own design requires this data be openly machine-fetchable; rpki-client's own site states its output is "for consumption by other routing stacks"). Same evidence class as the no-license-text geofeeds two rows up, not a stronger or weaker case than those. |
| Feodo Tracker (abuse.ch) botnet C2 list | Yes | CC0 — the operator's own terms state commercial and non-commercial use without limitation. **Not** the same grant as abuse.ch's URLhaus, checked and left out — see "Layer 6" above. |
| ASN reach metrics, risk score, connection-type guess | Yes | Computed here; no upstream dependency |

### Direct-URL geofeed publishers, individually

Each publisher's own terms were checked rather than assumed from the fact
that the file is public. Most state nothing at all; what makes that
defensible is RFC 8805's own purpose — an operator publishes a geofeed
*so that* geolocation providers consume it. One states a real condition.

| Publisher | Terms found | Note |
|---|---|---|
| Verizon | **CDLA-Permissive-2.0** | A data licence written for exactly this kind of sharing. Commercial use permitted outright. |
| T-Mobile US | **Apache-2.0** | Permissive. Its "ship the licence with the work" clause applies to redistributing the file, not to serving lookup responses derived from it. |
| Schwarz IT | **DL-DE→Zero-2.0** | German open-data licence: *"Jede Nutzung ist ohne Einschränkungen oder Bedingungen zulässig"* — effectively CC0. |
| **Netflix** | **Restricted** | The feed states the data *"may be used only for improving the accuracy of Geo:IP lookups."* That **is** what it's used for here, so the use sits inside the grant — but it is a condition, not an open licence. Do not route this source into risk scoring, infrastructure classification, or any dataset resale without revisiting it. |
| Civo | No licence file | Repository states the feed exists to be Civo's authoritative geofeed. |
| Google, NTT, Cogent, Vultr, Telia, DigitalOcean, GTT, Charter/Spectrum, Fastly, Zayo | None stated | No licence text accompanies the file. Published at a stable public URL in RFC 8805 format. |

The honest reading of the last row: "no terms found" is not the same as "no
terms exist", and it is recorded that way in `enrichment-sources.ts` rather
than rounded up to "unrestricted".

Removed for licensing reasons — **not** wired up in this codebase, listed
here only so the decision isn't re-litigated by a future contributor:

- **Spamhaus DROP/EDROP** — technically free to use including in products,
  but the "Spamhaus" name can't appear in commercial/marketing material and
  access is revocable at Spamhaus's discretion (spamhaus.org/drop/terms).
  Removed rather than accepted as a dependency; re-add only behind a
  Spamhaus Technology commercial license if a contractual guarantee is
  needed.
- **RIPE/APNIC bulk whois for geofeed discovery and abuse contacts** —
  replaced by live per-query RDAP (see above) specifically to avoid RIPE
  Database T&C Article 4.5's bulk-redistribution restriction, which a
  full/periodic whois-dump scan sat much closer to than a live RDAP client
  does.

Deliberately **not** included, despite being technically attractive:

- **CAIDA AS Rank** — licensed for non-profit research/education, internal
  evaluation, or government use; a commercial service is outside that
  grant. Replaced by the locally derived `asn_reach` metrics above.
- **PeeringDB** — its acceptable use policy forbids commercial use and
  prohibits passing the data on in bulk without approval.
- **FireHOL blocklist-ipsets** — technically attractive (an aggregate of
  ~100 free threat lists), but its own README says individual lists carry
  their own licences and the aggregate includes MaxMind GeoLite2-derived
  data. Only lists whose licence has been checked individually can be used;
  the aggregate as a whole cannot.
- **X4BNet VPN/datacenter lists** — ~42k ranges and good quality, but the
  repository ships no LICENCE file at all, so redistribution rights are
  undefined.
- **Orange Luxembourg geofeed** — no license restriction found on the
  data itself, but its `robots.txt` disallows crawling the site and its
  general terms' reproduction clause has unclear applicability to this
  data subdomain; low value regardless (small subsidiary, few rows). See
  "Deep commercial-terms check" above for the full account.
- **Yandex Cloud CDN ranges** — no license restriction on the data, but
  the contracting/infrastructure entities are Russia/Serbia-based
  (post-2024 Nebius split) — a jurisdictional/compliance question, not a
  copyright one, and one this project can't resolve on any given
  deployment's behalf. See "Deep commercial-terms check" above.

If you fork this and add a source, check its terms first: the value of a
self-hosted database is that you can answer for every byte in it.
