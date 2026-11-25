import { describe, it, expect } from "vitest";
import { assetHref, parseEquipmentLabel, labelKey, pieces, pickEquipment, readerMatch, lookupOrder, keepOrder, onePerPiece, unitOfId, type IdentityRecord } from "@/lib/equipmentIdentity";

// The live registry's shape: the X-31 a person added (with its ID and three
// photos) and the copy the drawing reader made without one.
const x31Mine: IdentityRecord = { id: "mine", tag: "X-31", code: "2030.31", unitCode: "20", origin: "manual", photos: 3, createdAt: "2026-05-28" };
const x31Copy: IdentityRecord = { id: "copy", tag: "X-31", code: null, unitCode: "20", origin: "drawing", photos: 0, createdAt: "2026-10-22" };
const v21: IdentityRecord[] = [
  { id: "v21-20", tag: "V-21", code: "2010.21", unitCode: "20", origin: "drawing" },
  { id: "v21-56", tag: "V-21", code: "5610.02", unitCode: "56", origin: "drawing" },
  { id: "v21-30", tag: "V-21", code: "3010.21", unitCode: "30", origin: "drawing" },
];
const v5: IdentityRecord[] = [
  { id: "v5-09", tag: "V-5", code: "5510.09", unitCode: "55", origin: "drawing" },
  { id: "v5-19", tag: "V-5", code: "5510.19", unitCode: "55", origin: "drawing" },
];
const registry = [x31Mine, x31Copy, ...v21, ...v5];

describe("reading a label", () => {
  it("splits TAG (ID): the ID is who it is, the tag a second name", () => {
    expect(parseEquipmentLabel("X-31 (2030.31)")).toEqual({ tag: "X-31", code: "2030.31" });
    expect(parseEquipmentLabel("  X-31  (2030.31)  Charge pump ")).toEqual({ tag: "X-31", code: "2030.31" });
    expect(parseEquipmentLabel("V-15 (5610.04B)")).toEqual({ tag: "V-15", code: "5610.04B" });
    expect(parseEquipmentLabel("X-31 · 2030.31")).toEqual({ tag: "X-31", code: "2030.31" });
    expect(parseEquipmentLabel("2030.31 X-31")).toEqual({ tag: "X-31", code: "2030.31" });
  });
  it("an ID alone, a tag alone, and brackets that hold no ID", () => {
    expect(parseEquipmentLabel("2030.31")).toEqual({ tag: null, code: "2030.31" });
    expect(parseEquipmentLabel("5516-TV-110")).toEqual({ tag: null, code: "5516-TV-110" });
    expect(parseEquipmentLabel("X-31")).toEqual({ tag: "X-31", code: null });
    expect(parseEquipmentLabel("V-9 (XX)")).toEqual({ tag: "V-9", code: null });
    expect(parseEquipmentLabel("")).toEqual({ tag: null, code: null });
    expect(parseEquipmentLabel(null)).toEqual({ tag: null, code: null });
  });
  it("one key for both spellings of a labelled piece", () => {
    expect(labelKey("X-31 (2030.31)")).toBe(labelKey("2030.031"));
    expect(labelKey("X-31")).not.toBe(labelKey("X-31 (2030.31)"));
    expect(labelKey("X-31", "20")).toBe(labelKey("x 31", "20"));
  });
  it("the unit an ID belongs to", () => {
    expect(unitOfId("2030.31", ["20", "30", "55"])).toBe("20");
    expect(unitOfId("5510.09", ["5", "55"])).toBe("55");
    expect(unitOfId("2030.31", ["30"])).toBeNull();
  });
});

