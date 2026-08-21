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
 * Claim a cost document's next lifecycle state with a compare-and-swap:
 * the UPDATE only matches while the row is still in an expected state, so
 * two users acting on stale tabs can't both move the same money. Returns
 * the row AS RE-READ from the DB (fresh totals — a colleague's manual
 * correction wins over any stale snapshot).
 */
async function claimDocTransition(
  docId: string,
  fromStatuses: CostDocStatus[],
  to: CostDocStatus,
  actorUid: string,
): Promise<{ ok: true; fresh: CostDocument } | { ok: false; error: string }> {
  const { data: row, error: readErr } = await supabase
    .from("cost_documents").select("*").eq("id", docId).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Document not found — it may have been removed." };
  const fresh = mapDoc(row as Record<string, unknown>);
  if (!fromStatuses.includes(fresh.status)) {
    return { ok: false, error: `This document is already ${COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()} — refresh to see the latest.` };
  }
  const { data: claimed, error } = await supabase.from("cost_documents")
    .update({ status: to, posted_at: new Date().toISOString(), posted_by: actorUid })
    .eq("id", docId).in("status", fromStatuses)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: "Someone else just decided this document — refresh to see the latest." };
  }
  return { ok: true, fresh };
}

/** Best-effort revert when money failed to post after a claim — the row
 *  goes back to its prior state so a retry is clean. */
async function revertDocTransition(docId: string, backTo: CostDocStatus): Promise<void> {
  await supabase.from("cost_documents")
    .update({ status: backTo, posted_at: null, posted_by: null })
    .eq("id", docId)
    .then(() => undefined, () => undefined);
}

/**
 * Award a quote: post its total as a COMMITMENT on the chosen budget line,
 * mark it awarded, and mark the competing bids in the same RFQ group
 * declined (their paper stays — the tabulation remains reviewable).
 * Concurrency-safe: the award is CLAIMED via compare-and-swap before any
 * money moves, and the total is re-read from the DB so a colleague's
 * correction (setManualTotal) is what actually posts.
 */
export async function awardQuote(input: {
  doc: CostDocument;
  siblings: CostDocument[];       // same-project docs (the group is derived here)
  costAccountId: string;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only quotes can be awarded." };

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "awarded", input.actor.uid);
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;

  // total_amount is the human-visible number (AI-written at parse, or typed
  // via setManualTotal) — it outranks the stored extraction.
  const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total;
  if (total == null || !(total > 0)) {
    await revertDocTransition(doc.id, fresh.status);
    return { ok: false, error: "No readable total on this quote yet — run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: fresh.orgId, projectId: fresh.projectId,
    costAccountId: input.costAccountId,
    partyId: fresh.partyId ?? undefined,
    entryType: "commitment",
    amount: total,
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Award — ${fresh.vendorName ?? "vendor"}${fresh.rfqGroup ? ` (${fresh.rfqGroup})` : ""}`,
    reference: fresh.docNumber ?? fresh.fileName ?? undefined,
    actor: input.actor,
  });
  if (!posted.ok) {
    await revertDocTransition(doc.id, fresh.status);
    return { ok: false, error: posted.error ?? "Couldn't post the commitment." };
  }

  // Same-group rivals: still-open ones become "not selected". The DB-side
  // status guard means a rival someone awarded meanwhile is never clobbered.
  const rivals = input.siblings.filter((d) =>
    d.id !== doc.id && d.kind === "quote" && !!fresh.rfqGroup && d.rfqGroup === fresh.rfqGroup);
  if (rivals.length > 0) {
    await supabase.from("cost_documents").update({ status: "declined" })
      .in("id", rivals.map((d) => d.id))
      .in("status", ["draft", "parsed"])
      .then(() => undefined, () => undefined);
  }

  await audit("COST_DOC_AWARDED", fresh.orgId, doc.id, input.actor, {
    vendor: fresh.vendorName, total, rfqGroup: fresh.rfqGroup, rivalsConsidered: rivals.map((d) => d.vendorName ?? d.id),
    costAccountId: input.costAccountId,
  });
  return { ok: true };
}

/** Confirm a parsed invoice: post its total as an ACTUAL and mark it.
 *  Same claim-before-money discipline as awardQuote. */
export async function postInvoice(input: {
  doc: CostDocument;
  costAccountId: string;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind === "quote") return { ok: false, error: "Quotes are awarded, not posted — use Award." };

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "posted", input.actor.uid);
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;

  const total = fresh.totalAmount ?? (fresh.parsed as { total?: number } | null)?.total ?? null;
  if (total == null || !(total > 0)) {
    await revertDocTransition(doc.id, fresh.status);
    return { ok: false, error: "No readable total on this invoice yet — run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: fresh.orgId, projectId: fresh.projectId,
    costAccountId: input.costAccountId,
    partyId: fresh.partyId ?? undefined,
    entryType: "actual",
    amount: total,
    entryDate: fresh.docDate ?? new Date().toISOString().slice(0, 10),
    description: `Invoice — ${fresh.vendorName ?? "vendor"}`,
    reference: fresh.docNumber ?? fresh.fileName ?? undefined,
    actor: input.actor,
  });
  if (!posted.ok) {
    await revertDocTransition(doc.id, fresh.status);
    return { ok: false, error: posted.error ?? "Couldn't post the actual." };
  }

  await audit("COST_DOC_POSTED", fresh.orgId, doc.id, input.actor, {
    vendor: fresh.vendorName, total, costAccountId: input.costAccountId,
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
