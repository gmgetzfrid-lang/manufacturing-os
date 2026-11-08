// costLines - full control of the budget lines: delete one (with Undo),
// close one (kept for the record, out of the totals), reopen it, move a
// line's spending to another line, keep a line for one phase or split it
// by the phases' shares, and group the lines with subtotals.
//
// Money is never lost: a line with spending booked on it (even voided)
// isn't deleted, since deleting it would take that history with it. Move
// its spending to another line, then close it.

import { supabase } from "@/lib/supabase";
import type { Actor, CostAccount, CostEntry } from "@/lib/costs";
import { PHASES_SQL } from "@/lib/projectPhases";

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({ action, resource_type: "cost", resource_id: resourceId, org_id: orgId, user_id: actor.uid, user_email: actor.email, details })
    .then(() => undefined, () => undefined);
}

/** Can a line be deleted: no entry booked on it at all. */
export const canDeleteLine = (lineId: string, entries: CostEntry[]) => !entries.some((e) => e.costAccountId === lineId);

/** Delete a line with nothing booked on it. Returns the row, for Undo. */
export async function deleteLine(input: { orgId: string; lineId: string; actor: Actor }): Promise<{ ok: boolean; error?: string; row?: Record<string, unknown> }> {
  const { data: used } = await supabase.from("cost_entries").select("id").eq("cost_account_id", input.lineId).limit(1);
  if (used?.length) return { ok: false, error: "This line has spending booked on it. Move its spending to another line, then close it: the record stays, out of the totals." };
  const { data: row } = await supabase.from("cost_accounts").select("*").eq("id", input.lineId).maybeSingle();
  if (!row) return { ok: false, error: "That line is already gone." };
  const { data, error } = await supabase.from("cost_accounts").delete().eq("id", input.lineId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Not deleted - only the project's owner, a co-owner or an admin can change the budget." };
  await audit("COST_ACCOUNT_DELETED", input.orgId, input.lineId, input.actor, { name: (row as { name?: string }).name ?? null, budget: (row as { budget?: number }).budget ?? null });
  return { ok: true, row: row as Record<string, unknown> };
}

/** Undo a delete: the line back as it was. */
export async function restoreLine(input: { orgId: string; row: Record<string, unknown>; actor: Actor }): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from("cost_accounts").insert(input.row);
  if (error) return { ok: false, error: error.message };
  await audit("COST_ACCOUNT_RESTORED", input.orgId, String(input.row.id), input.actor, {});
  return { ok: true };
}

/** Close lines (kept, out of the totals) or open them again. */
export async function setLinesClosed(input: { orgId: string; ids: string[]; closed: boolean; openStatus: string; actor: Actor }): Promise<{ ok: boolean; error?: string }> {
  if (!input.ids.length) return { ok: true };
  const { data, error } = await supabase.from("cost_accounts").update({ status: input.closed ? "closed" : input.openStatus }).in("id", input.ids).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Not changed - only the project's owner, a co-owner or an admin can change the budget." };
  for (const id of input.ids) await audit(input.closed ? "COST_ACCOUNT_CLOSED" : "COST_ACCOUNT_REOPENED", input.orgId, id, input.actor, {});
  return { ok: true };
}

/** Keep lines for one phase, or split them by the shares (null). */
export async function setLinesPhase(input: { orgId: string; ids: string[]; phaseId: string | null; actor: Actor }): Promise<{ ok: boolean; error?: string }> {
  if (!input.ids.length) return { ok: true };
  const { data, error } = await supabase.from("cost_accounts").update({ phase_id: input.phaseId }).in("id", input.ids).select("id");
  if (error) return { ok: false, error: /phase_id/.test(error.message) ? `Not saved. Run this in Supabase (SQL editor), wait a few seconds, then try again:\n${PHASES_SQL}\nThe database said: ${error.message}` : error.message };
  if (!data?.length) return { ok: false, error: "Not changed - only the project's owner, a co-owner or an admin can change the budget." };
  for (const id of input.ids) await audit("COST_ACCOUNT_PHASE", input.orgId, id, input.actor, { phaseId: input.phaseId });
  return { ok: true };
}

/** Move a line's spending to another line: each live entry booked again
 *  on the other line, the same in every way, and the old one voided (so
 *  the record shows the move). */
export async function moveSpend(input: { orgId: string; projectId: string; fromId: string; toId: string; toName: string; actor: Actor }): Promise<{ ok: boolean; error?: string; moved: number }> {
  if (input.fromId === input.toId) return { ok: false, error: "Pick another line.", moved: 0 };
  const { data, error } = await supabase.from("cost_entries").select("*").eq("cost_account_id", input.fromId).eq("status", "posted");
  if (error) return { ok: false, error: error.message, moved: 0 };
  let moved = 0;
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const copy: Record<string, unknown> = { ...r, cost_account_id: input.toId, created_by: input.actor.uid };
    delete copy.id; delete copy.created_at; delete copy.updated_at; delete copy.updated_by;
    copy.description = [r.description, `moved from another line`].filter(Boolean).join(" · ");
    const ins = await supabase.from("cost_entries").insert(copy).select("id").single();
    if (ins.error) return { ok: false, error: `Moved ${moved}, then: ${ins.error.message}`, moved };
    const v = await supabase.from("cost_entries").update({ status: "void" }).eq("id", String(r.id));
    if (v.error) return { ok: false, error: `Booked on ${input.toName}, but the old entry wasn't voided: ${v.error.message}`, moved };
    moved++;
  }
  await audit("COST_SPEND_MOVED", input.orgId, input.fromId, input.actor, { to: input.toId, moved });
  return { ok: true, moved };
}

export type GroupBy = "none" | "type" | "contractor" | "phase";

/** Lines in groups, each with its subtotal, in the order lines first come. */
export function groupLines<T extends { account: CostAccount; committed: number; spent: number }>(rows: T[], by: GroupBy, label: (r: T) => string): Array<{ key: string; label: string; rows: T[]; budget: number; committed: number; spent: number }> {
  const out: Array<{ key: string; label: string; rows: T[]; budget: number; committed: number; spent: number }> = [];
  for (const r of rows) {
    const key = by === "none" ? "all" : label(r);
    let g = out.find((x) => x.key === key);
    if (!g) { g = { key, label: key, rows: [], budget: 0, committed: 0, spent: 0 }; out.push(g); }
    g.rows.push(r);
    g.budget += r.account.budget; g.committed += r.committed; g.spent += r.spent;
  }
  return out;
}

/** The status an open line has on this project ("open" or "active"). */
export const openStatusOf = (accounts: CostAccount[]) => {
  const counts = new Map<string, number>();
  for (const a of accounts) if (a.status !== "closed") counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "active";
};
