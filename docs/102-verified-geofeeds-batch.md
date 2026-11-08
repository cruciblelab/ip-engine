# 102 — 178 more real geofeeds, found by scanning RIPE once

Built 2026-08-24, same day as `docs/101`. That document measured DB-IP
Lite's inferred-city accuracy and found it structurally limited below /24
resolution — no amount of tuning fixes that, because the information isn't
in the data. The operator's own question was the right one in response:
*"could we get more of this from real sources, the way cloud/hosting already
does?"*

## What was found

This project already carried 16 hand-picked operator geofeeds. A check
against real Türk Telekom/Superonline/Vodafone Türkiye prefixes (RIPE's own
`geofeed:` attribute, checked directly, not guessed) found none of the three
publish one — which reframed the question: is 16 close to everything that
exists, or a small sample of a much bigger set?

Measured by downloading RIPE's public split database dumps
(`ripe.db.inetnum.gz` + `ripe.db.inet6num.gz`, ~260MB compressed,
`https://ftp.ripe.net/ripe/dbase/split/`) and scanning every object for a
`geofeed:` attribute — a first-class WHOIS field since December 2021,
RFC 9632's standard discovery mechanism, not a free-text convention.

**4,171 unique geofeed URLs** came back, covering 1.7% of all IPv4 address
space in the RIPE region alone — of which this project's existing 16 sources
accounted for only 4.2%. The other 95.8% had never been looked for.

## What was verified before adding anything

The 200 largest (by covered address space) were checked one at a time, for
real:

1. **Not an IP-leasing marketplace.** Patterns like `ipv4center.com` and
   `ipbnb.com` appeared dozens of times under different `clients/N` paths —
   individual sub-lessees self-declaring location with no verification,
   structurally different from an operator describing infrastructure it
   owns. Filtered by domain pattern before fetching anything.
2. **Actually reachable, with a real certificate.** Every URL fetched with
   this session's own CA bundle (`/root/.ccr/ca-bundle.crt`) — never with
   verification disabled. **Deutsche Telekom's own feed — the single
   largest found, 28.9M addresses — failed here** and was excluded: its
   server presents a self-signed certificate, confirmed real (not a sandbox
   proxy artifact — the same bundle fetches other hosts fine, and the
   failure is a TLS handshake completing with a bad cert, not a connection
   rejection). There is no honest way to consume geolocation data over a
   connection whose identity cannot be verified, regardless of whose data
   it is.
3. **Actually valid RFC 8805 CSV**, checked by fetching and parsing, not by
   assuming from the URL. Two "failures" from a first crude check
   (`velia.net`, an Azure blob URL) turned out to be false negatives on
   retry with the fixed CA bundle — real content, my check was wrong.
4. **A second look at content**, not just shape: sampled Hetzner's,
   IPXO's, and `as8220.net`'s actual rows for plausibility before trusting
   any of them.

**178 of 200 passed all of it.** The 22 that didn't: 4 real TLS failures
(expired/self-signed/hostname-mismatched certificates — genuine problems on
those operators' own servers), 2 dead URLs (404), the rest connection resets
or timeouts (most likely these operators' own networks blocking a
cloud/datacenter IP range, which is what this sandbox's egress looks like to
them).

**One more excluded by decision, not failure: IPXO** (5.05M addresses, the
second-largest found). Its feed describes IP addresses *leased* through
IPXO's marketplace, not an operator's own infrastructure — a structurally
weaker location claim than every other entry, all of which are operators
describing networks they run.

Final set: **178 geofeeds, 31.5M addresses, 0.73% of global IPv4** — on top
of the existing 16, at the *same* trust standing (RFC 8805, self-published,
consumed via the same `rfc8805-geofeed-csv` parser and
`RFC8805_SELF_PUBLISHED` license this project already used for all 16).

Verified end to end, not just planned: `geofeed-hetzner-com` run for real
against the live 87MB file — 169,644 rows ingested — and looked up through
the real API. `2.28.0.5` → *Falkenstein, DE-SN, DE*, `geo_source: geofeed`,
`confidence.geo: 0.85`, no `geo:city-approximate` flag. Matches Hetzner's own
published row for that prefix exactly.

## A real compliance question, checked before writing any code

The obvious next step — "keep scanning RIPE automatically, stay current
forever" — was checked against RIPE's own Database Terms and Conditions
first, not built first and questioned later.

Article 3 lists geolocation as a legitimate database purpose. Article 4.5
prohibits downloading/compiling more than an "insubstantial part" of the
database without RIPE NCC's explicit permission. The one-time research pass
behind this document (269MB downloaded, 69,288 geofeed-bearing records
extracted from 4.1M total) is arguably already at the edge of that — no
RIPE NCC statement was found resolving the tension for this specific
bulk-scan use case, despite them being the ones who added the `geofeed:`
attribute specifically to enable third-party discovery.

**Conclusion: consuming the 178 individual URLs is clean (RFC 8805 exists so
operators publish these for exactly this consumption). Re-scanning RIPE's
database automatically and repeatedly, inside shipped code, is not clearly
permitted and was not built.**

`verified-geofeeds-data.ts` is therefore a **static, hand-refreshed
snapshot** — the result of one research pass, not a live discovery feature.
Getting a bigger or more current list means repeating the research
deliberately (or, better, writing to RIPE NCC for explicit permission first,
since Article 4.5 names that as the resolving path), not running a cron job.

## What is not covered

None of this closes the gap that started the conversation: no major
Turkish consumer ISP is in the 4,171 found (the RIPE-wide scan, not just the
first check), and none of the 178 added are large enough to matter for that
specific problem. `docs/101`'s conclusion stands — for household-level
consumer broadband, an inferred estimate is what exists, honestly labelled
as one.

Also unaddressed: the other four RIRs (ARIN, APNIC, LACNIC, AFRINIC) were not
scanned — each has its own bulk-access terms, not yet checked. RIPE alone
already produced more than this batch used; a full multi-RIR pass is a
separate, larger effort with its own compliance research per registry.

## Removing this

Delete `verified-geofeeds-data.ts`, then remove its import and the
`...VERIFIED_GEOFEEDS_DATA.map(...)` spread from `KNOWN_ENRICHMENT_SOURCES`
in `enrichment-sources.ts`. No config flag gates this batch — see the data
file's own header for why: a static list of geofeed sources has none of the
cost/risk tradeoffs `dbipLiteIpv6`/`bulkCopyIngest` have, and the existing
`--sources`/`"enrichment"` config selection every other source already uses
can exclude any subset without new code. Nothing else references it.
