// lib/checklists.ts — checklist data layer (PSSR / MI / QA-QC / custom).
//
// The flow honors one rule end to end: THE HUMAN SAVES, THE AI PROPOSES.
// The segment route reads the checklist document and returns proposed items
// — nothing persists until the reviewer clicks save (createChecklist). The
// assess route proposes applicability per item — applyAssessment writes ONLY
// the proposals a person ticked one by one (SAF-2), never over a human's
// override (a note or a person-attached chip marks human territory) and
// never a downgrade of an
// item that is satisfied or carries evidence (QUAL-5). runAutoEvidence is
// the deterministic sweep: what the platform can PROVE (accepted turnover
// matching the line's subject, an MI checklist completed on human sign-off,
// admitted documents on file) turns green with the citation — documentId
// attached — and what it can no longer prove is RETRACTED (QUAL-1); what it
// can't prove turns needs_evidence, which is exactly the list the project
// coach feeds back to the user.
//
// Every decision write goes through lib/checkedWrite.ts (GAP-402): a write
// row-level security filters to zero rows is a refusal, not a success, and
// the audit row is written only after a confirmed match. The machine paths
// stamp a reserved actor (DEC-35: updated_by NULL + a sentinel name), so a
// row always says whether a person or the machine set its status (QUAL-6).
// The reason bar, the completion gate and the completion basis are checked
// here AND enforced by the database (20261091): a write that bypasses this
// file meets the same rules there — a machine-stamped write is held to what
// that machine writes (a sentinel name, never on a person's item, its own
// columns only, a sweep green's citation resolving to its row), a person's
// write is stamped with the caller, a decision needs its own reason, an item
// is never deleted on its own, item writes serialise with the completion,
// and a completed checklist's items are frozen until it is reopened.

import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import { checkedWrite, describeWriteError } from "@/lib/checkedWrite";
import {
  applyAutoEvidence,
  completionBasis,
  isBlockingItem,
  isHumanTerritory,
  normalizeEvidence,
  MACHINE_ACTOR_ASSESSMENT,
  MACHINE_ACTOR_SWEEP,
  reasonKey,
  reasonProblem,
  staleAutoGreens,
  type ChecklistItemState,
  type EvidenceChip,
  type EvidenceDocument,
  type ProjectEvidenceState,
  type SegmentedItem,
} from "@/lib/checklistEngine";

export type ChecklistKind = "pssr" | "mi" | "qaqc" | "custom";

export const CHECKLIST_KIND_LABEL: Record<ChecklistKind, string> = {
  pssr: "PSSR — pre-startup safety review",
  mi: "Mechanical integrity",
  qaqc: "QA/QC",
  custom: "Custom",
};

export interface Checklist {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  kind: ChecklistKind;
  sourceDocumentId: string | null;
  status: "open" | "complete" | "void";
  /** QUAL-2: what the completion rested on — only 'human' is citable. */
  completedBasis: "human" | "auto" | null;
  createdAt: string | null;
  createdByName: string | null;
}

export interface ChecklistItem {
  id: string;
  checklistId: string;
  seq: number;
  section: string | null;
  text: string;
  applicability: "applies" | "na" | "unknown";
  status: "open" | "needs_evidence" | "satisfied" | "na";
  evidence: EvidenceChip[];
  aiRationale: string | null;
  manualNote: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
}

/** Documents the evidence register admits (SAF-1): Issued or Locked, with a
 *  current version. NOT_CURRENT_STATUSES (Superseded / Void / Archived) and
 *  Draft are out — a Draft title is a label, not evidence. */
export const EVIDENCE_DOCUMENT_STATUSES: ReadonlyArray<string> = ["Issued", "Locked"];

/** Item writes run at most this many at a time — each is its own checked,
 *  updated_at-guarded single-row request, so a 300-item assessment is 300
 *  requests in six concurrent waves (≈ the wall-clock of six round trips),
 *  not 300 sequential ones (PERF-7). */
export const WRITE_BATCH = 50;

function mapChecklist(r: Record<string, unknown>): Checklist {
  const basis = r.completed_basis;
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    title: String(r.title ?? ""),
    kind: (r.kind as ChecklistKind) ?? "custom",
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    status: (r.status as Checklist["status"]) ?? "open",
    completedBasis: basis === "human" || basis === "auto" ? basis : null,
    createdAt: (r.created_at as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
  };
}

