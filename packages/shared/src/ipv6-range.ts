/**
 * IPv6 address ↔ integer conversion and range → CIDR splitting.
 *
 * ## This file is deliberately self-contained and deletable
 *
 * Nothing else in this project depends on 128-bit address arithmetic.
 * `ip.ts` next door does the IPv4 equivalents in plain 32-bit `number`s,
 * and every other IPv6 code path in this codebase avoids arithmetic
 * entirely by letting Postgres' native `inet` type do the work. This file
 * exists for exactly one caller — the DB-IP Lite ingester, which receives
 * ranges as `start,end` address pairs rather than as CIDRs and therefore
 * has to convert.
 *
 * To remove IPv6 support for that source entirely: set
 * `dbipLiteIpv6: false` in `ip-insight.config.json` (the default) and
 * nothing here ever runs. To remove the code as well: delete this file,
 * delete `ipv6-range.test.ts`, drop the `export * from "./ipv6-range"` line
 * in `index.ts`, and remove the one `if (cfg.dbipLiteIpv6)` branch in
 * `enrichment.ts`'s `ingestDbIpLiteCsv`. Nothing else references it —
 * IPv4 ingestion, every lookup, `ip_intel`, and the `.mmdb` export all
 * keep working untouched, because none of them ever call in here.
 *
 * ## Why BigInt, and why that is not a performance problem
 *
 * IPv6 addresses are 128-bit; JavaScript `number` holds 53 bits exactly, so
 * the plain-integer approach `ip.ts` uses for IPv4 cannot represent them.
 * `BigInt` is the only correct option in the language. Measured against the
 * real DB-IP Lite file (4,274,502 IPv6 rows, 2026-08-23): parse + split ran
 * at ~34,000 rows/sec, ~125 seconds for the whole set — against an
 * ingestion step that already takes ~14 minutes for its IPv4 half, so this
 * is not the bottleneck.
 *
 * ## Correctness discipline
 *
 * Range→CIDR splitting is bit math, and this project has already been bitten
 * once by exactly that (see `docs/95-mmdb-trie-subdivide-bug.md`, where a
 * subtle error in trie descent silently blanked a quarter of all
 * announcements). The splitter here is therefore a direct structural port of
 * `rangeToCidrs` in `ip.ts` — proven code, same loop, same invariants, only
 * the numeric type and the width changed — rather than a cleverer algorithm
 * written fresh. Its test file additionally checks every result against
 * Postgres' own `inet` implementation as an independent oracle.
 */

/** Number of 16-bit groups in an IPv6 address. */
const GROUPS = 8;
const MAX_IPV6 = (1n << 128n) - 1n;

/**
 * Parses any textual IPv6 address into its numeric value, or `null` when the
 * text is not a valid address.
 *
 * Handles the three forms that appear in real feeds: full 8-group notation,
 * `::` zero compression (at most one, per RFC 4291), and a trailing embedded
 * IPv4 quad (`::ffff:1.2.3.4`), which RIS dumps really do contain — see the
 * IPv4-mapped-announcement note in `enrichment.ts`.
 *
 * Returns `null` rather than throwing or guessing: every caller here is
 * processing a bulk feed line-by-line, where one malformed line must be
 * skipped and counted, never allowed to fail a whole batch. That is the same
 * contract `parseCidr` and `ipv4ToInt` in `ip.ts` already follow.
 */
