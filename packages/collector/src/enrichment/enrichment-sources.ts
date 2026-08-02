/**
 * Public enrichment sources.
 *
 * Each source is a free, public CIDR or ASN feed used to annotate the RIR
 * dataset with additional context:
 *
 *  - asn-name:   RIPE NCC's global ASN -> holder name list. Used to populate
 *                asn_blocks.name.
 *  - bgp-origin: RIPE RIS whois dumps (real BGP tables) mapping announced
 *                prefixes -> origin ASN. This is Layer 1 of the geolocation
 *                model: it replaces per-request live ASN resolution with a
 *                locally indexed, refreshed-daily table so resolution is
 *                uniformly reliable for every ASN, not just the ones popular
 *                enough to be fast/cached on a third-party API. Populates
 *                bgp_origin_ranges.
 *  - cloud:      Per-provider published IP ranges (AWS, GCP, Cloudflare,
 *                DigitalOcean, …). Stored as separate rows in cloud_ranges
 *                so the original RIR allocation rows stay untouched. Range
 *                overlap is computed at query time. This is Layer 4: marking
 *                datacenter/cloud space distinctly from "where the user is".
 *  - geofeed:    RFC 8805 self-published prefix -> city/region feeds (Layer
 *                2). Operator-published, so materially more trustworthy than
 *                guessing a city from the RIR country. Also fed by LACNIC's
 *                bulk whois dump, which — uniquely among the 5 RIRs — carries
 *                a real, structured `city:` field directly on its inetnum
 *                (IP block) records. Populates geofeed_ranges with a
 *                confidence score. RIPE/APNIC-wide *discovery* of feeds
 *                nobody added by hand no longer runs as a batch source here
 *                (see the "abuse" entry below) — it's a live, per-address
 *                RDAP lookup on a cache miss instead.
 *  - geocoding:  GeoNames' free city gazetteer (cities5000.zip) — turns a
 *                city *name* (from LACNIC above) into real coordinates and
 *                an admin1/admin2 code. Infrastructure, not a "signal" of
 *                its own: never used live, downloaded once and kept local.
 *                See lib/geocode.ts.
 *  - threat:     Free public abuse / hijacked-block feeds. Stored in
 *                threat_ranges and joined at query time. No source is wired
 *                up here by default — Spamhaus DROP/EDROP, the obvious
 *                candidate, is free to use but its redistribution terms
 *                aren't clear enough to bulk-ingest for a commercial
 *                product without a paid Spamhaus Technology licence; see
 *                SOURCES.md. The table and lookup path stay in place so a
 *                deployment that has that licence (or another threat feed
 *                with clear terms) can populate it without any schema change.
 *  - special-purpose: IANA's IPv4/IPv6 special-purpose address registries —
 *                the static list of private/loopback/documentation/multicast/
 *                etc. ranges (RFC 6890 for v4, RFC 6890+RFC 4291 for v6).
 *                Populates special_purpose_ranges; lets a lookup say "this
 *                isn't a real internet-routable address" instead of just
 *                coming back empty.
 *  - anonymity:  Published address lists for services that stand between a
 *                user and the destination — Tor exits, VPN egress nodes.
 *                Populates anonymity_ranges. Covers only services that
 *                publish; residential/mobile proxy networks deliberately do
 *                not, and no feed fixes that (see the table's own comment).
 *  - verified-bot: Address space a crawler's operator publishes as its own,
 *                so a forged `User-Agent: Googlebot` can be told apart from
 *                the real one — the header is free text, the network is not.
 *                Populates verified_bot_ranges. Every one of these feeds uses
 *                the same JSON shape Google defined, so one parser serves all
 *                of them; only some operators publish at all, so absence
 *                means "unverifiable", never "fake" (see SOURCES.md).
 *  - abuse:      No source of this kind is wired up here any more — abuse
 *                contact and RFC 9092 geofeed discovery both used to run as
 *                batch enrichment against RIPE/APNIC's bulk whois dumps, but
 *                bulk-redistributing that data commercially is exactly what
 *                RIPE's database terms (Art. 4.5) restrict without approval.
 *                Both are now live, per-address RDAP lookups instead — see
 *                `@workspace/lookup`'s `rdap.ts`, called directly from the
 *                request path (same place reverse-DNS already runs live),
 *                write-through cached on the same abuse_contacts/
 *                geofeed_ranges tables this batch source used to populate.
 *                RDAP is the standardised protocol every RIR runs
 *                specifically for individual queries — a different thing
 *                from a bulk dump, and a genuine coverage improvement for
 *                abuse contact besides: ARIN publishes no free bulk dump,
 *                but does answer RDAP queries like every other RIR.
 *  - rpki:       Validated ROA payloads — whether a prefix's observed BGP
 *                origin is the one its holder cryptographically authorised.
 *                The one layer that can contradict another. Populates
 *                rpki_roas.
 *  - derived:    Not a download at all: a metric computed from tables this
 *                project already ingested. Runs as a normal source so it
 *                gets the same job/progress/health reporting, but fetches
 *                nothing and therefore carries no upstream license of its
 *                own. Currently: asn-reach (per-ASN announced-space metrics
 *                aggregated out of bgp_origin_ranges).
 */
