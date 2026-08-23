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
 * or — for a few findings — in a `**Mechanism and locations…:**` list.
 *
 * Two rules, both learned from shipping the wrong thing (META-AUDIT.md MA-1):
 *
 *  1. **Block quotes are excluded.** A `> **Verifier correction.**` block often
 *     quotes the paths it is refuting — REV-9's correction lists `:96-103` in
 *     order to say that line does not exist. Harvesting from it republishes
 *     exactly the citation the verifier removed.
 *  2. **The declared Locations region wins.** Only when a finding has no
 *     Locations line do we fall back to scanning the whole body, because then
 *     prose is the only source. Scanning the body unconditionally meant a
 *     corrected Locations line was silently overridden by the stale path still
 *     sitting in the Mechanism paragraph.
 */
function locations(block) {
  const live = block
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");

  // The Locations line plus any indented bullets directly beneath it.
  const declared = live.match(
    /^- \*\*(?:Locations|Mechanism and locations)[^:]*:\*\*[^\n]*\n(?:(?:[ \t]+[-*][^\n]*|[ \t]+[^\n-][^\n]*)\n)*/m,
  );
  const scope = declared ? declared[0] : live;

  const candidates = [...scope.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
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

    // How this REPORT was verified. It is a property of the report, not of the
    // individual finding: a finding that survived an adversarial pass cleanly
    // carries no correction block, so keying off corrections mislabels exactly
    // the findings that needed no changing. See META-AUDIT.md MA-2.
    const reportMode = /NOT adversarially verified/.test(text)
      ? "unverified"
      : /survived an adversarial verification pass/.test(text)
        ? "adversarial"
        : "author";

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
        // A verifier correction can invalidate the fields above it — most
        // consequentially the cited line numbers, which several corrections
        // rewrite in prose ("every cited line number is wrong; the real anchors
        // are ..."). `locations` is scraped from the ORIGINAL Locations line and
        // is not rewritten, so an agent that trusts the index without reading
        // the body can open the wrong lines. Surface the flag so it knows to
        // read. See audit-reports/META-AUDIT.md, MA-1.
        has_verifier_correction: /^> \*\*Verifier correction\.\*\*/m.test(block),
        // How this finding's severity and claim were challenged. `adversarial`
        // = a second agent read the code and tried to refute it during the
        // original run. `hardening-pass` = re-verified against source in the
        // corpus hardening pass. `author` = checked only by whoever wrote it.
        // An agent weighting by confidence should read this, not just severity
        // (META-AUDIT.md MA-2).
        verified_by: /^- \*\*Re-verified:\*\*/m.test(block) ? "hardening-pass" : reportMode,
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

// Dot-directories are support, not audit areas — `.evidence/` holds the
// regeneration inputs. Without this filter they get an empty findings.json.
const ALL = [];

const areas = readdirSync(ROOT)
  .filter((d) => !d.startsWith(".") && statSync(join(ROOT, d)).isDirectory())
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

  ALL.push(...findings.map((f) => ({ ...f, kind: "finding" })));
  ALL.push(...gaps.map((g) => ({ ...g, area, kind: "gap" })));
}

// ── Corpus integrity gate ─────────────────────────────────────────────
//
// Every one of these checks exists because the corpus shipped the defect it
// catches (META-AUDIT.md). They run on every build and exit non-zero, because a
// check that only warns is a check nobody runs.
//
// Citations under node_modules/ and .next/ are deliberate references to
// third-party or built code and are exempt from resolution — see MA-7.
const EXEMPT_PREFIX = ["node_modules/", ".next/"];
const problems = [];

// 1. Every in-repo citation resolves, to a real file and a line inside it.
for (const f of ALL) {
  for (const loc of f.locations ?? []) {
    const [path, lineSpec] = loc.split(":");
    if (EXEMPT_PREFIX.some((p) => path.startsWith(p))) continue;
    let lines;
    try {
      lines = readFileSync(join(REPO, path), "utf8").split("\n").length;
    } catch {
      problems.push(`${f.area}/${f.id}: cites a path that does not exist — ${loc}`);
      continue;
    }
    const first = Number((lineSpec ?? "").match(/^\d+/)?.[0]);
    if (first && first > lines) {
      problems.push(`${f.area}/${f.id}: cites line ${first} of a ${lines}-line file — ${loc}`);
    }
  }
}

// 2. An ID prefix may not be reused across areas — a bare cross-reference to it
//    would be ambiguous (MA-3).
const prefixAreas = new Map();
for (const f of ALL) {
  const prefix = f.id.replace(/-\d+$/, "");
  if (prefix === "GAP") continue; // gap ids are area-scoped by construction
  if (!prefixAreas.has(prefix)) prefixAreas.set(prefix, new Set());
  prefixAreas.get(prefix).add(f.area);
}
for (const [prefix, areaSet] of prefixAreas) {
  if (areaSet.size > 1) {
    problems.push(`prefix \`${prefix}-\` is defined in ${[...areaSet].join(" and ")} — cross-references to it are ambiguous`);
  }
}

// 3. Every `Related` / `depends_on` entry names an ID that exists (MA-5).
const knownIds = new Set(ALL.map((f) => f.id));
for (const f of ALL) {
  for (const rel of [...(f.related ?? []), ...(f.depends_on ?? [])]) {
    if (!knownIds.has(rel) && !/^DEC-\d+$/.test(rel)) {
      problems.push(`${f.area}/${f.id}: references \`${rel}\`, which no area defines`);
    }
  }
}

if (problems.length) {
  console.error(`\n✗ corpus integrity: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`\n✓ corpus integrity: ${ALL.length} entries — every in-repo citation resolves, no prefix collisions, no dangling references.`);
