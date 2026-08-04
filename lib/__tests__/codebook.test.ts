// lib/__tests__/codebook.test.ts — the codec is where the edge cases live;
// every convention quirk that could silently mis-file an asset gets a case.

import { describe, it, expect } from "vitest";
import {
  normalizeTag, splitTag, typeForTag, tagToCode, codeToTag,
  parseDrawingNumber, diffImport,
  EMPTY_CODEBOOK, type Codebook, type CodebookEntry,
} from "@/lib/codebook";

const entry = (kind: CodebookEntry["kind"], code: string, label: string, tagPrefixes?: string[]): CodebookEntry =>
  ({ id: `${kind}-${code}`, kind, code, label, meta: tagPrefixes ? { tagPrefixes } : {}, sort: 0, origin: "manual" });

/** The user's refinery, as taught in chat: 20 Crude, 25 DHT, 30 KHT,
 *  35 Platformer; types 10 vessels, 15 piping, 30 exchangers, 35 heaters;
 *  drawings like 2002-D-10001 SHT.4. */
const BOOK: Codebook = {
  units: [
    entry("unit", "20", "Crude Unit"),
    entry("unit", "25", "DHT"),
    entry("unit", "30", "KHT"),
    entry("unit", "35", "Platformer"),
  ],
  equipmentTypes: [
    entry("equipment_type", "10", "Vessels", ["V", "D"]),
    entry("equipment_type", "15", "Piping", ["L"]),
    entry("equipment_type", "30", "Exchangers", ["E"]),
    entry("equipment_type", "35", "Heaters", ["H"]),
    entry("equipment_type", "40", "Air Coolers", ["EA"]), // longer prefix than E
    entry("equipment_type", "50", "Pumps", ["P"]),
  ],
  drawingTypes: [
    entry("drawing_type", "02", "P&ID"),
    entry("drawing_type", "15", "Piping Isometric"),
  ],
  drawingNumber: {
    segments: [
      { kind: "unit", digits: 2 },
      { kind: "drawing_type", digits: 2 },
      { kind: "size", letters: 1 },
      { kind: "iterable" },
      { kind: "sheet" },
    ],
  },
  iterableRule: { mirrorsTag: true, padTo: 0 },
  legendDocIds: [],
};

describe("normalizeTag / splitTag", () => {
  it("canonicalizes case, spacing, and unicode dashes", () => {
    expect(normalizeTag("e-22")).toBe("E-22");
    expect(normalizeTag(" E – 22 ")).toBe("E-22");
    expect(normalizeTag("E22")).toBe("E-22");
  });
  it("splits prefix / number / suffix", () => {
    expect(splitTag("E-22")).toEqual({ prefix: "E", number: "22", suffix: "" });
    expect(splitTag("P-101A")).toEqual({ prefix: "P", number: "101", suffix: "A" });
    expect(splitTag("EA-1002")).toEqual({ prefix: "EA", number: "1002", suffix: "" });
  });
  it("rejects non-tags", () => {
    expect(splitTag("2002-D-10001")).toBeNull();  // a drawing number is not a tag
    expect(splitTag("HELLO")).toBeNull();
    expect(splitTag("")).toBeNull();
  });
});

describe("typeForTag — longest prefix wins", () => {
  it("EA beats E for air coolers", () => {
    expect(typeForTag("EA-101", BOOK)?.label).toBe("Air Coolers");
    expect(typeForTag("E-22", BOOK)?.label).toBe("Exchangers");
  });
  it("unknown prefix → null (never guesses)", () => {
    expect(typeForTag("X-1", BOOK)).toBeNull();
  });
});

describe("tagToCode — the user's worked example", () => {
  it("E-22 in the crude unit is 2030.22", () => {
    expect(tagToCode("E-22", "20", BOOK)).toBe("2030.22");
  });
  it("suffixes ride along; leading zeros canonicalize", () => {
    expect(tagToCode("P-101A", "20", BOOK)).toBe("2050.101A");
    expect(tagToCode("E-022", "25", BOOK)).toBe("2530.22");
  });
  it("padding honors the org rule", () => {
    const padded: Codebook = { ...BOOK, iterableRule: { mirrorsTag: true, padTo: 2 } };
    expect(tagToCode("P-5", "20", padded)).toBe("2050.05");
    expect(tagToCode("E-122", "20", padded)).toBe("2030.122"); // padTo never truncates
  });
  it("degrades to null: no unit, unknown prefix, non-mirroring scheme, empty book", () => {
    expect(tagToCode("E-22", null, BOOK)).toBeNull();
    expect(tagToCode("X-9", "20", BOOK)).toBeNull();
    expect(tagToCode("E-22", "20", { ...BOOK, iterableRule: { mirrorsTag: false, padTo: 0 } })).toBeNull();
    expect(tagToCode("E-22", "20", EMPTY_CODEBOOK)).toBeNull();
  });
});

