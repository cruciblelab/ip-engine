/**
 * `bulk-load.ts` — a COPY-based row writer for enrichment sources that fully
 * replace their own table every run.
 *
 * ## Why this exists
 *
 * `dbip-lite` writes 14.7M rows per run (6.25M IPv4 + 8.48M IPv6 once
 * `dbipLiteIpv6` is on). The original path did that with 2,000-row `INSERT`
 * statements — ~7,350 of them, each carrying 12,000 bind parameters — plus a
 * progress `UPDATE` after every single batch, into a table it had just
 * emptied with an unqualified `DELETE`. Measured on real data (see
 * `docs/100-bulk-copy-ingest.md` for the full attribution table), those three
 * things cost, in order:
 *
 *   - the `DELETE`      1.4x, and left the table permanently bloated
 *   - the progress rows 1.5x  (1,500 extra round-trips per 3M rows)
 *   - `INSERT` vs COPY  2.5x
 *
 * ## What is deliberately NOT here
 *
 * Four other changes were benchmarked and rejected because the measurements
 * said no, which is worth recording so nobody re-proposes them from first
 * principles:
 *
 *   - `synchronous_commit = off` for the load: no measurable effect once COPY
 *     is used (COPY already amortises commits), so it is pure added risk.
 *   - `maintenance_work_mem = 256MB` for the index build: **26% slower**.
 *   - Dropping the SP-GiST index for the load and rebuilding it after: a wash
 *     at 3M rows. Re-measured at full 14.7M scale before being dropped — see
 *     the doc.
 *   - Dropping the unused `id`/`ingested_at` columns: no speed win at all
 *     (22% less storage, but it breaks a convention every sibling range table
 *     follows). Recorded in the doc as an optional follow-up, not done here.
 *
 * ## Removing this
 *
 * 1. **Turn it off** — set `"bulkCopyIngest": false` in
 *    `ip-insight.config.json`. `ingestDbIpLiteCsv` then takes the original
 *    `DELETE` + batched-`INSERT` path, byte for byte, and nothing in this
 *    file runs. That is the whole point of keeping both writers.
 * 2. **Remove the wiring** — in `enrichment.ts`'s `ingestDbIpLiteCsv`,
 *    everything this feature adds sits between the two comment markers
 *    `─── COPY fast path (bulkCopyIngest) — begin ───` and `─── end ───`.
 *    Delete that block (the closing marker names the two lines to put back
 *    in its place) and the `import { openBulkRowWriter } from "./bulk-load"`
 *    at the top of the file; the loop and the tail below call only
 *    `pushRow`/`finishRows`/`abortRows` and need no edits of their own
 *    beyond dropping `abortRows` from the `catch`. Then the flag itself,
 *    which lives at five sites in `packages/collector/src/config.ts`
 *    (interface field, `DEFAULTS`, the no-config-file branch, the
 *    `parseBooleanValue` call, the returned object), the key in
 *    `ip-insight.config.json`, and the display line in
 *    `apps/cli/src/index.ts`'s `config` command.
 *
 *    The single-block shape is a consequence of testing this list rather
 *    than trusting it: the first version scattered `if (copyWriter)` checks
 *    through the function, named three edit sites where there were eight,
 *    and failed to typecheck when the steps were actually applied to a
 *    scratch copy.
 * 3. **Remove the code** — delete this file and `bulk-load.test.ts` and
 *    `bulk-load.integration.test.ts`, then drop **both** `pg-copy-streams`
 *    (dependencies) and `@types/pg-copy-streams` (devDependencies) from
 *    `packages/collector/package.json`, and re-run `pnpm install`. Nothing
 *    else imports any of it — verified by `grep` across `packages/`, `apps/`
 *    and `docs/`, not from memory.
 *
 * Lookups, `ip_intel`, the `.mmdb` export and every other enrichment source
 * are untouched by all three steps — none of them call in here.
 */

import { from as copyFrom } from "pg-copy-streams";
import { logger } from "@workspace/shared";

// `@workspace/db` is imported *inside* `openBulkRowWriter`, not at the top.
// That package throws at module load when DATABASE_URL is unset, so a static
// import here would make this file — and the pure encoding logic it also
// holds — unimportable without a database. Same reason README.md gives for
// the dynamic import in every `*.integration.test.ts`.

/** What a single column position can hold. `null` becomes SQL NULL. */
export type BulkValue = string | number | null | undefined;

export interface BulkRowWriter {
  /** Queue one row. Resolves immediately unless the socket needs draining. */
  push(values: BulkValue[]): Promise<void>;
  /** Flush the tail and wait for Postgres to accept the whole stream. */
  finish(): Promise<void>;
  /** Tear down after a failure. Never throws. */
  abort(): Promise<void>;
}

/**
 * CSV, not COPY's default text format. Text format assigns meaning to
 * backslashes, which means every field needs `\` `\n` `\r` `\t` escaped and a
 * miss corrupts data silently. In CSV format the only metacharacter is the
 * quote, every value is emitted quoted, and an embedded quote is doubled —
 * a rule with no edge cases. NULL is the one unquoted form, which is why it
 * can never collide with a real empty string.
 */
function encodeCsvRow(values: BulkValue[]): string {
  let line = "";
  for (let i = 0; i < values.length; i++) {
    if (i > 0) line += ",";
    const v = values[i];
    if (v === null || v === undefined) continue; // unquoted empty == NULL
    if (typeof v === "number") {
      // Non-finite numbers have no `double precision` representation Postgres
      // would accept here; the callers already filter them, and this is the
      // backstop for the ones that don't.
      if (!Number.isFinite(v)) continue;
      line += String(v);
      continue;
    }
    line += `"${v.replace(/"/g, '""')}"`;
  }
  return line + "\n";
}

