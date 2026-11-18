#!/usr/bin/env node
// Total-route JavaScript budget check (projects-tab PERF-12).
//
// Run AFTER `next build` (it reads the build's manifests; no network):
//
//   npm run build && npm run perf:budget
//   node scripts/perf/route-js-budget/check.mjs [--next-dir .next] [--budgets <file>] [--json] [--all]
//
// It measures every page's first-load JavaScript (rootMainFiles + the
// client-reference manifest's entryJSFiles — budget.mjs says what counts) and
// exits 1 when a route is over its budget in budgets.json, 2 when there is no
// build to read. --json prints the measurements; --all prints every route
// (the default prints the budgeted routes and the largest few).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseClientReferenceManifest, measureRoute, routeChunks, pageEntryKey, checkBudgets, budgetFor } from "./budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const nextDir = path.resolve(opt("--next-dir", ".next"));
const budgetsFile = path.resolve(opt("--budgets", path.join(here, "budgets.json")));
const asJson = args.includes("--json");
const showAll = args.includes("--all");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "page_client-reference-manifest.js") out.push(p);
  }
  return out;
}

const buildManifestPath = path.join(nextDir, "build-manifest.json");
const appDir = path.join(nextDir, "server", "app");
if (!fs.existsSync(buildManifestPath) || !fs.existsSync(appDir)) {
  console.error(`route-js-budget: no build at ${nextDir} — run \`next build\` first.`);
  process.exit(2);
}
const { rootMainFiles = [] } = JSON.parse(fs.readFileSync(buildManifestPath, "utf8"));
const sizeCache = new Map();
const sizeOf = (f) => {
  if (!sizeCache.has(f)) sizeCache.set(f, fs.statSync(path.join(nextDir, f)).size);
  return sizeCache.get(f);
};
const gzipOf = (files) => files.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(path.join(nextDir, f)), { level: 9 }).length, 0);

const measurements = [];
for (const file of walk(appDir)) {
  const manifests = parseClientReferenceManifest(fs.readFileSync(file, "utf8"));
  for (const [key, manifest] of Object.entries(manifests)) {
    if (!key.endsWith("/page")) continue;
    const m = measureRoute({ key, manifest, rootMainFiles, sizeOf });
    Object.defineProperty(m, "files", { value: routeChunks({ entryJSFiles: manifest.entryJSFiles, pageEntry: pageEntryKey(key), rootMainFiles }).files, enumerable: false });
    measurements.push(m);
  }
}
if (measurements.length === 0) {
  console.error(`route-js-budget: no page manifests under ${appDir}.`);
  process.exit(2);
}
measurements.sort((a, b) => b.totalBytes - a.totalBytes || a.route.localeCompare(b.route));

const budgets = JSON.parse(fs.readFileSync(budgetsFile, "utf8"));
const failures = checkBudgets(measurements, budgets);

if (asJson) {
  console.log(JSON.stringify({ rootMainFiles, measurements, failures }, null, 2));
} else {
  const named = budgets.routes ?? {};
  const rows = showAll ? measurements : measurements.filter((m, i) => i < 5 || m.route in named);
  const kb = (n) => (n / 1024).toFixed(1).padStart(8);
  console.log("route".padEnd(48), "total KB", "shell KB", "  own KB", "budget KB");
  for (const m of rows) {
    const b = budgetFor(m, budgets);
    console.log(m.route.padEnd(48), kb(m.totalBytes), kb(m.shellBytes), kb(m.ownBytes), kb(b));
  }
  const p = measurements.find((m) => m.route === "/projects/[id]");
  if (p) {
    console.log(`\n/projects/[id]: ${p.totalBytes} bytes in ${p.chunks} chunks (gzip ${gzipOf(p.files)}); shell ${p.shellBytes}, own ${p.ownBytes}`);
  }
  console.log(`\n${measurements.length} routes measured; ${failures.length ? `${failures.length} over budget:` : "every route is within its budget."}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failures.length ? 1 : 0);

