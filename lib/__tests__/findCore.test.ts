import { describe, it, expect } from "vitest";
import {
  tagKey, isTagLike, equipScore, rankEquip, exactTagMatches, whichOneLine, defaultPick,
  unitFromFolderName, unitOfChain, docLabel, docMeta, equipLabel, unitName, otherDocs, type FindEquip,
} from "@/lib/findCore";

const units = [
  { code: "30", label: "Kerosene Hydrotreater (KHT)" },
  { code: "55", label: "Transmix Unit (Old Solvent Unit)" },
  { code: "56", label: "LPG Recovery Unit (LRU)" },
];

const eq = (id: string, tag: string, code: string, unitCode: string, description: string): FindEquip => ({
  id, tag, code, unitCode, unitLabel: units.find((u) => u.code === unitCode)?.label ?? null, description, typeName: "Exchangers", docIds: [], score: 0,
});

// The three real E-22s.
const e22s = [
  eq("t", "E-22", "5530.29", "55", "TRANSMIX UNIT 2 FEED/BOTTOMS EXCHANGER"),
  eq("l", "E-22", "5630.01", "56", "COMPRESSOR INTERSTAGE COOLER"),
  eq("k", "E-22", "3030.22", "30", "ENGINE JW COOLER / RADIATOR"),
];
const scored = (q: string, list: FindEquip[]) => rankEquip(list.map((e) => ({ ...e, score: equipScore(q, e) })).filter((e) => e.score > 0));

describe("tags", () => {
  it("one tag however it is typed", () => {
    expect(tagKey("E-22")).toBe("e22");
    expect(tagKey("e22")).toBe("e22");
    expect(tagKey("E-022")).toBe("e22");
    expect(tagKey("V 01")).toBe("v1");
    expect(tagKey("PSV-209A")).toBe("psv209a");
  });
  it("knows a tag from a phrase or an ID", () => {
    expect(isTagLike("e22")).toBe(true);
    expect(isTagLike("E-22")).toBe(true);
    expect(isTagLike("feed exchanger")).toBe(false);
    expect(isTagLike("5530.29")).toBe(false);
    expect(isTagLike("pump")).toBe(false);
  });
});

describe("equipment hits", () => {
  it("e22 finds all three, best first by unit", () => {
    const r = scored("e22", [...e22s, eq("x", "E-221", "5530.40", "55", "OTHER")]);
    expect(r.slice(0, 3).map((e) => e.unitCode)).toEqual(["30", "55", "56"]);
    expect(r[3].tag).toBe("E-221");
    expect(r[0].score).toBe(100);
    expect(r[3].score).toBeLessThan(100);
  });
  it("an ID finds the one", () => {
    const r = scored("5530.29", e22s);
    expect(r[0].id).toBe("t");
    expect(defaultPick("5530.29", r, null)).toBe("t");
  });
  it("words find by description", () => {
    const r = scored("interstage cooler", e22s);
    expect(r.map((e) => e.id)).toEqual(["l"]);
  });
});

describe("which one", () => {
  it("asks when a tag is on several units", () => {
    const m = exactTagMatches("e22", e22s);
    expect(m).toHaveLength(3);
    expect(whichOneLine("E-22", m)).toBe("E-22 is on 3 units. Which one?");
    expect(defaultPick("e22", e22s, null)).toBeNull();
  });
  it("picks the unit of the folder you're in", () => {
    expect(defaultPick("e22", e22s, "55")).toBe("t");
    expect(defaultPick("E-22", e22s, "56")).toBe("l");
  });
  it("still asks when the folder's unit has none of them", () => {
    expect(defaultPick("e22", e22s, "20")).toBeNull();
  });
  it("two with one name on one unit: names it so", () => {
    const two = [eq("a", "V-7", "5510.07", "55", "A"), eq("b", "V-7", "5510.70", "55", "B")];
    expect(whichOneLine("V-7", two)).toBe("There are 2 called V-7. Which one?");
    expect(defaultPick("v7", two, "55")).toBeNull();
  });
  it("one match needs no question", () => {
    expect(whichOneLine("E-22", [e22s[0]])).toBeNull();
    expect(defaultPick("e22", [e22s[1]], "55")).toBe("l");
  });
});

describe("folder unit", () => {
  it("reads the unit from the folder name", () => {
    expect(unitFromFolderName("55 - Transmix", units)).toBe("55");
    expect(unitFromFolderName("56 - LRU", units)).toBe("56");
    expect(unitFromFolderName("LRU", units)).toBe("56");
    expect(unitFromFolderName("99 - Nowhere", units)).toBeNull();
    expect(unitFromFolderName("P&ID's", units)).toBeNull();
  });
  it("a leading number the name does not back up is not a unit", () => {
    const more = [...units, { code: "10", label: "Engineering" }, { code: "71", label: "Transfer" }];
    expect(unitFromFolderName("10 - Material Requirements", more)).toBeNull();
    expect(unitFromFolderName("30 - KHT", more)).toBe("30");
    expect(unitFromFolderName("55", more)).toBeNull();
  });
  it("a mark on the folder wins, deepest first", () => {
    const chain = [{ id: "p", name: "P&ID's" }, { id: "t", name: "55 - Transmix" }];
    expect(unitOfChain(chain, new Map(), units)).toBe("55");
    expect(unitOfChain(chain, new Map([["t", "56"]]), units)).toBe("56");
    expect(unitOfChain([{ id: "p", name: "P&ID's" }], new Map(), units)).toBeNull();
  });
});

describe("labels", () => {
  it("says the unit, the ID and the sheet", () => {
    expect(equipLabel(e22s[0])).toBe("E-22 (5530.29)");
    expect(equipLabel({ tag: "X-31 (2030.31)", code: "2030.31" })).toBe("X-31 (2030.31)");
    expect(unitName(e22s[0])).toBe("55 Transmix Unit (Old Solvent Unit)");
    expect(unitName({ unitCode: null, unitLabel: null })).toBe("No unit set");
    expect(docLabel({ number: "5502-D 2000-5", title: "5502-D 2000", name: null })).toBe("5502-D 2000-5");
    expect(docMeta({ sheet: "05", rev: "05" })).toBe("sheet 05 · Rev 05");
    expect(docMeta({ sheet: null, rev: "0" })).toBe("Rev 0");
  });
  it("lists other documents once", () => {
    expect(otherDocs(["a", "b", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });
});
