// lib/costDocs.ts — INBOUND cost documents: quotes, invoices, POs.
//
// The direction matters: vendors send US documents. A contractor's quote PDF
// lands here (uploaded by a member, or submitted through their tokened
// intake link), the AI parse route reads the printed pages into structured
// numbers, a human reviews the extraction, and only then does money move —
// an AWARD posts a commitment, a confirmed INVOICE posts an actual. The
// file, the extraction, and the decision all stay on the row, so every
// number in the rollup can show the paper it came from.
//
// Lifecycle:  uploaded(draft) → parsed → awarded/declined (quotes)
//                                      → posted (invoices)     … or void.
// Money moves through lib/costs.addEntry only — never a direct insert.

import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import { addEntry, type Actor } from "@/lib/costs";
import { validateParsedQuote, type ParsedQuote } from "@/lib/bidTab";

export type CostDocKind = "quote" | "invoice" | "po";
export type CostDocStatus = "draft" | "parsed" | "awarded" | "declined" | "posted" | "void";

export const COST_DOC_STATUS_LABEL: Record<CostDocStatus, string> = {
  draft: "Uploaded — not read yet",
  parsed: "Read — awaiting your review",
  awarded: "Awarded",
  declined: "Not selected",
  posted: "Posted to budget",
  void: "Void",
};

export interface CostDocument {
  id: string;
  orgId: string;
  projectId: string;
  partyId: string | null;
  kind: CostDocKind;
  fileUrl: string | null;        // R2 key
  fileName: string | null;
  mimeType: string | null;
  docNumber: string | null;
  docDate: string | null;
  vendorName: string | null;
  currency: string | null;
  totalAmount: number | null;
  status: CostDocStatus;
  parsed: unknown;               // ParsedQuote / ParsedInvoice jsonb
  rfqGroup: string | null;
  intakeLinkId: string | null;
  postedAt: string | null;
  createdAt: string | null;
}

