// lib/ai/embeddings.ts — SERVER-ONLY. Turning passages into vectors.
//
// THE EMBEDDING KEY IS NOT THE CHAT KEY. Anthropic makes no embeddings model,
// and an earlier cut of this file concluded from that fact that Claude users
// couldn't have semantic search. That was wrong: the chat model and the
// embedding model are unrelated services, and nothing stops a member holding
// a Claude key for answers and a separate key for embeddings. Anthropic's own
// guidance for Claude users points at Voyage AI, so that's the default here.
//
// Two providers, one vector shape:
//
//   voyage  — 1024 dims natively (the default for every Voyage text model)
//   openai  — text-embedding-3-*, asked for 1024 via the `dimensions` param
//
// Both land in the same vector(1024) column. What they must NOT do is share
// an index silently: a Voyage vector and an OpenAI vector describe different
// spaces, so every row records the model that produced it and search filters
// on it. Nearest-neighbour across that boundary is noise wearing a score.
//
// Runs on the member's own key and is metered like every other AI call.
// Embedding a library costs real money, so it is opt-in and batched.

import { AiCallError } from "@/lib/ai/providerCall";
import { estimateCostUsd } from "@/lib/ai/pricing";

export type EmbeddingProviderId = "voyage" | "openai";

/** The dimension the `embedding` column is declared at. Both providers can
 *  emit exactly this; anything else is a silent mismatch, so it's checked. */
export const EMBEDDING_DIMENSIONS = 1024;

export const EMBEDDING_PROVIDERS: ReadonlyArray<{
  id: EmbeddingProviderId;
  label: string;
  /** First entry is the default. */
  models: readonly string[];
  hint: string;
}> = [
  {
    id: "voyage",
    label: "Voyage AI",
    models: ["voyage-3.5-lite", "voyage-3.5", "voyage-3-large"],
    hint: "Anthropic's recommended embeddings provider — pairs with a Claude key.",
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
    hint: "Use if you already hold an OpenAI key.",
  },
];

export function defaultEmbeddingModel(provider: EmbeddingProviderId): string {
  return EMBEDDING_PROVIDERS.find((p) => p.id === provider)?.models[0] ?? "voyage-3.5-lite";
}

/** Both providers accept large batches; 96 keeps one request small enough to
 *  retry cheaply and to finish inside a serverless invocation. */
export const EMBED_BATCH = 96;

/** Well under either provider's context length. A pathological page (a giant
 *  table transcribed as one line) must not fail the whole batch. */
const MAX_INPUT_CHARS = 24_000;

/**
 * Retrieval embeddings are asymmetric.
 *
 * Voyage prepends a different instruction for a query than for a document,
 * and its docs are emphatic that omitting the distinction costs retrieval
 * quality. OpenAI has no such parameter. Callers always say which side they
 * are embedding, so the provider that cares gets told.
 */
export type EmbedInputKind = "document" | "query";

export interface EmbedResult {
  vectors: number[][];
  /** Input tokens as the provider reported them; output is always 0. */
  usage: { inputTokens: number; outputTokens: number };
}

interface EmbedRequest {
  provider: EmbeddingProviderId;
  model: string;
  apiKey: string;
  passages: readonly string[];
  kind: EmbedInputKind;
  signal?: AbortSignal;
}

/** An embeddings-provider refusal, carrying the provider's own HTTP status so
 *  a caller can tell "this PASSAGE was refused" (400 / 413 / 422 — split the
 *  batch, skip the one) from "this KEY or MODEL was refused" (everything
 *  else — stop, and never blame the passages). */
export type EmbeddingCallError = AiCallError & { providerStatus?: number };

function friendly(provider: EmbeddingProviderId, status: number, detail: string): EmbeddingCallError {
  const who = provider === "voyage" ? "Voyage AI" : "OpenAI";
  // Surface the provider's OWN words — "rejected the key" without the reason
  // ("expired trial", "add a payment method", "invalid key format") turns a
  // 30-second fix into a guessing game.
  const said = extractProviderDetail(detail);
  const suffix = said ? ` ${who} said: "${said}"` : "";
  const err = (message: string, code: number): EmbeddingCallError =>
    Object.assign(new AiCallError(message, code), { providerStatus: status });
  if (status === 401 || status === 403) {
    return err(`${who} rejected the embeddings key.${suffix || " Check the key in AI settings."}`, 401);
  }
  if (status === 429) {
    return err(`${who} rate/credit limit hit — add credits or wait a moment.${suffix}`, 429);
  }
  if (status === 404) {
    return err(`${who} doesn't recognise that embedding model.${suffix}`, 400);
  }
  return err(`${who} embedding call failed (${status}): ${said || detail.slice(0, 200)}`, 502);
}

