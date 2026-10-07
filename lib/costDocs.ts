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
// with no entry; an approved CO whose entry is missing or void) are listed by
// listLedgerOrphans and repaired by repairCostDoc / changeOrders'
// repairChangeOrder — audited, never a delete. Entries posted before Round G
// carry no source_document_id: an unlinked entry of the award/invoice shape
// ("Award — …" / "Invoice — …", the document's reference) attends its
// document, so legacy paper is never offered a second post.
//
// Every pre-write refusal (currency, company registry, read extent) runs
// against the row as RE-READ inside claimDocTransition, before the claim's
// UPDATE — never against the caller's snapshot. These refusals run in the
// caller's session (lib code, not a database rail).

import { supabase } from "@/lib/supabase";
import { uploadToPath, deleteFile } from "@/lib/storage";
import { addEntry, type Actor } from "@/lib/costs";
import { validateParsedQuote, normalizeCompanyName, UNKNOWN_VENDOR, type ParsedQuote } from "@/lib/bidTab";
import { emit } from "@/lib/notify/dispatch";
import { userFacingError, userFacingReadError, userFacingCaughtError, asClause } from "@/lib/userFacingError";

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
  if (error) throw new Error(`Couldn't load quotes & invoices: ${userFacingReadError(error, "listCostDocs")}`);
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
    return { ok: false, error: `File upload failed: ${userFacingError(e, { context: "uploadCostDoc storage" })}` };
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
    return { ok: false, error: error ? userFacingError(error, { context: "uploadCostDoc" }) : "Couldn't record the document." };
  }

  const doc = mapDoc(data as Record<string, unknown>);
  // COST-3 (DEC-48, J12 line): the upload never links the bid to a Known
  // Company — a stored link is a person's (the bid-row picker); a machine's
  // would clear a do-not-use look-alike added later (lib/costDocParse).
  await audit("COST_DOC_UPLOADED", input.orgId, doc.id, input.actor, {
    kind: input.kind, fileName: input.file.name, rfqGroup: input.rfqGroup ?? null, vendor: input.vendorName ?? null,
  });
  return { ok: true, doc };
}

/** The AI's extraction as a renderable ParsedQuote, or null when the doc
 *  hasn't been read (or the stored payload no longer validates). Vendor
 *  identity falls back to the row's own columns.
 *
 *  BID-1 dw1 (one number drives display and award): the returned `total` is
 *  the EXTRACTION, deliberately not overlaid with `doc.totalAmount` — the
 *  bid tab (J4) shows "corrected by hand from the AI's X" from exactly this
 *  value. The overlay lives at the consumer: J4's `withHumanTotal(q,
 *  doc.totalAmount)` (lib/bidTab.ts) is the accepted contract, and every
 *  consumer that shows a total must apply it. The money paths below post
 *  `total_amount ?? extraction` — the same number `withHumanTotal` shows. */
export function parsedQuoteFrom(doc: CostDocument): ParsedQuote | null {
  if (!doc.parsed) return null;
  try {
    const q = validateParsedQuote(doc.parsed, doc.id);
    if (q.vendorName === UNKNOWN_VENDOR && doc.vendorName) q.vendorName = doc.vendorName;
    return q;
  } catch {
    return null;
  }
}

/** Quotes grouped for bid tabulation: rfq_group label → its competing bids.
 *  Ungrouped quotes tabulate alone under their own name. BID-10: the
 *  grouping KEY is case-folded and whitespace-collapsed (rfqKey — the key
 *  the award's rival decline and the bid tab's merge use), so "Unit 300
 *  Repipe" and "unit 300 repipe " are ONE field, labelled with the first
 *  spelling seen. The coach's unawarded-field count (lib/projectSnapshot)
 *  reads this, so it counts what the bid tab shows. */
export function quoteGroups(docs: CostDocument[]): Array<{ group: string; docs: CostDocument[] }> {
  const live = docs.filter((d) => d.kind === "quote" && d.status !== "void");
  const by = new Map<string, { group: string; docs: CostDocument[] }>();
  for (const d of live) {
    const label = d.rfqGroup?.trim() || `Ungrouped — ${d.vendorName ?? d.fileName ?? "quote"}`;
    const key = rfqKey(label);
    const cur = by.get(key);
    if (cur) cur.docs.push(d); else by.set(key, { group: label, docs: [d] });
  }
  return [...by.values()];
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
  /** A refusal decided against the RE-READ row (typed + raw, so columns a
   *  later migration adds are visible), run before the UPDATE: a non-null
   *  string refuses the claim and nothing is written. */
  guard?: (fresh: CostDocument, raw: Record<string, unknown>) => Promise<string | null>,
): Promise<{ ok: true; fresh: CostDocument; raw: Record<string, unknown> } | { ok: false; error: string }> {
  const { data: row, error: readErr } = await supabase
    .from("cost_documents").select("*").eq("id", docId).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr ? userFacingReadError(readErr, "claimDocTransition") : "Document not found — it may have been removed." };
  const raw = row as Record<string, unknown>;
  const fresh = mapDoc(raw);
  if (!fromStatuses.includes(fresh.status)) {
    return { ok: false, error: `This document is already ${costDocStatusLabel(fresh.status).toLowerCase()} — refresh to see the latest.` };
  }
  if (guard) {
    const refusal = await guard(fresh, raw);
    if (refusal) return { ok: false, error: refusal };
  }
  const patch: Record<string, unknown> = stampPosted
    ? { status: to, posted_at: new Date().toISOString(), posted_by: actorUid }
    : { status: to };
  const { data: claimed, error } = await supabase.from("cost_documents")
    .update(patch)
    .eq("id", docId).in("status", fromStatuses)
    .select("id");
  if (error) return { ok: false, error: userFacingError(error, { context: "claimDocTransition" }) };
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: "Someone else just decided this document — refresh to see the latest." };
  }
  return { ok: true, fresh, raw };
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
    if (error) return { ok: false, error: userFacingError(error, { context: "revertDocTransition" }) };
    if (!data || data.length === 0) return { ok: false, error: "the row was not in the claimed state any more" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: userFacingCaughtError(e, { context: "revertDocTransition" }) };
  }
}

