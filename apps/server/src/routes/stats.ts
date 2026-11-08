import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import {
  db,
  ipBlocksTable,
  asnBlocksTable,
  bgpOriginRangesTable,
  cloudRangesTable,
  geofeedRangesTable,
  threatRangesTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/stats/overview", async (_req, res): Promise<void> => {
  const [ipCounts] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 6)::int`,
      countries: sql<number>`COUNT(DISTINCT ${ipBlocksTable.country})::int`,
      rirs: sql<number>`COUNT(DISTINCT ${ipBlocksTable.rir})::int`,
      ipv4Addrs: sql<number>`COALESCE(SUM(CASE WHEN family(${ipBlocksTable.network}) = 4 THEN POWER(2, 32 - masklen(${ipBlocksTable.network})) ELSE 0 END), 0)::float`,
      lastIngest: sql<Date | null>`MAX(${ipBlocksTable.ingestedAt})`,
    })
    .from(ipBlocksTable);

  const [asnCounts] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(asnBlocksTable);

  res.json({
    totalBlocks: (ipCounts?.total ?? 0) + (asnCounts?.total ?? 0),
    ipv4Blocks: ipCounts?.ipv4 ?? 0,
    ipv6Blocks: ipCounts?.ipv6 ?? 0,
    asnBlocks: asnCounts?.total ?? 0,
    totalCountries: ipCounts?.countries ?? 0,
    totalRirs: ipCounts?.rirs ?? 0,
    totalIpv4Addresses: ipCounts?.ipv4Addrs ?? 0,
    totalIpv6Prefixes: ipCounts?.ipv6 ?? 0,
    lastIngestAt: ipCounts?.lastIngest
      ? new Date(ipCounts.lastIngest).toISOString()
      : null,
  });
});

router.get("/stats/countries", async (_req, res): Promise<void> => {
  const ipRows = await db
    .select({
      country: ipBlocksTable.country,
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 6)::int`,
      ipv4Addrs: sql<number>`COALESCE(SUM(CASE WHEN family(${ipBlocksTable.network}) = 4 THEN POWER(2, 32 - masklen(${ipBlocksTable.network})) ELSE 0 END), 0)::float`,
    })
    .from(ipBlocksTable)
    .where(sql`${ipBlocksTable.country} IS NOT NULL`)
    .groupBy(ipBlocksTable.country);

  const asnRows = await db
    .select({
      country: asnBlocksTable.country,
      asn: sql<number>`COUNT(*)::int`,
    })
    .from(asnBlocksTable)
    .where(sql`${asnBlocksTable.country} IS NOT NULL`)
    .groupBy(asnBlocksTable.country);

  const map = new Map<
    string,
    {
      country: string;
      ipv4Blocks: number;
      ipv6Blocks: number;
      asnBlocks: number;
      ipv4Addresses: number;
    }
  >();
  for (const r of ipRows) {
    if (!r.country) continue;
    map.set(r.country, {
      country: r.country,
      ipv4Blocks: r.ipv4,
      ipv6Blocks: r.ipv6,
      asnBlocks: 0,
      ipv4Addresses: r.ipv4Addrs,
    });
  }
  for (const r of asnRows) {
    if (!r.country) continue;
    const existing = map.get(r.country) ?? {
      country: r.country,
      ipv4Blocks: 0,
      ipv6Blocks: 0,
      asnBlocks: 0,
      ipv4Addresses: 0,
    };
    existing.asnBlocks = r.asn;
    map.set(r.country, existing);
  }
  const result = Array.from(map.values())
    .map((v) => ({ ...v, totalBlocks: v.ipv4Blocks + v.ipv6Blocks + v.asnBlocks }))
    .sort((a, b) => b.totalBlocks - a.totalBlocks)
    .slice(0, 30);
  res.json(result);
});