/** Did the provider refuse the INPUT (a passage), rather than the key, the
 *  model or itself? Only these justify splitting a batch and, at a single
 *  passage, counting an attempt against it. */
export function isPassageRefusal(e: unknown): boolean {
  const s = (e as { providerStatus?: number } | null)?.providerStatus;
  return s === 400 || s === 413 || s === 422;
}

/** Pull the human sentence out of a provider error body — Voyage uses
 *  {"detail": "..."}, OpenAI {"error": {"message": "..."}} — else raw text. */
function extractProviderDetail(raw: string): string {
  if (!raw) return "";
  try {
    const j = JSON.parse(raw) as { detail?: unknown; error?: { message?: unknown }; message?: unknown };
    const msg = (typeof j.detail === "string" && j.detail)
      || (typeof j.error?.message === "string" && j.error.message)
      || (typeof j.message === "string" && j.message)
      || "";
    return String(msg).slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

/**
 * Embed a batch of passages.
 *
 * Returns one vector per input, IN INPUT ORDER. Callers pair them back to
 * chunk ids positionally, so a short, reordered, or wrong-width response has
 * to be a hard error — the alternative is filing the wrong vector against the
 * wrong passage, which poisons retrieval invisibly and forever.
 */
export async function embedPassages(req: EmbedRequest): Promise<EmbedResult> {
  const { provider, model, apiKey, passages, kind, signal } = req;
  if (passages.length === 0) return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };
  if (passages.length > EMBED_BATCH) {
    throw new AiCallError(`Embed at most ${EMBED_BATCH} passages per call.`, 400);
  }

  const input = passages.map((p) => (p.trim() || " ").slice(0, MAX_INPUT_CHARS));

  const url = provider === "voyage"
    ? "https://api.voyageai.com/v1/embeddings"
    : "https://api.openai.com/v1/embeddings";

  const body = provider === "voyage"
    ? {
        model, input,
        // Voyage's own docs: do not omit this for retrieval workloads.
        input_type: kind,
        output_dimension: EMBEDDING_DIMENSIONS,
      }
    : { model, input, dimensions: EMBEDDING_DIMENSIONS };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw friendly(provider, res.status, await res.text().catch(() => ""));
  }

  // Both providers return the same envelope: { data: [{embedding, index}] }.
  // Voyage reports usage.total_tokens; OpenAI reports usage.prompt_tokens.
  const parsed = await res.json() as {
    data?: Array<{ index: number; embedding: number[] }>;
    usage?: { total_tokens?: number; prompt_tokens?: number };
  };
  const data = parsed.data ?? [];
  if (data.length !== passages.length) {
    throw new AiCallError(
      `Embedding response had ${data.length} vectors for ${passages.length} passages.`, 502,
    );
  }

  const vectors: number[][] = new Array(passages.length);
  for (const row of data) {
    if (row.index < 0 || row.index >= passages.length || !Array.isArray(row.embedding)) {
      throw new AiCallError("Embedding response was malformed.", 502);
    }
    if (row.embedding.length !== EMBEDDING_DIMENSIONS) {
      // A model that can't emit 1024 would silently fail the column's width
      // check later, or worse, be stored and never match anything.
      throw new AiCallError(
        `${model} returned ${row.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. `
        + "Pick a model that supports 1024.",
        502,
      );
    }
    vectors[row.index] = row.embedding;
  }
  if (vectors.some((v) => !v)) throw new AiCallError("Embedding response skipped a passage.", 502);

  return {
    vectors,
    usage: {
      inputTokens: parsed.usage?.total_tokens ?? parsed.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
    },
  };
}

