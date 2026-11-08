/**
 * Usage-type classification engine.
 *
 * Combines every signal we have for an IP — anycast match, cloud-provider
 * range match, threat-list match, ASN holder name — and produces:
 *
 *   - usage_type:               residential | mobile | hosting | cdn |
 *                               enterprise | vpn | proxy | null
 *                               (null means no signal matched — an honest
 *                               "don't know", never defaulted to a guess;
 *                               see the "6. Final fallback" comment below)
 *   - classification_confidence (0..1): how sure we are about that label
 *   - flags:                    deduplicated array of tags surfaced to
 *                               callers (anycast, hosting, vpn, threat,
 *                               cloud:aws, cdn:cloudflare, …)
 *
 * Signal precedence (strongest first):
 *   1. Anycast prefix          → overrides geo, contributes "anycast" flag
 *   2. Cloudflare/Akamai/Fastly cloud range → cdn  (high confidence)
 *   3. Other cloud range (aws/gcp/azure)    → hosting (high confidence)
 *   4. Threat list match       → vpn / proxy if category hints, else
 *                                keeps base usage_type but adds threat
 *                                flags
 *   5. ASN name pattern        → fallback signal (medium / low confidence)
 *   6. Reverse-DNS hint        → tie-breaker only (optional, see notes)
 *
 * Confidence scoring rule when multiple signals agree:
 *   final = 1 - product(1 - confidence_i)   (independence-style fusion)
 *
 * Performance: pure in-memory work. Typical call < 50µs.
 */

import { classifyAsnName, asnTypeForCloudProvider, type AsnType } from "./asn-types";

export type UsageType =
  | "residential"
  | "mobile"
  | "hosting"
  | "cdn"
  | "enterprise"
  | "vpn"
  | "proxy";

export interface ClassificationSignals {
  anycast: { label: string | null; operator: string | null } | null;
  cloud: {
    provider: string;
    service: string | null;
    region: string | null;
  } | null;
  threat: {
    source: string;
    category: string | null;
  } | null;
  asn: {
    number: number | null;
    name: string | null;
  } | null;
  /** Reverse-DNS hostname when available; used only as a low-weight tiebreaker. */
  reverseDns?: string | null;
}

export interface UsageTypeFlags {
  hosting: boolean;
  residential: boolean;
  mobile: boolean;
  cdn: boolean;
  vpn: boolean;
  proxy: boolean;
}

export interface ClassificationResult {
  usageType: UsageType | null;
  flags: string[];
  /** Per-classification confidence, 0..1. */
  confidence: number;
  /** Boolean view of the usage_type required by the API spec. */
  usageBooleans: UsageTypeFlags;
}

interface SignalContribution {
  type: UsageType;
  /** Confidence the signal is correct on its own. */
  confidence: number;
}

// "other" is deliberately absent: it used to map to "hosting" here on the
// same "conservative default" theory the step-6 fallback below carried, and
// it was actually the *primary* site of that bug — this map is consulted in
// step 4, before step 6 ever runs, so most "other" ASN names were already
// being turned into a confident (if low-score) "hosting" guess right here.
// classifyAsnName's own contract is to return "other" for "no signal
// matched" (see asn-types.ts); an unmapped type below is handled explicitly
// in step 4 by contributing nothing, leaving usageType null for the next
// signal (or the caller) to decide honestly.
const ASN_TO_USAGE: Readonly<Record<Exclude<AsnType, "other">, UsageType>> = {
  hosting: "hosting",
  cdn: "cdn",
  isp: "residential",
  mobile: "mobile",
  enterprise: "enterprise",
};

/** Fuse independent confidences without exceeding 1.0. */
function fuseConfidences(values: number[]): number {
  if (values.length === 0) return 0;
  let inv = 1;
  for (const v of values) {
    const clamped = Math.max(0, Math.min(1, v));
    inv *= 1 - clamped;
  }
  return Number((1 - inv).toFixed(3));
}

