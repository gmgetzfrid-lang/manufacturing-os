// The codebook is told the site's convention from the site's own numbers,
// with the count behind every line. Nothing is proposed that the numbers do
// not show plainly.

import { describe, it, expect } from "vitest";
import { folderAsTypeName, learnDrawingNumbers, learnTagLetters } from "@/lib/codebookLearn";
import type { Codebook, CodebookEntry } from "@/lib/codebook";

const e = (kind: CodebookEntry["kind"], code: string, label: string, meta: CodebookEntry["meta"] = {}): CodebookEntry => ({ id: `${kind}-${code}`, kind, code, label, meta, sort: 0, origin: "manual" });
const book: Codebook = {
  units: [e("unit", "20", "Crude Unit"), e("unit", "30", "Kerosene Hydrotreater (KHT)"), e("unit", "55", "Transmix Unit (Old Solvent Unit)"), e("unit", "56", "LPG Recovery Unit (LRU)")],
  equipmentTypes: [e("equipment_type", "10", "Vessels", { tagPrefixes: ["V"] }), e("equipment_type", "24", "Pumps (Chemical)"), e("equipment_type", "26", "Pumps (Centrifugal)"), e("equipment_type", "30", "Exchangers"), e("equipment_type", "35", "Heaters")],
  drawingTypes: [], drawingNumber: null, iterableRule: { mirrorsTag: false, padTo: 0 }, legendDocIds: [],
};

// The site's drawings, as they are numbered and filed.
const drawings = [
  ...Array.from({ length: 16 }, () => ({ number: "2002-D 2001", topFolder: "P&ID's" })),
  ...Array.from({ length: 14 }, (_, i) => ({ number: i ? `3002-D 1086-${i + 1}` : "3002-D 1086", topFolder: "P&ID's" })),
  ...Array.from({ length: 8 }, (_, i) => ({ number: i ? `5502-D 2000-${i + 1}` : "5502-D 2000", topFolder: "P&ID's" })),
  { number: "2003-D 1039", topFolder: "PFD's" }, { number: "5503-D 1000", topFolder: "PFD's" },
  { number: "PSSR-TRANSMIX-1-2-TURNAROUND-10-2-20261108-093429", topFolder: null },
];

describe("learnDrawingNumbers", () => {
  const r = learnDrawingNumbers(drawings, book)!;
  it("reads the convention the numbers follow, and says how many follow it", () => {
    expect(r.segments).toEqual([{ kind: "unit", digits: 2 }, { kind: "drawing_type", digits: 2 }, { kind: "size", letters: 1 }, { kind: "iterable" }]);
    expect([r.fit, r.total]).toEqual([40, 41]);
    expect(r.misses).toEqual(["PSSR-TRANSMIX-1-2-TURNAROUND-10-2-20261108-093429"]);
    expect(r.examples.find((x) => x.number === "2003-D 1039")).toMatchObject({ unit: "20", unitLabel: "Crude Unit", type: "03", size: "D", serial: "1039" });
  });
  it("names a type for the folder all its drawings sit under", () => {
    expect(r.types).toEqual([
      { code: "02", count: 38, folder: "P&ID's", inFolder: 38, label: "P&ID", known: null },
      { code: "03", count: 2, folder: "PFD's", inFolder: 2, label: "PFD", known: null },
    ]);
  });
  it("leaves a type unnamed when its drawings are filed in more than one place", () => {
    const mixed = drawings.map((d, i) => (d.number.startsWith("2002") && i % 2 ? { ...d, topFolder: "Old" } : d));
    expect(learnDrawingNumbers(mixed, book)!.types.find((t) => t.code === "02")?.label).toBeNull();
  });
  it("proposes nothing when most numbers do not fit, or the unit is not the site's", () => {
    const standards = Array.from({ length: 40 }, (_, i) => ({ number: `EP ${i}-1-1`, topFolder: "Section 5" }));
    expect(learnDrawingNumbers([...drawings.slice(0, 5), ...standards], book)).toBeNull();
    expect(learnDrawingNumbers(Array.from({ length: 10 }, () => ({ number: "9902-D 1000", topFolder: "P&ID's" })), book)).toBeNull();
    expect(learnDrawingNumbers(drawings.slice(0, 3), book)).toBeNull();
  });
  it("says a type the codebook already names", () => {
    const named = { ...book, drawingTypes: [e("drawing_type", "02", "P&ID")] };
    expect(learnDrawingNumbers(drawings, named)!.types.find((t) => t.code === "02")?.known).toBe("P&ID");
  });
});

describe("learnTagLetters", () => {
  const registry = [
    ...Array.from({ length: 6 }, (_, i) => ({ tag: `E-${i + 1}`, code: `5530.${i + 1}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ tag: `X-${i + 1}`, code: `2030.${i + 1}` })),
    { tag: "H-1", code: "5535.1" }, { tag: "H-2", code: "5535.2" },
    { tag: "V-7", code: "5510.7" }, { tag: "V-8", code: "5510.8" },
    // P is two kinds of pump: it belongs to neither.
    { tag: "P-1", code: "5526.1" }, { tag: "P-2", code: "5526.2" }, { tag: "P-3", code: "5524.3" }, { tag: "P-4", code: "5524.4" },
    { tag: "K-1", code: "5535.9" },      // one alone proves nothing
    { tag: "T-100", code: null },         // no ID: says nothing
  ];
  const r = learnTagLetters(registry, book);
  it("gives a letter to the type its tagged equipment is, with the count", () => {
    expect(r).toEqual([
      { typeCode: "30", typeLabel: "Exchangers", letters: [{ letter: "E", count: 6 }, { letter: "X", count: 5 }], have: [] },
      { typeCode: "35", typeLabel: "Heaters", letters: [{ letter: "H", count: 2 }], have: [] },
    ]);
  });
  it("leaves out a letter shared between types, and types that already have theirs", () => {
    expect(r.some((x) => x.typeLabel.startsWith("Pumps"))).toBe(false);
    expect(r.some((x) => x.typeLabel === "Vessels")).toBe(false);
  });
});

describe("folderAsTypeName", () => {
  it("drops the plural a folder name carries", () => {
    expect(folderAsTypeName("P&ID's")).toBe("P&ID");
    expect(folderAsTypeName("PFDs")).toBe("PFD");
    expect(folderAsTypeName("Isometrics")).toBe("Isometrics");
  });
});
