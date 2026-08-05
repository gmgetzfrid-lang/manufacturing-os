// lib/ai/embeddings.ts — SERVER-ONLY. Turning passages into vectors.
//
// One provider, stated plainly: OpenAI. Of the two providers this product
// allows, Anthropic has no embeddings API, so a workspace whose members all
// use Claude keys gets keyword search alone. That isn't a bug to hide behind
// a spinner — it's a fact the UI says out loud, because a semantic search
// that silently isn't running produces answers that are mysteriously worse
// with no way for anyone to find out why.
//
// Runs on the SAME per-user key as everything else. Embedding a library costs
// the user real money (a few cents per thousand pages at current pricing),
// so it is opt-in, batched, resumable, and metered like every other AI call.

import { AiCallError } from "@/lib/ai/providerCall";

/** The model the vector column's 1536 dimensions belong to. Changing this
 *  means a new column and a re-embed — see the migration comment. */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/** OpenAI accepts up to 2048 inputs per call; 96 keeps a single request small
 *  enough to retry cheaply and to fit comfortably inside a serverless run. */
export const EMBED_BATCH = 96;

/** Roughly 8k tokens is the model's limit. Chunks are far smaller, but a
 *  pathological page (a giant table transcribed as one line) must not fail
 *  the whole batch. */
const MAX_INPUT_CHARS = 24_000;

export interface EmbedResult {
  vectors: number[][];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Embed a batch of passages.
 *
 * Returns one vector per input, in order — callers pair them back to chunk
 * ids positionally, so a partial or reordered response has to be a hard
 * error rather than a silent mismatch that files the wrong vector against
 * the wrong passage and poisons retrieval invisibly.
 */
export async function embedPassages(
  apiKey: string,
  passages: readonly string[],
  signal?: AbortSignal,
): Promise<EmbedResult> {
  if (passages.length === 0) return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };
  if (passages.length > EMBED_BATCH) {
    throw new AiCallError(`Embed at most ${EMBED_BATCH} passages per call.`, 400);
  }

  const input = passages.map((p) => {
    const trimmed = p.trim();
    return (trimmed || " ").slice(0, MAX_INPUT_CHARS);
  });

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMENSIONS }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new AiCallError("OpenAI rejected the API key — check it in AI settings.", 401);
    }
    if (res.status === 429) {
      throw new AiCallError("OpenAI rate/credit limit hit — add credits or wait a moment.", 429);
    }
    throw new AiCallError(`Embedding call failed (${res.status}): ${detail.slice(0, 200)}`, 502);
  }

  const body = await res.json() as {
    data?: Array<{ index: number; embedding: number[] }>;
    usage?: { prompt_tokens?: number };
  };
  const data = body.data ?? [];
  if (data.length !== passages.length) {
    throw new AiCallError(
      `Embedding response had ${data.length} vectors for ${passages.length} passages.`, 502,
    );
  }

  // The API documents index ordering, but pairing vectors to passages by
  // position without checking is exactly the kind of assumption that fails
  // silently and shows up months later as "search got worse".
  const vectors: number[][] = new Array(passages.length);
  for (const row of data) {
    if (row.index < 0 || row.index >= passages.length || !Array.isArray(row.embedding)) {
      throw new AiCallError("Embedding response was malformed.", 502);
    }
    if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new AiCallError(
        `Embedding had ${row.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}.`, 502,
      );
    }
    vectors[row.index] = row.embedding;
  }
  if (vectors.some((v) => !v)) throw new AiCallError("Embedding response skipped a passage.", 502);

  return {
    vectors,
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: 0 },
  };
}

/** Embed one query. Same model as the corpus — a query embedded with a
 *  different model finds neighbours in a space the documents don't live in. */
export async function embedQuery(apiKey: string, query: string, signal?: AbortSignal): Promise<number[]> {
  const { vectors } = await embedPassages(apiKey, [query], signal);
  return vectors[0];
}

/** pgvector's literal form. The driver has no vector type, so this is the
 *  wire format for both storage and the search RPC. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}
