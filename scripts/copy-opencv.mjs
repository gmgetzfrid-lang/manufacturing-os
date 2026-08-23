#!/usr/bin/env node
// Copy the OpenCV.js WASM build into /public so the reconstruction worker can
// load it without a CDN and without bundling 13 MB into a route chunk.
//
// Runs as a pre-step before `next dev` and `next build`, same as the pdf.js
// worker copy alongside it.
//
// Version note: we pin 4.12.x deliberately. OpenCV 5.x renamed the modules and
// dropped AKAZE/KAZE/BRISK from the JavaScript binding whitelist, leaving only
// ORB — and AKAZE is the more robust detector when clips are matched against
// each other across a wide baseline.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const candidates = [
  "node_modules/@techstark/opencv-js/dist/opencv.js",
].map((p) => resolve(projectRoot, p));

const src = candidates.find(existsSync);
if (!src) {
  console.warn("[copy-opencv] Could not find opencv.js. Looked in:");
  candidates.forEach((p) => console.warn(`  - ${p}`));
  console.warn("[copy-opencv] Skipping — 3D reconstruction will report the dependency as missing.");
  process.exit(0);
}

const target = resolve(projectRoot, "public/vendor/opencv/opencv.js");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(src, target);
const mb = (statSync(target).size / 1048576).toFixed(1);
console.log(`[copy-opencv] Copied ${src} -> ${target} (${mb} MB)`);
