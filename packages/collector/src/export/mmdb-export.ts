/**
 * Export the flattened database to a `.mmdb` file.
 *
 * This is the deployment path for volume, and the gap is larger than it
 * looks. Measured over real HTTP on one 4-vCPU box (2026-07-28), with
 * scattered addresses rather than a repeated one: the Postgres-backed API
 * serves **~46 req/s** once the cache misses, because each lookup is a
 * dozen GiST containment scans with no page locality. The same data as an
 * .mmdb, served by a minimal Node process, does **~18,900 req/s** — a
 * memory-mapped trie walk with no database in the picture. Roughly 400x,
 * not a tuning difference. Same answers, and readable by the MaxMind
 * reader that already exists for whatever language the consumer uses.
 *
 * The 18,900 figure specifically: treat as unreliable until re-measured.
 * DEPLOY.md's ".mmdb serving throughput" section (2026-08-07) found that
 * benchmarking this exact server shape with a single-threaded Node client
 * undercounts real throughput by ~4x — a real phone with weaker per-core
 * hardware than a 4-vCPU box cleared this number by ~2x once measured with
 * a proper (Go) client. This comment's own number was never re-measured
 * that way, so it's likely undercounting the real gap, not overstating it.
 *

 * Source is `ip_intel` — the flattened relation — precisely so that the file
 * and the API answer identically. Building it from the source tables again
 * would be a second implementation of the merge rules, and the two would
 * drift.
 *
 * Rows are streamed least-specific first (`ORDER BY masklen`) because the
 * trie writer lets a later, more specific entry override an earlier one at
 * greater depth. Reversing that order would let a /8 silently overwrite the
 * /24s inside it.
 */
import { sql } from "drizzle-orm";
import { db, ipIntelState } from "@workspace/db";
import { logger } from "@workspace/shared";
import { loadCollectorConfig } from "../config";
import { buildMmdb, type MmdbEntry, type MmdbValue } from "./mmdb-writer";

/** Columns carried into the file. Deliberately a subset: an .mmdb is read on
 * the hot path of somebody else's request, so it holds the facts a caller
 * acts on and leaves the provenance/debugging fields to the API. */
interface IntelRow extends Record<string, unknown> {
  network: string;
  country: string | null;
  city: string | null;
  region: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  geo_source: string | null;
  asn: number | null;
  asn_name: string | null;
  asn_size_rank: number | null;
  cloud_provider: string | null;
  is_cloud: boolean | null;
  is_anycast: boolean | null;
  is_threat: boolean | null;
  is_tor: boolean | null;
  is_vpn: boolean | null;
  rpki_status: string | null;
  special_purpose: string | null;
  /** Carried because it is acted on directly — "is this really Googlebot"
   * is a decision a consumer makes at request time, which is exactly what
   * the file is for. `neighborhood` deliberately is not: it is keyed by /24
   * block rather than by prefix, so it has no natural home in a per-prefix
   * row and would have to be denormalised misleadingly. */
  verified_bot: string | null;
  verified_bot_operator: string | null;
  /** Only selected when `mmdbHistoryFields` is on — see that config option's
   * doc comment for why this is a manual, maturity-gated decision rather
   * than an always-on column. `undefined` (not queried) and `null` (queried,
   * no baseline row for this network yet) both mean "omit"; `put()` below
   * treats them the same. */
  stable_since?: string | null;
}

/** Drop nulls rather than encoding them: an absent key is how MaxMind
 * databases signal "no data", and readers of every language already treat it
 * that way. Encoding an explicit null would make every record larger and
 * every consumer's null-check different. */
function toRecord(row: IntelRow): Record<string, MmdbValue> {
  const record: Record<string, MmdbValue> = {};
  const put = (key: string, value: MmdbValue): void => {
    if (value !== null && value !== undefined && value !== "") record[key] = value;
  };

  const location: Record<string, MmdbValue> = {};
  if (row.latitude !== null) location["latitude"] = row.latitude;
  if (row.longitude !== null) location["longitude"] = row.longitude;

  put("country", row.country);
  put("city", row.city);
  put("region", row.region);
  put("postal", row.postal);
  if (Object.keys(location).length > 0) record["location"] = location;
  put("geo_source", row.geo_source);
  // `asn` is a bigint column, and node-postgres hands bigints back as
  // *strings* to avoid silently losing precision above 2^53. Passing that
  // through would put `"15169"` in the file where every consumer — and
  // MaxMind's own ASN database — expects a number. The coercion is safe
  // here specifically: ASNs are 32-bit (RFC 6793 caps them at 4294967295),
  // comfortably inside the range the string was protecting.
  put("asn", row.asn === null ? null : Number(row.asn));
  put("asn_name", row.asn_name);
  put("asn_size_rank", row.asn_size_rank);
  put("cloud_provider", row.cloud_provider);
  put("rpki_status", row.rpki_status);
  put("special_purpose", row.special_purpose);
  put("verified_bot", row.verified_bot);
  put("verified_bot_operator", row.verified_bot_operator);
  put("stable_since", row.stable_since ?? null);
  // Booleans are only emitted when true — false is the default a reader
  // infers from absence, and emitting it would roughly double the record
  // count that survives dedup for no information gain.
  if (row.is_cloud) record["is_cloud"] = true;
  if (row.is_anycast) record["is_anycast"] = true;
  if (row.is_threat) record["is_threat"] = true;
  if (row.is_tor) record["is_tor"] = true;
  if (row.is_vpn) record["is_vpn"] = true;
  return record;
}

