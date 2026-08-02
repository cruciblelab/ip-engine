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
// depend on it). DB_POOL_MAX matters most on constrained deployments (e.g.
// a phone running Postgres under Termux) where pg's default of 10 idle
// connections can be more than the device wants to hold open.
const poolMax = process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : undefined;
if (poolMax !== undefined && (!Number.isInteger(poolMax) || poolMax < 1)) {
  throw new Error(`DB_POOL_MAX must be a positive integer, got "${process.env.DB_POOL_MAX}"`);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(poolMax !== undefined ? { max: poolMax } : {}),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./views/ip-intel";
export * from "./anycast-seed";
