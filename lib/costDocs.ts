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
//
// Round G (MON-1 / MON-3 / COST-11 / COST-14): EVERY status write here is a
// compare-and-swap through claimDocTransition — void and manual-total
// included — and every compensating write is checked, so a claim that could
// not be put back is REPORTED as stuck rather than silently stuck. The two
// orphan states the claim-then-post design can produce (awarded/posted paper
// with no entry; an approved CO with no posted_entry_id) are listed by
// listLedgerOrphans and repaired by repairCostDoc — audited, never a delete.

import { supabase } from "@/lib/supabase";
import { uploadToPath, deleteFile } from "@/lib/storage";
import { addEntry, type Actor } from "@/lib/costs";
import { validateParsedQuote, type ParsedQuote } from "@/lib/bidTab";
import { emit } from "@/lib/notify/dispatch";

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
    totalAmount: r.total_amount == null || !Number.isFinite(Number(r.total_amount)) ? null : Number(r.total_amount),
    status: (r.status as CostDocStatus) ?? "draft",
    parsed: r.parsed ?? null,
    rfqGroup: (r.rfq_group as string | null) ?? null,
    intakeLinkId: (r.intake_link_id as string | null) ?? null,
    postedAt: (r.posted_at as string | null) ?? null,
    createdAt: (r.created_at as string | null) ?? null,
  };
}

/** Best-effort audit row; a failed insert is LOGGED, never discarded
 *  (COST-11 dw4 — the audit-logger finding in roles-and-permissions). */
async function audit(action: string, orgId: string, resourceId: string, actor: Actor, details: Record<string, unknown>) {
  try {
    const { error } = await supabase.from("audit_logs").insert({
      action, resource_type: "cost", resource_id: resourceId,
      org_id: orgId, user_id: actor.uid, user_email: actor.email,
      details,
    });
    if (error) console.warn(`[costDocs] audit row ${action} for ${resourceId} not written: ${error.message}`);
  } catch (e) {
    console.warn(`[costDocs] audit row ${action} for ${resourceId} threw: ${(e as Error).message}`);
  }
}

/** A human-readable status for ANY stored value (MON-8): an unmapped
 *  status reads as itself instead of throwing inside the award path. */
export function costDocStatusLabel(status: string): string {
  return COST_DOC_STATUS_LABEL[status as CostDocStatus] ?? status;
}

/** REL-2: a failed read THROWS — the Costs tab's failure state is the only
 *  honest rendering of it; an empty list would be pixel-identical to a new
 *  project (and would flip the charts into EXAMPLE mode). */
export async function listCostDocs(orgId: string, projectId: string): Promise<CostDocument[]> {
  const { data, error } = await supabase.from("cost_documents").select("*")
    .eq("org_id", orgId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(`Couldn't load quotes & invoices: ${error.message}`);
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
  if (error || !data) {
    // REL-2 dw2: the bytes went up before the row — don't leave them orphaned.
    try { await deleteFile(key); } catch { /* best effort; the orphan collector (ILIFE-1) is the backstop */ }
    return { ok: false, error: error?.message ?? "Couldn't record the document." };
  }

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
  /** Award / post stamp posted_at + posted_by; a void or a decline does not (it moved no money). */
  stampPosted = true,
): Promise<{ ok: true; fresh: CostDocument } | { ok: false; error: string }> {
  const { data: row, error: readErr } = await supabase
    .from("cost_documents").select("*").eq("id", docId).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Document not found — it may have been removed." };
  const fresh = mapDoc(row as Record<string, unknown>);
  if (!fromStatuses.includes(fresh.status)) {
    return { ok: false, error: `This document is already ${costDocStatusLabel(fresh.status).toLowerCase()} — refresh to see the latest.` };
  }
  const patch: Record<string, unknown> = stampPosted
    ? { status: to, posted_at: new Date().toISOString(), posted_by: actorUid }
    : { status: to };
  const { data: claimed, error } = await supabase.from("cost_documents")
    .update(patch)
    .eq("id", docId).in("status", fromStatuses)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: "Someone else just decided this document — refresh to see the latest." };
  }
  return { ok: true, fresh };
}

