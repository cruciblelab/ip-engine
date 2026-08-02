/**
 * Streaming exports of the ingested database.
 *
 * Uses a server-side cursor (LIMIT/OFFSET-by-id pagination) to keep memory
 * bounded at any database size. Takes a plain `{ write(chunk) }` sink so the
 * same logic serves an HTTP response (api-server), a file handle, or stdout
 * (CLI) identically — the database itself is the deliverable, and it should
 * be exportable the same way regardless of which interface asked for it.
 */
import { sql } from "drizzle-orm";
import { isIP } from "node:net";
import { db, ipBlocksTable, asnBlocksTable } from "@workspace/db";

export interface WriteSink {
  write(chunk: string): unknown;
}

const CHUNK_SIZE = 10000;

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** `network` is the whole story now (native `inet`) — family is just a display convenience. */
export function familyOfNetwork(network: string): 4 | 6 {
  const address = network.split("/")[0]!;
  return isIP(address) === 6 ? 6 : 4;
}

export async function streamIpBlocksCsv(sink: WriteSink): Promise<void> {
  sink.write(
    "type,cidr,family,country,rir,status,registered_date,ingested_at,name\n",
  );
  let lastId = 0;
  while (true) {
    const rows = await db
      .select()
      .from(ipBlocksTable)
      .where(sql`${ipBlocksTable.id} > ${lastId}`)
      .orderBy(ipBlocksTable.id)
      .limit(CHUNK_SIZE);
    if (rows.length === 0) break;
    for (const r of rows) {
      sink.write(
        [
          "ip",
          csvEscape(r.network),
          familyOfNetwork(r.network),
          csvEscape(r.country),
          csvEscape(r.rir),
          csvEscape(r.status),
          csvEscape(r.registeredDate),
          r.ingestedAt.toISOString(),
          "",
        ].join(",") + "\n",
      );
    }
    const last = rows[rows.length - 1]!;
    lastId = last.id;
    if (rows.length < CHUNK_SIZE) break;
  }
}

export async function streamAsnBlocksCsv(sink: WriteSink): Promise<void> {
  let lastId = 0;
  while (true) {
    const rows = await db
      .select()
      .from(asnBlocksTable)
      .where(sql`${asnBlocksTable.id} > ${lastId}`)
      .orderBy(asnBlocksTable.id)
      .limit(CHUNK_SIZE);
    if (rows.length === 0) break;
    for (const r of rows) {
      sink.write(
        [
          "asn",
          `AS${r.asnStart}-AS${r.asnEnd}`,
          0,
          r.asnStart,
          r.asnEnd,
          csvEscape(r.country),
          csvEscape(r.rir),
          csvEscape(r.status),
          csvEscape(r.registeredDate),
          r.ingestedAt.toISOString(),
          csvEscape(r.name),
        ].join(",") + "\n",
      );
    }
    const last = rows[rows.length - 1]!;
    lastId = last.id;
    if (rows.length < CHUNK_SIZE) break;
  }
}

export async function streamBlocksNdjson(sink: WriteSink): Promise<void> {
  let lastId = 0;
  while (true) {
    const rows = await db
      .select()
      .from(ipBlocksTable)
      .where(sql`${ipBlocksTable.id} > ${lastId}`)
      .orderBy(ipBlocksTable.id)
      .limit(CHUNK_SIZE);
    if (rows.length === 0) break;
    for (const r of rows) {
      sink.write(
        JSON.stringify({
          type: "ip",
          cidr: r.network,
          family: familyOfNetwork(r.network),
          country: r.country,
          rir: r.rir,
          status: r.status,
          registeredDate: r.registeredDate,
          ingestedAt: r.ingestedAt.toISOString(),
        }) + "\n",
      );
    }
    const last = rows[rows.length - 1]!;
    lastId = last.id;
    if (rows.length < CHUNK_SIZE) break;
  }
  lastId = 0;
  while (true) {
    const rows = await db
      .select()
      .from(asnBlocksTable)
      .where(sql`${asnBlocksTable.id} > ${lastId}`)
      .orderBy(asnBlocksTable.id)
      .limit(CHUNK_SIZE);
    if (rows.length === 0) break;
    for (const r of rows) {
      sink.write(
        JSON.stringify({
          type: "asn",
          asnStart: r.asnStart,
          asnEnd: r.asnEnd,
          country: r.country,
          rir: r.rir,
          status: r.status,
          name: r.name,
          registeredDate: r.registeredDate,
          ingestedAt: r.ingestedAt.toISOString(),
        }) + "\n",
      );
    }
    const last = rows[rows.length - 1]!;
    lastId = last.id;
    if (rows.length < CHUNK_SIZE) break;
  }
}
