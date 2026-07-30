// /api/knowledge/ask — the question-answering seam for knowledge libraries.
//
// POST { orgId, libraryId, question } →
//   { answer, citations: [{n, documentId, documentName, page}], provider, model }
//
// Two model calls on the asker's EFFECTIVE connection (their personal key if
// they set one, else the org default — always their money, never ours):
//
//   1. Turn the question into 2-4 full-text search queries. Provider-neutral
//      trick: retrieval is Postgres FTS, so the model compensates for the
//      lack of embeddings by writing good keyword queries.
//   2. Answer FROM the retrieved passages only, citing [n] markers that map
//      to (document, page) — every claim traceable to a real page.
//
// Every Q&A lands in knowledge_questions (the library's own record) and the
// ai_usage_events meter.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { callAiModel, AiCallError, type AiProviderId } from "@/lib/ai/providerCall";
import {
  parseSearchQueries, extractCitationNumbers, mergeRetrieved, type RetrievedChunk,
} from "@/lib/knowledgeText";

export const runtime = "nodejs";
export const maxDuration = 120;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; libraryId?: string; question?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!orgId || !libraryId || !question) return bad("orgId, libraryId and question are required");

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid, display_name, email")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active")
    .maybeSingle();
  if (!member) return bad("Not a member of this workspace", 403);
  const userName = (member.display_name as string) || (member.email as string) || "Member";

  const { data: library } = await supabaseAdmin
    .from("knowledge_libraries").select("id, name").eq("id", libraryId).eq("org_id", orgId).maybeSingle();
  if (!library) return bad("Library not found", 404);

  // Effective connection: personal override wins, else the org default.
  const { data: connRows } = await supabaseAdmin
    .from("ai_connections").select("user_id, provider, model, api_key")
    .eq("org_id", orgId)
    .or(`user_id.is.null,user_id.eq.${user.id}`);
  const conn = (connRows ?? []).find((r) => r.user_id === user.id)
    ?? (connRows ?? []).find((r) => r.user_id === null);
  if (!conn) {
    return bad("No AI connection configured — add a provider API key in AI settings first.", 412);
  }
  const provider = conn.provider as AiProviderId;
  const model = conn.model as string;
  const apiKey = conn.api_key as string;

  const meter = (ok: boolean) =>
    supabaseAdmin.from("ai_usage_events")
      .insert({ user_id: user.id, org_id: orgId, op: "knowledgeAsk", provider, ok })
      .then(() => undefined, () => undefined);

  try {
    // ── Step 1: question → search queries ────────────────────────────────
    const queryText = await callAiModel({
      provider, model, apiKey,
      system:
        'You generate full-text search queries for a technical document library at an oil refinery. ' +
        'Given a question, reply with ONLY a JSON array of 2-4 short keyword queries (2-6 words each) ' +
        'that would find the relevant passages. Include exact designations (like "ASME B16.5") verbatim ' +
        'when present. No prose, no code fence — just the JSON array.',
      user: question,
      maxTokens: 1000,
    });
    const queries = parseSearchQueries(queryText, question);

    // ── Retrieval: ranked FTS per query, merged ──────────────────────────
    const batches: RetrievedChunk[][] = [];
    for (const q of queries) {
      const { data } = await supabaseAdmin.rpc("knowledge_search", {
        p_org: orgId, p_library: libraryId, p_query: q, p_limit: 10,
      });
      if (Array.isArray(data)) batches.push(data as RetrievedChunk[]);
    }
    const chunks = mergeRetrieved(batches);

    if (chunks.length === 0) {
      const answer =
        "I couldn't find anything in this library that matches the question. " +
        "It may not be covered by the indexed documents, or it may use different terminology — try rephrasing with the exact terms the standard would use.";
      await supabaseAdmin.from("knowledge_questions").insert({
        org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
        question, answer, citations: [], provider, model,
      });
      await meter(true);
      return NextResponse.json({ answer, citations: [], provider, model });
    }

    // Names for the documents the chunks came from.
    const docIds = [...new Set(chunks.map((c) => c.document_id))];
    const { data: docs } = await supabaseAdmin
      .from("knowledge_documents").select("id, name").in("id", docIds);
    const docName = new Map((docs ?? []).map((d) => [d.id as string, d.name as string]));

    // ── Step 2: passages → cited answer ──────────────────────────────────
    const passages = chunks.map((c, i) =>
      `[${i + 1}] (${docName.get(c.document_id) ?? "Document"}, page ${c.page})\n${c.content}`,
    ).join("\n\n");

    const answer = await callAiModel({
      provider, model, apiKey,
      system:
        "You are the reference-library assistant for a refinery document control system. Answer the " +
        "question USING ONLY the numbered passages provided. Cite every factual claim with its passage " +
        "marker like [2] (multiple allowed, e.g. [1][3]). If the passages only partially answer, say " +
        "exactly what is and isn't covered. If they don't answer it at all, say so plainly — NEVER " +
        "invent requirements, values, or clause numbers that aren't in the passages. Engineers act on " +
        "these answers. Be direct and complete, but do not pad.",
      user: `PASSAGES:\n\n${passages}\n\nQUESTION: ${question}`,
      maxTokens: 3000,
    });

    // Citations the answer actually used, in order of first use.
    const used = extractCitationNumbers(answer);
    const citations = used
      .filter((n) => n >= 1 && n <= chunks.length)
      .map((n) => {
        const c = chunks[n - 1];
        return {
          n,
          documentId: c.document_id,
          documentName: docName.get(c.document_id) ?? "Document",
          page: c.page,
        };
      });

    await supabaseAdmin.from("knowledge_questions").insert({
      org_id: orgId, library_id: libraryId, user_id: user.id, user_name: userName,
      question, answer, citations, provider, model,
    });
    await supabaseAdmin.from("audit_logs").insert({
      action: "KNOWLEDGE_ASKED",
      resource_type: "knowledge_library", resource_id: libraryId,
      org_id: orgId, user_id: user.id,
      details: { library: library.name, question: question.slice(0, 200), citations: citations.length },
    }).then(() => undefined, () => undefined);
    await meter(true);

    return NextResponse.json({ answer, citations, provider, model });
  } catch (e) {
    await meter(false);
    if (e instanceof AiCallError) return bad(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return bad(`Ask failed: ${(e as Error).message}`, 502);
  }
}
