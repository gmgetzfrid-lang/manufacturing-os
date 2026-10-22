import { describe, it, expect } from "vitest";
import { pressureClassOf, pressureClassNote } from "@/lib/pressureClass";

describe("pressureClassOf", () => {
  it("reads every way a class is written", () => {
    for (const q of [
      "What piping spec should i use for 150 class sour gas stream",
      "Class 150 flange", "150# flange", "#150 flange", "150 lb flange", "150 pound class",
      "CL150 gaskets", "ANSI 150 valve", "rated 150 class",
    ]) expect(pressureClassOf(q), q).toBe("150");
  });
  it("never mistakes 150 for 1500, or the other way round", () => {
    expect(pressureClassOf("Class 1500 spec FAAA1G")).toBe("1500");
    expect(pressureClassOf("1500# valve")).toBe("1500");
    expect(pressureClassOf("what is a 150 mm pipe")).toBeNull();
    expect(pressureClassOf("EP 1-5-0 piping")).toBeNull();
  });
  it("tells the answer a different class does not answer it", () => {
    expect(pressureClassNote("150")).toContain("Class 1500");
    expect(pressureClassNote(null)).toBe("");
  });
});

import { vi } from "vitest";
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/r2", () => ({ r2: {}, R2_BUCKET: "x" }));

describe("rankByRatingAndService", () => {
  it("keeps only the asked class (150, not 1500) and puts sour service first", async () => {
    const { rankByRatingAndService } = await import("@/lib/knowledgeCatalogServer");
    const row = (code: string, rating: string, service: string) => ({ tag: code, raw: JSON.stringify({ code, rating, service, rows: [] }) });
    const out = rankByRatingAndService([
      row("FAAA1G", "1500#", "Hydrocarbon, sour"),
      row("A1A", "150#", "Utility water"),
      row("A1S", "Class 150", "Sour hydrocarbon gas, wet H2S, NACE MR0103"),
    ], "150", "What piping spec should i use for 150 class sour gas stream");
    expect(out.map((r) => r.tag)).toEqual(["A1S", "A1A"]);
    expect(out[0].matched.literal).toContain("sour");
  });
  it("a class found only through a related term is kept, after, and marked as a lead", async () => {
    const { rankByRatingAndService } = await import("@/lib/knowledgeCatalogServer");
    const row = (code: string, rating: string, service: string) => ({ tag: code, raw: JSON.stringify({ code, rating, service, rows: [] }) });
    const out = rankByRatingAndService([
      row("WET1", "150#", "Wet H2S per EP 10-2-1 (200 BHN max)"),
      row("SOUR1", "150#", "Sour gas"),
      row("CW1", "150#", "Cooling water"),
    ], "150", "150 class sour gas");
    expect(out.map((r) => r.tag)).toEqual(["SOUR1", "WET1", "CW1"]);
    expect(out[1].matched).toEqual({ literal: [], leads: ["h2s", "wet h2s"] });
    expect(out[2].matched).toEqual({ literal: [], leads: [] });
  });
  it("whole words only: 'gas' does not match 'gasket'", async () => {
    const { rankByRatingAndService } = await import("@/lib/knowledgeCatalogServer");
    const out = rankByRatingAndService([{ tag: "G", raw: JSON.stringify({ code: "G", rating: "150", service: "Gasket test", rows: [] }) }], "150", "150 gas");
    expect(out[0].matched.literal).toEqual([]);
  });
});

describe("pipeClassFacts says why each class was found", () => {
  it("labels a related-term match as a lead", async () => {
    const { pipeClassFacts } = await import("@/lib/knowledgeCatalog");
    const text = pipeClassFacts([{ code: "WET1", rating: "150", service: "Wet H2S", rows: [], documentName: "Spec", page: 3, matched: { literal: [], leads: ["wet h2s"] } }]);
    expect(text).toMatch(/RELATED term \(wet h2s\) — a lead only/);
  });
});
