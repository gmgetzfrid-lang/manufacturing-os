import { describe, it, expect } from "vitest";
import { AiCallError, isTimeoutError } from "@/lib/ai/providerCall";

// Indexing commits nothing until its page loop ends, so "did we run out of
// time?" decides whether a batch resumes cleanly or a slow page silently
// downgrades to text-only. That question has to be answered correctly
// regardless of which runtime raised it.
describe("isTimeoutError", () => {
  it("recognises AbortSignal.timeout's DOMException", () => {
    const e = new Error("The operation was aborted");
    e.name = "TimeoutError";
    expect(isTimeoutError(e)).toBe(true);
  });

  it("recognises a manual abort", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isTimeoutError(e)).toBe(true);
  });

  it("recognises a 408 from the provider layer", () => {
    expect(isTimeoutError(new AiCallError("timed out", 408))).toBe(true);
  });

  it("does not mistake real provider failures for timeouts", () => {
    expect(isTimeoutError(new AiCallError("key rejected", 401))).toBe(false);
    expect(isTimeoutError(new AiCallError("rate limited", 429))).toBe(false);
    expect(isTimeoutError(new Error("socket hang up"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});
