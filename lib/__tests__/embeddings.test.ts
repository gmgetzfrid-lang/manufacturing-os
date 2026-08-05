// The bug this file exists to prevent shipped once already: semantic search
// was gated on the user's CHAT provider being OpenAI, which locked out every
// Claude user for a reason that was never true. The chat model and the
// embedding model are unrelated services.
//
// The other failure class here is silent: a vector filed against the wrong
// passage, or a query embedded by a different model than the corpus. Neither
// throws at write time. Both make retrieval quietly worthless.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  embedPassages, embedQuery, embeddingConnectionFrom, toVectorLiteral,
  defaultEmbeddingModel, EMBEDDING_DIMENSIONS, EMBED_BATCH,
} from "@/lib/ai/embeddings";

const vec = (n = EMBEDDING_DIMENSIONS) => Array.from({ length: n }, (_, i) => i / n);

function mockFetch(handler: (url: string, init: RequestInit) => unknown, status = 200) {
  return vi.fn(async (url: string, init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => handler(url, init),
    text: async () => JSON.stringify(handler(url, init)),
  })) as unknown as typeof fetch;
}

const body = (init: RequestInit) => JSON.parse(String(init.body));

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("embeddingConnectionFrom — who may embed", () => {
  it("uses the embedding key even when the chat provider is Anthropic", () => {
    // THE regression. A Claude user with a Voyage key must get vectors.
    const conn = embeddingConnectionFrom({
      provider: "anthropic", api_key: "sk-ant-x",
      embedding_provider: "voyage", embedding_model: "voyage-3.5-lite",
      embedding_api_key: "pa-voyage",
    });
    expect(conn).toEqual({ provider: "voyage", model: "voyage-3.5-lite", apiKey: "pa-voyage" });
  });

  it("falls back to an OpenAI chat key so nobody pastes the same secret twice", () => {
    const conn = embeddingConnectionFrom({ provider: "openai", api_key: "sk-openai" });
    expect(conn?.provider).toBe("openai");
    expect(conn?.apiKey).toBe("sk-openai");
  });

  it("never treats an Anthropic chat key as an embedding key", () => {
    // There is no endpoint to call — pretending otherwise produces a 404 the
    // user can't act on.
    expect(embeddingConnectionFrom({ provider: "anthropic", api_key: "sk-ant-x" })).toBeNull();
  });

  it("is null when nothing is configured", () => {
    expect(embeddingConnectionFrom(null)).toBeNull();
    expect(embeddingConnectionFrom({})).toBeNull();
  });

  it("defaults the model when a key is saved without one", () => {
    const conn = embeddingConnectionFrom({
      embedding_provider: "voyage", embedding_api_key: "pa-x", embedding_model: null,
    });
    expect(conn?.model).toBe(defaultEmbeddingModel("voyage"));
  });

  it("ignores a provider with no key behind it", () => {
    expect(embeddingConnectionFrom({ embedding_provider: "voyage", embedding_api_key: null }))
      .toBeNull();
  });
});

describe("embedPassages — provider wire shapes", () => {
  it("asks Voyage for 1024 dims and tells it these are documents", async () => {
    const fetchMock = mockFetch(() => ({
      data: [{ index: 0, embedding: vec() }], usage: { total_tokens: 12 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await embedPassages({
      provider: "voyage", model: "voyage-3.5-lite", apiKey: "pa-x",
      passages: ["a run of pipe"], kind: "document",
    });

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toContain("api.voyageai.com");
    expect(body(init).output_dimension).toBe(EMBEDDING_DIMENSIONS);
    // Voyage's docs are emphatic that omitting this costs retrieval quality.
    expect(body(init).input_type).toBe("document");
    expect(out.usage.inputTokens).toBe(12);
  });

  it("embeds a QUERY with the query instruction, not the document one", async () => {
    const fetchMock = mockFetch(() => ({ data: [{ index: 0, embedding: vec() }] }));
    vi.stubGlobal("fetch", fetchMock);
    await embedQuery("voyage", "voyage-3.5-lite", "pa-x", "anything about pipe supports?");
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(body(init).input_type).toBe("query");
  });

  it("asks OpenAI for the same 1024 dims via its own parameter name", async () => {
    const fetchMock = mockFetch(() => ({
      data: [{ index: 0, embedding: vec() }], usage: { prompt_tokens: 9 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await embedPassages({
      provider: "openai", model: "text-embedding-3-small", apiKey: "sk-x",
      passages: ["x"], kind: "document",
    });

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toContain("api.openai.com");
    expect(body(init).dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body(init).input_type).toBeUndefined();   // not an OpenAI parameter
    expect(out.usage.inputTokens).toBe(9);
  });

  it("returns vectors in INPUT order even when the provider reorders them", async () => {
    // Pairing by arrival order instead of by index files the wrong vector
    // against the wrong passage — silent, permanent, and unfindable later.
    const first = vec(); const second = vec().map((v) => v + 1);
    vi.stubGlobal("fetch", mockFetch(() => ({
      data: [{ index: 1, embedding: second }, { index: 0, embedding: first }],
    })));
    const out = await embedPassages({
      provider: "voyage", model: "m", apiKey: "k", passages: ["a", "b"], kind: "document",
    });
    expect(out.vectors[0][1]).toBeCloseTo(first[1]);
    expect(out.vectors[1][1]).toBeCloseTo(second[1]);
  });
});

describe("embedPassages — refusing bad data rather than storing it", () => {
  it("rejects a response with the wrong number of vectors", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ data: [{ index: 0, embedding: vec() }] })));
    await expect(embedPassages({
      provider: "voyage", model: "m", apiKey: "k", passages: ["a", "b"], kind: "document",
    })).rejects.toThrow(/1 vectors for 2 passages/);
  });

  it("rejects a model that can't emit the column's width", async () => {
    // Storing a 512-dim vector in a 1024-dim world fails later and further
    // away; catching it here names the actual problem.
    vi.stubGlobal("fetch", mockFetch(() => ({ data: [{ index: 0, embedding: vec(512) }] })));
    await expect(embedPassages({
      provider: "voyage", model: "voyage-tiny", apiKey: "k", passages: ["a"], kind: "document",
    })).rejects.toThrow(/512 dimensions, expected 1024/);
  });

  it("names the provider when the key is rejected", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({}), 401));
    await expect(embedPassages({
      provider: "voyage", model: "m", apiKey: "bad", passages: ["a"], kind: "document",
    })).rejects.toThrow(/Voyage AI rejected the embeddings key/);
  });

  it("refuses a batch larger than one request can carry", async () => {
    await expect(embedPassages({
      provider: "voyage", model: "m", apiKey: "k",
      passages: Array.from({ length: EMBED_BATCH + 1 }, () => "x"), kind: "document",
    })).rejects.toThrow(/at most/);
  });

  it("costs nothing and calls nothing for an empty batch", async () => {
    const fetchMock = mockFetch(() => ({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await embedPassages({
      provider: "voyage", model: "m", apiKey: "k", passages: [], kind: "document",
    });
    expect(out.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("substitutes a placeholder rather than sending an empty string", async () => {
    const fetchMock = mockFetch(() => ({ data: [{ index: 0, embedding: vec() }] }));
    vi.stubGlobal("fetch", fetchMock);
    await embedPassages({
      provider: "voyage", model: "m", apiKey: "k", passages: ["   "], kind: "document",
    });
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(body(init).input[0].length).toBeGreaterThan(0);
  });
});

describe("toVectorLiteral", () => {
  it("emits pgvector's bracket form", () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });
});
