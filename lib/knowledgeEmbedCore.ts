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

    // ── Reuse before paying ─────────────────────────────────────────────
    // An identical passage (same file bytes, same page, same text) already
    // embedded by the same model — a re-added file, a copy filed in two
    // places, a retired copy — lends its vector. Only the rest are sent.
    {
      const reused = await reuseTwinVectors(orgId, batch, connection.model);
      if (reused.size > 0) {
        for (let i = 0; i < batch.length && !lastError; i += 8) {
          const group = batch.slice(i, i + 8).filter((c) => reused.has(c.id));
          const results = await Promise.all(group.map((c) =>
            supabaseAdmin.from("knowledge_chunks")
              .update({ embedding: reused.get(c.id)!, embedding_model: connection.model })
              .eq("id", c.id)));
          for (const r of results) {
            if (r.error) { lastError = r.error.message; break; }
            embedded += 1;
          }
        }
        if (lastError) break;
        const rest = batch.filter((c) => !reused.has(c.id));
        if (rest.length === 0) continue;
        batch.length = 0;
        batch.push(...rest);
      }
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

/** Vectors for chunks whose identical twin (same file hash, page and text)
 *  is already embedded with `model`. Best-effort: any failure = no reuse. */
async function reuseTwinVectors(
  orgId: string,
  batch: Array<{ id: string; content: string; page: number; document_id: string }>,
  model: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const docIds = [...new Set(batch.map((c) => c.document_id))];
    const { data: docs } = await supabaseAdmin.from("knowledge_documents")
      .select("id, file_hash").in("id", docIds);
    const hashOf = new Map(((docs ?? []) as Array<{ id: string; file_hash: string | null }>)
      .filter((d) => d.file_hash).map((d) => [d.id, d.file_hash as string]));
    const hashes = [...new Set(hashOf.values())];
    if (hashes.length === 0) return out;
    const { data: twins } = await supabaseAdmin.from("knowledge_documents")
      .select("id, file_hash").eq("org_id", orgId).in("file_hash", hashes);
    const twinsByHash = new Map<string, string[]>();
    for (const t of (twins ?? []) as Array<{ id: string; file_hash: string }>) {
      if (docIds.includes(t.id)) continue;
      twinsByHash.set(t.file_hash, [...(twinsByHash.get(t.file_hash) ?? []), t.id]);
    }
    const twinIds = [...new Set([...twinsByHash.values()].flat())].slice(0, 50);
    if (twinIds.length === 0) return out;
    const pages = [...new Set(batch.map((c) => c.page))];
    const { data: rows } = await supabaseAdmin.from("knowledge_chunks")
      .select("document_id, page, content, embedding")
      .in("document_id", twinIds).in("page", pages)
      .eq("embedding_model", model).not("embedding", "is", null).limit(500);
    const byKey = new Map<string, string>();
    for (const r of (rows ?? []) as Array<{ document_id: string; page: number; content: string; embedding: unknown }>) {
      const hash = [...twinsByHash.entries()].find(([, ids]) => ids.includes(r.document_id))?.[0];
      if (!hash || r.embedding == null) continue;
      const v = typeof r.embedding === "string" ? r.embedding : JSON.stringify(r.embedding);
      byKey.set(`${hash}|${r.page}|${r.content}`, v);
    }
    for (const c of batch) {
      const hash = hashOf.get(c.document_id);
      const v = hash ? byKey.get(`${hash}|${c.page}|${c.content}`) : undefined;
      if (v) out.set(c.id, v);
    }
  } catch { /* no reuse this batch */ }
  return out;
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