/** Revert when money failed to post after a claim — the row goes back to
 *  its prior state so a retry is clean. CHECKED (MON-1 / COST-11 dw2): a
 *  revert that fails is reported, so the caller can say the document is
 *  stuck instead of pretending the retry will be clean. */
async function revertDocTransition(docId: string, backTo: CostDocStatus, from: CostDocStatus): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.from("cost_documents")
      .update({ status: backTo, posted_at: null, posted_by: null })
      .eq("id", docId).eq("status", from)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) return { ok: false, error: "the row was not in the claimed state any more" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The message for a claim whose money failed AND whose revert failed —
 *  names the state and the id so the row can be found and repaired. */
function stuckMessage(docId: string, claimedAs: CostDocStatus, postErr: string, revertErr: string): string {
  return `The money did not post (${postErr}) AND the document could not be put back (${revertErr}) — it is stuck as ${claimedAs} with no cost entry. Document ${docId}: use "Repair" on the Costs tab to re-post or revert it.`;
}

/** COST-8: the account the money lands on must be in the document's
 *  currency. No conversion is built — a mismatch is refused, not converted
 *  at face value. Either side unstated → nothing to compare. */
async function currencyMismatch(doc: CostDocument, costAccountId: string): Promise<string | null> {
  const docCur = doc.currency?.trim().toUpperCase();
  if (!docCur) return null;
  const { data, error } = await supabase.from("cost_accounts").select("currency").eq("id", costAccountId).maybeSingle();
  if (error) return `Couldn't check the budget line's currency: ${error.message}`;
  const acctCur = ((data as { currency?: string | null } | null)?.currency ?? "").trim().toUpperCase();
  if (!acctCur || acctCur === docCur) return null;
  return `This document is in ${docCur} but the budget line is in ${acctCur} — pick a ${docCur} budget line or correct the document's currency before posting.`;
}

/** MON-12: the company behind a quote, by the party's registry link first
 *  (project_parties.company_id) and by exact name only as a fallback. */
async function companyBehind(doc: CostDocument): Promise<{ id: string; name: string; status: string } | null> {
  let companyId: string | null = null;
  if (doc.partyId) {
    const { data } = await supabase.from("project_parties").select("company_id").eq("id", doc.partyId).maybeSingle();
    companyId = ((data as { company_id?: string | null } | null)?.company_id) ?? null;
  }
  if (companyId) {
    const { data } = await supabase.from("companies").select("id, name, status").eq("id", companyId).maybeSingle();
    if (data) return data as { id: string; name: string; status: string };
  }
  const name = doc.vendorName?.trim();
  if (!name) return null;
  const { data } = await supabase.from("companies").select("id, name, status")
    .eq("org_id", doc.orgId).ilike("name", name.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(2);
  const rows = (data ?? []) as Array<{ id: string; name: string; status: string }>;
  return rows.length === 1 ? rows[0] : null;
}

/** MON-11: an award is one of the three controls-program events that
 *  notify a human. Project owner + followers, through lib/notify. */
async function notifyAward(fresh: CostDocument, total: number, actor: Actor, costAccountId: string): Promise<void> {
  try {
    const { data } = await supabase.from("projects").select("owner_user_id").eq("id", fresh.projectId).maybeSingle();
    const owner = ((data as { owner_user_id?: string | null } | null)?.owner_user_id) ?? null;
    await emit({
      orgId: fresh.orgId, category: "status", kind: "project_status",
      title: `Quote awarded — ${fresh.vendorName ?? "vendor"}`,
      body: `${fresh.vendorName ?? "A vendor"} was awarded ${fresh.rfqGroup ? `"${fresh.rfqGroup}"` : "work"} for ${total.toLocaleString()} ${fresh.currency ?? ""}`.trim() + " — the commitment is posted to the budget.",
      link: `/projects/${fresh.projectId}?tab=costs`,
      resource: { type: "project", id: fresh.projectId },
      actorUserId: actor.uid, actorName: actor.email?.split("@")[0] ?? undefined,
      audience: { involved: owner ? [owner] : [], followers: true },
      metadata: { costDocId: fresh.id, costAccountId },
    });
  } catch (e) {
    console.warn(`[costDocs] award notice not sent: ${(e as Error).message}`);
  }
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
  /** MON-12: awarding a company flagged do-not-use (or inactive) is refused
   *  unless a reason is given here; the override is audited by company id. */
  overrideReason?: string | null;
}): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only quotes can be awarded." };

  // Refusals that move nothing come BEFORE the claim.
  const mismatch = await currencyMismatch(doc, input.costAccountId);
  if (mismatch) return { ok: false, error: mismatch };
  const company = await companyBehind(doc);
  const flagged = company && (company.status === "do_not_use" || company.status === "inactive");
  const override = input.overrideReason?.trim() || null;
  if (flagged && !override) {
    return {
      ok: false,
      error: company.status === "do_not_use"
        ? `${company.name} is flagged DO NOT USE in the company registry. Awarding it needs an explicit override with a reason, which goes on the audit trail.`
        : `${company.name} is marked inactive in the company registry. Awarding it needs an explicit override with a reason, which goes on the audit trail.`,
    };
  }

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "awarded", input.actor.uid);
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;

  // total_amount is the human-visible number (AI-written at parse, or typed
  // via setManualTotal) — it outranks the stored extraction.
  const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total;
  if (total == null || !(total > 0)) {
    const back = await revertDocTransition(doc.id, fresh.status, "awarded");
    const base = "No readable total on this quote yet — run the AI read (or type the total) first.";
    return { ok: false, error: back.ok ? base : stuckMessage(doc.id, "awarded", base, back.error ?? "unknown") };
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
    sourceDocumentId: doc.id,
    actor: input.actor,
  });
  if (!posted.ok) {
    const postErr = posted.error ?? "Couldn't post the commitment.";
    const back = await revertDocTransition(doc.id, fresh.status, "awarded");
    return { ok: false, error: back.ok ? postErr : stuckMessage(doc.id, "awarded", postErr, back.error ?? "unknown") };
  }

  if (flagged && override) {
    await audit("COST_DOC_AWARD_OVERRIDE", fresh.orgId, doc.id, input.actor, {
      companyId: company.id, companyName: company.name, companyStatus: company.status, reason: override,
    });
  }

  // Rivals (MON-10): every still-open quote in the SAME RFQ group becomes
  // "not selected". An UNGROUPED award declines nothing on its own —
  // ungrouped quotes tabulate alone (quoteGroups gives each its own
  // "Ungrouped — <vendor>" heading) and may be for unrelated work, so the
  // caller is TOLD which other ungrouped quotes stay open and declines the
  // ones that competed through declineQuote. The DB-side status guard means
  // a rival someone awarded meanwhile is never clobbered. CHECKED (COST-11):
  // a failed decline is a partial outcome the caller hears about, never an
  // unconditional success.
  const open = (d: CostDocument) =>
    d.id !== doc.id && d.kind === "quote" && (d.status === "draft" || d.status === "parsed");
  const rivals = fresh.rfqGroup ? input.siblings.filter((d) => open(d) && d.rfqGroup === fresh.rfqGroup) : [];
  const ungroupedOpen = fresh.rfqGroup ? [] : input.siblings.filter((d) => open(d) && !d.rfqGroup);
  const warnings: string[] = [];
  let declined = 0;
  if (rivals.length > 0) {
    const { data: hit, error } = await supabase.from("cost_documents").update({ status: "declined" })
      .in("id", rivals.map((d) => d.id))
      .in("status", ["draft", "parsed"])
      .select("id");
    declined = hit?.length ?? 0;
    if (error || declined < rivals.length) {
      warnings.push(`Awarded, but ${rivals.length - declined} of ${rivals.length} competing bid(s) could not be marked not-selected${error ? ` (${error.message})` : ""} — refresh and decline them by hand.`);
    }
  }
  if (ungroupedOpen.length > 0) {
    const names = ungroupedOpen.map((d) => d.vendorName ?? d.fileName ?? "quote");
    warnings.push(`Awarded. ${ungroupedOpen.length} other ungrouped quote${ungroupedOpen.length === 1 ? "" : "s"} stay${ungroupedOpen.length === 1 ? "s" : ""} open (${names.join(", ")}) — decline ${ungroupedOpen.length === 1 ? "it" : "them"} if ${ungroupedOpen.length === 1 ? "it" : "they"} competed for this scope.`);
  }

  await audit("COST_DOC_AWARDED", fresh.orgId, doc.id, input.actor, {
    vendor: fresh.vendorName, total, rfqGroup: fresh.rfqGroup, rivalsConsidered: rivals.map((d) => d.vendorName ?? d.id),
    rivalsDeclined: declined, ungroupedLeftOpen: ungroupedOpen.length,
    costAccountId: input.costAccountId, postedEntryId: posted.entryId ?? null,
    companyId: company?.id ?? null, override,
  });
  await notifyAward(fresh, total, input.actor, input.costAccountId);
  return warnings.length ? { ok: true, warning: warnings.join(" ") } : { ok: true };
}

