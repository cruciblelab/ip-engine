/**
 * Allocation freshness — how long ago a block or ASN was registered.
 *
 * Built entirely from `registered_date`, a column the RIR delegated-extended
 * files already carry and this project already ingests. No new source, no
 * new query, no probing: the two callers here read it off rows they had
 * fetched anyway.
 *
 * **Why the age is computed here and never stored.** The underlying *date*
 * is a fact that never changes and is stored everywhere (`ip_blocks`,
 * `asn_blocks`, `ip_intel`, the ASN cache). An *age in days* is that fact
 * minus today, so it is wrong the day after it is written. Storing it in a
 * materialized `ip_intel` (rebuilt every few hours at best) or in a
 * published `.mmdb` (rebuilt daily at best) would ship a number that
 * silently drifts out of date between rebuilds. Deriving it at request time
 * costs one subtraction and is always correct — the same reasoning that
 * keeps it out of the `prefixAsnCache` entry, which caches the date.
 *
 * **What the date actually means, stated honestly.** The RIR delegated
 * files document this field as the date the allocation/assignment was made,
 * but in practice a transfer between organisations can update it at some
 * RIRs. So a recent date means "this block was allocated *or* changed hands
 * recently", not strictly "this is newly created space". Both are the same
 * shape of signal for the case this exists to serve — address space that
 * has not been under its current holder for long — but a caller reading it
 * as "the day this /24 first existed" would sometimes be wrong.
 *
 * **Not wired into `risk.ts`, deliberately.** A fresh allocation is not
 * wrongdoing: every legitimate new network starts here too. This project
 * has no outcome data to calibrate a weight against, and `route_anomaly`
 * already set the precedent that an uncalibrated heuristic gets surfaced as
 * a labelled fact rather than silently folded into a score. Callers who
 * want to act on it can, from a field they can see.
 */

/**
 * Days since a block/ASN was registered, or `null` when no date is known.
 *
 * `null` is common and expected, not a gap: RIR delegated files carry a
 * date only for space that has actually been handed out. Measured against
 * this project's own full dataset (773,873 rows, 2026-08-21), every single
 * `allocated` and `assigned` row has one, and no `reserved` or `available`
 * row does — which is correct, since unallocated space has no allocation
 * date to report.
 *
 * Accepts whatever the driver hands back for a `date` column — pg returns a
 * `Date` for some configurations and a `YYYY-MM-DD` string for others, and
 * this is called on rows from both a Drizzle `.select()` and a raw
 * `db.execute()`.
 */
export function allocationAgeDays(
  registeredDate: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!registeredDate) return null;

  let registeredUtcMidnight: number;
  if (registeredDate instanceof Date) {
    if (Number.isNaN(registeredDate.getTime())) return null;
    registeredUtcMidnight = Date.UTC(
      registeredDate.getUTCFullYear(),
      registeredDate.getUTCMonth(),
      registeredDate.getUTCDate(),
    );
  } else {
    // Matched rather than passed to `new Date()`: that constructor accepts a
    // great deal of nonsense ("2026", "Aug 21") and quietly produces a real
    // timestamp for it, which here would turn a malformed date into a
    // confident-looking age. Only the exact shape a `date` column yields is
    // accepted; anything else is `null`, the same "honest no answer" this
    // codebase prefers over a plausible wrong one.
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(registeredDate.trim());
    if (!match) return null;
    registeredUtcMidnight = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    // Rejects impossible dates that `Date.UTC` silently rolls over instead
    // of failing on — "2026-02-30" becomes March 2nd, "2026-13-01" becomes
    // January of 2027.
    const roundTrip = new Date(registeredUtcMidnight);
    if (
      roundTrip.getUTCFullYear() !== Number(match[1]) ||
      roundTrip.getUTCMonth() !== Number(match[2]) - 1 ||
      roundTrip.getUTCDate() !== Number(match[3])
    ) {
      return null;
    }
  }

  const nowUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((nowUtcMidnight - registeredUtcMidnight) / 86_400_000);
  // A future date is upstream data this project can't interpret — the RIR
  // published something dated ahead of today. Reported as `null` rather than
  // as a negative age, which no caller has a sensible reading for.
  return days < 0 ? null : days;
}

/**
 * The cutoff below which `freshly-allocated` / `freshly-registered-asn`
 * fire.
 *
 * 90 days, chosen from a measurement rather than picked: against this
 * project's own full RIR dataset on 2026-08-21, of rows that carry a date,
 *
 *   IP blocks — <30d: 0.18%,  <90d: 0.63%,  <1y: 2.63%,  3y+: 91.92%
 *   ASNs      — <30d: 0.51%,  <90d: 1.53%,  <1y: 5.89%,  3y+: 85.17%
 *
 * A flag is only worth having if firing it is rare enough to mean
 * something; at 90 days it fires on well under 1% of blocks. 30 days would
 * be rarer still but excludes space allocated five weeks ago, which is not
 * meaningfully different; a year fires on 2.6%/5.9%, which starts to
 * describe ordinary network growth rather than anything notable. Re-measure
 * before moving it — the numbers above are reproducible from
 * `ip_blocks`/`asn_blocks` directly.
 */
export const FRESH_ALLOCATION_DAYS = 90;

/** True when an age (from `allocationAgeDays`) is inside the fresh window.
 * `null` — no date known — is not fresh, it is unknown. */
export function isFreshAllocation(ageDays: number | null): boolean {
  return ageDays !== null && ageDays < FRESH_ALLOCATION_DAYS;
}