/** Bytes buffered before a socket write. Big enough that the per-write cost
 * is amortised over thousands of rows, small enough to stay well inside a
 * phone's memory. */
const WRITE_BUFFER_BYTES = 1 << 20; // 1 MiB

/**
 * Opens a `COPY <table> (<columns>) FROM STDIN` on a dedicated pooled client.
 *
 * The client is held for the entire load — minutes, on the sources this is
 * built for — so this refuses to run on a pool with only one connection
 * rather than deadlocking against the progress updates the caller keeps
 * making on the shared pool. That is a real configuration: `DB_POOL_MAX=1`
 * is a reasonable thing to set on a constrained device.
 */
export async function openBulkRowWriter(
  table: string,
  columns: string[],
): Promise<BulkRowWriter | null> {
  // `table`/`columns` are interpolated, so they must never be caller-supplied
  // text. Every call site passes a literal from this codebase; this assertion
  // exists so that stays true if someone later wires a config value in.
  const ident = /^[a-z_][a-z0-9_]*$/;
  if (!ident.test(table) || !columns.every((c) => ident.test(c))) {
    throw new Error(`bulk-load: refusing to build COPY for unsafe identifiers (${table})`);
  }
  const { pool } = await import("@workspace/db");
  // `pool.options.max` is pg's own resolved value, so this reads whatever
  // DB_POOL_MAX actually produced rather than re-deriving it.
  const max = (pool as unknown as { options?: { max?: number } }).options?.max ?? 10;
  if (max < 2) {
    logger.warn(
      { poolMax: max },
      "bulk-load: DB_POOL_MAX is 1, so a COPY would hold the only connection and deadlock the progress updates — falling back to the batched-INSERT path",
    );
    return null;
  }

  const client = await pool.connect();
  let stream: NodeJS.WritableStream & {
    on(e: string, f: (...a: unknown[]) => void): unknown;
    once(e: string, f: (...a: unknown[]) => void): unknown;
    off?(e: string, f: (...a: unknown[]) => void): unknown;
  };
  try {
    stream = client.query(
      copyFrom(`COPY ${table} (${columns.join(", ")}) FROM STDIN WITH (FORMAT csv)`),
    ) as typeof stream;
  } catch (err) {
    client.release();
    throw err;
  }

  // A COPY that Postgres rejects (a malformed `inet`, say) fails on the
  // stream, not on the write that caused it — the error can surface long
  // after `push` returned. Latched here so `finish()` reports it rather than
  // hanging on a "finish" event that will never come.
  let streamError: Error | null = null;
  stream.on("error", (err: unknown) => {
    streamError = err instanceof Error ? err : new Error(String(err));
  });

  let buf = "";
  let released = false;
  /**
   * `destroy` closes the underlying connection instead of returning it to the
   * pool. That is not tidiness — an aborted COPY leaves the connection
   * mid-protocol, and a plain `release()` hands that state to whoever asks
   * for a connection next. pg says so out loud when it happens
   * ("Calling client.query() when the client is already executing a query"),
   * which is how this was caught: the abort test emitted that warning and
   * the others did not.
   */
  const release = (destroy?: Error) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };

  const flush = async (): Promise<void> => {
    if (!buf) return;
    const chunk = buf;
    buf = "";
    if (!stream.write(chunk)) {
      // Racing the error against the drain, not just waiting for the drain.
      // A stream that fails while the socket is full never emits "drain", so
      // waiting on it alone hangs forever — and a phone on a flaky link is
      // exactly where a mid-load failure happens.
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          stream.off?.("error", onError);
          resolve();
        };
        const onError = (err: unknown) => {
          stream.off?.("drain", onDrain);
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        stream.once("drain", onDrain);
        stream.once("error", onError);
      });
    }
  };

  return {
    async push(values) {
      if (streamError) throw streamError;
      buf += encodeCsvRow(values);
      if (buf.length >= WRITE_BUFFER_BYTES) await flush();
    },
    async finish() {
      // Tracked separately from `streamError`, because a failure that happens
      // *during* this call (in flush, or waiting for "finish") has to reach
      // the release below too. Releasing a connection whose COPY never
      // terminated hands the next caller a socket mid-protocol — the same
      // fault `abort()` was already fixed for, reachable here by simply
      // throwing before `stream.end()` was ever called.
      let failure: Error | undefined;
      try {
        if (streamError) throw streamError;
        await flush();
        await new Promise<void>((resolve, reject) => {
          stream.on("finish", () => resolve());
          stream.on("error", (err: unknown) =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
          stream.end();
        });
        if (streamError) throw streamError;
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        throw failure;
      } finally {
        release(failure);
      }
    },
    async abort() {
      const reason = new Error("bulk-load aborted");
      try {
        // Destroying the stream makes Postgres abort the COPY; the
        // transaction it ran in rolls back on its own. Deliberately swallows
        // everything — this only ever runs while another error is already on
        // its way up, and masking that one would be worse than closing a
        // connection a moment late.
        (stream as unknown as { destroy?: (e?: Error) => void }).destroy?.(reason);
      } catch {
        /* ignore */
      } finally {
        release(reason);
      }
    },
  };
}

/** Exported for the unit tests, which pin the encoding rules directly. */
export const __testing = { encodeCsvRow };
