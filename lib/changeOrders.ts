// lib/changeOrders.ts — change orders, first-class.
//
// A change order is never a silent budget edit: it is proposed with a REASON
// CODE, decided on the record, and only an APPROVAL posts money — as a typed
// cost entry the rollup already understands. The CO row itself remains the
// paper trail (who proposed, who decided, why), and the reason codes score
// both sides: scope_gap lands on the contractor's record, design_error and
// owner_request land on ours.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { addEntry } from "@/lib/costs";

export type CoReason = "scope_gap" | "field_condition" | "owner_request" | "design_error" | "other";
export type CoStatus = "proposed" | "approved" | "rejected" | "void";

export const CO_REASON_LABEL: Record<CoReason, string> = {
  scope_gap: "Scope gap (missed in the bid)",
  field_condition: "Field condition (found during work)",
  owner_request: "Owner request (we asked for more)",
  design_error: "Design error (our drawings/scope were wrong)",
  other: "Other",
};

export interface ChangeOrder {
  id: string;
  orgId: string;
  projectId: string;
  costAccountId: string | null;
  partyId: string | null;
  coNumber: string;
  title: string;
  description: string | null;
  amount: number;
  reasonCode: CoReason;
  status: CoStatus;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdByName: string | null;
  createdAt: string | null;
}

function rowToCo(r: Record<string, unknown>): ChangeOrder {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    costAccountId: (r.cost_account_id as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    coNumber: r.co_number as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    amount: Number(r.amount ?? 0),
    reasonCode: r.reason_code as CoReason,
    status: r.status as CoStatus,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedByName: (r.decided_by_name as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

export async function listChangeOrders(projectId: string): Promise<ChangeOrder[]> {
  const { data, error } = await supabase
    .from("change_orders").select("*").eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return ((data as Record<string, unknown>[]) ?? []).map(rowToCo);
}

export async function proposeChangeOrder(input: {
  orgId: string;
  projectId: string;
  costAccountId?: string | null;
  partyId?: string | null;
  title: string;
  description?: string | null;
  amount: number;
  reasonCode: CoReason;
  actorId: string;
  actorName?: string | null;
}): Promise<ChangeOrder> {
  if (!input.title.trim()) throw new Error("Give the change order a title.");
  if (!input.amount || !Number.isFinite(input.amount)) throw new Error("Amount is required (negative = credit).");

  // Next CO number for the project — CO-001, CO-002…
  const { data: last } = await supabase
    .from("change_orders").select("co_number").eq("project_id", input.projectId)
    .order("created_at", { ascending: false }).limit(50);
  const maxN = ((last as Array<{ co_number: string }>) ?? [])
    .map((r) => parseInt(r.co_number.replace(/\D+/g, ""), 10))
    .filter(Number.isFinite)
    .reduce((a, b) => Math.max(a, b), 0);
  const coNumber = `CO-${String(maxN + 1).padStart(3, "0")}`;

  const { data, error } = await supabase.from("change_orders").insert({
    org_id: input.orgId,
    project_id: input.projectId,
    cost_account_id: input.costAccountId ?? null,
    party_id: input.partyId ?? null,
    co_number: coNumber,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    amount: input.amount,
    reason_code: input.reasonCode,
    created_by: input.actorId,
    created_by_name: input.actorName ?? null,
  }).select("*").single();
  if (error) throw new Error(error.message);

  await logAuditAction({
    action: "CHANGE_ORDER_PROPOSED", resourceType: "project", resourceId: input.projectId,
    orgId: input.orgId, userId: input.actorId,
    details: { coNumber, amount: input.amount, reasonCode: input.reasonCode, title: input.title.trim() },
  });
  return rowToCo(data as Record<string, unknown>);
}

/**
 * Decide a proposed CO. Approval POSTS the money: a commitment entry (or an
 * adjustment when the CO has no account) so every rollup, S-curve, and
 * forecast sees it immediately. Rejection/void just closes the paper.
 */
export async function decideChangeOrder(input: {
  co: ChangeOrder;
  decision: "approved" | "rejected" | "void";
  note?: string | null;
  actorId: string;
  actorName?: string | null;
}): Promise<void> {
  const { co } = input;
  if (co.status !== "proposed") throw new Error(`This change order is already ${co.status}.`);
  if (input.decision === "approved" && !co.costAccountId) {
    throw new Error("Pick which budget line this change order posts to before approving.");
  }

  if (input.decision === "approved" && co.costAccountId) {
    const posted = await addEntry({
      orgId: co.orgId,
      projectId: co.projectId,
      costAccountId: co.costAccountId,
      partyId: co.partyId ?? undefined,
      entryType: co.amount >= 0 ? "commitment" : "adjustment",
      amount: co.amount,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `${co.coNumber} — ${co.title}`,
      reference: co.coNumber,
      actor: { uid: input.actorId, email: input.actorName ?? null },
    });
    if (!posted.ok) throw new Error(posted.error ?? "Couldn't post the change order to the budget line.");
  }

  const { error } = await supabase.from("change_orders").update({
    status: input.decision,
    decided_at: new Date().toISOString(),
    decided_by: input.actorId,
    decided_by_name: input.actorName ?? null,
    decision_note: input.note?.trim() || null,
  }).eq("id", co.id).eq("status", "proposed");
  if (error) throw new Error(error.message);

  await logAuditAction({
    action: input.decision === "approved" ? "CHANGE_ORDER_APPROVED" : input.decision === "rejected" ? "CHANGE_ORDER_REJECTED" : "CHANGE_ORDER_VOIDED",
    resourceType: "project", resourceId: co.projectId,
    orgId: co.orgId, userId: input.actorId,
    details: { coNumber: co.coNumber, amount: co.amount, reasonCode: co.reasonCode },
  });
}

/** Per-project CO rollup for tiles + health. */
export function summarizeChangeOrders(cos: ChangeOrder[]): {
  open: number; approvedCount: number; approvedAmount: number;
  byReason: Array<{ reason: CoReason; count: number; amount: number }>;
} {
  const approved = cos.filter((c) => c.status === "approved");
  const byReason = (Object.keys(CO_REASON_LABEL) as CoReason[]).map((reason) => ({
    reason,
    count: approved.filter((c) => c.reasonCode === reason).length,
    amount: approved.filter((c) => c.reasonCode === reason).reduce((s, c) => s + c.amount, 0),
  })).filter((r) => r.count > 0);
  return {
    open: cos.filter((c) => c.status === "proposed").length,
    approvedCount: approved.length,
    approvedAmount: approved.reduce((s, c) => s + c.amount, 0),
    byReason,
  };
}
