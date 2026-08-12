// /api/knowledge/embed — building the meaning index, a batch at a time.
//
// POST { orgId, libraryId }        → embed the next batch, report what's left
// POST { orgId, libraryId, action:"status" } → coverage only, spends nothing
// POST { orgId, libraryId, action:"reset" }  → clear vectors so the next
//        build re-embeds everything under current chunking and model
//
// RESUMABLE BY DESIGN. Free-tier serverless kills a request at 60 seconds, so
// this never tries to finish: it embeds what it can inside a budget, commits,
// and reports `remaining`. The caller loops. A pass that dies halfway has
// still permanently embedded every batch it committed — the one property that
// makes a long job survivable on infrastructure that can stop it at any time.
//
// Costs the user's own money on their own key, metered like every other call.
// Uses the EMBEDDING key, which is separate from the chat key — a Claude user
// keeps Claude for answers and adds a Voyage key for this.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal } from "@/lib/knowledgeAccess";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { getMonthUsage, getCapUsd, recordAskUsage } from "@/lib/ai/usageServer";
import {
  embedPassages, toVectorLiteral, embeddingConnectionFrom, EMBED_BATCH,
  NO_EMBEDDING_KEY_MESSAGE,
} from "@/lib/ai/embeddings";
import { AiCallError } from "@/lib/ai/providerCall";
import { openAiKey } from "@/lib/ai/keyVault";

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

  let body: { orgId?: string; libraryId?: string; action?: string; batch?: number };
  try { body = await req.json(); } catch { return bad("Expected JSON body"); }
  // Free-tier providers cap tokens-per-minute hard (Voyage without a card:
  // 10K TPM) — a full 96-passage batch can never fit. The client shrinks the
  // batch when it sees rateLimited and paces itself; we just honor the size.
  const batchSize = Math.max(1, Math.min(Number(body.batch) || EMBED_BATCH, EMBED_BATCH));
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
    // Mirror the SemanticProgress shape the build path returns EXACTLY.
    // This response used to omit coveredNow — the one field the panel
    // renders — so the bar showed 0% forever regardless of the database.
    return NextResponse.json({
      embedded: 0,                       // passages embedded by THIS call: none, it's a read
      total: stats.total,
      coveredNow: stats.embedded,
      remaining: stats.total - stats.embedded,
      done: stats.total - stats.embedded === 0,
      error: null,
      spentThisRun: 0,
    });
  }

  if (!principal.isController) {
    return bad("Only Admin or Doc Control can build the meaning index.", 403);
  }

  // Clear every vector so the next build re-embeds from scratch.
  //
  // This is not a convenience. Vectors are only as good as the chunking and
  // the model that produced them, and BOTH change: chunk boundaries move
  // when ingestion improves, and an embedding model gets swapped for a
  // better one. Without a reset those upgrades reach only documents added
  // afterwards, so a library ends up half-indexed under two different
  // regimes with nothing on screen saying so — the retrieval quietly gets
  // worse and no button exists to fix it. The build path only ever fills
  // rows where embedding IS NULL, which is exactly why emptying them is the
  // whole of a rebuild.
  if (body.action === "reset") {
    const { error } = await supabaseAdmin
      .from("knowledge_chunks")
      .update({ embedding: null, embedding_model: null })
      .eq("org_id", orgId)
      .eq("library_id", libraryId)
      .not("embedding", "is", null);
    if (error) return bad(`Couldn't clear the existing vectors: ${error.message}`, 500);
    const after = await coverage(orgId, libraryId);
    return NextResponse.json({
      embedded: 0,
      total: after?.total ?? stats.total,
      coveredNow: after?.embedded ?? 0,
      remaining: (after?.total ?? stats.total) - (after?.embedded ?? 0),
      done: false,
      error: null,
      spentThisRun: 0,
    });
  }

  const { data: conn } = await supabaseAdmin
    .from("ai_connections")
    .select("provider, api_key, embedding_provider, embedding_model, embedding_api_key")
    .eq("org_id", orgId).eq("user_id", user.id).maybeSingle();
  const embedding = embeddingConnectionFrom(conn && {
    ...conn,
    api_key: openAiKey(conn.api_key),
    embedding_api_key: openAiKey(conn.embedding_api_key),
  });
  if (!embedding) return bad(NO_EMBEDDING_KEY_MESSAGE, 412);

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
  let rateLimited = false;

  while (Date.now() - startedAt < BUDGET_MS) {
    const { data: chunks, error } = await supabaseAdmin
      .from("knowledge_chunks").select("id, content, section, page, document_id")
      .eq("org_id", orgId).eq("library_id", libraryId)
      .is("embedding", null)
      .limit(batchSize);
    if (error) { lastError = error.message; break; }
    const batch = (chunks ?? []) as Array<{
      id: string; content: string; section: string | null; page: number; document_id: string;
    }>;
    if (batch.length === 0) {
      // Coverage says passages lack vectors, yet the fetch returned none —
      // the classic symptom of a stale PostgREST schema cache after the
      // embedding column was rebuilt. Say so; silence here reads as "done".
      if (embedded === 0 && stats.total - stats.embedded > 0) {
        lastError =
          `${stats.total - stats.embedded} passages lack vectors but none could be fetched — ` +
          "the API schema cache is likely stale after a column rebuild. In the Supabase SQL " +
          "editor run:  NOTIFY pgrst, 'reload schema';  wait ~10 seconds, then build again.";
      }
      break;
    }

    let vectors: number[][];
    try {
      // Contextual prefix: the pipeline KNOWS the document name, the section
      // in force, and the page — and used to embed the bare text anyway, so
      // "§5.3 Pipe Supports" was invisible to the vector space. Prepending
      // the metadata line is the cheapest retrieval upgrade in the audit:
      // zero extra calls, and the heading often names the concept better
      // than any sentence in the chunk does.
      const docNames = new Map<string, string>();
      {
        const ids = [...new Set(batch.map((c) => c.document_id))];
        const { data: docs } = await supabaseAdmin
          .from("knowledge_documents").select("id, name").in("id", ids);
        for (const d of (docs ?? []) as Array<{ id: string; name: string }>) {
          docNames.set(d.id, d.name);
        }
      }
      const out = await embedPassages({
        provider: embedding.provider, model: embedding.model, apiKey: embedding.apiKey,
        passages: batch.map((c) => {
          const head = [docNames.get(c.document_id), c.section, `p.${c.page}`]
            .filter(Boolean).join(" — ");
          return head ? `${head}\n${c.content}` : c.content;
        }),
        // The corpus side of an asymmetric retrieval pair.
        kind: "document",
      });
      vectors = out.vectors;
      usage.inputTokens += out.usage.inputTokens;
    } catch (e) {
      // A 429 is pacing, not failure: the client waits out the provider's
      // window and continues with a smaller batch. Everything committed so
      // far stays committed either way.
      if (e instanceof AiCallError && e.status === 429) { rateLimited = true; break; }
      // Anything else: report and stop — hammering a rejected key or an
      // exhausted quota helps nobody.
      lastError = e instanceof AiCallError ? e.message : "Embedding failed.";
      break;
    }

    // One update per chunk. Slower than a bulk upsert, but an upsert on this
    // table would need every NOT NULL column echoed back, and getting that
    // wrong rewrites page text from a stale read.
    for (let i = 0; i < batch.length; i++) {
      const { error: writeError } = await supabaseAdmin
        .from("knowledge_chunks")
        .update({ embedding: toVectorLiteral(vectors[i]), embedding_model: embedding.model })
        .eq("id", batch[i].id);
      if (writeError) { lastError = writeError.message; break; }
      embedded += 1;
    }
    if (lastError) break;
  }

  if (usage.inputTokens > 0) {
    await recordAskUsage({
      orgId, userId: user.id, provider: embedding.provider, model: embedding.model,
      usage, ok: !lastError, op: "knowledgeEmbed",
    });
  }

  const after = await coverage(orgId, libraryId);
  // If the post-run count can't be read, DON'T claim done — an unverifiable
  // "complete" over a 0% bar is exactly the contradiction that burns trust.
  if (!after && !lastError) {
    lastError = "Couldn't verify the vector count after writing — re-check the panel; the build may still have succeeded.";
  }
  // Wrote vectors but the count didn't move: the writes are vanishing —
  // that's a bug worth naming, never a success.
  if (after && embedded > 0 && after.embedded < stats.embedded + embedded && !lastError) {
    lastError =
      `Wrote ${embedded} vector(s) but the library's count only shows ${after.embedded} — ` +
      "writes are not landing. Tell your admin: verify library_id/org_id on knowledge_chunks.";
  }
  const remaining = after ? after.total - after.embedded : 0;
  return NextResponse.json({
    embedded,
    total: after?.total ?? stats.total,
    coveredNow: after?.embedded ?? stats.embedded,
    remaining,
    done: remaining === 0 && !lastError && !rateLimited,
    error: lastError,
    rateLimited,
    // Free tiers meter per minute; a hair over one minute guarantees a
    // fresh window even with clock skew.
    retryAfterMs: rateLimited ? 65_000 : undefined,
    spentThisRun: estimateCostUsd(embedding.model, usage),
    provider: embedding.provider,
    model: embedding.model,
  });
}
