// lib/turnover.ts — turnover package + punch list data layer.
//
// "Has the contractor delivered turnover documents and a quality package,
// and did OUR side actually review them?" — that question becomes rows.
// Each turnover item is one required content of the package (weld map, NDE
// reports, MTRs…), seeded by job size, tracked open → received → accepted /
// rejected / waived with the reviewer's name on the decision. Acceptance
// rates roll up to the contractor's permanent scorecard, and accepted items
// become evidence the checklist engine can cite. The punch list is the
// closeout snag list — small, dated, and visible until it's empty.

import { supabase } from "@/lib/supabase";
import type { Actor } from "@/lib/costs";

export type TurnoverStatus = "open" | "received" | "accepted" | "rejected" | "waived";

export const TURNOVER_STATUS_LABEL: Record<TurnoverStatus, string> = {
  open: "Not received",
  received: "Received — awaiting QA/QC review",
  accepted: "Accepted",
  rejected: "Rejected — resubmission needed",
  waived: "Waived",
};

export interface TurnoverItem {
  id: string;
  orgId: string;
  projectId: string;
  partyId: string | null;
  name: string;
  description: string | null;
  required: boolean;
  status: TurnoverStatus;
  documentId: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  createdAt: string | null;
}

export interface PunchItem {
  id: string;
  orgId: string;
  projectId: string;
  partyId: string | null;
  title: string;
  status: "open" | "done" | "void";
  dueDate: string | null;
  closedAt: string | null;
  createdByName: string | null;
  createdAt: string | null;
}

/** What a turnover package must contain, sized by job kind — each seed
 *  explains itself in plain terms so a rookie knows what to chase. The
 *  lists nest: standard includes small, capital includes both. */
export const TURNOVER_SEEDS: Record<"small" | "standard" | "capital", Array<{ name: string; description: string }>> = {
  small: [
    { name: "Work completion sign-off", description: "The contractor's statement that the scope is finished — who signed and when." },
    { name: "As-built markups / redlines", description: "Marked-up drawings showing what was ACTUALLY installed, wherever it differs from the design." },
    { name: "Test records", description: "Whatever proving was done — pressure test, loop check, rotation check — with the numbers, not just a checkmark." },
  ],
  standard: [
    { name: "Weld map & weld log", description: "Which weld is where, who welded it, and with what procedure. The map ties every weld number to a drawing location." },
    { name: "NDE reports", description: "Non-destructive examination results (X-ray/RT, ultrasonic/UT, dye penetrant) for the welds that required them." },
    { name: "Material certs (MTRs)", description: "Mill test reports proving the pipe and fittings are the alloy the spec ordered — heat numbers must trace to what was installed." },
    { name: "Pressure / leak test records", description: "Test pressure, hold time, test medium, and the witness signature. The chart or gauge log comes with it." },
    { name: "Equipment data sheets", description: "Vendor data for anything new that was installed — capacities, materials, ratings." },
  ],
  capital: [
    { name: "ITP records (hold/witness points)", description: "The inspection & test plan with every hold and witness point signed off in order — proof nothing skipped inspection." },
    { name: "Welder qualification records", description: "Current qualification papers for every welder who touched the job, matched to the procedures they welded." },
    { name: "Calibration certs for M&TE", description: "Calibration certificates for the gauges and instruments used in testing — an uncalibrated gauge proves nothing." },
    { name: "PSSR support package", description: "Everything the pre-startup safety review needs: updated P&IDs, procedures, training records for the change." },
    { name: "Vendor manuals & spare parts list", description: "Operating manuals and the recommended spares list for new equipment — maintenance needs these on day one." },
    { name: "Final as-built drawings", description: "The drafted, issued as-built revisions — not just field markups — closing the loop in document control." },
  ],
};

/** The full seed list for a job kind (lists nest upward). */
export function seedsForJobKind(jobKind: string | null | undefined): Array<{ name: string; description: string }> {
  const k = jobKind === "capital" ? "capital" : jobKind === "small" ? "small" : "standard";
  if (k === "small") return TURNOVER_SEEDS.small;
  if (k === "standard") return [...TURNOVER_SEEDS.small, ...TURNOVER_SEEDS.standard];
  return [...TURNOVER_SEEDS.small, ...TURNOVER_SEEDS.standard, ...TURNOVER_SEEDS.capital];
}

