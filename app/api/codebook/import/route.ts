// /api/codebook/import — AI-assisted Site Codebook building.
//
// The org's numbering standards usually already exist as a written document
// (unit lists, identifier tables, drawing number conventions). This route
// reads that text and PROPOSES codebook rows — units, equipment types with
// tag prefixes, drawing types — as structured JSON. It never writes the
// codebook: the client diffs the proposal against what exists (lib/codebook
// diffImport) and only user-accepted rows are applied. AI does the heavy
// lifting; the user keeps the pen.
//
// Governance: identical contract to every other AI feature — the CALLER's
// own key (per-user, allowlisted providers only), the signed acceptable-use
// agreement, and the monthly spend cap, metered per user.
//
// Actions:
//   "extract"        — file/document → TEXT, no AI call. For PDFs the reply
//                      also carries pageCount + thinText so the client knows
//                      when the text layer is a lie (CAD exports, scans).
//   default propose  — one bounded AI call over `text` (the client chunks).
//   "propose-vision" — render the requested PDF pages to images and let the
//                      model READ them. CAD-exported legends and scanned
//                      standards carry their whole vocabulary as pixels; the
//                      text layer has nothing but the title block.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId, type AiCallImage } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { ensurePdfPolyfills } from "@/lib/knowledgeText";
import type { ProposedEntry } from "@/lib/codebook";
import { parseModelJson } from "@/lib/modelJson";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SOURCE_CHARS = 12_000;     // per-CALL cap: the client chunks big documents
const MAX_VISION_PAGES_PER_CALL = 4; // render + model time must fit the function window
const VISION_RENDER_WIDTH = 1400;    // readable legend text, modest image tokens

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const PROMPT = `You are reading an engineering site's numbering / identification standard. Extract the site's coding vocabulary as strict JSON. Output ONLY a JSON object, no prose, with this exact shape:

{
  "units": [{"code": "20", "label": "Crude Unit"}],
  "equipmentTypes": [{"code": "30", "label": "Exchangers", "tagPrefixes": ["E"]}],
  "drawingTypes": [{"code": "02", "label": "P&ID"}],
  "notes": "one short paragraph: anything you noticed about the drawing-number convention (segment order, paper-size letters, sheet markers) the user should configure manually"
}

Rules:
- "units" are operating areas / process units identified by a number code.
- "equipmentTypes" are equipment classes identified by a number code; tagPrefixes are the field-tag letter prefixes (E for exchangers, P for pumps) when the document states or clearly implies them; omit tagPrefixes when unknown.
- "drawingTypes" are document/drawing discipline codes (P&ID, isometric, one-line, ...).
- Codes are strings — preserve leading zeros exactly ("02", not 2).
- Only include entries the document actually defines. Do not invent, do not pad with examples. Empty arrays are correct answers.
- If the document defines none of this, return all empty arrays and say so in notes.`;

/** The governed AI leg, shared by the text and vision propose paths: key +
 *  agreement + cap gates, the model call, metering, tolerant parse, and the
 *  cleaned proposal response. */
