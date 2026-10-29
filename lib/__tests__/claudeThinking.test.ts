// The "answer only" request shape per Claude model: each model accepts a
// different way of keeping hidden reasoning out of the answer budget, and
// the wrong one is a 400 on every call.

import { describe, it, expect } from "vitest";
import { claudeThinking } from "@/lib/ai/providerCall";

describe("claudeThinking", () => {
  it("Opus 5.5 can't turn thinking off: low effort, room added for it", () => {
    expect(claudeThinking("claude-opus-5-5", 2000)).toEqual({ max_tokens: 10000, output_config: { effort: "low" } });
    expect(claudeThinking("claude-fable-5-1", 1000)).toEqual({ max_tokens: 9000, output_config: { effort: "low" } });
  });
  it("Sonnet 5.5 turns it off with between_tools", () => {
    expect(claudeThinking("claude-sonnet-5-5", 2000)).toEqual({ max_tokens: 2000, thinking: { type: "between_tools" } });
  });
  it("earlier models keep thinking disabled", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-haiku-5-5"]) {
      expect(claudeThinking(m, 500)).toEqual({ max_tokens: 500, thinking: { type: "disabled" } });
    }
  });
});