export type EnrichmentSourceKind =
  | "asn-name"
  | "bgp-origin"
  | "cloud"
  | "geofeed"
  | "geocoding"
  | "threat"
  | "special-purpose"
  | "anonymity"
  | "verified-bot"
  | "abuse"
  | "rpki"
  | "derived";

export type EnrichmentParser =
  | "ripe-asn-txt"
  | "ris-whois-dump"
  | "aws-json"
  | "gcp-json"
  | "cloudflare-text"
  | "oracle-json"
  | "fastly-json"
  | "digitalocean-geofeed-csv"
  | "rfc8805-geofeed-csv"
  | "lacnic-whois-city"
  | "geonames-cities-zip"
  | "iana-special-csv"
  | "bot-prefixes-json"
  | "tor-exit-list"
  | "azure-service-tags-json"
  | "mullvad-relays-json"
  | "rpki-vrp-json"
  | "asn-reach-sql"
  | "neighborhood-sql"
  | "asn-profile-sql";

/**
 * What a consumer redistributing this project's *database* (not just
 * running their own API against it) needs to know and do — a structured
 * form of what SOURCES.md's "Commercial use" table already says in prose,
 * kept next to the source it describes so the two can't drift apart.
 * See SOURCES.md for the full reasoning behind each entry.
 */
export interface SourceLicense {
  /** Short label for display, e.g. "CC BY 4.0", "Public domain". */
  name: string;
  /** True if redistributing this data requires crediting the source —
   * false doesn't mean "no terms at all", see `note`. */
  attributionRequired: boolean;
  /** Exact text to show wherever attribution is displayed, when required. */
  attributionText?: string;
  /** Any condition worth knowing before shipping commercially. */
  note?: string;
}

export interface EnrichmentSourceConfig {
  id: string;
  displayName: string;
  description: string;
  kind: EnrichmentSourceKind;
  /** Absent for `kind: "derived"` sources, which compute from local tables
   * instead of downloading anything. Every other source requires it. */
  url?: string;
  parser: EnrichmentParser;
  /** For cloud sources: the provider tag stored on each row. */
  provider?: string;
  /** For threat sources: the source tag stored on each row. */
  source?: string;
  /** For cloudflare-text and similar single-family files. */
  family?: 4 | 6;
  /** For threat sources: a category like "hijacked" / "spam". */
  category?: string;
  /** For geofeed sources: confidence (0..1) attached to every ingested row. */
  confidence?: number;
  /** Absent only for `kind: "derived"` sources — everything actually
   * downloaded from somewhere has terms, even "none". */
  license?: SourceLicense;
}

import { loadSourcesRegistry } from "../sources-registry";

const registry = loadSourcesRegistry();

/**
 * The usual footing for a direct-URL RFC 8805 geofeed: the operator serves
 * the file publicly at a stable address and states no terms alongside it.
 *
 * Deliberately not phrased as "no conditions" — the accurate statement is
 * that none were *found*. What makes the use defensible is the format's own
 * purpose: RFC 8805 exists so operators can self-publish location data for
 * geolocation providers to consume, so publishing one is the act of offering
 * it for exactly this. Anything a publisher *does* state (see Netflix below)
 * overrides this and is recorded on its own entry.
 */
