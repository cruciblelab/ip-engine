/**
 * Deliberately imports only the `@workspace/collector/collection/csv-collector`
 * subpath — never the package's main `.` barrel, which re-exports
 * collector.ts/enrichment.ts/etc and therefore `@workspace/db`. Importing
 * that here, even unused, would throw at module load if DATABASE_URL isn't
 * set, breaking the entire point of a database-free CSV collection mode.
 */
import fs from "node:fs";
import path from "node:path";
import { collectRirToCsv } from "@workspace/collector/collection/csv-collector";

export async function runCollectCsv(rirs: string[], outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Writing CSV files to ${path.resolve(outDir)} (no database used)...`);

  const results = await collectRirToCsv(
    rirs.length > 0 ? rirs : undefined,
    outDir,
  );

  let anyError = false;
  for (const r of results) {
    if (r.error) {
      anyError = true;
      console.log(`[${r.rir}] FAILED — ${r.error}`);
      continue;
    }
    console.log(
      `[${r.rir}] ${r.ipRows.toLocaleString()} IP rows, ${r.asnRows.toLocaleString()} ASN rows` +
        (r.skipped > 0 ? `, ${r.skipped.toLocaleString()} skipped` : ""),
    );
  }
  console.log(
    `Done. Files: ${results.map((r) => `${r.rir}-ip-blocks.csv`).join(", ")}` +
      ` (and matching *-asn-blocks.csv) in ${path.resolve(outDir)}`,
  );
  if (anyError) process.exitCode = 1;
}
