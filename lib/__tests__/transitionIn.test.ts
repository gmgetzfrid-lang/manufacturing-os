import { describe, it, expect } from "vitest";
import { extractCandidateTags } from "@/lib/transitionIn";

describe("extractCandidateTags", () => {
  it("finds equipment tags across number and title fields", () => {
    expect(extractCandidateTags("D-25-1042", "P&ID DHT Feed — FE-201 to P-101A"))
      .toEqual(expect.arrayContaining(["FE-201", "P-101A"]));
  });

  it("does not emit phantom tags from multi-segment drawing numbers", () => {
    expect(extractCandidateTags("D-25-1042", null)).toEqual([]);
  });

  it("uppercases lowercase input before matching", () => {
    expect(extractCandidateTags(null, "tie-in at fe-201 and psv-1002")).toEqual(
      expect.arrayContaining(["FE-201", "PSV-1002"]),
    );
  });

  it("dedupes a tag that appears in both fields", () => {
    const tags = extractCandidateTags("FE-201", "Orifice run for FE-201");
    expect(tags.filter((t) => t === "FE-201")).toHaveLength(1);
  });

  it("ignores plain words, bare numbers, and null/undefined fields", () => {
    expect(extractCandidateTags("General Arrangement", "Sheet 2 of 3")).toEqual([]);
    expect(extractCandidateTags(null, undefined)).toEqual([]);
  });
});
