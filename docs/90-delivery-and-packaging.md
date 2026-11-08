# Delivery and packaging — real bugs found while shipping zips to the phone

Split out of `DEPLOY.md` on 2026-08-07.

---

## Build bug: `apps/cli`/`apps/server` bundles were not portable

Found the hard way — a delivered zip ran fine in the sandbox that built it
and failed with `Error: Cannot find module '.../thread-stream-worker.mjs'`
the moment it was unzipped anywhere else (a different machine, a fresh
directory, even a renamed one). Root cause: `esbuild-plugin-pino` (used by
both `apps/cli/build.mjs` and `apps/server/build.mjs` to bundle pino's
worker-thread transports) writes the *build machine's* absolute `outdir`
into the bundle as a literal string, then resolves `thread-stream-worker.mjs`
/ `pino-worker.mjs` / `pino-file.mjs` / `pino-pretty.mjs` against that
hardcoded path at runtime. Works only if the built `dist/` later lives at
the exact path it was built at — which a zip handed to someone else's
machine never does.

Fixed in both `build.mjs` files with a small post-build patch: after
esbuild finishes, `dist/index.mjs` is read back and the plugin's generated
`const outputDir = "<build-machine path>";` line is replaced with
`const outputDir = globalThis.__dirname;` — the file's own runtime
location, already computed correctly by the existing banner
(`globalThis.__dirname = path.dirname(fileURLToPath(import.meta.url))`).
The worker files always ship next to `index.mjs`, so resolving against
wherever the bundle *actually is* at runtime is correct regardless of
machine or directory.

**Verified**: built `apps/cli` and `apps/server`, copied each `dist/` to
an unrelated path (`/tmp/portability-test*`, nothing shared with the build
location), ran `node .../dist/index.mjs lookup 8.8.8.8` from there against
a real database — correct output, no MODULE_NOT_FOUND. This is also almost
certainly why the *previous* delivered zip failed the same way on the
founder's phone; that zip predates this fix.

## Two more real gaps surfaced by this delivery, worth recording

**`ip-insight` was never actually a runnable global command.** `apps/cli`
declares `"bin": { "ip-insight": "./dist/index.mjs" }`, but pnpm only links
a package's `bin` into `node_modules/.bin` for packages something else in
the workspace *depends on* — nothing does, `apps/cli` exists to be run
directly, not imported. So `pnpm install` never created the symlink, and
neither bare `ip-insight ...` nor `pnpm --filter @workspace/cli exec
ip-insight ...` (same missing link) ever worked, on this phone or in any
fresh install. The actually-correct invocation is direct:
`node apps/cli/dist/index.mjs <command>`, or a shell alias pointed at that
same path (`alias ip-insight="node ~/ip-engine/apps/cli/dist/index.mjs"`
in `~/.bashrc`) — README's own command list has always silently assumed
one of these without saying so.

**A fresh unzip's schema can be behind the code even with no schema
changes in that particular delivery.** This project has no migration
files — `packages/db/drizzle.config.ts` uses `drizzle-kit push`
(schema diff + apply), so "did I remember to push after the *last* schema
change that landed, however long ago" is what determines whether a given
database is current, not "did this delivery add a migration." Confirmed on
the phone this delivery: `ops.mmdb_publishes.field_counts` (added well
before this session, see above) was missing on a database that had gone
untouched for a long stretch, breaking `mmdb-publish.integration.test.ts`
with `column "field_counts" of relation "mmdb_publishes" does not exist`
until `pnpm --filter @workspace/db push` was run. Rule of thumb for every
future delivery, not just ones that touch `packages/db/src/schema`: run
`pnpm --filter @workspace/db push` once after unzipping, before assuming
the database is current — it's a fast, safe no-op when nothing changed,
and confirming "add column" prompts (never a DROP/RENAME without checking
first — see the Task #57-adjacent warning already given in this session)
is cheap insurance against exactly this failure mode.
