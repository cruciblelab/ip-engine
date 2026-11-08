# 101 — How accurate is the inferred city, actually?

Measured 2026-08-24. Started from a user report, not a hypothesis: the
operator tested their own home and office connections, in Kartal (Istanbul),
and got back Maltepe (the adjacent district) and Esenyurt (~50 km away,
across the Bosphorus on the European side).

That was the open risk left over from `docs/99` — "DB-IP's geo accuracy was
never validated" — arriving as a real complaint rather than a checklist item.

**This document went through a wrong answer before it reached the right one,
and both are kept.** The first version of this measurement shipped a
calibration that was withdrawn hours later. The mistake is more instructive
than the result.

## Method

Ground truth is the **operator's own RFC 8805 geofeed**: the network's owner
stating where their own addresses are. That is the only honest yardstick
here — comparing one guess against another guess proves nothing, and
comparing against a paid database only measures agreement between two
inference engines.

Four operators, chosen so a datacenter/consumer split would be visible if one
existed. For each of their prefixes, DB-IP Lite was asked the same question
`ip_intel`'s own `dbip` LATERAL asks: the narrowest `dbip_lite_ranges` row
covering it. City comparison is case-folded with DB-IP's parenthetical
neighbourhood suffix stripped ("Overland Park (Santa Fe Hills)" is Overland
Park).

Telia's feed was fetched too but failed to parse — malformed rows — and was
dropped rather than half-loaded into a number that would look like data.

## The wrong answer, and why it was wrong

The first pass averaged **per prefix**:

| operator | kind | per-prefix city accuracy |
|---|---|---|
| Charter | consumer ISP | 15.6% |
| T-Mobile | mobile ISP | 57.5% |
| NTT | transit/DC | 66.4% |
| Google Cloud | datacenter | 74.3% |

That looked like a clean 4.5x datacenter-vs-consumer story, and it shipped as
a split confidence score: 0.7 for datacenter space, 0.3 for everything else.

It was an artifact. Averaging per prefix weights a /30 the same as a /16, and
**346,000 of Charter's 416,000 prefixes are /29s and /30s** — individual
customer assignments. So the "consumer" number was overwhelmingly measuring
one question: *which household is this?*

DB-IP's data has roughly **/24 resolution**, and accuracy collapses exactly
where the question crosses that line — cleanly enough that the cliff is
unmistakable:

| operator's own prefix | samples | DB-IP correct |
|---|---|---|
| /19 | 233 | 81.5% |
| /20 | 1,144 | 81.1% |
| /21 | 2,999 | 82.0% |
| /22 | 3,160 | 84.5% |
| /23 | 4,075 | 83.0% |
| /24 | 19,752 | **81.7%** |
| /25 | 3,053 | 56.3% |
| /26 | 1,297 | 35.5% |
| /27 | 1,115 | 21.6% |
| /28 | 3,955 | 11.9% |
| /29 | 99,754 | 9.2% |
| /30 | 246,477 | **8.0%** |

All Charter, one operator, one consistent methodology. The database is not
worse at consumer space; it was being asked a question its data cannot
answer, hundreds of thousands of times, and that dominated the average.

## The corrected result

Weighted by **address** — which is what a random IP lookup actually draws
from — and again restricted to questions at or above DB-IP's own resolution:

| operator | kind | per-prefix | **per-address** | /24-or-wider |
|---|---|---|---|---|
| Charter | consumer ISP | 14.9% | **76.2%** | 82.2% |
| Google Cloud | datacenter | 81.0% | **86.4%** | 82.0% |
| T-Mobile | mobile ISP | 21.9% | **78.1%** | 85.4% |
| NTT | transit/DC | 69.7% | 53.4% | 75.1% |

The datacenter/consumer gap is 86.4% vs 76.2% — real, but a tenth of what
the first pass reported, and it **disappears entirely** at DB-IP's own
resolution (82.0% vs 82.2%).

