# The .mmdb trie subdivide bug (2026-08-19)

Found because `mmdb publish`'s golden-set check did exactly its job: it
rejected a candidate over one failed case rather than promoting it, on the
phone. Traced through underlying data first (ruled out — `ip_intel` and
every source table had the correct answer), then reproduced in this
sandbox against real data, then isolated to a 3-line unit test, then fixed
in `packages/collector/src/export/mmdb-writer.ts`.

## The bug

`Trie.insert()` builds the on-disk MaxMind DB tree bit by bit. When a
narrower prefix's insertion walk passes *through* a shallower prefix's own
terminal slot — not stopping there, continuing deeper, because the
narrower prefix's own terminal sits further down — the code replaced that
shallower terminal with a brand-new, **empty** interior node:

```ts
// old code
this.ensure(this.count + 1);
const child = this.count++;
this.slots[slot] = child;   // both of `child`'s slots default to -1 (empty)
node = child;
```

That is correct for the branch the narrower prefix actually continues
into. It is wrong for the *sibling* branch — the one nothing more specific
ever touches — which should still answer with the shallower prefix's data,
but was left with "no data" instead. The result: **every address under the
shallower prefix except the exact narrower one returned `null`**, not a
wrong-but-present answer — a silent, total loss of that block's data.

## How it was found

`mmdb publish` on the phone rejected a candidate: `golden:193.0.6.139 —
country: expected "NL", got undefined; asn: expected 3333, got undefined`.
Investigation order, each step ruling one thing out before moving to the
next:

1. `bgp_origin_ranges`, `ip_blocks`, `geofeed_ranges` on the phone — all
   correct (`193.0.0.0/21 → NL, AS3333`). Not a data problem.
2. `ip_intel` itself — also correct. Not an `ip_intel` problem.
3. Reproduced the exact same failure in this sandbox against its own real
   (independently-confirmed-correct) data — rules out anything
   phone-specific.
4. Probed the built candidate address-by-address: every address in
   `193.0.0.0/21` (193.0.0.0–193.0.7.255) returned `null`; the sibling
   block `193.0.8.0/21` (different prefixes, same parent /20) resolved
   correctly. Not a general depth-21 bug — something specific to this one
   block.
5. Checked every source table for anything nested inside `193.0.0.0/21`:
   found `193.0.0.128/29` in `bgp_origin_ranges` — a narrower, separately
   announced prefix inside RIPE NCC's own /21. Exactly the shape
   `ip_intel.wider_prefix_asn` exists to flag (a narrower announcement
   nested inside a wider one from a different origin).
6. Reproduced with a 3-line synthetic test (`/20`, `/21`, `/29` only, no
   real data at all) — confirmed the bug lives entirely in
   `mmdb-writer.ts`'s trie logic, independent of everything else.

## Real-world scope — likely larger than one address

`ip-intel.ts`'s own prior research already measured, on a real sample of
this database: **~27% of announced prefixes have a wider containing
prefix from a different origin ASN.** That number was gathered for
`wider_prefix_asn` (a hijack-detection signal), but it describes the exact
structural shape this bug corrupts — so it's a real lower bound on how
much of the exported `.mmdb` was affected, not a coincidence.

It is a lower bound, not the true count: `wider_prefix_asn` only counts
*different-ASN* nesting (that's what makes it a useful hijack signal).
`Trie.insert()` has no concept of ASN at all — it corrupts on **any**
nested prefix pair, same-ASN or not (an ISP publishing a `/16` and several
`/24`s inside it under its own ASN hits this exactly the same way). The
true affected fraction was not independently re-measured here, but has no
reason to be smaller than 27%.

This means every `.mmdb` this project has ever published likely had a
meaningful fraction of its wider/aggregate-level prefixes silently
returning no data for addresses not covered by a more specific nested
entry — present in `ip_intel`, present in the exported file's data
section, simply unreachable by a correct lookup.

## The fix

Propagate the terminal being subdivided into *both* slots of the new
interior node, so it remains the default answer until (and unless)
something more specific overrides one branch of it:

```ts
if (value <= -2) {
  this.slots[child * 2] = value;
  this.slots[child * 2 + 1] = value;
}
```

Verified three ways:
1. Unit test: 3 synthetic entries (`/20`, `/21` nested `/29`) — the wider
   prefix now answers correctly outside the `/29`, and the `/29` still
   correctly overrides its own more-specific address (both directions
   checked, not just the one that was broken).
2. Full test suite: 87/87.
3. Real end-to-end: rebuilt the real `.mmdb` from this sandbox's actual
   3,168,971-row `ip_intel` (2,846,513 kept entries) and ran the full
   `mmdb publish` pipeline — `golden:193.0.6.139` now matches, file
   published.

## Why the golden-set check caught this and nothing else did

`validate()`'s field-completeness check (`prefix-count`, per-field ratios)
compares aggregate counts against the previous publish — this bug doesn't
change any count (the entry is still in `ip_intel`, still in the file's
data section, still counted as "kept"; only the *tree structure*
routing a specific address to it is broken). Only a real address lookup —
exactly what the golden set does — can catch this class of bug. Worth
keeping in mind if the golden set is ever trimmed for being "redundant"
with the other checks: it isn't.
