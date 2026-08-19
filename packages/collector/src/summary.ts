/**
 * "What's actually in this database" — a point-in-time snapshot, meant to
 * be written to a JSON file (and logged) after a collect/enrich run, or
 * pulled on demand (`ip-insight summary`) to answer "how much do we have,
 * broken down by status/family/RIR" without hand-writing SQL each time.
 *
 * Address counts use Postgres `numeric` (via `power(2::numeric, ...)`) and
 * come back as strings: IPv6 totals routinely exceed what a JS `number`
 * can represent exactly (a single /13 already exceeds 2^100), so this
 * never rounds them through a JS number — the string is the real, exact
 * value, not a display truncation.
 */
import { sql, desc } from "drizzle-orm";
import {
  db,
  ipBlocksTable,
  asnBlocksTable,
  bgpOriginRangesTable,
  geofeedRangesTable,
  cloudRangesTable,
  threatRangesTable,
  geonamesPlacesTable,
  collectionSourcesTable,
  enrichmentSourcesTable,
} from "@workspace/db";

export interface FamilyStatusBreakdown {
  rir: string;
  family: 4 | 6;
  status: string;
  blocks: number;
  /** Exact address count as a decimal string — see file header. */
  addresses: string;
}

export interface AsnBreakdown {
  rir: string;
  status: string;
  records: number;
  asnsCovered: number;
}

export interface SourceLastRun {
  id: string;
  status: string;
  recordsIngested: number;
  recordsSkipped: number;
  endedAt: string | null;
}

export interface DatabaseSummary {
  generatedAt: string;
  ipBlocks: {
    totalBlocks: number;
    totalIpv4Addresses: string;
    totalIpv6Addresses: string;
    byRirFamilyStatus: FamilyStatusBreakdown[];
  };
  asnBlocks: {
    totalRecords: number;
    totalAsnsCovered: number;
    byRirStatus: AsnBreakdown[];
  };
  enrichment: {
    bgpOriginRanges: number;
    geofeedRanges: number;
    cloudRanges: number;
    threatRanges: number;
    geonamesPlaces: number;
  };
  lastCollectionRuns: SourceLastRun[];
  lastEnrichmentRuns: SourceLastRun[];
}

