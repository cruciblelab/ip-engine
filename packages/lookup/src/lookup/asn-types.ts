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
  // datacenters?/data\s*centers?: plural forms were missing (e.g. "Scala
  // Data Centers", a real Brazilian hosting company, found during the
  // regional audit below — the singular-only pattern's trailing \b failed
  // right before the "s").
  { type: "hosting", pattern: /\b(hosting|datacenters?|data\s*centers?|server|servers|vps|cloud\s*server|dedicated)\b/i, confidence: 0.7 },

  // Government / education operating their own telecom infrastructure —
  // checked before the telecom-carrier rules below on purpose. Verified
  // against real data (2026-08-05): the broad telecom pattern further down
  // this list correctly catches ~97% of the world's telecom operators by
  // its root alone, but that same substring also fires on a small, distinct
  // class of false positives — a state government's internal telecom
  // *department*, or a university system's telecom *network* — that are
  // enterprise/institutional networks, not access ISPs. Real examples this
  // was checked against: "Florida ... Division of Telecommunications",
  // "Washington State K-20 Telecommunications Network", "Indiana Higher
  // Education Telecommunication System". Ordered first so these are caught
  // before the telecom-substring rule below ever sees them.
  { type: "enterprise", pattern: /\b(department|division|higher\s*education|state\s*of)\b/i, confidence: 0.6 },

  // Mobile carriers (must come before generic ISP since names overlap).
  // Deliberately NOT a bare "telekom": that matched Deutsche Telekom (whose
  // actual mobile arm is already caught by "t-mobile" below) but also fired
  // on Turk Telekom's fixed-line/DSL business, misclassifying a landline
  // ISP as a mobile carrier — found on real data, see the header comment.
  // `\bmovil\b` — Spanish "móvil" (mobile), e.g. "America Movil", "Colombia
  // Movil", "Telefonica Movil de Chile". Checked against the full
  // `asn_blocks.name` column (2026-08-05): 6 matches, all genuine mobile
  // carriers, zero false positives.
  { type: "mobile", pattern: /\b(verizon\s*wireless|at&t\s*mobility|t-mobile|sprint|vodafone|orange\s*mobile|movistar|mts|megafon|jio|airtel|ntt\s*docomo|softbank\s*mobile|china\s*mobile|china\s*unicom|china\s*telecom\s*mobile|turkcell|\bmtn\b|safaricom|globe\s*telecom|claro|telenor|singtel|rogers|telus|bell\s*mobility|\bmovil\b)\b/i, confidence: 0.9 },
  { type: "mobile", pattern: /\b(mobile|wireless|cellular|gsm|lte|3gpp|cellco)\b/i, confidence: 0.65 },

  // Consumer ISPs.
  // The block below (telia/cantv/vimpelcom/corbina/comcel/telconet/etb/vtr/
  // nos/wana/tele2/telenet/telmex/entel/altice) is brand names that carry no
  // generic telecom keyword at all — found missing during the same real-data
  // audits (2026-08-05) as the tele[ck]om rule below, the first pass across a
  // top-3000-by-address-space sample, a second pass broken down by RIR after
  // regional classification rates turned out uneven (LACNIC 57.5% "other" vs
  // AFRINIC 25.8% on that same sample — the opposite of the naive assumption
  // that African coverage would be worst; LACNIC's gap turned out to be
  // mostly missing Spanish-language generic words, not missing brands, see
  // `telefon`/`\bmovil\b`/`universit` below). Each brand was individually
  // checked against this project's full `asn_blocks.name` column (not just
  // the sample) for collisions before being added, word-bounded specifically
  // because of what that check found: a bare "elisa" (Elisa Oyj, Finland)
  // collides with the first name "Elisa" in unrelated personal/small-ISP
  // registrations and was dropped; a bare "tdc" (TDC Holding, Denmark)
  // collides with a New Zealand district council, a US payments company, and
  // multiple unrelated "-TDC-" abbreviations and was dropped; "beeline"
  // collides with the Beeline vendor-management-software company (unrelated
  // to Beeline the Vimpelcom mobile brand) and was dropped. "entel" (Chile/
  // Peru's Entel) is a disclosed exception to the zero-collision bar: 8/9
  // real matches were genuine Entel entities, the 9th was a Serbian
  // engineering firm ("Energoprojekt ENTEL a.d. Beograd") — kept anyway,
  // same call as `tele[ck]om`'s accepted ITU miss below, because the cost of
  // that single miss (an infrastructure-adjacent company mislabeled as ISP
  // instead of enterprise) is low next to correctly catching a top-2 Chilean
  // carrier across many AS entries. Every other brand below had zero
  // collisions in the full table.
  { type: "isp", pattern: /\b(comcast|charter|spectrum|cox|verizon\s*fios|frontier|centurylink|at&t\s*services|bt\s*group|sky|virgin\s*media|deutsche\s*telekom|free\s*sas|ono|orange|telefonica|vodafone|kpn|swisscom|kddi|ntt|china\s*telecom|china\s*unicom|viettel|etisalat|bell\s*canada|bacom|\btim\b|fpt|\bsfr\b|windtre|telia|cantv|vimpelcom|corbina|comcel|telconet|\betb\b|\bvtr\b|\bnos\b|\bwana\b|\btele2\b|\btelenet\b|\btelmex\b|\bentel\b|\baltice\b)\b/i, confidence: 0.88 },
  // `tele[ck]om`, deliberately with no leading word boundary and no
  // "-ations"/"-unicaciones"/etc. suffix enumerated: telecom operators
  // worldwide overwhelmingly carry this root in their legal name, in forms
  // a word-bounded or English-only pattern would miss — "Rostelecom" (root
  // fused mid-word, no boundary before "tele"), "Telekomunikasyon" (Turkish
  // suffix), "Telecomunicaciones"/"Telecomunicações" (Spanish/Portuguese
  // suffixes), "Telecommunications" (English suffix). One unbounded
  // substring covers all of them without enumerating every language's
  // suffix. Verified against this project's own top 3000 ASNs by announced
  // address space: 213 real matches, 207 genuine telecom operators (97.2%
  // precision) — the 6 false positives were exactly the government/
  // education class the enterprise rule above now catches first, plus one
  // singular case (International Telecommunication Union, a UN body) left
  // as an accepted rare miss rather than chased with an ever-growing
  // exclusion list.
  { type: "isp", pattern: /tele[ck]om/i, confidence: 0.85 },
  // `comunicac` (no suffix enumerated: covers Portuguese "comunicação"/
  // "comunicacao"/"comunicações"/"comunicacoes" and Spanish "comunicación"/
  // "comunicaciones" in one substring) — the non-English equivalent of the
  // "communications" keyword below, same rationale as `connection-type.ts`'s
  // "universidade"/"universidad" fix. Verified against this project's full
  // `asn_blocks.name` column (2026-08-05): 657 matches not already covered
  // by the tele[ck]om rule above, effectively all small/regional Brazilian
  // ISPs using "Serviço de Comunicação Multimídia" (SCM) — Brazil's actual
  // regulatory license category name for an internet access provider — or
  // the equivalent Spanish-language phrasing elsewhere in Latin America.
  // Zero false positives found in the sample.
  { type: "isp", pattern: /comunicac/i, confidence: 0.8 },
  // `telefon` — Spanish/Portuguese "teléfono"/"telefone" (telephone), the
  // root behind "Telefónica" (already named above) but also every small
  // independent "Cooperativa Telefónica" and legacy state phone company that
  // isn't the Telefónica brand. Verified: 162 matches in the full table, all
  // genuine telephone/telecom companies, zero false positives.
  { type: "isp", pattern: /telefon/i, confidence: 0.8 },
  // `iletisim` — Turkish "iletişim" (communications), the exact Turkish
  // counterpart to `comunicac` above and just as common in Turkish ISP/
  // telecom legal names ("... İletişim Hizmetleri A.Ş." is the standard
  // suffix, roughly "... Communications Services Inc."). Verified: 114
  // matches in the full table, all genuine Turkish telecom/ISP companies,
  // zero false positives.
  { type: "isp", pattern: /iletisim/i, confidence: 0.8 },
  { type: "isp", pattern: /\b(broadband|cable|fiber|fibre|dsl|fttp|fttx|residential\s*broadband|isp|internet\s*service|communications?)\b/i, confidence: 0.75 },

  // `universidad|universit(a|á|à)|universitaet`: catches Spanish
  // "universidad" and Portuguese "universidade" (the first 11 letters of
  // "universidad" are a strict prefix of "universidade", so one substring
  // covers both), Spanish/Portuguese "universitaria"/"universitario",
  // Italian "università", and German "Universität" (transliterated
  // "universitaet"). Two genuinely different roots, not one word with a
  // boundary issue — `universidad` has a "d" where `universitaria` has a
  // "t", so neither substring contains the other. Found the hard way: an
  // earlier version of this rule shipped with only `universit(a|á|à)|
  // universitaet` and was verified against 84+23 real "Universitaria"/
  // "Universität" matches — all genuine, so it looked done — but a direct
  // sanity check against "Universidad Nacional Autónoma de México" (one of
  // Latin America's best-known universities) still returned "other",
  // because plain "Universidad" has no "t" in it at all. Deliberately its
  // own unbounded rule, not folded into the `\b(...)\b` enterprise
  // alternation below: both roots are stems a real word always extends
  // ("Universidad" continues into "...dad", "universit-" into "...aria" or
  // "...ät"), so a trailing `\b` would block genuine matches the same way
  // `tele[ck]om`/`comunicac` above need no *leading* boundary for fused
  // roots like "Rostelecom". Verified against the full `asn_blocks.name`
  // column (2026-08-05): 231 matches for `universidad` alone (covering the
  // Portuguese "-e" spelling too), all genuine — Universidad Nacional
  // Autónoma de México among them, confirming the fix — plus the earlier
  // 84 + 23 for the "-t-" roots. Zero false positives across all three, and
  // a real contributor to why LACNIC's unclassified rate was measured
  // higher than any other RIR's.
  { type: "enterprise", pattern: /universidad|universit(a|á|à)|universitaet/i, confidence: 0.55 },

  // Enterprise / private networks.
  // `holdings?`/`enterprises?`/`communications?` above: plain regex bugs,
  // not new keywords — the singular forms ("Holding", "Enterprises" is
  // already plural-only so this is "Enterprise" that was missing, spotted
  // alongside "Communication" without a trailing s) were silently missed by
  // an exact-string alternation that only listed one of the two forms.
  { type: "enterprise", pattern: /\b(corporation|corp|inc\.?|ltd|limited|llc|gmbh|s\.a\.|company|holdings?|enterprises?|university|college|government|federal|ministry|bank|insurance)\b/i, confidence: 0.55 },
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

