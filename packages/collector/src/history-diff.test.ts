import { describe, expect, it } from "vitest";
import { diffHistoryRecords } from "./history-diff";

const BASE_RECORD = {
  rir: "arin",
  rir_status: "allocated",
  network_name: "EXAMPLE-NET",
  registered_date: "2020-01-01",
  asn: 64500,
  asn_name: "Example ISP",
  asn_type: "isp",
  country: "US",
  city: "New York",
  region: "NY",
  postal: "10001",
  latitude: 40.7,
  longitude: -74.0,
  geo_source: "geofeed",
  is_threat: false,
  threat_source: null,
  threat_category: null,
  is_cloud: false,
  verified_bot: null,
};

describe("diffHistoryRecords", () => {
  it("returns no events for identical records", () => {
    expect(diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, BASE_RECORD)).toEqual([]);
  });

  it("emits only ASNChanged when just the ASN group differs", () => {
    const to = { ...BASE_RECORD, asn: 64501, asn_name: "New Holder" };
    const events = diffHistoryRecords("1.2.3.0/24", new Date("2026-01-01"), BASE_RECORD, to);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ASNChanged",
      network: "1.2.3.0/24",
      from: { asn: 64500, asn_name: "Example ISP", asn_type: "isp" },
      to: { asn: 64501, asn_name: "New Holder", asn_type: "isp" },
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
    const sparseTo = { asn: 64500, asn_name: "Now Named" };
    const events = diffHistoryRecords("1.2.3.0/24", new Date(), sparseFrom, sparseTo);
    expect(events).toEqual([
      {
        type: "ASNChanged",
        network: "1.2.3.0/24",
        occurredAt: events[0]!.occurredAt,
        from: { asn: 64500, asn_name: null, asn_type: null },
        to: { asn: 64500, asn_name: "Now Named", asn_type: null },
      },
    ]);
  });

  it("emits PrefixChanged for RIR-registration facts, distinct from ASNChanged", () => {
    const to = { ...BASE_RECORD, rir_status: "reallocated", network_name: "NEW-NET" };
    const events = diffHistoryRecords("1.2.3.0/24", new Date(), BASE_RECORD, to);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("PrefixChanged");
  });
});
