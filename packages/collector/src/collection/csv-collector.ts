/**
 * DB-free RIR collection: fetches the same delegated-extended files as
 * collector.ts and writes straight to local CSV files instead of Postgres.
 *
 * This module — and everything it imports — deliberately never touches
 * `@workspace/db`. That's not a style preference: importing that package at
 * all throws immediately if `DATABASE_URL` isn't set, so this file has to
 * stay outside that import graph for "just give me the data, no database"
 * to actually mean no database. It reuses `parseRirLine` from collector.ts
 * (the exact same parsing rule the DB path uses, so the two can't silently
 * drift apart on what counts as a valid record) but does none of the job
 * tracking, batching-for-INSERT, or conflict resolution that path does —
 * running this twice just re-fetches and re-writes the file, no dedup.
 */
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "@workspace/shared";
import { KNOWN_SOURCES, type KnownSourceConfig } from "./sources";
import { parseRirLine } from "./rir-line-parser";
import { loadCollectorConfig } from "../config";

export interface CsvCollectResult {
  rir: string;
  filePath: string;
  ipRows: number;
  asnRows: number;
  skipped: number;
  bytesDownloaded: number;
  error: string | null;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function collectOneToCsv(
  source: KnownSourceConfig,
  outDir: string,
  allowedStatuses: string[] | null,
  fetchRetry: { maxAttempts: number; baseDelayMs: number; timeoutMs: number },
  onProgress?: (rowsWritten: number) => void,
): Promise<CsvCollectResult> {
  const ipFilePath = path.join(outDir, `${source.rir}-ip-blocks.csv`);
  const asnFilePath = path.join(outDir, `${source.rir}-asn-blocks.csv`);
  const ipStream = createWriteStream(ipFilePath);
  const asnStream = createWriteStream(asnFilePath);
  ipStream.write("network,country,rir,status,registered_date\n");
  asnStream.write("asn_start,asn_end,country,rir,status,registered_date\n");

  let ipRows = 0;
  let asnRows = 0;
  let skipped = 0;
  let bytesDownloaded = 0;

  try {
    const response = await fetchWithRetry(
      source.url,
      {
        headers: {
          "User-Agent": "ip-insight-engine/1.0 (self-hosted; contact via project operator)",
          Accept: "text/plain",
        },
      },
      {
        label: `csv-collector:${source.rir}`,
        attempts: fetchRetry.maxAttempts,
        baseDelayMs: fetchRetry.baseDelayMs,
        timeoutMs: fetchRetry.timeoutMs,
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesDownloaded += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = parseRirLine(line, source.rir);
        if (!parsed) continue;
        if (parsed.skipped) {
          skipped++;
          continue;
        }
        // Same "excluded by config isn't a parse failure" rule as the
        // Postgres path — just not counted, not written, not skipped.
        const keep = (status: string | null) =>
          !allowedStatuses || (status !== null && allowedStatuses.includes(status));
        for (const row of parsed.ipRows) {
          if (!keep(row.status)) continue;
          ipStream.write(
            [
              csvEscape(row.network),
              csvEscape(row.country),
              csvEscape(row.rir),
              csvEscape(row.status),
              csvEscape(row.registeredDate),
            ].join(",") + "\n",
          );
          ipRows++;
        }
        for (const row of parsed.asnRows) {
          if (!keep(row.status)) continue;
          asnStream.write(
            [
              row.asnStart,
              row.asnEnd,
              csvEscape(row.country),
              csvEscape(row.rir),
              csvEscape(row.status),
              csvEscape(row.registeredDate),
            ].join(",") + "\n",
          );
          asnRows++;
        }
        onProgress?.(ipRows + asnRows);
      }
    }

    return {
      rir: source.rir,
      filePath: ipFilePath,
      ipRows,
      asnRows,
      skipped,
      bytesDownloaded,
      error: null,
    };
  } catch (err) {
    return {
      rir: source.rir,
      filePath: ipFilePath,
      ipRows,
      asnRows,
      skipped,
      bytesDownloaded,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    ipStream.end();
    asnStream.end();
  }
}

/**
 * Runs the given RIRs (or all of them) sequentially, writing two CSV files
 * per RIR (`<rir>-ip-blocks.csv`, `<rir>-asn-blocks.csv`) into `outDir`.
 * Sequential, not parallel like the DB path — there's no job-state table to
 * coordinate progress across concurrent fetches here, and RIR files are
 * tens of MB each, so running them one at a time keeps memory bounded and
 * progress output legible.
 */
export async function collectRirToCsv(
  rirs: string[] | undefined,
  outDir: string,
  onSourceProgress?: (rir: string, rowsWritten: number) => void,
): Promise<CsvCollectResult[]> {
  // Same precedence as the Postgres path: explicit `rirs` always wins,
  // otherwise fall back to ip-insight.config.json's "collection" list.
  const config = loadCollectorConfig();
  const effectiveRirs = rirs && rirs.length > 0 ? rirs : config.collection;
  const sourcesToRun =
    effectiveRirs && effectiveRirs.length > 0
      ? KNOWN_SOURCES.filter((s) => effectiveRirs.includes(s.rir))
      : KNOWN_SOURCES;
  if (sourcesToRun.length === 0) {
    throw new Error("No matching sources to run");
  }

  const results: CsvCollectResult[] = [];
  for (const source of sourcesToRun) {
    const result = await collectOneToCsv(
      source,
      outDir,
      config.collectionStatuses,
      config.fetchRetry,
      (n) => onSourceProgress?.(source.rir, n),
    );
    results.push(result);
  }
  return results;
}
