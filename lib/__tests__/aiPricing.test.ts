// Tests for the AI spend estimation behind the monthly caps — the price
// table math has to be right because it locks people out of a paid feature.

import { describe, it, expect } from "vitest";
import {
  modelPricePerMTok, estimateCostUsd, addUsage, ZERO_USAGE,
  ALLOWED_PROVIDERS, ALLOWED_EMBEDDING_PROVIDERS, buildAgreementText, AGREEMENT_VERSION,
  worstCaseCostUsd, UPPER_CHARS_PER_TOKEN, UPPER_TOKENS_PER_IMAGE,
} from "../ai/pricing";
import { EMBEDDING_PROVIDERS } from "../ai/embeddings";

describe("modelPricePerMTok", () => {
  it("prices known model families", () => {
    expect(modelPricePerMTok("claude-opus-5")).toEqual([5, 25]);
    expect(modelPricePerMTok("claude-sonnet-5")).toEqual([3, 15]);
    expect(modelPricePerMTok("claude-haiku-4-5")).toEqual([1, 5]);
    expect(modelPricePerMTok("gemini-2.5-flash")).toEqual([0.3, 2.5]);
  });

  it("longest prefix wins: gpt-4o-mini is not priced as gpt-4o", () => {
    expect(modelPricePerMTok("gpt-4o-mini")).toEqual([0.15, 0.6]);
    expect(modelPricePerMTok("gpt-4o")).toEqual([2.5, 10]);
  });

  it("dated snapshots price like their family", () => {
    expect(modelPricePerMTok("gpt-4o-2024-11-20")).toEqual([2.5, 10]);
    expect(modelPricePerMTok("claude-sonnet-5-20260203")).toEqual([3, 15]);
  });

  it("unknown models fall back to frontier pricing (never undercharges the cap)", () => {
    expect(modelPricePerMTok("some-new-model")).toEqual([5, 25]);
    expect(modelPricePerMTok("")).toEqual([5, 25]);
  });
});

describe("estimateCostUsd", () => {
  it("computes input + output cost at the model's rates", () => {
    // 100k in @ $3/M + 10k out @ $15/M = 0.30 + 0.15 = $0.45
    expect(estimateCostUsd("claude-sonnet-5", { inputTokens: 100_000, outputTokens: 10_000 }))
      .toBeCloseTo(0.45, 6);
  });

  it("keeps micro-dollar precision so tiny calls accumulate", () => {
    const c = estimateCostUsd("gpt-4o-mini", { inputTokens: 1000, outputTokens: 200 });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeCloseTo(0.00027, 6);
  });

  it("clamps negative token counts to zero", () => {
    expect(estimateCostUsd("claude-opus-5", { inputTokens: -50, outputTokens: -50 })).toBe(0);
  });

  it("zero usage costs zero", () => {
    expect(estimateCostUsd("claude-opus-5", ZERO_USAGE)).toBe(0);
  });
});

