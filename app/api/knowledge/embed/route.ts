// /api/knowledge/embed — building the meaning index, a batch at a time.
//
// POST { orgId, libraryId }        → embed the next batch, report what's left
// POST { orgId, libraryId, action:"status" } → coverage only, spends nothing
//
// RESUMABLE BY DESIGN. Free-tier serverless kills a request at 60 seconds, so
// this never tries to finish: it embeds what it can inside a budget, commits,
// and reports `remaining`. The caller loops. A pass that dies halfway has
// still permanently embedded every batch it committed — the one property that
// makes a long job survivable on infrastructure that can stop it at any time.
//
// Costs the user's own money on their own key, metered like every other call.
// Requires an OpenAI key specifically: Anthropic has no embeddings API, and
// this says so rather than failing obscurely.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embedPassages, toVectorLiteral, EMBED_BATCH, EMBEDDING_MODEL,
} from "@/lib/ai/embeddings";
import { AiCallError } from "@/lib/ai/providerCall";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Stop well short of the platform's kill so the last batch commits and the
 *  response is a real answer rather than a 504 the client has to guess at. */
const BUDGET_MS = 40_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function coverage(orgId: string, libraryId: string) {
  const { data, error } = await supabaseAdmin
    .rpc("semantic_coverage", { p_org_id: orgId, p_library_id: libraryId });
  if (error) return null;
  const row = (data as Array<{ total: number; embedded: number }> | null)?.[0];
  return { total: Number(row?.total ?? 0), embedded: Number(row?.embedded ?? 0) };
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; libraryId?: string; action?: string };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  const orgId = String(body.orgId ?? "").trim();
  const libraryId = String(body.libraryId ?? "").trim();
  if (!orgId || !libraryId) return bad("orgId and libraryId are required");

  const principal = await loadPrincipal(orgId, user.id);
  if (!principal) return bad("Not a member of this workspace", 403);

  const stats = await coverage(orgId, libraryId);
  if (!stats) {
    return bad(
      "Semantic search needs migration 20260930 — run it in Supabase, then try again.", 424,
    );
  }

  if (body.action === "status") {
    return NextResponse.json({
      ...stats, remaining: stats.total - stats.embedded, embedded: stats.embedded, spentThisRun: 0,
    });
  }

  if (!principal.isController) {
    return bad("Only Admin or Doc Control can build the meaning index.", 403);
  }

  const { data: conn } = await supabaseAdmin
    .from("ai_connections").select("provider, model, api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  if (!conn || conn.provider !== "openai") {
    return bad(
      "Semantic search needs an OpenAI key. Anthropic has no embeddings API, so a Claude key "
      + "can't build this index — keyword search keeps working either way. Save an OpenAI key "
      + "in AI settings to turn meaning-based search on.",
      412,
    );
  }
  const apiKey = conn.api_key as string;

  const [monthSoFar, capUsd] = await Promise.all([
    getMonthUsage(orgId, user.id),
    getCapUsd(orgId, user.id),
  ]);
  if (capUsd > 0 && monthSoFar.spentUsd >= capUsd) {
    return bad(
      `Monthly AI budget reached — $${monthSoFar.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}. `
      + "It resets on the 1st; an Admin can raise the cap in AI settings.",
      402,
    );
  }

  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let embedded = 0;
  let lastError: string | null = null;

  while (Date.now() - startedAt < BUDGET_MS) {
    const { data: chunks, error } = await supabaseAdmin
      .from("knowledge_chunks").select("id, content")
      .eq("org_id", orgId).eq("library_id", libraryId)
      .is("embedding", null)
      .limit(EMBED_BATCH);
    if (error) { lastError = error.message; break; }
    const batch = (chunks ?? []) as Array<{ id: string; content: string }>;
    if (batch.length === 0) break;

    let vectors: number[][];
    try {
      const out = await embedPassages(apiKey, batch.map((c) => c.content));
      vectors = out.vectors;
      usage.inputTokens += out.usage.inputTokens;
    } catch (e) {
      // Whatever we've already committed stays committed. Report and stop:
      // hammering a rejected key or an exhausted quota helps nobody.
      lastError = e instanceof AiCallError ? e.message : "Embedding failed.";
      break;
    }

    // One update per chunk. Slower than a bulk upsert, but an upsert on this
    // table would need every NOT NULL column echoed back, and getting that
    // wrong rewrites page text from a stale read.
    for (let i = 0; i < batch.length; i++) {
      const { error: writeError } = await supabaseAdmin
        .from("knowledge_chunks")
        .update({ embedding: toVectorLiteral(vectors[i]), embedding_model: EMBEDDING_MODEL })
        .eq("id", batch[i].id);
      if (writeError) { lastError = writeError.message; break; }
      embedded += 1;
    }
    if (lastError) break;
  }

  if (usage.inputTokens > 0) {
    await recordAskUsage({
      orgId, userId: user.id, provider: "openai", model: EMBEDDING_MODEL,
      usage, ok: !lastError, op: "knowledgeEmbed",
    });
  }

  const after = await coverage(orgId, libraryId);
  const remaining = after ? after.total - after.embedded : 0;
  return NextResponse.json({
    embedded,
    total: after?.total ?? stats.total,
    coveredNow: after?.embedded ?? stats.embedded,
    remaining,
    done: remaining === 0 && !lastError,
    error: lastError,
    spentThisRun: estimateCostUsd(EMBEDDING_MODEL, usage),
  });
}
