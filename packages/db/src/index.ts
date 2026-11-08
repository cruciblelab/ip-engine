import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Connection-level settings (like DATABASE_URL itself) live in env vars, not
// ip-insight.config.json — that file is read by @workspace/collector and
// @workspace/lookup, and this package must not depend on either (both
// depend on it).
//
// DEFAULT_POOL_MAX is 20, not pg's own default of 10: a single cache-miss
// `lookupIp()` call fans out to 11-16 concurrent queries of its own
// (Promise.all across ASN/geo/RPKI/threat/etc lookups, see lookup.ts) — at
// pg's default, one cold request can already queue behind itself for
// connections, before any second concurrent request exists at all. 20
// leaves real headroom above that single-request fan-out without being a
// deployment-sizing decision this file has to get exactly right; anyone
// running on a genuinely constrained device (a phone under Termux) can
// still dial it down with DB_POOL_MAX, which this always honors when set.
const DEFAULT_POOL_MAX = 20;
const poolMax = process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : DEFAULT_POOL_MAX;
if (!Number.isInteger(poolMax) || poolMax < 1) {
  throw new Error(`DB_POOL_MAX must be a positive integer, got "${process.env.DB_POOL_MAX}"`);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./views/ip-intel";
export * from "./anycast-seed";
