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
});
