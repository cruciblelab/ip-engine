/**
 * /metrics endpoint — Prometheus-compatible plain-text exposition.
 *
 * Exposes the most useful counters/gauges for production monitoring:
 *   - process uptime / memory
 *   - lookup cache hit ratio
 *   - DB row counts per table
 *   - active job state
 */

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import {
  db,
  ipBlocksTable,
  asnBlocksTable,
  cloudRangesTable,
  threatRangesTable,
} from "@workspace/db";
import { lookupCache } from "@workspace/lookup";
import { getActiveJobSnapshot, isJobActive } from "@workspace/collector";

const router: Router = Router();

router.get("/metrics", async (_req: Request, res: Response) => {
  const cacheStats = lookupCache.stats();
  const job = getActiveJobSnapshot();

  // Cheap COUNT(*) on indexed tables — postgres uses an index-only scan.
  const [ipRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(ipBlocksTable);
  const [asnRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(asnBlocksTable);
  const [cloudRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(cloudRangesTable);
  const [threatRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(threatRangesTable);

  const mem = process.memoryUsage();
  const lines: string[] = [];

  const m = (
    name: string,
    help: string,
    type: "counter" | "gauge",
    value: number,
    labels?: string,
  ) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
  };

  m("process_uptime_seconds", "Process uptime in seconds", "gauge", process.uptime());
  m("process_resident_memory_bytes", "RSS bytes", "gauge", mem.rss);
  m("process_heap_used_bytes", "V8 heap used bytes", "gauge", mem.heapUsed);

  m("lookup_cache_size", "Number of IPs cached", "gauge", cacheStats.size);
  m("lookup_cache_hits_total", "Cache hits", "counter", cacheStats.hits);
  m("lookup_cache_misses_total", "Cache misses", "counter", cacheStats.misses);
  m("lookup_cache_hit_ratio", "Hit ratio over process lifetime", "gauge", cacheStats.hitRatio);

  m("db_ip_blocks_total", "Rows in ip_blocks", "gauge", ipRow?.c ?? 0);
  m("db_asn_blocks_total", "Rows in asn_blocks", "gauge", asnRow?.c ?? 0);
  m("db_cloud_ranges_total", "Rows in cloud_ranges", "gauge", cloudRow?.c ?? 0);
  m("db_threat_ranges_total", "Rows in threat_ranges", "gauge", threatRow?.c ?? 0);

  m("collection_active", "1 if a collection job is currently running", "gauge", isJobActive() ? 1 : 0);
  if (job) {
    m(
      "collection_rate_per_second",
      "Records ingested per second (current job)",
      "gauge",
      job.ratePerSecond,
    );
    for (const s of job.sources) {
      m(
        "collection_source_records_total",
        "Records ingested per source (current job)",
        "counter",
        s.recordsIngested,
        `rir="${s.config.rir}",status="${s.status}"`,
      );
    }
  }

  res.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
});

export default router;