function mapItem(r: Record<string, unknown>): TurnoverItem {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    partyId: (r.party_id as string | null) ?? null,
    name: String(r.name ?? ""),
    description: (r.description as string | null) ?? null,
    required: r.required !== false,
    status: (r.status as TurnoverStatus) ?? "open",
    documentId: (r.document_id as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    reviewedByName: (r.reviewed_by_name as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

function mapPunch(r: Record<string, unknown>): PunchItem {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    partyId: (r.party_id as string | null) ?? null,
    title: String(r.title ?? ""),
    status: (r.status as PunchItem["status"]) ?? "open",
    dueDate: (r.due_date as string | null) ?? null,
    closedAt: (r.closed_at as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "project", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

// ── Turnover items ───────────────────────────────────────────────────────

export async function listTurnoverItems(orgId: string, projectId: string): Promise<TurnoverItem[]> {
  const { data } = await supabase.from("turnover_items").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: true }).limit(300);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapItem);
}

/** Seed the required contents for the job size — skipping names that
 *  already exist, so re-seeding after a job-kind change only adds. */
export async function seedTurnoverItems(input: {
  orgId: string; projectId: string;
  jobKind: string | null;
  partyId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; added: number }> {
  const existing = await listTurnoverItems(input.orgId, input.projectId);
  const have = new Set(existing.map((i) => i.name.toLowerCase()));
  const rows = seedsForJobKind(input.jobKind)
    .filter((s) => !have.has(s.name.toLowerCase()))
    .map((s) => ({
      org_id: input.orgId, project_id: input.projectId,
      party_id: input.partyId ?? null,
      name: s.name, description: s.description, required: true,
      created_by: input.actor.uid,
    }));
  if (rows.length === 0) return { ok: true, added: 0 };
  const { error } = await supabase.from("turnover_items").insert(rows);
  if (error) return { ok: false, error: error.message, added: 0 };
  await audit("TURNOVER_SEEDED", input.orgId, input.projectId, input.actor, {
    jobKind: input.jobKind, added: rows.length,
  });
  return { ok: true, added: rows.length };
}

export async function addTurnoverItem(input: {
  orgId: string; projectId: string;
  name: string; description?: string | null; required?: boolean;
  partyId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.name.trim()) return { ok: false, error: "Name the turnover item." };
  const { error } = await supabase.from("turnover_items").insert({
    org_id: input.orgId, project_id: input.projectId,
    party_id: input.partyId ?? null,
    name: input.name.trim(), description: input.description?.trim() || null,
    required: input.required !== false,
    created_by: input.actor.uid,
  });
  if (error) return { ok: false, error: error.message };
  await audit("TURNOVER_ITEM_ADDED", input.orgId, input.projectId, input.actor, { name: input.name.trim() });
  return { ok: true };
}

/**
 * Move one item through the review: mark received (optionally attaching the
 * submitted document), then accepted / rejected / waived — decisions stamp
 * the reviewer's name and note. Acceptance rates feed the contractor's
 * scorecard, so the decision is the record.
 */
export async function reviewTurnoverItem(input: {
  item: TurnoverItem;
  status: TurnoverStatus;
  note?: string | null;
  documentId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { item } = input;
  const row: Record<string, unknown> = { status: input.status };
  if (input.documentId !== undefined) row.document_id = input.documentId;
  if (input.status === "accepted" || input.status === "rejected" || input.status === "waived") {
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = input.actor.uid;
    row.reviewed_by_name = input.actor.email?.split("@")[0] ?? null;
    row.review_note = input.note?.trim() || null;
  }
  const { error } = await supabase.from("turnover_items").update(row).eq("id", item.id);
  if (error) return { ok: false, error: error.message };
  await audit("TURNOVER_REVIEWED", item.orgId, item.projectId, input.actor, {
    itemId: item.id, name: item.name, status: input.status, note: input.note ?? null,
  });
  return { ok: true };
}

export interface TurnoverProgress {
  required: number;
  accepted: number;
  received: number;          // received but not yet decided
  rejected: number;
  outstanding: string[];     // required item names still open/rejected
  pct: number;               // accepted / required (waived counts as met)
}

export function computeTurnoverProgress(items: TurnoverItem[]): TurnoverProgress {
  const req = items.filter((i) => i.required);
  const accepted = req.filter((i) => i.status === "accepted" || i.status === "waived").length;
  return {
    required: req.length,
    accepted,
    received: req.filter((i) => i.status === "received").length,
    rejected: req.filter((i) => i.status === "rejected").length,
    outstanding: req.filter((i) => i.status === "open" || i.status === "rejected").map((i) => i.name),
    pct: req.length > 0 ? Math.round((accepted / req.length) * 100) : 100,
  };
}

// ── Punch list ───────────────────────────────────────────────────────────

export async function listPunchItems(orgId: string, projectId: string): Promise<PunchItem[]> {
  const { data } = await supabase.from("punch_items").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(500);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapPunch);
}

export async function addPunchItem(input: {
  orgId: string; projectId: string;
  title: string; dueDate?: string | null; partyId?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!input.title.trim()) return { ok: false, error: "Describe the punch item." };
  const { error } = await supabase.from("punch_items").insert({
    org_id: input.orgId, project_id: input.projectId,
    party_id: input.partyId ?? null,
    title: input.title.trim(), due_date: input.dueDate || null,
    created_by: input.actor.uid,
    created_by_name: input.actor.email?.split("@")[0] ?? null,
  });
  if (error) return { ok: false, error: error.message };
  await audit("PUNCH_ADDED", input.orgId, input.projectId, input.actor, { title: input.title.trim() });
  return { ok: true };
}

export async function setPunchStatus(input: {
  item: PunchItem; status: "open" | "done" | "void"; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const row: Record<string, unknown> = { status: input.status };
  if (input.status === "done" || input.status === "void") {
    row.closed_at = new Date().toISOString();
    row.closed_by = input.actor.uid;
  } else {
    row.closed_at = null;
    row.closed_by = null;
  }
  const { error } = await supabase.from("punch_items").update(row).eq("id", input.item.id);
  if (error) return { ok: false, error: error.message };
  await audit("PUNCH_STATUS", input.item.orgId, input.item.projectId, input.actor, {
    itemId: input.item.id, title: input.item.title, status: input.status,
  });
  return { ok: true };
}
