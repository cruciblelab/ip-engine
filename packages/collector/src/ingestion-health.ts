/**
 * Post-ingestion sanity check.
 *
 * Every source this project pulls from (RIR files, RIPE RIS, cloud
 * provider ranges, Spamhaus) is re-fetched wholesale on every run — there's
 * no per-row diffing against what was there before. That's fine when the
 * upstream is healthy, but it means a source that came back empty (or
 * nearly empty) because of a transient outage looks, in the job history,
 * identical to "nothing changed upstream". The retry-with-backoff in
 * lib/retry.ts handles the common case (a blip resolves itself within a
 * few attempts), but if every retry fails, the job still completes
 * "successfully" with a source at zero rows — silently.
 *
 * This compares the most recent completed run's row count per source
 * against a conservative expected minimum (well below anything actually
 * observed — see the comment on each threshold) and flags anything that
 * looks like a real gap rather than a genuine upstream event, so an
 * operator re-running collection/enrichment (e.g. as part of the IPv6
 * backfill) finds out immediately instead of discovering it later as a
 * "why doesn't this ASN resolve" bug report.
 */
import { loadCollectorConfig } from "./config";
import { BGP_ORIGIN_SOURCE_IDS } from "./enrichment/enrichment-sources";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  collectionSourcesTable,
  enrichmentSourcesTable,
} from "@workspace/db";

export interface HealthCheckResult {
  ok: boolean;
  checks: Array<{
    source: string;
    kind: "collection" | "enrichment";
    recordsIngested: number | null;
    expectedMinimum: number;
    status: "ok" | "low" | "never_run";
  }>;
}

/**
 * Thresholds are set well under half of what a real run actually produces
 * as of this writing (see the numbers this project observed while testing
 * the IPv6 migration: e.g. ris-whois-ipv4 ingested ~1.2M rows, ris-whois-ipv6
 * ~295K, ripencc ~260K). The point isn't to detect normal week-to-week
 * growth/shrinkage — it's to catch "came back at 0 (or near it) because the
 * upstream was unreachable," which looks nothing like normal variance.
 */
const COLLECTION_MINIMUMS: Record<string, number> = {
  arin: 40_000,
  ripencc: 100_000,
  apnic: 60_000,
  lacnic: 30_000,
  afrinic: 8_000,
};

const ENRICHMENT_MINIMUMS: Record<string, number> = {
  "ripe-asn-names": 50_000,
  "ris-whois-ipv4": 400_000,
  "ris-whois-ipv6": 80_000,
  // Real run 2026-11-08: 1,170,234 (v4) / 272,998 (v6). Only the project
  // `bgpOriginSource` selects is checked — see checkIngestionHealth.
  "routeviews-rib-ipv4": 400_000,
  "routeviews-rib-ipv6": 80_000,
  "digitalocean-geofeed": 300,
  // Real run: ~5,400 rows (Linode's geofeed is much larger than
  // DigitalOcean's — more regions, more granular sub-prefixes per region).
  "linode-geofeed": 1_000,
  "aws-ip-ranges": 1_000,
  "gcp-ip-ranges": 300,
  "cloudflare-v4": 5,
  "cloudflare-v6": 5,
  // Direct-URL RFC 8805 geofeeds — small, individually-run operator feeds,
  // so thresholds stay low; the point is only catching "came back at 0".
  "google-geofeed": 200,
  "ntt-geofeed": 500,
  "cogent-geofeed": 500,
  "verizon-geofeed": 500,
  "tmobile-geofeed": 10,
  "netflix-geofeed": 50,
  "vultr-geofeed": 50,
  "civo-geofeed": 5,
  "schwarzit-geofeed": 5,
  "telia-geofeed": 20,
  // Small, deliberately-scoped operator feeds (Anthropic's combined list was
  // ~20 rows, Common Crawl's ~6, when checked this session) — the point is
  // only catching "came back at 0", same as the other individually-run feeds
  // above.
  "anthropic-crawlers": 5,
  "ccbot": 3,
  // Derived from bgp_origin_ranges, so this can only come back low if the
  // BGP sources themselves failed — a real run yields ~85K originating ASNs.
  "asn-reach": 30_000,
  // Feodo Tracker's blocklist is small by design (currently/recently active
  // C2 servers only, not a historical archive — see enrichment-sources.ts).
  // A real run saw 5; the point of this floor is only catching "came back
  // at 0 because the upstream was unreachable", not normal day-to-day
  // fluctuation in how many C2s are currently tracked.
  "feodotracker": 1,
};

async function latestCollectionCount(rir: string): Promise<number | null> {
  const [row] = await db
    .select({ recordsIngested: collectionSourcesTable.recordsIngested })
    .from(collectionSourcesTable)
    .where(
      and(
        eq(collectionSourcesTable.rir, rir),
        eq(collectionSourcesTable.status, "completed"),
      ),
    )
    .orderBy(desc(collectionSourcesTable.id))
    .limit(1);
  return row?.recordsIngested ?? null;
}

async function latestEnrichmentCount(sourceId: string): Promise<number | null> {
  const [row] = await db
    .select({ recordsIngested: enrichmentSourcesTable.recordsIngested })
    .from(enrichmentSourcesTable)
    .where(
      and(
        eq(enrichmentSourcesTable.sourceId, sourceId),
        eq(enrichmentSourcesTable.status, "completed"),
      ),
    )
    .orderBy(desc(enrichmentSourcesTable.id))
    .limit(1);
  return row?.recordsIngested ?? null;
}

export async function checkIngestionHealth(): Promise<HealthCheckResult> {
  const checks: HealthCheckResult["checks"] = [];

  for (const [rir, minimum] of Object.entries(COLLECTION_MINIMUMS)) {
    const count = await latestCollectionCount(rir);
    checks.push({
      source: rir,
      kind: "collection",
      recordsIngested: count,
      expectedMinimum: minimum,
      status: count === null ? "never_run" : count < minimum ? "low" : "ok",
    });
  }

  // The deselected BGP project's sources are not checked at all: they no
  // longer run, so their last count (or "never_run") says nothing about
  // the data being served, and a stale "ok" there would read as coverage.
  const selectedBgp = BGP_ORIGIN_SOURCE_IDS[loadCollectorConfig().bgpOriginSource];
  const deselectedBgp = new Set(
    Object.values(BGP_ORIGIN_SOURCE_IDS).flat().filter((id) => !selectedBgp.includes(id)),
  );
  for (const [sourceId, minimum] of Object.entries(ENRICHMENT_MINIMUMS)) {
    if (deselectedBgp.has(sourceId)) continue;
    const count = await latestEnrichmentCount(sourceId);
    checks.push({
      source: sourceId,
      kind: "enrichment",
      recordsIngested: count,
      expectedMinimum: minimum,
      status: count === null ? "never_run" : count < minimum ? "low" : "ok",
    });
  }

  const ok = checks.every((c) => c.status !== "low");
  return { ok, checks };
}
