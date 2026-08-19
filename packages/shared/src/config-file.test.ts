import { describe, expect, it } from "vitest";
import {
  parseListValue,
  parseNumberValue,
  parseEnumValue,
  parseStringValue,
  parseBooleanValue,
  validateAgainstKnown,
} from "./config-file";

describe("parseListValue", () => {
  it("returns null when the key is absent", () => {
    expect(parseListValue(undefined, "collection", "database_full")).toBeNull();
    expect(parseListValue(null, "collection", "database_full")).toBeNull();
  });

  it("returns null for the all-keyword or an empty string", () => {
    expect(parseListValue("database_full", "collection", "database_full")).toBeNull();
    expect(parseListValue("", "collection", "database_full")).toBeNull();
    expect(parseListValue("   ", "collection", "database_full")).toBeNull();
  });

  it("splits, trims, and drops empty entries from a comma-separated list", () => {
    expect(parseListValue("arin, ripencc ,,apnic", "collection", "database_full")).toEqual([
      "arin",
      "ripencc",
      "apnic",
    ]);
  });

  it("throws on a non-string value", () => {
    expect(() => parseListValue(42, "collection", "database_full")).toThrow(/must be a string/);
  });
});

describe("validateAgainstKnown", () => {
  it("passes null through unchanged", () => {
    expect(validateAgainstKnown(null, ["arin", "ripencc"], "collection")).toBeNull();
  });

  it("keeps only known ids and warns about the rest, without throwing", () => {
    const result = validateAgainstKnown(["arin", "bogus"], ["arin", "ripencc"], "collection");
    expect(result).toEqual(["arin"]);
  });

  it("keeps everything when all ids are known", () => {
    expect(validateAgainstKnown(["arin", "ripencc"], ["arin", "ripencc"], "collection")).toEqual([
      "arin",
      "ripencc",
    ]);
  });
});

describe("parseNumberValue", () => {
  it("falls back when absent", () => {
    expect(parseNumberValue(undefined, "batchSize", 2000)).toBe(2000);
  });

  it("accepts an in-range integer", () => {
    expect(parseNumberValue(500, "batchSize", 2000, { min: 1, max: 100_000 })).toBe(500);
  });

  it("throws on a non-integer", () => {
    expect(() => parseNumberValue(1.5, "batchSize", 2000)).toThrow(/must be an integer/);
    expect(() => parseNumberValue("2000", "batchSize", 2000)).toThrow(/must be an integer/);
  });

  it("throws outside the min/max bounds", () => {
    expect(() => parseNumberValue(0, "batchSize", 2000, { min: 1, max: 100_000 })).toThrow(
      /must be between/,
    );
    expect(() => parseNumberValue(200_000, "batchSize", 2000, { min: 1, max: 100_000 })).toThrow(
      /must be between/,
    );
  });
});

describe("parseEnumValue", () => {
  const modes = ["view", "materialized", "off"] as const;

  it("falls back when absent", () => {
    expect(parseEnumValue(undefined, "ipIntelMode", modes, "view")).toBe("view");
  });

  it("accepts a listed value", () => {
    expect(parseEnumValue("materialized", "ipIntelMode", modes, "view")).toBe("materialized");
  });

  it("throws on a value outside the allowed set", () => {
    expect(() => parseEnumValue("bogus", "ipIntelMode", modes, "view")).toThrow(
      /must be one of/,
    );
  });
});

describe("parseStringValue", () => {
  it("falls back when absent", () => {
    expect(parseStringValue(undefined, "exportDir", ".")).toBe(".");
  });

  it("passes a string through as-is", () => {
    expect(parseStringValue("/srv/exports", "exportDir", ".")).toBe("/srv/exports");
  });

  it("throws on a non-string", () => {
    expect(() => parseStringValue(42, "exportDir", ".")).toThrow(/must be a string/);
  });
});

describe("parseBooleanValue", () => {
  it("falls back when absent", () => {
    expect(parseBooleanValue(undefined, "backupEnabled", false)).toBe(false);
  });

  it("passes booleans through", () => {
    expect(parseBooleanValue(true, "backupEnabled", false)).toBe(true);
    expect(parseBooleanValue(false, "backupEnabled", true)).toBe(false);
  });

  it("throws on a non-boolean", () => {
    expect(() => parseBooleanValue("true", "backupEnabled", false)).toThrow(/must be a boolean/);
  });
});
