// lib/checklistEngine.ts — checklist intelligence, pure parts.
//
// The PSSR promise: "the checklist tells the system what's needed; the
// system tells you what's missing." Three pure pieces:
//
//   1. validateSegmentedItems — turn the AI's checklist segmentation into
//      safe rows (the human reviews before anything saves).
//   2. applyAutoEvidence — given what the platform can PROVE about the
//      project (turnover accepted, MI checklist complete, documents present,
//      equipment tags known), auto-satisfy the items whose evidence exists
//      and mark the rest needs_evidence. A manual override ALWAYS wins —
//      auto never touches an item a human has decided.
//   3. The QUALITY-MANUAL RUBRIC — the ISO 9001-shaped areas a contractor's
//      manual is scored against; the AI cites findings per area, a human
//      confirms, the coverage % lands on the company profile.

export interface SegmentedItem {
  seq: number;
  section: string | null;
  text: string;
}

export function validateSegmentedItems(raw: unknown): SegmentedItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: SegmentedItem[] = [];
  for (const it of arr) {
    const r = it as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (text.length < 4 || text.length > 2000) continue;
    out.push({
      seq: out.length + 1,
      section: typeof r.section === "string" && r.section.trim() ? r.section.trim().slice(0, 200) : null,
      text,
    });
  }
  if (out.length === 0) throw new Error("No checklist items could be read from that document.");
  if (out.length > 500) throw new Error("That checklist parsed to 500+ items — split the document and try again.");
  return out;
}

// ── Auto-evidence ─────────────────────────────────────────────────────────

export interface ProjectEvidenceState {
  turnoverAcceptedNames: string[];   // accepted turnover item names
  miChecklistComplete: boolean;      // a kind='mi' checklist fully satisfied
  documentTitles: string[];          // project register titles+numbers
  equipmentTags: string[];           // tags known on the project's drawings
}

export interface ChecklistItemState {
  id: string;
  text: string;
  applicability: "applies" | "na" | "unknown";
  status: "open" | "needs_evidence" | "satisfied" | "na";
  manualNote: string | null;         // human touched it — auto keeps out
  evidence: Array<{ label: string; documentId?: string; href?: string; source: "auto" | "manual" }>;
}

