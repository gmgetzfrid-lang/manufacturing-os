// lib/knowledgeEmbedCore.ts — SERVER-ONLY. The one loop that turns
// unembedded knowledge chunks into vectors, shared by two drivers:
//
//   - /api/knowledge/embed        — the browser-driven build (user watching)
//   - /api/cron/embed-drain       — the background continuation (no tab)
//
// Extracted so a large library doesn't depend on someone keeping a browser
// tab alive for hours. Every committed batch is permanent; the slice stops
// on its time budget and reports what's left — the caller loops or the next
// cron run picks it up.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  embedPassages, toVectorLiteral, type EmbeddingProviderId,
} from "@/lib/ai/embeddings";
import { AiCallError } from "@/lib/ai/providerCall";

export interface EmbedConnection {
  provider: EmbeddingProviderId;
  model: string;
  apiKey: string;
}

export interface EmbedSliceResult {
  embedded: number;
  rateLimited: boolean;
  /** Chunks are missing vectors but none could be fetched — the classic
   *  stale-PostgREST-schema-cache symptom after a column rebuild. */
  fetchedNone: boolean;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** Embed one time-bounded slice of a library. Never throws — every outcome
 *  is a field on the result, because both drivers must keep going. */
export async function embedLibrarySlice(opts: {
  orgId: string;
  libraryId: string;
  connection: EmbedConnection;
  batchSize: number;
  /** Stop STARTING batches after this many ms. */
  budgetMs: number;
  /** Abort the in-flight provider call at this many ms — must leave room
   *  for the write-back inside the caller's platform limit. */
  hardStopMs: number;
}): Promise<EmbedSliceResult> {
  const { orgId, libraryId, connection, batchSize, budgetMs, hardStopMs } = opts;
  const startedAt = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let embedded = 0;
  let rateLimited = false;
  let fetchedNone = false;
  let lastError: string | null = null;

  while (Date.now() - startedAt < budgetMs) {
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
      if (embedded === 0) fetchedNone = true;
      break;
    }

    let vectors: number[][];
    try {
      // Contextual prefix: document name + section + page make the heading
      // visible to the vector space — the cheapest retrieval upgrade there is.
      const docNames = new Map<string, string>();
      {
        const ids = [...new Set(batch.map((c) => c.document_id))];
        const { data: docs } = await supabaseAdmin
          .from("knowledge_documents").select("id, name").in("id", ids);
        for (const d of (docs ?? []) as Array<{ id: string; name: string }>) {
          docNames.set(d.id, d.name);
        }
      }
      // HARD-BOUNDED: the in-flight provider call must never outlive the
      // caller's platform limit — it aborts with time left to commit.
      const callBudget = Math.max(5_000, hardStopMs - (Date.now() - startedAt));
      const out = await embedPassages({
        provider: connection.provider, model: connection.model, apiKey: connection.apiKey,
        passages: batch.map((c) => {
          const head = [docNames.get(c.document_id), c.section, `p.${c.page}`]
            .filter(Boolean).join(" — ");
          return head ? `${head}\n${c.content}` : c.content;
        }),
        kind: "document",             // corpus side of the asymmetric pair
        signal: AbortSignal.timeout(callBudget),
      });
      vectors = out.vectors;
      usage.inputTokens += out.usage.inputTokens;
    } catch (e) {
      // 429 is pacing, not failure — the driver waits out the window.
      if (e instanceof AiCallError && e.status === 429) { rateLimited = true; break; }
      // Ran out of clock, not out of luck: return committed progress.
      const name = (e as { name?: string })?.name ?? "";
      if (name === "TimeoutError" || name === "AbortError") break;
      lastError = e instanceof AiCallError ? e.message : "Embedding failed.";
      break;
    }

    // Write-back in parallel groups of 8 — primary-key updates are
    // independent, and sequential round trips were a third of the budget.
    for (let i = 0; i < batch.length && !lastError; i += 8) {
      const group = batch.slice(i, i + 8);
      const results = await Promise.all(group.map((c, j) =>
        supabaseAdmin.from("knowledge_chunks")
          .update({ embedding: toVectorLiteral(vectors[i + j]), embedding_model: connection.model })
          .eq("id", c.id)));
      for (const r of results) {
        if (r.error) { lastError = r.error.message; break; }
        embedded += 1;
      }
    }
    if (lastError) break;
  }

  return { embedded, rateLimited, fetchedNone, error: lastError, usage };
}

/** How many chunks in the library still lack vectors (fast partial-index count). */
export async function unembeddedCount(orgId: string, libraryId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("knowledge_chunks").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("library_id", libraryId).is("embedding", null);
  return count ?? 0;
}

/** Set / clear the background-continuation marker on a library. Starting a
 *  build in the UI records WHO consented to spend their key; the cron only
 *  ever continues builds carrying that consent. */
export async function setEmbedBuildMarker(
  libraryId: string, userId: string | null,
): Promise<void> {
  const { data: lib } = await supabaseAdmin
    .from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const feats = { ...((lib?.ai_features as Record<string, unknown> | null) ?? {}) };
  if (userId) feats.embedBuild = { userId, at: new Date().toISOString() };
  else delete feats.embedBuild;
  await supabaseAdmin.from("knowledge_libraries")
    .update({ ai_features: feats }).eq("id", libraryId)
    .then(() => undefined, () => undefined);
}
