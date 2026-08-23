#!/usr/bin/env node
// Bundle the 3D reconstruction Web Worker into /public.
//
// Why this exists rather than `new Worker(new URL("./x.worker.ts", import.meta.url))`:
// Turbopack (the default bundler in Next 16) does not compile that form — it
// emits the .ts file verbatim as a static asset, and the browser then fails to
// parse TypeScript. Bundling the worker ourselves is explicit, produces a real
// ES module, and matches how the pdf.js worker and OpenCV build are already
// staged into public/.
//
// Pass --watch during development to rebuild on change.

import { build, context } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const entry = resolve(projectRoot, "lib/recon/workers/recon.worker.ts");
const outfile = resolve(projectRoot, "public/workers/recon.worker.js");
mkdirSync(dirname(outfile), { recursive: true });

const watch = process.argv.includes("--watch");
const dev = watch || process.env.NODE_ENV === "development";

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  // IIFE, not ESM: a *classic* worker is what makes importScripts available,
  // which is how the 10 MB OpenCV.js build is loaded at runtime instead of
  // being fetched and eval'd through new Function.
  format: "iife",
  platform: "browser",
  target: ["chrome120", "edge120", "firefox121", "safari17"],
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  legalComments: "none",
  logLevel: "warning",
  // OpenCV.js is fetched at runtime from public/vendor, never bundled — it is
  // ~10 MB and only needed once the user actually starts a reconstruction.
  external: [],
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`[recon-worker] watching ${entry}`);
} else {
  const result = await build(options);
  if (result.errors.length) process.exit(1);
  console.log(`[recon-worker] Bundled -> ${outfile}`);
}
