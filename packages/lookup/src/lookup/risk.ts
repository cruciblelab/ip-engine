/**
 * Risk scoring — deliberately not a black box.
 *
 * Commercial IP-intelligence products sell a single "fraud score" produced
 * by a model trained on live traffic across many customers. This project
 * cannot reproduce that and does not pretend to: it holds bulk published
 * data, not behavioural telemetry, and no number of extra feeds turns one
 * into the other.
 *
 * What it can do — and what a black-box score cannot — is show its working.
 * Every point of the score below comes from one named, independently
 * checkable signal already in the response, and `reasons` lists exactly
 * which ones fired. A caller who disagrees with a weight can re-derive the
 * score from fields they can see, rather than filing a support ticket.
 *
 * Read the number as "how many independent signals say be careful", not as
 * a probability of fraud. It is not calibrated against outcomes, because
 * calibrating it would require the very outcome data this project doesn't
 * collect. Anything genuinely security-critical should treat this as one
 * input beside a specialist service, not as a verdict — see SOURCES.md.
 */

export interface RiskAssessment {
  /** 0-100. Higher means more signals point at "not an ordinary user". */
  score: number;
  /** Machine-readable reason codes, each worth the points shown below. */
  reasons: string[];
  /** "low" | "medium" | "high" — banded from `score` for callers that want
   * a coarse answer without picking their own thresholds. */
  level: "low" | "medium" | "high";
}

export interface RiskInputs {
  threatSources: string[];
  isTor: boolean;
  isVpn: boolean;
  isCloudOrHosting: boolean;
  isAnycast: boolean;
  hasReverseDns: boolean;
  /** RPKI validity of the observed origin, when known. */
  rpkiStatus: "valid" | "invalid" | "not-found" | null;
  /** Special-purpose (private/reserved) space appearing as a public source
   * address is itself anomalous. */
  isSpecialPurpose: boolean;
}

/**
 * Weights are deliberately coarse and hand-set. They encode judgements
 * anyone can argue with, which is the point — a hidden weight nobody can
 * inspect would be worse even if it were better tuned.
 */
const WEIGHTS = {
  /** Cryptographically invalid origin: the strongest single signal here,
   * because it means the announcement contradicts the holder's own signed
   * statement — the signature of a hijack, not a reputation judgement. */
  rpki_invalid: 40,
  /** Listed by a threat feed. Scales with how many independent feeds agree,
   * which is why the threat layer stores the source per row. */
  threat_listed_first: 30,
  threat_listed_additional: 10,
  /** Tor exit: not wrongdoing, but the operator has chosen to be
   * unattributable, which changes what a risk decision can rely on. */
  tor_exit: 20,
  /** Published VPN egress: same reasoning, weaker — VPN use is ordinary. */
  vpn_egress: 10,
  /** Private/reserved space seen as a public source address is spoofed or
   * misconfigured; either way it is not a normal client. */
  special_purpose_as_source: 15,
  /** Datacenter rather than consumer access. Common for bots and scrapers,
   * but also for every legitimate server, so it stays small. */
  datacenter: 10,
  /** No PTR record. Weak on its own — plenty of ordinary networks omit it —
   * so it only nudges. */
  no_reverse_dns: 5,
} as const;

export function assessRisk(input: RiskInputs): RiskAssessment {
  const reasons: string[] = [];
  let score = 0;

  if (input.rpkiStatus === "invalid") {
    score += WEIGHTS.rpki_invalid;
    reasons.push("rpki_invalid");
  }

  if (input.threatSources.length > 0) {
    score += WEIGHTS.threat_listed_first;
    reasons.push("threat_listed");
    const extra = input.threatSources.length - 1;
    if (extra > 0) {
      score += extra * WEIGHTS.threat_listed_additional;
      reasons.push(`threat_listed_by_${input.threatSources.length}_sources`);
    }
  }

  if (input.isTor) {
    score += WEIGHTS.tor_exit;
    reasons.push("tor_exit");
  } else if (input.isVpn) {
    // Not additive with Tor: an address is one or the other in practice, and
    // charging for both would double-count the same "unattributable" fact.
    score += WEIGHTS.vpn_egress;
    reasons.push("vpn_egress");
  }

  if (input.isSpecialPurpose) {
    score += WEIGHTS.special_purpose_as_source;
    reasons.push("special_purpose_as_source");
  }

  // Anycast addresses are infrastructure (resolvers, CDN edges), so being a
  // datacenter tells you nothing extra about them — skip rather than charge.
  if (input.isCloudOrHosting && !input.isAnycast) {
    score += WEIGHTS.datacenter;
    reasons.push("datacenter");
  }

  if (!input.hasReverseDns) {
    score += WEIGHTS.no_reverse_dns;
    reasons.push("no_reverse_dns");
  }

  score = Math.min(100, score);
  const level = score >= 60 ? "high" : score >= 25 ? "medium" : "low";
  return { score, reasons, level };
}