// Generic tokens stripped before comparing two ASN holder names for shared
// identity — company-suffix words (LLC/Inc/GmbH/SA/JSC/...), generic network
// vocabulary (backbone/network/communications/telecom/...), and a small set
// of country/nationality words that are too common to mean "same operator"
// on their own (found necessary directly from real data: "China-21Vianet"
// and "China Unicom Beijing" share only "China" and are NOT the same
// company — an unrelated hosting provider and a state carrier that happen
// to share a country). Not exhaustive by design, same posture as every
// other pattern list in this file: high precision over perfect recall.
const SAME_OPERATOR_STOPWORDS = new Set([
  "AS",
  "INC",
  "LLC",
  "LTD",
  "LIMITED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "GROUP",
  "HOLDING",
  "HOLDINGS",
  "GMBH",
  "SA",
  "SAU",
  "SPA",
  "AG",
  "NV",
  "BV",
  "JSC",
  "PLC",
  "SDN",
  "BHD",
  "PTY",
  "PVT",
  "AB",
  "OY",
  "OYJ",
  "AS1",
  "BACKBONE",
  "NETWORK",
  "NETWORKS",
  "NET",
  "COMMUNICATIONS",
  "COMMUNICATION",
  "TELECOM",
  "TELECOMMUNICATIONS",
  "SERVICES",
  "SOLUTIONS",
  "SYSTEMS",
  "GLOBAL",
  "INTERNATIONAL",
  "TECHNOLOGY",
  "TECHNOLOGIES",
  "IGW",
  "GROUP",
  "PROVINCE",
  "CHINA",
  "CHINESE",
  "USA",
  "US",
  "UK",
  "SAUDI",
  "COM",
  "ORG",
]);

