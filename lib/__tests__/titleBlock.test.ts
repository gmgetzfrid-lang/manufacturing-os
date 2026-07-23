// Freezes the title-block text heuristics — the pure half of the bulk-
// ingest reader. The PDF extraction itself is environment-bound; the
// guessing logic is not.

import { describe, it, expect } from "vitest";
import { guessFromText } from "@/lib/titleBlockHeuristics";

describe("guessFromText", () => {
  it("finds a labeled drawing number with high confidence", () => {
    const g = guessFromText("ACME REFINING  DRAWING NO. D-1401-S2  SCALE 1:50  REV 4");
    expect(g.docNumber).toBe("D-1401-S2");
    expect(g.rev).toBe("4");
    expect(g.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("reads 'DWG #' style labels", () => {
    const g = guessFromText("DWG # P-101A ISSUED FOR CONSTRUCTION");
    expect(g.docNumber).toBe("P-101A");
  });

  it("labeled revision without a number keyword still yields the rev", () => {
    const g = guessFromText("SOME TITLE TEXT REVISION: B2 OTHER WORDS");
    expect(g.rev).toBe("B2");
  });

  it("falls back to the most-repeated number-shaped token", () => {
    const g = guessFromText("E-204 EXCHANGER LAYOUT  E-204 DETAIL  NOZZLE N1  E-204");
    expect(g.docNumber).toBe("E-204");
    expect(g.confidence).toBeGreaterThan(0);
  });

  it("pure prose produces no drawing number", () => {
    const g = guessFromText("GENERAL NOTES SEE SPECIFICATION FOR DETAILS");
    expect(g.docNumber).toBeUndefined();
    expect(g.confidence).toBe(0);
  });

  it("a one-off unlabeled token stays low-confidence (below the apply gate)", () => {
    const g = guessFromText("REFER TO LINE 6-P-1023 FOR CONTINUATION");
    expect(g.confidence).toBeLessThan(0.4);
  });
});
