# SEO & attribution-link discipline (ipreadout-service public pages)

Written 2026-08-24, alongside the first static-page theme decision (Blue +
Mürdüm, `source.html`). This is not a general SEO tutorial — it is the
specific, checkable set of rules this project follows on its own public
pages, in the same spirit as `SOURCES.md`: real requirements, not
cargo-culted advice, revisited when something changes rather than trusted
forever.

## Why this exists

Two things are true about `source.html` and the pages that will follow it
(pricing, docs, status):

1. Some of the upstream data sources listed on `source.html` **require**
   attribution as a condition of their license (CAIDA, GeoNames, DB-IP
   Lite — see `SOURCES.md`). Getting the link wrong (missing, hidden,
   `nofollow`ed, or pointing at the wrong page) is a license-compliance
   problem, not a cosmetic one.
2. These pages are the first thing a prospective customer or a search
   engine sees. Getting basic technical SEO wrong here costs organic
   discovery for the life of the product, and is far cheaper to get right
   once than to retrofit after the first few pages exist.

## Attribution links — the actual requirement, not a guess

Pulled directly from `SOURCES.md`'s own license entries, not re-derived:

| Source | Requirement | Link target |
|---|---|---|
| **RouteViews RIB snapshots — the default BGP source since 2026-11-08** | **Three parts, all required** (RouteViews' own Commercial Terms of Use, read first-hand 2026-11-08): (1) the attribution statement below, which includes a link to `www.routeviews.org`, (2) the RouteViews logo "on the product, website, published customer reports, etc.", (3) RouteViews' boilerplate paragraph, quoted in full below. Revocable "if you do not provide the attribution called for above, or if you abuse this permission in any way." | `www.routeviews.org` + `creativecommons.org/licenses/by/4.0/` + logo from `routeviews.org/routeviews/logos/` |
| RIPE RIS whois dumps | **Only applies while `bgpOriginSource: "ripe-ris"` is selected — not the default since 2026-11-08.** The strictest one — three parts, all required, not just a link**: (1) the RIPE NCC logo displayed, (2) a link to `ripe.net/ris`, (3) RIPE's own specific boilerplate paragraph describing RIS, quoted in full below. Permission is revocable if any of the three lapses. Already tracked as a launch blocker in `ipreadout-service/PLAN.md`. | `ripe.net/analyse/internet-measurements/routing-information-service-ris/commercial-use/` + `ripe.net/ris` + logo asset (not yet sourced — see below) |
| CAIDA AS-organizations | Attribution text required, citation | `caida.org/catalog/datasets/as-organizations/` |
| GeoNames | CC BY 4.0 — attribution required | `geonames.org` |
| DB-IP Lite | CC BY 4.0 — attribution **and a link back** wherever results are shown | `db-ip.com` |
| RIR delegated-extended files, Tor exit list, cloud/CDN ranges, verified-bot ranges, RPKI ROAs, Feodo Tracker, Mullvad relays | No attribution requirement stated | — no link needed |

**RouteViews — required text, copied verbatim from
`routeviews.org/routeviews/licenses/` on 2026-11-08, not paraphrased.**

The attribution statement (with "[Product/Report]" filled in by us — the
page leaves that slot for the user):

> "This [Product/Report] utilizes data provided by RouteViews
> (www.routeviews.org). Use of this data is subject to the CC BY 4.0
> license."

The boilerplate description:

> "With contributions from network operators and volunteers all over the
> world, RouteViews collects BGP data by direct peering at Internet Exchange
> Points (IXPs) or multi-hop peering. Data are archived and made publicly
> available for download at archive.routeviews.org, lg.routeviews.org, and
> api.routeviews.org."

**The RouteViews logo — self-serve, with one wording conflict to settle.**
The logos page (`routeviews.org/routeviews/logos/`) offers two files, each
as PNG and SVG: the plain logo and a "powered by" variant
(`assets.routeviews.org/logos/...`). Its only sentence reads: "Choose one
of these two options to use the RouteViews official logo (permission is
given for non-commercial use)". The Commercial Terms page, meanwhile,
*requires* the logo for commercial products and links to that same page.
The reasonable reading is that the commercial terms grant logo use for the
purpose they themselves require — but that is a reading, not a written
statement. Unlike RIPE, nothing here asks us to request permission first,
and the commercial terms point to the logo page directly. Still worth one
short confirmation message to RouteViews (via the Contact link on their
site) before launch, so the answer is in writing. Tracked as `docs/106`
B6.

Also noted, smaller: the RouteViews homepage's "CC BY 4.0" text links to
`creativecommons.org/licenses/by-sa/4.0/` (ShareAlike), while the same
page's footer badge, and the licenses page itself, link to
`/licenses/by/4.0/`. Every piece of text says "Attribution 4.0"; the one
`by-sa` href looks like a link mistake. If it were ShareAlike, derived
databases would have to be shared under the same license — a material
difference, which is why it is written down here rather than ignored.

**RIPE RIS — kept for the `ripe-ris` option.** The required paragraph,
verified verbatim against RIPE's own commercial-use page (2026-08-24), not
paraphrased:

> "The RIPE Routing Information Service (RIS) is a RIPE NCC service. With
> the help of network operators all over the world, RIS employs a globally
> distributed set of Remote Route Collectors (RRCs), typically located at
> Internet Exchange Points, to collect and store Internet routing data.
> Volunteers peer with the RRCs using the BGP protocol and RIS stores the
> update and withdraw messages. RIS data can be accessed via: RIPEstat, the
> "one-stop shop" for all available information about Internet number
> resources — RIPEstat uses individual widgets to display routing and other
> information; RIS Live, a real time BGP streaming API allowing server-side
> filtering of BGP messages by prefix or autonomous system; RIS Raw Data,
> available for each route collector, with state dumps and batches of
> updates made available periodically; RISwhois, that searches the latest
> RIS data for details of an IP address using a plaintext "whois"-style
> interface. It is useful when querying RIS data using scripts."

Required in full, not summarized or trimmed — `source.html`'s current draft
carries this exact text in its Attribution section.

**The RIPE logo needs a separate approval — checked, not assumed, and now
in progress.** Checked RIPE's own logo page
(`ripe.net/about-us/press-centre/ripe-ncc-logos/`) directly rather than
assuming the commercial-use grant covers it: RIPE offers two logos (the
main RIPE NCC logo, and a separate "member" logo), and the main logo's own
page states outright that a non-member wanting to use it "on your website
or in any other marketing activity" must email `comms@ripe.net` first — the
RIS commercial-use permission does **not** automatically clear the logo
itself.

**Status: never answered — and no longer blocking.** RouteViews became the
default BGP source on 2026-11-08 (`docs/106` Phase 1 log), so the product
no longer depends on RIS and the RIPE logo question only matters if
`bgpOriginSource` is switched back to `"ripe-ris"`. History: Fırat emailed
`comms@ripe.net` on 2026-08-25 — product name (IP Readout Service,
pre-launch), the RIS attribution already in place (boilerplate paragraph +
link), and the two open questions (permitted for this use? which file
format?), offering a mockup screenshot if useful. Until RIPE replies,
`source.html`'s draft keeps a labeled placeholder box ("RIPE NCC logo
(pending)") in the exact spot the real asset goes — never a redrawn or
approximated version of a trademarked logo. Update this section (and swap
the placeholder for the real asset) the moment a reply lands, whichever way
it goes — a "yes" with a file, a "yes" with conditions, or a "no" that
sends this back to text-only attribution.

Rules that follow from this, checked on every page that surfaces data from
these sources (not just `source.html`):

- **Don't invent attribution where none is required.** Padding the footer
  with credits nobody asked for is clutter, not diligence — it also
  dilutes the ones that actually matter. Only RouteViews / CAIDA /
  GeoNames / DB-IP Lite get a credit line right now (RIPE RIS only if it
  is the selected BGP source again).
- **`rel="noopener noreferrer"`, never `nofollow`, on these four.**
  `noopener noreferrer` is a security/privacy default for any
  `target="_blank"` link, required or not. `nofollow` is for untrusted or
  paid links; slapping it on a genuine, license-required credit both
  misrepresents the relationship to search engines and, for DB-IP Lite
  specifically, arguably fails the "link back" requirement's intent (a
  `nofollow` link still resolves for a human but signals "don't count
  this" to a crawler — don't rely on that ambiguity holding up under
  scrutiny).
