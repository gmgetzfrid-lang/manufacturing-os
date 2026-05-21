#!/usr/bin/env node
/**
 * fix-dot-spread-corruption.mjs
 *
 * Repairs a specific class of AI/clipboard corruption where the spread operator `...`
 * is degraded into a single dot `.` in object/array literals for common patterns:
 *
 *   { id: d.id, .d.data() }                 -> { id: d.id, ...d.data() }
 *   { id: d.id, .(d.data() as any) }        -> { id: d.id, ...(d.data() as any) }
 *   { .a, status: 'submitted' }             -> { ...a, status: 'submitted' }
 *   setFiles(prev => [.prev, .Array.from])  -> setFiles(prev => [...prev, ...Array.from])
 *
 * This version is intentionally strict to avoid damaging real code.
 */

import fs from "node:fs/promises";
import path from "node:path";

const VERSION = "v2025-12-19.3";

const DEFAULT_EXTENSIONS = [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"];
const DEFAULT_EXCLUDE_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

// Never self-modify the fixer (avoids false-positive replacements inside regex/string literals).
const SELF_PATH_BASENAME = "fix-dot-spread-corruption.mjs";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    verbose: false,
    listChanges: false,
    root: process.cwd(),
    extensions: [...DEFAULT_EXTENSIONS],
    excludeDirs: new Set(DEFAULT_EXCLUDE_DIRS),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--list-changes") args.listChanges = true;
    else if (a === "--root") {
      const v = argv[i + 1];
      if (!v) throw new Error("--root requires a value");
      args.root = path.resolve(v);
      i++;
    } else if (a === "--extensions") {
      const v = argv[i + 1];
      if (!v) throw new Error("--extensions requires a value (comma-separated)");
      args.extensions = v.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--exclude-dirs") {
      const v = argv[i + 1];
      if (!v) throw new Error("--exclude-dirs requires a value (comma-separated)");
      args.excludeDirs = new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelpAndExit();
    }
  }

  return args;
}

function printHelpAndExit() {
  console.log(`
[fix-dot-spread-corruption] ${VERSION}

Usage:
  node scripts/fix-dot-spread-corruption.mjs [--dry-run] [--verbose] [--list-changes]
       [--root <path>] [--extensions ".ts,.tsx,..."] [--exclude-dirs "node_modules,.next,..."]

Flags:
  --dry-run        Do not write changes; report what would change.
  --verbose        Print scan stats and candidate list.
  --list-changes   Print the exact replacement rules that triggered per file.
  --root           Repo root to scan (default: cwd).
  --extensions     Comma-separated file extensions to include.
  --exclude-dirs   Comma-separated directory names to skip.
`);
  process.exit(0);
}

async function* walk(dir, excludeDirs) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (excludeDirs.has(e.name)) continue;
      yield* walk(p, excludeDirs);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function isCandidate(filePath, extensions) {
  const ext = path.extname(filePath).toLowerCase();
  return extensions.includes(ext);
}

function addChange(changes, rule, match) {
  changes.push({
    rule,
    match: String(match).slice(0, 220).replace(/\s+/g, " ").trim(),
  });
}

/**
 * Strict, surgical transforms only.
 * No brace-spanning regex. No pseudo-parsing of objects. Only known corruption variants.
 */