function mapItem(r: Record<string, unknown>): ChecklistItem {
  return {
    id: String(r.id),
    checklistId: String(r.checklist_id),
    seq: Number(r.seq ?? 0),
    section: (r.section as string | null) ?? null,
    text: String(r.text ?? ""),
    applicability: (r.applicability as ChecklistItem["applicability"]) ?? "unknown",
    status: (r.status as ChecklistItem["status"]) ?? "open",
    evidence: normalizeEvidence(r.evidence),
    aiRationale: (r.ai_rationale as string | null) ?? null,
    manualNote: (r.manual_note as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedByName: (r.updated_by_name as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "project", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

// ── Reads (UX-10 / QUAL-8: a failed read is an error, never an empty list) ──

/** The checklist headers, or a thrown error the caller can render as
 *  "failed to load" — an RLS denial or a missing migration is never an
 *  empty state. */
export async function listChecklists(orgId: string, projectId: string): Promise<Checklist[]> {
  const { data, error } = await supabase.from("project_checklists").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(describeWriteError(error));
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapChecklist);
}

/** The items with the read's outcome made explicit — the completion gate
 *  reads THIS so a failed read blocks completion instead of passing it. */
export async function readChecklistItems(checklistId: string): Promise<{ rows: ChecklistItem[]; error: string | null }> {
  const { data, error } = await supabase.from("checklist_items").select("*")
    .eq("checklist_id", checklistId).order("seq", { ascending: true }).limit(600);
  if (error) return { rows: [], error: describeWriteError(error) };
  return { rows: (((data ?? []) as Array<Record<string, unknown>>)).map(mapItem), error: null };
}

export async function listChecklistItems(checklistId: string): Promise<ChecklistItem[]> {
  const r = await readChecklistItems(checklistId);
  if (r.error) throw new Error(r.error);
  return r.rows;
}

/** Persist a reviewed segmentation — the human clicked save on the item
 *  list the AI proposed (or typed one by hand; same door). */
export async function createChecklist(input: {
  orgId: string; projectId: string;
  title: string; kind: ChecklistKind;
  sourceDocumentId?: string | null;
  items: SegmentedItem[];
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; checklistId?: string }> {
  if (!input.title.trim()) return { ok: false, error: "Give the checklist a title." };
  if (input.items.length === 0) return { ok: false, error: "A checklist needs at least one item." };

  const { data, error } = await supabase.from("project_checklists").insert({
    org_id: input.orgId, project_id: input.projectId,
    title: input.title.trim(), kind: input.kind,
    source_document_id: input.sourceDocumentId ?? null,
    created_by: input.actor.uid,
    created_by_name: input.actor.email?.split("@")[0] ?? null,
  }).select("id, org_id").single();
  if (error || !data) return { ok: false, error: error ? describeWriteError(error) : "Couldn't create the checklist." };
  const checklistId = String(data.id);
  // QUAL-12: the items' org is the HEADER's org, not the caller's argument.
  const orgId = String((data as { org_id?: unknown }).org_id ?? input.orgId);

  const rows = input.items.map((it) => ({
    org_id: orgId, checklist_id: checklistId,
    seq: it.seq, section: it.section, text: it.text,
  }));
  const ins = await checkedWrite(supabase.from("checklist_items").insert(rows).select("id"));
  if (!ins.ok) {
    // Half a checklist is worse than none — take the header back out.
    await checkedWrite(supabase.from("project_checklists").delete().eq("id", checklistId).select("id"));
    return { ok: false, error: `Couldn't save the items: ${ins.error}` };
  }

  await audit("CHECKLIST_CREATED", orgId, input.projectId, input.actor, {
    checklistId, title: input.title.trim(), kind: input.kind, items: input.items.length,
  });
  return { ok: true, checklistId };
}

// ── Batched, checked, optimistic item writes ─────────────────────────────

interface ItemWrite { item: ChecklistItem; patch: Record<string, unknown> }

/** Write each patch as a checked UPDATE guarded on the row's updated_at as
 *  read (optimistic concurrency): a row someone else changed in between is
 *  a refusal, never a lost chip. Batches of WRITE_BATCH run in parallel. */
async function writeItemPatches(writes: ItemWrite[]): Promise<{ landed: string[]; refused: string[]; failed: Array<{ id: string; error: string }> }> {
  const landed: string[] = [], refused: string[] = [], failed: Array<{ id: string; error: string }> = [];
  for (let i = 0; i < writes.length; i += WRITE_BATCH) {
    const batch = writes.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(batch.map(async (w) => ({
      id: w.item.id,
      res: await checkedWrite((w.item.updatedAt
        ? supabase.from("checklist_items").update(w.patch).eq("id", w.item.id).eq("updated_at", w.item.updatedAt)
        : supabase.from("checklist_items").update(w.patch).eq("id", w.item.id).is("updated_at", null)
      ).select("id")),
    })));
    for (const { id, res } of results) {
      if (res.ok) landed.push(id);
      else if (res.code === "refused") refused.push(id);
      else failed.push({ id, error: res.error });
    }
  }
  return { landed, refused, failed };
}

// ── The AI assessment ────────────────────────────────────────────────────

export interface AssessmentProposal {
  itemId: string;
  applicability: "applies" | "na" | "unknown";
  rationale: string;
}

/** True when the assessment may not move this item to N/A on its own: it is
 *  satisfied, or something is attached (QUAL-5). The person who wants it N/A
 *  uses the item's own control, with a reason. */
export const isProtectedFromDowngrade = (item: Pick<ChecklistItem, "status" | "evidence">): boolean =>
  item.status === "satisfied" || item.evidence.length > 0;

export interface AssessmentOutcome {
  applied: number;
  skippedHuman: number;
  /** N/A proposals on satisfied / evidence-bearing items — refused (QUAL-5). */
  skippedProtected: number;
  /** Proposals the reviewer did not tick (SAF-2). */
  skippedUnconfirmed: number;
  refused: number;
  failed: number;
  error?: string;
}

/** Write the AI's applicability proposals a person ticked — per item, never
 *  by count (SAF-2 / GAP-404): a call with no confirmed ids writes nothing.
 *  Skips any item in human territory (a note, or a person-attached chip —
 *  the database refuses a machine-stamped write there), and never
 *  downgrades a satisfied or evidence-bearing item to N/A (QUAL-5).
 *  Rationale rides along so every verdict can show its reasoning. The
 *  audit row names every item written with its prior and new state. */
export async function applyAssessment(input: {
  orgId: string; projectId: string; checklistId: string;
  proposals: AssessmentProposal[];
  /** The item ids the reviewer ticked in the per-item review. */
  confirmedItemIds: string[];
  actor: Actor;
}): Promise<AssessmentOutcome> {
  const read = await readChecklistItems(input.checklistId);
  if (read.error) {
    return { applied: 0, skippedHuman: 0, skippedProtected: 0, skippedUnconfirmed: 0, refused: 0, failed: 0, error: read.error };
  }
  const byId = new Map(read.rows.map((i) => [i.id, i]));
  const confirmed = new Set(input.confirmedItemIds);
  let skippedHuman = 0, skippedProtected = 0, skippedUnconfirmed = 0;
  const writes: ItemWrite[] = [];
  const changes: Array<{ itemId: string; from: { applicability: string; status: string }; to: { applicability: string; status: string } }> = [];
  for (const p of input.proposals) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    if (!confirmed.has(p.itemId)) { skippedUnconfirmed += 1; continue; }
    if (isHumanTerritory(item)) { skippedHuman += 1; continue; }
    if (p.applicability === "na" && isProtectedFromDowngrade(item)) { skippedProtected += 1; continue; }
    const patch: Record<string, unknown> = {
      applicability: p.applicability,
      ai_rationale: p.rationale.slice(0, 1000) || null,
      updated_at: new Date().toISOString(),
      updated_by: null,
      updated_by_name: MACHINE_ACTOR_ASSESSMENT,
    };
    let status: ChecklistItem["status"] = item.status;
    if (p.applicability === "na" && item.status !== "na") status = "na";
    if (p.applicability === "applies" && item.status === "na") status = "open";
    if (status !== item.status) patch.status = status;
    writes.push({ item, patch });
    changes.push({ itemId: item.id, from: { applicability: item.applicability, status: item.status }, to: { applicability: p.applicability, status } });
  }
  if (writes.length === 0) {
    return { applied: 0, skippedHuman, skippedProtected, skippedUnconfirmed, refused: 0, failed: 0 };
  }
  const w = await writeItemPatches(writes);
  const landedSet = new Set(w.landed);
  if (w.landed.length > 0) {
    await audit("CHECKLIST_ASSESSED", input.orgId, input.projectId, input.actor, {
      checklistId: input.checklistId, applied: w.landed.length, skippedHuman, skippedProtected, skippedUnconfirmed,
      refused: w.refused.length, failed: w.failed.length,
      items: changes.filter((c) => landedSet.has(c.itemId)),
    });
  }
  const error = w.failed.length > 0 ? w.failed[0].error
    : w.refused.length > 0 ? `${w.refused.length} item${w.refused.length === 1 ? "" : "s"} could not be written — no permission, or changed by someone else. Reload and try again.`
    : undefined;
  return { applied: w.landed.length, skippedHuman, skippedProtected, skippedUnconfirmed, refused: w.refused.length, failed: w.failed.length, ...(error ? { error } : {}) };
}

// ── Human override ───────────────────────────────────────────────────────

/** Human override on one item — status, applicability, note, or manually
 *  attached evidence. A status or applicability change REQUIRES a reason of
 *  its own that meets the bar (SAF-4 / GAP-405: no placeholder is ever
 *  invented, and the note already on the item belongs to the earlier
 *  decision); a note is set or replaced only with one that meets the bar and
 *  is never cleared. The database refuses the same writes (20261091). The
 *  note marks the item human-decided and every automated pass keeps its hands
 *  off from then on. Refused writes surface and audit nothing. */
export async function updateChecklistItem(input: {
  orgId: string; projectId: string;
  item: ChecklistItem;
  patch: {
    applicability?: ChecklistItem["applicability"];
    status?: ChecklistItem["status"];
    manualNote?: string | null;
    addEvidence?: { label: string; documentId?: string; href?: string };
  };
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const decides = input.patch.applicability !== undefined || input.patch.status !== undefined;
  if (decides || input.patch.manualNote !== undefined) {
    const problem = reasonProblem(input.patch.manualNote);
    if (problem) return { ok: false, error: problem };
  }
  if (decides && reasonKey(input.patch.manualNote) === reasonKey(input.item.manualNote)) {
    return { ok: false, error: "Give this decision its own reason — the note on the item is the earlier decision's." };
  }
  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: input.actor.uid,
    updated_by_name: input.actor.email?.split("@")[0] ?? null,
  };
  if (input.patch.applicability !== undefined) row.applicability = input.patch.applicability;
  if (input.patch.status !== undefined) row.status = input.patch.status;
  if (input.patch.manualNote !== undefined) row.manual_note = input.patch.manualNote?.trim() || null;
  if (input.patch.addEvidence) {
    row.evidence = [...input.item.evidence, { ...input.patch.addEvidence, source: "manual" as const }];
  }
  const w = await checkedWrite(supabase.from("checklist_items").update(row).eq("id", input.item.id).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  await audit("CHECKLIST_ITEM_UPDATED", input.orgId, input.projectId, input.actor, {
    checklistId: input.item.checklistId, itemId: input.item.id,
    from: { applicability: input.item.applicability, status: input.item.status },
    patch: {
      applicability: input.patch.applicability, status: input.patch.status,
      note: input.patch.manualNote ? true : undefined, evidence: input.patch.addEvidence?.label,
    },
  });
  return { ok: true };
}

// ── Completion ───────────────────────────────────────────────────────────

/** Mark a checklist complete / open / void. Completion is gated on the
 *  items — and the gate FAILS CLOSED (QUAL-8): a failed item read or an
 *  empty checklist refuses; the database's completion rail refuses an empty
 *  or unfinished checklist too (20261091), and freezes a completed
 *  checklist's items until it is reopened here with status 'open'. The evidence is re-checked at the moment it
 *  matters (QUAL-1): a green resting on the sweep alone whose document has
 *  since left the register refuses the completion until the evidence check
 *  runs. What the completion rested on (QUAL-2, completed_basis) is the
 *  DATABASE's to record — its rail computes it with completionBasis()'s rule
 *  and ignores a client value — so this write sends the status only (and
 *  works before 20261091, when no basis exists and nothing cites one); the
 *  stored basis is read back for the caller and the audit row. */
export async function setChecklistStatus(input: {
  orgId: string; projectId: string; checklist: Checklist;
  status: "open" | "complete" | "void"; actor: Actor;
}): Promise<{ ok: boolean; error?: string; basis?: "human" | "auto" }> {
  let basis: "human" | "auto" | undefined;
  if (input.status === "complete") {
    const read = await readChecklistItems(input.checklist.id);
    if (read.error) return { ok: false, error: `Couldn't verify the items, so the checklist stays open: ${read.error}` };
    const items = read.rows;
    if (items.length === 0) return { ok: false, error: "This checklist has no items — nothing was verified, so it cannot be completed." };
    const blocking = items.filter(isBlockingItem);   // the database's completion rail refuses the same
    if (blocking.length > 0) {
      return { ok: false, error: `${blocking.length} item${blocking.length === 1 ? " is" : "s are"} not satisfied yet — a checklist only completes when every applicable item is green or N/A.` };
    }
    const states = items.map(toState);
    const stale = staleAutoGreens(states, await gatherProjectEvidenceState(input.orgId, input.projectId));
    if (stale.length > 0) {
      return { ok: false, error: `${stale.length} green item${stale.length === 1 ? " rests" : "s rest"} on a document that is no longer current (voided, superseded, back to Draft, or no longer readable) — run "Check evidence we already hold" first. The checklist stays open.` };
    }
    basis = completionBasis(states);
  }
  const w = await checkedWrite(supabase.from("project_checklists").update({ status: input.status }).eq("id", input.checklist.id).select("id"));
  if (!w.ok) return { ok: false, error: w.error };
  if (basis) {
    // The stored value is the database's (same rule); before 20261091 there
    // is no column and the lib's reading stands in for the audit row.
    const back = await supabase.from("project_checklists").select("*").eq("id", input.checklist.id).maybeSingle();
    const stored = (back.data as { completed_basis?: unknown } | null)?.completed_basis;
    if (stored === "human" || stored === "auto") basis = stored;
  }
  await audit("CHECKLIST_STATUS", input.orgId, input.projectId, input.actor, {
    checklistId: input.checklist.id, status: input.status, title: input.checklist.title,
    ...(basis ? { completedBasis: basis } : {}),
  });
  return { ok: true, ...(basis ? { basis } : {}) };
}

const toState = (i: ChecklistItem): ChecklistItemState => ({
  id: i.id, text: i.text, applicability: i.applicability, status: i.status,
  manualNote: i.manualNote, evidence: i.evidence,
});

// ── Evidence gathering + the deterministic sweep ─────────────────────────

/** Everything the platform can currently PROVE about a project, for the
 *  auto-evidence pass. Every gather is fault-tolerant: a missing table
 *  (pre-migration) contributes nothing rather than failing the sweep —
 *  the tolerance fails CLOSED (an empty register proves nothing).
 *
 *  The evidence contract (SAF-1 / QUAL-13): the register admits only
 *  Issued/Locked documents with a current version, excludes a document
 *  whose CURRENT version is an external (intake) submission that was never
 *  approved, and lists the documents attached to ACCEPTED turnover items
 *  first so they are the citation of choice over raw intake-folder titles. */
export async function gatherProjectEvidenceState(orgId: string, projectId: string): Promise<ProjectEvidenceState> {
  const safe = async <T>(p: PromiseLike<T>, fallback: T): Promise<T> => {
    try { return await p; } catch { return fallback; }
  };

  const [turnover, checklists, project] = await Promise.all([
    safe(supabase.from("turnover_items").select("id, name, status, document_id").eq("project_id", projectId).limit(300)
      .then((r) => (r.data ?? []) as Array<{ id: string; name: string; status: string; document_id: string | null }>), []),
    safe(supabase.from("project_checklists").select("id, kind, status, completed_basis").eq("project_id", projectId).limit(50)
      .then((r) => (r.data ?? []) as Array<{ id: string; kind: string; status: string; completed_basis: string | null }>), []),
    safe(supabase.from("projects").select("intake_collection_id, sow_document_id").eq("id", projectId).maybeSingle()
      .then((r) => r.data as { intake_collection_id?: string | null; sow_document_id?: string | null } | null), null),
  ]);

  type DocRow = { id: string; title: string | null; name: string | null; document_number: string | null; status: string | null; rev: string | null; current_version_id: string | null };
  const admitted = (d: DocRow) =>
    Boolean(d.current_version_id) && EVIDENCE_DOCUMENT_STATUSES.includes(d.status ?? "") && !NOT_CURRENT_STATUSES.has(d.status ?? "");
  const label = (d: DocRow) => [d.document_number, d.title ?? d.name].filter(Boolean).join(" ");

  // Documents attached to ACCEPTED turnover items — the curated channel.
  const acceptedDocIds = [...new Set(turnover.filter((t) => t.status === "accepted" && t.document_id).map((t) => String(t.document_id)))];
  const documents: EvidenceDocument[] = [];
  const seen = new Set<string>();
  const currentVersionOf = new Map<string, string>();   // document id → current_version_id
  const admit = (rows: DocRow[], viaTurnover: boolean) => {
    for (const d of rows) {
      if (!admitted(d) || seen.has(d.id)) continue;
      const l = label(d);
      if (!l) continue;
      seen.add(d.id);
      currentVersionOf.set(String(d.id), String(d.current_version_id));
      documents.push({ id: String(d.id), label: l, status: d.status, rev: d.rev, viaTurnover });
    }
  };
  const fetchDocs = (q: PromiseLike<{ data: unknown }>) =>
    safe(q.then((r) => (r.data ?? []) as DocRow[]), [] as DocRow[]);
  const DOC_COLS = "id, title, name, document_number, status, rev, current_version_id";

  if (acceptedDocIds.length > 0) {
    admit(await fetchDocs(supabase.from("documents").select(DOC_COLS).in("id", acceptedDocIds).limit(300)), true);
  }
  const collectionId = project?.intake_collection_id ?? null;
  if (collectionId) {
    admit(await fetchDocs(supabase.from("documents").select(DOC_COLS).eq("collection_id", collectionId).limit(500)), false);
  }
  if (project?.sow_document_id) {
    admit(await fetchDocs(supabase.from("documents").select(DOC_COLS).in("id", [project.sow_document_id]).limit(1)), false);
  }

  // An external (intake) submission counts only once it was approved —
  // an unreviewed upload is a label, not evidence. Judged on the document's
  // CURRENT version only: an earlier rejected submission does not taint an
  // approved (or internal) current revision. The check fails CLOSED, per
  // document: a failed read admits nothing, and a document whose current
  // version did not come back (hidden by its own policy, or missing) is not
  // admitted either — its provenance was never checked.
  if (documents.length > 0) {
    const currentVersionIds = [...new Set(documents.map((d) => currentVersionOf.get(d.id)!))];
    const versions = await safe(
      supabase.from("document_versions").select("id, provenance, review_state")
        .in("id", currentVersionIds).limit(1000)
        .then((r) => (r.error ? null : (r.data ?? []) as Array<{ id: string; provenance: string | null; review_state: string | null }>)),
      null);
    const checked = new Set((versions ?? []).map((v) => String(v.id)));
    const unapprovedExternal = new Set((versions ?? [])
      .filter((v) => v.provenance === "external" && v.review_state !== "approved").map((v) => String(v.id)));
    for (let i = documents.length - 1; i >= 0; i--) {
      const current = currentVersionOf.get(documents[i].id)!;
      if (versions === null || !checked.has(current) || unapprovedExternal.has(current)) documents.splice(i, 1);
    }
  }

  const tags = await safe(
    supabase.from("assets").select("tag").eq("org_id", orgId).eq("archived", false).limit(1000)
      .then((r) => ((r.data ?? []) as Array<{ tag: string }>).map((a) => a.tag)), []);

  return {
    turnoverAcceptedNames: turnover.filter((t) => t.status === "accepted").map((t) => t.name),
    // The rows behind the two state rules, so a sweep citation names its row
    // (the database resolves it before it accepts a machine green).
    turnoverAccepted: turnover.filter((t) => t.status === "accepted" && t.id).map((t) => ({ id: String(t.id), name: t.name })),
    // QUAL-2: only a checklist completed on human sign-off is citable.
    miChecklistComplete: checklists.some((c) => c.kind === "mi" && c.status === "complete" && c.completed_basis === "human"),
    miChecklistId: checklists.find((c) => c.kind === "mi" && c.status === "complete" && c.completed_basis === "human" && c.id)?.id ?? null,
    documentTitles: [...new Set(documents.map((d) => d.label))],
    equipmentTags: tags,
    documents,
  };
}

export interface SweepOutcome {
  satisfied: number;
  needsEvidence: number;
  /** Greens the sweep withdrew because their only proof is gone (QUAL-1). */
  retracted: number;
  /** Rows changed by someone else between read and write — re-run. */
  refused: number;
  failed: number;
  error?: string;
}

/** The deterministic sweep: gather what the platform can prove, apply the
 *  pure rules, persist what changed — batched, checked, stamped with the
 *  machine actor, and audited as ONE row per sweep whose items[] names every
 *  item it changed (retractions flagged). Returns the tallies the UI
 *  announces. */
export async function runAutoEvidence(input: {
  orgId: string; projectId: string; checklistId: string; actor: Actor;
}): Promise<SweepOutcome> {
  const [read, state] = await Promise.all([
    readChecklistItems(input.checklistId),
    gatherProjectEvidenceState(input.orgId, input.projectId),
  ]);
  if (read.error) return { satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0, error: read.error };
  const items = read.rows;
  const byId = new Map(items.map((i) => [i.id, i]));
  const results = applyAutoEvidence(items.map(toState), state);

  const writes: ItemWrite[] = [];
  const changes: Array<{ itemId: string; from: string; to: string; retracted?: true; citation?: string; documentId?: string; turnoverItemId?: string; checklistId?: string }> = [];
  for (const r of results) {
    const item = byId.get(r.id);
    if (!item) continue;
    const patch: Record<string, unknown> = {
      status: r.status,
      updated_at: new Date().toISOString(),
      updated_by: null,
      updated_by_name: MACHINE_ACTOR_SWEEP,
    };
    if (r.removeAutoEvidence || r.addedEvidence.length > 0) {
      const kept = r.removeAutoEvidence ? item.evidence.filter((e) => e.source !== "auto") : item.evidence;
      patch.evidence = [...kept, ...r.addedEvidence];
    }
    writes.push({ item, patch });
    changes.push({
      itemId: r.id, from: item.status, to: r.status,
      ...(r.retracted ? { retracted: true as const } : {}),
      ...(r.addedEvidence[0] ? {
        citation: r.addedEvidence[0].label, documentId: r.addedEvidence[0].documentId,
        ...(r.addedEvidence[0].turnoverItemId ? { turnoverItemId: r.addedEvidence[0].turnoverItemId } : {}),
        ...(r.addedEvidence[0].checklistId ? { checklistId: r.addedEvidence[0].checklistId } : {}),
      } : {}),
    });
  }
  if (writes.length === 0) return { satisfied: 0, needsEvidence: 0, retracted: 0, refused: 0, failed: 0 };

  const w = await writeItemPatches(writes);
  const landed = new Set(w.landed);
  let satisfied = 0, needsEvidence = 0, retracted = 0;
  for (const c of changes) {
    if (!landed.has(c.itemId)) continue;
    if (c.retracted) retracted += 1;
    else if (c.to === "satisfied") satisfied += 1;
    else needsEvidence += 1;
  }
  if (w.landed.length > 0) {
    await audit("CHECKLIST_AUTO_EVIDENCE", input.orgId, input.projectId, input.actor, {
      checklistId: input.checklistId, satisfied, needsEvidence, retracted,
      refused: w.refused.length, failed: w.failed.length,
      items: changes.filter((c) => landed.has(c.itemId)),
    });
  }
  const error = w.failed.length > 0 ? w.failed[0].error
    : w.refused.length > 0 ? `${w.refused.length} item${w.refused.length === 1 ? "" : "s"} changed while the sweep ran and were left alone — run it again.`
    : undefined;
  return { satisfied, needsEvidence, retracted, refused: w.refused.length, failed: w.failed.length, ...(error ? { error } : {}) };
}

// ── Progress (pure) ──────────────────────────────────────────────────────

export interface ChecklistProgress {
  total: number;
  applicable: number;
  satisfied: number;
  needsEvidence: number;
  open: number;
  pct: number;               // satisfied / applicable, 0..100 (100 when nothing applies)
}

export function computeChecklistProgress(items: ChecklistItem[]): ChecklistProgress {
  const applicable = items.filter((i) => i.applicability !== "na" && i.status !== "na");
  const satisfied = applicable.filter((i) => i.status === "satisfied").length;
  const needsEvidence = applicable.filter((i) => i.status === "needs_evidence").length;
  return {
    total: items.length,
    applicable: applicable.length,
    satisfied,
    needsEvidence,
    open: applicable.length - satisfied - needsEvidence,
    pct: applicable.length > 0 ? Math.round((satisfied / applicable.length) * 100) : 100,
  };
}
