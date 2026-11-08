/**
 * Single source of truth for every URL this project fetches from — every
 * RIR delegated-stats file and every enrichment feed. `KNOWN_SOURCES`
 * (collection/sources.ts) and `KNOWN_ENRICHMENT_SOURCES`
 * (enrichment/enrichment-sources.ts) hold everything else about a source
 * (id, parser, kind, …) but pull the `url` from here — so an upstream URL
 * changing is a one-line edit in one file, not a hunt across two.
 *
 * This project is fully open source (MIT) and meant to be forked/self-hosted
 * by anyone, including as the base of someone else's commercial product —
 * so the registry is overridable *without* touching source or rebuilding:
 * drop a `sources.registry.json` next to where you run the command (or
 * point `IP_INSIGHT_SOURCES_REGISTRY` at one) and override just the keys you
 * need, e.g. to point at an internal mirror:
 *
 *   { "enrichment": { "geonames-cities": "https://mirror.internal/cities5000.zip" } }
 *
 * Unspecified keys keep using the defaults below — this is a shallow merge
 * per top-level section (collection/enrichment), not a full replace.
 *
 * Read once and cached for the process's lifetime: `KNOWN_SOURCES`/
 * `KNOWN_ENRICHMENT_SOURCES` are plain arrays built once at module load
 * (their `url` fields come from here at that point), not re-evaluated per
 * call — unlike the rest of this package's config, which re-reads on every
 * `collect`/`enrich`. Restart the process to pick up an edited URL.
 */
import { readNamedJsonFile, resolveNamedJsonPath } from "@workspace/shared";

export interface SourcesRegistry {
  collection: Record<string, string>;
  enrichment: Record<string, string>;
}