describe("pieces of equipment", () => {
  it("a copy with no ID joins the unit's one piece of that tag", () => {
    const ps = pieces([x31Mine, x31Copy]);
    expect(ps).toHaveLength(1);
    expect(ps[0].records.map((r) => r.id).sort()).toEqual(["copy", "mine"]);
    expect(ps[0].code).toBe("2030.31");
  });
  it("the same tag on three units is three pieces; two IDs in one unit are two", () => {
    expect(pieces(v21)).toHaveLength(3);
    expect(pieces(v5)).toHaveLength(2);
  });
  it("a copy with no ID where the unit has two IDs for the tag stands apart, unsure", () => {
    const ps = pieces([...v5, { id: "v5-x", tag: "V-5", code: null, unitCode: "55" }]);
    expect(ps).toHaveLength(3);
    expect(ps.find((p) => p.records[0].id === "v5-x")?.unsure).toBe(true);
  });
  it("the same ID is one piece, whatever the zeros or the name", () => {
    expect(pieces([{ id: "a", tag: "V-7", code: "2010.07", unitCode: "20" }, { id: "b", tag: "V-07", code: "2010.7", unitCode: "20" }])).toHaveLength(1);
    expect(pieces([{ id: "a", tag: "X-31 (2030.31)", code: null, unitCode: "20" }, { id: "b", tag: "X-31", code: "2030.31", unitCode: "20" }])).toHaveLength(1);
  });
  it("copies of one piece with no ID at all are one piece, but never across units", () => {
    expect(pieces([{ id: "a", tag: "C-02", code: null, unitCode: "20" }, { id: "b", tag: "C-2", code: null, unitCode: "20" }])).toHaveLength(1);
    expect(pieces([{ id: "a", tag: "C-02", code: null, unitCode: "20" }, { id: "b", tag: "C-02", code: null, unitCode: "56" }])).toHaveLength(2);
    expect(pieces([{ id: "a", tag: "C-02", code: null, unitCode: null }, { id: "b", tag: "C-02", code: "2028.02", unitCode: "20" }])).toHaveLength(2);
  });
});

describe("which record shows, and which stays", () => {
  it("to show: the one with an ID, then the one with photos", () => {
    const withPhotos: IdentityRecord = { id: "p", tag: "X-1", code: null, unitCode: "20", origin: "drawing", photos: 2 };
    const withId: IdentityRecord = { id: "i", tag: "X-1", code: "2030.01", unitCode: "20", origin: "drawing", photos: 0 };
    const bare: IdentityRecord = { id: "b", tag: "X-1", code: null, unitCode: "20", origin: "drawing", photos: 0 };
    expect([bare, withPhotos, withId].sort(lookupOrder).map((r) => r.id)).toEqual(["i", "p", "b"]);
  });
  it("to keep: the one a person added, then the ID, then photos", () => {
    const typed: IdentityRecord = { id: "t", tag: "X-1", code: null, unitCode: "20", origin: "manual" };
    const withId: IdentityRecord = { id: "i", tag: "X-1", code: "2030.01", unitCode: "20", origin: "drawing" };
    const withPhotos: IdentityRecord = { id: "p", tag: "X-1", code: null, unitCode: "20", origin: "drawing", photos: 4 };
    expect([withPhotos, withId, typed].sort(keepOrder).map((r) => r.id)).toEqual(["t", "i", "p"]);
  });
  it("one per piece", () => {
    expect(onePerPiece(registry).map((r) => r.id).sort()).toEqual(["mine", "v21-20", "v21-30", "v21-56", "v5-09", "v5-19"]);
  });
});

describe("the lookup order: ID first, then the tag in the unit", () => {
  it("the drawing cell's X-31 (2030.31) opens the X-31 with its photos", () => {
    expect(pickEquipment(registry, { label: "X-31 (2030.31)" })).toMatchObject({ asset: { id: "mine" }, why: "id" });
    expect(pickEquipment(registry, { label: "2030.031" })).toMatchObject({ asset: { id: "mine" }, why: "id" });
  });
  it("plain X-31: the copy without an ID is the same piece, so the one with the ID shows", () => {
    expect(pickEquipment(registry, { label: "X-31" })).toMatchObject({ asset: { id: "mine" }, why: "tag" });
    expect(pickEquipment([x31Copy, x31Mine], { label: "x 31", unitCode: "20" })).toMatchObject({ asset: { id: "mine" } });
  });
  it("an ID not on the list finds a record of that tag with no ID yet, in the ID's unit only", () => {
    const reg = [{ id: "c20", tag: "C-03", code: null, unitCode: "20" }, { id: "c30", tag: "C-03", code: null, unitCode: "30" }];
    expect(pickEquipment(reg, { label: "C-03 (2028.03)" })).toMatchObject({ asset: { id: "c20" }, why: "tag" });
    expect(pickEquipment([{ id: "c30", tag: "C-03", code: null, unitCode: "30" }], { label: "C-03 (2028.03)" })).toMatchObject({ asset: null, why: "none" });
  });
  it("an ID not on the list never opens the tag's other ID", () => {
    const r = pickEquipment(registry, { label: "X-31 (2030.99)" });
    expect(r).toMatchObject({ asset: null, why: "other-id" });
    expect(r.candidates.map((c) => c.id)).toContain("mine");
  });
  it("a tag on three units: the unit decides, else no answer", () => {
    expect(pickEquipment(registry, { label: "V-21" })).toMatchObject({ asset: null, why: "ambiguous", units: ["20", "56", "30"] });
    expect(pickEquipment(registry, { label: "V-21", unitCode: "56" })).toMatchObject({ asset: { id: "v21-56" }, why: "tag" });
    expect(pickEquipment(registry, { label: "V-21 (3010.21)" })).toMatchObject({ asset: { id: "v21-30" }, why: "id" });
  });
  it("two IDs for a tag in one unit: only the ID can say", () => {
    expect(pickEquipment(registry, { label: "V-5", unitCode: "55" })).toMatchObject({ asset: null, why: "ambiguous", units: ["55"] });
    expect(pickEquipment(registry, { label: "V-5 (5510.19)" })).toMatchObject({ asset: { id: "v5-19" } });
  });
  it("nothing by that name or ID", () => {
    expect(pickEquipment(registry, { label: "Z-9" })).toMatchObject({ asset: null, why: "none" });
    expect(pickEquipment(registry, { label: "" })).toMatchObject({ asset: null, why: "none" });
  });
});

