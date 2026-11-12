import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

// The CLI reads DATABASE_URL from the repo-root .env (apps/cli/src/index.ts);
// `push` used to read it only from the shell. With the address only in .env,
// push failed with the error below — easy to miss in a long setup — and
// the schema stayed old. That is how a phone database kept the pre-2026-11-08
// (network, asn) unique index and lost its BGP data on the RouteViews switch.
// A shell-exported value still wins, same precedence as the CLI.
if (!process.env.DATABASE_URL) {
  const envFile = path.join(__dirname, "../../.env");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/m);
    if (m?.[1]) process.env.DATABASE_URL = m[1].replace(/^(['"])(.*)\1$/, "$2");
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // Without this, drizzle-kit manages only `public` and silently ignores
  // every table in `ops` — `push` reports "changes applied" against a fresh
  // database while creating none of the job/source/backup tables, and the
  // first `collect` then fails on a missing relation. The default is
  // ["public"]; both schemas this project defines have to be listed.
  schemaFilter: ["public", "ops"],
  // ip_intel (and its transient ip_intel_building staging copy) is created
  // by the `flatten` command via raw SQL, not by a drizzle schema
  // definition — without this exclusion, push introspects it as an
  // unrecognized object and offers to DROP it, which for a materialized
  // view can mean discarding hours of real rebuild work.
  tablesFilter: ["!ip_intel*"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
