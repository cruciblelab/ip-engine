/**
 * Query the `ip_intel` *definition* in a test without touching the real
 * relation.
 *
 * Tests used to call `ensureIpIntel("view")`, which replaces whatever
 * `ip_intel` is. On a database where it is materialized — the operator's
 * real one — that throws away hours of build work just by running
 * `pnpm test`. Instead: one transaction, a TEMP VIEW of the same SELECT,
 * the caller's queries (and any setup writes) inside it, then a rollback,
 * so nothing a test does here survives.
 */
import { sql } from "drizzle-orm";
import { db, ipIntelSelectSql } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class Rollback extends Error {}

export async function withScratchIpIntel<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`CREATE TEMP VIEW ip_intel_scratch AS ${ipIntelSelectSql()}`));
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result as T;
}
