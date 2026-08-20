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

  it("returns nothing for junk instead of guessing", () => {
    expect(searchAtlas("zzqx")).toHaveLength(0);
  });

  it("renders a prompt block naming every destination", () => {
    const block = atlasForPrompt();
    expect(block).toContain("APP MAP");
    for (const e of FEATURE_ATLAS) expect(block).toContain(e.href);
  });
});
