// Which model each AI job runs on: the person's choice, the job's own
// default, or the main model — and never a model from another provider.

import { describe, it, expect } from "vitest";
import { modelForJob, jobOfOp, cleanJobModels, modelName, fmtCost, costPerUse } from "@/lib/ai/jobModels";

const conn = { provider: "anthropic" as const, model: "claude-opus-5-5" };

describe("modelForJob", () => {
  it("a choice wins; 'main' is the main model", () => {
    expect(modelForJob({ ...conn, jobModels: { drafting: "claude-haiku-5-5" } }, "drafting")).toBe("claude-haiku-5-5");
    expect(modelForJob({ ...conn, jobModels: { reading: "main" } }, "reading")).toBe("claude-opus-5-5");
  });
  it("no choice: the job's default, else the main model", () => {
    expect(modelForJob(conn, "reading")).toBe("claude-haiku-4-5");
    expect(modelForJob(conn, "knowledge")).toBe("claude-opus-5-5");
    expect(modelForJob(conn, null)).toBe("claude-opus-5-5");
  });
  it("a choice for another provider is ignored", () => {
    expect(modelForJob({ ...conn, jobModels: { knowledge: "gpt-4o" } }, "knowledge")).toBe("claude-opus-5-5");
    expect(modelForJob({ provider: "openai", model: "gpt-5.1", jobModels: { drafting: "claude-sonnet-5-5" } }, "drafting")).toBe("gpt-5.1");
  });
});

describe("helpers", () => {
  it("ops belong to their jobs", () => {
    expect(jobOfOp("knowledgeAsk")).toBe("knowledge");
    expect(jobOfOp("invoiceParse")).toBe("projectDocs");
    expect(jobOfOp("graphShape")).toBeNull();
  });
  it("keeps only known jobs and sane ids", () => {
    expect(cleanJobModels({ knowledge: " claude-opus-5-5 ", bogus: "x", reading: "<script>" })).toEqual({ knowledge: "claude-opus-5-5" });
    expect(cleanJobModels(null)).toEqual({});
  });
  it("names and costs", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelName("claude-opus-5")).toBe("Opus 5");
    expect(modelName("gpt-4o")).toBe("gpt-4o");
    // 127k in @ $4 + 3.7k out @ $20 = 0.508 + 0.074
    expect(fmtCost(costPerUse("claude-opus-5-5", { inputTokens: 127_000, outputTokens: 3_700 }))).toBe("58¢");
    expect(fmtCost(costPerUse("claude-sonnet-5-5", { inputTokens: 6_000, outputTokens: 800 }))).toBe("2¢");
    expect(fmtCost(0.0004)).toBe("<0.1¢");
    expect(fmtCost(1.2)).toBe("$1.20");
  });
});