/** Reverse-DNS heuristics — purely additive, never used to override a strong signal. */
function reverseDnsSignal(hostname: string): SignalContribution | null {
  const h = hostname.toLowerCase();
  if (/\bcompute\.amazonaws\.com$/.test(h)) return { type: "hosting", confidence: 0.95 };
  if (/\b\.googleusercontent\.com$/.test(h) || /\.bc\.googleusercontent\.com$/.test(h))
    return { type: "hosting", confidence: 0.95 };
  if (/\.cloudfront\.net$/.test(h)) return { type: "cdn", confidence: 0.95 };
  if (/\.cloudflare\.com$/.test(h)) return { type: "cdn", confidence: 0.95 };
  if (/\.akamai(?:edge|technologies)?\.net$/.test(h)) return { type: "cdn", confidence: 0.95 };
  if (/\.fastly\.net$/.test(h)) return { type: "cdn", confidence: 0.95 };
  if (/\.azure(?:websites|edge)\.net$/.test(h) || /\.cloudapp\.net$/.test(h))
    return { type: "hosting", confidence: 0.92 };
  if (/\.vpn\b|\bvpn\./.test(h)) return { type: "vpn", confidence: 0.7 };
  if (/\bproxy\b/.test(h)) return { type: "proxy", confidence: 0.7 };
  if (
    /\b(cable|fiber|fibre|broadband|dsl|fttp|res|residential|dynamic|dyn|pppoe|cpe|dhcp|client|customer|home)\b/.test(
      h,
    )
  )
    return { type: "residential", confidence: 0.6 };
  if (/\b(mobile|wireless|lte|3g|4g|5g)\b/.test(h))
    return { type: "mobile", confidence: 0.6 };
  return null;
}

/**
 * Decide what a threat-list category implies. Spamhaus DROP for example
 * does NOT mean the IP is a VPN, only that the prefix is hijacked. We
 * therefore keep the base usage_type and just surface threat flags. When
 * the upstream feed explicitly tags vpn/proxy/tor we promote it.
 */
function threatSignal(
  threat: ClassificationSignals["threat"],
): SignalContribution | null {
  if (!threat) return null;
  const tag = `${threat.source} ${threat.category ?? ""}`.toLowerCase();
  if (/\bvpn\b/.test(tag)) return { type: "vpn", confidence: 0.85 };
  if (/\b(proxy|open[-_ ]?proxy)\b/.test(tag))
    return { type: "proxy", confidence: 0.85 };
  if (/\btor\b/.test(tag)) return { type: "proxy", confidence: 0.8 };
  return null;
}

/**
 * Main entry point. Synchronous, pure-in-memory — the lookup pipeline can
 * call it once per response with no measurable overhead.
 */
