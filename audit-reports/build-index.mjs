#!/usr/bin/env node
// audit-reports/build-index.mjs
//
// Regenerates each audit area's findings.json from its markdown reports. The
// reports are the source of truth; the JSON is a derived index so an agent can
// query one area's backlog without reading every report in it.
//
//   node audit-reports/build-index.mjs
//
// ONE INDEX PER AREA. audit-reports/<area>/findings.json covers only that
// area's reports — areas are never mixed, so an agent working the roles model
// never has to filter out project-controls findings. There is deliberately no
// combined top-level index.
//
// Run it after changing any finding's Status, and commit the result alongside
// the report edit. It is deliberately dependency-free and touches nothing
// outside audit-reports/.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");

const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Pull the `- **Key:** value` lines that sit under a finding heading. */
function field(block, key) {
  const m = block.match(new RegExp(`^- \\*\\*${key}:\\*\\* (.+)$`, "m"));
  return m ? m[1].trim() : null;
}

/**
 * A location must look like a repo path — `dir/file.ext` with an optional
 * `:line` suffix. Identifiers, column names and grep patterns also live in
 * backticks on these lines, so filter rather than take everything.
 */
const PATH_RE = /^[\w./[\]()@-]+\/[\w.[\]()@-]+\.(ts|tsx|sql|mjs|js|jsx|css|json|md)(:[\d\-,+\s]+)?$/;

/**
 * Locations sit on a `- **Locations…:**` line, in the bullet list beneath it,
 * or — for a few findings — in a `**Mechanism and locations…:**` list. Scan
 * every backticked span in the block and keep the ones shaped like paths;
 * that is robust to all three layouts.
 */
function locations(block) {
  const candidates = [...block.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  return [...new Set(candidates.filter((c) => PATH_RE.test(c)).map(resolvePath))];
}

/**
 * Reports cite paths in prose by their distinctive tail —
 * `projects/[id]/page.tsx` rather than `app/(protected)/projects/[id]/page.tsx`.
 * Expand those to the real path when exactly one file matches, so every entry
 * in the index is something an agent can open directly.
 */
let REPO_FILES = null;
function repoFiles() {
  if (REPO_FILES) return REPO_FILES;
  const out = [];
  const skip = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(REPO, p));
    }
  })(REPO);
  REPO_FILES = out;
  return out;
}

function resolvePath(loc) {
  const [path, ...rest] = loc.split(":");
  const suffix = rest.length ? ":" + rest.join(":") : "";
  try {
    if (statSync(join(REPO, path)).isFile()) return loc;
  } catch { /* not a real path — fall through to suffix matching */ }
  const hits = repoFiles().filter((f) => f === path || f.endsWith("/" + path));
  return hits.length === 1 ? hits[0] + suffix : loc;
}

/**
 * Verification lines are often qualified — "CONFIRMED gap; SUSPECTED impact",
 * "(a) CONFIRMED. (b) CONFIRMED from the migration set". Normalize to the
 * leading verdict and keep the full text as a note so nothing is lost.
 */
function verification(block) {
  const raw = field(block, "Verification");
  if (!raw) return { verdict: null, note: null };
  const first = raw.match(/\b(CONFIRMED|SUSPECTED)\b/);
  const qualified = /\bSUSPECTED\b/.test(raw) && /\bCONFIRMED\b/.test(raw);
  return {
    verdict: first ? first[1] : null,
    note: qualified || raw.replace(/^(CONFIRMED|SUSPECTED)\.?$/, "") !== "" ? raw : null,
  };
}

/** First sentence of the Failure scenario, for a one-line summary. */
function summary(block) {
  const m = block.match(/\*\*Failure scenario\.\*\*\s+([\s\S]*?)(?:\n\n|$)/);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").replace(/[*`_]/g, "").trim().slice(0, 400);
}

/**
 * Parse one area folder into findings + gaps.
 *
 * `GAP-` entries stay in their own array rather than being mixed into
 * `findings`. Both are work, but they are worked differently: a finding is a
 * defect with a severity, a gap is a build spec with a verdict and a dependency
 * chain. Keeping them separate means an agent sorting findings by severity does
 * not get a feature build interleaved into its queue.
 */
