#!/usr/bin/env node
// scripts/thor-scan.mjs — walk a network share and write a listing the
// finder can read: path, name, size, date and (by default) a SHA-256 of
// every file, plus a triage summary. Nothing is uploaded; nothing is read by
// a model. Run it on a machine that can see the share, then paste or import
// the JSON under Documents › Graph › Drives.
//
//   node scripts/thor-scan.mjs "T:\\" --out thor.json
//   node scripts/thor-scan.mjs /mnt/thor --out thor.json --max-hash-mb 200
//   node scripts/thor-scan.mjs /mnt/thor --no-hash            (names only, fast)
//
// A hash is what lets the system say "this file on Thor IS 2002-D-2001 rev 38,
// already under control" without reading it, and "these 9,000 files are
// copies of 1,200" before anyone spends a token.

import { promises as fs, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (!root) { console.error("usage: thor-scan <root> [--out file.json] [--no-hash] [--max-hash-mb N] [--quiet]"); process.exit(2); }
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const out = opt("--out", "thor-listing.json");
const doHash = !args.includes("--no-hash");
const maxHashBytes = Number(opt("--max-hash-mb", "500")) * 1024 * 1024;
const quiet = args.includes("--quiet");

const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const files = [];
const folders = new Set();
let bytes = 0, hashed = 0, skippedHash = 0, errors = 0;

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function walk(dir, rel) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { errors++; return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { folders.add([...rel, e.name].join("/")); await walk(full, [...rel, e.name]); continue; }
    if (!e.isFile()) continue;
    if (JUNK.has(e.name.toLowerCase()) || e.name.startsWith("._")) continue;
    let st;
    try { st = await fs.stat(full); } catch { errors++; continue; }
    const row = { path: rel, name: e.name, sizeBytes: st.size, date: st.mtime.toISOString().slice(0, 10) };
    bytes += st.size;
    if (doHash && st.size > 0 && st.size <= maxHashBytes) {
      try { row.hash = await sha256(full); hashed++; } catch { errors++; }
    } else if (doHash && st.size > maxHashBytes) skippedHash++;
    files.push(row);
    if (!quiet && files.length % 500 === 0) process.stderr.write(`\r${files.length} files…`);
  }
}

const t0 = Date.now();
await walk(root, []);
if (!quiet) process.stderr.write("\n");

// ── Triage: what is here, before anyone reads a page ─────────────────────
const byHash = new Map();
for (const f of files) if (f.hash) (byHash.get(f.hash) ?? byHash.set(f.hash, []).get(f.hash)).push(f);
const dupGroups = [...byHash.values()].filter((g) => g.length > 1);
const dupFiles = dupGroups.reduce((s, g) => s + g.length - 1, 0);
const drawingLike = (n) => /\.(dwg|dxf|dgn)$/i.test(n) || /\b(pid|p&id|iso|pfd|plot|gad?)\b/i.test(n) || /^\d{2,4}[-_][A-Z]{1,3}[-_]\d{3,6}/i.test(n) || /\bsht?\s*\d{1,3}\b/i.test(n);
const copierLike = (n) => /^(scan|doc|img|image|oc|dsc|copy|untitled)[-_ ]?\d{2,}\b/i.test(n) || /^\d{8,}\.(pdf|tif|tiff|jpg)$/i.test(n);
const empty = files.filter((f) => f.sizeBytes === 0).length;
const drawings = files.filter((f) => drawingLike(f.name)).length;
const scans = files.filter((f) => copierLike(f.name)).length;
const perFolder = new Map();
for (const f of files) { const k = f.path.join("/") || "(root)"; perFolder.set(k, (perFolder.get(k) ?? 0) + 1); }
const topFolders = [...perFolder.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
const personal = [...perFolder.keys()].filter((k) => /\b[A-Z][a-z]+'?s\b|\b(my|personal|misc|temp|old|new folder)\b/i.test(k)).length;

const listing = {
  format: "thor-scan/1", root: path.resolve(root), scannedAt: new Date().toISOString(),
  stats: { files: files.length, folders: folders.size, bytes, hashed, skippedHash, errors, empty, duplicateGroups: dupGroups.length, duplicateFiles: dupFiles, drawingLike: drawings, copierLike: scans, personalFolders: personal },
  folders: [...folders], files,
};
await fs.writeFile(out, JSON.stringify(listing));
const mb = (n) => (n / 1048576).toFixed(0);
console.log(`Scanned ${files.length} files in ${folders.size} folders (${mb(bytes)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${out}`);
console.log(`  hashed ${hashed}${skippedHash ? `, skipped ${skippedHash} over the size limit` : ""}${errors ? `, ${errors} unreadable` : ""}`);
console.log(`  ${dupGroups.length} duplicate groups (${dupFiles} files are copies of another)`);
console.log(`  ${drawings} look like drawings by name · ${scans} look like copier/scanner-named files · ${empty} empty`);
console.log(`  ${personal} folders look personal/temporary`);
console.log(`  busiest folders:`); for (const [k, n] of topFolders) console.log(`    ${n}\t${k}`);
console.log(`Next: Documents › Graph › Drives › paste or import ${out}. Files whose bytes are already in the system are identified by hash.`);
