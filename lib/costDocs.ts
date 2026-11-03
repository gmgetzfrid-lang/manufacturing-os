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
// Every step can be taken back on the record: an award is undone (its
// commitment voided, the bids back to read), a posted invoice moves to the
// right budget line (old entry voided, a new one posted), and a read
// document's total, vendor and RFQ group can be corrected before money
// moves. Cost entries are voided, never deleted.

import { supabase } from "@/lib/supabase";
import { uploadToPath } from "@/lib/storage";
import { addEntry, voidEntry, listEntries, findDocEntries, type Actor, type CostEntry } from "@/lib/costs";
import { validateParsedQuote, type ParsedQuote } from "@/lib/bidTab";

/** budget = the authorization paper (AFE / estimate) a project is built
 *  from — kept for the record, never awarded or posted as spend. */
export type CostDocKind = "quote" | "invoice" | "po" | "budget";
export type CostDocStatus = "draft" | "parsed" | "awarded" | "declined" | "posted" | "void";

export const COST_DOC_STATUS_LABEL: Record<CostDocStatus, string> = {
  draft: "Uploaded - not read yet",
  parsed: "Read - awaiting your review",
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
    const g = d.rfqGroup?.trim() || `Ungrouped - ${d.vendorName ?? d.fileName ?? "quote"}`;
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
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Document not found - it may have been removed." };
  const fresh = mapDoc(row as Record<string, unknown>);
  if (!fromStatuses.includes(fresh.status)) {
    return { ok: false, error: `This document is already ${COST_DOC_STATUS_LABEL[fresh.status].toLowerCase()} - refresh to see the latest.` };
  }
  const { data: claimed, error } = await supabase.from("cost_documents")
    .update({ status: to, posted_at: new Date().toISOString(), posted_by: actorUid })
    .eq("id", docId).in("status", fromStatuses)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: "Someone else just decided this document - refresh to see the latest." };
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
    return { ok: false, error: "No readable total on this quote yet - run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: fresh.orgId, projectId: fresh.projectId,
    costAccountId: input.costAccountId,
    partyId: fresh.partyId ?? undefined,
    entryType: "commitment",
    amount: total,
    entryDate: new Date().toISOString().slice(0, 10),
    description: `Award - ${fresh.vendorName ?? "vendor"}${fresh.rfqGroup ? ` (${fresh.rfqGroup})` : ""}`,
    reference: fresh.docNumber ?? fresh.fileName ?? undefined,
    sourceDocumentId: fresh.id,
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
  if (doc.kind === "quote") return { ok: false, error: "Quotes are awarded, not posted - use Award." };
  if (doc.kind === "budget") return { ok: false, error: "A budget document sets the plan - it isn't spend to post." };

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "posted", input.actor.uid);
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;

  const total = fresh.totalAmount ?? (fresh.parsed as { total?: number } | null)?.total ?? null;
  if (total == null || !(total > 0)) {
    await revertDocTransition(doc.id, fresh.status);
    return { ok: false, error: "No readable total on this invoice yet - run the AI read (or type the total) first." };
  }

  const posted = await addEntry({
    orgId: fresh.orgId, projectId: fresh.projectId,
    costAccountId: input.costAccountId,
    partyId: fresh.partyId ?? undefined,
    entryType: "actual",
    amount: total,
    entryDate: fresh.docDate ?? new Date().toISOString().slice(0, 10),
    description: `Invoice - ${fresh.vendorName ?? "vendor"}`,
    reference: fresh.docNumber ?? fresh.fileName ?? undefined,
    sourceDocumentId: fresh.id,
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
    return { ok: false, error: "This document already moved money - void the cost entry itself if the amount is wrong." };
  }
  const { error } = await supabase.from("cost_documents").update({ status: "void" }).eq("id", doc.id);
  if (error) return { ok: false, error: error.message };
  await audit("COST_DOC_VOIDED", doc.orgId, doc.id, input.actor, { fileName: doc.fileName, vendor: doc.vendorName });
  return { ok: true };
}

