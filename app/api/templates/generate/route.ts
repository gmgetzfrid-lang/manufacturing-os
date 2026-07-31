// /api/templates/generate — turn data + a template into finished documents.
//
// Two phases, deliberately separated so nobody gets a surprise batch:
//
//   action "draft"    → parse the source spreadsheet, map columns onto the
//                       template's tags, and have the model WRITE the prose
//                       fields in the example document's voice. Returns the
//                       drafted values for review — no files yet.
//   action "render"   → take (possibly edited) drafted values, inject them
//                       into the template file, and return the finished
//                       document(s): one file, or a zip for a batch. Can
//                       also file each one into document control as a draft
//                       revision with provenance.
//
// The model never touches the file: it supplies words, docxtemplater
// injects them into the user's own .docx, so formatting is exactly the
// template's. Drafting spends the caller's own AI key, metered and capped
// like every other model call in the app.

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { ALLOWED_PROVIDERS, estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import { renderTemplate, TemplateRenderError } from "@/lib/docxRender";
import { parseWorkbook } from "@/lib/xlsxData";
import { fetchBytes } from "@/lib/r2Bytes";
import {
  autoMapColumns, missingRequirements, renderFilename, uniqueFilenames,
  type Placeholder,
} from "@/lib/outputTemplateText";

export const runtime = "nodejs";
export const maxDuration = 300;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authUser(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  return error || !user ? null : user;
}

type TemplateRow = {
  id: string; org_id: string; name: string; kind: string;
  template_file_key: string | null; template_file_name: string | null;
  example_text: string | null; placeholders: Placeholder[];
  instructions: string | null; mode: string; column_map: Record<string, string>;
  filename_pattern: string | null;
};

/** Batch cap per request — big jobs run in slices so a serverless timeout
 *  can never eat a 300-row run silently. */
const MAX_ROWS_PER_CALL = 25;

export async function POST(req: NextRequest) {
  let body: {
    orgId?: string; templateId?: string; action?: string;
    sourceFileKey?: string; sourceName?: string; sheet?: string;
    columnMap?: Record<string, string>;
    mode?: string;
    rowOffset?: number;
    /** For render: the reviewed values, one object per document. */
    documents?: Array<{ values: Record<string, string>; filename?: string }>;
    /** Return the rendered files as base64 JSON instead of a download, so
     *  the client can file them into document control through the normal
     *  (RLS-checked, versioned, audited) document-creation path. */
    returnJson?: boolean;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const templateId = String(body.templateId ?? "").trim();
  if (!orgId || !templateId) return bad("orgId and templateId are required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const { data: tplRow, error: tplErr } = await supabaseAdmin
    .from("output_templates").select("*").eq("id", templateId).eq("org_id", orgId).maybeSingle();
  if (tplErr || !tplRow) return bad("Template not found", 404);
  const tpl = tplRow as unknown as TemplateRow;
  if (!tpl.template_file_key) return bad("This template has no template file uploaded yet.", 412);

  const placeholders: Placeholder[] = Array.isArray(tpl.placeholders) ? tpl.placeholders : [];
  const mode = ["per_row", "summary"].includes(String(body.mode)) ? String(body.mode)
    : (tpl.mode === "summary" ? "summary" : "per_row");

  // ── DRAFT ──────────────────────────────────────────────────────────────
  if (body.action !== "render") {
    const sourceFileKey = String(body.sourceFileKey ?? "").trim();
    if (!sourceFileKey) return bad("Upload the data file first.");

    let sheetData;
    try {
      sheetData = parseWorkbook(await fetchBytes(sourceFileKey), body.sheet);
    } catch (e) {
      return bad(`Couldn't read that spreadsheet: ${(e as Error).message}`, 400);
    }
    if (sheetData.rows.length === 0) {
      return bad("That sheet has no data rows under its header row.", 400);
    }

    const dataTags = placeholders.filter((p) => p.kind === "data").map((p) => p.tag);
    const columnMap: Record<string, string> = {
      ...autoMapColumns(dataTags, sheetData.headers),
      ...(tpl.column_map ?? {}),
      ...(body.columnMap ?? {}),
    };
    const missing = missingRequirements(placeholders, columnMap, sheetData.headers);
    if (missing.length > 0) {
      // ONE clear question, not a failed run.
      return NextResponse.json({
        needsMapping: true,
        missing,
        headers: sheetData.headers,
        columnMap,
        sheetNames: sheetData.sheetNames,
        rowCount: sheetData.rows.length,
      });
    }

    const aiFields = placeholders.filter((p) => p.kind === "ai");
    const offset = Math.max(0, Number(body.rowOffset ?? 0));
    const slice = mode === "summary"
      ? sheetData.rows
      : sheetData.rows.slice(offset, offset + MAX_ROWS_PER_CALL);

    // Static + data values need no model at all.
    const baseValues = (row: Record<string, string>): Record<string, string> => {
      const v: Record<string, string> = {};
      for (const p of placeholders) {
        if (p.kind === "static") v[p.tag] = p.value ?? "";
        else if (p.kind === "data") v[p.tag] = row[columnMap[p.tag] ?? ""] ?? "";
      }
      return v;
    };

    const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
    let providerUsed = "", modelUsed = "";

    // Only load an AI key if prose actually has to be written.
    let conn: { provider: AiProviderId; model: string; api_key: string } | null = null;
    if (aiFields.length > 0) {
      const { data: c } = await supabaseAdmin
        .from("ai_connections").select("provider, model, api_key")
        .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
      if (!c || !ALLOWED_PROVIDERS.includes(c.provider as AiProviderId)) {
        return bad(
          "This template has AI-written sections, so it needs your own API key — add a Claude or " +
          "OpenAI key in AI settings (Knowledge → AI settings).",
          412,
        );
      }
      const [spent, cap] = await Promise.all([
        getMonthUsage(orgId, user.id), getCapUsd(orgId, user.id),
      ]);
      if (cap > 0 && spent.spentUsd >= cap) {
        return bad(
          `Monthly AI budget reached — $${spent.spentUsd.toFixed(2)} of $${cap.toFixed(2)}. ` +
          "It resets on the 1st; an Admin can raise the cap in AI settings.",
          402,
        );
      }
      conn = { provider: c.provider as AiProviderId, model: c.model as string, api_key: c.api_key as string };
      providerUsed = conn.provider; modelUsed = conn.model;
    }

    const styleGuide = (tpl.example_text ?? "").trim();
    const system =
      "You write sections of a company document that will be injected into that company's OWN " +
      "template file. Write ONLY the words for the requested fields.\n\n" +
      "Return STRICT JSON: an object whose keys are the field tags and whose values are the text " +
      "for that field. No markdown, no code fence, no commentary.\n\n" +
      "VOICE: match the example document's phrasing, nomenclature, abbreviations, level of detail, " +
      "and section length. Reuse its standard sentences where they fit. Never invent facts that " +
      "aren't in the row data — if something isn't provided, write what the example writes in that " +
      "situation, or keep it general rather than fabricating specifics.\n" +
      "Plain sentences only: NO markdown syntax (no **, no #, no bullets unless the example uses " +
      "them), because this text lands directly in a formatted Word document. Use \\n for line breaks." +
      (tpl.instructions ? `\n\nSTANDING INSTRUCTIONS:\n${tpl.instructions.slice(0, 2000)}` : "") +
      (styleGuide ? `\n\nEXAMPLE DOCUMENT (the voice to match):\n${styleGuide.slice(0, 8000)}` : "");

    const fieldSpec = aiFields
      .map((f) => `- ${f.tag}: ${f.guidance || f.label}`)
      .join("\n");

    const draftOne = async (rowsForDoc: Array<Record<string, string>>, known: Record<string, string>) => {
      if (aiFields.length === 0 || !conn) return {} as Record<string, string>;
      const dataBlock = rowsForDoc.length === 1
        ? Object.entries(rowsForDoc[0]).map(([k, v]) => `${k}: ${v}`).join("\n")
        : rowsForDoc.map((r, i) =>
            `ROW ${i + 1}\n` + Object.entries(r).map(([k, v]) => `  ${k}: ${v}`).join("\n")).join("\n\n");
      const out = await callAiModel({
        provider: conn.provider, model: conn.model, apiKey: conn.api_key,
        system,
        user:
          `FIELDS TO WRITE (JSON keys):\n${fieldSpec}\n\n` +
          `ALREADY-KNOWN VALUES (do not contradict):\n${Object.entries(known)
            .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)"}\n\n` +
          `SOURCE DATA:\n${dataBlock}`,
        maxTokens: 3000,
      });
      usage.inputTokens += out.usage.inputTokens;
      usage.outputTokens += out.usage.outputTokens;
      modelUsed = conn.model;
      // Tolerant JSON parse — models occasionally wrap in prose/fences.
      const text = out.text.trim();
      const json = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const clean: Record<string, string> = {};
        for (const f of aiFields) {
          const v = parsed[f.tag];
          clean[f.tag] = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
        }
        return clean;
      } catch {
        return Object.fromEntries(aiFields.map((f) => [f.tag, ""])) as Record<string, string>;
      }
    };

    const documents: Array<{ values: Record<string, string>; filename: string; sourceRow?: number }> = [];
    try {
      if (mode === "summary") {
        const known = baseValues(slice[0] ?? {});
        const drafted = await draftOne(slice, known);
        const values = { ...known, ...drafted };
        documents.push({
          values,
          filename: renderFilename(tpl.filename_pattern, values, tpl.name, tpl.kind === "xlsx" ? "xlsx" : "docx"),
        });
      } else {
        for (let i = 0; i < slice.length; i++) {
          const known = baseValues(slice[i]);
          const drafted = await draftOne([slice[i]], known);
          const values = { ...known, ...drafted };
          documents.push({
            values,
            filename: renderFilename(
              tpl.filename_pattern, values, tpl.name,
              tpl.kind === "xlsx" ? "xlsx" : "docx", offset + i,
            ),
            sourceRow: offset + i + 1,
          });
        }
      }
    } catch (e) {
      if (usage.inputTokens + usage.outputTokens > 0) {
        await recordAskUsage({
          orgId, userId: user.id, provider: providerUsed || "none",
          model: modelUsed, usage, ok: false, op: "templateDraft",
        });
      }
      if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
      return bad(`Drafting failed: ${(e as Error).message}`, 502);
    }

    if (usage.inputTokens + usage.outputTokens > 0) {
      await recordAskUsage({
        orgId, userId: user.id, provider: providerUsed, model: modelUsed,
        usage, ok: true, op: "templateDraft",
      });
    }

    const nextOffset = mode === "summary" ? null
      : (offset + slice.length < sheetData.rows.length ? offset + slice.length : null);

    return NextResponse.json({
      documents,
      columnMap,
      headers: sheetData.headers,
      sheetNames: sheetData.sheetNames,
      rowCount: sheetData.rows.length,
      nextOffset,
      estCostUsd: usage.inputTokens + usage.outputTokens > 0
        ? estimateCostUsd(modelUsed, usage) : 0,
    });
  }

  // ── RENDER ─────────────────────────────────────────────────────────────
  const docs = Array.isArray(body.documents) ? body.documents : [];
  if (docs.length === 0) return bad("Nothing to render.");

  let templateBytes: Buffer;
  try {
    templateBytes = await fetchBytes(tpl.template_file_key);
  } catch (e) {
    return bad(`Couldn't read the template file: ${(e as Error).message}`, 502);
  }

  const ext = tpl.kind === "xlsx" ? "xlsx" : "docx";
  const names = uniqueFilenames(docs.map((d, i) =>
    d.filename?.trim() || renderFilename(tpl.filename_pattern, d.values, tpl.name, ext, i)));

  const rendered: Array<{ name: string; bytes: Uint8Array }> = [];
  try {
    for (let i = 0; i < docs.length; i++) {
      rendered.push({ name: names[i], bytes: renderTemplate(templateBytes, docs[i].values) });
    }
  } catch (e) {
    if (e instanceof TemplateRenderError) return bad(e.message, 400);
    return bad(`Rendering failed: ${(e as Error).message}`, 500);
  }

  // Production record — what was made, from what, by whom.
  await supabaseAdmin.from("output_generations").insert({
    org_id: orgId, template_id: tpl.id, template_name: tpl.name,
    source_name: body.sourceName ?? null, document_count: rendered.length,
    mode, created_by: user.id,
  }).then(() => undefined, () => undefined);
  await supabaseAdmin.from("audit_logs").insert({
    action: "OUTPUT_DOCS_GENERATED",
    resource_type: "output_template", resource_id: tpl.id,
    org_id: orgId, user_id: user.id,
    details: { template: tpl.name, count: rendered.length, mode, source: body.sourceName ?? null },
  }).then(() => undefined, () => undefined);

  const contentType = ext === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  if (body.returnJson) {
    return NextResponse.json({
      files: rendered.map((r) => ({
        name: r.name,
        contentType,
        base64: Buffer.from(r.bytes).toString("base64"),
      })),
    });
  }

  if (rendered.length === 1) {
    return new NextResponse(new Uint8Array(rendered[0].bytes), {
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${rendered[0].name.replace(/"/g, "")}"`,
      },
    });
  }

  const zip = new JSZip();
  for (const r of rendered) zip.file(r.name, r.bytes);
  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const zipName = `${tpl.name.replace(/[\\/:*?"<>|]+/g, "-")} — ${rendered.length} documents.zip`;
  return new NextResponse(new Uint8Array(zipBytes), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${zipName.replace(/"/g, "")}"`,
    },
  });
}