Country is right 81-98% everywhere. Only the city was ever at issue.

(NTT's per-address figure is dragged down by a single /2 in its feed —
one billion addresses in one row. Left in rather than quietly excluded, since
the /24-or-wider column already shows what it looks like without it.)

## Two other splits were tested and rejected

- **The matched range's own width does not predict accuracy.** Holding the
  operator's prefix size fixed at /24, DB-IP was right 82.3% of the time when
  its matching range was also a /24 and 79.3% when it was wider. Narrower is
  not better. It is reported to callers as `geo_network` because it is a
  factual statement about the claim's extent, and documented there as *not* a
  quality signal.
- **Datacenter detection is unreliable anyway.** 12 of 12 sampled real NTT
  datacenter addresses classified as `residential`/`unknown`, because
  `cloud_ranges` only lists the large public clouds. A split that cannot be
  applied correctly is worse than no split — which also answers "should we
  add more hosting-provider data sources to fix this?": no. More lists would
  apply a distinction the data does not support.

## What shipped

`packages/lookup/src/lookup/geo-confidence.ts` — one consumer, and the
measurement lives in its header so numbers and code cannot drift apart.

| geo_source | confidence.geo | was |
|---|---|---|
| geofeed | 0.8-0.85 | unchanged |
| dbip-lite | **0.6** | 0.5 originally, then briefly 0.7/0.3 |
| country-estimate | 0.2 | unchanged |

0.6 sits **under** the 76-86% measured, not in the middle of it: NTT's 53.4%
is inside the range and the sample is four operators in two countries.
`country-estimate` was left alone — this measurement says nothing about it,
and inventing a number for it would be the same unsupported precision the
whole exercise is against.

**`geo:city-approximate`** is now set for *every* inferred city, not a subset.
None of them is operator-published, and there is no measured basis for
treating one class as trustworthy enough to omit the label. It exists so a
caller who never reads `confidence.geo` still cannot mistake a guess for a
fact.

**`geo.geo_network`** (new) reports the prefix the geo answer actually
describes — the geofeed or DB-IP range that matched, not the address asked
about. "Kartal, for this /30" and "Kartal, for this /12" are very different
statements and only one of them is about your address specifically. Null for
`country-estimate` (the claim is the whole country) and `anycast` (no claim
at all). The CLI prints it under the location line.

## Verified end to end, on real addresses

    8.34.210.5  (Google Cloud)  → Council Bluffs, Iowa    geo 0.6, /24, approximate
    70.93.80.5  (Charter, home) → Imperial, California    geo 0.6, /22, approximate

Both correct against their operators' own geofeeds. Both still scored 0.6 and
labelled approximate — which is the design working. A confidence score is a
statement about the population, not about the answer in front of you; one
that rose whenever the answer happened to be right would require knowing it
was right, which is the entire problem.

## What this means for the product

The defensible claim is not "our city data is accurate". It is **"we tell you
how accurate this particular answer is likely to be, we tell you what it is
an answer *about*, and we measured both"** — which most IP geolocation
vendors do not publish at all.

- **Country: usable.** 81-98% across all four operators.
- **City at /24 granularity or coarser: usable.** ~82%, and consistent across
  datacenter, consumer and mobile space.
- **City for a specific household or small block: not usable.** 8-12%. This
  is the case the original user report hit, and it is not fixable by adding
  data sources — the information is not in any IP database.

## The lesson worth keeping

The first version of this measurement was not sloppy. It used real ground
truth, a real methodology, and a large sample, and it produced a clean,
plausible, memorable story — 74.3% vs 15.6%, datacenter vs consumer — which
then shipped into a public API contract.

It was wrong because of the weighting, and the weighting was invisible until
someone asked a follow-up question ("should we add more data sources?") that
required looking at the distribution rather than the average. A large sample
does not protect against measuring the wrong thing; it just makes the wrong
thing look statistically solid.
