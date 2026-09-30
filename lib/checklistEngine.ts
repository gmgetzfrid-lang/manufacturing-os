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
//      auto never touches an item a human has decided. And the sweep
//      RETRACTS: a green that rests only on the sweep's own citation goes
//      back to needs_evidence the moment the proof is gone (QUAL-1) — a
//      human chip or note is never touched.
//      Evidence contract (SAF-1 / GAP-404): only documents the register
//      admits — Issued/Locked, with a current version, not an unapproved
//      external submission — can be cited, and every auto chip carries the
//      documentId it matched so the citation resolves to a row.
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

/** One admitted document of the project's evidence register (SAF-1). */
export interface EvidenceDocument {
  id: string;
  label: string;                     // "<number> <title>" — what firstDocMatch sees
  status: string | null;
  rev: string | null;
  viaTurnover: boolean;              // attached to an ACCEPTED turnover item (preferred)
}

export interface ProjectEvidenceState {
  turnoverAcceptedNames: string[];   // accepted turnover item names
  miChecklistComplete: boolean;      // a kind='mi' checklist completed on HUMAN sign-off (completed_basis = 'human')
  documentTitles: string[];          // project register titles+numbers (admitted documents only)
  equipmentTags: string[];           // tags known on the project's drawings
  documents?: EvidenceDocument[];    // the same register with ids, so a chip can name its row
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
  addedEvidence: Array<{ label: string; documentId?: string; source: "auto" }>;
  /** Drop every existing source:'auto' chip before appending (stale
   *  citation, or the proof is gone). Human chips are never in scope. */
  removeAutoEvidence?: true;
  /** A satisfied item lost its only (auto) proof — QUAL-1 retraction. */
  retracted?: true;
}

// ── Machine actor (DEC-35: a reserved sentinel, not a facility role) ─────
//
// The sweep and the AI assessment stamp `updated_by = NULL` and one of these
// names, so a row can always say whether a person or the machine set its
// status (QUAL-6). A human write always carries a uid and never these names.
export const MACHINE_ACTOR_SWEEP = "evidence sweep";
export const MACHINE_ACTOR_ASSESSMENT = "AI assessment";
export const isMachineActorName = (name: string | null | undefined): boolean =>
  name === MACHINE_ACTOR_SWEEP || name === MACHINE_ACTOR_ASSESSMENT;

// ── The reason bar (SAF-4 / GAP-405) ─────────────────────────────────────
//
// A decision that turns a gate green — N/A, reopen, waive, void — needs a
// typed reason: the same bar lib/checkinOutcomes.ts sets (no canned text,
// no get-out-of-jail-free cards). Checked in lib/checklists.ts and
// lib/turnover.ts (the client data layer, which says why), and ENFORCED by
// the database — quality_reason_ok() and the 20261091 rails refuse a write
// that bypasses the lib (GAP-405: not a client-side check). The prompt
// mirrors it (required + minLength). The SQL carries the same canned list
// (lib/__tests__/qualityRailsMigration.test.ts pins the two together).
export const REASON_MIN_LENGTH = 10;
export const CANNED_REASONS: ReadonlySet<string> = new Set(["decided by reviewer", "n/a", "na", "not applicable", "reason", "none", "ok"]);

/** null when the reason meets the bar, otherwise the refusal to show. */
export function reasonProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  const dense = text.replace(/\s+/g, "");
  if (dense.length === 0) return "A reason is required — this decision goes on the record.";
  if (dense.length < REASON_MIN_LENGTH) return `Say why in at least ${REASON_MIN_LENGTH} characters — the reason is the record.`;
  if (CANNED_REASONS.has(text.toLowerCase())) return "That isn't a reason — say what was decided and why.";
  return null;
}

// ── Completion basis (QUAL-2) ────────────────────────────────────────────

/** A person decided this item: a note (every human control writes one, with
 *  a reason that meets the bar) or a person-attached evidence chip. */
export const isHumanDecided = (it: Pick<ChecklistItemState, "manualNote" | "evidence">): boolean =>
  Boolean(it.manualNote) || it.evidence.some((e) => e.source === "manual");

/** A green the evidence sweep set that no person has verified yet — what a
 *  reviewer confirms ("Verify") before the completion can be citable. */
export const isAutoOnlyGreen = (it: Pick<ChecklistItemState, "status" | "applicability" | "manualNote" | "evidence">): boolean =>
  it.status === "satisfied" && it.applicability !== "na" && !isHumanDecided(it);

/** Out of scope for this job, by either column. */
const isNa = (it: Pick<ChecklistItemState, "status" | "applicability">): boolean =>
  it.applicability === "na" || it.status === "na";

/** An N/A no person gave a reason for — the AI assessment's (stamped with
 *  the machine actor, no note) or a legacy one. Every human N/A path writes
 *  a reason (updateChecklistItem; the database refuses a uid-stamped N/A
 *  without one), so a note-less N/A is not a person's decision. */
export const isUnreasonedNa = (it: Pick<ChecklistItemState, "status" | "applicability" | "manualNote">): boolean =>
  isNa(it) && !it.manualNote;

/** A green a person decided (a note, or a person-attached chip). */
export const isHumanGreen = (it: Pick<ChecklistItemState, "status" | "applicability" | "manualNote" | "evidence">): boolean =>
  it.status === "satisfied" && it.applicability !== "na" && isHumanDecided(it);

/** 'human' only when a person stands behind the whole checklist: no green
 *  rests on the evidence sweep alone, no N/A lacks a person's reason, and at
 *  least one green was decided by a person. Otherwise 'auto'. An N/A proves
 *  nothing, so a checklist the assessment N/A'd end to end — or one with no
 *  human green at all — is never citable proof (QUAL-2). Only a 'human'
 *  completion is citable by another checklist. The database computes the
 *  stored value with the SAME rule (checklist_completion_basis(), 20261091)
 *  and ignores a client-supplied one; its backfill uses it too. */