router.get("/stats/rirs", async (_req, res): Promise<void> => {
  const ipRows = await db
    .select({
      rir: ipBlocksTable.rir,
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 6)::int`,
    })
    .from(ipBlocksTable)
    .groupBy(ipBlocksTable.rir);

  const asnRows = await db
    .select({
      rir: asnBlocksTable.rir,
      asn: sql<number>`COUNT(*)::int`,
    })
    .from(asnBlocksTable)
    .groupBy(asnBlocksTable.rir);

  const map = new Map<
    string,
    { rir: string; ipv4Blocks: number; ipv6Blocks: number; asnBlocks: number }
  >();
  for (const r of ipRows) {
    map.set(r.rir, { rir: r.rir, ipv4Blocks: r.ipv4, ipv6Blocks: r.ipv6, asnBlocks: 0 });
  }
  for (const r of asnRows) {
    const existing = map.get(r.rir) ?? {
      rir: r.rir,
      ipv4Blocks: 0,
      ipv6Blocks: 0,
      asnBlocks: 0,
    };
    existing.asnBlocks = r.asn;
    map.set(r.rir, existing);
  }
  const result = Array.from(map.values())
    .map((v) => ({ ...v, totalBlocks: v.ipv4Blocks + v.ipv6Blocks + v.asnBlocks }))
    .sort((a, b) => b.totalBlocks - a.totalBlocks);
  res.json(result);
});

router.get("/stats/families", async (_req, res): Promise<void> => {
  const [ipCounts] = await db
    .select({
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 6)::int`,
    })
    .from(ipBlocksTable);
  const [asnCounts] = await db
    .select({ asn: sql<number>`COUNT(*)::int` })
    .from(asnBlocksTable);
  res.json({
    ipv4Blocks: ipCounts?.ipv4 ?? 0,
    ipv6Blocks: ipCounts?.ipv6 ?? 0,
    asnBlocks: asnCounts?.asn ?? 0,
  });
});

router.get("/stats/enrichment", async (_req, res): Promise<void> => {
  const [cloudTotal] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(cloudRangesTable);
  const [threatTotal] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(threatRangesTable);
  const [asnTotal] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(asnBlocksTable);
  const [asnNamed] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(asnBlocksTable)
    .where(sql`${asnBlocksTable.name} IS NOT NULL`);
  // Layer 1 coverage: how many announced prefixes this project can resolve
  // from its own local table (there is no live third-party fallback).
  const [bgpOriginTotal] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(bgpOriginRangesTable);
  // Layer 2 coverage: prefixes with an operator-published geofeed city hint.
  const [geofeedTotal] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(geofeedRangesTable);
  const cloudByProvider = await db
    .select({
      provider: cloudRangesTable.provider,
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${cloudRangesTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${cloudRangesTable.network}) = 6)::int`,
    })
    .from(cloudRangesTable)
    .groupBy(cloudRangesTable.provider);
  const threatBySource = await db
    .select({
      source: threatRangesTable.source,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(threatRangesTable)
    .groupBy(threatRangesTable.source);

  res.json({
    totalCloudRanges: cloudTotal?.c ?? 0,
    totalThreatRanges: threatTotal?.c ?? 0,
    asnNamedCount: asnNamed?.c ?? 0,
    asnTotalCount: asnTotal?.c ?? 0,
    totalBgpOriginRanges: bgpOriginTotal?.c ?? 0,
    totalGeofeedRanges: geofeedTotal?.c ?? 0,
    cloudByProvider,
    threatBySource,
  });
});

router.get("/stats/timeline", async (_req, res): Promise<void> => {
  const ipRows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${ipBlocksTable.registeredDate})::int`,
      ipv4: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 4)::int`,
      ipv6: sql<number>`COUNT(*) FILTER (WHERE family(${ipBlocksTable.network}) = 6)::int`,
    })
    .from(ipBlocksTable)
    .where(sql`${ipBlocksTable.registeredDate} IS NOT NULL`)
    .groupBy(sql`EXTRACT(YEAR FROM ${ipBlocksTable.registeredDate})`);
  const asnRows = await db
    .select({
      year: sql<number>`EXTRACT(YEAR FROM ${asnBlocksTable.registeredDate})::int`,
      asn: sql<number>`COUNT(*)::int`,
    })
    .from(asnBlocksTable)
    .where(sql`${asnBlocksTable.registeredDate} IS NOT NULL`)
    .groupBy(sql`EXTRACT(YEAR FROM ${asnBlocksTable.registeredDate})`);

  const map = new Map<number, { year: number; ipv4: number; ipv6: number; asn: number }>();
  for (const r of ipRows) {
    if (!r.year) continue;
    map.set(r.year, { year: r.year, ipv4: r.ipv4, ipv6: r.ipv6, asn: 0 });
  }
  for (const r of asnRows) {
    if (!r.year) continue;
    const existing = map.get(r.year) ?? {
      year: r.year,
      ipv4: 0,
      ipv6: 0,
      asn: 0,
    };
    existing.asn = r.asn;
    map.set(r.year, existing);
  }
  const result = Array.from(map.values()).sort((a, b) => a.year - b.year);
  res.json(result);
});

export default router;