function parseArea(area) {
  const dir = join(ROOT, area);
  const files = readdirSync(dir).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
  const found = [];
  const gaps = [];

  for (const file of files) {
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");

    // Split on "## ID · Title" headings; ignore other h2 sections.
    const parts = text.split(/\n## (?=[A-Z0-9]+-\d+ · )/);
    for (const part of parts.slice(1)) {
      const head = part.slice(0, part.indexOf("\n"));
      const [id, ...titleBits] = head.split(" · ");
      const block = part.slice(0, part.indexOf("\n## ") === -1 ? undefined : part.indexOf("\n## "));

      // Gaps are build specs, not defects: they carry a verdict and a dependency
      // chain instead of a severity. Kept in their own array so a severity-sorted
      // finding queue does not interleave feature builds.
      if (/^GAP-\d+$/.test(id.trim())) {
        const verdict = block.match(/\*\*Verdict:\s*([A-Z_]+)\*\*/)?.[1] ?? null;
        gaps.push({
          id: id.trim(),
          title: titleBits.join(" · ").trim(),
          kind: "gap",
          verdict,
          actionable: verdict !== "DECLINE" && verdict !== "FOLD_INTO_FINDING",
          effort: block.match(/Effort:\s*\*\*([SMLX]+)\*\*/)?.[1] ?? null,
          depends_on: (block.match(/Depends on:([^\n·]*)/)?.[1] ?? "")
            .match(/[A-Z0-9]+-\d+/g) ?? [],
          related: (block.match(/\*\*Related findings:\*\*(.+)/)?.[1] ?? "")
            .match(/[A-Z0-9]+-\d+/g) ?? [],
          report: relative(REPO, path),
        });
        continue;
      }

      const severity = field(block, "Severity");
      if (!severity) continue;

      found.push({
        id: id.trim(),
        title: titleBits.join(" · ").trim(),
        severity,
        status: field(block, "Status") ?? "OPEN",
        ...(() => {
          const v = verification(block);
          return { verification: v.verdict, verification_note: v.note };
        })(),
        blast_radius: field(block, "Blast radius"),
        related: (field(block, "Related") ?? "").match(/[A-Z0-9]+-\d+/g) ?? [],
        locations: locations(block),
        summary: summary(block),
        area,
        report: relative(REPO, path),
      });
    }
  }

  found.sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    return s !== 0 ? s : a.id.localeCompare(b.id, "en", { numeric: true });
  });
  gaps.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return { findings: found, gaps };
}

const areas = readdirSync(ROOT)
  .filter((d) => statSync(join(ROOT, d)).isDirectory())
  .sort();

for (const area of areas) {
  const { findings, gaps } = parseArea(area);

  const byStatus = {};
  const bySeverity = {};
  for (const f of findings) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  const index = {
    $comment:
      `Generated by audit-reports/build-index.mjs from the markdown reports in ` +
      `audit-reports/${area}/. Covers THIS AREA ONLY — audit areas are never ` +
      `mixed. The reports are the source of truth: edit those, then regenerate.`,
    area,
    generated_from: findings.length
      ? [...new Set(findings.map((f) => f.report))].sort()
      : [],
    totals: { findings: findings.length, gaps: gaps.length, by_severity: bySeverity, by_status: byStatus },
    status_vocabulary: ["OPEN", "IN_PROGRESS", "RESOLVED", "WONTFIX", "INVALID"],
    findings,
    gaps_note:
      "Gaps are build specs for capabilities that do not exist. They are work, " +
      "but they carry a verdict and a dependency chain rather than a severity — " +
      "check `verdict` and `depends_on` before starting one. DECLINE and " +
      "FOLD_INTO_FINDING entries are NOT to be built; their `actionable` flag is " +
      "false and the spec names what to do instead. Build order is in " +
      "99-fix-sequencing.md.",
    gaps,
  };

  writeFileSync(join(ROOT, area, "findings.json"), JSON.stringify(index, null, 2) + "\n");

  const buildable = gaps.filter((g) => g.actionable).length;
  console.log(
    `${area}/findings.json — ${findings.length} findings` +
    (gaps.length ? `, ${gaps.length} gaps (${buildable} buildable)` : ""),
  );
  console.log(`  by severity: ${JSON.stringify(bySeverity)}`);
  console.log(`  by status:   ${JSON.stringify(byStatus)}`);
}
