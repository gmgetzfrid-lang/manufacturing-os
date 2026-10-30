// POST /api/projects/budget-doc — READ a project's budget basis from paper.
//
// An AFE, capital request, estimate sheet, or cost breakdown arrives in
// whatever format the company uses — a scanned PDF, a photo, an Excel
// workbook, a Word doc. The file is already in storage (the client uploads
// it under the org's prefix first); this route turns it into model input
// by format, has the model extract ONE shape (lib/budgetDoc), validates
// it, and hands it back for a human to review. Nothing is written to the
// project here — the wizard prefills from the result, and the Costs tab's
// importer applies it only when the reviewer clicks Apply.
//
// Authority: any active member may read a document for a NEW project (the
// wizard runs before a project exists); reading for an EXISTING project
// takes the same people who may write its costs — controllers or the owner.
// Runs on the caller's own AI key through governedAiCall.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { governedAiCall, GovernedCallError } from "@/lib/ai/governedCall";
import { extractJsonBlock } from "@/lib/orchestrator/protocol";
import { renderPdfPages } from "@/lib/knowledgePageRender";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import { fetchBytes } from "@/lib/r2Bytes";
import { validateParsedBudgetDoc, reconcileBudget, budgetSourceFormat } from "@/lib/budgetDoc";
import type { AiCallImage } from "@/lib/ai/providerCall";

export const runtime = "nodejs";
export const maxDuration = 120;

const bad = (error: string, status: number) => NextResponse.json({ error }, { status });
const MAX_PAGES = 8;
const MAX_TEXT = 60_000;
const MAX_BYTES = 25 * 1024 * 1024;
// A 1400px-wide page that encodes under ~20 KB is blank. On a scan that
// usually means an image the renderer couldn't decode (JBIG2 / JPEG 2000
// scanner compression) — the reviewer is told which pages to check.
const BLANK_PAGE_BYTES = 20_000;