export interface MmdbExportResult {
  buffer: Buffer;
  rows: number;
  nodeCount: number;
  recordCount: number;
  skipped: number;
  /** How many entries in this build carried each field, keyed by the exact
   * key `toRecord()` puts into the file (`location` covers both latitude
   * and longitude together, since that's the shape a reader actually sees).
   * Feeds `mmdb-publish.ts`'s per-field completeness check — see that
   * file for why row/prefix counts alone can't catch a field going
   * silently bulk-null. */
  fieldCounts: Record<string, number>;
}

export async function exportMmdb(options?: { databaseType?: string }): Promise<MmdbExportResult> {
  const state = await ipIntelState();
  if (state === "off") {
    throw new Error(
      "ip_intel does not exist — run `ip-insight flatten --mode materialized` first (the .mmdb is built from it so the file and the API can never disagree).",
    );
  }
  if (state === "view") {
    // A plain view recomputes its full LATERAL join chain (RPKI, abuse,
    // anonymity, asn_reach, ...) on every query — cheap once for a single
    // address, catastrophic for a bulk scan. Paging this export by masklen
    // against a view means redoing that whole computation once per distinct
    // mask value; measured on a real ~2.5M-row database, that ran over an
    // hour on one core before being killed. Materialized, the same paging
    // is a plain indexed scan per page. Fail fast here instead of silently
    // taking hours.
    throw new Error(
      "ip_intel is a plain view — exporting from it rescans the whole database once per prefix " +
        "length and can take hours. Run `ip-insight flatten --mode materialized` first.",
    );
  }

  // Built once outside the mask loop, not per page — `mmdbHistoryFields`
  // can't change mid-export. Empty `sql` fragments when off, so the query
  // shape (and therefore its plan) is identical to before this option
  // existed for anyone not using it.
  const includeHistoryFields = loadCollectorConfig().mmdbHistoryFields;
  const historyColumn = includeHistoryFields
    ? sql`, b.captured_at::date::text AS stable_since`
    : sql``;
  // LEFT, not INNER: a prefix can be in ip_intel without ever having been
  // through a history capture yet (baseline lags enrichment until the next
  // capture runs) — that's "no stable_since data" (null), not "exclude this
  // row from the whole export".
  const historyJoin = includeHistoryFields
    ? sql`LEFT JOIN ops.prefix_baseline b ON b.network = i.network`
    : sql``;

  // Paged by prefix length rather than by OFFSET, for two reasons that
  // happen to align: the trie needs least-specific first anyway, and an
  // OFFSET walk over a 2.5M-row view re-evaluates the skipped rows every
  // page. Grouping by masklen gives natural, cheap pages in exactly the
  // order required — and keeps peak memory to one length-group instead of
  // the whole relation, which is what killed the first attempt at this.
  const entries: MmdbEntry[] = [];
  const fieldCounts: Record<string, number> = {};
  let scanned = 0;
  // All 129 pages read inside ONE `repeatable read` transaction, so every
  // page sees the same snapshot. Without this each page took its own — 129
  // separate implicit transactions — and a refresh committing partway
  // through produced a file that was pre-refresh for some prefix lengths
  // and post-refresh for others. Nothing rejected it either: the result is
  // a structurally valid .mmdb whose rows simply disagree with each other,
  // so `validate()`'s per-field counts look fine and the torn build gets
  // published. Not hypothetical once refreshes run on more than one
  // cadence, which is exactly the direction this project is heading (see
  // DEPLOY.md's tiered-refresh plan) — the window widens as soon as a
  // second relation starts refreshing independently of the first.
  //
  // `repeatable read` rather than `serializable`: this is a read-only
  // scan, so the only property needed is a stable snapshot across all 129
  // statements, and `serializable` would add predicate-locking overhead
  // (and a real serialization-failure retry path) for a guarantee nothing
  // here uses.
  await db.transaction(
    async (tx) => {
      for (let mask = 0; mask <= 128; mask++) {
        const page = await tx.execute<IntelRow>(sql`
      SELECT i.network::text AS network, i.country, i.city, i.region, i.postal,
             i.latitude, i.longitude, i.geo_source, i.asn, i.asn_name, i.asn_size_rank,
             i.cloud_provider, i.is_cloud, i.is_anycast, i.is_threat, i.is_tor, i.is_vpn,
             i.rpki_status, i.special_purpose, i.verified_bot, i.verified_bot_operator
             ${historyColumn}
      FROM ip_intel i
      ${historyJoin}
      WHERE masklen(i.network) = ${mask}
    `);
        if (page.rows.length === 0) continue;
        scanned += page.rows.length;
        for (const row of page.rows) {
          const record = toRecord(row);
          // A prefix we know nothing about carries no information into the file;
          // including it would only grow the trie.
          if (Object.keys(record).length === 0) continue;
          entries.push({ network: row.network, record });
          for (const key of Object.keys(record)) {
            fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
          }
        }
        logger.debug({ mask, rows: page.rows.length, kept: entries.length }, "mmdb export page");
      }
    },
    { isolationLevel: "repeatable read" },
  );
  logger.info({ scanned, kept: entries.length }, "Building .mmdb from ip_intel");

  const built = buildMmdb(entries, {
    databaseType: options?.databaseType ?? "IP-Insight-Engine",
    description: {
      en: "IP-Insight-Engine — self-hosted IP intelligence built from free public sources",
    },
  });

  return {
    buffer: built.buffer,
    rows: entries.length,
    nodeCount: built.nodeCount,
    recordCount: built.recordCount,
    skipped: built.skipped,
    fieldCounts,
  };
}
