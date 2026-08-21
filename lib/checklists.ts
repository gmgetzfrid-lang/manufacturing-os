// lib/checklists.ts — checklist data layer (PSSR / MI / QA-QC / custom).
//
// The flow honors one rule end to end: THE HUMAN SAVES, THE AI PROPOSES.
// The segment route reads the checklist document and returns proposed items
// — nothing persists until the reviewer clicks save (createChecklist). The
// assess route proposes applicability per item — applyAssessment writes it,
// but never over a human's override (manual_note marks human territory).
// runAutoEvidence is the deterministic sweep: what the platform can PROVE
// (accepted turnover, MI complete, documents on file) turns green with the
// citation attached; what it can't turns needs_evidence — which is exactly
// the list the project coach feeds back to the user.

import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";
import {
  applyAutoEvidence,
  type ChecklistItemState,
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
  evidence: Array<{ label: string; documentId?: string; href?: string; source: "auto" | "manual" }>;
  aiRationale: string | null;
  manualNote: string | null;
  updatedByName: string | null;
}

function mapChecklist(r: Record<string, unknown>): Checklist {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    title: String(r.title ?? ""),
    kind: (r.kind as ChecklistKind) ?? "custom",
    sourceDocumentId: (r.source_document_id as string | null) ?? null,
    status: (r.status as Checklist["status"]) ?? "open",
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
    evidence: Array.isArray(r.evidence) ? (r.evidence as ChecklistItem["evidence"]) : [],
    aiRationale: (r.ai_rationale as string | null) ?? null,
    manualNote: (r.manual_note as string | null) ?? null,
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

export async function listChecklists(orgId: string, projectId: string): Promise<Checklist[]> {
  const { data } = await supabase.from("project_checklists").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(50);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapChecklist);
}

export async function listChecklistItems(checklistId: string): Promise<ChecklistItem[]> {
  const { data } = await supabase.from("checklist_items").select("*")
    .eq("checklist_id", checklistId).order("seq", { ascending: true }).limit(600);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapItem);
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
  }).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't create the checklist." };
  const checklistId = String(data.id);

  const rows = input.items.map((it) => ({
    org_id: input.orgId, checklist_id: checklistId,
    seq: it.seq, section: it.section, text: it.text,
  }));
  const { error: itemsErr } = await supabase.from("checklist_items").insert(rows);
  if (itemsErr) {
    // Half a checklist is worse than none — take the header back out.
    await supabase.from("project_checklists").delete().eq("id", checklistId).then(() => undefined, () => undefined);
    return { ok: false, error: `Couldn't save the items: ${itemsErr.message}` };
  }

  await audit("CHECKLIST_CREATED", input.orgId, input.projectId, input.actor, {
    checklistId, title: input.title.trim(), kind: input.kind, items: input.items.length,
  });
  return { ok: true, checklistId };
}

/** Write the AI's applicability proposals — skipping any item a human has
 *  already decided (manual_note set). Rationale rides along so every
 *  verdict can show its reasoning. */
export async function applyAssessment(input: {
  orgId: string; projectId: string; checklistId: string;
  proposals: Array<{ itemId: string; applicability: "applies" | "na" | "unknown"; rationale: string }>;
  actor: Actor;
}): Promise<{ applied: number; skippedHuman: number }> {
  const items = await listChecklistItems(input.checklistId);
  const byId = new Map(items.map((i) => [i.id, i]));
  let applied = 0, skippedHuman = 0;
  for (const p of input.proposals) {
    const item = byId.get(p.itemId);
    if (!item) continue;
    if (item.manualNote) { skippedHuman += 1; continue; }
    const patch: Record<string, unknown> = {
      applicability: p.applicability,
      ai_rationale: p.rationale.slice(0, 1000) || null,
      updated_at: new Date().toISOString(),
    };
    if (p.applicability === "na" && item.status !== "na") patch.status = "na";
    if (p.applicability === "applies" && item.status === "na") patch.status = "open";
    const { error } = await supabase.from("checklist_items").update(patch).eq("id", p.itemId);
    if (!error) applied += 1;
  }
  await audit("CHECKLIST_ASSESSED", input.orgId, input.projectId, input.actor, {
    checklistId: input.checklistId, applied, skippedHuman,
  });
  return { applied, skippedHuman };
}

/** Human override on one item — status, applicability, note, or manually
 *  attached evidence. Setting a note marks the item human-decided; every
 *  automated pass keeps its hands off from then on. */
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
  const { error } = await supabase.from("checklist_items").update(row).eq("id", input.item.id);
  if (error) return { ok: false, error: error.message };
  await audit("CHECKLIST_ITEM_UPDATED", input.orgId, input.projectId, input.actor, {
    checklistId: input.item.checklistId, itemId: input.item.id, patch: {
      applicability: input.patch.applicability, status: input.patch.status,
      note: input.patch.manualNote ? true : undefined, evidence: input.patch.addEvidence?.label,
    },
  });
  return { ok: true };
}

