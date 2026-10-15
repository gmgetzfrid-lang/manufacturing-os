// lib/budgetImport.ts — budget documents IN: read, review, apply.
//
// The client half of lib/budgetDoc. readBudgetDoc uploads the file under
// the org's prefix and has /api/projects/budget-doc read it; the caller
// shows the result for review (the wizard prefills its steps, the Costs
// tab shows an import sheet). applyBudgetToProject then builds the cost
// model from the reviewed lines: companies first (reusing the project's
// and the Known Companies registry's), then budget lines linked to the
// company each was budgeted for — which is what lets invoices route
// themselves later. recordBudgetBasis keeps the paper and stamps the
// authorization facts on the project.
//
// Nothing here posts money. Budgets are the plan; commitments and actuals
// still only move through lib/costs.addEntry.

import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import { listAccounts, listParties, type Actor } from "@/lib/costs";
import {
  planBudgetApply, matchParty, sameCompany,
  type BudgetLine, type BudgetReconciliation, type ParsedBudgetDoc, type CostType,
} from "@/lib/budgetDoc";

export interface BudgetSource { fileKey: string; fileName: string; mimeType: string | null }

export interface BudgetReadResult {
  parsed: ParsedBudgetDoc;
  reconciliation: BudgetReconciliation;
  source: BudgetSource;
  /** PDF pages that rendered blank — usually scanner compression the
   *  reader can't decode. The reviewer should check them by eye. */
  blankPages: number[];
}

const pgMissingColumn = (e: { code?: string } | null) => !!e && (e.code === "PGRST204" || e.code === "42703");

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "cost", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

/** Upload a budget document and have the AI read it. projectId is omitted
 *  in the wizard (no project yet). */
export async function readBudgetDoc(input: { orgId: string; projectId?: string | null; file: File }): Promise<BudgetReadResult> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "budget";
  const folder = input.projectId ? `project-costs/${input.projectId}` : "project-setup";
  const fileKey = `orgs/${input.orgId}/${folder}/${crypto.randomUUID()}-${safeName}`;
  await uploadToPath(input.file, fileKey, { contentType: input.file.type || undefined });

  const { data } = await supabase.auth.getSession();
  const res = await fetch("/api/projects/budget-doc", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
    },
    body: JSON.stringify({
      orgId: input.orgId, projectId: input.projectId ?? undefined,
      fileKey, fileName: input.file.name, mimeType: input.file.type || null,
    }),
  });
  const body = (await res.json().catch(() => null)) as
    | { parsed: ParsedBudgetDoc; reconciliation: BudgetReconciliation; blankPages?: number[]; error?: string } | null;
  if (!res.ok || !body?.parsed) throw new Error(body?.error || `Couldn't read the document (HTTP ${res.status}).`);
  return {
    parsed: body.parsed,
    reconciliation: body.reconciliation,
    blankPages: Array.isArray(body.blankPages) ? body.blankPages : [],
    source: { fileKey, fileName: input.file.name, mimeType: input.file.type || null },
  };
}

/** contractor / vendor / rental from what the company was budgeted for. */
export function partyKindFor(types: CostType[]): "contractor" | "vendor" | "rental" {
  if (types.length > 0 && types.every((t) => t === "material")) return "vendor";
  if (types.length > 0 && types.every((t) => t === "equipment")) return "rental";
  return "contractor";
}

/**
 * Create the project's companies and return name → party id for every
 * supplier named (existing parties reused, Known Companies linked).
 */
export async function ensureParties(input: {
  orgId: string; projectId: string;
  suppliers: Array<{ name: string; types: CostType[] }>;
  existing: Array<{ id: string; name: string }>;
  registry?: Array<{ id: string; name: string }>;
  actor: Actor;
}): Promise<{ resolve: (name: string | null) => string | null; created: number; error?: string }> {
  const known = [...input.existing];
  const toCreate = input.suppliers.filter((s) => !matchParty(s.name, known));
  let created = 0;
  let error: string | undefined;
  if (toCreate.length > 0) {
    const rows = toCreate.map((s) => ({
      org_id: input.orgId, project_id: input.projectId,
      name: s.name.trim(), kind: partyKindFor(s.types), status: "active",
      company_id: input.registry?.find((c) => sameCompany(c.name, s.name))?.id ?? null,
      created_by: input.actor.uid,
    }));
    let { data, error: e } = await supabase.from("project_parties").insert(rows).select("id, name");
    if (pgMissingColumn(e)) {
      // Pre-migration: no company_id link yet — save the companies anyway.
      ({ data, error: e } = await supabase.from("project_parties")
        .insert(rows.map(({ company_id: _c, ...rest }) => rest)).select("id, name"));
    }
    if (e) error = e.message;
    for (const r of ((data ?? []) as Array<{ id: string; name: string }>)) known.push({ id: String(r.id), name: String(r.name) });
    created = (data ?? []).length;
  }
  return { resolve: (name) => matchParty(name, known)?.id ?? null, created, error };
}

