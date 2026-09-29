// lib/changeOrders.ts — change orders, first-class.
//
// A change order is never a silent budget edit: it is proposed with a REASON
// CODE, decided on the record, and only an APPROVAL posts money — as a typed
// cost entry the rollup already understands. The CO row itself remains the
// paper trail (who proposed, who decided, why), and the reason codes score
// both sides: scope_gap lands on the contractor's record, design_error and
// owner_request land on ours.
//
// Round G (COST-6): a decision has an AUTHORITY model — the proposer may not
// decide their own change order while another eligible decider exists in
// the org (DEC-12 shape, derived from the eligible-decider count: the org's
// controllers plus the project owner); when nobody else can, the decision is
// allowed and MARKED. An org may set `change_order_approval_threshold`
// ({ amount }) in org_configurations: above it, only an org controller may
// approve. Both rules are re-checked by `enforce_change_order_decision_guard`
// (20261094) at the database, so the UI is never the only gate. Default: no
// threshold until the org sets one — a shipped default that blocked every
// large CO would strand real approvals; the marker + audit make the gap
// visible instead.

import { supabase } from "@/lib/supabase";
import { logAuditAction } from "@/lib/audit";
import { addEntry, voidEntry } from "@/lib/costs";
import { memberHoldsAny } from "@/lib/roleHeld";
import { emit } from "@/lib/notify/dispatch";

/** org_configurations key: `{ "amount": <number> }`. */
export const CO_APPROVAL_THRESHOLD_KEY = "change_order_approval_threshold";
/** The controller tier that may approve above the threshold — the same
 *  collection `is_org_controller` reads (additive roles, never the headline alone). */
const CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;

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
  decidedBy: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  /** COST-9: the cost entry an approval created — the unwind voids exactly this. */
  postedEntryId: string | null;
  /** COST-6: proposer and decider are the same person (allowed only when
   *  nobody else could decide; rendered as a visible marker). */
  selfDecided: boolean;
}

function rowToCo(r: Record<string, unknown>): ChangeOrder {
  const createdBy = (r.created_by as string | null) ?? null;
  const decidedBy = (r.decided_by as string | null) ?? null;
  const amount = Number(r.amount ?? 0);
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string,
    costAccountId: (r.cost_account_id as string | null) ?? null,
    partyId: (r.party_id as string | null) ?? null,
    coNumber: r.co_number as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    amount: Number.isFinite(amount) ? amount : 0,
    reasonCode: r.reason_code as CoReason,
    status: r.status as CoStatus,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy,
    decidedByName: (r.decided_by_name as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    createdBy,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
    postedEntryId: (r.posted_entry_id as string | null) ?? null,
    selfDecided: !!createdBy && !!decidedBy && createdBy === decidedBy,
  };
}

/** COST-4: approved change-order totals by cost account — the map
 *  computeCostRollup folds into revisedBudget. */
export function approvedChangesByAccount(cos: ChangeOrder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cos) {
    if (c.status !== "approved" || !c.costAccountId) continue;
    out.set(c.costAccountId, (out.get(c.costAccountId) ?? 0) + c.amount);
  }
  return out;
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

  // Next CO number for the project — CO-001, CO-002… Two proposals at the
  // same moment read the same maximum; the unique index rejects the loser
  // (23505) and we recompute and retry, bounded (MON-9). After three
  // collisions the user gets a human sentence, never the constraint text.
  let data: Record<string, unknown> | null = null;
  let coNumber = "";
  let lastTried = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: last, error: readErr } = await supabase
      .from("change_orders").select("co_number").eq("project_id", input.projectId)
      .order("created_at", { ascending: false }).limit(50);
    if (readErr) throw new Error(readErr.message);
    const maxN = ((last as Array<{ co_number: string }>) ?? [])
      .map((r) => parseInt(String(r.co_number ?? "").replace(/\D+/g, ""), 10))
      .filter(Number.isFinite)
      .reduce((a, b) => Math.max(a, b), 0);
    // Re-read max + 1; if the rival's row is not visible yet, step past the
    // number that just collided instead of colliding on it again.
    const next = Math.max(maxN + 1, lastTried + 1);
    lastTried = next;
    coNumber = `CO-${String(next).padStart(3, "0")}`;

    const { data: inserted, error } = await supabase.from("change_orders").insert({
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
    if (!error && inserted) { data = inserted as Record<string, unknown>; break; }
    if (error?.code === "23505") continue;
    throw new Error(error?.message ?? "Couldn't propose the change order.");
  }
  if (!data) {
    throw new Error("Another change order was numbered at the same moment — try again and it will take the next number.");
  }

  await logAuditAction({
    action: "CHANGE_ORDER_PROPOSED", resourceType: "project", resourceId: input.projectId,
    orgId: input.orgId, userId: input.actorId,
    details: { coNumber, amount: input.amount, reasonCode: input.reasonCode, title: input.title.trim() },
  });
  return rowToCo(data);
}