/** Embed one query. Must use the SAME provider and model as the corpus — a
 *  query embedded elsewhere finds neighbours in a space the documents don't
 *  live in, and returns confident nonsense rather than nothing. */
export async function embedQuery(
  provider: EmbeddingProviderId, model: string, apiKey: string, query: string, signal?: AbortSignal,
): Promise<number[]> {
  const { vectors } = await embedPassages({
    provider, model, apiKey, passages: [query], kind: "query", signal,
  });
  return vectors[0];
}

/** pgvector's literal form. The driver has no vector type, so this is the
 *  wire format for both storage and the search RPC. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/** The member's embedding setup, or null when they haven't enabled it. */
export interface EmbeddingConnection {
  provider: EmbeddingProviderId;
  model: string;
  apiKey: string;
}

/**
 * Read the embedding key, falling back to the chat key when it happens to be
 * usable.
 *
 * The fallback exists so an OpenAI chat user isn't asked to paste the same
 * key twice. It is deliberately one-directional: an Anthropic chat key is
 * never treated as an embedding key, because there is nothing to call.
 */
export function embeddingConnectionFrom(row: {
  provider?: string | null;
  api_key?: string | null;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_api_key?: string | null;
} | null): EmbeddingConnection | null {
  if (!row) return null;
  if (row.embedding_api_key && row.embedding_provider) {
    const provider = row.embedding_provider as EmbeddingProviderId;
    return {
      provider,
      model: row.embedding_model || defaultEmbeddingModel(provider),
      apiKey: row.embedding_api_key,
    };
  }
  if (row.provider === "openai" && row.api_key) {
    return { provider: "openai", model: defaultEmbeddingModel("openai"), apiKey: row.api_key };
  }
  return null;
}

// ── One vector space per corpus (SEM-1 / SEM-3 / SEM-6) ──────────────────────
//
// A vector only means something next to vectors from the SAME model. The
// corpus records the model on every row (knowledge_chunks.embedding_model);
// the provider follows from the model. These helpers are the one reading of
// that stamp, shared by the build (never add a second model to a corpus) and
// the ask route (embed the query with the corpus's model, on the corpus's
// provider — or report why meaning search cannot run).

/** Passages the provider refused this many times are skipped by the queue
 *  (embed_claim_batch's p_max_attempts) and reported as failed. */
export const EMBED_MAX_ATTEMPTS = 3;

/** The provider that produced a vector, read off its model stamp. */
export function embeddingProviderForModel(model: string | null | undefined): EmbeddingProviderId | null {
  const m = (model ?? "").trim().toLowerCase();
  if (m.startsWith("voyage-")) return "voyage";
  if (m.startsWith("text-embedding-")) return "openai";
  return null;
}

export type CorpusModelVerdict =
  | { state: "empty" }
  | { state: "single"; model: string; provider: EmbeddingProviderId | null; vectors: number }
  | { state: "mixed"; models: Array<{ model: string; vectors: number }> };

/** Resolve a corpus's model from its per-model vector counts
 *  (semantic_coverage_detail.models). Deterministic: never "whichever row
 *  came back first". A mixed corpus is reported as mixed — search refuses it
 *  (20261121) until it is rebuilt under one model. */
export function resolveCorpusModel(models: Record<string, number> | null | undefined): CorpusModelVerdict {
  const entries = Object.entries(models ?? {})
    .map(([model, n]) => ({ model, vectors: Number(n) || 0 }))
    .filter((e) => e.vectors > 0)
    .sort((a, b) => b.vectors - a.vectors || a.model.localeCompare(b.model));
  if (entries.length === 0) return { state: "empty" };
  if (entries.length > 1) return { state: "mixed", models: entries };
  return { state: "single", model: entries[0].model, provider: embeddingProviderForModel(entries[0].model), vectors: entries[0].vectors };
}

export type QueryEmbedPlan =
  | { ok: true; provider: EmbeddingProviderId; model: string }
  | { ok: false; reason: "no_vectors" | "mixed" | "no_key" | "provider_mismatch" | "unknown_model"; detail: string };

/** How a question must be embedded to search this corpus — the corpus's own
 *  model on the corpus's own provider — or, when it cannot be, a reason a
 *  caller can report instead of an empty result. Resolve it PER LIBRARY:
 *  linked libraries are built independently and may carry other models. */
