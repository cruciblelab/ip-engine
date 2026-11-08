/**
 * Side-effect-only module, imported first in index.ts for a reason that
 * can't be expressed as a plain statement in that file: ES modules run every
 * static `import` before any of the importing file's own top-level code, in
 * textual order relative to each other — so a `config()` call written
 * between two import lines in index.ts would still run after both of them,
 * including the one ("./app") that reaches @workspace/db and reads
 * DATABASE_URL at module-evaluation time. Wrapping the call in its own
 * module and importing *that* module first is what makes it actually run
 * first.
 *
 * The path is anchored to this file's own location rather than
 * process.cwd(), because every documented way of running this server in the
 * monorepo sets cwd to this package's directory, not the repo root where the
 * README says to put `.env`. `src/load-env.ts` and the built
 * `dist/index.mjs` sit at the same depth, so the same relative path reaches
 * the repo root from either.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// quiet: true — dotenv 16.4+ prints a rotating promotional "tip" line
// (third-party services, unrelated to this project) to stdout on every load
// by default. Not appropriate on a server's boot log.
config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  quiet: true,
});
