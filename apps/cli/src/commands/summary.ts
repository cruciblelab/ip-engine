import fs from "node:fs";
import path from "node:path";
import { buildDatabaseSummary, type DatabaseSummary } from "@workspace/collector";
import { logger } from "@workspace/shared";

function fmtAddr(n: string): string {
  // IPv6 totals routinely run into the tens-of-undecillions — not a
  // human-graspable "capacity" figure, just scientific notation so the
  // console output stays readable; the JSON file keeps the exact string.
  const num = Number(n);
  if (!Number.isFinite(num)) return n;
  return num >= 1e15 ? num.toExponential(3) : num.toLocaleString();
}

function printHuman(summary: DatabaseSummary): void {
  console.log(`Generated: ${summary.generatedAt}\n`);
  console.log(
    `IP blocks: ${summary.ipBlocks.totalBlocks.toLocaleString()} total ` +
      `(IPv4: ${fmtAddr(summary.ipBlocks.totalIpv4Addresses)} addresses, ` +
      `IPv6: ${fmtAddr(summary.ipBlocks.totalIpv6Addresses)} addresses)`,
  );
  console.log("  by RIR / family / status:");
  for (const row of summary.ipBlocks.byRirFamilyStatus) {
    console.log(
      `    ${row.rir.padEnd(9)} IPv${row.family}  ${row.status.padEnd(10)} ` +
        `${row.blocks.toLocaleString().padStart(8)} blocks  ${fmtAddr(row.addresses)} addresses`,
    );
  }

  console.log(
    `\nASN blocks: ${summary.asnBlocks.totalRecords.toLocaleString()} records, ` +
      `${summary.asnBlocks.totalAsnsCovered.toLocaleString()} ASNs covered`,
  );
  for (const row of summary.asnBlocks.byRirStatus) {
    console.log(
      `    ${row.rir.padEnd(9)} ${row.status.padEnd(10)} ${row.records.toLocaleString().padStart(8)} records`,
    );
  }

  console.log("\nEnrichment tables:");
  console.log(`    bgp_origin_ranges: ${summary.enrichment.bgpOriginRanges.toLocaleString()}`);
  console.log(`    geofeed_ranges:    ${summary.enrichment.geofeedRanges.toLocaleString()}`);
  console.log(`    cloud_ranges:      ${summary.enrichment.cloudRanges.toLocaleString()}`);
  console.log(`    threat_ranges:     ${summary.enrichment.threatRanges.toLocaleString()}`);
  console.log(`    geonames_places:   ${summary.enrichment.geonamesPlaces.toLocaleString()}`);

  if (summary.lastCollectionRuns.length > 0) {
    console.log("\nLast collection run per RIR:");
    for (const r of summary.lastCollectionRuns) {
      console.log(`    ${r.id.padEnd(9)} ${r.status.padEnd(10)} ${r.recordsIngested.toLocaleString()} ingested — ${r.endedAt}`);
    }
  }
  if (summary.lastEnrichmentRuns.length > 0) {
    console.log("\nLast enrichment run per source:");
    for (const r of summary.lastEnrichmentRuns) {
      console.log(`    ${r.id.padEnd(22)} ${r.status.padEnd(10)} ${r.recordsIngested.toLocaleString()} ingested — ${r.endedAt}`);
    }
  }
}

export async function runSummary(outDir: string): Promise<void> {
  const summary = await buildDatabaseSummary();
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, "db-summary.json");
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2) + "\n");

  // Also lands in the persistent NDJSON log (logs/ip-insight.log), not
  // just this one-off file — so the summary history survives even if the
  // JSON file gets overwritten by the next run.
  logger.info({ summary }, "Database summary generated");

  printHuman(summary);
  console.log(`\nWritten to ${path.resolve(filePath)}`);
}