export function completionBasis(items: ChecklistItemState[]): "human" | "auto" {
  if (items.some(isAutoOnlyGreen)) return "auto";
  if (items.some(isUnreasonedNa)) return "auto";
  if (!items.some(isHumanGreen)) return "auto";
  return "human";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Keyword families the platform can vouch for. Each maps checklist phrasing
 *  to the proof the system holds. Deliberately conservative: a weak match
 *  yields needs_evidence, never a false green. */
const EVIDENCE_RULES: Array<{
  match: RegExp;
  probe: (s: ProjectEvidenceState, text: string) => string | null; // evidence label when proven
}> = [
  {
    // QUAL-2: the item's SUBJECT must match an accepted item's name — one
    // accepted sign-off never vouches for every line that says "turnover".
    match: /turnover|quality package|data book|documentation package/i,
    probe: (s, text) => acceptedTurnoverMatch(s, text),
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

/** The register row behind a `Document on file: "…"` citation, so the chip
 *  carries the documentId it matched (QUAL-1). Turnover-attached documents
 *  are listed first by the gather, so a title shared with an intake upload
 *  resolves to the accepted one. */
function documentForProof(s: ProjectEvidenceState, proof: string): EvidenceDocument | null {
  if (!s.documents) return null;
  return s.documents.find((d) => `Document on file: "${d.label}"` === proof) ?? null;
}

// Words too generic to tie a checklist line to a turnover item: a shared
// "records" or "package" proves nothing about the subject.
const GENERIC_WORDS = new Set([
  "and", "the", "for", "with", "from", "that", "this", "all", "any", "per", "are", "was",
  "records", "record", "reports", "report", "package", "packages", "turnover", "quality",
  "data", "book", "documentation", "documents", "document", "items", "item", "test", "tests",
  "sign", "off", "final", "received", "accepted", "complete", "completed", "reviewed",
]);
const subjectWords = (text: string) => new Set(norm(text).split(" ").filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)));

/** An accepted turnover item satisfies a line only when the two share a
 *  subject word ("weld", "nde", "mtr", "pressure") — never on the bare
 *  fact that something was accepted. */
function acceptedTurnoverMatch(s: ProjectEvidenceState, text: string): string | null {
  const words = subjectWords(text);
  if (words.size === 0) return null;
  for (const name of s.turnoverAcceptedNames) {
    const nameWords = subjectWords(name);
    for (const w of nameWords) {
      if (words.has(w)) return `Turnover item accepted: "${name}"`;
    }
  }
  return null;
}

/**
 * Sweep items the human hasn't decided: where the platform can PROVE the
 * evidence exists, satisfy with the citation attached; where the item looks
 * evidence-shaped but nothing is on file, mark needs_evidence (that list is
 * exactly what the coach demands next). Items matching no rule are left
 * alone — silence over guessing.
 *
 * Retraction (QUAL-1): an item at `satisfied` whose only chips are the
 * sweep's own and whose probe no longer proves it goes back to
 * needs_evidence with the stale chips removed. A stale auto chip on a still-
 * proven item is replaced by the current citation. A human chip or a human
 * note keeps the sweep out entirely (unchanged precedence).
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
    const proof = rule.probe(state, item.text);
    const autoChips = item.evidence.filter((e) => e.source === "auto");
    if (proof) {
      const already = item.evidence.some((e) => e.label === proof);
      const stale = autoChips.some((e) => e.label !== proof);
      const doc = documentForProof(state, proof);
      const chip = { label: proof, ...(doc ? { documentId: doc.id } : {}), source: "auto" as const };
      out.push({
        id: item.id,
        status: "satisfied",
        // A stale auto chip is replaced, never merely supplemented.
        addedEvidence: stale ? [chip] : already ? [] : [chip],
        ...(stale ? { removeAutoEvidence: true as const } : {}),
      });
    } else if (item.status === "open") {
      out.push({ id: item.id, status: "needs_evidence", addedEvidence: [] });
    } else if (item.status === "satisfied" && autoChips.length > 0) {
      // The green rested on the sweep alone and the proof is gone.
      out.push({ id: item.id, status: "needs_evidence", addedEvidence: [], removeAutoEvidence: true, retracted: true });
    }
  }
  return out;
}

/**
 * The completion-time evidence check (QUAL-1: a green never silently stays
 * green). Returns the ids of the greens that rest on the sweep alone and
 * whose proof is no longer current: the sweep would withdraw or re-cite
 * them now, or a chip names a document the register no longer admits (voided,
 * superseded, back to Draft, or unreadable to this caller). A person's green
 * is theirs and is not second-guessed here — its chip shows the document's
 * standing.
 */
export function staleAutoGreens(items: ChecklistItemState[], state: ProjectEvidenceState): string[] {
  const admitted = new Set((state.documents ?? []).map((d) => d.id));
  const changed = new Map(applyAutoEvidence(items, state).map((r) => [r.id, r]));
  const out: string[] = [];
  for (const it of items) {
    if (!isAutoOnlyGreen(it)) continue;
    const r = changed.get(it.id);
    const withdrawnOrReCited = Boolean(r && (r.retracted || r.removeAutoEvidence || r.status !== "satisfied"));
    const citesDropped = it.evidence.some((e) => e.source === "auto" && e.documentId && !admitted.has(e.documentId));
    if (withdrawnOrReCited || citesDropped) out.push(it.id);
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