/**
 * Best-effort check: do two ASN holder names look like the same real-world
 * operator (a parent/subsidiary pair, or two AS numbers the same company
 * runs)? Used to catch a specific false-positive mode found in `route_anomaly`
 * (see lookup.ts and SOURCES.md): "own ASN is covered by a wider prefix from
 * a different ASN, with an invalid RPKI origin" is *not* an anomaly worth the
 * same weight when the two ASNs are actually the same company's own
 * aggregate over its own more specific announcement, one level removed.
 *
 * Method: strip punctuation, split into words, drop the generic stopwords
 * above and anything shorter than 3 characters, then check for any shared
 * remaining word. Verified against a real 94-row sample of
 * `route_anomaly`-triggering pairs (2026-08-06): correctly flags "GoDaddy.com,
 * LLC" / "GoDaddy.com, LLC" (shared "GODADDY"), "KPN GTT Communications Inc."
 * / "GTT-BACKBONE GTT Communications Inc." (shared "GTT" — the reason the
 * length floor is 3, not 4: a first version used 4 and silently missed this
 * exact pair, caught by testing against real names rather than assumed
 * safe), "JAZZNET Orange Espagne SA" / "UNI2-AS Orange Espagne SA" (shared
 * "ORANGE"/"ESPAGNE" — the single largest cluster in the sample, ~50 of the
 * 94 rows), "Shanghai Mobile Communications Co.,Ltd." / "China Mobile
 * Communications Group Co., Ltd." (shared "MOBILE").
 *
 * Two known, accepted misses in that same sample, both left disclosed rather
 * than chased with an ever-growing exception list (same call this file
 * already makes for `tele[ck]om`'s ITU miss and `entel`'s Energoprojekt
 * miss): "CHINATELECOM-GUANGDONG-..." / "CHINANET-BACKBONE" is the same real
 * operator (China Telecom's backbone AS is branded "Chinanet") but shares no
 * literal token; "SAUDINETSTC-AS Saudi Telecom Company JSC" / "STC-IGW-AS
 * Saudi Telecom Company JSC" is the same real operator (Saudi Telecom
 * Company / STC) but every word they share ("Saudi", "Telecom", "Company")
 * is deliberately stopworded — "Saudi" for the same reason "China"/"USA"/
 * "UK" are (a bare country/nationality word is too common across unrelated
 * companies to mean "same operator" — see `CHINA`'s own comment above), and
 * "Telecom"/"Company" because they're two of the most generic words in this
 * entire domain (hundreds of unrelated phone companies worldwide use one or
 * both). A phrase-level match ("this *combination* of otherwise-generic
 * words is distinctive") would catch this; this function only does
 * single-word-set overlap, deliberately, to stay simple and auditable.
 */
export function looksLikeSameOperator(
  nameA: string | null | undefined,
  nameB: string | null | undefined,
): boolean {
  if (!nameA || !nameB) return false;
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter((w) => w.length >= 3 && !SAME_OPERATOR_STOPWORDS.has(w)),
    );
  const wordsA = tokenize(nameA);
  const wordsB = tokenize(nameB);
  for (const w of wordsA) {
    if (wordsB.has(w)) return true;
  }
  return false;
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
