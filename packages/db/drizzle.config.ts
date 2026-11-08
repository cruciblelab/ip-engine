import { defineConfig } from "drizzle-kit";
import path from "path";

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