/** COST-6: who else could decide this CO — the org's active controllers and
 *  the project owner, minus the actor. Read errors count as "unknown", which
 *  fails SAFE (the self-decision is refused and the reason names the read). */
async function otherEligibleDeciders(orgId: string, projectId: string, actorId: string): Promise<{ count: number; error?: string }> {
  const [membersRes, projectRes] = await Promise.all([
    supabase.from("org_members").select("uid, role, roles").eq("org_id", orgId).eq("status", "active"),
    supabase.from("projects").select("owner_user_id").eq("id", projectId).maybeSingle(),
  ]);
  if (membersRes.error) return { count: 0, error: membersRes.error.message };
  if (projectRes.error) return { count: 0, error: projectRes.error.message };
  const others = new Set<string>();
  for (const m of (membersRes.data ?? []) as Array<{ uid: string; role?: unknown; roles?: unknown }>) {
    if (m.uid && m.uid !== actorId && memberHoldsAny(m, CONTROLLER_ROLES)) others.add(m.uid);
  }
  const owner = ((projectRes.data as { owner_user_id?: string | null } | null)?.owner_user_id) ?? null;
  if (owner && owner !== actorId) others.add(owner);
  return { count: others.size };
}

async function actorIsController(orgId: string, actorId: string): Promise<boolean> {
  const { data } = await supabase.from("org_members").select("role, roles")
    .eq("org_id", orgId).eq("uid", actorId).eq("status", "active").maybeSingle();
  return memberHoldsAny(data as { role?: unknown; roles?: unknown } | null, CONTROLLER_ROLES);
}

