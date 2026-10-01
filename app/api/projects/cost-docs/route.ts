// POST /api/projects/cost-docs — READ an inbound quote or invoice PDF.
//
// This is the reading direction the cost program runs on: vendors send US
// documents, and the system does the work. A member uploads (or the intake
// portal lands) a quote PDF; this route renders its printed pages and has
// the model extract the numbers — total, line items with labor hours and
// crew sizes, and the EXCLUSIONS (why the low bid is low). The extraction
// is stored on the row for a human to review; nothing posts to the budget
// here. Money only moves when a person clicks Award / Post, client-side
// through lib/costDocs.
//
// Authority: org controllers or the project owner — the same people the
// cost tables' RLS lets write. Runs on the caller's own AI key through the
// standard five gates (governedAiCall).
//
// projects Round G J12: a CLOSED project's documents are not read (PM-1 —
// this route writes as the service role, which the 20261103 freeze lets
// through, so the refusal is the route's own); the read answers inside its
// own time limit with a readable 504 (PERF-6, lib/routeDeadline); an
// invoice's extraction is validated before it is stored (PR-2,
// lib/costDocParse); and a quote whose vendor name matches exactly one
// Known Company is linked to it on the row (COST-3 done-when 2).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { countPdfPages } from "@/lib/pdfPageCount";
import { validateParsedQuote, isoCurrency, matchCompanyByName } from "@/lib/bidTab";
import { validateParsedInvoice, closedProjectReadMessage } from "@/lib/costDocParse";
import { memberHoldsAny } from "@/lib/roleHeld";
import { CLOSED_PROJECT_STATUSES } from "@/lib/intakeLinks";
import { isTimeoutError } from "@/lib/ai/providerCall";
import {
  routeDeadline, beforeDeadline, aiBudgetMs, tooLargeToReadMessage, DEADLINE_PASSED,
} from "@/lib/routeDeadline";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
// The read is capped at 8 pages for cost and latency (COST-13 — raising
// it is a cost/latency question for the user). What matters is that the
// cap is RECORDED: pages_total / pages_read land on the row, travel in the
// response and the audit row, and the review screen says "read pages
// 1–8 of N" before anyone awards on the number.
const MAX_PAGES = 8;
const AI_TIMEOUT_MS = 90_000;
/** The registry is read in pages of this many rows when a quote's vendor
 *  is matched to it (COST-3) — never a capped first page. */
const REGISTRY_PAGE = 1000;
/** The page count is a detail of the answer, not a reason to wait: it gets
 *  this long (inside the deadline) and is unknown after it. */
const PAGE_COUNT_BUDGET_MS = 10_000;

const QUOTE_SYSTEM =
  "You read vendor quotes/proposals for industrial mechanical work, extracting what is PRINTED — never inventing.\n" +
  "Rules:\n" +
  "- total: the bottom-line quoted price as a plain number (no currency symbols). If several totals appear (base + options), use the base bid and note options in notes.\n" +
  "- lineItems: each priced scope line. Include qty/unit/unitRate/total when printed. When a line states labor content, fill hours (total man-hours) and headcount (crew size) and craft (pipefitter, electrician…). Leave fields null when not printed.\n" +
  "- exclusions: scope the vendor explicitly does NOT include, verbatim, one string each. These matter more than anything — they are why a low bid is low.\n" +
  "- validUntil: the quote's expiry date as YYYY-MM-DD if printed.\n" +
  "- Numbers must be numbers, not strings. Do not compute values the page doesn't print.\n" +
  'Return STRICT JSON: {"vendorName":"…","total":182000,"currency":"USD","validUntil":null,"lineItems":[{"description":"…","qty":null,"unit":null,"unitRate":null,"total":52000,"craft":"pipefitter","hours":1680,"headcount":8}],"exclusions":["…"],"notes":null}';

const INVOICE_SYSTEM =
  "You read vendor invoices for industrial work, extracting what is PRINTED — never inventing.\n" +
  "Rules:\n" +
  "- total: the amount due as a plain number. docNumber: the invoice number. docDate: invoice date as YYYY-MM-DD.\n" +
  "- lineItems: each billed line with its amount when printed.\n" +
  "- Numbers must be numbers, not strings.\n" +
  'Return STRICT JSON: {"vendorName":"…","docNumber":"INV-1042","docDate":"2026-08-01","total":41250,"currency":"USD","lineItems":[{"description":"…","total":41250}]}';