async function governedPropose(opts: {
  orgId: string;
  userId: string;
  userMessage: string;
  images?: AiCallImage[];
  sourceName: string;
}): Promise<NextResponse> {
  const { orgId, userId } = opts;

  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return bad("Add your Claude or OpenAI key in AI settings first — imports run on your own key.", 412);
  }
  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", userId)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    const tableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) {
      return bad("Accept the AI acceptable-use agreement first (ask any question in Knowledge to be prompted).", 428);
    }
  }
  const [monthSoFar, capUsd] = await Promise.all([getMonthUsage(orgId, userId), getCapUsd(orgId, userId)]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(`Monthly AI budget reached ($${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}).`, 402);
  }

  try {
    const out = await callAiModel({
      provider: conn.provider as AiProviderId,
      model: String(conn.model),
      apiKey: String(conn.api_key),
      system: PROMPT,
      user: opts.userMessage,
      images: opts.images,
      // Bounded input + bounded output = every call fits the platform's 60s
      // function window with margin, whatever the model speed.
      maxTokens: 4000,
      // Fail fast with a real message instead of letting the platform kill
      // the function into an opaque 502.
      timeoutMs: 40_000,
    });
    await recordAskUsage({
      orgId, userId, provider: String(conn.provider), model: String(conn.model),
      usage: out.usage, ok: true, op: "codebookImport",
    }).catch(() => undefined);

    // Tolerant parse: survives fences, prose prefixes, and token-cap
    // truncation (salvages every complete row instead of failing wholesale).
    const parsed = parseModelJson(out.text) as {
      units?: Array<{ code?: unknown; label?: unknown }>;
      equipmentTypes?: Array<{ code?: unknown; label?: unknown; tagPrefixes?: unknown }>;
      drawingTypes?: Array<{ code?: unknown; label?: unknown }>;
      notes?: unknown;
    } | null;
    if (!parsed) {
      return bad("The AI response couldn't be parsed — run it again (a retry usually succeeds), or try a smaller excerpt of the standard.", 502);
    }

    const clean = (kind: ProposedEntry["kind"], rows: Array<{ code?: unknown; label?: unknown; tagPrefixes?: unknown }> | undefined): ProposedEntry[] =>
      (Array.isArray(rows) ? rows : [])
        .map((r) => ({
          kind,
          code: String(r.code ?? "").trim(),
          label: String(r.label ?? "").trim(),
          tagPrefixes: Array.isArray(r.tagPrefixes)
            ? r.tagPrefixes.map((p) => String(p).trim().toUpperCase()).filter((p) => /^[A-Z]{1,4}$/.test(p))
            : undefined,
        }))
        .filter((r) => r.code.length > 0 && r.code.length <= 6 && r.label.length > 0 && r.label.length <= 80)
        .slice(0, 200);

    return NextResponse.json({
      proposals: [
        ...clean("unit", parsed.units),
        ...clean("equipment_type", parsed.equipmentTypes),
        ...clean("drawing_type", parsed.drawingTypes),
      ],
      notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 1000) : "",
      sourceName: opts.sourceName,
    });
  } catch (e) {
    await recordAskUsage({
      orgId, userId, provider: String(conn.provider), model: String(conn.model),
      usage: { inputTokens: 0, outputTokens: 0 }, ok: false, op: "codebookImport",
    }).catch(() => undefined);
    const msg = e instanceof AiCallError ? e.message : (e as Error).message;
    return bad(`AI call failed: ${msg}`, 502);
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: {
    orgId?: string; text?: string; knowledgeDocumentId?: string;
    fileName?: string; fileBase64?: string;
    /** "extract" = read the file/document to TEXT, no AI call (free, fast).
     *  "propose-vision" = render `pages` of the uploaded PDF and let the
     *  model read the images — for documents with no real text layer.
     *  Default = "propose": one AI call over `text` — the client extracts
     *  first, then sends bounded chunks so every call fits the platform's
     *  function window regardless of document size or model speed. */
    action?: string;
    /** 1-based page numbers for "propose-vision" (bounded per call). */
    pages?: number[];
    /** Progress label for chunked proposes ("part 2 of 5"). */
    partLabel?: string;
  };
  try { body = await req.json(); } catch { return bad("Invalid JSON body"); }
  const orgId = String(body.orgId ?? "");
  if (!orgId) return bad("orgId required");

  // Codebook writers only (same roles as the RLS policy).
  const { data: member } = await supabaseAdmin
    .from("org_members").select("role").eq("org_id", orgId).eq("uid", user.id)
    .eq("status", "active").maybeSingle();
  if (!member || !["Admin", "DocCtrl"].includes(String(member.role))) {
    return bad("Only Admins and Document Controllers can build the codebook", 403);
  }

  // ── Vision propose: render the requested pages and let the model READ the
  //    drawing. Page list is bounded per call — the client batches, exactly
  //    like text chunks — so render + model always fit the function window.
  if (body.action === "propose-vision") {
    const sourceName = String(body.fileName ?? "uploaded file");
    if (!body.fileBase64) return bad("Vision reads need the uploaded file — re-upload and try again.");
    let buf: Buffer;
    try { buf = Buffer.from(String(body.fileBase64), "base64"); } catch { return bad("Couldn't decode the uploaded file"); }
    if (buf.byteLength > 3_500_000) {
      return bad("That file is over the 3 MB upload limit — index it in a knowledge library instead and pick it from there.", 413);
    }
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
      return bad(`Vision reading works on PDFs — "${sourceName}" doesn't look like one.`, 422);
    }
    const pages = (Array.isArray(body.pages) ? body.pages : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1)
      .slice(0, MAX_VISION_PAGES_PER_CALL);
    if (pages.length === 0) return bad("pages required for a vision read");

    const images: AiCallImage[] = [];
    try {
      ensurePdfPolyfills();
      const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      for (const page of pages) {
        if (page > pdf.numPages) continue;
        const img = await renderPageAsImage(pdf, page, {
          width: VISION_RENDER_WIDTH,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        images.push({ mediaType: "image/png", base64: Buffer.from(img as ArrayBuffer).toString("base64") });
      }
    } catch (e) {
      return bad(`Couldn't render "${sourceName}" for reading: ${(e as Error).message}`, 422);
    }
    if (images.length === 0) return bad(`Those pages don't exist in "${sourceName}".`, 422);

    return governedPropose({
      orgId, userId: user.id, sourceName,
      images,
      userMessage:
        `PAGE IMAGES from "${sourceName}"${body.partLabel ? ` (${body.partLabel})` : ""} — ` +
        `a drawing legend / numbering standard rendered as images because it has no text layer. ` +
        `Read the tables, legends, and abbreviation lists in these images and extract only the coding vocabulary THESE pages define.`,
    });
  }

  // ── Source text, in priority order: uploaded file → pasted text → an
  //    indexed knowledge document's chunks.
  let source = String(body.text ?? "").trim();
  let sourceName = "pasted text";
  let pdfPageCount: number | undefined;
  if (body.fileBase64) {
    sourceName = String(body.fileName ?? "uploaded file");
    let buf: Buffer;
    try { buf = Buffer.from(String(body.fileBase64), "base64"); } catch { return bad("Couldn't decode the uploaded file"); }
    if (buf.byteLength > 3_500_000) {
      return bad("That file is over the 3 MB upload limit — index it in a knowledge library instead and pick it from there.", 413);
    }
    const head = buf.subarray(0, 5).toString("latin1");
    const isPdf = head.startsWith("%PDF") || /\.pdf$/i.test(sourceName);
    const isZip = head.startsWith("PK"); // .docx/.xlsx are ZIP containers
    const isCfb = buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf; // legacy .doc/.xls
    if (isPdf) {
      try {
        const { getDocumentProxy, extractText } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        pdfPageCount = pdf.numPages;
        const { text } = await extractText(pdf, { mergePages: true });
        source = String(text ?? "").trim();
      } catch (e) {
        return bad(`Couldn't read that PDF: ${(e as Error).message}`, 422);
      }
      // An empty text layer is not an error for "extract" — the reply's
      // thinText flag tells the client to come back through vision instead.
      if (!source && body.action !== "extract") {
        return bad(`"${sourceName}" has no extractable text (a scan or CAD export). Re-run the import — it will read the pages visually.`, 422);
      }
    } else if (isZip) {
      // Word .docx = ZIP of XML. Detected by CONTENT (word/document.xml
      // inside), never by filename — a mislabeled upload still works. Unzip
      // and strip markup — paragraph and table-cell boundaries become
      // newlines/tabs so the AI sees the numbering TABLES the way a human
      // reads them.
      try {
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(buf);
        const docXml = await zip.file("word/document.xml")?.async("string");
        if (!docXml) {
          return bad(`"${sourceName}" is a compressed container but not a Word document. Upload a .pdf, .docx, .txt, .csv, or .md.`, 422);
        }
        source = docXml
          .replace(/<w:tab[^>]*\/>/g, "\t")
          .replace(/<\/w:tc>/g, "\t")          // table cell boundary
          .replace(/<\/w:tr>/g, "\n")          // table row boundary
          .replace(/<\/w:p>/g, "\n")           // paragraph boundary
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
          .replace(/[ \t]{2,}/g, "\t")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      } catch (e) {
        return bad(`Couldn't read that Word document: ${(e as Error).message}`, 422);
      }
      if (!source) return bad(`"${sourceName}" contains no readable text.`, 422);
    } else if (isCfb || /\.doc$/i.test(sourceName)) {
      return bad(
        `"${sourceName}" is a LEGACY Word .doc (pre-2007 binary format), which can't be read reliably. ` +
        `Open it in Word and Save As → .docx or PDF, then upload that — both work here.`, 422);
    } else {
      source = buf.toString("utf-8").trim();
      // A "text" file that's mostly unprintable bytes is binary in disguise —
      // never send garbage to the model.
      const junk = (source.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) ?? []).length;
      if (!source || junk > source.length * 0.05) {
        return bad(`"${sourceName}" doesn't look like readable text. Upload a .pdf, .docx, .txt, .csv, or .md.`, 422);
      }
    }
  }
  if (!source && body.knowledgeDocumentId) {
    const { data: kdoc } = await supabaseAdmin
      .from("knowledge_documents").select("id, org_id, name, status")
      .eq("id", body.knowledgeDocumentId).eq("org_id", orgId).maybeSingle();
    if (!kdoc) return bad("Document not found in this workspace", 404);
    sourceName = String(kdoc.name ?? "document");
    const { data: chunks } = await supabaseAdmin
      .from("knowledge_chunks").select("page, content")
      .eq("document_id", kdoc.id).order("page").limit(120);
    source = ((chunks ?? []) as Array<{ page: number; content: string }>)
      .map((c) => c.content).join("\n\n").slice(0, MAX_SOURCE_CHARS);
    if (!source.trim()) {
      return bad(`"${sourceName}" has no extracted text yet — index it first, or paste the content directly.`, 422);
    }
  }

  // ── "extract" stops here: hand the TEXT back so the client can chunk it
  //    into bounded AI calls. No key, agreement, or spend involved. For PDFs,
  //    thinText says the text layer can't be the whole story — CAD exports
  //    and scans render their vocabulary as pixels — so the client should
  //    propose through vision page reads instead.
  if (body.action === "extract") {
    if (!source && typeof pdfPageCount !== "number") {
      return bad("Provide text or pick an indexed document");
    }
    const thinText = typeof pdfPageCount === "number" && pdfPageCount > 0 &&
      source.length < Math.max(400, pdfPageCount * 200);
    return NextResponse.json({
      text: source.slice(0, 80_000),
      sourceName,
      ...(typeof pdfPageCount === "number" ? { pageCount: pdfPageCount, thinText } : {}),
    });
  }

  if (!source) return bad("Provide text or pick an indexed document");
  source = source.slice(0, MAX_SOURCE_CHARS);

  // LAST-LINE GUARD, every path: if what we're about to send still looks like
  // binary (unprintable-byte ratio), refuse — the user's API key must never
  // be spent on garbage, and the model must never "analyze" compressed bytes.
  {
    const junk = (source.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) ?? []).length;
    if (junk > source.length * 0.05) {
      return bad(`The content from "${sourceName}" isn't readable text — it looks like binary data. Upload the document as .pdf or .docx, or paste the tables directly.`, 422);
    }
  }

  return governedPropose({
    orgId, userId: user.id, sourceName,
    userMessage: `SOURCE DOCUMENT (${sourceName}${body.partLabel ? `, ${body.partLabel} — extract only what THIS part defines` : ""}):\n\n${source}`,
  });
}
