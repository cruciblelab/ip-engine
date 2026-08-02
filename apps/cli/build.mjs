import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, chmod } from "node:fs/promises";

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

  // Executable bit so `./dist/index.mjs` and the `bin` symlink both work
  // directly, matching how `npm link` / a global install would invoke it.
  await chmod(path.resolve(distDir, "index.mjs"), 0o755);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