- **Visible, not buried.** CC BY licenses generally require attribution
  "in any reasonable manner", but a link only readable by a screen reader
  while zero-height/zero-opacity in CSS, or one requiring a click-through
  to a separate legal page nobody visits, is the kind of thing that reads
  as evasive if anyone checks. A plain footer section, visible without
  interaction, is enough and is what `source.html`'s current draft does.
- **Point at the source's own page, not a generic homepage redirect** —
  `caida.org/catalog/datasets/as-organizations/`, not just `caida.org`.
  Specific enough that a human clicking it lands on the actual thing being
  credited.
- **Re-check when a new enrichment source is added.** `SOURCES.md` already
  tracks each source's license terms; adding a source there without also
  checking whether it needs a line here is exactly the kind of gap this
  file exists to prevent. RIPE NCC's `asn.txt` in particular stays off
  every public page (source list *and* attribution footer) until its
  commercial-use licensing question is actually resolved — see
  `SOURCES.md`'s RIPE entry.
- **`source.html` lists every ingested source, not a curated sample —
  and separates what's computed from what's sourced.** The current draft
  covers all seven layers plus supporting signals from `SOURCES.md`, and
  ends with a distinct "Computed by IPReadout" section (ASN reach, ASN
  profile, neighborhood stats, allocation freshness, risk score, usage/
  connection type, the country-estimate fallback) with no license badge,
  because there's no upstream to badge. This is a transparency decision,
  not just a completeness one: a caller reading the page should never
  have to guess whether a field is a sourced fact or a local inference —
  the page says so directly, the same contract every API response already
  follows (`geo_source`, `confidence`, `geo:city-approximate`, etc.).
  Keep both halves of that list in sync with `SOURCES.md` as sources are
  added, removed, or reclassified — a source that quietly drops off this
  page while still being ingested is a worse failure than one that was
  never added.

