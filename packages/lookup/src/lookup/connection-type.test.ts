import { describe, expect, it } from "vitest";
import { guessConnectionType } from "./connection-type";

describe("guessConnectionType", () => {
  it("returns satellite for AS14593 (Starlink) regardless of ASN name text", () => {
    expect(guessConnectionType("SPACEX-STARLINK", null, 14593)).toEqual({
      type: "satellite",
      confidence: "heuristic",
      matched: "as14593",
    });
    // The ASN name in the wild is inconsistent — the number is what's checked.
    expect(guessConnectionType("SpaceX Services, Inc.", null, 14593)).toEqual({
      type: "satellite",
      confidence: "heuristic",
      matched: "as14593",
    });
  });

  it("does not match satellite for an unrelated ASN, even with 'space' in the name", () => {
    expect(guessConnectionType("SPACE-HOSTING-CORP", null, 64500)).toEqual({
      type: "hosting",
      confidence: "heuristic",
      matched: "hosting",
    });
  });

  it("still falls through to text patterns when asnNumber is omitted", () => {
    expect(guessConnectionType("Comcast Cable Communications", null)).toEqual({
      type: "cable",
      confidence: "heuristic",
      matched: "cable",
    });
  });

  it("returns null when nothing matches", () => {
    expect(guessConnectionType("Example Networks LLC", null, 64501)).toBeNull();
  });

  it("returns education for real-world university/college/school names", () => {
    // "edu" appears before "University" in the string, and the regex
    // matches leftmost-position-first, so "edu" is the reported match here.
    expect(guessConnectionType("MIAMI-EDU - University of Miami, US", null)).toEqual({
      type: "education",
      confidence: "heuristic",
      matched: "edu",
    });
    // Portuguese/Spanish institutions don't use the English word "university".
    expect(guessConnectionType("AS271755 - UNIVERSIDADE DE SAO PAULO, BR", null)).toEqual({
      type: "education",
      confidence: "heuristic",
      matched: "universidade",
    });
    expect(guessConnectionType("AS3449 - Universidad Nacional de Buenos Aires, AR", null)).toEqual({
      type: "education",
      confidence: "heuristic",
      matched: "universidad",
    });
  });

  it("classifies a business school as education, not corporate (checked before 'corporate')", () => {
    expect(guessConnectionType("HBSNET - Harvard Business School, US", null)).toEqual({
      type: "education",
      confidence: "heuristic",
      matched: "school",
    });
  });

  it("returns government for real-world agency/municipal names", () => {
    expect(guessConnectionType("GSA-GOV - General Services Administration, US", null)).toEqual({
      type: "government",
      confidence: "heuristic",
      matched: "gov",
    });
    expect(
      guessConnectionType("CFU-NET - The Municipal Communications Utility of the City of Cedar Falls, Iowa, US", null),
    ).toEqual({ type: "government", confidence: "heuristic", matched: "municipal" });
  });

  it("does not match government for 'federal' (real data: mostly credit unions/universities, not agencies)", () => {
    expect(guessConnectionType("RBSTARNET1 - Randolph-Brooks Federal Credit Union, US", null)).toBeNull();
    expect(guessConnectionType("AS262511 - Universidade Federal do Para, BR", null)).toEqual({
      type: "education",
      confidence: "heuristic",
      matched: "universidade",
    });
  });

  it("classifies a municipal utility as government, not corporate (checked before 'corporate')", () => {
    expect(
      guessConnectionType('HOKS Municipal Enterprise of Kharkiv Regional Council "Kharkiv Oblast Communication Systems", UA', null),
    ).toEqual({ type: "government", confidence: "heuristic", matched: "municipal" });
  });

  it("returns iot for real-world IoT/M2M operator names", () => {
    expect(guessConnectionType("CISCO-IOT - Cisco IoT, US", null)).toEqual({
      type: "iot",
      confidence: "heuristic",
      matched: "iot",
    });
    expect(guessConnectionType("M2MNT M2M SERVICES Ltd., BG", null)).toEqual({
      type: "iot",
      confidence: "heuristic",
      matched: "m2m",
    });
  });

  it("prefers cellular over iot for 'mobile IoT' names, matching the cellular-before-dsl precedent", () => {
    expect(guessConnectionType("wavely Greenwave Mobile IoT ApS, DK", null)).toEqual({
      type: "cellular",
      confidence: "heuristic",
      matched: "mobile",
    });
  });

  it("returns satellite from name text for self-descriptive operators other than Starlink", () => {
    expect(guessConnectionType("DIGISATNET-AS-ID - DIGITAL SATELLITE INDONESIA PT., ID", null)).toEqual({
      type: "satellite",
      confidence: "heuristic",
      matched: "satellite",
    });
    expect(guessConnectionType("SITEL-VSAT-ASN SITEL-VSAT sro, SK", null)).toEqual({
      type: "satellite",
      confidence: "heuristic",
      matched: "vsat",
    });
  });
});
