import { lookupIp, lookupAsn } from "@workspace/lookup";

/** A day count read as a phrase. "9642 days ago" is technically the answer
 * and practically unreadable; the point of this line is for someone to tell
 * "brand new" from "been there for decades" at a glance. The exact date is
 * printed right next to it, so this is allowed to be approximate. */
function humanAge(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (days < 365) return `~${months} months ago`;
  const years = days / 365.25;
  return years < 10 ? `~${years.toFixed(1)} years ago` : `~${Math.round(years)} years ago`;
}

export async function runLookup(ip: string, opts: { json?: boolean }): Promise<void> {
  const result = await lookupIp(ip);
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`IP:        ${result.ip} (IPv${result.family})`);
  const hasAnyData =
    result.network.cidr || result.asn.number || result.geo.country || result.special_purpose;
  if (!hasAnyData) {
    console.log("No data at all — this address isn't covered by any ingested source.");
    return;
  }
  if (result.special_purpose) {
    // Special-purpose addresses (private/loopback/documentation/etc) are
    // never RIR-allocated or BGP-announced, so network/ASN below are
    // legitimately empty for them — this line is what explains why.
    console.log(
      `Special:   ${result.special_purpose.name}${result.special_purpose.rfc ? ` (${result.special_purpose.rfc})` : ""}`,
    );
  }
  if (!result.found) {
    // No base RIR allocation row matched (that source may not have been
    // collected yet), but other layers (BGP-RIS, geofeed, etc.) still
    // resolved something below — the layered model degrading gracefully,
    // not a contradiction.
    console.log("(No base RIR allocation row — resolved from other layers below.)");
  }
  console.log(
    `Network:   ${result.network.cidr ?? "-"} (${result.network.rir ?? "unknown RIR"})` +
      (result.network.status ? ` [${result.network.status}]` : ""),
  );
  // Only printed when a date exists — most `reserved`/`available` blocks
  // carry none, and an "Allocated: unknown" line on every one of them would
  // be noise. `humanAge` spells out what a bare day count means for space
  // that has been sitting there since the 1980s.
  if (result.network.allocation_date) {
    console.log(
      `Allocated: ${result.network.allocation_date}` +
        (result.network.allocation_age_days != null
          ? ` (${humanAge(result.network.allocation_age_days)})`
          : ""),
    );
  }
  console.log(
    `ASN:       ${result.asn.number ? `AS${result.asn.number}` : "-"}${
      result.asn.name ? ` (${result.asn.name})` : ""
    }${result.asn.source ? ` [${result.asn.source}]` : ""}${
      result.asn.rank ? ` (size rank ${result.asn.rank})` : ""
    }${
      result.asn.registered_age_days != null
        ? ` (registered ${humanAge(result.asn.registered_age_days)})`
        : ""
    }`,
  );
  if (result.asn.originated_prefixes != null) {
    console.log(
      `Reach:     ${result.asn.originated_prefixes} prefixes` +
        (result.asn.originated_addresses != null
          ? `, ${result.asn.originated_addresses.toLocaleString("en-US")} IPv4 addresses announced`
          : "") +
        (result.asn.peer_visibility != null
          ? `, seen by ${result.asn.peer_visibility} collectors`
          : ""),
    );
    // originated_prefixes_v6 was already computed and returned by the API,
    // just never shown here — this network's own IPv6 prefix count was
    // invisible in the human-readable output even though it was one field
    // away in --json.
    console.log(
      result.asn.originated_prefixes_v6
        ? `IPv6:      dual-stack — also announces ${result.asn.originated_prefixes_v6} IPv6 prefix(es)`
        : "IPv6:      not observed announcing any IPv6 space",
    );
  }
  console.log(
    `Location:  ${[result.geo.city, result.geo.region, result.geo.postal, result.geo.country]
      .filter(Boolean)
      .join(", ") || "-"}${
      result.geo.latitude != null ? ` (${result.geo.latitude}, ${result.geo.longitude})` : ""
    }${result.geo.geo_source ? ` [${result.geo.geo_source}]` : ""}`,
  );
  // The extent of the claim, printed next to it. "Kartal" for a /30 and
  // "Kartal" for a /12 are very different statements, and only one of them
  // is about your address specifically — see docs/101.
  if (result.geo.geo_network) {
    console.log(
      `           ...which is what that source says about ${result.geo.geo_network}` +
        (result.flags.includes("geo:city-approximate") ? ", inferred — not operator-published" : ""),
    );
  }
  console.log(`Usage:     ${result.usage_type ?? "unknown"}${result.anycast ? " (anycast)" : ""}`);
  if (result.cloud_provider) console.log(`Cloud:     ${result.cloud_provider}`);
  console.log(
    `Threat:    ${result.threat.is_malicious ? `MALICIOUS (${result.threat.sources.join(", ")})` : "clean"}`,
  );
  if (result.anonymity.is_tor || result.anonymity.is_vpn || result.anonymity.is_proxy) {
    const kinds = [
      result.anonymity.is_tor && "Tor exit",
      result.anonymity.is_vpn && "VPN egress",
      result.anonymity.is_proxy && "proxy",
    ].filter(Boolean);
    console.log(
      `Anonymity: ${kinds.join(", ")}${
        result.anonymity.providers.length > 0 ? ` (${result.anonymity.providers.join(", ")})` : ""
      }`,
    );
  }
  if (result.rpki.status) {
    console.log(
      `RPKI:      ${result.rpki.status}${
        result.rpki.authorized_asns.length > 0
          ? ` (authorized: ${result.rpki.authorized_asns.map((a) => `AS${a}`).join(", ")})`
          : ""
      }`,
    );
  }
  if (result.asn.wider_prefix_asn) {
    // A raw fact, not a verdict — see the field's own doc comment in
    // lookup.ts. Only worth calling out plainly when RPKI already flagged
    // this same address invalid; otherwise it's ordinary internet
    // structure (a transit provider's aggregate covering a customer's
    // prefix) and gets a quieter note instead of an alarming one.
    const notable = result.rpki.status === "invalid";
    console.log(
      `${notable ? "⚠ Sub-prefix:" : "Sub-prefix: "} inside AS${result.asn.wider_prefix_asn}'s wider announcement` +
        (notable ? " — combined with the RPKI-invalid status above, this is the shape of an unauthorized announcement" : ""),
    );
  }
  if (result.connection_type) {
    console.log(
      `Conn type: ${result.connection_type.type} (heuristic, matched "${result.connection_type.matched}")`,
    );
  }
  if (result.abuse?.email) {
    console.log(`Abuse:     ${result.abuse.email}${result.abuse.org ? ` (${result.abuse.org})` : ""}`);
  }
  if (result.risk) {
    console.log(
      `Risk:      ${result.risk.score}/100 ${result.risk.level}${
        result.risk.reasons.length > 0 ? ` — ${result.risk.reasons.join(", ")}` : ""
      }`,
    );
  }
  if (result.reverse_dns) console.log(`rDNS:      ${result.reverse_dns}`);
  if (result.flags.length > 0) console.log(`Flags:     ${result.flags.join(", ")}`);
  console.log(`Confidence: overall ${result.confidence.overall}, geo ${result.confidence.geo ?? "-"}, asn ${result.confidence.asn ?? "-"}`);
}

export async function runLookupAsn(asnNumber: number, opts: { json?: boolean }): Promise<void> {
  const result = await lookupAsn(asnNumber);
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result) {
    console.log(`AS${asnNumber}: not found.`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