function applyTransforms(text) {
  const changes = [];
  let out = text;

  // (1) Object literal: ", .x.data()" -> ", ...x.data()"
  {
    const re = /,\s*\.\s*([A-Za-z_$][\w$]*)\.data\(\s*\)/g;
    out = out.replace(re, (m, v) => {
      addChange(changes, "object: , .x.data() -> , ...x.data()", m);
      return `, ...${v}.data()`;
    });
  }

  // (2) Object literal: ", .(x.data() as any)" -> ", ...(x.data() as any)"
  // Supports x or x.y.z before .data()
  {
    const re = /,\s*\.\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.data\(\s*\)\s+as\s+any\s*\)/g;
    out = out.replace(re, (m, v) => {
      addChange(changes, "object: , .(x.data() as any) -> , ...(x.data() as any)", m);
      return `, ...(${v}.data() as any)`;
    });
  }

  // (3) Object literal: "return { id: snap.id, .(snap.data() as any) }" variant (no comma)
  {
    const re = /{\s*([^{}]*\bid\s*:\s*[^{}]+?),\s*\.\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.data\(\s*\)\s+as\s+any\s*\)\s*}/g;
    out = out.replace(re, (m, prefix, v) => {
      addChange(changes, "object: { id: ..., .(x.data() as any) } -> { id: ..., ...(x.data() as any) }", m);
      return `{ ${prefix}, ...(${v}.data() as any) }`;
    });
  }

  // (4) Object literal: "{ .a," or "{ .a }" -> "{ ...a,"
  {
    const re = /{\s*\.\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g;
    out = out.replace(re, (m, v) => {
      addChange(changes, "object: { .x -> { ...x", m);
      return `{ ...${v}`;
    });
  }

  // (5) Array literal: "[.prev" -> "[...prev"
  {
    const re = /\[\s*\.\s*([A-Za-z_$][\w$]*)\s*(?=[,\]])/g;
    out = out.replace(re, (m, v) => {
      addChange(changes, "array: [.x -> [...x", m);
      return `[...${v}`;
    });
  }

  // (6) Array literal: ", .Array.from(" -> ", ...Array.from("
  {
    const re = /,\s*\.\s*Array\.from\s*\(/g;
    out = out.replace(re, (m) => {
      addChange(changes, "array: , .Array.from( -> , ...Array.from(", m);
      return ", ...Array.from(";
    });
  }

  // (7) Array literal: ", .prev" inside array (rare but seen) -> ", ...prev"
  {
    const re = /,\s*\.\s*([A-Za-z_$][\w$]*)\s*(?=[,\]])/g;
    out = out.replace(re, (m, v) => {
      // Avoid touching numeric literals or property access; this rule is intentionally narrow.
      // We only apply when it looks like a standalone identifier token.
      addChange(changes, "array/object: , .x -> , ...x (standalone ident)", m);
      return `, ...${v}`;
    });
  }

  // (8) Specific known composite: "prev => [.prev, .Array.from(" -> "prev => [...prev, ...Array.from("
  {
    const re = /prev\s*=>\s*\[\s*\.\s*prev\s*,\s*\.\s*Array\.from\s*\(/g;
    out = out.replace(re, (m) => {
      addChange(changes, "array composite: prev => [.prev, .Array.from( -> prev => [...prev, ...Array.from(", m);
      return "prev => [...prev, ...Array.from(";
    });
  }

  return { out, changes };
}

function findSuspiciousRemaining(text) {
  const suspects = [];

  // These are *residual corruption indicators* only. We keep them conservative.
  if (/\{\s*[^}]*,\s*\.\s*[A-Za-z_$][\w$]*\.data\(\s*\)/.test(text)) {
    suspects.push("object: , .x.data() still present");
  }
  if (/\{\s*[^}]*,\s*\.\s*\(\s*[A-Za-z_$]/.test(text)) {
    suspects.push("object: , .(expr) still present");
  }
  if (/\[\s*\.\s*[A-Za-z_$][\w$]*/.test(text)) {
    suspects.push("array: [.x still present");
  }
  if (/\bprev\s*=>\s*\[\s*\.\s*prev\b/.test(text)) {
    suspects.push("array: prev => [.prev still present");
  }

  return suspects;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[fix-dot-spread-corruption] ${VERSION}`);
  console.log(`Root: ${args.root}`);
  console.log(`Mode: ${args.dryRun ? "DRY RUN" : "APPLY"}`);
  console.log(`Verbose: ${args.verbose ? "ON" : "OFF"}`);
  console.log(`Extensions: ${args.extensions.join(", ")}`);
  console.log(`Exclude dirs: ${[...args.excludeDirs].join(", ")}`);
  console.log("");

  const candidateFiles = [];
  for await (const p of walk(args.root, args.excludeDirs)) {
    if (!isCandidate(p, args.extensions)) continue;
    if (path.basename(p) === SELF_PATH_BASENAME) continue;
    candidateFiles.push(p);
  }

  if (args.verbose) {
    console.log(`Scanned candidate files: ${candidateFiles.length}`);
    console.log(`First 15 candidates:`);
    candidateFiles.slice(0, 15).forEach((p) => console.log(` - ${path.relative(args.root, p)}`));
    console.log("");
  }

  const changed = [];
  const suspiciousAfter = [];

  for (const filePath of candidateFiles) {
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const { out, changes: fileChanges } = applyTransforms(raw);

    if (out !== raw) {
      const beforeBytes = Buffer.byteLength(raw, "utf8");
      const afterBytes = Buffer.byteLength(out, "utf8");
      changed.push({ filePath, beforeBytes, afterBytes, changes: fileChanges });

      if (!args.dryRun) {
        await fs.writeFile(filePath, out, "utf8");
      }
    }

    const suspects = findSuspiciousRemaining(out);
    if (suspects.length) suspiciousAfter.push({ filePath, suspects });
  }

  const modeLabel = args.dryRun ? "[DRY RUN]" : "[APPLY]";
  console.log(`${modeLabel} Would change: ${changed.length} file(s)`);
  if (changed.length) console.log("");

  for (const c of changed) {
    const rel = path.relative(args.root, c.filePath);
    console.log(` - ${rel} (${c.beforeBytes}B -> ${c.afterBytes}B)`);
    if (args.listChanges) {
      const uniq = [];
      for (const ch of c.changes) {
        const key = `${ch.rule} :: ${ch.match}`;
        if (!uniq.includes(key)) uniq.push(key);
      }
      uniq.slice(0, 80).forEach((u) => console.log(`    • ${u}`));
      if (uniq.length > 80) console.log(`    • … (${uniq.length - 80} more)`);
    }
  }

  console.log("");

  if (suspiciousAfter.length) {
    console.log("[WARN] Potentially suspicious dot-patterns still present after transforms:");
    suspiciousAfter.slice(0, 40).forEach((s) => {
      console.log(` - ${path.relative(args.root, s.filePath)}: ${s.suspects.join(", ")}`);
    });
    if (suspiciousAfter.length > 40) {
      console.log(` - … (${suspiciousAfter.length - 40} more)`);
    }
    console.log("");
    console.log("[NOTE] If warnings remain, they may be a new corruption variant or real code. This tool only fixes known safe variants.");
    process.exitCode = 2;
    return;
  }

  console.log("[OK] No suspicious dot-patterns detected after transforms.");
}

main().catch((e) => {
  console.error("[fix-dot-spread-corruption] fatal:", e);
  process.exitCode = 1;
});
