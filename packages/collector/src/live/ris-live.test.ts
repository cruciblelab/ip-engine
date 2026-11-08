import { describe, it, expect } from "vitest";
import { originFromPath, isKnownOrigin, knownAsList } from "./ris-live";

describe("originFromPath", () => {
  it("takes the last ASN of the path", () => {
    expect(originFromPath([18106, 4657, 9002, 401363])).toBe(401363);
    expect(originFromPath([13335])).toBe(13335);
  });

  it("returns null for shapes with no single origin", () => {
    // An AS_SET tail is a *set* of origins by definition (RIS delivers it as
    // a nested array) — picking one member would state something the
    // protocol didn't. Empty/absent paths are iBGP or malformed.
    expect(originFromPath([174, [64496, 64497]])).toBeNull();
    expect(originFromPath([])).toBeNull();
    expect(originFromPath(undefined)).toBeNull();
    expect(originFromPath(null)).toBeNull();
    expect(originFromPath("64496")).toBeNull();
  });

  it("rejects non-positive and non-finite tails rather than recording them", () => {
    expect(originFromPath([174, 0])).toBeNull();
    expect(originFromPath([174, -1])).toBeNull();
    expect(originFromPath([174, Number.NaN])).toBeNull();
  });

  it("accepts 32-bit ASNs, which are ordinary now", () => {
    expect(originFromPath([3356, 4200000001])).toBe(4200000001);
  });
});

describe("isKnownOrigin / knownAsList", () => {
  it("treats a single stored origin correctly", () => {
    expect(isKnownOrigin(15169, 15169)).toBe(true);
    expect(isKnownOrigin(15169, 16509)).toBe(false);
    expect(knownAsList(15169)).toEqual([15169]);
  });

  it("accepts any member of a MOAS set — the whole reason this is a set", () => {
    // A prefix legitimately announced by more than one AS is ordinary. If
    // the second origin counted as a change, real signal would be buried
    // under thousands of these.
    expect(isKnownOrigin([16509, 21664], 21664)).toBe(true);
    expect(isKnownOrigin([16509, 21664], 16509)).toBe(true);
    expect(isKnownOrigin([16509, 21664], 13335)).toBe(false);
    expect(knownAsList([16509, 21664])).toEqual([16509, 21664]);
  });

  it("treats an absent entry as unknown, not as a match", () => {
    expect(isKnownOrigin(undefined, 15169)).toBe(false);
    expect(knownAsList(undefined)).toEqual([]);
  });
});