/** COST-3 done-when 2: the Known Company a quote's vendor name binds to —
 *  an exact name, else the ONE row it normalises to (lib/bidTab
 *  matchCompanyByName; ambiguity never binds). Null when the registry
 *  cannot be read: binding is an improvement, never a reason to refuse a
 *  read. */
async function registryMatch(orgId: string, vendorName: string): Promise<{ id: string; name: string } | null> {
  const rows: Array<{ id: string; name: string }> = [];
  for (let from = 0; ; from += REGISTRY_PAGE) {
    const { data, error } = await supabaseAdmin.from("companies").select("id, name")
      .eq("org_id", orgId).order("id").range(from, from + REGISTRY_PAGE - 1);
    if (error) {
      console.warn(`[cost-docs] registry read for the company link failed: ${error.message}`);
      return null;
    }
    const page = (data ?? []) as Array<{ id: string; name: string }>;
    rows.push(...page);
    if (page.length < REGISTRY_PAGE) break;
  }
  const hit = matchCompanyByName(vendorName, rows);
  return hit ? { id: hit.id, name: hit.name } : null;
}

export async function POST(req: NextRequest) {
  // PERF-6: the answer must land before the function's own limit.
  const deadline = routeDeadline(maxDuration);
  let body: { orgId?: string; projectId?: string; costDocId?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const projectId = (body.projectId ?? "").trim();
  const costDocId = (body.costDocId ?? "").trim();
  if (!orgId || !projectId || !costDocId) return bad("orgId, projectId and costDocId required", 400);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const [{ data: member }, { data: project }] = await Promise.all([
    supabaseAdmin.from("org_members").select("role, roles, status").eq("org_id", orgId).eq("uid", userId).maybeSingle(),
    supabaseAdmin.from("projects").select("id, owner_user_id, status").eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  const m = member as { role?: string; status?: string } | null;
  if (!m || m.status !== "active") return bad("Not a member of this workspace.", 403);
  if (!project) return bad("Project not found.", 404);
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isController = memberHoldsAny(m, ["Admin", "DocCtrl"]);
  const isOwner = String(project.owner_user_id ?? "") === userId;
  if (!isController && !isOwner) {
    return bad("Only the project owner or a document controller can run cost-document reads.", 403);
  }
  // PM-1: nothing is read into a closed project's record — before the file
  // is fetched and before the caller's key is spent.
  const projectStatus = String((project as { status?: string | null }).status ?? "");
  if (CLOSED_PROJECT_STATUSES.has(projectStatus)) return bad(closedProjectReadMessage(projectStatus), 409);

  const { data: docRow } = await supabaseAdmin
    .from("cost_documents").select("*")
    .eq("id", costDocId).eq("org_id", orgId).eq("project_id", projectId).maybeSingle();
  const doc = docRow as {
    id: string; kind: string; status: string;
    file_url: string | null; file_name: string | null; mime_type: string | null;
    vendor_name: string | null; total_amount?: number | null; parsed?: unknown;
  } | null;
  if (!doc) return bad("Cost document not found.", 404);
  // The total this read starts from — the final write requires it unchanged.
  const startedTotal = doc.total_amount ?? null;
  if (!doc.file_url) return bad("This row has no stored file to read.", 404);
  // Only a document nobody has read yet is readable (COST-13): awarded /
  // posted are locked (money moved), a declined or voided document stays
  // dead — re-reading must never resurrect a decision someone already made
  // — and a `parsed` one that carries an extraction was read already.
  // COST-15: a `parsed` row with NO extraction is a total someone typed
  // before any read ("type total" moves a draft to parsed). It is readable,
  // and the read is saved BESIDE that total — the extraction (line items,
  // manpower, exclusions) and its extent land, the typed total and the
  // status stay exactly as they are (the typed total is authoritative; the
  // bid table shows a differing read as "AI read …", never applies it).
  const besideTypedTotal = doc.status === "parsed" && doc.parsed == null;
  if (doc.status !== "draft" && !besideTypedTotal) {
    return bad(
      doc.status === "awarded" || doc.status === "posted"
        ? "This document already moved money — its extraction is locked."
        : doc.status === "parsed"
          ? "This document has already been read — nothing was changed. Refresh to see it; use \"correct total\" to change its total."
          : `This document is ${doc.status} — upload it again if it should be back in play.`,
      409);
  }
  const looksPdf = (doc.mime_type ?? "").includes("pdf") || /\.pdf$/i.test(doc.file_name ?? "");
  if (!looksPdf) return bad("Only PDF quotes and invoices can be read for now — ask the vendor for a PDF.", 415);

  // PERF-6: the render races the deadline (it takes no signal — it is
  // abandoned, not cancelled); a page count that cannot finish in its own
  // short budget is unknown (null), never a reason to refuse the read or to
  // spend the model's time waiting.
  const [rendered, counted] = await Promise.all([
    beforeDeadline(
      renderKnowledgePages(doc.file_url, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES), deadline),
    beforeDeadline(countPdfPages(doc.file_url), Math.min(deadline, Date.now() + PAGE_COUNT_BUDGET_MS)),
  ]);
  if (rendered === DEADLINE_PASSED) return bad(tooLargeToReadMessage(MAX_PAGES), 504);
  const images = rendered;
  const pagesTotal = counted === DEADLINE_PASSED ? null : counted;
  if (images.length === 0) return bad("The pages could not be rendered for reading — the file may be corrupt or password-protected.", 502);
  const pagesRead = images.map((i) => i.page);
  // The model's budget is what is left, capped — refused outright when too
  // little is left to be worth the caller's key.
  const budget = aiBudgetMs(deadline, AI_TIMEOUT_MS);
  if (budget === null) return bad(tooLargeToReadMessage(MAX_PAGES), 504);

  const isQuote = doc.kind === "quote";
  let text: string;
  try {
    const out = await governedAiCall({
      orgId, userId,
      op: isQuote ? "quoteParse" : "invoiceParse",
      system: isQuote ? QUOTE_SYSTEM : INVOICE_SYSTEM,
      user: `File: ${doc.file_name ?? "document"}\nPages attached in order: ${images.map((i) => i.page).join(", ")}${doc.vendor_name ? `\nExpected sender (from the submission channel): ${doc.vendor_name}` : ""}`,
      images: images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
      maxTokens: 3000,
      timeoutMs: budget,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    if (isTimeoutError(e)) return bad(tooLargeToReadMessage(MAX_PAGES), 504);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(text);
  if (!block) return bad("The model returned nothing readable — try again.", 502);
  let raw: unknown;
  try { raw = JSON.parse(block); } catch { return bad("The extraction wasn't valid JSON — try again.", 502); }

  const patch: Record<string, unknown> = {
    parsed: raw, status: "parsed",
    // Read extent (COST-13): the document's true page count and the pages
    // the model actually saw. Unknown stays NULL — never "complete".
    pages_total: pagesTotal, pages_read: pagesRead.length,
  };
  /** The total the model read (audited beside a typed total it did not replace). */
  let extractedTotal: number | null = null;
  /** COST-3: the Known Company this read linked the quote to. */
  let companyLinked: { id: string; name: string } | null = null;
  if (isQuote) {
    let quote;
    try { quote = validateParsedQuote(raw, costDocId); } catch (e) { return bad((e as Error).message, 422); }
    // Currency is stored only as a known ISO-4217 code (COST-8): the
    // model's free text ("$", "dollars", "US") is NULL = unknown, and the
    // stored extraction carries the same validated value.
    quote.currency = isoCurrency(quote.currency);
    patch.parsed = quote;
    patch.total_amount = quote.total;
    patch.currency = quote.currency;
    extractedTotal = quote.total;
    // The submission channel's identity outranks the model's reading of a
    // letterhead — only fill vendor_name when the row has none.
    if (!doc.vendor_name && quote.vendorName !== "Unknown vendor") patch.vendor_name = quote.vendorName;
    // COST-3 done-when 2: a bid nobody has linked is linked here when its
    // vendor name binds to exactly one Known Company — so the do-not-use
    // gates read a stored link, not an AI-read name, on every render. Only
    // where the row carries the column (20261096), has no link of its own,
    // and its contractor has none either (a person's link outranks a name).
    const docRaw = docRow as Record<string, unknown>;
    const vendorForLink = (doc.vendor_name ?? (patch.vendor_name as string | undefined) ?? "").trim();
    if ("company_id" in docRaw && docRaw.company_id == null && vendorForLink) {
      let partyLinked = false;
      const partyId = (docRaw.party_id as string | null | undefined) ?? null;
      if (partyId) {
        const { data: party, error: partyErr } = await supabaseAdmin.from("project_parties")
          .select("company_id").eq("id", partyId).maybeSingle();
        partyLinked = !!partyErr || !!(party as { company_id?: string | null } | null)?.company_id;
      }
      if (!partyLinked) companyLinked = await registryMatch(orgId, vendorForLink);
    }
  } else {
    // PR-2 criterion 3: the invoice's extraction is validated against its
    // schema (lib/costDocParse) and the validated record is what is stored —
    // never the model's raw JSON.
    let invoice;
    try { invoice = validateParsedInvoice(raw); } catch (e) { return bad((e as Error).message, 422); }
    patch.parsed = invoice;
    patch.total_amount = invoice.total;
    extractedTotal = invoice.total;
    patch.currency = invoice.currency;
    if (invoice.docNumber) patch.doc_number = invoice.docNumber;
    if (invoice.docDate) patch.doc_date = invoice.docDate;
    if (!doc.vendor_name && invoice.vendorName) patch.vendor_name = invoice.vendorName;
  }

  // COST-15: beside a typed total, the read writes ONLY the extraction and
  // its extent (and a vendor name the row lacks) — never the total, its
  // currency, the status or the invoice's number / date, all of which the
  // person who typed the total stands behind.
  if (besideTypedTotal) {
    for (const k of ["status", "total_amount", "currency", "doc_number", "doc_date"]) delete patch[k];
  }

  // The read took seconds to minutes: the document may have been decided
  // meanwhile (a typed total, then an award that posted the commitment; an
  // invoice posted as an actual). The write carries the same status
  // predicate as the check above — still a draft — so a late read never
  // reopens a decided document or replaces a total a person typed during
  // the read (both human-total writers move a draft to parsed) — zero rows
  // is a refusal, and nothing is audited (MON-3 / COST-13). It also
  // requires the total the read started from, so a total written without
  // that status change is not overwritten either.
  // Beside a typed total (COST-15) the predicate is the state the read
  // started from — still `parsed`, still no extraction, the same total — so
  // an award, a second read or a corrected total meanwhile is never
  // overwritten.
  const save = () => {
    const base = supabaseAdmin.from("cost_documents").update(patch)
      .eq("id", costDocId).eq("org_id", orgId);
    const q = besideTypedTotal ? base.eq("status", "parsed").is("parsed", null) : base.eq("status", "draft");
    return (startedTotal == null ? q.is("total_amount", null) : q.eq("total_amount", startedTotal)).select("id");
  };
  let { data: saved, error: updErr } = await save();
  if (updErr && (updErr.code === "PGRST204" || updErr.code === "42703")) {
    // Pre-migration tolerance: pages_total / pages_read land in 20261096.
    // The extent still travels in the response and the audit row.
    delete patch.pages_total;
    delete patch.pages_read;
    ({ data: saved, error: updErr } = await save());
  }
  if (updErr) return bad(`The read succeeded but saving it failed: ${updErr.message}`, 500);
  if (!saved || (saved as unknown[]).length === 0) {
    return bad(besideTypedTotal
      ? "This document was decided, read, or its total changed while it was being read — nothing was changed. Refresh to see the latest."
      : "This document was decided, or its total typed by hand, while it was being read — nothing was changed. Refresh to see the latest.", 409);
  }

  // COST-3: the link is its own write, guarded on the row still having no
  // link — a company a person linked while the read ran is never replaced,
  // and a link that cannot be written leaves the read itself standing.
  if (companyLinked) {
    const { data: linked, error: linkErr } = await supabaseAdmin.from("cost_documents")
      .update({ company_id: companyLinked.id })
      .eq("id", costDocId).eq("org_id", orgId).is("company_id", null).select("id");
    if (linkErr || !linked || (linked as unknown[]).length === 0) {
      if (linkErr) console.warn(`[cost-docs] company link for ${costDocId} not written: ${linkErr.message}`);
      companyLinked = null;
    }
  }

  await supabaseAdmin.from("audit_logs").insert({
    action: "COST_DOC_PARSED",
    resource_type: "cost", resource_id: costDocId,
    org_id: orgId, user_id: userId, user_email: userData.user.email ?? null,
    details: {
      kind: doc.kind, fileName: doc.file_name,
      total: besideTypedTotal ? startedTotal : (patch.total_amount ?? null),
      currency: patch.currency ?? null,
      ...(besideTypedTotal ? { besideTypedTotal: true, extractedTotal, totalKept: startedTotal } : {}),
      pagesRead, pagesTotal, truncated: pagesTotal != null ? pagesRead.length < pagesTotal : null,
      ...(companyLinked ? { companyLinked: { id: companyLinked.id, name: companyLinked.name, by: "vendor name" } } : {}),
    },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({
    parsed: patch.parsed, pagesRead, pagesTotal,
    ...(besideTypedTotal ? { totalKept: startedTotal, extractedTotal } : {}),
    ...(companyLinked ? { companyLinked } : {}),
  });
}
