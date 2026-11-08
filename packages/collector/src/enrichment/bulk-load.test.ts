/**
 * Pins the COPY CSV encoding rules.
 *
 * This is the whole trust surface of the fast ingest path: every row goes
 * through `encodeCsvRow`, and a mistake here does not throw — it silently
 * shifts fields, so a city lands in `region` and nobody notices until a
 * lookup answers nonsense. The integration test alongside this one checks
 * the same values survive a real Postgres round trip; this one checks the
 * bytes.
 */
import { describe, expect, it } from "vitest";
import { __testing } from "./bulk-load";

const { encodeCsvRow } = __testing;

describe("encodeCsvRow", () => {
  it("quotes every string field", () => {
    expect(encodeCsvRow(["1.2.3.0/24", "US", "Kansas", "Overland Park"])).toBe(
      '"1.2.3.0/24","US","Kansas","Overland Park"\n',
    );
  });

  it("emits numbers unquoted", () => {
    expect(encodeCsvRow(["a", 38.9759, -94.6815])).toBe('"a",38.9759,-94.6815\n');
  });

  it("distinguishes NULL from an empty string", () => {
    // The one asymmetry the format has, and the reason every string is
    // quoted: unquoted-empty is NULL, quoted-empty is ''.
    expect(encodeCsvRow([null, ""])).toBe(',""\n');
    expect(encodeCsvRow([undefined, ""])).toBe(',""\n');
  });

  it("doubles embedded quotes", () => {
    expect(encodeCsvRow(['say "hi"'])).toBe('"say ""hi"""\n');
  });

  it("passes commas through untouched (they are inside quotes)", () => {
    expect(encodeCsvRow(["Washington, D.C."])).toBe('"Washington, D.C."\n');
  });

  it("passes backslashes through untouched", () => {
    // The reason CSV was chosen over COPY's text format: there, this value
    // would need escaping and a miss would corrupt the row.
    expect(encodeCsvRow(["back\\slash"])).toBe('"back\\slash"\n');
  });

  it("passes embedded newlines and tabs through", () => {
    // Legal inside a quoted CSV field; Postgres reassembles the row.
    expect(encodeCsvRow(["two\nlines"])).toBe('"two\nlines"\n');
    expect(encodeCsvRow(["a\tb"])).toBe('"a\tb"\n');
  });

  it("keeps non-ASCII intact", () => {
    expect(encodeCsvRow(["Kırıkkale", "İzmir", "北京", "Sāo Paulo"])).toBe(
      '"Kırıkkale","İzmir","北京","Sāo Paulo"\n',
    );
  });

  it("writes non-finite numbers as NULL rather than an unparseable literal", () => {
    // `double precision` would reject "NaN"/"Infinity" spelled this way, and
    // a rejected COPY fails the whole source. The callers already filter
    // these; this is the backstop for one that forgets.
    expect(encodeCsvRow([Number.NaN, Number.POSITIVE_INFINITY, 1])).toBe(",,1\n");
  });

  it("handles a row that is entirely NULL", () => {
    expect(encodeCsvRow([null, null, null])).toBe(",,\n");
  });

  it("handles a single-column row", () => {
    expect(encodeCsvRow(["x"])).toBe('"x"\n');
  });
});
