/**
 * Pure record-diffing logic for typed history change events — split out of
 * history.ts specifically so it has no `@workspace/db` import and can be
 * unit-tested without a database connection (`db`'s module import throws
 * immediately if `DATABASE_URL` isn't set, which would poison every test in
 * the same file otherwise). See history.ts's `changeEvents()` for the
 * DB-touching caller.
 */

/** The full flattened record for a prefix, everything `ip_intel` carries
 * except the prefix itself (which is already the row's key). */
export type PrefixRecord = Record<string, unknown>;

/**
 * Typed change events — the same old/new record pair `ops.prefix_history`
 * already stores, decomposed into the four facts a consumer actually asks
 * about instead of two opaque JSON blobs they'd otherwise have to diff
 * themselves. No new data: this classifies what moved between two records
 * `historyTimeline()` already returns.
 *
 * Deliberately four groups, matching the four questions this project's own
 * layers answer (registration, routing, location, abuse), not one event per
 * column — a caller asking "did this address change ASN" doesn't care that
 * `asn_type` moved in the same capture as `asn_name`, only that "ASN" as a
 * concept changed. Fields outside these four groups (cloud/anycast/RPKI/
 * verified-bot/anonymity/abuse-contact/asn-reach) are not decomposed: they
 * still show up in the underlying whole-record diff, just not as a typed
 * event, because nothing asked for that here — see DEPLOY.md's discipline
 * on not building speculative surface area.
 */
export type HistoryChangeEventType = "PrefixChanged" | "ASNChanged" | "GeoChanged" | "ThreatChanged";

const CHANGE_EVENT_FIELDS: Record<HistoryChangeEventType, readonly string[]> = {
  // Registration/allocation facts — who officially holds the block, per the
  // RIR — as distinct from who's actually routing it (ASNChanged) or where
  // it's actually used (GeoChanged).
  PrefixChanged: ["rir", "rir_status", "network_name", "registered_date"],
  ASNChanged: ["asn", "asn_name", "asn_type"],
  GeoChanged: ["country", "city", "region", "postal", "latitude", "longitude", "geo_source"],
  ThreatChanged: ["is_threat", "threat_source", "threat_category"],
};

export interface HistoryChangeEvent {
  type: HistoryChangeEventType;
  network: string;
  /** When the new value became true — the later record's `validFrom`. */
  occurredAt: Date;
  /** Only the fields this event type tracks (see `CHANGE_EVENT_FIELDS`), not
   * the whole record — `null` for a field absent from either side. */
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

function pickFields(record: PrefixRecord, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = record[field] ?? null;
  return out;
}

/**
 * Classifies one old→new record transition into zero or more typed events —
 * zero when the change was entirely in fields none of the four groups track,
 * more than one when a single capture moved e.g. both ASN and country at
 * once (a full renumbering-and-relocation looks like exactly this).
 */
export function diffHistoryRecords(
  network: string,
  occurredAt: Date,
  from: PrefixRecord,
  to: PrefixRecord,
): HistoryChangeEvent[] {
  const events: HistoryChangeEvent[] = [];
  for (const type of Object.keys(CHANGE_EVENT_FIELDS) as HistoryChangeEventType[]) {
    const fields = CHANGE_EVENT_FIELDS[type];
    const before = pickFields(from, fields);
    const after = pickFields(to, fields);
    // These field groups are small and scalar-only (no nested objects/arrays
    // among rir/asn/geo/threat columns), so a JSON comparison is exact and
    // doesn't need a deep-equal dependency.
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      events.push({ type, network, occurredAt, from: before, to: after });
    }
  }
  return events;
}