export const DEFAULT_SOURCES_REGISTRY: SourcesRegistry = {
  collection: {
    arin: "https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
    ripencc: "https://ftp.ripe.net/ripe/stats/delegated-ripencc-extended-latest",
    apnic: "https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest",
    lacnic: "https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest",
    afrinic: "https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest",
  },
  enrichment: {
    "ripe-asn-names": "https://ftp.ripe.net/ripe/asnames/asn.txt",
    // Fallback-tier base URL only, for display/attribution. The real
    // monthly-dated download URL is resolved by ingestCaidaAsnOrgTxt itself,
    // same pattern as dbip-lite's own bootstrap URL below.
    "caida-asn-names": "https://publicdata.caida.org/datasets/as-organizations/",
    "ris-whois-ipv4": "https://www.ris.ripe.net/dumps/riswhoisdump.IPv4.gz",
    "ris-whois-ipv6": "https://www.ris.ripe.net/dumps/riswhoisdump.IPv6.gz",
    // Archive roots, not files: the dated RIB URL
    // (YYYY.MM/RIBS/rib.YYYYMMDD.HHMM.bz2) is resolved by
    // ingestRouteViewsRib from the directory listing, same pattern as
    // caida-asn-names and dbip-lite.
    "routeviews-rib-ipv4": "https://archive.routeviews.org/route-views2/bgpdata/",
    "routeviews-rib-ipv6": "https://archive.routeviews.org/route-views6/bgpdata/",
    "geonames-cities": "https://download.geonames.org/export/dump/cities5000.zip",
    "lacnic-whois-city": "https://ftp.lacnic.net/lacnic/dbase/lacnic.db.gz",
    "digitalocean-geofeed": "https://digitalocean.com/geo/google.csv",
    // Bootstrap URL only — DB-IP publishes the real IP-to-City Lite file at
    // a month-stamped address that changes every month
    // (dbip-city-lite-YYYY-MM.csv.gz). This just needs to be a URL that
    // resolves so the generic fetch-then-dispatch step succeeds; the
    // ingester (ingestDbIpLiteCsv) does its own fetch(es) against the real,
    // dynamically-computed file, same pattern as azure-service-tags-json.
    "dbip-lite": "https://db-ip.com/db/lite.php",
    // Linode/Akamai Connected Cloud's self-published RFC 8805 geofeed for
    // its own datacenter ranges — same dual-purpose shape as DigitalOcean's
    // above (feeds cloud_ranges and geofeed_ranges from one file).
    "linode-geofeed": "https://geoip.linode.com/",
    // Direct-URL RFC 8805 geofeeds: fixed addresses the publisher itself
    // serves, discovered via research rather than RIR RDAP — no RIR
    // involvement, no rate limit, see SOURCES.md.
    "google-geofeed": "https://www.gstatic.com/ipranges/cloud_geofeed",
    "ntt-geofeed": "https://geo.ip.gin.ntt.net/geofeeds/geofeeds.csv",
    "cogent-geofeed": "https://geofeed.cogentco.com/geofeed.csv",
    "verizon-geofeed": "https://raw.githubusercontent.com/Verizon/verizon-geofeed/main/feed.csv",
    "tmobile-geofeed": "https://raw.githubusercontent.com/tmobile/tmus-geofeed/main/tmus-geo-ip.txt",
    "netflix-geofeed": "https://raw.githubusercontent.com/Netflix/nflx-geofeed/main/geofeed.csv",
    "vultr-geofeed": "https://geofeed.constant.com/",
    "civo-geofeed": "https://raw.githubusercontent.com/civo/geofeed/master/civo-geofeed.csv",
    "schwarzit-geofeed": "https://raw.githubusercontent.com/SchwarzIT/geofeeds/main/geofeed.csv",
    "telia-geofeed": "https://lg.telia.net/ripe/AS3301_geofeed.csv",
    // Round 2 (2026-08-04): five more direct-URL geofeeds, found via RIPE's
    // full-text search API surfacing each operator's own `remarks: Geofeed`
    // line, every one confirmed live at this exact URL before adding.
    "gtt-geofeed": "https://geolocation.gtt.net/gtt_geolocation.csv",
    "charter-geofeed": "https://s3.amazonaws.com/charter-geo-feed/Charter-Geofeed.csv",
    // Fastly also has an RFC 8805 geofeed, distinct from the cloud-ranges
    // JSON file at "fastly-ip-ranges" below (same operator, two different
    // feeds serving two different layers — see SOURCES.md).
    "fastly-geofeed": "https://ip-geolocation.fastly.com/",
    // EU entities only, not Zayo globally — the feed itself only covers
    // Zayo's European operating companies. Final host is a Zayo-controlled
    // Google Sheets CSV export, not zayo.com directly; zayo.is/eu-geofeeds
    // is Zayo's own redirect to it.
    "zayo-eu-geofeed": "https://zayo.is/eu-geofeeds",
    // Orange Luxembourg deliberately NOT added — see SOURCES.md's "Deep
    // commercial-terms check" note: robots.txt disallows crawling the
    // whole site and the general site terms' reproduction clause has
    // unclear applicability to this data subdomain, combined with low
    // value (small subsidiary, few rows). Revisit if it becomes worth
    // resolving the ambiguity for.
    "aws-ip-ranges": "https://ip-ranges.amazonaws.com/ip-ranges.json",
    "gcp-ip-ranges": "https://www.gstatic.com/ipranges/cloud.json",
    "cloudflare-v4": "https://www.cloudflare.com/ips-v4",
    "cloudflare-v6": "https://www.cloudflare.com/ips-v6",
    "oracle-ip-ranges": "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json",
    "fastly-ip-ranges": "https://api.fastly.com/public-ip-list",
    // Yandex Cloud CDN deliberately NOT added — see SOURCES.md's "Deep
    // commercial-terms check" note: no restriction on the data itself,
    // but its contracting/infrastructure entities are Russia/Serbia-based
    // (post-2024 Nebius split) — a jurisdictional/compliance question for
    // the operator, not a licensing one this project can resolve alone.
    // Revisit if a deployment's own context clears this.
    // Bunny.net's edge-server list: bare host addresses (no CIDR prefix),
    // one endpoint per family — stored as each address's own /32 or /128,
    // see the "bunny-cdn-json" parser.
    "bunny-cdn-v4": "https://bunnycdn.com/api/system/edgeserverlist",
    "bunny-cdn-v6": "https://bunnycdn.com/api/system/edgeserverlist/IPv6",
    "iana-ipv4-special":
      "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv",
    "iana-ipv6-special":
      "https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv",
    "tor-exit-nodes": "https://check.torproject.org/torbulkexitlist",
    // Verified-bot lists: each crawler operator publishes its own address
    // space so a forged User-Agent can be told from the real thing. All
    // share Google's JSON shape (see the bot-prefixes-json parser).
    "googlebot": "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
    "google-special-crawlers":
      "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
    "google-user-triggered":
      "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json",
    "bingbot": "https://www.bing.com/toolbox/bingbot.json",
    "applebot": "https://search.developer.apple.com/applebot.json",
    "gptbot": "https://openai.com/gptbot.json",
    "oai-searchbot": "https://openai.com/searchbot.json",
    "chatgpt-user": "https://openai.com/chatgpt-user.json",
    "perplexitybot": "https://www.perplexity.ai/perplexitybot.json",
    "ahrefsbot": "https://api.ahrefs.com/v3/public/crawler-ip-ranges",
    // Same Google-defined JSON shape as the feeds above. Re-verified this
    // session — as of when SOURCES.md's "checked, not added" note was
    // written, neither operator published one; both do now (see the
    // "Verified bots" section of SOURCES.md for what changed and when).
    "anthropic-crawlers": "https://claude.com/crawling/bots.json",
    "ccbot": "https://index.commoncrawl.org/ccbot.json",
    // Microsoft dates the filename and changes it weekly, so this points at
    // the download *page*; the parser scrapes the current JSON URL out of it.
    "azure-ip-ranges": "https://www.microsoft.com/en-us/download/details.aspx?id=56519",
    "mullvad-relays": "https://api.mullvad.net/www/relays/all/",
    "rpki-vrp": "https://console.rpki-client.org/vrps.json",
    // abuse.ch Feodo Tracker's non-aggressive blocklist — deliberately not
    // the "aggressive" variant, which Feodo Tracker's own page warns has a
    // materially higher false-positive rate from address reuse/recycling.
    "feodotracker": "https://feodotracker.abuse.ch/downloads/ipblocklist.json",
  },
};

let cached: SourcesRegistry | null = null;

function mergeSection(
  defaults: Record<string, string>,
  override: unknown,
  section: string,
): Record<string, string> {
  if (override === undefined) return defaults;
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error(`sources.registry.json: "${section}" must be an object of id -> url`);
  }
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`sources.registry.json: "${section}.${key}" must be a string URL`);
    }
    merged[key] = value;
  }
  return merged;
}

export function loadSourcesRegistry(): SourcesRegistry {
  if (cached) return cached;
  const overridePath = resolveNamedJsonPath("IP_INSIGHT_SOURCES_REGISTRY", "sources.registry.json");
  const file = readNamedJsonFile(overridePath, "sources.registry.json");
  if (!file) {
    cached = DEFAULT_SOURCES_REGISTRY;
    return cached;
  }
  cached = {
    collection: mergeSection(DEFAULT_SOURCES_REGISTRY.collection, file.obj["collection"], "collection"),
    enrichment: mergeSection(DEFAULT_SOURCES_REGISTRY.enrichment, file.obj["enrichment"], "enrichment"),
  };
  return cached;
}
