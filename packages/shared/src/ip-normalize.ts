/**
 * One shared normalization step used at *every* entry point that accepts a
 * raw IP address string — ingestion and lookup alike — so the two can
 * never quietly diverge in how they treat the same address.
 *
 * The concrete problem this solves: Postgres's `inet` type treats
 * `::ffff:1.1.1.1` (the IPv4-mapped-IPv6 notation dual-stack systems often
 * produce) as a completely different value from `1.1.1.1` — `'::ffff:1.1.1.1'
 * ::inet <<= '1.1.1.0/24'::inet` is false. A client that happens to send
 * the mapped form for an address we have real IPv4 data for would silently
 * get "not found" instead of the right answer. Collapsing that form to
 * plain IPv4 here, once, means every query and every stored row is already
 * in the same canonical shape by the time it reaches SQL.
 *
 * Deliberately narrow: only handles the common textual `::ffff:a.b.c.d`
 * form. The rarer all-hex form (`::ffff:0101:0101`) is not handled — it's
 * not a shape real API callers send in practice, and guessing at it would
 * add regex complexity for a case we've never actually seen.
 */
const IPV4_MAPPED_RX = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  const mapped = trimmed.match(IPV4_MAPPED_RX);
  return mapped ? mapped[1]! : trimmed;
}
