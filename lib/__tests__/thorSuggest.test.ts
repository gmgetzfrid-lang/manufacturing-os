import { describe, it, expect } from "vitest";
import { ghostCompletion, exampleSearches, resolveTags, categoryChips, primaryTag, describe as describeEq } from "@/lib/thor/suggest";
import { parseThorQuery } from "@/lib/thor/query";
import type { ThorVocabulary } from "@/lib/thor/client";

// A slice of the real THOR vocabulary (thor_vocabulary) — enough to exercise
// tags that exist in several units, folder categories and descriptions.
const VOCAB: ThorVocabulary = {
  units: [
    { code: "2000", folder: "2000 - CRUDE UNIT", files: 25041 },
    { code: "2500", folder: "2500 - DHT", files: 8222 },
    { code: "3500", folder: "3500 - PLATFORMER", files: 10769 },
  ],
  categories: [
    { name: "EXCHANGERS", files: 31839 },
    { name: "VESSELS", files: 29250 },
    { name: "RELIEF VALVES", files: 7492 },
  ],
  equipment: [
    { number: "2010.03", unit: "2000", tags: ["NDE-02", "V-3"], description: "V-3 PREFRACTIONATOR TOWER", files: 1673 },
    { number: "2535.11", unit: "2500", tags: ["H-11"], description: "H-11 REACTOR FEED HEATER", files: 1337 },
    { number: "2035.02", unit: "2000", tags: ["H-2"], description: "H-2 FRACTIONATOR HEATER - BORN HEATER", files: 1318 },
    { number: "3510.01", unit: "3500", tags: ["V-1"], description: "V-1 CHARGE ACCUMULATOR", files: 400 },
    { number: "2510.01", unit: "2500", tags: ["V-1"], description: "V-1 FEED SURGE DRUM", files: 300 },
  ],
};
const UNITS = VOCAB.units.map((u) => ({ code: u.code, folder: u.folder }));

describe("equipment names", () => {
  it("prefers the tag its description starts with", () => {
    expect(primaryTag(VOCAB.equipment[0])).toBe("V-3");
    expect(describeEq(VOCAB.equipment[0])).toBe("prefractionator tower");
    expect(describeEq(VOCAB.equipment[2])).toBe("fractionator heater");
  });
});

describe("ghostCompletion", () => {
  it("completes units, phrases, categories and equipment from the index", () => {
    expect(ghostCompletion("only pdfs of the vessel v-1 in the cru", VOCAB)).toBe("de unit");
    expect(ghostCompletion("from latest to o", VOCAB)).toBe("ldest");
    expect(ghostCompletion("relief va", VOCAB)).toBe("lves");
    expect(ghostCompletion("show me exch", VOCAB)).toBe("angers");
  });
  it("completes equipment names one word at a time, in the case being typed", () => {
    expect(ghostCompletion("newest pref", VOCAB)).toBe("ractionator");
    expect(ghostCompletion("PREFRACT", VOCAB)).toBe("IONATOR");
  });
  it("says nothing after a space or without a vocabulary", () => {
    expect(ghostCompletion("crude ", VOCAB)).toBe("");
    expect(ghostCompletion("cru", null)).toBe("");
    expect(ghostCompletion("from latest to oldest", VOCAB)).toBe("");
  });
});

describe("exampleSearches", () => {
  it("builds examples from real equipment, in its own unit", () => {
    const ex = exampleSearches(VOCAB);
    expect(ex[0]).toBe("only PDFs of the vessel V-3 in the crude unit from latest to oldest");
    expect(ex).toContain("newest prefrac drawings");
    expect(ex.some((e) => e.startsWith("inspection reports for H-11 in the dht"))).toBe(true);
  });
});

describe("the sentence from the request", () => {
  const q = parseThorQuery("i need only pdfs of the vessel v-1 in crude unit from latest to oldest ordered", UNITS);
  it("becomes keywords", () => {
    expect(q).toMatchObject({ terms: ["vessel"], tags: ["v1"], units: ["2000"], types: ["pdf"], sort: "newest" });
  });
  it("names the category the words point at", () => {
    expect(categoryChips(q, VOCAB)).toEqual([{ name: "VESSELS", terms: ["vessel"] }]);
  });
  it("says V-1 is not in the crude unit, and where it is", () => {
    const [r] = resolveTags(q, VOCAB);
    expect(r.inScope).toEqual([]);
    expect(r.elsewhere.map((e) => e.number).sort()).toEqual(["2510.01", "3510.01"]);
  });
  it("resolves inside the unit when it is there", () => {
    const [r] = resolveTags(parseThorQuery("v-1 in the platformer", UNITS), VOCAB);
    expect(r.inScope.map((e) => e.number)).toEqual(["3510.01"]);
  });
  it("multi-word categories", () => {
    expect(categoryChips(parseThorQuery("relief valves in the platformer", UNITS), VOCAB)).toEqual([{ name: "RELIEF VALVES", terms: ["relief", "valve"] }]);
  });
});