export interface AutoEvidenceResult {
  id: string;
  status: "needs_evidence" | "satisfied";
  addedEvidence: Array<{ label: string; source: "auto" }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Keyword families the platform can vouch for. Each maps checklist phrasing
 *  to the proof the system holds. Deliberately conservative: a weak match
 *  yields needs_evidence, never a false green. */
const EVIDENCE_RULES: Array<{
  match: RegExp;
  probe: (s: ProjectEvidenceState) => string | null; // evidence label when proven
}> = [
  {
    match: /turnover|quality package|data book|documentation package/i,
    probe: (s) => s.turnoverAcceptedNames.length > 0
      ? `Turnover items accepted: ${s.turnoverAcceptedNames.slice(0, 3).join(", ")}${s.turnoverAcceptedNames.length > 3 ? "…" : ""}`
      : null,
  },
  {
    match: /mechanical integrity|MI review|integrity (group|manager)/i,
    probe: (s) => (s.miChecklistComplete ? "Mechanical-integrity checklist complete" : null),
  },
  {
    match: /weld map|weld log/i,
    probe: (s) => firstDocMatch(s, ["weld map", "weld log"]),
  },
  {
    // \b guards matter: bare "nde" would fire on "under", "grounded",
    // "recommended" — a false green on a PSSR is the one failure this
    // module promises never to produce.
    match: /\bnde\b|radiograph|ultrasonic|\brt \d|\but \d/i,
    probe: (s) => firstDocMatch(s, ["nde", "radiograph", "ut report", "rt report"]),
  },
  {
    match: /pressure test|hydrotest|hydro test|leak test/i,
    probe: (s) => firstDocMatch(s, ["hydrotest", "pressure test", "leak test"]),
  },
  {
    match: /material (cert|certification)|mtr|mill test/i,
    probe: (s) => firstDocMatch(s, ["mtr", "material cert", "mill test"]),
  },
  {
    match: /as.?built/i,
    probe: (s) => firstDocMatch(s, ["as-built", "as built", "asbuilt"]),
  },
  {
    match: /p&id|piping and instrument/i,
    probe: (s) => firstDocMatch(s, ["p&id", "pid"]),
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word title matching — substring matching would cite "Rapid
 *  Response Plan" as a P&ID ("pid") or "Extended Warranty" as NDE
 *  evidence. A false citation on a satisfied safety item is worse than no
 *  match at all. */
function firstDocMatch(s: ProjectEvidenceState, keys: string[]): string | null {
  const patterns = keys.map((k) => new RegExp(`\\b${escapeRe(norm(k))}\\b`));
  for (const t of s.documentTitles) {
    const n = norm(t);
    if (patterns.some((p) => p.test(n))) return `Document on file: "${t}"`;
  }
  return null;
}

/**
 * Sweep items the human hasn't decided: where the platform can PROVE the
 * evidence exists, satisfy with the citation attached; where the item looks
 * evidence-shaped but nothing is on file, mark needs_evidence (that list is
 * exactly what the coach demands next). Items matching no rule are left
 * alone — silence over guessing.
 */
export function applyAutoEvidence(
  items: ChecklistItemState[],
  state: ProjectEvidenceState,
): AutoEvidenceResult[] {
  const out: AutoEvidenceResult[] = [];
  for (const item of items) {
    if (item.manualNote) continue;                       // human decided — hands off
    if (item.applicability === "na" || item.status === "na") continue;
    if (item.status === "satisfied" && item.evidence.some((e) => e.source === "manual")) continue;
    const rule = EVIDENCE_RULES.find((r) => r.match.test(item.text));
    if (!rule) continue;
    const proof = rule.probe(state);
    if (proof) {
      const already = item.evidence.some((e) => e.label === proof);
      out.push({
        id: item.id,
        status: "satisfied",
        addedEvidence: already ? [] : [{ label: proof, source: "auto" }],
      });
    } else if (item.status === "open") {
      out.push({ id: item.id, status: "needs_evidence", addedEvidence: [] });
    }
  }
  return out;
}

// ── Quality-manual rubric ─────────────────────────────────────────────────

export interface RubricArea { key: string; label: string; hint: string }

/** ISO 9001-shaped expectations for a contractor's quality manual on
 *  mechanical work. The AI reads the manual and reports per-area findings;
 *  coverage % = covered areas / total, human-confirmed before it lands on
 *  the company profile. */
export const QUALITY_MANUAL_RUBRIC: RubricArea[] = [
  { key: "doc_control", label: "Document control", hint: "Controlled procedures, revision discipline, distribution" },
  { key: "welding", label: "Welding program", hint: "WPS/PQR, welder qualifications, continuity logs" },
  { key: "nde", label: "NDE procedures", hint: "Methods, acceptance criteria, technician certification" },
  { key: "calibration", label: "Calibration", hint: "M&TE control, calibration intervals, traceability" },
  { key: "itp", label: "Inspection & test plans", hint: "Hold/witness points, ITP execution records" },
  { key: "material", label: "Material control", hint: "MTR traceability, positive material identification" },
  { key: "ncr", label: "Nonconformance handling", hint: "NCR process, disposition, corrective action" },
  { key: "training", label: "Training & qualifications", hint: "Craft quals, safety training records" },
  { key: "records", label: "Quality records", hint: "Turnover package contents, retention" },
];

export interface RubricFinding { area: string; covered: boolean; finding: string }

export function validateRubricFindings(raw: unknown): RubricFinding[] {
  const arr = Array.isArray(raw) ? raw : [];
  const known = new Set(QUALITY_MANUAL_RUBRIC.map((a) => a.key));
  const out: RubricFinding[] = [];
  for (const f of arr) {
    const r = f as Record<string, unknown>;
    const area = typeof r.area === "string" ? r.area : "";
    if (!known.has(area)) continue;
    out.push({
      area,
      covered: r.covered === true,
      finding: typeof r.finding === "string" ? r.finding.slice(0, 500) : "",
    });
  }
  return out;
}

export function rubricCoverageScore(findings: RubricFinding[]): number {
  if (findings.length === 0) return 0;
  const byArea = new Map(findings.map((f) => [f.area, f.covered]));
  const covered = QUALITY_MANUAL_RUBRIC.filter((a) => byArea.get(a.key) === true).length;
  return Math.round((covered / QUALITY_MANUAL_RUBRIC.length) * 100);
}