## Logo & image handling

- **The logo is inline SVG, not a raster upload.** Drawn directly in the
  page markup (see `source.html`'s current draft: three nodes + two
  connecting lines, stroke/fill from the two brand color tokens). This
  is a deliberate choice, not just a stylistic one:
  - Crisp at any pixel density with zero extra assets — no `@2x`/`@3x`
    variants to generate, ship, or keep in sync.
  - No separate HTTP request, so it can never be the thing that delays
    or shifts the page's first paint.
  - Recolors with the same two brand tokens as the rest of the page
    (`primary`/`secondary`) instead of needing a re-export whenever the
    palette is tuned — which is exactly what's still happening this
    week.
- **When a raster asset is genuinely unavoidable** (a favicon `.ico`, an
  Open Graph / social-preview image, an app-icon set for a future mobile
  wrapper — none of which SVG can serve everywhere yet): export at the
  actual sizes the target surface asks for, name the file for what it is
  (`favicon-32.png`, `og-image-1200x630.png`), never `logo-final-v2.png`
  or similar. Always set explicit `width`/`height` on the `<img>` tag —
  this is what stops the browser reserving zero space and then shifting
  the whole page down once the image loads, which is a real, measured
  Core Web Vitals signal (Cumulative Layout Shift), not a style nitpick.
- **`alt` text describes the thing, not the file.** `alt="IPReadout — IP
  intelligence API"` on the wordmark/logo, never `alt="logo"` or an empty
  string on anything that isn't purely decorative. The inline SVG logo
  mark itself carries `role="img"` + `aria-label` for the same reason,
  since an inline `<svg>` has no native `alt` attribute.
- **Every future content image on these pages gets real `alt` text before
  it ships**, not after. This is the single most-skipped SEO/accessibility
  item in practice — worth a deliberate check per page, not an assumption
  that it'll get done.

## General checklist for every new public page

Not exhaustive SEO theory — the specific, checkable items that actually
apply to a small set of static/marketing pages for an API product:

- **One `<h1>` per page**, matching what the page is actually about (not
  the brand name repeated on every page — `source.html`'s is "Data
  sources & licensing", not "IPReadout").
- **Unique `<title>` and `<meta name="description">` per page.** A
  pricing page and a docs page sharing the homepage's title/description
  is the most common real-world SEO mistake on small sites, and costs
  nothing to avoid from the start.
- **A `<link rel="canonical">`** once any page can be reached by more than
  one URL (trailing slash, query params, `www` vs. apex) — decide the
  canonical form before the second URL variant exists, not after a search
  engine has indexed both.
- **`robots.txt` and `sitemap.xml`** once there is a real deployed set of
  pages to point at — not needed for a design mockup, needed before the
  first page goes live.
- **External links default to `rel="noopener"`** even outside the
  attribution cases above — any `target="_blank"` link to a domain this
  project doesn't control gets it, as a security default independent of
  SEO.
- **`source.html` is a real structured-data candidate** (schema.org
  `Dataset` or `WebPage` JSON-LD, one block per listed source) —
  flagged here as a deliberate future item, not implemented yet: no
  value in adding structured data to a page that doesn't have a stable,
  deployed URL for a search engine to associate it with. Revisit once
  `ipreadout-service` actually ships pages.
- **Fonts load via `<link rel="stylesheet">` to Google Fonts**, the
  pattern already used in the current theme draft — add `rel="preconnect"`
  to `fonts.gstatic.com` once this becomes a real deployed page (cuts the
  font-loading round trip; not meaningful inside a design-canvas preview,
  real on a production page).

## What this file deliberately does not cover

Analytics, paid-search, backlink strategy, keyword research — none of
that is a "discipline" question, it's a marketing/growth decision the
founder makes deliberately when the time comes. This file only covers the
technical-correctness items that are cheap to get right now and expensive
to fix retroactively across many pages later.