const SYSTEM =
  "You read project budget and authorization documents - AFEs (Authorization for Expenditure), capital requests, cost estimates, budget spreadsheets, cost breakdowns - for industrial maintenance and capital projects. Every company uses its own form; find the facts wherever they are printed. Extract what is PRINTED - never invent.\n" +
  "Fields:\n" +
  "- docType: what the document calls itself (\"AFE\", \"Capital Request\", \"Estimate\"…). docNumber: its number. chargeAccount: the account/GL/cost-center/WBS code the spend books to, verbatim.\n" +
  "- docDate, targetCompletionDate, milestone dates: YYYY-MM-DD. When a date omits the year, use the document's own year. targetCompletionDate only when the paper states an end/completion/in-service date or one is a direct sum the paper states (start date + stated duration).\n" +
  "- title; authorizedAmount: the total amount requested/authorized as a number; currency (ISO code).\n" +
  "- description: the project/scope description as printed (may condense). justification: WHY the work is needed, condensed to at most ~6 sentences keeping the key numbers.\n" +
  "- goals: the outcomes the paper says the work must achieve (e.g. 'Restore feed rate to 4,200 bpd'), short phrases. successCriteria: one sentence if the paper states how success is judged (duration, rate, budget).\n" +
  "- lines: every cost line in the cost projection/breakdown: name, amount (number), supplier (the company named for it, without braces; null when none or 'Various'), costType one of labor|material|equipment|subcontract|other, note (any qualifier printed beside it, e.g. 'Consignment', a contingency condition). Do NOT include total/subtotal rows. If the document shows a breakdown by area/unit AND by cost category, use the cost category lines.\n" +
  "- budgetReferences: the approved-budget items this request draws on, each {label, amount}. varianceNote: any over/under-budget statement and its reasons, condensed.\n" +
  "- approvals: each approver line {role, name (if legible/printed, else null), date}. preparedBy: who prepared it.\n" +
  "- milestones: dated events the paper commits to (shutdowns, start-up, mobilization), {name, date}.\n" +
  "- mocReference: a Management of Change number only if printed.\n" +
  "Numbers must be numbers. Unknown → null (or [] for lists).\n" +
  'Return STRICT JSON: {"docType":"AFE","docNumber":"…","chargeAccount":"…","docDate":"2025-03-07","title":"…","authorizedAmount":1250000,"currency":"USD","description":"…","justification":"…","goals":["…"],"successCriteria":null,"preparedBy":null,"approvals":[{"role":"…","name":null,"date":null}],"budgetReferences":[{"label":"…","amount":500000}],"varianceNote":null,"lines":[{"name":"…","amount":884000,"supplier":"…","costType":"labor","note":null}],"milestones":[{"name":"…","date":"2025-03-15"}],"targetCompletionDate":null,"mocReference":null}';

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function docxText(bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  return decodeXml(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sheetText(bytes: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
  const parts: string[] = [];
  for (const name of wb.SheetNames.slice(0, 8)) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    if (csv.trim()) parts.push(`## Sheet: ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    ensurePdfPolyfills();
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text ?? "").trim();
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest) {
  let body: { orgId?: string; projectId?: string; fileKey?: string; fileName?: string; mimeType?: string };
  try { body = await req.json(); } catch { return bad("Bad JSON", 400); }
  const orgId = (body.orgId ?? "").trim();
  const projectId = (body.projectId ?? "").trim();
  const fileKey = (body.fileKey ?? "").trim();
  const fileName = (body.fileName ?? "").trim() || "document";
  if (!orgId || !fileKey) return bad("orgId and fileKey required", 400);
  // The file must live under this org's prefix — never read another
  // tenant's object by passing its key.
  if (!fileKey.startsWith(`orgs/${orgId}/`) || fileKey.includes("..")) return bad("That file isn't in this workspace.", 403);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return bad("Not signed in", 401);
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return bad("Not signed in", 401);
  const userId = userData.user.id;

  const { data: member } = await supabaseAdmin.from("org_members")
    .select("role, status").eq("org_id", orgId).eq("uid", userId).maybeSingle();
  const m = member as { role?: string; status?: string } | null;
  if (!m || m.status !== "active") return bad("Not a member of this workspace.", 403);
  if (projectId) {
    const { data: project } = await supabaseAdmin.from("projects")
      .select("id, owner_user_id").eq("id", projectId).eq("org_id", orgId).maybeSingle();
    if (!project) return bad("Project not found.", 404);
    const isController = ["Admin", "DocCtrl"].includes(m.role ?? "");
    if (!isController && String(project.owner_user_id ?? "") !== userId) {
      return bad("Only the project owner or a document controller can import a budget.", 403);
    }
  }

  const format = budgetSourceFormat(fileName, body.mimeType ?? null);
  if (format === "unsupported") {
    return bad("Send a PDF, a photo (PNG/JPG), an Excel or CSV sheet, a Word document, or plain text.", 415);
  }

  let bytes: Buffer;
  try { bytes = await fetchBytes(fileKey); } catch { return bad("The uploaded file couldn't be found - upload it again.", 404); }
  if (bytes.length > MAX_BYTES) return bad("That file is over 25 MB - export just the budget pages.", 413);

  let images: AiCallImage[] = [];
  let text = "";
  let pagesRead: number[] = [];
  let blankPages: number[] = [];
  try {
    if (format === "pdf") {
      const u8 = new Uint8Array(bytes);
      const [rendered, layer] = await Promise.all([
        renderPdfPages(u8, Array.from({ length: MAX_PAGES }, (_, i) => i + 1), MAX_PAGES),
        pdfText(u8),
      ]);
      images = rendered.map(({ base64, mediaType }) => ({ base64, mediaType }));
      pagesRead = rendered.map((r) => r.page);
      blankPages = rendered.filter((r) => (r.base64.length * 3) / 4 < BLANK_PAGE_BYTES).map((r) => r.page);
      text = layer;
      if (images.length === 0 && text.length < 40) {
        return bad("The PDF couldn't be read - it may be corrupt or password-protected.", 502);
      }
    } else if (format === "image") {
      const mt = (body.mimeType ?? "").startsWith("image/") ? body.mimeType! : /\.png$/i.test(fileName) ? "image/png" : "image/jpeg";
      images = [{ base64: bytes.toString("base64"), mediaType: mt }];
    } else if (format === "sheet") {
      text = await sheetText(bytes);
    } else if (format === "docx") {
      text = await docxText(bytes);
    } else {
      text = bytes.toString("utf8");
    }
  } catch (e) {
    return bad(`The file couldn't be opened: ${(e as Error).message}`, 422);
  }
  if (images.length === 0 && !text.trim()) return bad("The file has no readable content.", 422);

  let out: string;
  try {
    const res = await governedAiCall({
      orgId, userId,
      op: "budgetDocParse",
      system: SYSTEM,
      user: [
        `File: ${fileName}`,
        images.length ? `Pages attached as images in order${pagesRead.length ? `: ${pagesRead.join(", ")}` : ""}.` : null,
        text ? `Document text${format === "pdf" ? " (PDF text layer - the images are authoritative where they differ)" : ""}:\n${text.slice(0, MAX_TEXT)}` : null,
      ].filter(Boolean).join("\n\n"),
      images: images.length ? images : undefined,
      maxTokens: 4000,
      timeoutMs: 100_000,
    });
    out = res.text;
  } catch (e) {
    if (e instanceof GovernedCallError) return bad(e.message, e.status);
    return bad((e as Error).message, 502);
  }

  const block = extractJsonBlock(out);
  if (!block) return bad("The model returned nothing readable - try again.", 502);
  let parsed;
  try { parsed = validateParsedBudgetDoc(JSON.parse(block)); } catch (e) { return bad((e as Error).message, 422); }

  await supabaseAdmin.from("audit_logs").insert({
    action: "COST_BUDGET_DOC_READ",
    resource_type: "cost", resource_id: projectId || fileKey.split("/").pop()?.slice(0, 60) || "budget-doc",
    org_id: orgId, user_id: userId, user_email: userData.user.email ?? null,
    details: { fileName, format, projectId: projectId || null, lines: parsed.lines.length, authorized: parsed.authorizedAmount },
  }).then(() => undefined, () => undefined);

  return NextResponse.json({ parsed, reconciliation: reconcileBudget(parsed), pagesRead, blankPages, format });
}
