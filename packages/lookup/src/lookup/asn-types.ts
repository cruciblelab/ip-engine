/**
 * ASN type classification.
 *
 * ASN holder names are noisy free-form strings, but a small set of pattern
 * matches covers the vast majority of public traffic. Order matters:
 * earlier matches win, so put the most specific patterns first.
 *
 * Used to:
 *   - Backfill `asn_blocks.type` during enrichment (one shot per ASN)
 *   - Provide a default `usage_type` signal for IPs whose covering CIDR is
 *     not in any cloud / threat / anycast list.
 */

export type AsnType =
  | "hosting"
  | "isp"
  | "mobile"
  | "enterprise"
  | "cdn"
  | "other";

interface Rule {
  type: AsnType;
  /** Compiled once at module load. */
  pattern: RegExp;
  /** Confidence we attach to the resulting usage_type. 0..1. */
  confidence: number;
}

/**
 * Pattern set is intentionally small and tuned for high precision over
 * recall. False positives cost more than misses here because operators
 * rely on `usage_type` to make routing / blocking decisions.
 */
const RULES: Rule[] = [
  // CDN / edge networks (must come before generic hosting since their
  // names often contain "cloud" / "networks" too).
  { type: "cdn", pattern: /\b(cloudflare|fastly|akamai|cdn|edgio|stackpath|incapsula|cdn77|bunny\s*cdn|keycdn)\b/i, confidence: 0.95 },

  // Big public clouds — high signal hosting.
  { type: "hosting", pattern: /\b(amazon|aws|amazon\s*web\s*services|amazon\.com)\b/i, confidence: 0.97 },
  { type: "hosting", pattern: /\b(google|google\s*llc|google\s*cloud)\b/i, confidence: 0.95 },
  { type: "hosting", pattern: /\b(microsoft|azure)\b/i, confidence: 0.95 },
  { type: "hosting", pattern: /\b(oracle\s*(cloud|corporation)|alibaba|tencent\s*cloud|huawei\s*cloud|ibm\s*cloud|softlayer)\b/i, confidence: 0.93 },

  // Generic hosting / colocation / VPS providers.
  { type: "hosting", pattern: /\b(digitalocean|linode|vultr|hetzner|ovh|leaseweb|scaleway|contabo|hostinger|godaddy|ionos|namecheap|m247|psychz|choopa|datapacket|colocation|colocrossing|incero)\b/i, confidence: 0.92 },
  { type: "hosting", pattern: /\b(hosting|datacenter|data\s*center|server|servers|vps|cloud\s*server|dedicated)\b/i, confidence: 0.7 },

  // Mobile carriers (must come before generic ISP since names overlap).
  { type: "mobile", pattern: /\b(verizon\s*wireless|at&t\s*mobility|t-mobile|sprint|vodafone|orange\s*mobile|telekom|movistar|mts|megafon|jio|airtel|ntt\s*docomo|softbank\s*mobile|china\s*mobile|china\s*unicom|china\s*telecom\s*mobile)\b/i, confidence: 0.9 },
  { type: "mobile", pattern: /\b(mobile|wireless|cellular|gsm|lte|3gpp)\b/i, confidence: 0.65 },

  // Consumer ISPs.
  { type: "isp", pattern: /\b(comcast|charter|spectrum|cox|verizon\s*fios|frontier|centurylink|at&t\s*services|bt\s*group|sky|virgin\s*media|deutsche\s*telekom|free\s*sas|ono|orange|telefonica|vodafone|kpn|swisscom|kddi|ntt|china\s*telecom|china\s*unicom)\b/i, confidence: 0.88 },
  { type: "isp", pattern: /\b(broadband|cable|fiber|fibre|dsl|fttp|fttx|residential\s*broadband|isp|internet\s*service)\b/i, confidence: 0.75 },

  // Enterprise / private networks.
  { type: "enterprise", pattern: /\b(corporation|corp|inc\.?|ltd|limited|llc|gmbh|s\.a\.|holdings|enterprise|university|college|government|federal|ministry|bank|insurance)\b/i, confidence: 0.55 },
];

/**
 * Classify an ASN holder name into a usage type and assign a confidence
 * score. Returns `{ type: 'other', confidence: 0.2 }` when nothing matches.
 */
export function classifyAsnName(rawName: string | null | undefined): {
  type: AsnType;
  confidence: number;
} {
  if (!rawName) return { type: "other", confidence: 0.2 };
  const name = rawName.trim();
  if (!name) return { type: "other", confidence: 0.2 };
  for (const rule of RULES) {
    if (rule.pattern.test(name)) {
      return { type: rule.type, confidence: rule.confidence };
    }
  }
  return { type: "other", confidence: 0.2 };
}

/**
 * Map a cloud-provider tag (as stored in cloud_ranges.provider) onto an
 * `AsnType`. CDN providers map to "cdn"; everything else is "hosting".
 */
export function asnTypeForCloudProvider(provider: string): AsnType {
  const p = provider.toLowerCase();
  if (p === "cloudflare" || p === "fastly" || p === "akamai") return "cdn";
  return "hosting";
}
