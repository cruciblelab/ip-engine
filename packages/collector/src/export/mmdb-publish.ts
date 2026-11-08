/**
 * Build a new `.mmdb`, prove it is good, and only then let it serve.
 *
 * The naive version of this — write the file, and keep the old one if the
 * write throws — protects against the failure that almost never happens. The
 * one that does happen is a file that writes perfectly and is wrong: a source
 * came back empty, a collect run half-finished, and the result is a valid
 * MaxMind file of the right shape containing a fraction of the data. Nothing
 * errors. `current.mmdb` gets replaced. The API serves it, and the only
 * symptom is answers quietly getting worse.
 *
 * So promotion is gated on the candidate *answering correctly*, not on the
 * build not throwing:
 *
 *  1. Build and write to a timestamped file. Never overwrite anything.
 *  2. Re-open it with the real MaxMind reader — the same library a consumer
 *     would use, deliberately not our own writer's code, so a bug in the
 *     writer can't validate itself.
 *  3. Ask it a golden set of addresses with known answers, and compare
 *     aggregate shape against the file currently serving.
 *  4. Only if every check passes, atomically repoint `current.mmdb`.
 *
 * A rejected candidate is left on disk rather than deleted: the reason to
 * keep it is that "why was this rejected" is a question best answered by
 * looking at the file, and it costs nothing until retention prunes it.
 *
 * Rollback exists separately (`rollbackMmdb`) because validation cannot catch
 * everything. A regression noticed two hours later needs a way back that
 * doesn't involve rebuilding for hours.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, desc, and } from "drizzle-orm";
import { db, mmdbPublishesTable } from "@workspace/db";
import { logger } from "@workspace/shared";
import { exportMmdb } from "./mmdb-export";

/** The symlink consumers point at. Repointed by rename, which is atomic — a
 * reader either follows the old target or the new one, never a half-written
 * file. */
export const CURRENT_LINK = "current.mmdb";

export interface GoldenCase {
  ip: string;
  /** Field → expected value. Only the listed fields are compared, so a case
   * can assert `{country: "US"}` without pinning everything else. */
  expect: Record<string, string | number | boolean>;
}

/**
 * Deliberately small and boring. These are not a test suite for the data —
 * they are a smoke test for "did the pipeline produce something sane",
 * chosen because each would break for a *different* upstream reason:
 * a well-known ASN (BGP ingestion), a country (RIR stats), a published
 * crawler range (verified-bot sources), and a Tor exit (anonymity sources).
 *
 * Overridable per deployment via `goldenSetPath` — a project serving mostly
 * one region will want its own addresses here.
 */
export const DEFAULT_GOLDEN_SET: GoldenCase[] = [
  { ip: "8.8.8.8", expect: { asn: 15169, country: "US" } },
  { ip: "1.1.1.1", expect: { asn: 13335 } },
  { ip: "66.249.66.1", expect: { verified_bot: "googlebot" } },
  { ip: "193.0.6.139", expect: { country: "NL", asn: 3333 } },
];

export interface PublishOptions {
  /** Directory holding the timestamped files and `current.mmdb`. */
  dir: string;
  databaseType?: string;
  /** JSON file of `GoldenCase[]`, replacing the defaults above. */
  goldenSetPath?: string;
  /** Reject if the candidate has fewer prefixes than this fraction of what
   * is currently serving. Guards the "a source came back empty" case, which
   * is the realistic way a build goes wrong. */
  minPrefixRatio?: number;
  /** Same idea as `minPrefixRatio`, applied per field rather than to the
   * total row count — catches a build where the *count* of records looks
   * normal but one specific field (say, `city`, or `rpki_status`) went
   * silently bulk-null, e.g. a join in `ip_intel` breaking for one column
   * without affecting row count at all. `prefix-count` alone cannot see
   * this, and the golden set only ever pins down the handful of fields it
   * explicitly asserts. Defaults to `minPrefixRatio` if unset, so a
   * deployment that already tuned one tolerance doesn't silently get a
   * looser default for the other. */
  minFieldRatio?: number;
  /** Keep this many timestamped files. `current` and the file it points at
   * are never pruned regardless. */
  retain?: number;
}

export interface PublishCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PublishResult {
  status: "published" | "rejected";
  filePath: string;
  prefixes: number;
  sizeBytes: number;
  checks: PublishCheck[];
}

function currentPath(dir: string): string {
  return path.join(dir, CURRENT_LINK);
}

