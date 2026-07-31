// Tests for the AI spend estimation behind the monthly caps — the price
// table math has to be right because it locks people out of a paid feature.

import { describe, it, expect } from "vitest";
import {
  modelPricePerMTok, estimateCostUsd, addUsage, ZERO_USAGE,
  PERSONAL_ALLOWED_PROVIDERS,
} from "../ai/pricing";

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

describe("PERSONAL_ALLOWED_PROVIDERS", () => {
  it("is exactly the no-training pair — Gemini stays org-only", () => {
    expect([...PERSONAL_ALLOWED_PROVIDERS].sort()).toEqual(["anthropic", "openai"]);
  });
});