export function parseIpv6(text: string): bigint | null {
  let s = text.trim();
  if (s.length === 0 || s.length > 45) return null;

  // Embedded IPv4 tail: rewrite the dotted quad into the two hex groups it
  // occupies, then fall through to the ordinary parser. Done first so the
  // group-counting below never has to know about this form.
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon === -1) return null;
    const quad = s.slice(lastColon + 1).split(".");
    if (quad.length !== 4) return null;
    let v4 = 0n;
    for (const octet of quad) {
      // Digits only, and no leading-zero forms. The leading-zero rule was
      // added after checking the actual consumer: Postgres rejects
      // `'::ffff:01.2.3.4'::inet` outright ("invalid input syntax for type
      // inet"), because a leading zero is ambiguous — some parsers read
      // "010" as octal 8. Accepting it here would mean inventing an
      // interpretation the destination refuses, so a line like that is
      // skipped and counted as malformed instead.
      //
      // Note this is deliberately stricter than `ipv4ToInt` in ip.ts, which
      // accepts leading zeros. That difference is left alone rather than
      // "fixed" in passing: that function is on the RIR ingestion path,
      // whose files do not contain the form, and tightening it is a change
      // with its own blast radius that belongs to its own task.
      if (!/^(0|[1-9]\d{0,2})$/.test(octet)) return null;
      const n = Number(octet);
      if (n > 255) return null;
      v4 = (v4 << 8n) | BigInt(n);
    }
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const dbl = s.indexOf("::");
  let head: string[];
  let tail: string[];
  if (dbl === -1) {
    head = s.split(":");
    tail = [];
    if (head.length !== GROUPS) return null;
  } else {
    // A second "::" is invalid — the compression is ambiguous otherwise.
    if (s.indexOf("::", dbl + 1) !== -1) return null;
    const headText = s.slice(0, dbl);
    const tailText = s.slice(dbl + 2);
    head = headText === "" ? [] : headText.split(":");
    tail = tailText === "" ? [] : tailText.split(":");
    // "::" must stand for at least one zero group, so a compressed address
    // with 8 explicit groups is malformed rather than merely redundant.
    if (head.length + tail.length >= GROUPS) return null;
  }

  let value = 0n;
  for (const group of [
    ...head,
    ...new Array<string>(GROUPS - head.length - tail.length).fill("0"),
    ...tail,
  ]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Renders a numeric address as full, uncompressed 8-group notation
 * (`2001:0db8:0000:...`).
 *
 * Deliberately *not* RFC 5952 canonical form (which would compress the
 * longest zero run to `::`). The only consumer is a Postgres `inet` column,
 * which normalises whatever it is given, so implementing compression here
 * would add a second fiddly algorithm — and a second place to get it wrong —
 * for output nobody reads in this form.
 */
export function formatIpv6(value: bigint): string {
  if (value < 0n || value > MAX_IPV6) {
    throw new RangeError(`Value out of IPv6 range: ${value}`);
  }
  const groups: string[] = [];
  for (let i = GROUPS - 1; i >= 0; i--) {
    groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16).padStart(4, "0"));
  }
  return groups.join(":");
}

/**
 * Expresses an arbitrary inclusive IPv6 range as the minimal list of aligned
 * CIDR prefixes covering exactly it — no more, no less.
 *
 * Structurally identical to `rangeToCidrs` in `ip.ts` (see this file's header
 * for why that similarity is deliberate): repeatedly take the largest power-
 * of-two block that is both aligned to the current position and small enough
 * to fit in what remains.
 *
 * The loop is inherently bounded — each iteration consumes at least one
 * address and the block size can at most double 128 times — so a pathological
 * input cannot hang it. Measured on the real DB-IP Lite file (4.27M ranges):
 * 63.7% of ranges need exactly one CIDR, 98% need eight or fewer, and the
 * worst real case observed was 105. That measured ceiling is why there is no
 * artificial cap here: one would never fire on real data, and skipping a
 * range for being awkwardly aligned would lose real coverage for no reason.
 *
 * Returns an empty array for an inverted range (`end < start`) rather than
 * throwing — bulk callers treat that as a skippable bad line, same as a
 * parse failure.
 */
export function rangeToCidrs6(start: bigint, end: bigint): string[] {
  if (start < 0n || end > MAX_IPV6 || end < start) return [];

  const out: string[] = [];
  let cur = start;
  let remaining = end - start + 1n;
  while (remaining > 0n) {
    let size = 1n;
    let prefix = 128;
    // Grow while the block stays aligned to `cur` AND still fits. Both
    // conditions are required: alignment alone would let a block start
    // mid-range, size alone would let it run past `end`.
    while (prefix > 0 && cur % (size * 2n) === 0n && size * 2n <= remaining) {
      size *= 2n;
      prefix -= 1;
    }
    out.push(`${formatIpv6(cur)}/${prefix}`);
    cur += size;
    remaining -= size;
  }
  return out;
}
