/**
 * Public RIR delegated-extended-stats files.
 * These are authoritative allocation records published daily by each
 * Regional Internet Registry. Each line is pipe-delimited:
 *   registry|cc|type|start|value|date|status[|opaque-id]
 *   header lines start with "2|" or are comments starting with "#"
 *
 * Type can be "ipv4", "ipv6", or "asn".
 *   - ipv4: start = first IP, value = number of addresses (count)
 *   - ipv6: start = first address, value = prefix length (CIDR /N)
 *   - asn:  start = first AS number, value = count
 */
import { loadSourcesRegistry } from "../sources-registry";

export interface KnownSourceConfig {
  rir: string;
  displayName: string;
  region: string;
  url: string;
}

const registry = loadSourcesRegistry();

export const KNOWN_SOURCES: KnownSourceConfig[] = [
  {
    rir: "arin",
    displayName: "ARIN",
    region: "North America",
    url: registry.collection["arin"]!,
  },
  {
    rir: "ripencc",
    displayName: "RIPE NCC",
    region: "Europe / Middle East / Central Asia",
    url: registry.collection["ripencc"]!,
  },
  {
    rir: "apnic",
    displayName: "APNIC",
    region: "Asia Pacific",
    url: registry.collection["apnic"]!,
  },
  {
    rir: "lacnic",
    displayName: "LACNIC",
    region: "Latin America & Caribbean",
    url: registry.collection["lacnic"]!,
  },
  {
    rir: "afrinic",
    displayName: "AFRINIC",
    region: "Africa",
    url: registry.collection["afrinic"]!,
  },
];

export function findSource(rir: string): KnownSourceConfig | undefined {
  return KNOWN_SOURCES.find((s) => s.rir === rir);
}
