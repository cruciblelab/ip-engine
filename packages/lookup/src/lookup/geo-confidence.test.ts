/**
 * Pins the calibration, and the *ordering* the numbers exist to express.
 *
 * The last test in this file is the important one. An earlier version of
 * `geo-confidence.ts` scored datacenter addresses 0.7 and everything else
 * 0.3, on a per-prefix average that turned out to be measuring "which
 * household is this" against 346,000 consumer /29s and /30s. Corrected to a
 * per-address weighting the gap was 86.4% vs 76.2%, not 74.3% vs 15.6%, and
 * the split was removed. That test states the removal as an intention, so
 * re-adding a split silently is a failing test rather than a quiet
 * regression.
 */
import { describe, expect, it } from "vitest";
import { inferredGeoConfidence } from "./geo-confidence";

/** What `geofeed_ranges` rows actually carry, for the ordering assertions. */
const GEOFEED_LOW = 0.8;

describe("inferredGeoConfidence", () => {
  it("keeps every inferred score below a real operator geofeed", () => {
    for (const source of ["dbip-lite", "country-estimate"] as const) {
      for (const countryConflict of [true, false]) {
        expect(inferredGeoConfidence({ source, countryConflict }).score).toBeLessThan(GEOFEED_LOW);
      }
    }
  });

  it("keeps a per-range guess above a whole-country estimate", () => {
    // The gap these two numbers exist to express: DB-IP says something about
    // *this prefix*; the country estimate names the country's biggest city
    // and would say the same thing for every address in the country.
    expect(
      inferredGeoConfidence({ source: "dbip-lite", countryConflict: false }).score,
    ).toBeGreaterThan(
      inferredGeoConfidence({ source: "country-estimate", countryConflict: false }).score,
    );
  });

  it("stays under the measured accuracy rather than matching its top end", () => {
    // Measured per address: 76.2% (Charter) to 86.4% (Google), with NTT at
    // 53.4%. A score at or above the top of that range would be claiming the
    // best case as typical.
    const { score } = inferredGeoConfidence({ source: "dbip-lite", countryConflict: false });
    expect(score).toBeLessThan(0.76);
    expect(score).toBeGreaterThan(0.5);
  });

  it("lowers, but never inverts, on a country conflict", () => {
    const clean = inferredGeoConfidence({ source: "dbip-lite", countryConflict: false });
    const conflicted = inferredGeoConfidence({ source: "dbip-lite", countryConflict: true });
    expect(conflicted.score).toBeLessThan(clean.score);
    expect(conflicted.score).toBeGreaterThan(
      inferredGeoConfidence({ source: "country-estimate", countryConflict: false }).score,
    );
  });

  it("labels every inferred city approximate — none of them is operator-published", () => {
    for (const source of ["dbip-lite", "country-estimate"] as const) {
      expect(inferredGeoConfidence({ source, countryConflict: true }).cityApproximate).toBe(true);
      expect(inferredGeoConfidence({ source, countryConflict: false }).cityApproximate).toBe(true);
    }
  });

  it("returns clean two-decimal numbers, not floating-point debris", () => {
    // 0.6 - 0.05 is 0.5499999999999999 in IEEE 754, and that would be served
    // verbatim in a JSON API response.
    for (const source of ["dbip-lite", "country-estimate"] as const) {
      for (const countryConflict of [true, false]) {
        const { score } = inferredGeoConfidence({ source, countryConflict });
        expect(score).toBe(Number(score.toFixed(2)));
      }
    }
  });

  it("pins the exact published values", () => {
    // These four numbers are a public API contract — they appear in
    // openapi.yaml with the measurement behind them, so a caller may have
    // written a threshold against them. Changing one should require editing
    // this test, which is the moment to ask whether the doc still matches.
    expect(inferredGeoConfidence({ source: "dbip-lite", countryConflict: false }).score).toBe(0.6);
    expect(inferredGeoConfidence({ source: "dbip-lite", countryConflict: true }).score).toBe(0.55);
    expect(inferredGeoConfidence({ source: "country-estimate", countryConflict: false }).score).toBe(
      0.2,
    );
    expect(inferredGeoConfidence({ source: "country-estimate", countryConflict: true }).score).toBe(
      0.15,
    );
  });
});
