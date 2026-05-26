#!/usr/bin/env node
// Copy pdfjs-dist's worker into /public so we don't depend on a CDN.
// Runs as a pre-step before `next dev` and `next build`. CDN hosting of the
// exact pdfjs version that react-pdf bundles is unreliable (cdnjs/unpkg both
// have intermittent 404s on the .mjs build), so we serve it ourselves.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// pdfjs-dist may live under react-pdf when installed by some package managers.
const candidates = [
  "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  "node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
  "node_modules/react-pdf/node_modules/pdfjs-dist/build/pdf.worker.mjs",
].map((p) => resolve(projectRoot, p));

const src = candidates.find(existsSync);
if (!src) {
  console.warn("[copy-pdfjs-worker] Could not find pdfjs-dist worker file. Looked in:");
  candidates.forEach((p) => console.warn(`  - ${p}`));
  console.warn("[copy-pdfjs-worker] Skipping — the viewer will fall back to a CDN.");
  process.exit(0);
}

const target = resolve(projectRoot, "public/pdf.worker.min.mjs");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(src, target);
console.log(`[copy-pdfjs-worker] Copied ${src} -> ${target}`);