/** The entries this document's award or posting made, read fresh. */
async function entriesOfDoc(doc: CostDocument): Promise<CostEntry[]> {
  return findDocEntries(doc, await listEntries(doc.orgId, doc.projectId));
}

/**
 * Take an award back: the quote goes back to read (awaiting your review),
 * the commitment it posted is voided (struck through, kept), and the bids
 * it beat in the same RFQ group come back into the comparison. Claimed
 * first, like the award, so two people can't undo it twice. Says so when
 * no commitment could be found to void (voided by hand already, or posted
 * before awards kept their link).
 */
export async function unawardQuote(input: {
  doc: CostDocument;
  siblings: CostDocument[];
  actor: Actor;
}): Promise<{ ok: boolean; error?: string; note?: string }> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only an awarded quote can be un-awarded." };
  const { data: claimed, error } = await supabase.from("cost_documents")
    .update({ status: "parsed", posted_at: null, posted_by: null })
    .eq("id", doc.id).eq("status", "awarded").select("id");
  if (error) return { ok: false, error: error.message };
  if (!claimed || claimed.length === 0) return { ok: false, error: "This quote isn't awarded any more - refresh to see the latest." };

  const found = await entriesOfDoc(doc);
  for (const e of found) {
    const v = await voidEntry({ orgId: doc.orgId, entryId: e.id, actor: input.actor });
    if (!v.ok) {
      // The money didn't come off, so the award stands and the record adds up.
      await supabase.from("cost_documents").update({ status: "awarded" }).eq("id", doc.id).then(() => undefined, () => undefined);
      return { ok: false, error: `The award stands - its commitment couldn't be voided (${v.error}).` };
    }
  }

  // The bids it beat come back: read ones to "read", never-read ones to
  // "uploaded". A rival someone voided meanwhile stays void.
  const rivals = input.siblings.filter((d) =>
    d.id !== doc.id && d.kind === "quote" && d.status === "declined" && !!doc.rfqGroup && d.rfqGroup === doc.rfqGroup);
  for (const r of rivals) {
    const back: CostDocStatus = r.parsed || (r.totalAmount ?? 0) > 0 ? "parsed" : "draft";
    await supabase.from("cost_documents").update({ status: back })
      .eq("id", r.id).eq("status", "declined")
      .then(() => undefined, () => undefined);
  }

  await audit("COST_DOC_UNAWARDED", doc.orgId, doc.id, input.actor, {
    vendor: doc.vendorName, total: doc.totalAmount, rfqGroup: doc.rfqGroup,
    voidedEntries: found.map((e) => e.id), rivalsBack: rivals.map((d) => d.vendorName ?? d.id),
  });
  return {
    ok: true,
    note: found.length === 0 ? "The award is undone. No commitment for it was found to void - check the budget line and void it there if it's still on." : undefined,
  };
}

/**
 * Move a posted invoice to the budget line it belongs on: a new actual is
 * posted on that line first, then the old one is voided (struck through,
 * kept), so the money is never missing in between. The invoice stays
 * posted; the move is on the record.
 */
