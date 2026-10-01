// lib/flowsRead.ts — the PFD reader's decisions, pure (no I/O).
//
// /api/flows/read does the reading, the gates and the writes; everything it
// DECIDES lives here so each decision is tested on its own:
//
//   buildRoster        which entities the model may connect (FLOW-4 / AREA-5
//                      / WIRE-6): every Site Codebook unit, then registry
//                      equipment chosen deliberately — the launching unit's
//                      first, then the unit the drawing's number decodes to,
//                      then the rest by tag — up to a budget, with the count
//                      left off said to the model and to the person
//   parseFlowReply     the model's reply as data, or a malformed reply named
//                      as such (PR-8) — never a thrown parse
//   planFlowProposals  what the reply turns into: new proposals, pairs a
//                      person already settled (confirmed, dismissed on this
//                      revision), pairs already awaiting review, a dismissal
//                      a NEW revision of the same drawing may re-propose
//                      (IEDGE-8), handles the roster never offered (counted,
//                      FLOW-11), the reader's own confidence kept as data —
//                      unknown when absent, never a default (PR-7)
//   readNote           one sentence that names every reason a read came back
//                      short (FLOW-11 / FLOW-12) instead of blaming the drawing
//   flowReadCoverage   the area checklist's deep-read count (AREA-8): of the
//                      shelf's FLOW DRAWINGS (named PFD / P&ID / block
//                      diagram … by title or folder), how many were read —
//                      data sheets, manuals and standards are not the target
//
// The grounding contract is unchanged: the model only ever sees opaque
// handles (A1, U2) the server built, and only a handle on the roster becomes
// a row, so a hallucinated vessel can never enter the topology.

/** Below this the reader's own confidence puts a proposal in the
 *  low-confidence bucket (PR-7). A number is not a source (GAP-303): nothing
 *  is ever confirmed on it — a person decides every proposal either way. */
export const LOW_CONFIDENCE = 0.5;

export type RosterKind = "asset" | "unit";
export interface RosterEntry { ref: string; kind: RosterKind; id: string; label: string }

/** Registry equipment offered to the model per read (the unit list is
 *  always whole). The same token budget as before; what changed is which
 *  equipment fills it and that the rest is counted. */
export const ROSTER_ASSET_BUDGET = 300;

/** At most this many proposals land from one read. */
export const MAX_PROPOSALS_PER_READ = 20;

export interface RosterResult {
  roster: RosterEntry[];
  assetsListed: number;
  assetsTotal: number;
  /** Registry equipment the model was not offered. */
  assetsOmitted: number;
  unitsListed: number;
  /** Of the listed equipment, how many are the launching unit's. */
  launchingUnitListed: number;
  /** The launching unit's equipment that did not fit (it exceeds the budget). */
  launchingUnitOmitted: number;
}