describe("codeToTag — the inverse", () => {
  it("2030.22 → E-22 in unit 20", () => {
    expect(codeToTag("2030.22", BOOK)).toEqual({ tag: "E-22", unitCode: "20", typeCode: "30" });
  });
  it("padding strips on the way back; suffix survives", () => {
    expect(codeToTag("2050.05A", BOOK)).toEqual({ tag: "P-5A", unitCode: "20", typeCode: "50" });
  });
  it("round-trips through tagToCode", () => {
    for (const [tag, unit] of [["E-22", "20"], ["H-3", "35"], ["EA-101", "25"], ["V-1201", "30"]] as const) {
      const code = tagToCode(tag, unit, BOOK)!;
      expect(codeToTag(code, BOOK)).toMatchObject({ tag, unitCode: unit });
    }
  });
  it("rejects codes the book can't place", () => {
    expect(codeToTag("9999.1", BOOK)).toBeNull();   // unknown unit+type
    expect(codeToTag("garbage", BOOK)).toBeNull();
    expect(codeToTag("2030.22", EMPTY_CODEBOOK)).toBeNull();
  });
});

describe("parseDrawingNumber — tolerant of real-world formatting", () => {
  const parse = (s: string) => parseDrawingNumber(s, BOOK);

  it("the canonical form decodes fully", () => {
    expect(parse("2002-D-10001 SHT.4")).toEqual({
      unitCode: "20", unitLabel: "Crude Unit",
      drawingTypeCode: "02", drawingTypeLabel: "P&ID",
      size: "D", iterable: "10001", sheet: "4",
    });
  });
  it("piping iso, B size", () => {
    expect(parse("2015-B-0042 SHT 12")).toMatchObject({
      unitCode: "20", drawingTypeLabel: "Piping Isometric", size: "B", iterable: "0042", sheet: "12",
    });
  });
  it("separator soup: dots, underscores, no separators, lowercase", () => {
    expect(parse("2002.D.10001.sht.4")).toMatchObject({ unitCode: "20", size: "D", sheet: "4" });
    expect(parse("2002_D_10001")).toMatchObject({ unitCode: "20", size: "D", iterable: "10001", sheet: null });
    expect(parse("2002d10001")).toMatchObject({ unitCode: "20", size: "D", iterable: "10001" });
  });
  it("sheet marker variants: SHEET / SHT / SH / S.", () => {
    for (const v of ["SHEET 7", "SHT.7", "SH 7", "S.7", "7"]) {
      expect(parse(`2002-D-10001 ${v}`)?.sheet).toBe("7");
    }
  });
  it("sheet number canonicalizes leading zeros; iterable keeps them", () => {
    const p = parse("2002-D-00042 SHT.007")!;
    expect(p.iterable).toBe("00042");
    expect(p.sheet).toBe("7");
  });
  it("missing trailing segments are fine; missing identity is not", () => {
    expect(parse("2002-D")).toMatchObject({ unitCode: "20", size: "D", iterable: null, sheet: null });
    expect(parse("20")).toBeNull();      // drawing_type required but absent
    expect(parse("ABCD-D-1")).toBeNull(); // unit must be digits
  });
  it("unknown codes still parse — labels just come back null", () => {
    expect(parse("9902-D-1")).toMatchObject({ unitCode: "99", unitLabel: null, drawingTypeLabel: "P&ID" });
  });
  it("no decoder configured → null, never a guess", () => {
    expect(parseDrawingNumber("2002-D-10001", EMPTY_CODEBOOK)).toBeNull();
  });
});

describe("diffImport — AI proposals never steamroll manual work", () => {
  const existing = [entry("unit", "20", "Crude Unit"), entry("equipment_type", "30", "Exchangers", ["E"])];

  it("classifies adds / changes / unchanged", () => {
    const d = diffImport(existing, [
      { kind: "unit", code: "20", label: "Crude Unit" },              // unchanged
      { kind: "unit", code: "25", label: "DHT" },                     // add
      { kind: "equipment_type", code: "30", label: "Heat Exchangers", tagPrefixes: ["E"] }, // change
    ]);
    expect(d.adds).toHaveLength(1);
    expect(d.adds[0].code).toBe("25");
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0].existing.label).toBe("Exchangers");
    expect(d.unchanged).toHaveLength(1);
  });
  it("prefix-set changes count as changes; order does not", () => {
    const same = diffImport(existing, [{ kind: "equipment_type", code: "30", label: "Exchangers", tagPrefixes: ["E"] }]);
    expect(same.changes).toHaveLength(0);
    const diff = diffImport(existing, [{ kind: "equipment_type", code: "30", label: "Exchangers", tagPrefixes: ["E", "EA"] }]);
    expect(diff.changes).toHaveLength(1);
  });
  it("drops AI garbage: blanks and duplicates", () => {
    const d = diffImport([], [
      { kind: "unit", code: "", label: "Nameless" },
      { kind: "unit", code: "25", label: "" },
      { kind: "unit", code: "25", label: "DHT" },
      { kind: "unit", code: "25", label: "DHT again" },
    ]);
    expect(d.adds).toHaveLength(1);
    expect(d.adds[0].label).toBe("DHT");
  });
});
