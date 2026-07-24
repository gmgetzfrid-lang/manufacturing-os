// lib/__tests__/reviewControl.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveEffectiveReviewControl,
  effectiveModeForRevUp,
  letterLabelFor,
  reviewStatusFor,
  type ReviewSummary,
} from "@/lib/reviewControl";
import type { ReviewControl } from "@/types/schema";

const C = (p: Partial<ReviewControl> = {}): ReviewControl => ({ mode: "require", ...p });

describe("resolveEffectiveReviewControl", () => {
  it("defaults to mode 'none' when nothing is set", () => {
    expect(resolveEffectiveReviewControl(null, null, null)).toEqual({ mode: "none" });
  });
  it("takes the most specific DEFINED level (document > folder > library)", () => {
    const doc = C({ mode: "publisher_choice" });
    const folder = C({ mode: "require" });
    const lib = C({ mode: "none" });
    expect(resolveEffectiveReviewControl(doc, folder, lib)).toBe(doc);
    expect(resolveEffectiveReviewControl(null, folder, lib)).toBe(folder);
    expect(resolveEffectiveReviewControl(null, null, lib)).toBe(lib);
  });
  it("lets a document-level 'none' override an inherited 'require'", () => {
    expect(resolveEffectiveReviewControl(C({ mode: "none" }), C({ mode: "require" }), null).mode).toBe("none");
  });
});

describe("effectiveModeForRevUp — escape hatches", () => {
  it("passes the mode through for a Major direct push", () => {
    expect(effectiveModeForRevUp({ control: C({ mode: "require" }), changeType: "Major" })).toBe("require");
  });
  it("skips the gate for a Minor change", () => {
    expect(effectiveModeForRevUp({ control: C({ mode: "require" }), changeType: "Minor" })).toBe("none");
  });
  it("skips the gate for a Correction", () => {
    expect(effectiveModeForRevUp({ control: C({ mode: "require" }), changeType: "Correction" })).toBe("none");
  });
  it("skips the gate when the rev came from a drafting ticket", () => {
    expect(effectiveModeForRevUp({ control: C({ mode: "require" }), changeType: "Major", relatedTicketId: "t1" })).toBe("none");
  });
  it("stays 'none' when the library isn't gated", () => {
    expect(effectiveModeForRevUp({ control: { mode: "none" }, changeType: "Major" })).toBe("none");
  });
});

describe("letterLabelFor", () => {
  it("starts a numeric base at letter A", () => {
    expect(letterLabelFor("2")).toBe("2A");
    expect(letterLabelFor("10")).toBe("10A");
  });
  it("bumps an existing draft letter", () => {
    expect(letterLabelFor("2", "2A")).toBe("2B");
    expect(letterLabelFor("2", "2B")).toBe("2C");
  });
  it("appends A when the existing label has no trailing letter", () => {
    expect(letterLabelFor("R3", "R3")).toBe("R3A");
  });
});

describe("reviewStatusFor", () => {
  const S = (p: Partial<ReviewSummary> = {}): ReviewSummary => ({ inReview: true, requiredPrimaries: 2, signed: 0, ready: false, revisionLabel: "2A", ...p });
  it("is 'none' when not in review", () => {
    expect(reviewStatusFor(null)).toBe("none");
    expect(reviewStatusFor(S({ inReview: false }))).toBe("none");
  });
  it("is 'in_review' while sign-offs are outstanding", () => {
    expect(reviewStatusFor(S({ signed: 1, ready: false }))).toBe("in_review");
  });
  it("is 'ready' once every required sign-off is in", () => {
    expect(reviewStatusFor(S({ signed: 2, ready: true }))).toBe("ready");
  });
});