export async function moveInvoiceToLine(input: {
  doc: CostDocument;
  costAccountId: string;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.status !== "posted") return { ok: false, error: "Only a posted invoice can be moved." };
  const found = await entriesOfDoc(doc);
  if (found.length !== 1) {
    return { ok: false, error: found.length === 0
      ? "Couldn't find the entry this invoice posted - move it by hand on the budget line (void it there, then post it on the right line)."
      : "This invoice posted more than one entry - move them by hand on the budget line." };
  }
  const old = found[0];
  if (old.costAccountId === input.costAccountId) return { ok: false, error: "It's already on that budget line." };
  const posted = await addEntry({
    orgId: doc.orgId, projectId: doc.projectId,
    costAccountId: input.costAccountId,
    partyId: old.partyId,
    entryType: old.entryType,
    amount: old.amount,
    entryDate: old.entryDate ?? new Date().toISOString().slice(0, 10),
    description: old.description,
    reference: old.reference,
    sourceDocumentId: doc.id,
    actor: input.actor,
  });
  if (!posted.ok) return { ok: false, error: posted.error ?? "Couldn't post it on the new line." };
  const v = await voidEntry({ orgId: doc.orgId, entryId: old.id, actor: input.actor });
  if (!v.ok) {
    // Never counted twice: take the new one back off.
    if (posted.entryId) await voidEntry({ orgId: doc.orgId, entryId: posted.entryId, actor: input.actor });
    return { ok: false, error: `Not moved - the old entry couldn't be voided (${v.error}).` };
  }
  await audit("COST_DOC_MOVED", doc.orgId, doc.id, input.actor, {
    vendor: doc.vendorName, amount: old.amount, fromAccountId: old.costAccountId, toAccountId: input.costAccountId,
    voidedEntry: old.id, newEntry: posted.entryId ?? null,
  });
  return { ok: true };
}

/** The budget line a posted invoice (or an awarded quote) sits on now. */
export function lineOfDoc(doc: CostDocument, entries: CostEntry[]): string | null {
  const found = findDocEntries(doc, entries);
  return found.length === 1 ? found[0].costAccountId : null;
}

/**
 * Correct what the AI read (or what was typed) before money moves: the
 * total, the vendor, and for a quote its RFQ group. Not on an awarded or
 * posted document - undo the award, or move the invoice, instead.
 */
export async function correctCostDoc(input: {
  doc: CostDocument;
  total?: number | null;
  vendorName?: string | null;
  rfqGroup?: string | null;
  actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.status === "awarded") return { ok: false, error: "Undo the award first, then correct it." };
  if (doc.status === "posted") return { ok: false, error: "This invoice is posted - move it to the right line, or void its entry on the budget line." };
  if (doc.status === "void") return { ok: false, error: "This document is void." };
  const patch: Record<string, unknown> = {};
  if (input.total !== undefined) {
    if (input.total == null || !Number.isFinite(input.total) || input.total <= 0) return { ok: false, error: "Enter the total as a positive number." };
    patch.total_amount = input.total;
  }
  if (input.vendorName !== undefined) patch.vendor_name = input.vendorName?.trim() || null;
  if (input.rfqGroup !== undefined && doc.kind === "quote") patch.rfq_group = input.rfqGroup?.trim() || null;
  if (Object.keys(patch).length === 0) return { ok: true };
  // A typed total makes an unread document reviewable, like "type total".
  if (doc.status === "draft" && patch.total_amount != null) patch.status = "parsed";
  // The bid comparison reads a quote's extraction: the correction goes in
  // there too, so the table shows what the person fixed (the audit keeps
  // what was read before).
  if (doc.kind === "quote" && doc.parsed && typeof doc.parsed === "object" && !Array.isArray(doc.parsed)) {
    const next: Record<string, unknown> = { ...(doc.parsed as Record<string, unknown>) };
    if (patch.total_amount != null) next.total = patch.total_amount;
    if (typeof patch.vendor_name === "string") next.vendorName = patch.vendor_name;
    patch.parsed = next;
  }
  const { data, error } = await supabase.from("cost_documents").update(patch)
    .eq("id", doc.id).in("status", ["draft", "parsed", "declined"]).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "Someone else just acted on this document - refresh to see the latest." };
  await audit("COST_DOC_CORRECTED", doc.orgId, doc.id, input.actor, {
    before: { total: doc.totalAmount, vendor: doc.vendorName, rfqGroup: doc.rfqGroup },
    after: { total: patch.total_amount, vendor: patch.vendor_name, rfqGroup: patch.rfq_group },
  });
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
  await audit("COST_DOC_MANUAL_TOTAL", input.doc.orgId, input.doc.id, input.actor, { total: input.total, vendor: input.vendorName?.trim() || null });
  return { ok: true };
}