const byTag = (a: { tag: string; id: string }, b: { tag: string; id: string }) =>
  a.tag.localeCompare(b.tag, undefined, { numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The roster, chosen deliberately and deterministically: the same document
 *  read twice from the same unit grounds on the same roster. */
export function buildRoster(
  assets: ReadonlyArray<{ id: string; tag: string; unit_code?: string | null }>,
  units: ReadonlyArray<{ code: string; label?: string | null }>,
  opts: { unitCode?: string | null; drawingUnit?: string | null; budget?: number; total?: number } = {},
): RosterResult {
  const budget = opts.budget ?? ROSTER_ASSET_BUDGET;
  const unitCode = (opts.unitCode ?? "").trim() || null;
  const drawingUnit = (opts.drawingUnit ?? "").trim() || null;
  const sorted = [...assets].sort(byTag);
  const tier = (a: { unit_code?: string | null }) =>
    unitCode && a.unit_code === unitCode ? 0 : drawingUnit && a.unit_code === drawingUnit ? 1 : 2;
  const ordered = [...sorted].sort((a, b) => tier(a) - tier(b));
  const listed = ordered.slice(0, Math.max(0, budget));
  const roster: RosterEntry[] = [];
  listed.forEach((a, i) => roster.push({ ref: `A${i + 1}`, kind: "asset", id: a.id, label: a.tag }));
  units.forEach((u, i) => roster.push({ ref: `U${i + 1}`, kind: "unit", id: u.code, label: `${u.label || "Unit"} (unit ${u.code})` }));
  const ofUnit = unitCode ? sorted.filter((a) => a.unit_code === unitCode).length : 0;
  const ofUnitListed = unitCode ? listed.filter((a) => a.unit_code === unitCode).length : 0;
  const total = Math.max(assets.length, opts.total ?? 0);
  return {
    roster,
    assetsListed: listed.length,
    assetsTotal: total,
    assetsOmitted: total - listed.length,
    unitsListed: units.length,
    launchingUnitListed: ofUnitListed,
    launchingUnitOmitted: ofUnit - ofUnitListed,
  };
}

/** The roster as the model reads it, with the count left off said plainly. */
export function rosterPrompt(r: RosterResult, unitLabel?: string | null): string {
  const lines = r.roster.map((e) => `${e.ref} [${e.kind}] ${e.label}`).join("\n");
  const head = r.assetsOmitted > 0
    ? `ROSTER (the only entities you may connect). ${r.assetsOmitted} more registry equipment item${r.assetsOmitted === 1 ? " is" : "s are"} NOT listed${unitLabel ? ` (${unitLabel}'s equipment is listed first)` : ""} — a tag printed on the drawing that is not on this roster cannot be connected; leave it out.`
    : "ROSTER (the only entities you may connect):";
  return `${head}\n${lines}`;
}

// ── The reply ───────────────────────────────────────────────────────────────

export type ParsedReply =
  | { ok: true; flows: unknown[] }
  | { ok: false; reason: "no_json" | "malformed" };

/** The model's reply as data. `block` is the first balanced JSON span
 *  (lib/orchestrator/protocol extractJsonBlock) or null when there is none
 *  (a reply cut off at the token limit). */
export function parseFlowReply(block: string | null): ParsedReply {
  if (!block) return { ok: false, reason: "no_json" };
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return { ok: false, reason: "malformed" }; }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
  const flows = (parsed as { flows?: unknown }).flows;
  if (flows === undefined) return { ok: true, flows: [] };
  if (!Array.isArray(flows)) return { ok: false, reason: "malformed" };
  return { ok: true, flows };
}

export const MALFORMED_REPLY_MESSAGE =
  "The AI read the drawing but replied in a form that couldn't be understood, so nothing was written. The call was charged to your key — try the read again.";

// ── What the reply becomes ─────────────────────────────────────────────────

export interface PriorFlow {
  id: string;
  from_kind: string; from_ref: string; to_kind: string; to_ref: string;
  status: string;
  origin?: string | null;
  source_document_id?: string | null;
  source_version_id?: string | null;
}

export const pairKey = (fk: string, fr: string, tk: string, tr: string) => `${fk}:${fr}>${tk}:${tr}`;

/** May the reader re-propose a pair a person dismissed? Only when the
 *  dismissal judged an AI reading of THIS document at a recorded revision,
 *  and the document is now at another one (IEDGE-8). A dismissal with no
 *  recorded revision — a hand-drawn row, an upload, a row from before
 *  20261155 — sticks, as does a dismissal of another document's reading. */
export function reproposable(prior: PriorFlow, docId: string, revisionRead: string | null): boolean {
  return prior.status === "dismissed"
    && prior.origin === "ai"
    && prior.source_document_id === docId
    && !!prior.source_version_id
    && !!revisionRead
    && prior.source_version_id !== revisionRead;
}

export interface ProposalRow {
  from_kind: RosterKind; from_ref: string;
  to_kind: RosterKind; to_ref: string;
  label: string | null;
  source_page: number;
  confidence: number | null;
}

export interface ProposalPlan {
  inserts: ProposalRow[];
  repropose: Array<ProposalRow & { id: string; previousRevision: string }>;
  /** Already on the map. */
  skippedConfirmed: number;
  /** A person dismissed it (on this revision, or with no revision recorded). */
  skippedDismissed: number;
  /** Already proposed and awaiting a decision. */
  skippedPending: number;
  /** The model named a handle the roster never offered, or joined an entity to itself. */
  skippedUngrounded: number;
  /** Past the per-read ceiling. */
  skippedOverLimit: number;
  /** AI proposals below LOW_CONFIDENCE or with none given (PR-7). */
  lowConfidence: number;
  /** IEDGE-8: every pair the read found but did not propose, with why. */
  skippedPairs: SkippedPair[];
}

export type SkipReason = "confirmed" | "dismissed" | "pending" | "over_limit";
export interface SkippedPair { from: string; to: string; reason: SkipReason }

/** How a skipped pair reads to a person. */
export const SKIP_REASON_TEXT: Record<SkipReason | "duplicate", string> = {
  confirmed: "already on the map",
  dismissed: "dismissed by a person — it stands until the drawing is revised",
  pending: "already awaiting review",
  over_limit: "over the per-read limit — read again",
  duplicate: "written by someone else while this read ran",
};

/** Clamp a confidence the model gave; null when it gave none — unknown. */
export function readConfidence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

export function planFlowProposals(input: {
  flows: unknown[];
  roster: RosterEntry[];
  prior: ReadonlyArray<PriorFlow>;
  docId: string;
  revisionRead: string | null;
  /** The pages attached, in attachment order (page 1 of the reply = pages[0]). */
  pagesAttached: number[];
  max?: number;
}): ProposalPlan {
  const max = input.max ?? MAX_PROPOSALS_PER_READ;
  const byRef = new Map(input.roster.map((r) => [r.ref, r]));
  const prior = new Map(input.prior.map((p) => [pairKey(p.from_kind, p.from_ref, p.to_kind, p.to_ref), p]));
  const seen = new Set<string>();
  const plan: ProposalPlan = {
    inserts: [], repropose: [],
    skippedConfirmed: 0, skippedDismissed: 0, skippedPending: 0, skippedUngrounded: 0, skippedOverLimit: 0,
    lowConfidence: 0, skippedPairs: [],
  };
  const skip = (reason: SkipReason, from: RosterEntry, to: RosterEntry) => plan.skippedPairs.push({ from: from.label, to: to.label, reason });
  for (const raw of input.flows) {
    const f = (raw && typeof raw === "object" ? raw : {}) as { from?: unknown; to?: unknown; label?: unknown; page?: unknown; confidence?: unknown };
    const from = typeof f.from === "string" ? byRef.get(f.from) : undefined;
    const to = typeof f.to === "string" ? byRef.get(f.to) : undefined;
    if (!from || !to || from.ref === to.ref) { plan.skippedUngrounded += 1; continue; }
    const key = pairKey(from.kind, from.id, to.kind, to.id);
    if (seen.has(key)) continue; // the reply named the same pair twice
    seen.add(key);
    const pageIndex = typeof f.page === "number" && Number.isInteger(f.page) ? f.page : 1;
    const row: ProposalRow = {
      from_kind: from.kind, from_ref: from.id,
      to_kind: to.kind, to_ref: to.id,
      label: String(f.label ?? "").slice(0, 120) || null,
      source_page: input.pagesAttached[pageIndex - 1] ?? input.pagesAttached[0] ?? 1,
      confidence: readConfidence(f.confidence),
    };
    const was = prior.get(key);
    if (was) {
      if (was.status === "confirmed") { plan.skippedConfirmed += 1; skip("confirmed", from, to); continue; }
      if (was.status === "proposed") { plan.skippedPending += 1; skip("pending", from, to); continue; }
      if (!reproposable(was, input.docId, input.revisionRead)) { plan.skippedDismissed += 1; skip("dismissed", from, to); continue; }
    }
    if (plan.inserts.length + plan.repropose.length >= max) { plan.skippedOverLimit += 1; skip("over_limit", from, to); continue; }
    if (row.confidence === null || row.confidence < LOW_CONFIDENCE) plan.lowConfidence += 1;
    if (was) plan.repropose.push({ ...row, id: was.id, previousRevision: String(was.source_version_id) });
    else plan.inserts.push(row);
  }
  return plan;
}

// ── Saying what happened ────────────────────────────────────────────────────

export interface ReadOutcome {
  proposed: number;
  reproposed: number;
  skippedConfirmed: number;
  skippedDismissed: number;
  skippedPending: number;
  skippedUngrounded: number;
  skippedDuplicate: number;
  skippedOverLimit: number;
  writeFailed: number;
  pagesRead: number[];
  pagesTotal: number | null;
  pagesFailed: number[];
  pagesNotRead: number[];
  defaultPages: boolean;
  assetsOmitted: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1, 2, 3, 6" → "1–3, 6". */
export function pageList(pages: number[]): string {
  const p = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < p.length; i++) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++;
    out.push(j > i ? `${p[i]}–${p[j]}` : String(p[i]));
    i = j;
  }
  return out.join(", ");
}

/** Every reason a read came back short, named — on BOTH branches. */
export function readNote(o: ReadOutcome): string {
  const parts: string[] = [];
  const of = o.pagesTotal ? ` of ${o.pagesTotal}` : "";
  parts.push(o.pagesRead.length > 0 ? `Read page${o.pagesRead.length === 1 ? "" : "s"} ${pageList(o.pagesRead)}${of}.` : "No page could be read.");
  if (o.defaultPages && o.pagesTotal && o.pagesTotal > o.pagesRead.length + o.pagesFailed.length + o.pagesNotRead.length) {
    parts.push(`Only the first pages are read by default — enter the pages that show the flow (up to 6 per read) to read the rest.`);
  }
  if (o.pagesFailed.length > 0) parts.push(`Page${o.pagesFailed.length === 1 ? "" : "s"} ${pageList(o.pagesFailed)} could not be rendered.`);
  if (o.pagesNotRead.length > 0) parts.push(`Page${o.pagesNotRead.length === 1 ? "" : "s"} ${pageList(o.pagesNotRead)} ${o.pagesNotRead.length === 1 ? "was" : "were"} not read (past the document's end, or out of time).`);
  const landed = o.proposed;
  if (landed > 0) {
    parts.push(`${plural(landed, "flow")} proposed${o.reproposed > 0 ? ` (${o.reproposed} re-proposed because the drawing has a new revision since it was dismissed)` : ""} — review ${landed === 1 ? "it" : "them"} in the flow panel.`);
  } else {
    parts.push("No new flows were proposed.");
  }
  const skips: string[] = [];
  if (o.skippedConfirmed > 0) skips.push(`${o.skippedConfirmed} already on the map`);
  if (o.skippedPending > 0) skips.push(`${o.skippedPending} already awaiting review`);
  if (o.skippedDismissed > 0) skips.push(`${o.skippedDismissed} dismissed by a person (a dismissal stands until the drawing is revised)`);
  if (o.skippedDuplicate > 0) skips.push(`${o.skippedDuplicate} written by someone else while this read ran`);
  if (o.skippedUngrounded > 0) skips.push(`${o.skippedUngrounded} named equipment the reader was not offered`);
  if (o.skippedOverLimit > 0) skips.push(`${o.skippedOverLimit} over the ${MAX_PROPOSALS_PER_READ}-per-read limit — read again for the rest`);
  if (skips.length > 0) parts.push(`Not proposed: ${skips.join("; ")}.`);
  if (o.writeFailed > 0) parts.push(`${plural(o.writeFailed, "proposal")} could not be written.`);
  if (o.assetsOmitted > 0) {
    parts.push(`${plural(o.assetsOmitted, "registry equipment item")} ${o.assetsOmitted === 1 ? "was" : "were"} not offered to the reader (it reads ${ROSTER_ASSET_BUDGET} at a time, this area's first), so flows between ${o.assetsOmitted === 1 ? "it" : "them"} cannot be found from here.`);
  }
  return parts.join(" ");
}

// ── AREA-8: the area checklist's deep-read coverage ─────────────────────────

/** A title or folder name that says "flow drawing": a PFD / process flow
 *  diagram, a P&ID (also spelled out: "Piping & Instrumentation
 *  Diagram(s)"), a block (flow) diagram, a utility flow diagram, a
 *  flowsheet. Whole words only ("rapid" is not a PID), and a bare "PID"
 *  that names the control algorithm ("PID controller", "PID loop tuning")
 *  is not a drawing. */
const FLOW_DRAWING_WORD =
  /(?:^|[^a-z0-9])(?:p\s*&\s*ids?|p\s*and\s*ids?|pids?(?!\s*[-_]?\s*(?:controllers?|control|loops?|tuning|gains?|parameters?|settings?|algorithms?|function\s+blocks?|blocks?|faceplates?)(?:$|[^a-z0-9]))|piping\s*(?:&|and)\s*instrument(?:ation)?(?:\s+diagrams?)?|pfds?|ufds?|bfds?|process\s+flows?(?:\s+diagrams?)?|flow\s+diagrams?|flow\s*sheets?|block\s+(?:flow\s+)?diagrams?)(?=$|[^a-z0-9])/i;

/** Does any of these names (the document's own, its folder path, the drawing
 *  type its number decodes to) call it a flow drawing? */
export function namesFlowDrawing(...names: Array<string | null | undefined>): boolean {
  return names.some((n) => !!n && FLOW_DRAWING_WORD.test(n));
}

export interface FlowReadCoverage {
  /** The shelf's flow drawings: ready documents named as one (title or
   *  folder), plus any ready document already read for flows — a read is
   *  never in one count and missing from the other. */
  readable: number;
  /** Of those, how many were read for flows. */
  read: number;
  /** Ready documents on the shelf that are neither (data sheets, manuals,
   *  standards) — said, not counted: reading them for flows is not the job. */
  otherDocs: number;
}

/** AREA-8: step 3's coverage. Done means every flow drawing on the shelf was
 *  read once — the threshold a plant engineer sets for "the PFDs and P&IDs
 *  are mapped", not "every data sheet went through the paid reader". */
export function flowReadCoverage(
  ready: Array<{ id: string; name: string; folderPath?: string[]; drawingType?: string | null }>,
  readIds: ReadonlySet<string>,
): FlowReadCoverage {
  let readable = 0, read = 0, otherDocs = 0;
  for (const d of ready) {
    const wasRead = readIds.has(d.id);
    // The drawing type the document's number decodes to (the Site Codebook's
    // drawing_type label, "02" → "P&ID") is asked first; a codebook label is
    // free text, so it ADDS a drawing the title misses and never takes one
    // away from the title or folder.
    if (wasRead || namesFlowDrawing(d.drawingType, d.name, ...(d.folderPath ?? []))) {
      readable += 1;
      if (wasRead) read += 1;
    } else otherDocs += 1;
  }
  return { readable, read, otherDocs };
}