export function classify(signals: ClassificationSignals): ClassificationResult {
  const flagSet = new Set<string>();
  const contributions: SignalContribution[] = [];
  let usageType: UsageType | null = null;
  let topConfidence = 0;

  // 1. Anycast — supplemental, not a usage type. CDN networks heavily use
  //    anycast so we'll mark `anycast` and let the cloud / ASN signal pick
  //    the actual usage_type below.
  if (signals.anycast) {
    flagSet.add("anycast");
    if (signals.anycast.operator) flagSet.add(signals.anycast.operator.toLowerCase());
  }

  // 2. Cloud provider match — strongest deterministic signal.
  if (signals.cloud) {
    const provider = signals.cloud.provider.toLowerCase();
    flagSet.add(`cloud:${provider}`);
    flagSet.add(provider);
    const asnLikeType = asnTypeForCloudProvider(provider);
    const ut: UsageType = asnLikeType === "cdn" ? "cdn" : "hosting";
    const c = ut === "cdn" ? 0.97 : 0.95;
    contributions.push({ type: ut, confidence: c });
    if (!usageType || c > topConfidence) {
      usageType = ut;
      topConfidence = c;
    }
    flagSet.add(ut);
  }

  // 3. Threat — may force usage_type to vpn/proxy when the feed says so.
  const threatSig = threatSignal(signals.threat);
  if (signals.threat) {
    flagSet.add("threat");
    flagSet.add(`threat:${signals.threat.source.toLowerCase()}`);
    if (signals.threat.category) {
      flagSet.add(`threat:${signals.threat.category.toLowerCase()}`);
    }
  }
  if (threatSig) {
    contributions.push(threatSig);
    if (!usageType || threatSig.confidence > topConfidence) {
      usageType = threatSig.type;
      topConfidence = threatSig.confidence;
    }
    flagSet.add(threatSig.type);
  }

  // 4. ASN name — used as a fallback when no cloud/threat signal beat it.
  //    "other" contributes nothing (see ASN_TO_USAGE comment above): no
  //    pattern matched, so there is no signal here to act on.
  if (signals.asn?.name) {
    const asn = classifyAsnName(signals.asn.name);
    if (asn.type !== "other") {
      const ut = ASN_TO_USAGE[asn.type];
      contributions.push({ type: ut, confidence: asn.confidence });
      flagSet.add(ut);
      if (!usageType) {
        usageType = ut;
        topConfidence = asn.confidence;
      }
    }
  }

  // 5. Reverse DNS — last-ditch tiebreaker.
  if (signals.reverseDns) {
    const dns = reverseDnsSignal(signals.reverseDns);
    if (dns) {
      contributions.push({ type: dns.type, confidence: dns.confidence });
      if (!usageType) {
        usageType = dns.type;
        topConfidence = dns.confidence;
      }
      flagSet.add(dns.type);
    }
  }

  // 6. Final fallback — used to force "hosting" here (and, redundantly, in
  // step 4's ASN_TO_USAGE map — see the comment there) on the theory that it
  // was the "conservative default". Measured against this project's own
  // real data (2026-08-05): `classifyAsnName` alone returns "other" (no
  // pattern matched) for 48.3% of the top 3000 ASNs by announced address
  // space — including China Telecom, Korea Telecom, BT, Rostelecom, Turk
  // Telekom, Turkcell, MTN, and most of the world's carriers whose names
  // don't happen to match an English/Western brand pattern — and both this
  // branch and step 4 used to turn every one of those into a confidently
  // labelled "hosting". That is not conservative, it is a specific wrong
  // answer asserted with confidence, and it fed straight into `risk.ts`'s
  // "datacenter" flag for every one of those addresses. `asn-types.ts` was
  // broadened considerably to catch that (a telecom-root pattern that
  // covers ~97% of world carriers, verified against real data, plus named
  // exceptions) specifically so "other" is reached far less often — but for
  // whatever's left after that, `null` is the honest answer, the same rule
  // `connection-type.ts` already follows: absence of a signal is not itself
  // a signal, and every non-null answer here now really means something
  // matched.

  // Confidence is fused over agreeing signals only. Disagreements weaken
  // the chosen label but never to zero.
  const agreeing = contributions
    .filter((c) => c.type === usageType)
    .map((c) => c.confidence);
  const disagreeing = contributions
    .filter((c) => c.type !== usageType)
    .map((c) => c.confidence);

  let confidence = fuseConfidences(agreeing);
  if (disagreeing.length > 0) {
    // Penalize: each conflicting signal shaves up to 30% off.
    const penalty = disagreeing.reduce((acc, c) => acc * (1 - c * 0.3), 1);
    confidence = Number((confidence * penalty).toFixed(3));
  }
  if (confidence === 0) confidence = topConfidence;

  // Boolean view required by the API spec. Mostly mirrors usage_type,
  // but a CDN is also (almost always) hosting, etc.
  const usageBooleans: UsageTypeFlags = {
    hosting: usageType === "hosting" || usageType === "cdn" || flagSet.has("hosting"),
    residential: usageType === "residential",
    mobile: usageType === "mobile",
    cdn: usageType === "cdn" || flagSet.has("cdn"),
    vpn: usageType === "vpn" || flagSet.has("vpn"),
    proxy: usageType === "proxy" || flagSet.has("proxy"),
  };

  // Deduplicate, normalize casing, sort for stable output.
  const flags = Array.from(flagSet, (f) => f.toLowerCase()).sort();

  return {
    usageType,
    flags,
    confidence,
    usageBooleans,
  };
}