const RFC8805_SELF_PUBLISHED: SourceLicense = {
  name: "Self-published RFC 8805 geofeed, no stated terms",
  attributionRequired: false,
  note: "No licence text accompanies the feed. RFC 8805's stated purpose is for operators to publish this data for geolocation use, which is what it is used for here.",
};

export const KNOWN_ENRICHMENT_SOURCES: EnrichmentSourceConfig[] = [
  {
    id: "ripe-asn-names",
    displayName: "RIPE NCC ASN holder names",
    description:
      "Global list mapping each ASN to its registered holder name (org name).",
    kind: "asn-name",
    url: registry.enrichment["ripe-asn-names"]!,
    parser: "ripe-asn-txt",
    license: {
      name: "RIPE NCC terms of use",
      attributionRequired: true,
      attributionText: "ASN names: RIPE NCC (https://www.ripe.net)",
    },
  },
  {
    id: "ris-whois-ipv4",
    displayName: "RIPE RIS whois dump (IPv4)",
    description:
      "Real BGP-announced prefix -> origin ASN mapping, combined from all RIS route collectors. Refreshed daily. Primary source for ASN resolution (Layer 1).",
    kind: "bgp-origin",
    url: registry.enrichment["ris-whois-ipv4"]!,
    parser: "ris-whois-dump",
    family: 4,
    license: {
      name: "RIPE RIS commercial-use terms",
      attributionRequired: true,
      attributionText: "Routing data: RIPE NCC RIS (https://www.ripe.net/analyse/internet-measurements/routing-information-service-ris/)",
      note: "Commercial use is explicitly permitted, conditioned on this credit — see SOURCES.md.",
    },
  },
  {
    id: "ris-whois-ipv6",
    displayName: "RIPE RIS whois dump (IPv6)",
    description:
      "Same as the IPv4 dump, for IPv6. Now that bgp_origin_ranges is a native `inet` column, this is queryable the same way as v4 — previously skipped because the old bigint-range schema couldn't represent 128-bit addresses.",
    kind: "bgp-origin",
    url: registry.enrichment["ris-whois-ipv6"]!,
    parser: "ris-whois-dump",
    family: 6,
    license: {
      name: "RIPE RIS commercial-use terms",
      attributionRequired: true,
      attributionText: "Routing data: RIPE NCC RIS (https://www.ripe.net/analyse/internet-measurements/routing-information-service-ris/)",
    },
  },
  {
    // Ordered before lacnic-whois-city on purpose: that parser matches city
    // names against this table as it ingests, so this needs to be populated
    // first for coordinates to resolve on the very first run (matching
    // still degrades safely — null lat/lon, never a guess — if run out of
    // order or before this has ever completed).
    id: "geonames-cities",
    displayName: "GeoNames city gazetteer",
    description:
      "Free city/place-name database (population > 5000 or capitals), CC BY 4.0. Used to turn a city name from whois text into real coordinates + admin1/admin2 codes. See SOURCES.md.",
    kind: "geocoding",
    url: registry.enrichment["geonames-cities"]!,
    parser: "geonames-cities-zip",
    license: {
      name: "CC BY 4.0",
      attributionRequired: true,
      attributionText: "City data: GeoNames (https://www.geonames.org), CC BY 4.0",
      note: "Attribution must survive redistribution — the one hard requirement in this whole table.",
    },
  },
  {
    id: "lacnic-whois-city",
    displayName: "LACNIC whois city field",
    description:
      "LACNIC (Latin America & Caribbean) uniquely publishes a structured `city:` field directly on IP block records in its bulk whois dump — no free-text parsing needed. Resolved to coordinates via the GeoNames source above.",
    kind: "geofeed",
    url: registry.enrichment["lacnic-whois-city"]!,
    parser: "lacnic-whois-city",
    confidence: 0.75,
    license: {
      name: "LACNIC LAC-2018-3 policy publication",
      attributionRequired: false,
      note: "Published daily under LAC-2018-3 specifically for geolocation use, stated by LACNIC as \"publicly available and free to use\" — a different, unrestricted file from LACNIC's separately gated Bulkwhois product.",
    },
  },
  {
    id: "digitalocean-geofeed",
    displayName: "DigitalOcean IP geofeed",
    description:
      "DigitalOcean's self-published RFC 8805 geofeed for their own datacenter ranges. Populates both cloud_ranges (Layer 4: this is a datacenter, not a residential user) and geofeed_ranges (Layer 2: precise facility city).",
    kind: "geofeed",
    url: registry.enrichment["digitalocean-geofeed"]!,
    parser: "digitalocean-geofeed-csv",
    provider: "digitalocean",
    confidence: 0.85,
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "linode-geofeed",
    displayName: "Linode IP geofeed",
    description:
      "Linode's (Akamai Connected Cloud) self-published RFC 8805 geofeed for their own datacenter ranges. Same dual-purpose shape as the DigitalOcean geofeed above: populates cloud_ranges (Layer 4) and geofeed_ranges (Layer 2) from one file, reusing the same parser.",
    kind: "geofeed",
    url: registry.enrichment["linode-geofeed"]!,
    parser: "digitalocean-geofeed-csv",
    provider: "linode",
    confidence: 0.85,
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "google-geofeed",
    displayName: "Google Cloud IP geofeed",
    description:
      "Google's self-published RFC 8805 geofeed for its Cloud/edge IP space, at a fixed URL — no RIR lookup involved.",
    kind: "geofeed",
    url: registry.enrichment["google-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: RFC8805_SELF_PUBLISHED,
  },
  {
    id: "ntt-geofeed",
    displayName: "NTT (AS2914) IP geofeed",
    description: "NTT Global IP Network's self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["ntt-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: RFC8805_SELF_PUBLISHED,
  },
  {
    id: "cogent-geofeed",
    displayName: "Cogent (AS174) IP geofeed",
    description: "Cogent Communications' self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["cogent-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: RFC8805_SELF_PUBLISHED,
  },
  {
    id: "verizon-geofeed",
    displayName: "Verizon IP geofeed",
    description:
      "Verizon's self-published RFC 8805 geofeed (general feed; Verizon also publishes separate wireline/wireless/5G-home feeds not fetched here).",
    kind: "geofeed",
    url: registry.enrichment["verizon-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: {
      name: "CDLA-Permissive-2.0",
      attributionRequired: false,
      note: "Community Data License Agreement (Permissive) 2.0 — a data licence written for exactly this kind of sharing; commercial use permitted.",
    },
  },
  {
    id: "tmobile-geofeed",
    displayName: "T-Mobile US (AS21928) IP geofeed",
    description: "T-Mobile US's self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["tmobile-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: {
      name: "Apache-2.0",
      attributionRequired: false,
      note: "Permissive; commercial use permitted. Apache-2.0 asks that a copy of the licence accompany redistribution of the work itself — not triggered by serving lookup responses derived from it.",
    },
  },
  {
    id: "netflix-geofeed",
    displayName: "Netflix IP geofeed",
    description: "Netflix's self-published RFC 8805 geofeed for its Open Connect IP space, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["netflix-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: {
      name: "Restricted: geolocation accuracy only",
      attributionRequired: false,
      note: "The feed itself states the data \"may be used only for improving the accuracy of Geo:IP lookups\". That is what this project uses it for, so the use is within the grant — but it is a condition, not an open licence. Do not feed this source into anything other than geolocation (risk scoring, infrastructure classification, resale as a dataset) without revisiting it.",
    },
  },
  {
    id: "vultr-geofeed",
    displayName: "Vultr/Constant.com (AS20473) IP geofeed",
    description: "Vultr's self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["vultr-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: RFC8805_SELF_PUBLISHED,
  },
  {
    id: "civo-geofeed",
    displayName: "Civo IP geofeed",
    description: "Civo's self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["civo-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: {
      name: "Self-published RFC 8805 geofeed, no licence file",
      attributionRequired: false,
      note: "Repository states the feed exists to serve as Civo's authoritative geofeed; it carries no LICENSE file.",
    },
  },
  {
    id: "schwarzit-geofeed",
    displayName: "Schwarz IT (Lidl/Kaufland group) IP geofeed",
    description: "Schwarz IT's self-published RFC 8805 geofeed, at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["schwarzit-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: {
      name: "DL-DE->Zero-2.0",
      attributionRequired: false,
      note: "Datenlizenz Deutschland Zero 2.0 — \"Jede Nutzung ist ohne Einschraenkungen oder Bedingungen zulaessig\"; commercial use explicitly allowed, effectively CC0-equivalent.",
    },
  },
  {
    id: "telia-geofeed",
    displayName: "Telia Sweden (AS3301) IP geofeed",
    description: "Telia's self-published RFC 8805 geofeed for its Swedish domestic network (AS3301), at a fixed URL.",
    kind: "geofeed",
    url: registry.enrichment["telia-geofeed"]!,
    parser: "rfc8805-geofeed-csv",
    confidence: 0.85,
    license: RFC8805_SELF_PUBLISHED,
  },
  {
    id: "aws-ip-ranges",
    displayName: "AWS published IP ranges",
    description:
      "Amazon Web Services datacenter / service IP ranges (us-east-1, EC2, S3, etc).",
    kind: "cloud",
    url: registry.enrichment["aws-ip-ranges"]!,
    parser: "aws-json",
    provider: "aws",
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "gcp-ip-ranges",
    displayName: "Google Cloud published IP ranges",
    description: "Google Cloud Platform datacenter IP ranges.",
    kind: "cloud",
    url: registry.enrichment["gcp-ip-ranges"]!,
    parser: "gcp-json",
    provider: "gcp",
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "cloudflare-v4",
    displayName: "Cloudflare IPv4",
    description: "Cloudflare edge / CDN IPv4 prefixes.",
    kind: "cloud",
    url: registry.enrichment["cloudflare-v4"]!,
    parser: "cloudflare-text",
    provider: "cloudflare",
    family: 4,
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "cloudflare-v6",
    displayName: "Cloudflare IPv6",
    description: "Cloudflare edge / CDN IPv6 prefixes.",
    kind: "cloud",
    url: registry.enrichment["cloudflare-v6"]!,
    parser: "cloudflare-text",
    provider: "cloudflare",
    family: 6,
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "oracle-ip-ranges",
    displayName: "Oracle Cloud published IP ranges",
    description: "Oracle Cloud Infrastructure (OCI) datacenter/service ranges, by region.",
    kind: "cloud",
    url: registry.enrichment["oracle-ip-ranges"]!,
    parser: "oracle-json",
    provider: "oracle",
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "fastly-ip-ranges",
    displayName: "Fastly published IP ranges",
    description: "Fastly CDN edge IP ranges (IPv4 + IPv6).",
    kind: "cloud",
    url: registry.enrichment["fastly-ip-ranges"]!,
    parser: "fastly-json",
    provider: "fastly",
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "iana-ipv4-special",
    displayName: "IANA IPv4 special-purpose registry",
    description:
      "Static list of private/loopback/documentation/multicast/etc. IPv4 ranges (RFC 6890). Rarely changes; useful to flag 'not a real internet address' distinctly from 'no data'.",
    kind: "special-purpose",
    url: registry.enrichment["iana-ipv4-special"]!,
    parser: "iana-special-csv",
    family: 4,
    license: { name: "Public registry data", attributionRequired: false },
  },
  {
    id: "iana-ipv6-special",
    displayName: "IANA IPv6 special-purpose registry",
    description: "Same as the IPv4 registry, for IPv6 (RFC 6890 + RFC 4291).",
    kind: "special-purpose",
    url: registry.enrichment["iana-ipv6-special"]!,
    parser: "iana-special-csv",
    family: 6,
    license: { name: "Public registry data", attributionRequired: false },
  },
  {
    id: "azure-ip-ranges",
    displayName: "Azure published IP ranges",
    description:
      "Microsoft Azure datacenter/service ranges from the weekly Service Tags file. The registry URL is the download *page*, not the JSON: Microsoft dates the filename (ServiceTags_Public_YYYYMMDD.json) and rotates it weekly, so the parser resolves the current link first.",
    kind: "cloud",
    url: registry.enrichment["azure-ip-ranges"]!,
    parser: "azure-service-tags-json",
    provider: "azure",
    license: { name: "Published for public consumption", attributionRequired: false },
  },
  {
    id: "googlebot",
    displayName: "Googlebot",
    description:
      "Google's primary search crawler.",
    kind: "verified-bot",
    url: registry.enrichment["googlebot"]!,
    parser: "bot-prefixes-json",
    provider: "googlebot",
    source: "Google",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "google-special-crawlers",
    displayName: "Google special crawlers",
    description:
      "Google crawlers serving specific products (AdsBot, Google-Safety, …) rather than general search.",
    kind: "verified-bot",
    url: registry.enrichment["google-special-crawlers"]!,
    parser: "bot-prefixes-json",
    provider: "googlebot-special",
    source: "Google",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "google-user-triggered",
    displayName: "Google user-triggered fetchers",
    description:
      "Fetches Google makes on a user's behalf (site verification, feed fetching) rather than autonomous crawling — a different trust question from a crawler.",
    kind: "verified-bot",
    url: registry.enrichment["google-user-triggered"]!,
    parser: "bot-prefixes-json",
    provider: "google-user-triggered",
    source: "Google",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "bingbot",
    displayName: "Bingbot",
    description:
      "Microsoft Bing's search crawler.",
    kind: "verified-bot",
    url: registry.enrichment["bingbot"]!,
    parser: "bot-prefixes-json",
    provider: "bingbot",
    source: "Microsoft",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "applebot",
    displayName: "Applebot",
    description:
      "Apple's crawler for Siri and Spotlight suggestions.",
    kind: "verified-bot",
    url: registry.enrichment["applebot"]!,
    parser: "bot-prefixes-json",
    provider: "applebot",
    source: "Apple",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "gptbot",
    displayName: "GPTBot",
    description:
      "OpenAI's crawler for model training data.",
    kind: "verified-bot",
    url: registry.enrichment["gptbot"]!,
    parser: "bot-prefixes-json",
    provider: "gptbot",
    source: "OpenAI",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "oai-searchbot",
    displayName: "OAI-SearchBot",
    description:
      "OpenAI's crawler for search results in ChatGPT.",
    kind: "verified-bot",
    url: registry.enrichment["oai-searchbot"]!,
    parser: "bot-prefixes-json",
    provider: "oai-searchbot",
    source: "OpenAI",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "chatgpt-user",
    displayName: "ChatGPT-User",
    description:
      "Fetches ChatGPT makes when a user asks it to visit a page.",
    kind: "verified-bot",
    url: registry.enrichment["chatgpt-user"]!,
    parser: "bot-prefixes-json",
    provider: "chatgpt-user",
    source: "OpenAI",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "perplexitybot",
    displayName: "PerplexityBot",
    description:
      "Perplexity's search crawler.",
    kind: "verified-bot",
    url: registry.enrichment["perplexitybot"]!,
    parser: "bot-prefixes-json",
    provider: "perplexitybot",
    source: "Perplexity",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "ahrefsbot",
    displayName: "AhrefsBot",
    description:
      "Ahrefs' SEO backlink crawler — commonly impersonated, and commonly blocked, so telling the real one apart matters either way.",
    kind: "verified-bot",
    url: registry.enrichment["ahrefsbot"]!,
    parser: "bot-prefixes-json",
    provider: "ahrefsbot",
    source: "Ahrefs",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    // Anthropic publishes one combined list covering all three of its
    // crawlers (ClaudeBot — autonomous training crawl, Claude-User —
    // fetches triggered by a user's Claude request, Claude-SearchBot —
    // search indexing) rather than Google's per-crawler split; there is no
    // finer-grained feed to ingest. Re-checked this session: as of when
    // SOURCES.md's "Absence is not a verdict" note was written, Anthropic
    // stated it did not publish IP ranges at all — that changed since (see
    // SOURCES.md's "Verified bots" section for the dated correction).
    id: "anthropic-crawlers",
    displayName: "Anthropic crawlers (ClaudeBot, Claude-User, Claude-SearchBot)",
    description:
      "Anthropic's combined published range for all three of its crawlers/fetchers.",
    kind: "verified-bot",
    url: registry.enrichment["anthropic-crawlers"]!,
    parser: "bot-prefixes-json",
    provider: "claude-crawlers",
    source: "Anthropic",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify these crawlers' identity — consuming it is the documented purpose.",
    },
  },
  {
    // Re-checked this session, same as Anthropic above: Common Crawl did not
    // publish a machine-readable list when SOURCES.md's prior note was
    // written ("Absence is not a verdict" listed it alongside Meta/DuckDuckGo/
    // Yandex/Baidu as unconfirmable). It does now, in the same JSON shape.
    id: "ccbot",
    displayName: "CCBot (Common Crawl)",
    description:
      "Common Crawl's web crawler, used to build the open crawl corpus many AI training pipelines draw from.",
    kind: "verified-bot",
    url: registry.enrichment["ccbot"]!,
    parser: "bot-prefixes-json",
    provider: "ccbot",
    source: "Common Crawl",
    license: {
      name: "Published by the operator for bot verification",
      attributionRequired: false,
      note: "Published specifically so third parties can verify this crawler's identity — consuming it is the documented purpose.",
    },
  },
  {
    id: "tor-exit-nodes",
    displayName: "Tor exit nodes",
    description:
      "The Tor Project's own bulk list of current exit relays. Tor publishes this deliberately — the network is designed to be identifiable at the exit — so it is complete for Tor in a way no proxy list can be for proxies.",
    kind: "anonymity",
    url: registry.enrichment["tor-exit-nodes"]!,
    parser: "tor-exit-list",
    provider: "tor",
    source: "tor-project",
    license: { name: "CC0 / public domain", attributionRequired: false },
  },
  {
    id: "mullvad-relays",
    displayName: "Mullvad VPN relays",
    description:
      "Mullvad publishes its full relay list, including each server's egress address, through a public API. Covers one provider only: this layer can mark traffic leaving a VPN whose operator publishes, and says nothing about the ones that don't.",
    kind: "anonymity",
    url: registry.enrichment["mullvad-relays"]!,
    parser: "mullvad-relays-json",
    provider: "mullvad",
    source: "mullvad",
    license: {
      name: "Public API",
      attributionRequired: false,
      note: "Check Mullvad's own terms before high-volume polling.",
    },
  },
  {
    id: "rpki-vrp",
    displayName: "RPKI validated ROA payloads",
    description:
      "Validated ROA payloads from a public relying-party validator: which ASN each prefix holder has cryptographically authorised to announce their space, and to what length. Lets a lookup say whether the BGP origin it reports is actually authorised — the only signal here that can contradict another.",
    kind: "rpki",
    url: registry.enrichment["rpki-vrp"]!,
    parser: "rpki-vrp-json",
    source: "rpki-client",
    license: { name: "Public validator output", attributionRequired: false },
  },
  {
    // Deliberately last: it aggregates bgp_origin_ranges, so on a full run it
    // must see the freshly ingested RIS dumps above rather than the previous
    // run's routes. Running it alone (`enrich --sources asn-reach`) is fine
    // too — it just recomputes from whatever is currently in that table.
    id: "asn-reach",
    displayName: "ASN reach metrics (derived)",
    description:
      "Per-ASN announced-prefix count, announced IPv4 address space, and route-collector visibility, aggregated locally from bgp_origin_ranges. Computed, not downloaded — no upstream dependency or license. Measures origination footprint, not transit-hierarchy centrality (see asn_reach's schema comment).",
    kind: "derived",
    parser: "asn-reach-sql",
  },
  {
    // Ordered last: it counts rows in the anonymity/threat/bot tables, so it
    // has to run after whatever refreshed them this pass.
    id: "neighborhood-stats",
    displayName: "Neighborhood context (derived)",
    description:
      "Per-block counts of flagged neighbours (Tor, VPN, threat listings, published crawlers) in the /24 or /48 around each address, aggregated locally. Counts, never a score — see neighborhood_stats' schema comment. Computed, not downloaded: no upstream dependency or license.",
    kind: "derived",
    parser: "neighborhood-sql",
  },
  {
    id: "asn-profile",
    displayName: "ASN profile (derived)",
    description:
      "Per-ASN composition: RPKI signing hygiene, country spread, and how much of the network is cloud/Tor/VPN/crawler space. Answers 'what kind of network is this', where asn_reach answers 'how big'. Computed, not downloaded: no upstream dependency or license.",
    kind: "derived",
    parser: "asn-profile-sql",
  },
];

export function findEnrichmentSource(
  id: string,
): EnrichmentSourceConfig | undefined {
  return KNOWN_ENRICHMENT_SOURCES.find((s) => s.id === id);
}
