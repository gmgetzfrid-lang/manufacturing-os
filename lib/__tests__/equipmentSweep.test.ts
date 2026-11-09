import { describe, it, expect } from "vitest";
import { readCallout, decodeId, sweepRows, typeFromLetter, autoReady, type RegistryAsset } from "@/lib/equipmentSweep";
import type { Codebook, CodebookEntry } from "@/lib/codebook";

const e = (kind: string, code: string, label: string, prefixes?: string[]): CodebookEntry => ({ id: code, orgId: "o", kind, code, label, meta: prefixes ? { tagPrefixes: prefixes } : {} } as unknown as CodebookEntry);
const book: Codebook = {
  units: [e("unit", "20", "Crude Unit"), e("unit", "55", "Transmix Unit (Old Solvent Unit)")],
  equipmentTypes: [e("equipment_type", "10", "Vessels", ["V"]), e("equipment_type", "26", "Pumps (Centrifugal)"), e("equipment_type", "30", "Exchangers"), e("equipment_type", "35", "Heaters")],
  drawingTypes: [], drawingNumber: null, iterableRule: { mirrorsTag: false, padTo: 0 }, legendDocIds: [],
};
// The registry today: the Crude Unit's V-7 with a guessed ID, its E-12 with none.
const crude: RegistryAsset[] = [
  { id: "c-v7", tag: "V-7", code: "2010.7", unitCode: "20" },
  { id: "c-e12", tag: "E-12", code: null, unitCode: "20" },
];

describe("reading the callout", () => {
  it("takes the ID in brackets and the service name, not the design data", () => {
    expect(readCallout("E-12", "E-12 (5530.25) TRANSMIX FEED / TRANS. DIESEL EXCHANGER NO. 2 · SIZE: 15'-0\"L")).toEqual({ code: "5530.25", name: "TRANSMIX FEED / TRANS. DIESEL EXCHANGER NO. 2" });
    expect(readCallout("P-10", "P-10 (5526.22) CHEM. PUMP")).toEqual({ code: "5526.22", name: "CHEM. PUMP" });
    expect(readCallout("V-25", "V-25 TRANSMIX 1 FEED FILTER")).toEqual({ code: null, name: "TRANSMIX 1 FEED FILTER" });
    expect(readCallout("V-9", "V-9 (XX) FILTER")).toEqual({ code: null, name: "FILTER" });
  });
  it("decodes the unit and type from the ID", () => {
    expect(decodeId("5530.25", book)).toEqual({ unitCode: "55", unitLabel: "Transmix Unit (Old Solvent Unit)", typeCode: "30", typeLabel: "Exchangers" });
    expect(decodeId("5526.20", book)?.typeLabel).toBe("Pumps (Centrifugal)");
    expect(decodeId("9930.1", book)).toBeNull();
  });
  it("types a tag with no ID from the codebook prefix, else the usual letter", () => {
    expect(typeFromLetter("V-25", book)).toEqual({ code: "10", label: "Vessels", from: "codebook" });
    expect(typeFromLetter("E-9", book)).toEqual({ code: "30", label: "Exchangers", from: "letter" });
    expect(typeFromLetter("X-31", book)).toBeNull();
  });
});

describe("lining up with the registry by ID", () => {
  it("a Transmix V-7 never matches the Crude Unit's V-7", () => {
    const [r] = sweepRows({ readings: [{ tag: "V-7", page: 1, raw: "V-7 (5510.19) TRANSMIX FRACTIONATOR" }], registry: crude, book, drawingUnit: "20" });
    expect(r).toMatchObject({ code: "5510.19", codeFrom: "sheet", unitCode: "55", typeLabel: "Vessels", typeFrom: "id", assetId: null, assetStatus: "new", match: null });
    expect(r.otherUnits).toEqual([{ unitCode: "20", code: "2010.7" }]);
    expect(autoReady(r)).toBe(true);
  });
  it("matches by ID whatever the registry calls it", () => {
    const reg = [...crude, { id: "t-v7", tag: "V-07", code: "5510.19", unitCode: "55" }, { id: "t-x", tag: "V-99", code: "5530.25", unitCode: "55" }];
    const rows = sweepRows({ readings: [{ tag: "V-7", page: 2, raw: "V-7 (5510.19) X" }, { tag: "E-12", page: 1, raw: "E-12 (5530.25) Y" }], registry: reg, book, drawingUnit: null });
    expect(rows.find((x) => x.tag === "V-7")).toMatchObject({ assetId: "t-v7", match: "id", listedAs: null });
    expect(rows.find((x) => x.tag === "E-12")).toMatchObject({ assetId: "t-x", match: "id", listedAs: "V-99" });
  });
  it("the same name in the unit with no ID yet is this equipment; with another ID it's a clash", () => {
    const reg: RegistryAsset[] = [{ id: "t-e12", tag: "E-12", code: null, unitCode: "55" }, { id: "t-e16", tag: "E-16", code: "5530.99", unitCode: "55" }];
    const rows = sweepRows({ readings: [{ tag: "E-12", page: 1, raw: "E-12 (5530.25) A" }, { tag: "E-16", page: 1, raw: "E-16 (5530.09) B" }], registry: reg, book, drawingUnit: null });
    expect(rows[0]).toMatchObject({ tag: "E-12", assetId: "t-e12", match: "name" });
    expect(rows[1]).toMatchObject({ tag: "E-16", assetId: null });
    expect(rows[1].problem).toMatch(/has E-16 as 5530\.99; the sheet says 5530\.09/);
  });
  it("no ID printed: the sheet's unit from its other IDs, a name match only in that unit, else it needs an ID", () => {
    const reg: RegistryAsset[] = [...crude];
    const rows = sweepRows({ readings: [{ tag: "E-17", page: 1, raw: "E-17 (5530.26) A" }, { tag: "E-12", page: 1, raw: "E-12 B" }], registry: reg, book, drawingUnit: "20" });
    const e12 = rows.find((x) => x.tag === "E-12")!;
    expect(e12).toMatchObject({ unitCode: "55", code: null, codeFrom: null, assetId: null, typeFrom: "letter" });
    expect(autoReady(e12)).toBe(false);
  });
});