/** Absolute path the `current` symlink resolves to, or null if unset. */
export function currentTarget(dir: string): string | null {
  try {
    const target = fs.readlinkSync(currentPath(dir));
    return path.isAbsolute(target) ? target : path.join(dir, target);
  } catch {
    return null;
  }
}

/** Repoint `current.mmdb` atomically: symlink to a temp name, then rename
 * over the old one. `fs.symlinkSync` cannot replace an existing link, and
 * unlink-then-symlink would leave a window with no `current` at all. */
function repointCurrent(dir: string, target: string): void {
  const tmp = path.join(dir, `.current.mmdb.${process.pid}.tmp`);
  fs.symlinkSync(path.basename(target), tmp);
  fs.renameSync(tmp, currentPath(dir));
}

/** Exported for testing: exercising this against a real (small, synthetic)
 * candidate and a real `ops.mmdb_publishes` row is far cheaper than routing
 * through `publishMmdb()` + `exportMmdb()`, which needs a fully materialized
 * `ip_intel` — hours on a full dataset. See `mmdb-publish.integration.test.ts`. */
export async function validate(
  candidate: string,
  prefixes: number,
  fieldCounts: Record<string, number>,
  opts: PublishOptions,
): Promise<PublishCheck[]> {
  const checks: PublishCheck[] = [];

  // Read back with the consumer's own library, not ours.
  const maxmind = (await import("maxmind")).default;
  let reader: Awaited<ReturnType<typeof maxmind.open>>;
  try {
    reader = await maxmind.open(candidate);
    checks.push({ name: "readable", ok: true, detail: "opened with the MaxMind reader" });
  } catch (err) {
    checks.push({
      name: "readable",
      ok: false,
      detail: `MaxMind reader could not open the file: ${err instanceof Error ? err.message : String(err)}`,
    });
    return checks;
  }

  const golden: GoldenCase[] = opts.goldenSetPath
    ? (JSON.parse(fs.readFileSync(opts.goldenSetPath, "utf8")) as GoldenCase[])
    : DEFAULT_GOLDEN_SET;

  for (const c of golden) {
    const got = reader.get(c.ip) as Record<string, unknown> | null;
    const wrong = Object.entries(c.expect).filter(([k, v]) => got?.[k] !== v);
    checks.push({
      name: `golden:${c.ip}`,
      ok: wrong.length === 0,
      detail:
        wrong.length === 0
          ? "matched"
          : wrong.map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got?.[k])}`).join("; "),
    });
  }

  // Shape check against what is serving now. Skipped on a first publish,
  // where there is nothing to compare against and no basis to reject.
  const ratio = opts.minPrefixRatio ?? 0.8;
  const [previous] = await db
    .select({ prefixes: mmdbPublishesTable.prefixes, fieldCounts: mmdbPublishesTable.fieldCounts })
    .from(mmdbPublishesTable)
    .where(eq(mmdbPublishesTable.status, "published"))
    .orderBy(desc(mmdbPublishesTable.startedAt))
    .limit(1);

  if (!previous?.prefixes) {
    checks.push({ name: "prefix-count", ok: true, detail: `${prefixes} (first publish, nothing to compare)` });
  } else {
    const got = prefixes / previous.prefixes;
    checks.push({
      name: "prefix-count",
      ok: got >= ratio,
      detail: `${prefixes} vs ${previous.prefixes} previously (${(got * 100).toFixed(1)}%, floor ${(ratio * 100).toFixed(0)}%)`,
    });
  }

  // Field-completeness: `prefix-count` above only sees how many rows made
  // it into the file, not what's inside them. A join that silently starts
  // returning null for one column (this project's own real example: a
  // discussion of the `lookup.ts`/`ip_intel` merge work turned up that the
  // golden set never once asserts `city`, `region`, `rpki_status`, or most
  // other fields) would leave `prefix-count` and every golden case green
  // while a real column quietly went empty across the board. Skips fields
  // the golden set already pins down (nothing to add there) and any field
  // with no comparable previous count — either it's new this build (e.g.
  // `mmdbHistoryFields` just got turned on) or the previous published row
  // predates this check entirely — both are "nothing to regress from", not
  // a reason to fail.
  const goldenFields = new Set(golden.flatMap((c) => Object.keys(c.expect)));
  const fieldRatio = opts.minFieldRatio ?? ratio;
  const previousFieldCounts = (previous?.fieldCounts as Record<string, number> | null) ?? null;
  if (previousFieldCounts) {
    for (const [field, count] of Object.entries(fieldCounts)) {
      if (goldenFields.has(field)) continue;
      const before = previousFieldCounts[field];
      if (!before) continue;
      const got = count / before;
      checks.push({
        name: `field-completeness:${field}`,
        ok: got >= fieldRatio,
        detail: `${count} vs ${before} previously (${(got * 100).toFixed(1)}%, floor ${(fieldRatio * 100).toFixed(0)}%)`,
      });
    }
  }

  return checks;
}

/** Delete old timestamped files beyond `retain`, never touching the file
 * `current` points at nor the newest published one. Count-based rather than
 * age-based on purpose: after a long outage, an age rule would delete every
 * file there was to roll back to. */
function prune(dir: string, retain: number): number {
  const live = currentTarget(dir);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mmdb") && f !== CURRENT_LINK)
    .map((f) => path.join(dir, f))
    .sort()
    .reverse();

  let removed = 0;
  for (const f of files.slice(retain)) {
    if (f === live) continue;
    try {
      fs.rmSync(f);
      removed++;
    } catch {
      // A file we cannot remove is not worth failing a publish over.
    }
  }
  return removed;
}

export async function publishMmdb(opts: PublishOptions): Promise<PublishResult> {
  fs.mkdirSync(opts.dir, { recursive: true });
  const [run] = await db.insert(mmdbPublishesTable).values({ status: "running" }).returning();
  if (!run) throw new Error("Failed to create mmdb_publishes row");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidate = path.join(opts.dir, `ip-insight-${stamp}.mmdb`);

  try {
    const built = await exportMmdb({ databaseType: opts.databaseType });
    fs.writeFileSync(candidate, built.buffer);

    const checks = await validate(candidate, built.rows, built.fieldCounts, opts);
    const ok = checks.every((c) => c.ok);
    const common = {
      endedAt: new Date(),
      filePath: candidate,
      sizeBytes: built.buffer.length,
      prefixes: built.rows,
      fieldCounts: built.fieldCounts,
      checks,
    };

    if (!ok) {
      await db
        .update(mmdbPublishesTable)
        .set({ ...common, status: "rejected" })
        .where(eq(mmdbPublishesTable.id, run.id));
      logger.error(
        { candidate, failed: checks.filter((c) => !c.ok) },
        "mmdb candidate rejected — the previously published file keeps serving",
      );
      return { status: "rejected", filePath: candidate, prefixes: built.rows, sizeBytes: built.buffer.length, checks };
    }

    repointCurrent(opts.dir, candidate);
    await db
      .update(mmdbPublishesTable)
      .set({ ...common, status: "published" })
      .where(eq(mmdbPublishesTable.id, run.id));
    const removed = prune(opts.dir, opts.retain ?? 5);
    logger.info(
      { candidate, prefixes: built.rows, sizeBytes: built.buffer.length, pruned: removed },
      "mmdb published",
    );
    return { status: "published", filePath: candidate, prefixes: built.rows, sizeBytes: built.buffer.length, checks };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(mmdbPublishesTable)
      .set({ status: "failed", endedAt: new Date(), errorMessage: message })
      .where(eq(mmdbPublishesTable.id, run.id));
    logger.error({ err }, "mmdb build failed — the previously published file keeps serving");
    throw err;
  }
}

/**
 * Point `current` back at the previously published file.
 *
 * Separate from validation because it covers what validation cannot: a
 * candidate that passed every check and is still wrong. The alternative in
 * that situation is rebuilding, which takes hours — this takes a rename.
 */
export async function rollbackMmdb(dir: string): Promise<string> {
  const live = currentTarget(dir);
  const published = await db
    .select({ filePath: mmdbPublishesTable.filePath })
    .from(mmdbPublishesTable)
    .where(and(eq(mmdbPublishesTable.status, "published")))
    .orderBy(desc(mmdbPublishesTable.startedAt))
    .limit(10);

  const target = published
    .map((p) => p.filePath)
    .find((p): p is string => !!p && p !== live && fs.existsSync(p));

  if (!target) {
    throw new Error(
      "No earlier published .mmdb is still on disk to roll back to — retention may have pruned it.",
    );
  }
  repointCurrent(dir, target);
  logger.warn({ from: live, to: target }, "mmdb rolled back");
  return target;
}
