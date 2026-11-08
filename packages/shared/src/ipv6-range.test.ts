import { describe, it, expect } from "vitest";
import { parseIpv6, formatIpv6, rangeToCidrs6 } from "./ipv6-range";

describe("parseIpv6", () => {
  it("parses full uncompressed notation", () => {
    expect(parseIpv6("0000:0000:0000:0000:0000:0000:0000:0000")).toBe(0n);
    expect(parseIpv6("0000:0000:0000:0000:0000:0000:0000:0001")).toBe(1n);
    expect(parseIpv6("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe((1n << 128n) - 1n);
    expect(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      0x20010db8000000000000000000000001n,
    );
  });

  it("parses :: compression in every position", () => {
    expect(parseIpv6("::")).toBe(0n);
    expect(parseIpv6("::1")).toBe(1n);
    expect(parseIpv6("1::")).toBe(1n << 112n);
    expect(parseIpv6("2001:db8::1")).toBe(0x20010db8000000000000000000000001n);
    expect(parseIpv6("2001:db8::")).toBe(0x20010db80000000000000000000000000n >> 4n);
  });

  it("agrees with itself on compressed vs expanded forms of the same address", () => {
    // The property that actually matters: two spellings of one address must
    // produce one value.
    const pairs: Array<[string, string]> = [
      ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"],
      ["::1", "0000:0000:0000:0000:0000:0000:0000:0001"],
      ["fe80::", "fe80:0000:0000:0000:0000:0000:0000:0000"],
      ["2a19:3e0:ff70::2", "2a19:03e0:ff70:0000:0000:0000:0000:0002"],
    ];
    for (const [compressed, expanded] of pairs) {
      expect(parseIpv6(compressed)).toBe(parseIpv6(expanded));
    }
  });

  it("parses an embedded IPv4 tail — RIS dumps really contain these", () => {
    // ::ffff:1.2.3.4 is the IPv4-mapped form; the low 32 bits are the quad.
    expect(parseIpv6("::ffff:1.2.3.4")).toBe(0xffff01020304n);
    expect(parseIpv6("::1.2.3.4")).toBe(0x01020304n);
    // Same address, written both ways.
    expect(parseIpv6("::ffff:255.255.255.255")).toBe(parseIpv6("::ffff:ffff:ffff"));
  });

  it("rejects malformed input rather than guessing a plausible address", () => {
    for (const bad of [
      "",
      "  ",
      "not-an-address",
      "2001:db8",                       // too few groups, no ::
      "1:2:3:4:5:6:7:8:9",              // too many
      "1:2:3:4:5:6:7:8:9:a:b:c:d:e:f:0",
      "2001::db8::1",                   // two :: — ambiguous
      "2001:db8:::1",
      "12345::",                        // group too long
      "2001:zzzz::1",                   // non-hex
      "1:2:3:4:5:6:7:8::",              // :: standing for zero groups
      "::ffff:1.2.3",                   // short quad
      "::ffff:1.2.3.4.5",               // long quad
      "::ffff:256.1.1.1",               // octet out of range
      "::ffff:01.2.3.4",                // leading-zero octet
      "1.2.3.4",                        // no colon at all
    ]) {
      expect(parseIpv6(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("formatIpv6", () => {
  it("renders full uncompressed groups, zero-padded", () => {
    expect(formatIpv6(0n)).toBe("0000:0000:0000:0000:0000:0000:0000:0000");
    expect(formatIpv6(1n)).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(formatIpv6((1n << 128n) - 1n)).toBe("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
    expect(formatIpv6(0x20010db8000000000000000000000001n)).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
  });

  it("round-trips with parseIpv6 across the whole width", () => {
    // One value per 16-bit group boundary plus edges — catches shift/mask
    // errors that only show up in one lane.
    const values = [0n, 1n, (1n << 128n) - 1n];
    for (let i = 0; i < 128; i++) values.push(1n << BigInt(i));
    for (const v of values) {
      expect(parseIpv6(formatIpv6(v)), `round-trip failed for ${v}`).toBe(v);
    }
  });

  it("refuses values outside the address space", () => {
    expect(() => formatIpv6(-1n)).toThrow(RangeError);
    expect(() => formatIpv6(1n << 128n)).toThrow(RangeError);
  });
});

describe("rangeToCidrs6", () => {
  it("returns a single prefix for an already-aligned range", () => {
    // 2001:db8::/32 expressed as its start/end pair.
    const start = parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0000")!;
    const end = parseIpv6("2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff")!;
    expect(rangeToCidrs6(start, end)).toEqual(["2001:0db8:0000:0000:0000:0000:0000:0000/32"]);
  });

  it("handles a single address as a /128", () => {
    const a = parseIpv6("2001:db8::5")!;
    expect(rangeToCidrs6(a, a)).toEqual(["2001:0db8:0000:0000:0000:0000:0000:0005/128"]);
  });

  it("covers the entire address space as ::/0", () => {
    expect(rangeToCidrs6(0n, (1n << 128n) - 1n)).toEqual([
      "0000:0000:0000:0000:0000:0000:0000:0000/0",
    ]);
  });

  it("splits an unaligned range into the minimal aligned set", () => {
    // ::1 through ::4 — cannot be one block: 1 is odd, so /128, then ::2-::3
    // is an aligned /127, then ::4 alone.
    expect(rangeToCidrs6(1n, 4n)).toEqual([
      "0000:0000:0000:0000:0000:0000:0000:0001/128",
      "0000:0000:0000:0000:0000:0000:0000:0002/127",
      "0000:0000:0000:0000:0000:0000:0000:0004/128",
    ]);
  });

  it("returns [] for an inverted or out-of-range input instead of throwing", () => {
    expect(rangeToCidrs6(10n, 5n)).toEqual([]);
    expect(rangeToCidrs6(-1n, 5n)).toEqual([]);
    expect(rangeToCidrs6(0n, 1n << 128n)).toEqual([]);
  });

  /**
   * The property that actually matters, checked exhaustively on small ranges
   * and randomly on large ones: the emitted prefixes must cover [start, end]
   * exactly — every address in, nothing outside, no overlaps.
   *
   * Verified here by decoding each prefix back to its own numeric span and
   * checking the spans tile the input contiguously. `ipv6-range.pg.test.ts`
   * re-checks the same property against Postgres' native `inet` as an
   * independent implementation.
   */
  function assertExactCover(start: bigint, end: bigint): void {
    const cidrs = rangeToCidrs6(start, end);
    expect(cidrs.length, `no cidrs for ${start}..${end}`).toBeGreaterThan(0);
    let cursor = start;
    for (const cidr of cidrs) {
      const slash = cidr.lastIndexOf("/");
      const base = parseIpv6(cidr.slice(0, slash));
      const prefixLen = Number(cidr.slice(slash + 1));
      expect(base, `unparseable cidr ${cidr}`).not.toBeNull();
      const size = 1n << BigInt(128 - prefixLen);
      // Aligned: the base must be a multiple of its own block size.
      expect(base! % size, `unaligned block ${cidr}`).toBe(0n);
      // Contiguous with what came before — proves no gaps and no overlaps.
      expect(base, `gap or overlap at ${cidr} (expected ${cursor})`).toBe(cursor);
      cursor = base! + size;
    }
    // Ends exactly on the boundary — proves nothing outside the range.
    expect(cursor - 1n, `wrong end for ${start}..${end}`).toBe(end);
  }

  it("covers every small range exactly (exhaustive 0..40 x 0..40)", () => {
    for (let a = 0n; a <= 40n; a++) {
      for (let b = a; b <= 40n; b++) assertExactCover(a, b);
    }
  });

  it("covers ranges straddling group boundaries exactly", () => {
    // Where shift/mask bugs hide: on and around each 16-bit lane edge.
    const MAX = (1n << 128n) - 1n;
    const clampLow = (v: bigint): bigint => (v < 0n ? 0n : v);
    const clampHigh = (v: bigint): bigint => (v > MAX ? MAX : v);
    for (let i = 0; i < 128; i++) {
      const boundary = 1n << BigInt(i);
      assertExactCover(clampLow(boundary - 1n), clampHigh(boundary + 1n));
      assertExactCover(boundary, clampHigh(boundary + 7n));
      assertExactCover(clampLow(boundary - 3n), boundary);
    }
  });

  it("covers randomly generated large ranges exactly", () => {
    // Deterministic PRNG so a failure is reproducible rather than a
    // one-off that vanishes on re-run.
    let seed = 0x2026_08_23n;
    const next = (): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      const start = ((next() << 64n) | next()) & ((1n << 128n) - 1n);
      const span = next() % 100_000n;
      const end = start + span > (1n << 128n) - 1n ? (1n << 128n) - 1n : start + span;
      assertExactCover(start, end);
    }
  });

  it("reproduces the worst real case found in the DB-IP file without exploding", () => {
    // Measured 2026-08-23 as the single worst-splitting range in the real
    // 4.27M-row file: 105 prefixes. Pinned so a future "optimisation" that
    // silently changes the split is caught.
    const start = parseIpv6("2a19:3e0:ff70::2")!;
    const end = parseIpv6("2a1b:3e0:1300::3")!;
    const cidrs = rangeToCidrs6(start, end);
    expect(cidrs).toHaveLength(105);
    assertExactCover(start, end);
  });
});
