#!/usr/bin/env node
// Copy the OCR engine (tesseract.js's worker, its LSTM cores) and the
// English data into /public/ocr, so reading a scanned kit sheet never
// depends on a CDN (plant networks often block them). Runs before
// `next dev` and `next build`, like copy-pdfjs-worker.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "public/ocr");
const files = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng.traineddata.gz"],
];
mkdirSync(out, { recursive: true });
let missing = 0;
for (const [from, to] of files) {
  const src = resolve(root, from);
  if (!existsSync(src)) { console.warn(`[copy-ocr-files] Missing ${from}`); missing++; continue; }
  copyFileSync(src, resolve(out, to));
}
console.log(`[copy-ocr-files] ${files.length - missing} of ${files.length} copied to public/ocr${missing ? " (reading scans will say it can't)" : ""}`);
