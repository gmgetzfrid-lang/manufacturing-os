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
//   action "filed"    → close the loop on a render that was filed into
//                       document control: filing happens client-side (so it
//                       goes through the normal RLS-checked, versioned,
//                       audited creation path), and this records how many
//                       actually landed against that production record.
//
// The model never touches the file: it supplies words, docxtemplater
// injects them into the user's own .docx, so formatting is exactly the
// template's. Drafting spends the caller's own AI key behind the one gate
// stack (lib/ai/aiGates — own key, allowlist, the signed agreement, the cap
// over every op; GOV-11 / PR-12), each document's call reserved before it is
// made and settled after (GOV-13).
//
// PR-6: a draft whose reply cannot be read as the requested fields — no JSON
// object, JSON that does not parse (often a reply cut off at its length
// limit), or a field left out — FAILS for that row: no document with
// silently blank AI sections is ever returned. In a per-row batch the slice
// stops at that row: the documents drafted before it come back (they were
// paid for), the row is named in `skippedRows` with the reason and `stopped`
// says so, and `nextOffset` is the row AFTER it — so a row whose reply is
// unreadable every time cannot hold the batch. A cap stop, or a provider
// failure (a timeout, a 429, a 5xx) after the first row, also stops the
// slice at its row with the earlier documents kept, and the next slice
// starts AT that row (nothing was drafted for it). So in a per-row batch no
// drafted, paid-for row is thrown away; a provider failure on the slice's
// FIRST row answers with its error (nothing was drafted). A summary
// document (one call) answers 502. A field the model deliberately wrote as
// "" is kept as written.

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { memberDisplayName } from "@/lib/orgMemberName";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import { estimateCostUsd, type AiUsage } from "@/lib/ai/pricing";
import { assertAiGates, type AiGatePass } from "@/lib/ai/aiGates";
import { GovernedCallError } from "@/lib/ai/gateError";
import { renderTemplate, TemplateRenderError } from "@/lib/docxRender";
import { parseWorkbook } from "@/lib/xlsxData";
import { fetchBytes } from "@/lib/r2Bytes";
import { isSafeStorageKey } from "@/lib/storageKey";
import {
  autoMapColumns, missingRequirements, renderFilename, uniqueFilenames,
  pickDeclaredValues, contentDispositionAttachment,
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
 *  can never eat a 300-row run silently. XEDGE-11: the SAME cap bounds the
 *  render action (every rendered file is held in memory before the zip), and
 *  the client (lib/outputTemplates.ts RENDER_CHUNK) slices to it. */
const MAX_ROWS_PER_CALL = 25;

/** PR-6: one document's draft could not be read as its fields. */
class DraftParseError extends Error {
  constructor(public rowLabel: string, public reason: string) {
    super(`The AI's draft for ${rowLabel} couldn't be read — ${reason}`);
    this.name = "DraftParseError";
  }
}

/** PR-6: the reply → the requested fields, or why it is not usable. A
 *  missing key is a failed draft (it would render as a blank section); a key
 *  present as "" or null is the model's own answer and is kept. */
function parseDraftFields(text: string, tags: readonly string[]):
  { ok: true; values: Record<string, string> } | { ok: false; reason: string } {
  const t = text.trim();
  const json = t.startsWith("{") ? t : (t.match(/\{[\s\S]*\}/)?.[0] ?? null);
  if (!json) return { ok: false, reason: "the reply held no JSON object" };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    return { ok: false, reason: "the reply's JSON did not parse (a reply cut off at its length limit does this)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the reply was not an object of fields" };
  }
  const obj = parsed as Record<string, unknown>;
  const missing = tags.filter((tag) => !Object.prototype.hasOwnProperty.call(obj, tag));
  if (missing.length > 0) return { ok: false, reason: `the reply left out ${missing.join(", ")}` };
  const values: Record<string, string> = {};
  for (const tag of tags) {
    const v = obj[tag];
    values[tag] = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  }
  return { ok: true, values };
}

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
    /** For action "filed": which production record, and how many landed. */
    generationId?: string;
    filedCount?: number;
  };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const templateId = String(body.templateId ?? "").trim();
  if (!orgId) return bad("orgId is required");
  if (!templateId && body.action !== "filed") return bad("templateId is required");
  const user = await authUser(req);
  if (!user) return bad("Unauthorized", 401);
  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  // ── FILED ──────────────────────────────────────────────────────────────
  // Write-back only: the caller can amend the record of a run THEY made, and
  // only the count — never the document count or the template it came from.
  if (body.action === "filed") {
    const generationId = String(body.generationId ?? "").trim();
    if (!generationId) return bad("generationId is required");
    const { data: gen } = await supabaseAdmin
      .from("output_generations").select("id, document_count")
      .eq("id", generationId).eq("org_id", orgId).eq("created_by", user.id).maybeSingle();
    if (!gen) return bad("That production record isn't yours.", 404);
    const filed = Math.max(0, Math.min(
      Number(body.filedCount ?? 0) || 0, Number(gen.document_count ?? 0),
    ));
    const { error } = await supabaseAdmin
      .from("output_generations").update({ filed_count: filed }).eq("id", generationId);
    if (error) return bad(`Couldn't record the filing: ${error.message}`, 500);
    return NextResponse.json({ ok: true, filedCount: filed });
  }

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

    // Authorize the KEY, not just the session (XEDGE-1). Without this the
    // route would fetch and PARSE any object in the bucket by caller-supplied
    // key, straight past document ACLs — the exact hole the sibling analyze
    // route (app/api/templates/route.ts:84-100) guards against. The draft
    // source is only ever an output-data/output-examples upload
    // (uploadTemplateFile), and those folders carry no document ACL, so
    // pinning the key to this org's own upload prefixes both closes the
    // cross-tenant read and keeps every legitimate draft working.
    if (!isSafeStorageKey(sourceFileKey)) {
      return bad("That data file path isn't valid.", 400);
    }
    const allowedSourcePrefixes = [
      `orgs/${orgId}/output-data/`,
      `orgs/${orgId}/output-examples/`,
    ];
    if (!allowedSourcePrefixes.some((p) => sourceFileKey.startsWith(p))) {
      return bad("That file isn't an output-data upload for this workspace.", 403);
    }

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
    let modelUsed = "";

    /** A gate refusal, said in this route's words. */
    const refusal = (e: GovernedCallError) => {
      if (e.status === 412) {
        return bad(
          "This template has AI-written sections, so it needs your own API key — add a Claude or " +
          "OpenAI key in AI settings (Knowledge → AI settings).",
          412,
        );
      }
      if (e.status === 402) {
        return bad(
          `${e.message} It resets on the 1st; someone who manages AI caps (an Admin, unless your ` +
          "workspace granted it to others) can raise it in AI settings.",
          402,
        );
      }
      return NextResponse.json({ error: e.message, ...(e.details ?? {}) }, { status: e.status });
    };

    // Only gate an AI key if prose actually has to be written: own key →
    // allowlist → agreement → cap over every op (GOV-11 / PR-12).
    let gate: AiGatePass | null = null;
    if (aiFields.length > 0) {
      try {
        gate = await assertAiGates({ orgId, userId: user.id, op: "templateDraft" });
      } catch (e) {
        if (e instanceof GovernedCallError) return refusal(e);
        throw e;
      }
      modelUsed = gate.connection.model;
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

    const draftOne = async (rowsForDoc: Array<Record<string, string>>, known: Record<string, string>, rowLabel: string) => {
      if (aiFields.length === 0 || !gate) return {} as Record<string, string>;
      const dataBlock = rowsForDoc.length === 1
        ? Object.entries(rowsForDoc[0]).map(([k, v]) => `${k}: ${v}`).join("\n")
        : rowsForDoc.map((r, i) =>
            `ROW ${i + 1}\n` + Object.entries(r).map(([k, v]) => `  ${k}: ${v}`).join("\n")).join("\n\n");
      const userText =
        `FIELDS TO WRITE (JSON keys):\n${fieldSpec}\n\n` +
        `ALREADY-KNOWN VALUES (do not contradict):\n${Object.entries(known)
          .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n") || "(none)"}\n\n` +
        `SOURCE DATA:\n${dataBlock}`;
      const { provider, model, apiKey } = gate.connection;
      // GOV-13: this document's worst case, reserved before the call.
      const reservation = await gate.reserve({ inputChars: system.length + userText.length, maxTokens: 3000 });
      let out: Awaited<ReturnType<typeof callAiModel>>;
      try {
        out = await callAiModel({ provider: provider as AiProviderId, model, apiKey, system, user: userText, maxTokens: 3000 });
      } catch (e) {
        await reservation.settle({ usage: { inputTokens: 0, outputTokens: 0 }, ok: false });
        throw e;
      }
      usage.inputTokens += out.usage.inputTokens;
      usage.outputTokens += out.usage.outputTokens;
      // Tolerant of prose / fences around the object — never of a missing or
      // unreadable one (PR-6).
      const parsed = parseDraftFields(out.text, aiFields.map((f) => f.tag));
      await reservation.settle({ usage: out.usage, ok: parsed.ok });
      if (!parsed.ok) throw new DraftParseError(rowLabel, parsed.reason);
      return parsed.values;
    };

    const documents: Array<{ values: Record<string, string>; filename: string; sourceRow?: number }> = [];
    /** PR-6: rows whose draft could not be read — left out, never blanked. */
    const skippedRows: Array<{ row: number; reason: string }> = [];
    let stopped: string | null = null;
    try {
      if (mode === "summary") {
        const known = baseValues(slice[0] ?? {});
        const drafted = await draftOne(slice, known, "the summary document");
        const values = { ...known, ...drafted };
        documents.push({
          values,
          filename: renderFilename(tpl.filename_pattern, values, tpl.name, tpl.kind === "xlsx" ? "xlsx" : "docx"),
        });
      } else {
        for (let i = 0; i < slice.length; i++) {
          const known = baseValues(slice[i]);
          let drafted: Record<string, string>;
          try {
            drafted = await draftOne([slice[i]], known, `row ${offset + i + 1}`);
          } catch (e) {
            // The cap (or the ledger) stopped the batch part-way: keep what
            // was drafted and paid for; the next slice starts at this row
            // and answers the refusal itself.
            if (e instanceof GovernedCallError && documents.length > 0) { stopped = e.message; break; }
            // PR-6: a provider failure (timeout, 429, 5xx) part-way: the
            // rows drafted before it were paid for and come back; this row
            // drafted nothing, so the next slice starts AT it.
            if (e instanceof AiCallError && documents.length > 0) {
              const row = offset + i + 1;
              const said = e.message.trim();
              stopped = `The AI provider failed on row ${row}: ${/[.!?]$/.test(said) ? said : `${said}.`} ` +
                `The rows drafted before it are kept; the next batch starts at row ${row}.`;
              break;
            }
            // PR-6: an unreadable draft stops the slice AT its row and skips
            // it — the earlier rows are kept, the next slice starts after it.
            if (e instanceof DraftParseError) {
              const row = offset + i + 1;
              skippedRows.push({ row, reason: e.reason });
              stopped = `${e.message}. Row ${row} was left out — no document with blank AI sections was made; ` +
                "the rows drafted before it are kept, and the next batch starts after it.";
              break;
            }
            throw e;
          }
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
      // Every call already settled its own metering row (GOV-13). Only the
      // summary document (one call) reaches here with an unreadable draft.
      if (e instanceof DraftParseError) {
        return bad(
          `${e.message}, so the summary document was not produced and nothing was left blank. ` +
          "Draft again to retry.",
          502,
        );
      }
      if (e instanceof GovernedCallError) return refusal(e);
      if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
      return bad(`Drafting failed: ${(e as Error).message}`, 502);
    }

    // Rows this slice used up: every drafted document, plus a skipped row
    // (a cap stop or a provider failure uses up nothing — it is retried).
    const consumed = mode === "summary" ? slice.length : documents.length + skippedRows.length;
    const nextOffset = mode === "summary" ? null
      : (offset + consumed < sheetData.rows.length ? offset + consumed : null);

    return NextResponse.json({
      documents,
      columnMap,
      headers: sheetData.headers,
      sheetNames: sheetData.sheetNames,
      rowCount: sheetData.rows.length,
      nextOffset,
      ...(stopped ? { stopped } : {}),
      ...(skippedRows.length > 0 ? { skippedRows } : {}),
      estCostUsd: usage.inputTokens + usage.outputTokens > 0
        ? estimateCostUsd(modelUsed, usage) : 0,
    });
  }

  // ── RENDER ─────────────────────────────────────────────────────────────
  const docs = Array.isArray(body.documents) ? body.documents : [];
  if (docs.length === 0) return bad("Nothing to render.");
  // XEDGE-11: bounded like the draft path — every rendered file is held in
  // memory until the zip is built, so an unbounded array is a memory ceiling
  // reached after the run is already on the record.
  if (docs.length > MAX_ROWS_PER_CALL) {
    return bad(`Render at most ${MAX_ROWS_PER_CALL} documents per call (${docs.length} sent); the client slices larger batches.`, 413);
  }

  let templateBytes: Buffer;
  try {
    templateBytes = await fetchBytes(tpl.template_file_key);
  } catch (e) {
    return bad(`Couldn't read the template file: ${(e as Error).message}`, 502);
  }

  const ext = tpl.kind === "xlsx" ? "xlsx" : "docx";
  // XEDGE-11: only the template's DECLARED tags reach the renderer — a
  // caller-invented key is dropped, never injected. The filename pattern
  // resolves against the same declared set.
  const values = docs.map((d) => pickDeclaredValues(d?.values, placeholders));
  const names = uniqueFilenames(docs.map((d, i) =>
    d.filename?.trim() || renderFilename(tpl.filename_pattern, values[i], tpl.name, ext, i)));

  const rendered: Array<{ name: string; bytes: Uint8Array }> = [];
  try {
    for (let i = 0; i < docs.length; i++) {
      rendered.push({ name: names[i], bytes: renderTemplate(templateBytes, values[i]) });
    }
  } catch (e) {
    if (e instanceof TemplateRenderError) return bad(e.message, 400);
    return bad(`Rendering failed: ${(e as Error).message}`, 500);
  }

  // Production record — what was made, from what, by whom. Its id goes back
  // to the caller so a filing run can amend it with how many landed.
  // XEDGE-2: written only AFTER the response has been constructed — a header
  // the runtime refuses must not leave behind a run that says N documents
  // were produced and an audit row saying they reached someone.
  const recordProduction = async (): Promise<string | null> => {
    const { data: genRow } = await supabaseAdmin.from("output_generations").insert({
      org_id: orgId, template_id: tpl.id, template_name: tpl.name,
      source_name: body.sourceName ?? null, document_count: rendered.length,
      mode, created_by: user.id,
      created_by_name: await memberDisplayName(orgId, user.id),
    }).select("id").maybeSingle().then((r) => r, () => ({ data: null }));
    await supabaseAdmin.from("audit_logs").insert({
      action: "OUTPUT_DOCS_GENERATED",
      resource_type: "output_template", resource_id: tpl.id,
      org_id: orgId, user_id: user.id,
      details: { template: tpl.name, count: rendered.length, mode, source: body.sourceName ?? null },
    }).then(() => undefined, () => undefined);
    return (genRow as { id?: string } | null)?.id ?? null;
  };

  const contentType = ext === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  if (body.returnJson) {
    const files = rendered.map((r) => ({
      name: r.name,
      contentType,
      base64: Buffer.from(r.bytes).toString("base64"),
    }));
    const generationId = await recordProduction();
    return NextResponse.json({ generationId, files });
  }

  // XEDGE-2: the filename travels as RFC 5987 `filename*` with an ASCII-folded
  // `filename=` fallback, so an em dash or a CJK character in a document name
  // (or in the zip name) can never make the response throw.
  let response: NextResponse;
  if (rendered.length === 1) {
    response = new NextResponse(new Uint8Array(rendered[0].bytes), {
      headers: {
        "content-type": contentType,
        "content-disposition": contentDispositionAttachment(rendered[0].name),
      },
    });
  } else {
    const zip = new JSZip();
    for (const r of rendered) zip.file(r.name, r.bytes);
    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const zipName = `${tpl.name.replace(/[\\/:*?"<>|]+/g, "-")} - ${rendered.length} documents.zip`;
    response = new NextResponse(new Uint8Array(zipBytes), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": contentDispositionAttachment(zipName),
      },
    });
  }
  await recordProduction();
  return response;
}