export function planQueryEmbedding(corpus: CorpusModelVerdict, connection: EmbeddingConnection | null): QueryEmbedPlan {
  if (corpus.state === "empty") return { ok: false, reason: "no_vectors", detail: "No passage carries a meaning vector yet." };
  if (corpus.state === "mixed") {
    return {
      ok: false, reason: "mixed",
      detail: `The meaning index holds vectors from ${corpus.models.length} models (${corpus.models.map((m) => m.model).join(", ")}) — rebuild it under one.`,
    };
  }
  if (!corpus.provider) {
    return { ok: false, reason: "unknown_model", detail: `The meaning index was built with ${corpus.model}, which no supported provider serves.` };
  }
  if (!connection) return { ok: false, reason: "no_key", detail: NO_EMBEDDING_KEY_MESSAGE };
  if (connection.provider !== corpus.provider) {
    return {
      ok: false, reason: "provider_mismatch",
      detail: `The meaning index was built with ${corpus.model} (${providerLabel(corpus.provider)}); your embeddings key is ${providerLabel(connection.provider)}, which cannot search it. Add a ${providerLabel(corpus.provider)} key, or rebuild the index with yours.`,
    };
  }
  return { ok: true, provider: corpus.provider, model: corpus.model };
}

/** Would building with this connection put a second model into the corpus?
 *  Null when it may build; otherwise the refusal, stated so the reader knows
 *  both ways out (rebuild, or set the model back). */
export function buildModelConflict(
  corpus: CorpusModelVerdict, connection: EmbeddingConnection,
): { stamped: string[]; yours: string; message: string } | null {
  if (corpus.state === "empty") return null;
  if (corpus.state === "single" && corpus.model === connection.model) return null;
  const stamped = corpus.state === "single" ? [corpus.model] : corpus.models.map((m) => m.model);
  const message = corpus.state === "mixed"
    ? `This library's meaning index already mixes ${stamped.join(" and ")} — meaning search is off for it until it is rebuilt. Use Rebuild index to re-embed every passage with ${connection.model}.`
    : `This library's meaning index was built with ${stamped[0]}; your embeddings setting is ${connection.model}. Adding ${connection.model} vectors would mix two vector spaces that cannot be compared, so the build stops here. Use Rebuild index to switch the whole library to ${connection.model}, or set your embedding model back to ${stamped[0]} in AI settings.`;
  return { stamped, yours: connection.model, message };
}

function providerLabel(p: EmbeddingProviderId): string {
  return EMBEDDING_PROVIDERS.find((x) => x.id === p)?.label ?? p;
}

// ── The price of a build (SEM-13) ────────────────────────────────────────────
//
// Quoted from the SAME function the ledger bills with (estimateCostUsd, the
// per-model table in lib/ai/pricing), over the library's real character
// volume — never a flat constant. Tokens are estimated at 4 characters each
// plus the contextual heading every passage is sent with; the ledger then
// records the provider's own count.

export const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Document name + section + page, prepended to every passage (knowledgeEmbedCore). */
export const HEADING_TOKENS_PER_PASSAGE = 16;

export function estimateEmbeddingTokens(chars: number, passages: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE) + Math.max(0, passages) * HEADING_TOKENS_PER_PASSAGE;
}

export function estimateEmbeddingCostUsd(model: string, chars: number, passages: number): number {
  return estimateCostUsd(model, { inputTokens: estimateEmbeddingTokens(chars, passages), outputTokens: 0 });
}

/** Voyage's in-app rate is a declared conservative placeholder
 *  (lib/ai/pricing) — its figures are labelled estimates until corrected. */
export function embeddingRateIsPlaceholder(model: string): boolean {
  return embeddingProviderForModel(model) === "voyage";
}

export const NO_EMBEDDING_KEY_MESSAGE =
  "Meaning-based search needs an embeddings key, which is separate from your chat key. "
  + "Anthropic doesn't make an embeddings model, so a Claude key can't build this index — "
  + "add a Voyage AI key (Anthropic's recommended embeddings provider) in AI settings and "
  + "keep using Claude for answers. Keyword search works either way.";
