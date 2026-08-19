/**
 * Formalizes the manual audit-script workflow this project has used every
 * time a new ASN-name classification pattern was added this session (a
 * throwaway `apps/cli/audit-*.ts`, run once, deleted after use — see
 * DEPLOY.md's classifier-fix and regional-audit sections for the actual
 * numbers that process produced). A candidate word/pattern for
 * `asn-types.ts`'s `RULES` can be checked against the real, full
 * `asn_blocks.name` column without writing and deleting a one-off script
 * each time.
 *
 * Deliberately scoped to `asn_blocks.name` only, not `connection-type.ts`'s
 * reverse-DNS half: reverse DNS is inherently a live, per-address lookup in
 * this project (see SOURCES.md's "Supporting signals"), never bulk-stored,
 * so there is no column to bulk-test a candidate DNS pattern against.
 */
import { db, asnBlocksTable } from "@workspace/db";
import { classifyAsnName } from "@workspace/lookup";

export interface ClassifyTestOptions {
  flags?: string;
  sample?: number;
  json?: boolean;
  compareTo?: string;
}

export async function runClassifyTest(pattern: string, opts: ClassifyTestOptions): Promise<void> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.flags ?? "i");
  } catch (err) {
    console.error(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let compareRe: RegExp | undefined;
  if (opts.compareTo) {
    try {
      compareRe = new RegExp(opts.compareTo, opts.flags ?? "i");
    } catch (err) {
      console.error(`Invalid --compare-to pattern: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // Full-table scan in-process, not a DB-side regex filter: this guarantees
  // the exact same JS RegExp semantics `classifyAsnName` itself uses at
  // runtime (Postgres's `~*` is a different regex dialect — flags and some
  // constructs don't map 1:1). 116k-ish rows of short text is small enough
  // to hold in memory and scan in well under a second; the expensive
  // full-table-scan traps this project has hit elsewhere this session were
  // all spatial/containment joins over 1M+-row range tables, not this.
  const rows = await db.select({ name: asnBlocksTable.name, rir: asnBlocksTable.rir }).from(asnBlocksTable);

  const matches: { name: string; rir: string | null; alreadyClassified: string; newCapture: boolean }[] = [];
  let compareMatches = 0;
  for (const row of rows) {
    if (!row.name) continue;
    const hit = re.test(row.name);
    if (compareRe?.test(row.name)) compareMatches++;
    if (!hit) continue;
    const current = classifyAsnName(row.name);
    matches.push({
      name: row.name,
      rir: row.rir,
      alreadyClassified: current.type,
      newCapture: current.type === "other",
    });
  }

  const newCaptures = matches.filter((m) => m.newCapture);
  const alreadyCaught = matches.filter((m) => !m.newCapture);
  const byExistingType = new Map<string, number>();
  for (const m of alreadyCaught) {
    byExistingType.set(m.alreadyClassified, (byExistingType.get(m.alreadyClassified) ?? 0) + 1);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          pattern,
          flags: opts.flags ?? "i",
          totalAsnBlocks: rows.length,
          totalMatches: matches.length,
          newCaptures: newCaptures.length,
          alreadyCaughtByExistingRule: alreadyCaught.length,
          alreadyCaughtByType: Object.fromEntries(byExistingType),
          compareTo: opts.compareTo ? { pattern: opts.compareTo, matches: compareMatches } : undefined,
          sample: newCaptures.slice(0, opts.sample ?? 30).map((m) => ({ name: m.name, rir: m.rir })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Pattern:        /${pattern}/${opts.flags ?? "i"}`);
  console.log(`Scanned:        ${rows.length} asn_blocks rows (full table)`);
  console.log(`Total matches:  ${matches.length}`);
  console.log(
    `New captures:   ${newCaptures.length} (currently classified "other" — this pattern would change them)`,
  );
  console.log(
    `Already caught: ${alreadyCaught.length} (an earlier rule in RULES already classifies these — this` +
      " pattern would never be reached for them, first-match-wins)",
  );
  if (byExistingType.size > 0) {
    for (const [type, count] of byExistingType) {
      console.log(`                  - ${count} already "${type}"`);
    }
  }
  if (opts.compareTo) {
    console.log(
      `\n--compare-to /${opts.compareTo}/: ${compareMatches} matches ` +
        `(${compareMatches - matches.length >= 0 ? "+" : ""}${compareMatches - matches.length} vs the pattern above)`,
    );
  }

  const sampleSize = opts.sample ?? 30;
  const sample = newCaptures.slice(0, sampleSize);
  if (sample.length > 0) {
    console.log(`\nSample of new captures (${sample.length} of ${newCaptures.length}, for manual precision review):`);
    for (const m of sample) {
      console.log(`  [${(m.rir ?? "?").padEnd(8)}] ${m.name}`);
    }
    if (newCaptures.length > sampleSize) {
      console.log(`  ... and ${newCaptures.length - sampleSize} more (raise --sample to see more, or use --json)`);
    }
  } else if (matches.length > 0) {
    console.log(`\nNo new captures — every match is already classified by an earlier rule.`);
  } else {
    console.log(`\nNo matches at all in the real data.`);
  }
}