/** The message for a claim whose money failed AND whose revert failed —
 *  names the state and the id so the row can be found and repaired. */
function stuckMessage(docId: string, claimedAs: CostDocStatus, postErr: string, revertErr: string): string {
  return `The money did not post (${asClause(postErr)}) AND the document could not be put back (${asClause(revertErr)}) — it is stuck as ${claimedAs} with no cost entry. Document ${docId}: use "Repair" on the Costs tab to re-post or revert it.`;
}

/** A stored currency as an ISO-4217-shaped code, or null when unstated or
 *  not a code (COST-8 minor): the base parse route stored the model's free
 *  text, so "$" / "US$" are read as USD and anything else that is not three
 *  letters counts as unstated rather than stranding the document. */
export function normalizeCurrency(value: string | null | undefined): string | null {
  const s = (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  if (s === "$" || s === "US$" || s === "USD$" || s === "$US") return "USD";
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

/** COST-8: the account the money lands on must be in the document's
 *  currency. No conversion is built — a mismatch is refused, not converted
 *  at face value. An unstated (or non-code) document currency has nothing
 *  to compare; an account with no currency is USD, exactly as the Costs tab
 *  renders it. */
async function currencyMismatch(doc: CostDocument, costAccountId: string): Promise<string | null> {
  const docCur = normalizeCurrency(doc.currency);
  if (!docCur) return null;
  const { data, error } = await supabase.from("cost_accounts").select("currency").eq("id", costAccountId).maybeSingle();
  if (error) return `Couldn't check the budget line's currency: ${userFacingReadError(error, "currencyMismatch")}`;
  const acctCur = normalizeCurrency((data as { currency?: string | null } | null)?.currency) ?? "USD";
  if (acctCur === docCur) return null;
  return `This document is in ${docCur} but the budget line is in ${acctCur} — pick a ${docCur} budget line or correct the document's currency before posting.`;
}

type CompanyRow = { id: string; name: string; status: string };

/** The registry statuses an award must answer for (MON-12) on the company
 *  the quote is BOUND to (its own link, its contractor's, or its one exact
 *  name): `inactive` has the same behaviour as `do_not_use` — refused
 *  without a typed override. A look-alike the quote is not bound to counts
 *  only when it is `do_not_use` (DEC-48's gate). */
const FLAGGED_COMPANY_STATUSES = ["do_not_use", "inactive"];

/** MON-12 / DEC-48: the company behind a quote, as two answers.
 *  - `company` — the registry row the quote BINDS to, which the award
 *    records: the document's own registry link first (cost_documents.company_id,
 *    J4's 20261096 column, read from the raw row so it is simply absent
 *    before that migration), then the party's (project_parties.company_id),
 *    then an exact name with a single match. Binding refuses ambiguity.
 *  - `barred` — the flagged (do-not-use / inactive) row the award must ANSWER
 *    FOR: the document's own link decides, flagged or not (a person chose it
 *    on the bid row); the contractor's link answers for its company's own
 *    flag, but an unflagged one never hides a do-not-use look-alike — the
 *    intake door files a quote against the contractor it matched by name
 *    (app/api/intake/upload, nobody choosing), and the bid tab's chip reads
 *    only the document's own link; then ANY do-not-use registry row the
 *    vendor name normalises to (lib/bidTab `normalizeCompanyName`, the bid
 *    tab's `barredCompanyFor` gate, DEC-48), else the bound company itself
 *    when it is flagged. Gating does not refuse ambiguity — it fails toward
 *    the flag, so "Gulf Mechanical Inc" answers for a do-not-use "Gulf
 *    Mechanical, Inc." it does not bind to. An INACTIVE look-alike the
 *    quote does not bind to is not the bid's (the bid tab never flags it;
 *    a registry de-duplicated by marking the old row inactive leaves one
 *    beside the active row the bid binds to).
 *  20261157's `cost_doc_company_behind` / `cost_doc_company_barred` are the
 *  same two rules in SQL (the rail and `award_quote` read them as the
 *  database's own check). A link counts only to a company of the document's
 *  own org (the rail reads as the definer, so it checks the same).
 *  Any failed read is an ERROR, never "no company": the refusal must not
 *  pass silently because a lookup timed out. */
async function companyBehind(doc: CostDocument, raw: Record<string, unknown>): Promise<{ company: CompanyRow | null; barred: CompanyRow | null; error?: string }> {
  const flaggedOrNull = (c: CompanyRow): CompanyRow | null => (FLAGGED_COMPANY_STATUSES.includes(c.status) ? c : null);
  const byId = async (id: string): Promise<{ company: CompanyRow | null; error?: string }> => {
    const { data, error } = await supabase.from("companies").select("id, name, status").eq("id", id).eq("org_id", doc.orgId).maybeSingle();
    if (error) return { company: null, error: userFacingReadError(error, "companyBehind") };
    return { company: (data as CompanyRow | null) ?? null };
  };
  const docCompanyId = (raw.company_id as string | null | undefined) ?? null;
  if (docCompanyId) {
    const hit = await byId(docCompanyId);
    if (hit.error) return { company: null, barred: null, error: hit.error };
    if (hit.company) return { company: hit.company, barred: flaggedOrNull(hit.company) };
  }
  if (doc.partyId) {
    const { data, error } = await supabase.from("project_parties").select("company_id").eq("id", doc.partyId).maybeSingle();
    if (error) return { company: null, barred: null, error: userFacingReadError(error, "companyBehind") };
    const partyCompanyId = ((data as { company_id?: string | null } | null)?.company_id) ?? null;
    if (partyCompanyId) {
      const hit = await byId(partyCompanyId);
      if (hit.error) return { company: null, barred: null, error: hit.error };
      if (hit.company) {
        // A flagged contractor company answers; an unflagged one binds but
        // never clears a do-not-use look-alike (20261157 cost_doc_company_barred).
        const flagged = flaggedOrNull(hit.company);
        if (flagged) return { company: hit.company, barred: flagged };
        const lookAlike = await flaggedLookAlike(doc.orgId, doc.vendorName ?? "");
        if (lookAlike.error) return { company: null, barred: null, error: lookAlike.error };
        return { company: hit.company, barred: lookAlike.company };
      }
    }
  }
  const name = doc.vendorName?.trim();
  if (!name) return { company: null, barred: null };
  const { data, error } = await supabase.from("companies").select("id, name, status")
    .eq("org_id", doc.orgId).ilike("name", name.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(2);
  if (error) return { company: null, barred: null, error: userFacingReadError(error, "companyBehind") };
  const rows = (data ?? []) as CompanyRow[];
  const bound = rows.length === 1 ? rows[0] : null;
  const lookAlike = await flaggedLookAlike(doc.orgId, doc.vendorName ?? "");
  if (lookAlike.error) return { company: null, barred: null, error: lookAlike.error };
  return { company: bound, barred: lookAlike.company ?? (bound ? flaggedOrNull(bound) : null) };
}

/** MON-12's gate for a bid nobody has linked: ANY do-not-use registry row
 *  of the org whose name normalises to the vendor's (`normalizeCompanyName`;
 *  20261157's `company_name_key` is the same rule; DEC-48 and the bid tab's
 *  `barredCompanyFor` flag do-not-use look-alikes only), the exact name
 *  first so the refusal names the bound company when that one is barred,
 *  then by id in byte order — `cost_doc_company_barred`'s own order
 *  (exact name as `lower(btrim(vendor))`, which trims spaces only; then
 *  `c.id`), with no collation in either, so the lib's prompt
 *  (`needsOverride`) and the override row `award_quote` writes name the
 *  same company. The bid tab's own prompt and intent row ask the award's
 *  question at the click (components/projects/cost/QuotesPanel.tsx
 *  `companyAwardAnswersFor`: `cost_doc_company_barred` itself once 20261157
 *  is applied; before it this function's order through lib/bidTab.ts
 *  `barredCompanyFor`, over the STORED vendor name — J12 review fix pass 7.
 *  Pass 6 ordered `barredCompanyFor` this way but the panel still fed it the
 *  letterhead the AI read, so it could name another look-alike).
 *  The read is narrowed server-side to the org's do-not-use rows whose name
 *  holds the key's longest word — every word of the key except "and"
 *  (which may stand for "&") appears, case aside, in the name as written —
 *  and paged past PostgREST's 1,000-row answer. */
async function flaggedLookAlike(orgId: string, vendorName: string): Promise<{ company: CompanyRow | null; error?: string }> {
  const key = normalizeCompanyName(vendorName);
  if (!key) return { company: null };
  const word = key.split(" ").filter((w) => w !== "and").sort((a, b) => b.length - a.length)[0] ?? null;
  const exact = vendorName.replace(/^ +| +$/g, "").toLowerCase();
  const hits: CompanyRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("companies").select("id, name, status").eq("org_id", orgId).eq("status", "do_not_use");
    if (word) q = q.ilike("name", `%${word}%`);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) return { company: null, error: userFacingReadError(error, "companyBehind") };
    const rows = (data ?? []) as CompanyRow[];
    hits.push(...rows.filter((c) => normalizeCompanyName(c.name) === key));
    if (rows.length < 1000) break;
  }
  hits.sort((a, b) => Number(b.name.toLowerCase() === exact) - Number(a.name.toLowerCase() === exact) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { company: hits[0] ?? null };
}

/** The RFQ group as a grouping KEY — case-folded, whitespace collapsed —
 *  the same key the bid tab tabulates by (J4's `rfqGroupKey`), so a bid the
 *  table shows as a rival is the bid the award declines. */
function rfqKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** COST-13 posting limb: how much of the document the AI read, from the
 *  raw row. `recorded` is false before J4's 20261096 adds the columns — the
 *  brief's "no-op until the columns exist"; once they exist a NULL is
 *  UNKNOWN, and unknown fails safe (it needs the typed confirmation). */
function readExtentOf(raw: Record<string, unknown>): { recorded: boolean; pagesRead: number | null; pagesTotal: number | null } {
  const recorded = "pages_total" in raw || "pages_read" in raw;
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return { recorded, pagesRead: n(raw.pages_read), pagesTotal: n(raw.pages_total) };
}

/** The total that would post and the AI's reading of it (null when the AI
 *  read no total — the row's total was typed by hand with nothing read). */
function postableTotal(fresh: CostDocument): { total: number | null; extracted: number | null } {
  const extracted = fresh.kind === "quote"
    ? parsedQuoteFrom(fresh)?.total ?? null
    : (() => { const t = Number((fresh.parsed as { total?: unknown } | null)?.total); return Number.isFinite(t) && t > 0 ? t : null; })();
  return { total: fresh.totalAmount ?? extracted, extracted };
}

/** COST-13: the typed-back confirmation is EXPLICIT. When the AI read this
 *  document and the read was truncated (or, once the extent is recordable,
 *  of unknown extent), the total posts only with `confirmedTotal` — the
 *  figure the user typed from the paper — equal to the row's total in whole
 *  units. Whether that total equals the extraction or was corrected by hand
 *  does not matter: the lib no longer infers "typed" from "differs from the
 *  AI" (a typed-back figure equal to the extraction used to read as "from
 *  the read" and could never post). A `confirmedTotal` that differs from the
 *  row's total is refused whatever the extent — the paper and the row
 *  disagree. No refusal: extent not recorded (before 20261096), a full
 *  read, or no AI total at all (nothing was read to be incomplete). */
function extentRefusal(fresh: CostDocument, raw: Record<string, unknown>, confirmedTotal: number | null | undefined): string | null {
  const { total, extracted } = postableTotal(fresh);
  if (total == null || !(total > 0)) return null;   // the no-total refusal follows the claim
  if (confirmedTotal != null && (!Number.isFinite(confirmedTotal) || Math.round(confirmedTotal) !== Math.round(total))) {
    return confirmMismatchMessage(confirmedTotal, total);
  }
  if (extracted == null) return null;
  const ext = readExtentOf(raw);
  if (!ext.recorded) return null;
  const truncated = ext.pagesRead != null && ext.pagesTotal != null && ext.pagesRead < ext.pagesTotal;
  const unknown = ext.pagesRead == null || ext.pagesTotal == null;
  if (!truncated && !unknown) return null;
  if (confirmedTotal != null) return null;   // typed back and equal (checked above)
  return extentMessage(ext.pagesRead, ext.pagesTotal, total);
}

/** COST-13's two sentences — the lib's guard and 20261157 `award_quote`'s
 *  re-check under its lock (`confirm_mismatch`, `extent`) say the same. */
function confirmMismatchMessage(confirmedTotal: number, total: number): string {
  return `The confirmed total (${Number.isFinite(confirmedTotal) ? confirmedTotal.toLocaleString() : String(confirmedTotal)}) doesn't match the stored total (${total.toLocaleString()}) — correct the total first if the paper says something else.`;
}
function extentMessage(pagesRead: number | null, pagesTotal: number | null, total: number): string {
  const shown = total.toLocaleString();
  return pagesRead != null && pagesTotal != null && pagesRead < pagesTotal
    ? `The AI read only pages 1–${pagesRead} of ${pagesTotal} of this document, so its total (${shown}) may come from an incomplete read. Type the total from the paper to confirm it (correct the row's total first if the paper says something else).`
    : `How much of this document the AI read is unknown, so its total (${shown}) may come from an incomplete read. Type the total from the paper to confirm it (correct the row's total first if the paper says something else).`;
}

/** The reference an award / invoice entry carried before Round G (and
 *  still carries): the document number, else the file name. */
function docReference(d: CostDocument): string | null {
  const ref = (d.docNumber ?? d.fileName ?? "").trim();
  return ref || null;
}

type LegacyEntry = { id: string; project_id?: string | null; entry_type?: string | null; reference?: string | null; description?: string | null; status?: string | null };

/** Does an UNLINKED entry of the award/invoice shape stand for this
 *  document? Pre-Round-G posts never wrote source_document_id, so such an
 *  entry (any status — a hand-voided one was the correction) means the
 *  document's money reached the ledger; it must never be re-posted. */
function legacyShapeMatches(d: CostDocument, e: LegacyEntry): boolean {
  const ref = docReference(d);
  if (!ref || (e.reference ?? "").trim() !== ref) return false;
  if (d.kind === "quote") return e.entry_type === "commitment" && (e.description ?? "").startsWith("Award — ");
  return e.entry_type === "actual" && (e.description ?? "").startsWith("Invoice — ");
}

/** Reads `.in(column, values)` in chunks so a large project never builds
 *  one oversized request URL (and never silently truncates at a cap). */
async function selectIn<T>(
  build: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  values: string[],
): Promise<{ rows: T[]; error?: string }> {
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += 100) {
    const { data, error } = await build(values.slice(i, i + 100));
    if (error) return { rows, error: userFacingReadError(error, "listOrphans") };
    rows.push(...((data ?? []) as T[]));
  }
  return { rows };
}

/** Unlinked award/invoice-shaped entries in the project whose reference is
 *  one of these documents' references. */
async function unlinkedLegacyEntries(projectId: string, docs: CostDocument[]): Promise<{ rows: LegacyEntry[]; error?: string }> {
  const refs = [...new Set(docs.flatMap((d) => {
    const raw = d.docNumber ?? d.fileName;
    return raw ? [raw, raw.trim()] : [];
  }).filter((r) => r))];
  if (refs.length === 0) return { rows: [] };
  return selectIn<LegacyEntry>((chunk) => supabase.from("cost_entries")
    .select("id, project_id, entry_type, reference, description, status")
    .eq("project_id", projectId).is("source_document_id", null).in("reference", chunk), refs);
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

/** The refusals an award runs against the row as read, before anything
 *  moves (MON-12 / COST-8 / COST-13): the budget line's currency, the
 *  company registry (fail-closed — a failed read refuses), and the read
 *  extent. Shared by the one-transaction award and the client sequence. */
async function awardGuard(
  f: CostDocument, raw: Record<string, unknown>, costAccountId: string,
  override: string | null, confirmedTotal: number | null | undefined,
): Promise<{ refusal: string | null; company: CompanyRow | null; barred: CompanyRow | null }> {
  const mismatch = await currencyMismatch(f, costAccountId);
  if (mismatch) return { refusal: mismatch, company: null, barred: null };
  const behind = await companyBehind(f, raw);
  if (behind.error) {
    return { refusal: `Couldn't check the company registry (${asClause(behind.error)}) — try again; an award is not made without that check.`, company: null, barred: null };
  }
  const { company, barred } = behind;
  if (barred && !override) return { refusal: flaggedMessage(barred), company, barred };
  return { refusal: extentRefusal(f, raw, confirmedTotal), company, barred };
}

function flaggedMessage(company: CompanyRow): string {
  return company.status === "do_not_use"
    ? `${company.name} is flagged DO NOT USE in the company registry. Awarding it needs an explicit override with a reason, which goes on the audit trail.`
    : `${company.name} is marked inactive in the company registry. Awarding it needs an explicit override with a reason, which goes on the audit trail.`;
}

/** The one-transaction award is not in the database yet (20261157 not
 *  applied): the caller runs the client sequence instead. */
const AWARD_RPC_MISSING: unique symbol = Symbol("award_quote missing");

/** A function the database does not have: Postgres 42883, or PostgREST's
 *  schema-cache miss (PGRST202). */
export function isMissingRpc(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42883" || err.code === "PGRST202" || /could not find the function/i.test(err.message ?? "");
}

type AwardResult = {
  ok: boolean; error?: string; warning?: string;
  needsOverride?: { companyId: string; companyName: string; status: string };
};

/**
 * GAP-406: the award as ONE transaction — 20261157 `award_quote` locks the
 * quote, re-checks it, claims it, posts the commitment, records the
 * override, declines the open rivals of its RFQ group (by key) and writes
 * COST_DOC_AWARDED, all or nothing: a failure at any step leaves no partial
 * award. The guard (currency, registry, read extent) runs here first
 * against the row as read, so a refusal reads exactly as the client
 * sequence's; the function re-checks what it can under its lock (status,
 * budget line, currency, the total the guard saw, the registry gate on any
 * normalised do-not-use look-alike, and COST-13's confirmed figure and read
 * extent).
 * Returns AWARD_RPC_MISSING while the migration is not applied.
 */
async function awardInOneTransaction(
  input: Parameters<typeof awardQuote>[0], override: string | null,
): Promise<AwardResult | typeof AWARD_RPC_MISSING> {
  const { data: row, error: readErr } = await supabase.from("cost_documents").select("*").eq("id", input.doc.id).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr ? userFacingReadError(readErr, "awardQuote") : "Document not found — it may have been removed." };
  const raw = row as Record<string, unknown>;
  const fresh = mapDoc(raw);
  if (fresh.status !== "draft" && fresh.status !== "parsed") {
    return { ok: false, error: `This document is already ${costDocStatusLabel(fresh.status).toLowerCase()} — refresh to see the latest.` };
  }
  const verdict = await awardGuard(fresh, raw, input.costAccountId, override, input.confirmedTotal);
  if (verdict.refusal) {
    return verdict.barred && !override
      ? { ok: false, error: verdict.refusal, needsOverride: { companyId: verdict.barred.id, companyName: verdict.barred.name, status: verdict.barred.status } }
      : { ok: false, error: verdict.refusal };
  }
  const total = postableTotal(fresh).total;
  if (total == null || !(total > 0)) return { ok: false, error: "No readable total on this quote yet — run the AI read (or type the total) first." };

  let res: { data: unknown; error: { code?: string | null; message: string } | null };
  try {
    res = await supabase.rpc("award_quote", {
      p_doc: fresh.id, p_cost_account: input.costAccountId, p_expected_total: total,
      p_override_reason: override, p_confirmed_total: input.confirmedTotal ?? null,
    });
  } catch (e) {
    return { ok: false, error: userFacingCaughtError(e, { context: "awardQuote" }) };
  }
  if (res.error) {
    if (isMissingRpc(res.error)) return AWARD_RPC_MISSING;
    return { ok: false, error: userFacingError(res.error, { context: "awardQuote" }) };
  }
  const out = (res.data ?? {}) as {
    ok?: boolean; code?: string; status?: string; total?: number;
    confirmed?: number; pagesRead?: number | null; pagesTotal?: number | null;
    docCurrency?: string; accountCurrency?: string;
    company?: { id?: string; name?: string; status?: string } | null;
    rivals?: number; declined?: number; ungroupedOpen?: unknown;
  };
  if (!out.ok) {
    const co = out.company;
    switch (out.code) {
      case "company_flagged":
        if (co?.id && co.name && co.status) {
          const c: CompanyRow = { id: co.id, name: co.name, status: co.status };
          return { ok: false, error: flaggedMessage(c), needsOverride: { companyId: c.id, companyName: c.name, status: c.status } };
        }
        return { ok: false, error: "The company behind this quote is flagged in the registry — awarding it needs an explicit override with a reason." };
      case "status":
        return { ok: false, error: `This document is already ${costDocStatusLabel(out.status ?? "decided").toLowerCase()} — refresh to see the latest.` };
      case "currency":
        return { ok: false, error: `This document is in ${out.docCurrency} but the budget line is in ${out.accountCurrency} — pick a ${out.docCurrency} budget line or correct the document's currency before posting.` };
      case "account":
        return { ok: false, error: "That budget line is not on this project (or no longer exists) — pick one of the project's budget lines. Nothing was changed." };
      case "no_total":
        return { ok: false, error: "No readable total on this quote yet — run the AI read (or type the total) first." };
      case "total_changed":
        return { ok: false, error: `The total of this quote changed since it was checked${typeof out.total === "number" ? ` (it is now ${out.total.toLocaleString()})` : ""} — refresh and check it before awarding. Nothing was changed.` };
      // COST-13, re-checked under the lock: the guard's own sentences.
      case "confirm_mismatch":
        return { ok: false, error: confirmMismatchMessage(Number(out.confirmed ?? input.confirmedTotal), Number(out.total ?? total)) };
      case "extent":
        return { ok: false, error: extentMessage(out.pagesRead ?? null, out.pagesTotal ?? null, Number(out.total ?? total)) };
      case "not_quote":
        return { ok: false, error: "Only quotes can be awarded." };
      case "not_found":
        return { ok: false, error: "This document could not be awarded — it was removed, or you don't have permission to award it. Nothing was changed." };
      default:
        return { ok: false, error: "Someone else just decided this document — refresh to see the latest." };
    }
  }
  const warnings: string[] = [];
  const rivals = Number(out.rivals ?? 0);
  const declined = Number(out.declined ?? 0);
  if (rivals > declined) {
    warnings.push(`Awarded, but ${rivals - declined} of ${rivals} competing bid(s) could not be marked not-selected — refresh and decline them by hand.`);
  }
  const names = Array.isArray(out.ungroupedOpen) ? (out.ungroupedOpen as unknown[]).map(String) : [];
  if (names.length > 0) {
    warnings.push(`Awarded. ${names.length} other ungrouped quote${names.length === 1 ? "" : "s"} stay${names.length === 1 ? "s" : ""} open (${names.join(", ")}) — decline ${names.length === 1 ? "it" : "them"} if ${names.length === 1 ? "it" : "they"} competed for this scope.`);
  }
  await notifyAward(fresh, total, input.actor, input.costAccountId);
  return warnings.length ? { ok: true, warning: warnings.join(" ") } : { ok: true };
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
   *  unless a reason is given here; the override is audited by company id
   *  (COST_DOC_AWARD_OVERRIDE, written by this function after the post — a
   *  caller does not write its own override row). */
  overrideReason?: string | null;
  /** COST-13: the figure the user typed from the PAPER, in the document's
   *  currency — pass the typed number itself, never the row's total. It
   *  must equal the row's total in whole units (else refused). Required
   *  when the AI read this document and the read was truncated, or — once
   *  the read extent is recorded (20261096) — of unknown extent, whether
   *  the row's total is the extraction or a hand correction. Omit it when
   *  nothing was typed. */
  confirmedTotal?: number | null;
}): Promise<{
  ok: boolean; error?: string; warning?: string;
  /** Set when the award was refused ONLY because the company behind the
   *  quote is flagged (do-not-use or inactive) and no override reason was
   *  given — the caller may ask for a reason and call again with it. */
  needsOverride?: { companyId: string; companyName: string; status: string };
}> {
  const { doc } = input;
  if (doc.kind !== "quote") return { ok: false, error: "Only quotes can be awarded." };

  const override = input.overrideReason?.trim() || null;

  // GAP-406: the award in ONE database transaction (20261157 award_quote).
  // Until that migration is applied the client sequence below runs instead.
  const inOne = await awardInOneTransaction(input, override);
  if (inOne !== AWARD_RPC_MISSING) return inOne;

  // Refusals that move nothing run against the RE-READ row, before the
  // claim's UPDATE (claimDocTransition's guard).
  let company: CompanyRow | null = null;
  let barred: CompanyRow | null = null;
  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "awarded", input.actor.uid, true, async (f, raw) => {
    const verdict = await awardGuard(f, raw, input.costAccountId, override, input.confirmedTotal);
    company = verdict.company;
    barred = verdict.barred;
    return verdict.refusal;
  });
  const awardedCompany = company as CompanyRow | null;
  const barredCompany = barred as CompanyRow | null;
  if (!claim.ok) {
    return barredCompany && !override
      ? { ok: false, error: claim.error, needsOverride: { companyId: barredCompany.id, companyName: barredCompany.name, status: barredCompany.status } }
      : { ok: false, error: claim.error };
  }
  const fresh = claim.fresh;
  const extent = readExtentOf(claim.raw);

  // total_amount is the human-visible number (AI-written at parse, or typed
  // via setManualTotal) — it outranks the stored extraction.
  const total = postableTotal(fresh).total;
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

  if (barredCompany && override) {
    await audit("COST_DOC_AWARD_OVERRIDE", fresh.orgId, doc.id, input.actor, {
      companyId: barredCompany.id, companyName: barredCompany.name, companyStatus: barredCompany.status, reason: override,
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
  // Groups compare by KEY (case-folded, whitespace collapsed), exactly as
  // the bid tab tabulates them — "Piping" and "piping " are one scope.
  const open = (d: CostDocument) =>
    d.id !== doc.id && d.kind === "quote" && (d.status === "draft" || d.status === "parsed");
  const groupKey = rfqKey(fresh.rfqGroup);
  const rivals = groupKey ? input.siblings.filter((d) => open(d) && rfqKey(d.rfqGroup) === groupKey) : [];
  const ungroupedOpen = groupKey ? [] : input.siblings.filter((d) => open(d) && !rfqKey(d.rfqGroup));
  const warnings: string[] = [];
  let declined = 0;
  if (rivals.length > 0) {
    const { data: hit, error } = await supabase.from("cost_documents").update({ status: "declined" })
      .in("id", rivals.map((d) => d.id))
      .in("status", ["draft", "parsed"])
      .select("id");
    declined = hit?.length ?? 0;
    if (error || declined < rivals.length) {
      warnings.push(`Awarded, but ${rivals.length - declined} of ${rivals.length} competing bid(s) could not be marked not-selected${error ? ` (${userFacingError(error, { context: "declineRivals", clause: true })})` : ""} — refresh and decline them by hand.`);
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
    companyId: awardedCompany?.id ?? null, override,
    // COST-13 dw4: the read extent the posted total came from (null = not recorded / unknown).
    pagesRead: extent.pagesRead, pagesTotal: extent.pagesTotal, totalConfirmed: input.confirmedTotal != null,
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
  /** COST-13: the figure the user typed from the paper (same contract as
   *  awardQuote's `confirmedTotal`). */
  confirmedTotal?: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { doc } = input;
  if (doc.kind === "quote") return { ok: false, error: "Quotes are awarded, not posted — use Award." };

  const claim = await claimDocTransition(doc.id, ["draft", "parsed"], "posted", input.actor.uid, true, async (f, raw) =>
    (await currencyMismatch(f, input.costAccountId)) ?? extentRefusal(f, raw, input.confirmedTotal));
  if (!claim.ok) return { ok: false, error: claim.error };
  const fresh = claim.fresh;
  const extent = readExtentOf(claim.raw);

  const total = postableTotal(fresh).total;
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
    pagesRead: extent.pagesRead, pagesTotal: extent.pagesTotal, totalConfirmed: input.confirmedTotal != null,
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
  /** COST-8: the document's currency as the paper states it (an ISO code,
   *  or "$" / "US$" for USD) — the in-app correction for a stored currency
   *  that would otherwise strand the document at posting. */
  currency?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(input.total) || input.total <= 0) return { ok: false, error: "Enter the document's total as a positive number." };
  if (input.doc.status === "awarded" || input.doc.status === "posted") return { ok: false, error: MOVED_MONEY };
  const patch: Record<string, unknown> = { total_amount: input.total };
  if (input.vendorName?.trim()) patch.vendor_name = input.vendorName.trim();
  if (input.currency != null && input.currency.trim()) {
    const code = normalizeCurrency(input.currency);
    if (!code) return { ok: false, error: `"${input.currency.trim()}" is not a currency code — use a three-letter code such as USD, CAD or EUR.` };
    patch.currency = code;
  }
  const open = await supabase.from("cost_documents").update({ ...patch, status: "parsed" })
    .eq("id", input.doc.id).in("status", ["draft", "parsed"]).select("id");
  if (open.error) return { ok: false, error: userFacingError(open.error, { context: "setManualTotal" }) };
  let hit = open.data ?? [];
  if (hit.length === 0) {
    const dec = await supabase.from("cost_documents").update(patch)
      .eq("id", input.doc.id).eq("status", "declined").select("id");
    if (dec.error) return { ok: false, error: userFacingError(dec.error, { context: "setManualTotal" }) };
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
  await audit("COST_DOC_MANUAL_TOTAL", input.doc.orgId, input.doc.id, input.actor, { total: input.total, currency: patch.currency ?? null });
  return { ok: true };
}

// ── reconciliation + repair (MON-1 / COST-11 dw3 — GAP-406's repair path) ──

/** Why an approved change order needs attention: no entry linked, or the
 *  linked entry is void (the base's only unwind was voiding it by hand), or
 *  the linked entry cannot be found. Only a CO whose linked entry is POSTED
 *  revises the budget (changeOrders.approvedChangesByAccount). */
export type CoOrphanReason = "unlinked" | "entry_void" | "entry_missing";

export interface LedgerOrphans {
  /** False until migration 20261093 has run (the `cost_ledger_orphans` view
   *  is the probe): before its COST-9 backfill the list would be noise, so
   *  the Costs tab renders nothing. */
  available: boolean;
  /** awarded / posted documents whose money is on the ledger NOWHERE: no
   *  entry links to them (any status — a hand-voided entry was the
   *  correction), and no unlinked pre-Round-G entry of their award/invoice
   *  shape stands for them. */
  docs: CostDocument[];
  /** approved change orders whose linked entry is missing, void or absent. */
  changeOrders: Array<{
    id: string; coNumber: string; title: string; amount: number;
    costAccountId: string | null; postedEntryId: string | null; reason: CoOrphanReason;
  }>;
}

function relationMissing(e: { code?: string; message?: string }): boolean {
  return e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? "");
}

/** The two orphan states the claim-then-post design can produce. Read-only;
 *  the SQL view `cost_ledger_orphans` (20261093) answers the same question
 *  from the database side, and its absence means the migration (and its
 *  backfill) has not run — the result is then `available: false`. Every
 *  entry read is bounded to the documents / COs in question (`.in`, in
 *  chunks), never a capped scan of the project's ledger. A failed read
 *  throws (REL-2). */
export async function listLedgerOrphans(orgId: string, projectId: string): Promise<LedgerOrphans> {
  const probe = await supabase.from("cost_ledger_orphans").select("id").eq("org_id", orgId).eq("project_id", projectId).limit(1);
  if (probe.error) {
    if (relationMissing(probe.error)) return { available: false, docs: [], changeOrders: [] };
    throw new Error(`Couldn't check the ledger for orphans: ${userFacingReadError(probe.error, "ledgerOrphans")}`);
  }
  const [docsRes, cosRes] = await Promise.all([
    supabase.from("cost_documents").select("*").eq("org_id", orgId).eq("project_id", projectId)
      .in("status", ["awarded", "posted"]).limit(500),
    supabase.from("change_orders").select("id, co_number, title, amount, cost_account_id, posted_entry_id")
      .eq("org_id", orgId).eq("project_id", projectId).eq("status", "approved").limit(500),
  ]);
  const failed = docsRes.error ?? cosRes.error;
  if (failed) throw new Error(`Couldn't check the ledger for orphans: ${userFacingReadError(failed, "ledgerOrphans")}`);
  const moved = ((docsRes.data ?? []) as Array<Record<string, unknown>>).map(mapDoc);
  const approved = (cosRes.data ?? []) as Array<{ id: string; co_number: string; title: string; amount: unknown; cost_account_id: string | null; posted_entry_id: string | null }>;

  const [linkedRes, legacyRes, coEntryRes] = await Promise.all([
    selectIn<{ source_document_id: string | null }>((chunk) => supabase.from("cost_entries")
      .select("source_document_id").in("source_document_id", chunk), moved.map((d) => d.id)),
    unlinkedLegacyEntries(projectId, moved),
    selectIn<{ id: string; status: string | null }>((chunk) => supabase.from("cost_entries")
      .select("id, status").in("id", chunk), [...new Set(approved.map((c) => c.posted_entry_id).filter((v): v is string => !!v))]),
  ]);
  const readErr = linkedRes.error ?? legacyRes.error ?? coEntryRes.error;
  if (readErr) throw new Error(`Couldn't check the ledger for orphans: ${readErr}`);

  const linked = new Set(linkedRes.rows.map((r) => r.source_document_id));
  const docs = moved.filter((d) => !linked.has(d.id) && !legacyRes.rows.some((e) => legacyShapeMatches(d, e)));
  const entryStatus = new Map(coEntryRes.rows.map((e) => [e.id, e.status]));
  const changeOrders: LedgerOrphans["changeOrders"] = [];
  for (const r of approved) {
    const status = r.posted_entry_id ? entryStatus.get(r.posted_entry_id) : undefined;
    const reason: CoOrphanReason | null = !r.posted_entry_id ? "unlinked"
      : status === undefined ? "entry_missing"
      : status === "posted" ? null : "entry_void";
    if (!reason) continue;
    changeOrders.push({
      id: r.id, coNumber: r.co_number, title: r.title,
      amount: Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0,
      costAccountId: r.cost_account_id ?? null, postedEntryId: r.posted_entry_id ?? null, reason,
    });
  }
  return { available: true, docs, changeOrders };
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
 * document whose linked entry was VOIDED by hand is refused BOTH actions:
 * the void was the correction (a re-post would bring back the locked total),
 * and a revert would reopen the paper for a fresh award / post beside the
 * corrected money — the amount the controller hand-posted after voiding
 * would be joined by a second commitment. It is not an orphan (the linked
 * entry attends it) and stays as it is. A document that an UNLINKED
 * pre-Round-G entry of its award/invoice shape stands for (any status) is
 * refused BOTH actions too — its money reached the ledger.
 */
export async function repairCostDoc(input: {
  doc: CostDocument; action: "repost" | "revert"; costAccountId?: string | null; actor: Actor;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: row, error: readErr } = await supabase.from("cost_documents").select("*").eq("id", input.doc.id).maybeSingle();
  if (readErr || !row) return { ok: false, error: readErr ? userFacingReadError(readErr, "repairCostDoc") : "Document not found — it may have been removed." };
  const fresh = mapDoc(row as Record<string, unknown>);
  if (fresh.status !== "awarded" && fresh.status !== "posted") {
    return { ok: false, error: `This document is ${costDocStatusLabel(fresh.status).toLowerCase()} — nothing to repair.` };
  }
  const { data: linked, error: linkErr } = await supabase.from("cost_entries").select("id, status")
    .eq("source_document_id", fresh.id).limit(50);
  if (linkErr) return { ok: false, error: userFacingError(linkErr, { context: "repairCostDoc" }) };
  const links = (linked ?? []) as Array<{ id: string; status: string | null }>;
  if (links.some((e) => e.status === "posted")) return { ok: false, error: "This document already has its cost entry — nothing to repair. Refresh." };
  // Pre-Round-G money carries no source_document_id: an unlinked entry of
  // this document's award/invoice shape (any status) means the money DID
  // reach the ledger. Neither action is safe — a re-post would double it,
  // a revert would reopen paper whose commitment stays.
  const legacy = await unlinkedLegacyEntries(fresh.projectId, [fresh]);
  if (legacy.error) return { ok: false, error: legacy.error };
  const lookalike = legacy.rows.find((e) => legacyShapeMatches(fresh, e));
  if (lookalike) {
    return {
      ok: false,
      error: `An unlinked entry that looks like this document's exists (reference "${docReference(fresh)}", ${lookalike.status === "void" ? "voided" : "posted"}) — its money reached the ledger before entries carried their document link. Link it, don't re-post or revert: the 20261093 backfill links the unambiguous ones, and an ambiguous one is linked by hand.`,
    };
  }

  // A linked entry voided by hand: the void was the correction. Neither
  // action — a re-post brings back the locked total, a revert reopens the
  // paper so a fresh award / post would add money beside the correction.
  if (links.length > 0) {
    return {
      ok: false,
      error: input.action === "repost"
        ? "This document's cost entry was voided by hand — that void was the correction, so its locked total is not re-posted. Post the corrected amount on the budget line instead."
        : "This document's cost entry was voided by hand — that void was the correction, so the document is not reopened: awarding or posting it again would put its money on the ledger a second time beside the correction. It stays as it is; post any corrected amount on the budget line.",
    };
  }

  if (input.action === "repost") {
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