function mapDoc(r: Record<string, unknown>): CostDocument {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    projectId: String(r.project_id),
    partyId: (r.party_id as string | null) ?? null,
    kind: (r.kind as CostDocKind) ?? "quote",
    fileUrl: (r.file_url as string | null) ?? null,
    fileName: (r.file_name as string | null) ?? null,
    mimeType: (r.mime_type as string | null) ?? null,
    docNumber: (r.doc_number as string | null) ?? null,
    docDate: (r.doc_date as string | null) ?? null,
    vendorName: (r.vendor_name as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    totalAmount: r.total_amount == null ? null : Number(r.total_amount),
    status: (r.status as CostDocStatus) ?? "draft",
    parsed: r.parsed ?? null,
    rfqGroup: (r.rfq_group as string | null) ?? null,
    intakeLinkId: (r.intake_link_id as string | null) ?? null,
    postedAt: (r.posted_at as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  await supabase.from("audit_logs").insert({
    action, resource_type: "cost", resource_id: resourceId,
    org_id: orgId, user_id: actor.uid, user_email: actor.email,
    details,
  }).then(() => undefined, () => undefined);
}

export async function listCostDocs(orgId: string, projectId: string): Promise<CostDocument[]> {
  const { data } = await supabase.from("cost_documents").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(500);
  return (((data ?? []) as Array<Record<string, unknown>>)).map(mapDoc);
}

/** Store the file and create the row. The AI hasn't read it yet — that's
 *  the parse route, and it's a separate, deliberate click. */
export async function uploadCostDoc(input: {
  orgId: string; projectId: string;
  kind: CostDocKind;
  file: File;
  rfqGroup?: string | null;
  partyId?: string | null;
  vendorName?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; doc?: CostDocument }> {
  const safeName = input.file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "document";
  const key = `orgs/${input.orgId}/project-costs/${input.projectId}/${crypto.randomUUID()}-${safeName}`;
  try {
    await uploadToPath(input.file, key, { contentType: input.file.type });
  } catch (e) {
    return { ok: false, error: `File upload failed: ${(e as Error).message}` };
  }

  const row: Record<string, unknown> = {
    org_id: input.orgId, project_id: input.projectId,
    party_id: input.partyId || null,
    kind: input.kind,
    file_url: key, file_name: input.file.name, mime_type: input.file.type || null,
    vendor_name: input.vendorName?.trim() || null,
    status: "draft",
    rfq_group: input.rfqGroup?.trim() || null,
    created_by: input.actor.uid,
  };
  let { data, error } = await supabase.from("cost_documents").insert(row).select("*").single();
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    // Pre-migration tolerance: rfq_group lands in 20261013.
    delete row.rfq_group;
    ({ data, error } = await supabase.from("cost_documents").insert(row).select("*").single());
  }
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't record the document." };

  const doc = mapDoc(data as Record<string, unknown>);
  await audit("COST_DOC_UPLOADED", input.orgId, doc.id, input.actor, {
    kind: input.kind, fileName: input.file.name, rfqGroup: input.rfqGroup ?? null, vendor: input.vendorName ?? null,
  });
  return { ok: true, doc };
}

/** The AI's extraction as a renderable ParsedQuote, or null when the doc
 *  hasn't been read (or the stored payload no longer validates). Vendor
 *  identity falls back to the row's own columns. */
export function parsedQuoteFrom(doc: CostDocument): ParsedQuote | null {
  if (!doc.parsed) return null;
  try {
    const q = validateParsedQuote(doc.parsed, doc.id);
    if (q.vendorName === "Unknown vendor" && doc.vendorName) q.vendorName = doc.vendorName;
    return q;
  } catch {
    return null;
  }
}

/** Quotes grouped for bid tabulation: rfq_group label → its competing bids.
 *  Ungrouped quotes tabulate alone under their own name. */
export function quoteGroups(docs: CostDocument[]): Array<{ group: string; docs: CostDocument[] }> {
  const live = docs.filter((d) => d.kind === "quote" && d.status !== "void");
  const by = new Map<string, CostDocument[]>();
  for (const d of live) {
    const g = d.rfqGroup?.trim() || `Ungrouped — ${d.vendorName ?? d.fileName ?? "quote"}`;
    by.set(g, [...(by.get(g) ?? []), d]);
  }
  return [...by.entries()].map(([group, ds]) => ({ group, docs: ds }));
}

/**
 * Award a quote: post its total as a COMMITMENT on the chosen budget line,
 * mark it awarded, and mark the competing bids in the same RFQ group
 * declined (their paper stays — the tabulation remains reviewable).
 */
export async function awardQuote(input: {
  doc: CostDocument;
  siblings: CostDocument[];       // same-project docs (the group is derived here)
  costAccountId: string;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only quotes can be awarded." };
  if (doc.status === "awarded") return { ok: false, error: "This quote is already awarded." };
  if (doc.status === "void" || doc.status === "declined") {
    return { ok: false, error: `This quote is ${COST_DOC_STATUS_LABEL[doc.status].toLowerCase()} — re-upload it to award.` };
  }
  const total = parsedQuoteFrom(doc)?.total ?? doc.totalAmount;
  if (total == null || !(total > 0)) {
    return { ok: false, error: "No readable total on this quote yet — run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: doc.orgId, projectId: doc.projectId,
    costAccountId: input.costAccountId,
    partyId: doc.partyId ?? undefined,
    entryType: "commitment",
    amount: total,
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Award — ${doc.vendorName ?? "vendor"}${doc.rfqGroup ? ` (${doc.rfqGroup})` : ""}`,
    reference: doc.docNumber ?? doc.fileName ?? undefined,
    actor: input.actor,
  });
  if (!posted.ok) return { ok: false, error: posted.error ?? "Couldn't post the commitment." };

  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("cost_documents")
    .update({ status: "awarded", posted_at: nowIso, posted_by: input.actor.uid })
    .eq("id", doc.id);
  if (error) return { ok: false, error: `The commitment posted but the quote couldn't be marked awarded: ${error.message}` };

  // Same-group rivals: still-open ones become "not selected".
  const rivals = input.siblings.filter((d) =>
    d.id !== doc.id && d.kind === "quote" && !!doc.rfqGroup && d.rfqGroup === doc.rfqGroup &&
    (d.status === "draft" || d.status === "parsed"));
  if (rivals.length > 0) {
    await supabase.from("cost_documents").update({ status: "declined" })
      .in("id", rivals.map((d) => d.id))
      .then(() => undefined, () => undefined);
  }

  await audit("COST_DOC_AWARDED", doc.orgId, doc.id, input.actor, {
    vendor: doc.vendorName, total, rfqGroup: doc.rfqGroup, declined: rivals.map((d) => d.vendorName ?? d.id),
    costAccountId: input.costAccountId,
  });
  return { ok: true };
}

/** Confirm a parsed invoice: post its total as an ACTUAL and mark it. */
export async function postInvoice(input: {
  doc: CostDocument;
  costAccountId: string;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind === "quote") return { ok: false, error: "Quotes are awarded, not posted — use Award." };
  if (doc.status === "posted") return { ok: false, error: "This invoice is already posted." };
  if (doc.status === "void") return { ok: false, error: "This document is void." };
  const total = doc.totalAmount ?? (doc.parsed as { total?: number } | null)?.total ?? null;
  if (total == null || !(total > 0)) {
    return { ok: false, error: "No readable total on this invoice yet — run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: doc.orgId, projectId: doc.projectId,
    costAccountId: input.costAccountId,
    partyId: doc.partyId ?? undefined,
    entryType: "actual",
    amount: total,
    entryDate: doc.docDate ?? new Date().toISOString().slice(0, 10),
    description: `Invoice — ${doc.vendorName ?? "vendor"}`,
    reference: doc.docNumber ?? doc.fileName ?? undefined,
    actor: input.actor,
  });
  if (!posted.ok) return { ok: false, error: posted.error ?? "Couldn't post the actual." };

  const { error } = await supabase.from("cost_documents")
    .update({ status: "posted", posted_at: new Date().toISOString(), posted_by: input.actor.uid })
    .eq("id", doc.id);
  if (error) return { ok: false, error: `The actual posted but the invoice couldn't be marked: ${error.message}` };

  await audit("COST_DOC_POSTED", doc.orgId, doc.id, input.actor, {
    vendor: doc.vendorName, total, costAccountId: input.costAccountId,
  });
  return { ok: true };
}

/** Void an unposted document. Awarded/posted paper stays — void the cost
 *  entry instead if the money itself was wrong. */
export async function voidCostDoc(input: { doc: CostDocument; actor: Actor }): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.status === "awarded" || doc.status === "posted") {
    return { ok: false, error: "This document already moved money — void the cost entry itself if the amount is wrong." };
  }
  const { error } = await supabase.from("cost_documents").update({ status: "void" }).eq("id", doc.id);
  if (error) return { ok: false, error: error.message };
  await audit("COST_DOC_VOIDED", doc.orgId, doc.id, input.actor, { fileName: doc.fileName, vendor: doc.vendorName });
  return { ok: true };
}

/** Manual total entry for when the AI can't read a scan — the human types
 *  what the paper says, and that becomes the awardable number. */
export async function setManualTotal(input: {
  doc: CostDocument; total: number; vendorName?: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(input.total) || input.total <= 0) return { ok: false, error: "Enter the document's total as a positive number." };
  const patch: Record<string, unknown> = { total_amount: input.total };
  if (input.vendorName?.trim()) patch.vendor_name = input.vendorName.trim();
  if (input.doc.status === "draft") patch.status = "parsed";
  const { error } = await supabase.from("cost_documents").update(patch).eq("id", input.doc.id);
  if (error) return { ok: false, error: error.message };
  await audit("COST_DOC_MANUAL_TOTAL", input.doc.orgId, input.doc.id, input.actor, { total: input.total });
  return { ok: true };
}