/** MON-10: decline a quote by hand — the explicit, audited "not selected"
 *  for an ungrouped bid that competed with an award (an ungrouped award
 *  declines nothing on its own; awardQuote's warning names the quotes that
 *  stay open). draft|parsed → declined through the same compare-and-swap as
 *  every other status write; no posted_at stamp (it moved no money). */
export async function declineQuote(input: {
  doc: CostDocument; actor: Actor; reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only quotes are declined — void an invoice that should not post." };
  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "declined", input.actor.uid, false);
  if (!claim.ok) return { ok: false, error: claim.error };
  await audit("COST_DOC_DECLINED", claim.fresh.orgId, doc.id, input.actor, {
    vendor: claim.fresh.vendorName, rfqGroup: claim.fresh.rfqGroup, reason: input.reason?.trim() || null,
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
  const mismatch = await currencyMismatch(doc, input.costAccountId);
  if (mismatch) return { ok: false, error: mismatch };

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "posted", input.actor.uid);
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;

  const total = fresh.totalAmount ?? (fresh.parsed as { total?: number } | null)?.total ?? null;
  if (total == null || !(total > 0)) {
    const back = await revertDocTransition(doc.id, fresh.status, "posted");
    const base = "No readable total on this invoice yet — run the AI read (or type the total) first.";
    return { ok: false, error: back.ok ? base : stuckMessage(doc.id, "posted", base, back.error ?? "unknown") };
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
    sourceDocumentId: doc.id,
    actor: input.actor,
  });
  if (!posted.ok) {
    const postErr = posted.error ?? "Couldn't post the actual.";
    const back = await revertDocTransition(doc.id, fresh.status, "posted");
    return { ok: false, error: back.ok ? postErr : stuckMessage(doc.id, "posted", postErr, back.error ?? "unknown") };
  }

  await audit("COST_DOC_POSTED", fresh.orgId, doc.id, input.actor, {
    vendor: fresh.vendorName, total, costAccountId: input.costAccountId, postedEntryId: posted.entryId ?? null,
  });
  return { ok: true };
}