describe("addUsage", () => {
  it("sums both directions without mutating inputs", () => {
    const a = { inputTokens: 100, outputTokens: 20 };
    const b = { inputTokens: 5, outputTokens: 7 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 105, outputTokens: 27 });
    expect(a).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});

describe("ALLOWED_PROVIDERS / ALLOWED_EMBEDDING_PROVIDERS — the two-list model (GOV-6)", () => {
  it("a CHAT key: exactly the no-training pair Anthropic + OpenAI", () => {
    expect([...ALLOWED_PROVIDERS].sort()).toEqual(["anthropic", "openai"]);
  });
  it("an EMBEDDINGS key: exactly Voyage AI + OpenAI — nothing else, and no chat-only provider", () => {
    expect([...ALLOWED_EMBEDDING_PROVIDERS].sort()).toEqual(["openai", "voyage"]);
    expect(ALLOWED_EMBEDDING_PROVIDERS).not.toContain("anthropic");
  });
  it("every provider the embeddings picker offers is on the embeddings allowlist", () => {
    for (const p of EMBEDDING_PROVIDERS) expect(ALLOWED_EMBEDDING_PROVIDERS, p.id).toContain(p.id);
  });
});

describe("GOV-6 — Voyage at its published rates; the agreement names every vendor; re-sign required", () => {
  it("prices the three offered Voyage models at the published list (longest prefix wins)", () => {
    expect(modelPricePerMTok("voyage-3.5-lite")).toEqual([0.02, 0]);
    expect(modelPricePerMTok("voyage-3.5")).toEqual([0.06, 0]);
    expect(modelPricePerMTok("voyage-3-large")).toEqual([0.18, 0]);
    // any other Voyage model keeps the conservative family row, above every published rate
    expect(modelPricePerMTok("voyage-law-2")).toEqual([0.2, 0]);
    // a million embedded tokens on the default model costs two cents
    expect(estimateCostUsd("voyage-3.5-lite", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0.02);
  });
  it("the version moved off 2026-07-v2, so every earlier acceptance is re-signed against the corrected text", () => {
    expect(AGREEMENT_VERSION).not.toBe("2026-07-v2");
    expect(AGREEMENT_VERSION).toBe("2026-10-v3");
  });
  it("every agreement text — whatever the member's keys — names Anthropic, OpenAI and Voyage AI and what each receives", () => {
    for (const [chat, emb] of [[undefined, undefined], ["anthropic", undefined], ["openai", "openai"], ["anthropic", "voyage"]] as const) {
      const text = buildAgreementText(chat, emb);
      expect(text).toMatch(/Anthropic or OpenAI/);
      expect(text).toMatch(/Voyage AI/);
      expect(text).toMatch(/text of every page in the libraries you index is also sent to your embeddings provider/);
    }
  });
  it("a Claude member with a Voyage key gets both providers' paragraphs; a shared OpenAI key gets one", () => {
    const both = buildAgreementText("anthropic", "voyage");
    expect(both).toMatch(/This workspace runs on Claude/);
    expect(both).toMatch(/Your meaning index is built by Voyage AI/);
    const openai = buildAgreementText("openai", "openai");
    expect(openai.match(/This workspace runs on OpenAI/g)).toHaveLength(1);
    // a caller that hands the embeddings provider first still gets its paragraph
    expect(buildAgreementText("voyage")).toMatch(/Your meaning index is built by Voyage AI/);
  });
});

describe("worstCaseCostUsd (GOV-13) — what a pending call could cost", () => {
  // The arithmetic, not the price table: a neutral model name is unlisted,
  // so it prices at the frontier fallback ($5 in / $25 out per million).
  const NEUTRAL = "chat-model";
  it("the neutral fixture prices at the frontier fallback", () => {
    expect(modelPricePerMTok(NEUTRAL)).toEqual([5, 25]);
  });
  it("text at 3 chars a token, every image at 1,600 tokens, output at the full maxTokens", () => {
    expect(UPPER_CHARS_PER_TOKEN).toBe(3);
    expect(UPPER_TOKENS_PER_IMAGE).toBe(1600);
    // 30,000 chars → 10,000 tokens @ $5/M = $0.05; 4,000 out @ $25/M = $0.10
    expect(worstCaseCostUsd(NEUTRAL, { inputChars: 30_000, maxTokens: 4000 })).toBeCloseTo(0.15, 6);
    // + 5 images = 8,000 tokens more @ $5/M = $0.04
    expect(worstCaseCostUsd(NEUTRAL, { inputChars: 30_000, images: 5, maxTokens: 4000 })).toBeCloseTo(0.19, 6);
  });
  it("is never below what the same call is estimated at once its counts come back (text is over-estimated)", () => {
    const chars = 40_000;
    const realisticInput = Math.round(chars / 4);
    expect(worstCaseCostUsd(NEUTRAL, { inputChars: chars, maxTokens: 2000 }))
      .toBeGreaterThanOrEqual(estimateCostUsd(NEUTRAL, { inputTokens: realisticInput, outputTokens: 2000 }));
  });
  it("an embeddings call has no output side", () => {
    // 3,000,000 chars → 1,000,000 tokens @ $5/M = $5.00; maxTokens 0 adds nothing
    expect(worstCaseCostUsd("embed-model", { inputChars: 3_000_000, maxTokens: 0 })).toBeCloseTo(5, 6);
    expect(worstCaseCostUsd("embed-model", { inputChars: 3_000_000, maxTokens: 0 }))
      .toBe(estimateCostUsd("embed-model", { inputTokens: 1_000_000, outputTokens: 0 }));
  });
});

describe("buildAgreementText", () => {
  it("always carries the general don't-be-careless rules", () => {
    for (const p of [undefined, "anthropic", "openai", "gemini"]) {
      const text = buildAgreementText(p);
      expect(text).toMatch(/passwords/i);
      expect(text).toMatch(/credit card|financial/i);
      expect(text).toMatch(/NEVER enter/);
    }
  });

  it("adds the provider paragraph for Claude and OpenAI", () => {
    expect(buildAgreementText("anthropic")).toContain("Claude");
    expect(buildAgreementText("anthropic")).toMatch(/not a reason to get careless/);
    expect(buildAgreementText("openai")).toContain("OpenAI");
  });

  it("adds no provider paragraph for an unknown/no provider (the core still names the vendors)", () => {
    expect(buildAgreementText(undefined)).not.toMatch(/This workspace runs on/);
    expect(buildAgreementText("gemini")).not.toMatch(/This workspace runs on/);
    expect(buildAgreementText("gemini")).not.toMatch(/gemini/i);
  });
});
