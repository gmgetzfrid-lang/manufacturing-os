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
// Input: { orgId, fileBase64?+fileName?, text?, knowledgeDocumentId? } —
// upload the standard directly (PDF text is extracted server-side with the
// same engine knowledge ingest uses), paste text, or point at an indexed
// knowledge document. Uploads are capped at ~3 MB (platform request limit);
// bigger standards go through a knowledge library instead.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, AGREEMENT_VERSION } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import type { ProposedEntry } from "@/lib/codebook";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SOURCE_CHARS = 28_000;

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

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Not authenticated", 401);
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authErr || !user) return bad("Not authenticated", 401);

  let body: { orgId?: string; text?: string; knowledgeDocumentId?: string; fileName?: string; fileBase64?: string };
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

  // ── Source text, in priority order: uploaded file → pasted text → an
  //    indexed knowledge document's chunks.
  let source = String(body.text ?? "").trim();
  let sourceName = "pasted text";
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
        const { text } = await extractText(pdf, { mergePages: true });
        source = String(text ?? "").trim();
      } catch (e) {
        return bad(`Couldn't read that PDF: ${(e as Error).message}`, 422);
      }
      if (!source) {
        return bad(`"${sourceName}" has no extractable text (it may be a scan). Index it in a knowledge library — vision indexing can read it there — then pick it from the list.`, 422);
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

  // ── Governed AI: caller's key, agreement, cap — same gates as asks.
  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || !ALLOWED_PROVIDERS.includes(conn.provider as AiProviderId)) {
    return bad("Add your Claude or OpenAI key in AI settings first — imports run on your own key.", 412);
  }
  {
    const { data: agree, error: agreeError } = await supabaseAdmin
      .from("ai_key_agreements").select("id")
      .eq("org_id", orgId).eq("user_id", user.id)
      .eq("scope", "use").eq("agreement_version", AGREEMENT_VERSION).limit(1);
    const tableMissing = !!agreeError && (agreeError.code === "42P01" || /does not exist/i.test(agreeError.message));
    if (!tableMissing && (agree ?? []).length === 0) {
      return bad("Accept the AI acceptable-use agreement first (ask any question in Knowledge to be prompted).", 428);
    }
  }
  const [monthSoFar, capUsd] = await Promise.all([getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id)]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(`Monthly AI budget reached ($${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}).`, 402);
  }

  try {
    const out = await callAiModel({
      provider: conn.provider as AiProviderId,
      model: String(conn.model),
      apiKey: String(conn.api_key),
      system: PROMPT,
      user: `SOURCE DOCUMENT (${sourceName}):\n\n${source}`,
      maxTokens: 3000,
    });
    await recordAskUsage({
      orgId, userId: user.id, provider: String(conn.provider), model: String(conn.model),
      usage: out.usage, ok: true, op: "codebookImport",
    }).catch(() => undefined);

    // Parse strictly but survive fence-wrapped output.
    const raw = out.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let parsed: {
      units?: Array<{ code?: unknown; label?: unknown }>;
      equipmentTypes?: Array<{ code?: unknown; label?: unknown; tagPrefixes?: unknown }>;
      drawingTypes?: Array<{ code?: unknown; label?: unknown }>;
      notes?: unknown;
    };
    try { parsed = JSON.parse(raw); } catch {
      return bad("The AI response wasn't valid JSON — try again, or paste a cleaner excerpt of the standard.", 502);
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
      sourceName,
    });
  } catch (e) {
    await recordAskUsage({
      orgId, userId: user.id, provider: String(conn.provider), model: String(conn.model),
      usage: { inputTokens: 0, outputTokens: 0 }, ok: false, op: "codebookImport",
    }).catch(() => undefined);
    const msg = e instanceof AiCallError ? e.message : (e as Error).message;
    return bad(`AI call failed: ${msg}`, 502);
  }
}
