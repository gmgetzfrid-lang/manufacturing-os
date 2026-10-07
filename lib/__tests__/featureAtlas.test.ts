import { describe, it, expect } from "vitest";
import { FEATURE_ATLAS, searchAtlas, atlasForPrompt } from "@/lib/featureAtlas";

// The atlas is the cure for "I can't remember where everything is" — so its
// own integrity is worth a tripwire, and the searches people actually type
// must land.

describe("feature atlas — the app's map of itself", () => {
  it("has unique, absolute hrefs and non-empty aliases", () => {
    const hrefs = FEATURE_ATLAS.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const e of FEATURE_ATLAS) {
      expect(e.href.startsWith("/")).toBe(true);
      expect(e.aliases.length).toBeGreaterThan(0);
      for (const a of e.aliases) expect(a).toBe(a.toLowerCase());
    }
  });

  it("finds the Site Codebook by the words people actually use", () => {
    for (const q of ["numbering system", "naming convention", "decoder", "where did my import go"]) {
      const top = searchAtlas(q)[0];
      expect(top?.href, `query "${q}"`).toBe("/admin/codebook");
    }
  });

  it("routes feature questions to their real homes", () => {
    expect(searchAtlas("api key")[0]?.href).toBe("/intelligence/setup");
    expect(searchAtlas("uncategorized")[0]?.href).toBe("/admin/assets");
    expect(searchAtlas("what now")[0]?.href).toBe("/setup");
    expect(searchAtlas("flow map")[0]?.href).toBe("/graph");
  });

  it("regression (I-24 fix pass): ⌘K finds the graph by the same words as before the lens rename", () => {
    // The palette asks for 4 (components/navigation/GlobalCommandPalette.tsx).
    // These are the exact results on the base b0a03b1, before the /graph
    // blurb named the lenses by their new labels: the blurb is part of what
    // is searched, so dropping its words "everything", "documents", "docs"
    // and "equipment" lost the graph from each of these. An atlas entry added
    // later may change a list legitimately — update it deliberately.
    const BEFORE: Record<string, string[]> = {
      "equipment graph": ["/graph"],
      "equipment map": ["/plot-plans", "/graph"],
      "document map": ["/graph"],
      "documents graph": ["/graph"],
      "docs graph": ["/graph"],
      "equipment docs": ["/graph"],
      "everything": ["/admin/data-export", "/activity", "/graph"],
      "documents": ["/documents", "/transmittals", "/admin/assets", "/graph"],
      "docs": ["/output-templates", "/graph"],
      "equipment": ["/documents", "/admin/assets", "/admin/codebook", "/plot-plans"],
      // …and the words that never left (the aliases, the label, Connect).
      "flow map": ["/graph"],
      "process lens": ["/graph"],
      "graph": ["/graph", "/knowledge"],
      "map": ["/plot-plans", "/graph"],
      "whole": ["/assistant", "/graph"],
      "lenses": ["/graph"],
      "process": ["/admin/assets", "/graph"],
      "connect": ["/admin/proposed-links", "/graph", "/intelligence/skills", "/intelligence"],
    };
    for (const [q, hrefs] of Object.entries(BEFORE)) {
      expect(searchAtlas(q, 4).map((e) => e.href), `query "${q}"`).toEqual(hrefs);
    }
    // At the default limit the graph is still the fifth "equipment" result.
    expect(searchAtlas("equipment").map((e) => e.href)).toEqual(
      ["/documents", "/admin/assets", "/admin/codebook", "/plot-plans", "/graph"]);
  });

  it("the graph is also found by its lenses' new labels", () => {
    for (const q of ["whole map", "process layout", "governing paper", "records filing"]) {
      expect(searchAtlas(q, 4).map((e) => e.href), `query "${q}"`).toContain("/graph");
    }
  });

  it("returns nothing for junk instead of guessing", () => {
    expect(searchAtlas("zzqx")).toHaveLength(0);
  });

  it("renders a prompt block naming every destination", () => {
    const block = atlasForPrompt();
    expect(block).toContain("APP MAP");
    for (const e of FEATURE_ATLAS) expect(block).toContain(e.href);
  });
});