const MOVED_MONEY = "This document already moved money — void the cost entry itself if the amount is wrong.";

/** The statuses that moved no money — the only ones a void or a typed
 *  total may touch (MON-3 / COST-14). `declined` is here: a bid that was
 *  not selected moved nothing, and a wrongly declined or junk document
 *  needs a terminal (void) and a correction (total) path. */
const MOVED_NO_MONEY: CostDocStatus[] = ["draft", "parsed", "declined"];

/** Void an unposted document. Awarded/posted paper stays — void the cost
 *  entry instead if the money itself was wrong. MON-3 / COST-14: the
 *  decision is made against the DATABASE row through claimDocTransition
 *  (draft|parsed|declined → void), never against the caller's snapshot. */
export async function voidCostDoc(input: { doc: CostDocument; actor: Actor }): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.status === "awarded" || doc.status === "posted") return { ok: false, error: MOVED_MONEY };
  const claim = await claimDocTransition(doc.id, MOVED_NO_MONEY, "void", input.actor.uid, false);
  if (!claim.ok) return { ok: false, error: claim.error };
  await audit("COST_DOC_VOIDED", doc.orgId, doc.id, input.actor, { fileName: claim.fresh.fileName, vendor: claim.fresh.vendorName });
  return { ok: true };
}

/** Manual total entry for when the AI can't read a scan — the human types
 *  what the paper says, and that becomes the awardable number. MON-3 /
 *  COST-14: only a document that moved no money takes a new total — each
 *  UPDATE carries its status predicate and a zero-row match is reported
 *  with the row's real status, re-read. A draft/parsed document becomes
 *  (stays) parsed; a DECLINED bid takes the corrected total for its
 *  tabulation and stays declined — a correction is not a reopen. */