/** Group lines by supplier with the cost types each was budgeted for. */
export function suppliersOf(lines: Array<Pick<BudgetLine, "supplier" | "costType">>): Array<{ name: string; types: CostType[] }> {
  const out: Array<{ name: string; types: CostType[] }> = [];
  for (const l of lines) {
    if (!l.supplier) continue;
    const hit = out.find((s) => sameCompany(s.name, l.supplier!));
    if (hit) hit.types.push(l.costType); else out.push({ name: l.supplier, types: [l.costType] });
  }
  return out;
}

/** Keep the paper as a kind='budget' cost document and stamp the
 *  authorization facts on the project. Best-effort on pre-migration DBs. */
export async function recordBudgetBasis(input: {
  orgId: string; projectId: string; parsed: ParsedBudgetDoc; source: BudgetSource | null; actor: Actor;
}): Promise<{ docId: string | null }> {
  const { parsed, source } = input;
  let docId: string | null = null;
  if (source) {
    const { data } = await supabase.from("cost_documents").insert({
      org_id: input.orgId, project_id: input.projectId,
      kind: "budget", status: "posted",
      file_url: source.fileKey, file_name: source.fileName, mime_type: source.mimeType,
      doc_number: parsed.docNumber, doc_date: parsed.docDate,
      currency: parsed.currency ?? "USD",
      total_amount: parsed.authorizedAmount,
      parsed,
      posted_at: new Date().toISOString(), posted_by: input.actor.uid,
      created_by: input.actor.uid,
    }).select("id").single();
    docId = data?.id ? String(data.id) : null;
  }
  const patch: Record<string, unknown> = {};
  if (parsed.docNumber) patch.afe_number = parsed.docNumber;
  if (parsed.chargeAccount) patch.charge_account = parsed.chargeAccount;
  if (parsed.authorizedAmount != null) patch.authorized_amount = parsed.authorizedAmount;
  if (docId) patch.budget_doc_id = docId;
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("projects").update(patch).eq("id", input.projectId);
    if (error && !pgMissingColumn(error)) console.warn("[budget] basis not saved:", error.message);
  }
  return { docId };
}

/**
 * Build (or extend) a project's cost model from reviewed budget lines.
 * Lines whose name already exists as a budget line are skipped — an
 * existing budget only changes through a change order.
 */
export async function applyBudgetToProject(input: {
  orgId: string; projectId: string;
  parsed: ParsedBudgetDoc;          // with the reviewer's edits applied to .lines
  source: BudgetSource | null;
  registry?: Array<{ id: string; name: string }>;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; accountsCreated: number; partiesCreated: number; skipped: string[] }> {
  const [accounts, parties] = await Promise.all([
    listAccounts(input.orgId, input.projectId),
    listParties(input.orgId, input.projectId),
  ]);
  const plan = planBudgetApply(input.parsed.lines, accounts, parties);
  const parties2 = await ensureParties({
    orgId: input.orgId, projectId: input.projectId,
    suppliers: suppliersOf(plan.accountsToCreate),
    existing: parties, registry: input.registry, actor: input.actor,
  });

  let accountsCreated = 0;
  if (plan.accountsToCreate.length > 0) {
    const currency = input.parsed.currency ?? "USD";
    const { data, error } = await supabase.from("cost_accounts").insert(plan.accountsToCreate.map((a) => ({
      org_id: input.orgId, project_id: input.projectId,
      name: a.name, budget: a.budget, cost_type: a.costType, currency,
      party_id: parties2.resolve(a.supplier),
      status: "active",
      created_by: input.actor.uid,
    }))).select("id");
    if (error) {
      return { ok: false, error: `Budget lines not saved: ${error.message}`, accountsCreated: 0, partiesCreated: parties2.created, skipped: [] };
    }
    accountsCreated = (data ?? []).length;
  }

  const { docId } = await recordBudgetBasis({
    orgId: input.orgId, projectId: input.projectId, parsed: input.parsed, source: input.source, actor: input.actor,
  });
  await audit("COST_BUDGET_IMPORTED", input.orgId, docId ?? input.projectId, input.actor, {
    projectId: input.projectId, docNumber: input.parsed.docNumber, authorized: input.parsed.authorizedAmount,
    accountsCreated, partiesCreated: parties2.created,
    skipped: plan.accountsSkipped.map((s) => s.name), fileName: input.source?.fileName ?? null,
  });
  return {
    ok: true, error: parties2.error,
    accountsCreated, partiesCreated: parties2.created,
    skipped: plan.accountsSkipped.map((s) => s.name),
  };
}
