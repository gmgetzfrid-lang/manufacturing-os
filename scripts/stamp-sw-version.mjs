#!/usr/bin/env node
// Stamp the deployed build id into the service worker (public-surfaces OFF-11).
//
// public/sw.js names its caches `mfgos-v<SW_SCHEMA>-<SW_BUILD>-…`. The browser
// installs a new worker only when the bytes of sw.js change, and the worker's
// activate handler drops every cache that is not its own — so a worker whose
// bytes never change across deploys never shows the update toast and keeps
// the previous build's runtime cache forever. This script writes the build id
// into the one line
//
//     const SW_BUILD = "…";
//
// at `prebuild` (package.json), from the same id /api/version serves:
//
//     VERCEL_GIT_COMMIT_SHA ?? VERCEL_DEPLOYMENT_ID
//
// (an empty value counts as unset). Only cache-name-safe characters are kept,
// at most 64 of them.
//
// Without either variable — `next dev` (predev does NOT run this), a local
// `npm run build`, the Docker image (Dockerfile / docker-compose.yml pass no
// Vercel variables) — the id is the deterministic default "unstamped", which
// is exactly what the committed file carries, so the file is left
// byte-identical: a local build never dirties the tree, and a stamped sw.js
// can never be committed (lib/__tests__/sw.test.ts pins the committed value;
// running this without a build id also restores a stamped file to it). On
// those deployments the worker's caches roll only when SW_SCHEMA is bumped —
// the pre-OFF-11 behaviour — and the in-app UpdatePill (/api/version) is the
// update path.
//
// A worker without exactly one stamp line fails the build: a deploy must
// never ship a worker that can no longer be stamped.
//
// Usage: node scripts/stamp-sw-version.mjs [path/to/sw.js]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UNSTAMPED = "unstamped";
const STAMP_LINE = /^const SW_BUILD = "[^"\n]*";$/gm;

/** The build id for this build: the Vercel commit SHA, else the Vercel
 *  deployment id, else the deterministic default. Sanitized for a cache name.
 *  @param {Record<string, string | undefined>} env
 *  @returns {string} */
export function resolveBuildId(env) {
  const raw = env.VERCEL_GIT_COMMIT_SHA || env.VERCEL_DEPLOYMENT_ID || "";
  const clean = String(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean || UNSTAMPED;
}

/** The worker source with its one SW_BUILD line set to `buildId`. Throws when
 *  the source does not carry exactly one such line.
 *  @param {string} source
 *  @param {string} buildId
 *  @returns {string} */
export function stampSource(source, buildId) {
  const found = source.match(STAMP_LINE) ?? [];
  if (found.length !== 1) {
    throw new Error(`[stamp-sw-version] expected exactly one 'const SW_BUILD = "…";' line in the service worker, found ${found.length}`);
  }
  return source.replace(STAMP_LINE, () => `const SW_BUILD = "${buildId}";`);
}

function main() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolve(process.argv[2] ?? resolve(projectRoot, "public/sw.js"));
  const buildId = resolveBuildId(process.env);
  const source = readFileSync(target, "utf8");
  const stamped = stampSource(source, buildId);
  if (stamped === source) {
    console.log(`[stamp-sw-version] ${target}: build id "${buildId}" already in place — unchanged`);
    return;
  }
  writeFileSync(target, stamped);
  console.log(`[stamp-sw-version] ${target}: stamped build id "${buildId}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
