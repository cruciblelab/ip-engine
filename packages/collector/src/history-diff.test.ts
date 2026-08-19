import { describe, expect, it } from "vitest";
import { diffHistoryRecords } from "./history-diff";

// Matches the trimmed 18-field record captureBaseline() actually stores
// (see history.ts's TRACKED_FIELDS) — deliberately does NOT include
// asn_name/asn_type/region/postal/latitude/longitude/threat_category,
// which were dropped from tracked history (licensing + redundancy reasons,
// see the CHANGE_EVENT_FIELDS doc comment in history-diff.ts).
const BASE_RECORD = {
  rir: "arin",
  rir_status: "allocated",
  network_name: "EXAMPLE-NET",
  registered_date: "2020-01-01",
  asn: 64500,
  country: "US",
  city: "New York",
  geo_source: "geofeed",
  is_threat: false,
  threat_source: null,
  is_cloud: false,
  verified_bot: null,
};

describe("diffHistoryRecords", () => {
  it("returns no events for identical records", () => {
    expect(diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, BASE_RECORD)).toEqual([]);
  });

  it("emits ASNChanged when the ASN number differs", () => {
    const to = { ...BASE_RECORD, asn: 64501 };
    const events = diffHistoryRecords("1.2.3.0/24", new Date("2026-01-01"), BASE_RECORD, to);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ASNChanged",
      network: "1.2.3.0/24",
      from: { asn: 64500 },
      to: { asn: 64501 },
    });
  });

  it("does not fire ASNChanged for a field outside its group (e.g. is_cloud)", () => {
    const to = { ...BASE_RECORD, is_cloud: true };
    expect(diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, to)).toEqual([]);
  });

  it("emits multiple event types when a capture moves more than one group at once", () => {
    const to = {
      ...BASE_RECORD,
      asn: 64501,
      country: "DE",
      city: "Berlin",
      is_threat: true,
      threat_source: "feodotracker",
    };
    const events = diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, to);
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(["ASNChanged", "GeoChanged", "ThreatChanged"]);
  });

  it("treats a field absent from a record as null rather than throwing", () => {
    const sparseFrom = { asn: 64500 };
    const sparseTo = { asn: 64501 };
    const events = diffHistoryRecords("1.2.3.0/24", new Date(), sparseFrom, sparseTo);
    expect(events).toEqual([
      {
        type: "ASNChanged",
        network: "1.2.3.0/24",
        occurredAt: events[0]!.occurredAt,
        from: { asn: 64500 },
        to: { asn: 64501 },
      },
    ]);
  });

  it("emits PrefixChanged for RIR-registration facts, distinct from ASNChanged", () => {
    const to = { ...BASE_RECORD, rir_status: "reallocated", network_name: "NEW-NET" };
    const events = diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, to);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("PrefixChanged");
  });

  it("does NOT fire ASNChanged for an org-name-only change (asn_name isn't tracked)", () => {
    // The deliberate licensing-driven exclusion, made explicit as a test so
    // it reads as "on purpose" to whoever finds this later, not as a gap.
    // asn_name isn't in the stored record at all post-trim, so a caller
    // that somehow still has it in an old/foreign record sees no event —
    // only the numeric `asn` is tracked.
    const from = { asn: 64500, asn_name: "Old Org LLC" };
    const to = { asn: 64500, asn_name: "New Org LLC" };
    expect(diffHistoryRecords("1.2.3.0/24", new Date(), from, to)).toEqual([]);
  });
});
