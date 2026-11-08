import { describe, expect, it } from "vitest";
import {
  formatIpv6,
  iterMrtRibPrefixes,
  MrtFormatError,
  originOfAsPath,
  type MrtPrefixOrigins,
} from "./mrt";

/* Builders for hand-made MRT bytes, following RFC 6396 field by field. */

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
function record(type: number, subtype: number, body: Buffer): Buffer {
  return Buffer.concat([u32(0), u16(type), u16(subtype), u32(body.length), body]);
}
function asPath(...segments: Array<[number, number[]]>): Buffer {
  return Buffer.concat(segments.map(([t, asns]) => Buffer.concat([Buffer.from([t, asns.length]), ...asns.map(u32)])));
}
/** A path-attribute block: ORIGIN (type 1), then AS_PATH (type 2). */
function attrs(path: Buffer, extended = false): Buffer {
  const origin = Buffer.from([0x40, 1, 1, 0]);
  const pathAttr = extended
    ? Buffer.concat([Buffer.from([0x50, 2]), u16(path.length), path])
    : Buffer.concat([Buffer.from([0x40, 2, path.length]), path]);
  return Buffer.concat([origin, pathAttr]);
}
function ribBody(prefixLen: number, prefixBytes: number[], entries: Array<{ peer: number; attrs: Buffer; pathId?: number }>): Buffer {
  return Buffer.concat([
    u32(1),
    Buffer.from([prefixLen, ...prefixBytes]),
    u16(entries.length),
    ...entries.map((e) =>
      Buffer.concat([u16(e.peer), u32(0), ...(e.pathId !== undefined ? [u32(e.pathId)] : []), u16(e.attrs.length), e.attrs]),
    ),
  ]);
}
const PEER_INDEX = record(13, 1, Buffer.concat([u32(0), u16(0), u16(0)]));
const SEQ = 2;
const SET = 1;

async function collect(bytes: Buffer, chunkSize = bytes.length): Promise<MrtPrefixOrigins[]> {
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  }
  const out: MrtPrefixOrigins[] = [];
  for await (const p of iterMrtRibPrefixes(chunks())) out.push(p);
  return out;
}

describe("originOfAsPath", () => {
  it("takes the last ASN of a final AS_SEQUENCE", () => {
    expect(originOfAsPath(asPath([SEQ, [3356, 1299, 4200000001]]))).toBe(4200000001);
  });
  it("accepts a final AS_SET of exactly one ASN", () => {
    expect(originOfAsPath(asPath([SEQ, [3356]], [SET, [64500]]))).toBe(64500);
  });
  it("refuses a final AS_SET of several ASNs instead of guessing", () => {
    expect(originOfAsPath(asPath([SEQ, [3356]], [SET, [64500, 64501]]))).toBeNull();
  });
  it("refuses an empty path", () => {
    expect(originOfAsPath(Buffer.alloc(0))).toBeNull();
  });
  it("throws on a truncated segment", () => {
    expect(() => originOfAsPath(Buffer.from([SEQ, 2, 0, 0, 0, 1]))).toThrow(MrtFormatError);
  });
});

describe("formatIpv6", () => {
  it.each([
    ["20010db8000000000000000000000000", "2001:db8::"],
    ["00000000000000000000000000000001", "::1"],
    ["20010db8000000010000000000000001", "2001:db8:0:1::1"],
    ["20010db8000000000001000000000000", "2001:db8:0:0:1::"],
    // Two equal zero runs: RFC 5952 compresses the first.
    ["20010db8000000000001000000000001", "2001:db8::1:0:0:1"],
    ["20010db8000100010001000100010001", "2001:db8:1:1:1:1:1:1"],
  ])("%s -> %s", (hex, text) => {
    expect(formatIpv6(Buffer.from(hex, "hex"))).toBe(text);
  });
});

describe("iterMrtRibPrefixes", () => {
  const file = Buffer.concat([
    PEER_INDEX,
    // 192.0.2.0/24: peers 0 and 1 say AS64500, peer 2 says AS64501 (MOAS).
    record(13, 2, ribBody(24, [192, 0, 2], [
      { peer: 0, attrs: attrs(asPath([SEQ, [3356, 64500]])) },
      { peer: 1, attrs: attrs(asPath([SEQ, [1299, 64500]]), true) },
      { peer: 2, attrs: attrs(asPath([SEQ, [174, 64501]])) },
    ])),
    // 2001:db8::/32 with a host bit set in the encoding — must come out zeroed.
    record(13, 4, ribBody(31, [0x20, 0x01, 0x0d, 0xb9], [
      { peer: 0, attrs: attrs(asPath([SEQ, [6939, 64502]])) },
    ])),
    // ADD-PATH: the same peer twice with the same origin counts once.
    record(13, 8, ribBody(16, [198, 51], [
      { peer: 3, pathId: 1, attrs: attrs(asPath([SEQ, [64503]])) },
      { peer: 3, pathId: 2, attrs: attrs(asPath([SEQ, [2914, 64503]])) },
    ])),
    // Only an aggregated AS_SET origin: no usable origin, counted as ambiguous.
    record(13, 2, ribBody(8, [10], [
      { peer: 0, attrs: attrs(asPath([SEQ, [3356]], [SET, [1, 2]])) },
    ])),
    // Multicast RIB and a non-TABLE_DUMP_V2 record are skipped, not parsed.
    record(13, 3, Buffer.from([1, 2, 3])),
    record(16, 4, Buffer.from([9, 9])),
  ]);

  it("yields one entry per unicast prefix with distinct-peer origin counts", async () => {
    const out = await collect(file);
    expect(out).toEqual([
      { family: 4, prefix: "192.0.2.0/24", prefixLen: 24, origins: [{ asn: 64500, peers: 2 }, { asn: 64501, peers: 1 }], ambiguousPeers: 0 },
      { family: 6, prefix: "2001:db8::/31", prefixLen: 31, origins: [{ asn: 64502, peers: 1 }], ambiguousPeers: 0 },
      { family: 4, prefix: "198.51.0.0/16", prefixLen: 16, origins: [{ asn: 64503, peers: 1 }], ambiguousPeers: 0 },
      { family: 4, prefix: "10.0.0.0/8", prefixLen: 8, origins: [], ambiguousPeers: 1 },
    ]);
  });

  it("gives the same result however the input is chunked", async () => {
    const whole = await collect(file);
    for (const size of [1, 7, 13, 100]) expect(await collect(file, size)).toEqual(whole);
  });

  it("fails on input cut off mid-record — a truncated download must not ingest half a table", async () => {
    await expect(collect(file.subarray(0, file.length - 1))).rejects.toThrow(MrtFormatError);
  });

  it("fails on a RIB record whose entries run past its own length", async () => {
    const bad = record(13, 2, ribBody(24, [192, 0, 2], [{ peer: 0, attrs: attrs(asPath([SEQ, [1]])) }]).subarray(0, 12));
    await expect(collect(Buffer.concat([PEER_INDEX, bad]))).rejects.toThrow(MrtFormatError);
  });
});
