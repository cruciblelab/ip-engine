/**
 * BGP hijack signal — built entirely from data this project already
 * collects, specifically the time-travel tables in `history.ts`. No new
 * source, no new table.
 *
 * The idea: a prefix that has announced from the same origin ASN for a long
 * time, then suddenly announces from a different one, is either a routine
 * provider change or a hijack — and RPKI is what tells the two apart. A
 * changed origin that's still RPKI-authorized is a customer switching ISPs.
 * A changed origin that's RPKI-*invalid* is exactly what a hijack looks
 * like: someone announcing a prefix they have no authorization for.
 *
 * `ops.prefix_history`'s most recent row per prefix already records the
 * *previous* full record, and `ops.prefix_baseline` the *current* one — so
 * "did the origin just change" is a single comparison between the two,
 * needing no separate change-tracking of its own. This only sees changes
 * that happened between two `history capture` runs; it cannot notice
 * something that changed and changed back between captures.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "@workspace/shared";

export type HijackConfidence = "high" | "medium";

export interface HijackFinding {
  network: string;
  previousAsn: number | null;
  currentAsn: number | null;
  rpkiStatus: string | null;
  changedAt: Date;
  confidence: HijackConfidence;
  reasons: string[];
}

/**
 * Every prefix whose most recently recorded transition changed the origin
 * ASN, where the new origin isn't RPKI-authorized. RPKI-valid origin changes
 * (a legitimate provider switch, still covered by the ROA) are excluded
 * entirely — reporting those as hijacks would make every real finding easy
 * to ignore in the noise. RPKI-`not-found` changes are included at lower
 * confidence: no ROA means no authority to contradict, so it's an anomaly
 * worth a look, not a violation.
 */
export async function scanHijacks(): Promise<HijackFinding[]> {
  const result = await db.execute<{
    network: string;
    previous_asn: string | null;
    current_asn: string | null;
    rpki_status: string | null;
    changed_at: string;
  }>(sql`
    SELECT
      b.network::text,
      h.record ->> 'asn' AS previous_asn,
      b.record ->> 'asn' AS current_asn,
      b.record ->> 'rpki_status' AS rpki_status,
      h.valid_to AS changed_at
    FROM ops.prefix_baseline b
    JOIN LATERAL (
      SELECT record, valid_to
      FROM ops.prefix_history hh
      WHERE hh.network = b.network
      ORDER BY hh.valid_to DESC
      LIMIT 1
    ) h ON true
    WHERE (h.record ->> 'asn') IS DISTINCT FROM (b.record ->> 'asn')
      AND coalesce(b.record ->> 'rpki_status', 'not-found') != 'valid'
    ORDER BY h.valid_to DESC
  `);

  const findings = result.rows.map((r): HijackFinding => {
    const rpkiInvalid = r.rpki_status === "invalid";
    const reasons: string[] = [
      `origin ASN changed from ${r.previous_asn ?? "(unknown)"} to ${r.current_asn ?? "(unknown)"}`,
    ];
    reasons.push(
      rpkiInvalid
        ? "new origin is not RPKI-authorized for this prefix"
        : "no RPKI ROA covers this prefix, so the new origin cannot be confirmed or contradicted",
    );
    return {
      network: r.network,
      previousAsn: r.previous_asn === null ? null : Number(r.previous_asn),
      currentAsn: r.current_asn === null ? null : Number(r.current_asn),
      rpkiStatus: r.rpki_status,
      changedAt: new Date(r.changed_at),
      confidence: rpkiInvalid ? "high" : "medium",
      reasons,
    };
  });

  logger.info(
    { total: findings.length, high: findings.filter((f) => f.confidence === "high").length },
    "Hijack scan complete",
  );
  return findings;
}