export async function setChecklistStatus(input: {
  orgId: string; projectId: string; checklist: Checklist;
  status: "open" | "complete" | "void"; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (input.status === "complete") {
    const items = await listChecklistItems(input.checklist.id);
    const blocking = items.filter((i) => i.applicability !== "na" && i.status !== "satisfied" && i.status !== "na");
    if (blocking.length > 0) {
      return { ok: false, error: `${blocking.length} item${blocking.length === 1 ? " is" : "s are"} not satisfied yet — a checklist only completes when every applicable item is green or N/A.` };
    }
  }
  const { error } = await supabase.from("project_checklists").update({ status: input.status }).eq("id", input.checklist.id);
  if (error) return { ok: false, error: error.message };
  await audit("CHECKLIST_STATUS", input.orgId, input.projectId, input.actor, {
    checklistId: input.checklist.id, status: input.status, title: input.checklist.title,
  });
  return { ok: true };
}

// ── Evidence gathering + the deterministic sweep ─────────────────────────

/** Everything the platform can currently PROVE about a project, for the
 *  auto-evidence pass. Every gather is fault-tolerant: a missing table
 *  (pre-migration) contributes nothing rather than failing the sweep. */
export async function gatherProjectEvidenceState(orgId: string, projectId: string): Promise<ProjectEvidenceState> {
  const safe = async <T>(p: PromiseLike<T>, fallback: T): Promise<T> => {
    try { return await p; } catch { return fallback; }
  };

  const [turnover, checklists, project] = await Promise.all([
    safe(supabase.from("turnover_items").select("name, status").eq("project_id", projectId).limit(300)
      .then((r) => (r.data ?? []) as Array<{ name: string; status: string }>), []),
    safe(supabase.from("project_checklists").select("kind, status").eq("project_id", projectId).limit(50)
      .then((r) => (r.data ?? []) as Array<{ kind: string; status: string }>), []),
    safe(supabase.from("projects").select("intake_collection_id, sow_document_id").eq("id", projectId).maybeSingle()
      .then((r) => r.data as { intake_collection_id?: string | null; sow_document_id?: string | null } | null), null),
  ]);

  // The project's document register: its intake folder + the SOW + any
  // documents attached to turnover items.
  const titles: string[] = [];
  const collectionId = project?.intake_collection_id ?? null;
  if (collectionId) {
    const docs = await safe(
      supabase.from("documents").select("title, name, document_number").eq("collection_id", collectionId).limit(500)
        .then((r) => (r.data ?? []) as Array<{ title: string | null; name: string | null; document_number: string | null }>),
      []);
    for (const d of docs) {
      const label = [d.document_number, d.title ?? d.name].filter(Boolean).join(" ");
      if (label) titles.push(label);
    }
  }
  const extraDocIds = [
    ...(project?.sow_document_id ? [project.sow_document_id] : []),
  ];
  const turnoverDocs = await safe(
    supabase.from("turnover_items").select("document_id").eq("project_id", projectId).not("document_id", "is", null).limit(300)
      .then((r) => (r.data ?? []) as Array<{ document_id: string }>), []);
  extraDocIds.push(...turnoverDocs.map((t) => t.document_id));
  if (extraDocIds.length > 0) {
    const docs = await safe(
      supabase.from("documents").select("title, name, document_number").in("id", [...new Set(extraDocIds)]).limit(300)
        .then((r) => (r.data ?? []) as Array<{ title: string | null; name: string | null; document_number: string | null }>),
      []);
    for (const d of docs) {
      const label = [d.document_number, d.title ?? d.name].filter(Boolean).join(" ");
      if (label) titles.push(label);
    }
  }

  const tags = await safe(
    supabase.from("assets").select("tag").eq("org_id", orgId).eq("archived", false).limit(1000)
      .then((r) => ((r.data ?? []) as Array<{ tag: string }>).map((a) => a.tag)), []);

  return {
    turnoverAcceptedNames: turnover.filter((t) => t.status === "accepted").map((t) => t.name),
    miChecklistComplete: checklists.some((c) => c.kind === "mi" && c.status === "complete"),
    documentTitles: [...new Set(titles)],
    equipmentTags: tags,
  };
}

/** The deterministic sweep: gather what the platform can prove, apply the
 *  pure rules, persist what changed. Returns the tallies the UI announces. */
export async function runAutoEvidence(input: {
  orgId: string; projectId: string; checklistId: string; actor: Actor;
}): Promise<{ satisfied: number; needsEvidence: number }> {
  const [items, state] = await Promise.all([
    listChecklistItems(input.checklistId),
    gatherProjectEvidenceState(input.orgId, input.projectId),
  ]);
  const states: ChecklistItemState[] = items.map((i) => ({
    id: i.id, text: i.text, applicability: i.applicability, status: i.status,
    manualNote: i.manualNote, evidence: i.evidence,
  }));
  const results = applyAutoEvidence(states, state);

  let satisfied = 0, needsEvidence = 0;
  for (const r of results) {
    const item = items.find((i) => i.id === r.id);
    if (!item) continue;
    const patch: Record<string, unknown> = { status: r.status, updated_at: new Date().toISOString() };
    if (r.addedEvidence.length > 0) patch.evidence = [...item.evidence, ...r.addedEvidence];
    const { error } = await supabase.from("checklist_items").update(patch).eq("id", r.id);
    if (error) continue;
    if (r.status === "satisfied") satisfied += 1; else needsEvidence += 1;
  }
  await audit("CHECKLIST_AUTO_EVIDENCE", input.orgId, input.projectId, input.actor, {
    checklistId: input.checklistId, satisfied, needsEvidence,
  });
  return { satisfied, needsEvidence };
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