export async function setManualTotal(input: {
  doc: CostDocument; total: number; vendorName?: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(input.total) || input.total <= 0) return { ok: false, error: "Enter the document's total as a positive number." };
  if (input.doc.status === "awarded" || input.doc.status === "posted") return { ok: false, error: MOVED_MONEY };
  const patch: Record<string, unknown> = { total_amount: input.total };
  if (input.vendorName?.trim()) patch.vendor_name = input.vendorName.trim();
  const open = await supabase.from("cost_documents").update({ ...patch, status: "parsed" })
    .eq("id", input.doc.id).in("status", ["draft", "parsed"]).select("id");
  if (open.error) return { ok: false, error: open.error.message };
  let hit = open.data ?? [];
  if (hit.length === 0) {
    const dec = await supabase.from("cost_documents").update(patch)
      .eq("id", input.doc.id).eq("status", "declined").select("id");
    if (dec.error) return { ok: false, error: dec.error.message };
    hit = dec.data ?? [];
  }
  if (hit.length === 0) {
    const { data: row } = await supabase.from("cost_documents").select("status").eq("id", input.doc.id).maybeSingle();
    const status = (row as { status?: string } | null)?.status;
    return {
      ok: false,
      error: status
        ? `This document is already ${costDocStatusLabel(status).toLowerCase()} — its total is locked. Refresh to see the latest.`
        : "Someone else just decided this document — refresh to see the latest.",
    };
  }
  await audit("COST_DOC_MANUAL_TOTAL", input.doc.orgId, input.doc.id, input.actor, { total: input.total });
  return { ok: true };
}

// ── reconciliation + repair (MON-1 / COST-11 dw3 — GAP-406's repair path) ──

export interface LedgerOrphans {
  /** awarded / posted documents with NO cost entry pointing at them. An
   *  entry that was voided by hand still counts as attended: voiding the
   *  entry is the documented correction for a wrong amount (MOVED_MONEY). */
  docs: CostDocument[];
  /** approved change orders whose posted_entry_id is null. */
  changeOrders: Array<{ id: string; coNumber: string; title: string; amount: number }>;
}

/** The two orphan states the claim-then-post design can produce. Read-only;
 *  the SQL view `cost_ledger_orphans` (20261093) answers the same question
 *  from the database side. A document whose linked entry exists in ANY
 *  status is attended — its entry was posted and, if void, voided on
 *  purpose — so it is never offered a re-post of its locked total. A failed
 *  read throws (REL-2). */
export async function listLedgerOrphans(orgId: string, projectId: string): Promise<LedgerOrphans> {
  const [docsRes, entriesRes, cosRes] = await Promise.all([
    supabase.from("cost_documents").select("*").eq("org_id", orgId).eq("project_id", projectId)
      .in("status", ["awarded", "posted"]).limit(500),
    supabase.from("cost_entries").select("source_document_id").eq("org_id", orgId).eq("project_id", projectId)
      .not("source_document_id", "is", null).limit(2000),
    supabase.from("change_orders").select("id, co_number, title, amount").eq("org_id", orgId).eq("project_id", projectId)
      .eq("status", "approved").is("posted_entry_id", null).limit(500),
  ]);
  const failed = docsRes.error ?? entriesRes.error ?? cosRes.error;
  if (failed) throw new Error(`Couldn't check the ledger for orphans: ${failed.message}`);
  const linked = new Set(((entriesRes.data ?? []) as Array<{ source_document_id: string | null }>).map((r) => r.source_document_id));
  const docs = ((docsRes.data ?? []) as Array<Record<string, unknown>>).map(mapDoc).filter((d) => !linked.has(d.id));
  const changeOrders = ((cosRes.data ?? []) as Array<{ id: string; co_number: string; title: string; amount: unknown }>).map((r) => ({
    id: r.id, coNumber: r.co_number, title: r.title, amount: Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0,
  }));
  return { docs, changeOrders };
}

