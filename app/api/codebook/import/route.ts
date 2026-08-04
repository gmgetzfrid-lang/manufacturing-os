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
// Input: { orgId, text? , knowledgeDocumentId? } — paste text directly, or
// point at an indexed knowledge document (its extracted chunks are used, so
// a PDF standard works without any new upload path).

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

  let body: { orgId?: string; text?: string; knowledgeDocumentId?: string };
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

  // ── Source text: direct paste, or an indexed knowledge document's chunks.
  let source = String(body.text ?? "").trim();
  let sourceName = "pasted text";
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
