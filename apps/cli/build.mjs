import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, chmod, readFile, writeFile } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external: ["*.node", "pg-native"],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      // No shebang here: esbuild already preserves src/index.ts's own
      // `#!/usr/bin/env node` at the very top of the bundle. Adding a
      // second one here would make a `#!` appear mid-file, which isn't
      // valid JS anywhere but line 1.
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // esbuild-plugin-pino bakes the *build machine's* absolute `outdir` into
  // the bundle as a literal string, to find pino's worker-thread files
  // (thread-stream-worker.mjs etc.) at runtime. That only works if the
  // package is later run from that exact path — moving `dist/` anywhere
  // else (a different machine, a fresh unzip, even a renamed folder) makes
  // every worker-spawning log call fail with MODULE_NOT_FOUND, since the
  // hardcoded path no longer exists. The banner above already computes
  // `globalThis.__dirname` from `import.meta.url` — the file's *actual*
  // location wherever it's run from — so swapping the plugin's baked-in
  // path for that makes the worker lookup portable, since the worker
  // files always sit next to index.mjs regardless of where dist/ lives.
  const indexPath = path.resolve(distDir, "index.mjs");
  const built = await readFile(indexPath, "utf8");
  const patched = built.replace(
    /const outputDir = "[^"]*";/,
    "const outputDir = globalThis.__dirname;",
  );
  if (patched === built) {
    throw new Error(
      "esbuild-plugin-pino's hardcoded outputDir pattern wasn't found in the build output — " +
        "the plugin's generated code shape may have changed; update this replacement in build.mjs.",
    );
  }
  await writeFile(indexPath, patched);

  // Executable bit so `./dist/index.mjs` and the `bin` symlink both work
  // directly, matching how `npm link` / a global install would invoke it.
  await chmod(path.resolve(distDir, "index.mjs"), 0o755);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
