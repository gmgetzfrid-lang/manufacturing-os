import { describe, it, expect } from "vitest";
import { isSelectionQuestion, filterCandidates, distinguishers, openingFields, labelCounts, normChem, selectionBlock, guideTerms, type CatalogRecord } from "@/lib/specSelect";

// The Service Index rows from the real question, plus distractors.
const rec = (code: string, rating: string, service: string, ca: string, temp: string, material: string): CatalogRecord =>
  ({ code, documentId: "spec", documentName: "E2G Piping Specs (All).pdf", page: 1, rating, service, attrs: { "Corrosion Allowance": ca, "Temperature Range": temp, "Pipe Material": material } });
const catalog = [
  rec("AAAC2H", "150", "Hydrocarbon and/or Hydrogen Rich Service, Sour Service (200 BHN MAX)", "0.125", "-20 - 450", "CS - PWHT if wall thk.>3/4"),
  rec("AAAW2H", "150", "Wet H2S Per EP 10-2-1, DEA Service (150 F Max), Hydrogen", "0.125", "-20 - 800", "CS - PWHT if wall thk.>3/4"),
  rec("AAAW3H", "150", "Wet H2S Per EP 10-2-1, DEA Service (150 F Max), Regeneration Vapor", "0.188", "-20 - 800", "CS(Thk.>3/4\", PWHT)"),
  rec("AAAW4H", "150", "Wet H2S Per EP 10-2-1, Sour Water, Stripper Reflux (200 BHN MAX)", "0.250", "-20 - 800", "CS(Thk.>3/4\", PWHT)"),
  rec("AAAW4L", "150", "Wet H2S Per EP 10-2-1, Sour Water, Stripper Reflux (200 BHN MAX)", "0.250", "-20 - 800", "CS - PWHT"),
  rec("FAAW4H", "1500", "Wet H2S Per EP 10-2-1, Sour Water", "0.250", "-20 - 800", "CS"),
  rec("AAAA1", "150", "Hydrocarbons and/or Hydrogen Rich Service, Nitrogen", "0.065", "-20 - 800", "CS"),
  rec("AAAN2", "150", "Amine, NACE requirements", "0.125", "-20 - 400", "CS"),
];

describe("selection: filter the catalog, then narrow", () => {
  it("recognises a selection question", () => {
    expect(isSelectionQuestion("What piping spec should i use for 150 class sour gas stream")).toBe(true);
    expect(isSelectionQuestion("Can I use a 300 class flange on a vessel")).toBe(false);
  });
  it("Class 150 + 'sour' (asker) + 'wet h2s' (company's word) → the five sour classes, not 1500, not amine-by-lead first", () => {
    const c = filterCandidates(catalog, { ratings: ["150"], askerTerms: ["sour gas", "sour"], companyTerms: ["wet h2s"], leadTerms: ["nace"] });
    const strong = c.filter((x) => x.matched.some((m) => m.how !== "lead")).map((x) => x.code);
    expect(strong.sort()).toEqual(["AAAC2H", "AAAW2H", "AAAW3H", "AAAW4H", "AAAW4L"]);
    expect(c.map((x) => x.code)).not.toContain("FAAW4H");
    expect(c.find((x) => x.code === "AAAN2")?.matched).toEqual([{ term: "nace", how: "lead" }]);
    expect(c.find((x) => x.code === "AAAW2H")?.matched[0]).toEqual({ term: "wet h2s", how: "company" });
  });
  it("names what splits the shortlist", () => {
    const c = filterCandidates(catalog, { ratings: ["150"], askerTerms: ["sour"], companyTerms: ["wet h2s"], leadTerms: [] });
    const fields = distinguishers(c).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["Corrosion Allowance", "Temperature Range", "Pipe Material"]));
    const text = selectionBlock(c, { ratings: ["150"], askerTerms: ["sour"], companyTerms: ["wet h2s"], total: 700, cite: () => null });
    expect(text).toMatch(/every catalog entry in the libraries \(700\)/);
    expect(text).toMatch(/THEY DIFFER ON: .*Corrosion Allowance/);
  });
  it("reads labelled fields off a class's opening page, learning the labels from the book", () => {
    const page = (svc: string, r: string, mat: string) => `Service: ${svc} Rating: ${r} Corrosion Allowance: 0.250 in. Temperature Range: -20 - 800 Pipe Material: ${mat} Valve Trim: 316 SS w/ Stellite Seat`;
    const pages = [page("Wet H2S Per EP 10-2-1, Sour Water", "150", "CS - PWHT"), page("Steam", "300", "1-1/4 Cr"), page("Cooling Water", "150", "CS"), page("Hydrocarbons, Nitrogen", "600", "316L SS")];
    const f = openingFields(pages[0], labelCounts(pages));
    expect(f).toMatchObject({ Service: "Wet H2S Per EP 10-2-1, Sour Water", Rating: "150", "Corrosion Allowance": "0.250 in.", "Pipe Material": "CS - PWHT" });
  });
  it("puts formulas back together", () => {
    expect(normChem("Wet H 2 S")).toBe("wet h2s");
  });
  it("looks for the library's own selection section and code legend", () => {
    expect(guideTerms("what piping spec should I use")).toEqual(["class selection", "first character", "designator"]);
  });
});

describe("fixes from the second real answer", () => {
  it("a class with no recorded rating stays on the shortlist, after the rated ones", () => {
    const recs = [
      { ...catalog[1], rating: undefined },
      catalog[0],
      { ...catalog[5] },
    ];
    const c = filterCandidates(recs, { ratings: ["150"], askerTerms: ["sour"], companyTerms: ["wet h2s"], leadTerms: [] });
    expect(c.map((x) => x.code)).toEqual(["AAAC2H", "AAAW2H"]);
    expect(selectionBlock(c, { ratings: ["150"], askerTerms: ["sour"], companyTerms: [], total: 3, cite: () => null })).toMatch(/AAAW2H.*rating not recorded/);
  });
});
