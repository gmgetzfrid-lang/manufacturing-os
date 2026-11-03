// costRevisions - changing the money after it was first entered, on the
// record.
//
//   AFE         the number, charge account and authorized amount change
//               (a supplement, a correction); the document can be replaced.
//               Each change is kept in projects.afe_history.
//   Budget line its name, contractor, type and budget change; budget changes
//               are kept in cost_accounts.budget_history.
//   Quote / PO  an awarded amount changes: the old entry is voided (struck
//   / invoice   through, never deleted) and the new one posted, with why.
//
// History needs 20261116_cost_controls.sql; before it, the change still
// saves and the history is simply not kept (said plainly).

import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import { addEntry, saveAccount, voidEntry, fmtMoney, type Actor, type CostAccount, type CostEntry } from "@/lib/costs";
import { noEmDash } from "@/lib/noEmDash";

export const COST_CONTROLS_SQL = "20261116_cost_controls.sql";
const missingColumn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST204" || e.code === "42703" || /afe_history|budget_history|schema cache/i.test(e.message ?? ""));

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "cost", resource_id: resourceId, org_id: orgId, user_id: actor.uid, user_email: actor.email, details,
  }).then(() => undefined, () => undefined);
}
const by = (a: Actor) => a.email?.split("@")[0] ?? null;

