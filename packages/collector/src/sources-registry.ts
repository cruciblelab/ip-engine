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
    "ris-whois-ipv4": "https://www.ris.ripe.net/dumps/riswhoisdump.IPv4.gz",
    "ris-whois-ipv6": "https://www.ris.ripe.net/dumps/riswhoisdump.IPv6.gz",
    "geonames-cities": "https://download.geonames.org/export/dump/cities5000.zip",
    "lacnic-whois-city": "https://ftp.lacnic.net/lacnic/dbase/lacnic.db.gz",
    "digitalocean-geofeed": "https://digitalocean.com/geo/google.csv",
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
    "aws-ip-ranges": "https://ip-ranges.amazonaws.com/ip-ranges.json",
    "gcp-ip-ranges": "https://www.gstatic.com/ipranges/cloud.json",
    "cloudflare-v4": "https://www.cloudflare.com/ips-v4",
    "cloudflare-v6": "https://www.cloudflare.com/ips-v6",
    "oracle-ip-ranges": "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json",
    "fastly-ip-ranges": "https://api.fastly.com/public-ip-list",
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
