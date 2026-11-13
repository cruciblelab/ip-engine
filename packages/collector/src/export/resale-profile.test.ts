import { describe, expect, it } from "vitest";
import {
  applyResaleProfile,
  resaleAttributionText,
  RESALE_DEFAULT_DROP_COUNTRY_FALLBACK_RIRS,
  RESALE_DEFAULT_EXCLUDED_FIELDS,
} from "./resale-profile";

const DEFAULTS = {
  excludeFields: RESALE_DEFAULT_EXCLUDED_FIELDS,
  dropCountryFallbackRirs: RESALE_DEFAULT_DROP_COUNTRY_FALLBACK_RIRS,
};

const full = () => ({
  country: "TR",
  city: "Istanbul",
  location: { latitude: 41, longitude: 29 },
  geo_source: "dbip-lite",
  asn: 20978,
  asn_name: "TT Mobil",
  asn_size_rank: 341,
  rpki_status: "valid",
  verified_bot: "googlebot",
  is_tor: true,
});

describe("applyResaleProfile", () => {
  it("removes CAIDA's ASN name and unverified RPKI status, keeps everything else", () => {
    const r = applyResaleProfile(full(), { geo_source: "dbip-lite", rir: "ripencc" }, DEFAULTS);
    expect(r).not.toHaveProperty("asn_name");
    expect(r).not.toHaveProperty("rpki_status");
    expect(r).toMatchObject({ country: "TR", city: "Istanbul", asn: 20978, asn_size_rank: 341, verified_bot: "googlebot", is_tor: true });
  });

  it("drops a RIPE-region country whose only source is the registry", () => {
    const rec = { country: "TR", geo_source: "country-estimate", asn: 20978 };
    const r = applyResaleProfile(rec, { geo_source: "country-estimate", rir: "ripencc" }, DEFAULTS);
    expect(r).toEqual({ asn: 20978 });
  });

  it("keeps a RIPE-region country that a geofeed or DB-IP supplied", () => {
    const rec = { country: "TR", geo_source: "geofeed" };
    expect(applyResaleProfile(rec, { geo_source: "geofeed", rir: "ripencc" }, DEFAULTS)).toEqual(rec);
  });

  it("keeps registry-only countries of other RIRs", () => {
    const rec = { country: "JP", geo_source: "country-estimate" };
    expect(applyResaleProfile(rec, { geo_source: "country-estimate", rir: "apnic" }, DEFAULTS)).toEqual(rec);
  });

  it("follows the config: empty lists change nothing", () => {
    const rec = full();
    expect(applyResaleProfile(rec, { geo_source: "country-estimate", rir: "ripencc" }, { excludeFields: [], dropCountryFallbackRirs: [] })).toEqual(full());
  });
});

describe("resaleAttributionText", () => {
  it("names every source that requires attribution, the CC BY licence and what was left out", () => {
    const t = resaleAttributionText(DEFAULTS, new Date("2026-11-13T00:00:00Z"));
    expect(t).toContain("RouteViews (www.routeviews.org)");
    expect(t).toContain("https://db-ip.com");
    expect(t).toContain("GeoNames");
    expect(t).toContain("With contributions from network operators and volunteers all over the world");
    expect(t).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(t).toContain("fields: asn_name, rpki_status");
    expect(t).toContain("held by: ripencc");
  });
});