/** An amount as typed: "1,250,000", "$85,000.50", "-2500". */
export function parseMoney(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ─── AFE ───────────────────────────────────────────────────────────

export interface Afe { afeNumber: string | null; chargeAccount: string | null; authorized: number | null; docId: string | null }
export interface AfeRevision extends Afe { at: string | null; by: string | null; note: string | null }

export async function loadAfeHistory(projectId: string): Promise<{ history: AfeRevision[]; missing: boolean }> {
  const { data, error } = await supabase.from("projects").select("afe_history").eq("id", projectId).maybeSingle();
  if (error) return { history: [], missing: missingColumn(error) };
  const h = (data as { afe_history?: unknown } | null)?.afe_history;
  return { history: Array.isArray(h) ? (h as AfeRevision[]) : [], missing: false };
}

/** Change the AFE: the facts, why, and (optionally) a new document. The
 *  first change also keeps what was there before as the original. */
export async function saveAfe(input: {
  orgId: string; projectId: string; before: Afe; next: Omit<Afe, "docId">; note: string; file?: File | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string; historyKept: boolean }> {
  let docId = input.before.docId;
  if (input.file) {
    const safe = input.file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "afe";
    const key = `orgs/${input.orgId}/project-costs/${input.projectId}/${crypto.randomUUID()}-${safe}`;
    try { await uploadToPath(input.file, key, { contentType: input.file.type || undefined }); }
    catch (e) { return { ok: false, error: `The document didn't upload: ${(e as Error).message}`, historyKept: false }; }
    const { data, error } = await supabase.from("cost_documents").insert({
      org_id: input.orgId, project_id: input.projectId, kind: "budget", status: "posted",
      file_url: key, file_name: input.file.name, mime_type: input.file.type || null,
      doc_number: input.next.afeNumber, total_amount: input.next.authorized, currency: "USD",
      posted_at: new Date().toISOString(), posted_by: input.actor.uid, created_by: input.actor.uid,
    }).select("id").single();
    if (error) return { ok: false, error: `The document wasn't attached: ${error.message}`, historyKept: false };
    docId = String((data as { id: string }).id);
  }
  const patch = {
    afe_number: input.next.afeNumber?.trim() || null,
    charge_account: input.next.chargeAccount?.trim() || null,
    authorized_amount: input.next.authorized,
    budget_doc_id: docId,
  };
  const { data: saved, error } = await supabase.from("projects").update(patch).eq("id", input.projectId).select("id");
  if (error) return { ok: false, error: /afe_number|authorized_amount|charge_account|budget_doc_id|column/i.test(error.message) ? `Saving the AFE needs the database update (${COST_CONTROLS_SQL}) run first.` : error.message, historyKept: false };
  if (!saved?.length) return { ok: false, error: "Not saved - only the project's owner, a co-owner or an admin can change the AFE.", historyKept: false };

  // History: what was there first, then each change.
  const { history, missing } = await loadAfeHistory(input.projectId);
  let historyKept = false;
  if (!missing) {
    const now: AfeRevision = { afeNumber: patch.afe_number, chargeAccount: patch.charge_account, authorized: patch.authorized_amount, docId, at: new Date().toISOString(), by: by(input.actor), note: noEmDash(input.note.trim()) || null };
    const first: AfeRevision[] = history.length === 0 && (input.before.afeNumber || input.before.authorized != null)
      ? [{ ...input.before, at: null, by: null, note: "As first entered" }] : [];
    const { error: hErr } = await supabase.from("projects").update({ afe_history: [...history, ...first, now] }).eq("id", input.projectId);
    historyKept = !hErr;
  }
  await audit("PROJECT_AFE_REVISED", input.orgId, input.projectId, input.actor, { before: input.before, after: patch, note: input.note || null });
  return { ok: true, historyKept };
}

/** Add one change to the AFE's history (a revised AFE read from a
 *  document). Nothing changed, or no history column yet: nothing kept. */
export async function appendAfeHistory(projectId: string, before: Afe, after: Afe, note: string, actor: Actor): Promise<boolean> {
  const same = before.afeNumber === after.afeNumber && before.chargeAccount === after.chargeAccount && before.authorized === after.authorized && before.docId === after.docId;
  if (same) return true;
  const { history, missing } = await loadAfeHistory(projectId);
  if (missing) return false;
  const first: AfeRevision[] = history.length === 0 && (before.afeNumber || before.authorized != null) ? [{ ...before, at: null, by: null, note: "As first entered" }] : [];
  const { error } = await supabase.from("projects").update({ afe_history: [...history, ...first, { ...after, at: new Date().toISOString(), by: by(actor), note: noEmDash(note) || null }] }).eq("id", projectId);
  return !error;
}

/** The AFE as it stands on the project. */
export async function readAfe(projectId: string): Promise<Afe | null> {
  const got = await Promise.resolve().then(() => supabase.from("projects").select("afe_number, charge_account, authorized_amount, budget_doc_id").eq("id", projectId).maybeSingle()).catch(() => null);
  if (!got) return null;
  const { data, error } = got;
  if (error || !data) return null;
  const r = data as { afe_number: string | null; charge_account: string | null; authorized_amount: number | string | null; budget_doc_id: string | null };
  return { afeNumber: r.afe_number, chargeAccount: r.charge_account, authorized: r.authorized_amount == null ? null : Number(r.authorized_amount), docId: r.budget_doc_id };
}

// ─── Budget lines ──────────────────────────────────────────────────

export interface BudgetChange { at: string; by: string | null; from: number; to: number; note: string | null }

/** Each line's budget changes, oldest first (none before the update). */
export async function loadBudgetHistory(projectId: string): Promise<Map<string, BudgetChange[]>> {
  const { data, error } = await supabase.from("cost_accounts").select("id, budget_history").eq("project_id", projectId);
  const out = new Map<string, BudgetChange[]>();
  if (error) return out;
  for (const r of (data ?? []) as Array<{ id: string; budget_history?: unknown }>) {
    if (Array.isArray(r.budget_history) && r.budget_history.length) out.set(r.id, r.budget_history as BudgetChange[]);
  }
  return out;
}

/** Change a budget line: its name, contractor, type, budget; a budget
 *  change is kept with why. */
export async function reviseAccount(input: {
  orgId: string; projectId: string; account: CostAccount;
  patch: Partial<Pick<CostAccount, "name" | "partyId" | "costType" | "budget">>; note: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string; historyKept: boolean }> {
  const res = await saveAccount({ orgId: input.orgId, projectId: input.projectId, id: input.account.id, patch: input.patch, actor: input.actor });
  if (!res.ok) return { ok: false, error: res.error, historyKept: false };
  const b = input.patch.budget;
  if (b === undefined || b === input.account.budget) return { ok: true, historyKept: true };
  const { data, error } = await supabase.from("cost_accounts").select("budget_history").eq("id", input.account.id).maybeSingle();
  if (error) return { ok: true, historyKept: false };
  const h = (data as { budget_history?: unknown } | null)?.budget_history;
  const change: BudgetChange = { at: new Date().toISOString(), by: by(input.actor), from: input.account.budget, to: b, note: noEmDash(input.note.trim()) || null };
  const { error: e2 } = await supabase.from("cost_accounts").update({ budget_history: [...(Array.isArray(h) ? h : []), change] }).eq("id", input.account.id);
  return { ok: true, historyKept: !e2 };
}

// ─── Quotes, POs, invoices ─────────────────────────────────────────

/** Change an entry's amount: the new one is posted first, then the old one
 *  voided (struck through, kept), so money never goes missing between. */
export async function reviseEntry(input: {
  orgId: string; projectId: string; entry: CostEntry; amount: number; note: string; currency: string; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const e = input.entry;
  if (!e.costAccountId) return { ok: false, error: "This entry isn't on a budget line." };
  if (!Number.isFinite(input.amount) || input.amount === 0) return { ok: false, error: "Enter the new amount." };
  if (input.amount === e.amount) return { ok: false, error: "That's the same amount." };
  const why = noEmDash(input.note.trim());
  const res = await addEntry({
    orgId: input.orgId, projectId: input.projectId, costAccountId: e.costAccountId, entryType: e.entryType,
    amount: input.amount, entryDate: e.entryDate ?? new Date().toISOString().slice(0, 10), partyId: e.partyId,
    reference: e.reference, sourceDocumentId: e.sourceDocumentId,
    description: [e.description, `Revised from ${fmtMoney(e.amount, input.currency)}${why ? `: ${why}` : ""}`].filter(Boolean).join(" · "),
    actor: input.actor,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const v = await voidEntry({ orgId: input.orgId, entryId: e.id, actor: input.actor });
  if (!v.ok) return { ok: false, error: `The new amount is posted, but the old one couldn't be voided (${v.error}). Void it by hand.` };
  return { ok: true };
}