/** The org's approval threshold, or null when none is set (the default). */
export async function loadApprovalThreshold(orgId: string): Promise<number | null> {
  const { data } = await supabase.from("org_configurations").select("data")
    .eq("org_id", orgId).eq("key", CO_APPROVAL_THRESHOLD_KEY).maybeSingle();
  const amount = Number((data as { data?: { amount?: unknown } } | null)?.data?.amount);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * Decide a proposed CO. Approval POSTS the money: a SIGNED commitment entry
 * (a credit CO reduces the committed side — the same side the original
 * award lives on) so every rollup, S-curve, and forecast sees it
 * immediately. Rejection/void just closes the paper.
 *
 * Concurrency-safe: the decision is CLAIMED with a compare-and-swap BEFORE
 * money moves — two approvers on stale tabs can't both post; the loser is
 * told the CO was already decided. If posting then fails, the claim is
 * reverted so a clean retry is possible.
 */
export async function decideChangeOrder(input: {
  co: ChangeOrder;
  decision: "approved" | "rejected" | "void";
  note?: string | null;
  actorId: string;
  actorName?: string | null;
}): Promise<{ warning: string | null }> {
  // Re-read — the caller's snapshot may be stale (amount, account, status).
  const { data: row, error: readErr } = await supabase
    .from("change_orders").select("*").eq("id", input.co.id).maybeSingle();
  if (readErr || !row) throw new Error(readErr?.message ?? "Change order not found.");
  const co = rowToCo(row as Record<string, unknown>);
  if (co.status !== "proposed") throw new Error(`This change order is already ${co.status}.`);
  if (input.decision === "approved" && !co.costAccountId) {
    throw new Error("Pick which budget line this change order posts to before approving.");
  }

  // COST-6: separation of duties, derived from who else could decide.
  let selfDecided = false;
  if (input.decision !== "void" && co.createdBy && co.createdBy === input.actorId) {
    const others = await otherEligibleDeciders(co.orgId, co.projectId, input.actorId);
    if (others.error) throw new Error(`Couldn't check who else can decide this change order (${others.error}) — a second person has to decide a change order you proposed.`);
    if (others.count > 0) {
      throw new Error(`You proposed ${co.coNumber} — a second person has to decide it (${others.count} other eligible decider${others.count === 1 ? "" : "s"} in this org).`);
    }
    selfDecided = true; // nobody else can — allowed, and marked on the row and the audit trail
  }
  // COST-6: the org's approval threshold — above it, only a controller approves.
  if (input.decision === "approved") {
    const threshold = await loadApprovalThreshold(co.orgId);
    if (threshold != null && Math.abs(co.amount) > threshold && !(await actorIsController(co.orgId, input.actorId))) {
      throw new Error(`${co.coNumber} (${Math.abs(co.amount).toLocaleString()}) is above this org's change-order approval threshold (${threshold.toLocaleString()}) — an org controller has to approve it.`);
    }
  }

  // Claim the decision. Zero rows matched = someone else decided first —
  // PostgREST reports that as success, so the count is the real signal.
  const { data: claimed, error } = await supabase.from("change_orders").update({
    status: input.decision,
    decided_at: new Date().toISOString(),
    decided_by: input.actorId,
    decided_by_name: input.actorName ?? null,
    decision_note: input.note?.trim() || null,
  }).eq("id", co.id).eq("status", "proposed").select("id");
  if (error) throw new Error(error.message);
  if (!claimed || claimed.length === 0) {
    throw new Error("Someone else just decided this change order — refresh to see the outcome.");
  }

  let warning: string | null = null;
  if (input.decision === "approved" && co.costAccountId) {
    const posted = await addEntry({
      orgId: co.orgId,
      projectId: co.projectId,
      costAccountId: co.costAccountId,
      partyId: co.partyId ?? undefined,
      entryType: "commitment",
      amount: co.amount,
      entryDate: new Date().toISOString().slice(0, 10),
      description: `${co.coNumber} — ${co.title}`,
      reference: co.coNumber,
      actor: { uid: input.actorId, email: input.actorName ?? null },
    });
    if (!posted.ok) {
      // Money didn't move — put the CO back so the retry is clean. CHECKED
      // (COST-11 dw2): a revert that fails is said out loud with the id.
      const postErr = posted.error ?? "Couldn't post the change order to the budget line.";
      const back = await revertDecision(co.id);
      if (!back.ok) {
        throw new Error(`${postErr} AND the change order could not be put back (${back.error}) — ${co.coNumber} is stuck as approved with no cost entry. It is listed under "Ledger needs attention" on the Costs tab.`);
      }
      throw new Error(postErr);
    }
    // Durable CO → cost-entry link, so an approval made in error can be
    // unwound by voiding exactly the entry it created. CHECKED: a link that
    // did not save is reported (the money moved; the CO is reconcilable).
    if (posted.entryId) {
      const { data: linked, error: linkErr } = await supabase.from("change_orders")
        .update({ posted_entry_id: posted.entryId }).eq("id", co.id).select("id");
      if (linkErr || !linked || linked.length === 0) {
        warning = `${co.coNumber} was approved and its money posted, but the link to its cost entry could not be saved${linkErr ? ` (${linkErr.message})` : ""} — it is listed under "Ledger needs attention" on the Costs tab until repaired.`;
      }
    }
  }

  await logAuditAction({
    action: input.decision === "approved" ? "CHANGE_ORDER_APPROVED" : input.decision === "rejected" ? "CHANGE_ORDER_REJECTED" : "CHANGE_ORDER_VOIDED",
    resourceType: "project", resourceId: co.projectId,
    orgId: co.orgId, userId: input.actorId,
    details: { coNumber: co.coNumber, amount: co.amount, reasonCode: co.reasonCode, selfDecided, proposerId: co.createdBy },
  });
  if (input.decision === "approved") await notifyApproval(co, input.actorId, input.actorName ?? null);
  return { warning };
}

/** Put a claimed decision back to proposed — checked. */
async function revertDecision(coId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.from("change_orders").update({
      status: "proposed", decided_at: null, decided_by: null, decided_by_name: null, decision_note: null,
    }).eq("id", coId).neq("status", "proposed").select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) return { ok: false, error: "the row was not in the claimed state any more" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** MON-11: a change-order approval notifies the proposer, through lib/notify. */
async function notifyApproval(co: ChangeOrder, actorId: string, actorName: string | null): Promise<void> {
  if (!co.createdBy || co.createdBy === actorId) return;
  try {
    await emit({
      orgId: co.orgId, category: "status", kind: "project_status",
      title: `${co.coNumber} approved — ${co.title}`,
      body: `Your change order for ${co.amount.toLocaleString()} was approved and posted to the budget line.`,
      link: `/projects/${co.projectId}?tab=costs`,
      resource: { type: "project", id: co.projectId },
      actorUserId: actorId, actorName: actorName ?? undefined,
      audience: { involved: [co.createdBy] },
      metadata: { changeOrderId: co.id, coNumber: co.coNumber },
    });
  } catch (e) {
    console.warn(`[changeOrders] approval notice not sent: ${(e as Error).message}`);
  }
}

/**
 * Unwind an APPROVED change order in one action (REL-9 / COST-9): the CO
 * goes to void on the record and EXACTLY the entry it posted
 * (posted_entry_id) is voided — never a hunt through the entry list. The CO
 * is claimed first (compare-and-swap, so two unwinds cannot race) and put
 * back if the entry could not be voided. Recorded as CHANGE_ORDER_VOIDED
 * with the entry id.
 */
export async function unwindChangeOrder(input: {
  co: ChangeOrder; note?: string | null; actorId: string; actorName?: string | null;
}): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from("change_orders").select("*").eq("id", input.co.id).maybeSingle();
  if (readErr || !row) throw new Error(readErr?.message ?? "Change order not found.");
  const co = rowToCo(row as Record<string, unknown>);
  if (co.status !== "approved") throw new Error(`Only an approved change order can be reversed — this one is ${co.status}.`);
  if (!co.postedEntryId) {
    throw new Error(`${co.coNumber} has no linked cost entry to reverse — it is listed under "Ledger needs attention" on the Costs tab; void the right entry by hand and decide there.`);
  }
  const { data: claimed, error } = await supabase.from("change_orders").update({
    status: "void",
    decision_note: input.note?.trim() ? `Reversed: ${input.note.trim()}` : "Reversed",
  }).eq("id", co.id).eq("status", "approved").select("id");
  if (error) throw new Error(error.message);
  if (!claimed || claimed.length === 0) throw new Error("Someone else just changed this change order — refresh to see the outcome.");

  const voided = await voidEntry({ orgId: co.orgId, entryId: co.postedEntryId, actor: { uid: input.actorId, email: input.actorName ?? null } });
  if (!voided.ok) {
    const { data: back, error: backErr } = await supabase.from("change_orders")
      .update({ status: "approved", decision_note: co.decisionNote }).eq("id", co.id).eq("status", "void").select("id");
    const restored = !backErr && !!back && back.length > 0;
    throw new Error(`Couldn't void the change order's cost entry (${voided.error ?? "unknown"})${restored ? " — the change order is still approved." : ` AND the change order could not be put back — ${co.coNumber} reads void while its entry ${co.postedEntryId} is still posted. Void that entry by hand.`}`);
  }

  await logAuditAction({
    action: "CHANGE_ORDER_VOIDED",
    resourceType: "project", resourceId: co.projectId,
    orgId: co.orgId, userId: input.actorId,
    details: { coNumber: co.coNumber, amount: co.amount, reasonCode: co.reasonCode, reversedEntryId: co.postedEntryId, note: input.note?.trim() || null },
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
