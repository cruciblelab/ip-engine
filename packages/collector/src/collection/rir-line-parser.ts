/**
 * Pure parse of one RIR delegated-extended line — no DB, no batching, no job
 * state. Used by both the Postgres ingestion path (collector.ts pushes
 * these rows into a batch for `db.insert`) and the DB-free CSV export path
 * (csv-collector.ts writes these rows straight to a file). Keeping the
 * actual parsing rule in exactly one place, in a file that itself never
 * imports `@workspace/db`, means: (a) the two paths can never silently
 * drift apart on what counts as a valid record, and (b) the CSV path can
 * genuinely run without `DATABASE_URL` set — importing anything that
 * imports `@workspace/db`, even transitively, would throw immediately at
 * module load, defeating the entire point of a DB-free mode.
 */
import { ipv4ToInt, rangeToCidrs } from "@workspace/shared";

export interface ParsedIpRow {
  network: string;
  country: string | null;
  rir: string;
  status: string | null;
  registeredDate: string | null;
}

export interface ParsedAsnRow {
  asnStart: number;
  asnEnd: number;
  country: string | null;
  rir: string;
  status: string | null;
  registeredDate: string | null;
}

export type ParsedRirLine =
  | { skipped: false; ipRows: ParsedIpRow[]; asnRows: ParsedAsnRow[] }
  | { skipped: true }
  | null;

/**
 * Returns `null` for lines to silently ignore (blank, comment, header,
 * summary), `{ skipped: true }` for a line that looked like a real record
 * but failed to parse, or the parsed row(s) otherwise.
 *
 * `rir` is the *configured* registry (which file this line came from — e.g.
 * "arin"), not the line's own `registry` field. A delegated-extended file
 * can contain transferred/other-registry records whose own registry field
 * differs from the file's namesake; rows are tagged by source file to match
 * existing stored data, not by that per-line field.
 */
export function parseRirLine(raw: string, rir: string): ParsedRirLine {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith("#")) return null;
  const parts = line.split("|");
  if (parts.length < 7) return null;
  // Skip header line: 2|registry|serial|records|startdate|enddate|UTCoffset
  if (parts[0] === "2") return null;
  // Skip summary lines: registry|*|type|*|count|summary
  if (parts[5] === "summary") return null;

  const cc = parts[1] ?? "";
  const type = parts[2] ?? "";
  const start = parts[3] ?? "";
  const valueStr = parts[4] ?? "";
  const dateStr = parts[5] ?? "";
  const status = parts[6] ?? null;

  const value = Number(valueStr);
  if (!Number.isFinite(value) || value <= 0) {
    return { skipped: true };
  }
  const country = cc && cc !== "ZZ" ? cc : null;
  const registeredDate = parseRirDate(dateStr);

  if (type === "ipv4") {
    // RIR delegated-extended records give "start address + count", and the
    // count is often not a power of 2 — rangeToCidrs decomposes that into
    // the minimal aligned CIDR set. This decomposition is about the RIR
    // file format, not storage, so it's unchanged by the move to `inet`.
    let startInt: number;
    try {
      startInt = ipv4ToInt(start);
    } catch {
      return { skipped: true };
    }
    const cidrs = rangeToCidrs(startInt, value);
    return {
      skipped: false,
      ipRows: cidrs.map((cidr) => ({
        network: cidr,
        country,
        rir,
        status,
        registeredDate,
      })),
      asnRows: [],
    };
  } else if (type === "ipv6") {
    // Unlike ipv4, the RIR format already gives us "start address + prefix
    // length" directly — a clean CIDR, no decomposition needed.
    const prefix = Math.floor(value);
    if (prefix < 0 || prefix > 128) {
      return { skipped: true };
    }
    return {
      skipped: false,
      ipRows: [
        {
          network: `${start}/${prefix}`,
          country,
          rir,
          status,
          registeredDate,
        },
      ],
      asnRows: [],
    };
  } else if (type === "asn") {
    const asnStart = Number(start);
    if (!Number.isFinite(asnStart)) {
      return { skipped: true };
    }
    return {
      skipped: false,
      ipRows: [],
      asnRows: [
        {
          asnStart,
          asnEnd: asnStart + value - 1,
          country,
          rir,
          status,
          registeredDate,
        },
      ],
    };
  }
  return { skipped: true };
}

/**
 * Real ARIN records use "00000000" as a placeholder for "date unknown"
 * (108 of them in the current file) — format-only validation (digit count)
 * let that through as the literal string "0000-00-00", which Postgres
 * rejects with "date/time field value out of range", silently failing the
 * *entire batch* that record was in (see flushIp/flushAsn's catch — a
 * failed INSERT drops every row in that batch, not just the bad one).
 * Validate real calendar bounds, not just digit shape, so "unknown" comes
 * through as `null` (the correct, already-supported meaning) instead of
 * quietly taking dozens of legitimate rows down with it.
 */
function parseRirDate(d: string | null): string | null {
  if (!d || d.length !== 8) return null;
  const y = d.slice(0, 4);
  const m = d.slice(4, 6);
  const dd = d.slice(6, 8);
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(dd))
    return null;
  const year = Number(y);
  const month = Number(m);
  const day = Number(dd);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${dd}`;
}
