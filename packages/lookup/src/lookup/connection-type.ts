/**
 * Connection type — an honest heuristic, labelled as one.
 *
 * MaxMind sells a separate Connection Type database (cable/DSL, cellular,
 * corporate, dialup). There is no free bulk equivalent, and there is no way
 * to derive one properly: the fact is a property of the physical access
 * network, and nothing published in bulk records it.
 *
 * What *is* derivable is a guess from two things this project already has —
 * the ASN holder's name and the address's PTR record. Network operators name
 * things descriptively far more often than not ("... Mobile", "dsl-...",
 * "cable-..."), so pattern-matching them recovers a usable signal for a
 * decent fraction of addresses and nothing at all for the rest.
 *
 * The contract that makes this acceptable rather than sloppy: it returns
 * `null` when no pattern matches, never a default, and every non-null answer
 * carries `confidence: "heuristic"`. A caller can therefore always tell a
 * guess from a fact, which is the same rule the geo layer follows with
 * `geo_source`. If that distinction gets flattened by a consumer, the field
 * becomes misinformation — so it is deliberately shaped to make flattening
 * it awkward.
 */

export type ConnectionType = "cellular" | "dsl" | "cable" | "fiber" | "corporate" | "hosting";

export interface ConnectionTypeGuess {
  type: ConnectionType;
  /** Always "heuristic" — there is no authoritative source for this field.
   * Present as a literal rather than implied so it survives serialisation
   * into somebody else's schema. */
  confidence: "heuristic";
  /** Which text the guess came from, so it can be argued with. */
  matched: string;
}

/** Ordered: the first pattern to match wins, so put the specific ones first.
 * Cellular before DSL because "lte-dsl-..." style names exist and the mobile
 * signal is the more useful of the two. */
const PATTERNS: Array<{ type: ConnectionType; re: RegExp }> = [
  { type: "cellular", re: /\b(mobile|cellular|wireless|gsm|lte|umts|4g|5g|gprs)\b/i },
  { type: "fiber", re: /\b(fiber|fibre|ftth|fttb|gpon)\b/i },
  { type: "dsl", re: /\b(dsl|adsl|vdsl|pppoe)\b/i },
  { type: "cable", re: /\b(cable|docsis|cbl)\b/i },
  // Named hosting/VPS providers whose ASN names carry only a brand, not a
  // generic keyword like "hosting" or "cloud" — the keyword pattern below
  // silently missed all of these (verified against real ASN names: Vultr,
  // OVH, DigitalOcean, LeaseWeb, Contabo, Linode were all invisible to it).
  { type: "hosting", re: /\b(hetzner|ovh|vultr|digitalocean|contabo|leaseweb|linode|scaleway|kimsufi|hostinger|ionos|netcup)\b/i },
  // \bcloud\d*\b, not \bcloud\b: real ASN names suffix "cloud" with a digit
  // ("HETZNER-CLOUD2-AS"), and \b never matches between two word
  // characters, so the un-suffixed pattern silently missed those too.
  { type: "hosting", re: /\b(hosting|datacenter|datacentre|server|colo|cloud\d*|vps|dedicated)\b/i },
  { type: "corporate", re: /\b(corp|corporate|enterprise|business)\b/i },
];

/**
 * Guess from the ASN name and/or reverse DNS. Returns null when nothing
 * matches — which is the common case and the correct answer.
 */
export function guessConnectionType(
  asnName: string | null,
  reverseDns: string | null,
): ConnectionTypeGuess | null {
  // rDNS first: it describes this specific address, while the ASN name
  // describes the whole network and is the coarser of the two.
  for (const candidate of [reverseDns, asnName]) {
    if (!candidate) continue;
    for (const { type, re } of PATTERNS) {
      const hit = candidate.match(re);
      if (hit) return { type, confidence: "heuristic", matched: hit[0].toLowerCase() };
    }
  }
  return null;
}