/**
 * Repair an awarded/posted document that has no cost entry (a post that
 * failed after the claim). Two audited actions, never a delete:
 *   re-post — posts the missing commitment (quote) / actual (invoice) with
 *             the document as its source, so the paper and the ledger agree;
 *   revert  — puts the document back to parsed/draft so it can be decided
 *             again (rivals it declined stay declined; decide them by hand).
 * Controller / owner writes only (RLS); the entry check is re-done here so
 * a repair on a document that has since been made whole is refused. A
 * document whose linked entry was VOIDED by hand is not re-posted (the void
 * was the correction, and its total is locked); it may still be reverted,
 * since no money of its own remains on the ledger.
 */
export async function repairCostDoc(input: {
  doc: CostDocument; action: "repost" | "revert"; costAccountId?: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: row, error: readErr } = await supabase.from("cost_documents").select("*").eq("id", input.doc.id).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr?.message ?? "Document not found — it may have been removed." };
  const fresh = mapDoc(row as Record<string, unknown>);
  if (fresh.status !== "awarded" && fresh.status !== "posted") {
    return { ok: false, error: `This document is ${costDocStatusLabel(fresh.status).toLowerCase()} — nothing to repair.` };
  }
  const { data: linked, error: linkErr } = await supabase.from("cost_entries").select("id, status")
    .eq("source_document_id", fresh.id).limit(50);
  if (linkErr) return { ok: false, error: linkErr.message };
  const links = (linked ?? []) as Array<{ id: string; status: string | null }>;
  if (links.some((e) => e.status === "posted")) return { ok: false, error: "This document already has its cost entry — nothing to repair. Refresh." };

  if (input.action === "repost") {
    if (links.length > 0) {
      return { ok: false, error: "This document's cost entry was voided by hand — that void was the correction, so its locked total is not re-posted. Post the corrected amount on the budget line instead." };
    }
    if (!input.costAccountId) return { ok: false, error: "Pick the budget line the money posts to." };
    const mismatch = await currencyMismatch(fresh, input.costAccountId);
    if (mismatch) return { ok: false, error: mismatch };
    const total = fresh.totalAmount ?? parsedQuoteFrom(fresh)?.total ?? (fresh.parsed as { total?: number } | null)?.total ?? null;
    if (total == null || !(total > 0)) return { ok: false, error: "No readable total on this document — type the total first, or revert it." };
    const isQuote = fresh.kind === "quote";
    const posted = await addEntry({
      orgId: fresh.orgId, projectId: fresh.projectId, costAccountId: input.costAccountId,
      partyId: fresh.partyId ?? undefined,
      entryType: isQuote ? "commitment" : "actual",
      amount: total,
      entryDate: (isQuote ? null : fresh.docDate) ?? new Date().toISOString().slice(0, 10),
      description: `${isQuote ? "Award" : "Invoice"} — ${fresh.vendorName ?? "vendor"}${isQuote && fresh.rfqGroup ? ` (${fresh.rfqGroup})` : ""} (re-posted)`,
      reference: fresh.docNumber ?? fresh.fileName ?? undefined,
      sourceDocumentId: fresh.id,
      actor: input.actor,
    });
    if (!posted.ok) return { ok: false, error: posted.error ?? "Couldn't re-post the entry." };
    await audit("COST_DOC_REPAIRED", fresh.orgId, fresh.id, input.actor, {
      action: "repost", status: fresh.status, total, costAccountId: input.costAccountId, postedEntryId: posted.entryId ?? null,
    });
    return { ok: true };
  }

  const backTo: CostDocStatus = fresh.totalAmount != null || fresh.parsed ? "parsed" : "draft";
  const back = await revertDocTransition(fresh.id, backTo, fresh.status);
  if (!back.ok) return { ok: false, error: `Couldn't revert the document: ${back.error}` };
  await audit("COST_DOC_REPAIRED", fresh.orgId, fresh.id, input.actor, { action: "revert", from: fresh.status, to: backTo });
  return { ok: true };
}
