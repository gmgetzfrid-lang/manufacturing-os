// lib/__tests__/aiMockProvider.test.ts
//
// Tests for the local heuristic AI provider. This is the fallback
// every build ships with; it MUST behave deterministically and stay
// inside the four non-mutating methods of the AiProvider contract.

import { describe, it, expect } from "vitest";
import { mockProvider } from "@/lib/ai/mockProvider";
import { getAiProvider } from "@/lib/ai";

describe("mockProvider identity", () => {
  it("self-identifies as not-real", () => {
    expect(mockProvider.isReal).toBe(false);
    expect(mockProvider.name).toMatch(/mock|local/i);
  });
});

describe("mockProvider.summarize", () => {
  it("returns a placeholder for empty input", async () => {
    expect(await mockProvider.summarize("")).toMatch(/nothing/i);
    expect(await mockProvider.summarize("   ")).toMatch(/nothing/i);
  });

  it("returns the first sentence(s) bounded by ~220 chars", async () => {
    const long = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const out = await mockProvider.summarize(long);
    // Should include the first two sentences but not the third.
    expect(out).toContain("First sentence.");
    expect(out).toContain("Second sentence.");
    expect(out).not.toContain("Third sentence");
  });

  it("truncates very long single sentences", async () => {
    const single = "a".repeat(500) + ".";
    const out = await mockProvider.summarize(single);
    expect(out.length).toBeLessThanOrEqual(220);
  });
});

describe("mockProvider.extractEntities", () => {
  it("extracts equipment tags", async () => {
    const out = await mockProvider.extractEntities("Heat exchanger E-204 and pump P-101 need vendor data.");
    const tags = out.filter((e) => e.kind === "equipment").map((e) => e.text);
    expect(tags).toContain("E-204");
    expect(tags).toContain("P-101");
  });

  it("extracts MOC references", async () => {
    const out = await mockProvider.extractEntities("Per MOC-2024-051 we need to update the P&ID.");
    expect(out.some((e) => e.kind === "moc" && e.text.startsWith("MOC"))).toBe(true);
  });

  it("extracts @-mentions", async () => {
    const out = await mockProvider.extractEntities("Reached out to @joe.smith yesterday.");
    expect(out.some((e) => e.kind === "person" && e.text === "@joe.smith")).toBe(true);
  });

  it("extracts ISO-ish dates", async () => {
    const out = await mockProvider.extractEntities("Targeting 2026-07-15 for the next review.");
    expect(out.some((e) => e.kind === "date" && e.text === "2026-07-15")).toBe(true);
  });

  it("dedupes by (kind, value)", async () => {
    const out = await mockProvider.extractEntities("E-204 needs check. Also E-204 might leak.");
    const e204 = out.filter((e) => e.kind === "equipment" && e.text === "E-204");
    expect(e204).toHaveLength(1);
  });

  it("returns empty array for unmatched input", async () => {
    const out = await mockProvider.extractEntities("just a generic note");
    expect(out).toEqual([]);
  });
});

describe("mockProvider.suggestFollowups", () => {
  it("surfaces open checkbox tasks", async () => {
    const text = "- [ ] confirm flow rate\n- [x] done thing\n- [ ] update sheet 3";
    const out = await mockProvider.suggestFollowups(text);
    expect(out.some((line) => line.includes("confirm flow rate"))).toBe(true);
    expect(out.some((line) => line.includes("update sheet 3"))).toBe(true);
    expect(out.some((line) => line.includes("done thing"))).toBe(false);
  });

  it("falls back to soft-cue verb extraction when no checkboxes", async () => {
    const text = "We need to confirm the flow rate with the vendor. Should ask Joe today.";
    const out = await mockProvider.suggestFollowups(text);
    expect(out.length).toBeGreaterThan(0);
  });

  it("caps results at 5", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const out = await mockProvider.suggestFollowups(tasks);
    expect(out.length).toBeLessThanOrEqual(5);
  });
});

describe("mockProvider.generateHandoff", () => {
  it("returns a markdown template for empty context", async () => {
    const out = await mockProvider.generateHandoff("");
    expect(out).toContain("Handoff");
    expect(out).toContain("Open items");
    expect(out).toContain("Next shift");
  });

  it("includes a quoted excerpt of the context", async () => {
    const out = await mockProvider.generateHandoff("Today we did X.\nTomorrow we do Y.");
    expect(out).toContain("> Today we did X.");
  });
});

describe("getAiProvider", () => {
  it("returns a real-ish provider object with the four required methods", () => {
    const p = getAiProvider();
    expect(typeof p.summarize).toBe("function");
    expect(typeof p.extractEntities).toBe("function");
    expect(typeof p.suggestFollowups).toBe("function");
    expect(typeof p.generateHandoff).toBe("function");
  });

  it("defaults to the mock provider when no env var is set", () => {
    const p = getAiProvider();
    expect(p.isReal).toBe(false);
  });
});
