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

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderKnowledgePages } from "@/lib/knowledgePageRender";
import { validateParsedQuote } from "@/lib/bidTab";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PAGES = 8;

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

export async function POST(req: NextRequest) {
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
    supabaseAdmin.from("org_members").select("role, status").eq("org_id", orgId).eq("uid", userId).maybeSingle(),
    supabaseAdmin.from("projects").select("id, owner_user_id").eq("id", projectId).eq("org_id", orgId).maybeSingle(),
  ]);
  const m = member as { role?: string; status?: string } | null;
  if (!m || m.status !== "active") return bad("Not a member of this workspace.", 403);
  if (!project) return bad("Project not found.", 404);
  const isController = ["Admin", "DocCtrl"].includes(m.role ?? "");
  const isOwner = String(project.owner_user_id ?? "") === userId;
  if (!isController && !isOwner) {
    return bad("Only the project owner or a document controller can run cost-document reads.", 403);
  }

  const { data: docRow } = await supabaseAdmin
    .from("cost_documents").select("*")
    .eq("id", costDocId).eq("org_id", orgId).eq("project_id", projectId).maybeSingle();
  const doc = docRow as {
    id: string; kind: string; status: string;
    file_url: string | null; file_name: string | null; mime_type: string | null;
    vendor_name: string | null;
  } | null;
  if (!doc) return bad("Cost document not found.", 404);
  if (!doc.file_url) return bad("This row has no stored file to read.", 404);
  if (doc.status === "awarded" || doc.status === "posted") {
    return bad("This document already moved money — its extraction is locked.", 409);
  }
  const looksPdf = (doc.mime_type ?? "").includes("pdf") || /\.pdf$/i.test(doc.file_name ?? "");
  if (!looksPdf) return bad("Only PDF quotes and invoices can be read for now — ask the vendor for a PDF.", 415);

  const images = await renderKnowledgePages(doc.file_url, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES);
  if (images.length === 0) return bad("The pages could not be rendered for reading — the file may be corrupt or password-protected.", 502);

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
      timeoutMs: 90_000,
    });
    text = out.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(text);
  if (!block) return bad("The model returned nothing readable — try again.", 502);
  let raw: unknown;
  try { raw = JSON.parse(block); } catch { return bad("The extraction wasn't valid JSON — try again.", 502); }

  const patch: Record<string, unknown> = { parsed: raw, status: "parsed" };
  if (isQuote) {
    let quote;
    try { quote = validateParsedQuote(raw, costDocId); } catch (e) { return bad((e as Error).message, 422); }
    patch.parsed = quote;
    patch.total_amount = quote.total;
    if (quote.currency) patch.currency = quote.currency;
    // The submission channel's identity outranks the model's reading of a
    // letterhead — only fill vendor_name when the row has none.
    if (!doc.vendor_name && quote.vendorName !== "Unknown vendor") patch.vendor_name = quote.vendorName;
  } else {
    const r = raw as { total?: unknown; vendorName?: unknown; docNumber?: unknown; docDate?: unknown; currency?: unknown };
    const total = typeof r.total === "number" && Number.isFinite(r.total) ? r.total : null;
    if (total == null || total <= 0) return bad("Couldn't read an amount due from the invoice.", 422);
    patch.total_amount = total;
    if (typeof r.currency === "string" && r.currency.trim()) patch.currency = r.currency.trim();
    if (typeof r.docNumber === "string" && r.docNumber.trim()) patch.doc_number = r.docNumber.trim().slice(0, 60);
    if (typeof r.docDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.docDate)) patch.doc_date = r.docDate;
    if (!doc.vendor_name && typeof r.vendorName === "string" && r.vendorName.trim()) {
      patch.vendor_name = r.vendorName.trim().slice(0, 200);
    }
  }

  const { error: updErr } = await supabaseAdmin.from("cost_documents").update(patch).eq("id", costDocId);
  if (updErr) return bad(`The read succeeded but saving it failed: ${updErr.message}`, 500);

  await supabaseAdmin.from("audit_logs").insert({
    action: "COST_DOC_PARSED",
    resource_type: "cost", resource_id: costDocId,
    org_id: orgId, user_id: userId, user_email: userData.user.email ?? null,
    details: { kind: doc.kind, fileName: doc.file_name, total: patch.total_amount ?? null, pagesRead: images.map((i) => i.page) },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ parsed: patch.parsed, pagesRead: images.map((i) => i.page) });
}