describe("the drawing reader's matching", () => {
  it("by ID plant-wide, whatever the record is called", () => {
    expect(readerMatch(registry, { tag: "X-31", code: "2030.31", unitCode: "20" })).toMatchObject({ kind: "same-id", asset: { id: "mine" } });
    expect(readerMatch(registry, { tag: "V-99", code: "5610.02", unitCode: "56" })).toMatchObject({ kind: "same-id", asset: { id: "v21-56" } });
  });
  it("no ID printed: the tag in the sheet's unit, copies counted once", () => {
    expect(readerMatch(registry, { tag: "X-31", code: null, unitCode: "20" })).toMatchObject({ kind: "same-tag", asset: { id: "mine" }, fillId: false });
    expect(readerMatch(registry, { tag: "X-31", code: null, unitCode: "30" })).toEqual({ kind: "new" });
    expect(readerMatch(registry, { tag: "X-31", code: null, unitCode: null })).toEqual({ kind: "new" });
  });
  it("an ID for a tag the unit has with none yet: it goes on that record", () => {
    expect(readerMatch([x31Copy], { tag: "X-31", code: "2030.31", unitCode: "20" })).toMatchObject({ kind: "same-tag", asset: { id: "copy" }, fillId: true });
  });
  it("never a second record for a tag the unit already has under another ID", () => {
    expect(readerMatch(registry, { tag: "X-31", code: "2030.99", unitCode: "20" })).toMatchObject({ kind: "other-id", asset: { id: "mine" } });
  });
  it("two IDs for the tag in the unit and a third on the sheet: unsure", () => {
    expect(readerMatch(registry, { tag: "V-5", code: "5510.29", unitCode: "55" })).toMatchObject({ kind: "unsure" });
    expect(readerMatch(registry, { tag: "V-5", code: null, unitCode: "55" })).toMatchObject({ kind: "unsure" });
  });
  it("a tag new to the unit, with its ID: new", () => {
    expect(readerMatch(registry, { tag: "X-77", code: "2030.77", unitCode: "20" })).toEqual({ kind: "new" });
  });
});

describe("a piece of equipment's page", () => {
  it("carries its ID, so X-1 and X-01 each open their own", () => {
    expect(assetHref({ tag: "X-1", code: "2030.01" })).toBe("/assets/X-1?code=2030.01");
    expect(assetHref({ tag: "X-01", code: "3030.01" })).toBe("/assets/X-01?code=3030.01");
    expect(assetHref({ tag: "P-101", code: null })).toBe("/assets/P-101");
    expect(assetHref({ tag: "TK 5 / A" })).toBe("/assets/TK%205%20%2F%20A");
  });
  it("two tags that read the same and no ID: a choice, never a guess", () => {
    const reg: IdentityRecord[] = [
      { id: "a", tag: "X-1", code: "2030.01", unitCode: "20" },
      { id: "b", tag: "X-01", code: "3030.01", unitCode: "30" },
    ];
    expect(pickEquipment(reg, { label: "X-1" }).why).toBe("ambiguous");
    expect(pickEquipment(reg, { label: "X-1 (2030.01)" }).asset?.id).toBe("a");
    expect(pickEquipment(reg, { label: "X-01 (3030.01)" }).asset?.id).toBe("b");
  });
});
