// lib/__tests__/revLabelCorrection.test.ts
//
// Pure validation for after-the-fact revision label corrections
// ("uploaded as Rev 0, the stamp actually reads Rev 38"). The invariants:
// non-blank, bounded length, unique within the document's chain
// (case-insensitive), and hands off in-review drafts — the review workflow
// owns their letter labels.

import { describe, it, expect } from "vitest";
import { checkRevLabelCorrection } from "@/lib/revisions";

const base = {
  currentLabel: "0",
  siblingLabels: ["1", "2", "37"],
  reviewState: null as string | null,
};

describe("checkRevLabelCorrection", () => {
  it("accepts a normal correction and trims whitespace", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "  38 " });
    expect(r).toEqual({ ok: true, label: "38" });
  });

  it("rejects a blank label", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/blank/i);
  });

  it("rejects an over-long label", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "X".repeat(25) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });

  it("rejects renaming an in-review draft — the review flow owns those labels", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "38", reviewState: "in_review" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/review/i);
  });

  it("rejects a no-op (same label)", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: " 0 " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already this revision/i);
  });

  it("rejects a label already used elsewhere in the chain", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "37" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already used/i);
  });

  it("duplicate check is case-insensitive and whitespace-tolerant", () => {
    const r = checkRevLabelCorrection({
      ...base,
      siblingLabels: [" 2a "],
      newLabel: "2A",
    });
    expect(r.ok).toBe(false);
  });

  it("approved review state does not block a correction", () => {
    const r = checkRevLabelCorrection({ ...base, newLabel: "38", reviewState: "approved" });
    expect(r).toEqual({ ok: true, label: "38" });
  });

  it("tolerates null-ish sibling labels", () => {
    const r = checkRevLabelCorrection({
      ...base,
      siblingLabels: ["", "1"] as string[],
      newLabel: "38",
    });
    expect(r).toEqual({ ok: true, label: "38" });
  });

  it("letter labels work (shops that use A/B/C revs)", () => {
    const r = checkRevLabelCorrection({
      currentLabel: "C",
      siblingLabels: ["A", "B"],
      reviewState: null,
      newLabel: "D",
    });
    expect(r).toEqual({ ok: true, label: "D" });
  });
});