export async function buildDatabaseSummary(): Promise<DatabaseSummary> {
  const byRirFamilyStatus = await db
    .select({
      rir: ipBlocksTable.rir,
      family: sql<number>`family(${ipBlocksTable.network})`,
      status: sql<string>`coalesce(${ipBlocksTable.status}, 'unknown')`,
      blocks: sql<number>`count(*)::int`,
      addresses: sql<string>`sum(power(2::numeric, (case when family(${ipBlocksTable.network}) = 4 then 32 else 128 end) - masklen(${ipBlocksTable.network})))::text`,
    })
    .from(ipBlocksTable)
    .groupBy(
      ipBlocksTable.rir,
      sql`family(${ipBlocksTable.network})`,
      sql`coalesce(${ipBlocksTable.status}, 'unknown')`,
    )
    .orderBy(ipBlocksTable.rir);

  const [totals] = await db
    .select({
      totalBlocks: sql<number>`count(*)::int`,
      totalIpv4: sql<string>`coalesce(sum(power(2::numeric, 32 - masklen(${ipBlocksTable.network}))) filter (where family(${ipBlocksTable.network}) = 4), 0)::text`,
      totalIpv6: sql<string>`coalesce(sum(power(2::numeric, 128 - masklen(${ipBlocksTable.network}))) filter (where family(${ipBlocksTable.network}) = 6), 0)::text`,
    })
    .from(ipBlocksTable);

  const byRirStatusAsn = await db
    .select({
      rir: asnBlocksTable.rir,
      status: sql<string>`coalesce(${asnBlocksTable.status}, 'unknown')`,
      records: sql<number>`count(*)::int`,
      asnsCovered: sql<number>`sum(${asnBlocksTable.asnEnd} - ${asnBlocksTable.asnStart} + 1)::int`,
    })
    .from(asnBlocksTable)
    .groupBy(asnBlocksTable.rir, sql`coalesce(${asnBlocksTable.status}, 'unknown')`)
    .orderBy(asnBlocksTable.rir);

  const [asnTotals] = await db
    .select({
      totalRecords: sql<number>`count(*)::int`,
      totalAsnsCovered: sql<number>`coalesce(sum(${asnBlocksTable.asnEnd} - ${asnBlocksTable.asnStart} + 1), 0)::int`,
    })
    .from(asnBlocksTable);

  const [bgpCount] = await db.select({ n: sql<number>`count(*)::int` }).from(bgpOriginRangesTable);
  const [geofeedCount] = await db.select({ n: sql<number>`count(*)::int` }).from(geofeedRangesTable);
  const [cloudCount] = await db.select({ n: sql<number>`count(*)::int` }).from(cloudRangesTable);
  const [threatCount] = await db.select({ n: sql<number>`count(*)::int` }).from(threatRangesTable);
  const [geonamesCount] = await db.select({ n: sql<number>`count(*)::int` }).from(geonamesPlacesTable);

  // Most recent completed/failed row per RIR / enrichment source id.
  const collectionRows = await db
    .select({
      rir: collectionSourcesTable.rir,
      status: collectionSourcesTable.status,
      recordsIngested: collectionSourcesTable.recordsIngested,
      recordsSkipped: collectionSourcesTable.recordsSkipped,
      endedAt: collectionSourcesTable.endedAt,
    })
    .from(collectionSourcesTable)
    .where(sql`${collectionSourcesTable.endedAt} is not null`)
    .orderBy(desc(collectionSourcesTable.endedAt));
  const lastCollectionRuns = dedupeLatest(
    collectionRows.map((r) => ({
      id: r.rir,
      status: r.status,
      recordsIngested: r.recordsIngested,
      recordsSkipped: r.recordsSkipped,
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    })),
  );

  const enrichmentRows = await db
    .select({
      sourceId: enrichmentSourcesTable.sourceId,
      status: enrichmentSourcesTable.status,
      recordsIngested: enrichmentSourcesTable.recordsIngested,
      recordsSkipped: enrichmentSourcesTable.recordsSkipped,
      endedAt: enrichmentSourcesTable.endedAt,
    })
    .from(enrichmentSourcesTable)
    .where(sql`${enrichmentSourcesTable.endedAt} is not null`)
    .orderBy(desc(enrichmentSourcesTable.endedAt));
  const lastEnrichmentRuns = dedupeLatest(
    enrichmentRows.map((r) => ({
      id: r.sourceId,
      status: r.status,
      recordsIngested: r.recordsIngested,
      recordsSkipped: r.recordsSkipped,
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    })),
  );

  return {
    generatedAt: new Date().toISOString(),
    ipBlocks: {
      totalBlocks: totals?.totalBlocks ?? 0,
      totalIpv4Addresses: totals?.totalIpv4 ?? "0",
      totalIpv6Addresses: totals?.totalIpv6 ?? "0",
      byRirFamilyStatus: byRirFamilyStatus.map((r) => ({
        rir: r.rir,
        family: r.family as 4 | 6,
        status: r.status,
        blocks: r.blocks,
        addresses: r.addresses,
      })),
    },
    asnBlocks: {
      totalRecords: asnTotals?.totalRecords ?? 0,
      totalAsnsCovered: asnTotals?.totalAsnsCovered ?? 0,
      byRirStatus: byRirStatusAsn,
    },
    enrichment: {
      bgpOriginRanges: bgpCount?.n ?? 0,
      geofeedRanges: geofeedCount?.n ?? 0,
      cloudRanges: cloudCount?.n ?? 0,
      threatRanges: threatCount?.n ?? 0,
      geonamesPlaces: geonamesCount?.n ?? 0,
    },
    lastCollectionRuns,
    lastEnrichmentRuns,
  };
}

/** Rows are already ordered newest-first; keep only the first (most recent) per id. */
function dedupeLatest(rows: SourceLastRun[]): SourceLastRun[] {
  const seen = new Set<string>();
  const out: SourceLastRun[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}
