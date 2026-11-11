import { describe, it, expect } from "vitest";
import { EMPTY_CODEBOOK, type Codebook, type CodebookEntry } from "@/lib/codebook";
import type { Milestone } from "@/types/schema";
import {
  decodeSiteCode, codesIn, codeOf, typeOfTag, classifyWorkOrder, classesFor, classOfStep, classPasses, classChoices, EQUIP_UNIT, EQUIP_TYPE, NONE,
} from "@/lib/woClass";
import { matchWorkOrders, setupOrders, undecided } from "@/lib/projectEquipment";

const e = (kind: CodebookEntry["kind"], code: string, label: string, tagPrefixes: string[] = []): CodebookEntry =>
  ({ id: `${kind}${code}`, kind, code, label, meta: { tagPrefixes }, sort: 0, origin: "manual" });
const book: Codebook = {
  ...EMPTY_CODEBOOK,
  units: [e("unit", "20", "Crude Unit"), e("unit", "55", "Transmix Unit"), e("unit", "56", "LPG Recovery Unit (LRU)"), e("unit", "63", "Electricity (Utility)"), e("unit", "73", "Vapor Recovery")],
  equipmentTypes: [e("equipment_type", "08", "Buildings"), e("equipment_type", "10", "Vessels", ["V"]), e("equipment_type", "15", "Piping"), e("equipment_type", "16", "Valves"),
    e("equipment_type", "17", "Relief Valves"), e("equipment_type", "26", "Pumps (Centrifugal)"), e("equipment_type", "24", "Pumps (Chemical)"), e("equipment_type", "28", "Compressors"), e("equipment_type", "30", "Exchangers")],
};
const m = (id: string, name: string, attributes: Record<string, unknown> = {}, parentId: string | null = null) =>
  ({ id, name, attributes, parentId, status: "planned" } as unknown as Milestone);

describe("decodeSiteCode", () => {
  it("reads unit and type from the site's numbering", () => {
    expect(decodeSiteCode("5630.06", book)).toEqual({ code: "5630.06", unit: "56", type: "30", typeKnown: true });
    expect(decodeSiteCode("5610.01A", book)).toMatchObject({ unit: "56", type: "10", typeKnown: true });
    expect(decodeSiteCode("5616-XV-105", book)).toMatchObject({ unit: "56", type: "16" });
    expect(decodeSiteCode("6308.04", book)).toMatchObject({ unit: "63", type: "08" });
  });
  it("keeps a type the codebook doesn't have yet", () => {
    expect(decodeSiteCode("5679.01", book)).toEqual({ code: "5679.01", unit: "56", type: "79", typeKnown: false });
  });
  it("not a code, or no codebook: nothing", () => {
    expect(decodeSiteCode("E-27", book)).toBeNull();
    expect(decodeSiteCode("310337", book)).toBeNull();
    expect(decodeSiteCode("5630.06", EMPTY_CODEBOOK)).toBeNull();
    expect(decodeSiteCode("9930.06", book)).toBeNull();
  });
});

describe("codes in names and columns", () => {
  it("finds codes written in a name", () => {
    expect(codesIn('Modify 4" Piping from E-2 (5630.12) to V-2 (5610.15)')).toEqual(["5630.12", "5610.15"]);
  });
  it("reads the Equipment column", () => {
    expect(codeOf(m("a", "E-27", { Equipment: "5630.06", "Work Order": "310337" }))).toBe("5630.06");
    expect(codeOf(m("a", "E-27", { Equipment: "E-27" }))).toBeNull();
  });
});

describe("typeOfTag", () => {
  it("codebook prefixes first, else the usual letters", () => {
    expect(typeOfTag("V-12A", book)?.code).toBe("10");
    expect(typeOfTag("E-02", book)?.code).toBe("30");
    expect(typeOfTag("PSV-209", book)?.code).toBe("17");
    expect(typeOfTag("XV-105", book)?.code).toBe("16");
  });
  it("letters that could mean more than one type: none", () => {
    expect(typeOfTag("P-11A", book)).toBeNull();
    expect(typeOfTag("ZZ-1", book)).toBeNull();
  });
});

describe("classifyWorkOrder", () => {
  it("the equipment number wins over the tag", () => {
    const c = classifyWorkOrder({ owner: m("a", "E-22 - Annual Service, Clean/Check VFD's", { Equipment: "5679.01" }), book, projectUnits: ["56"] });
    expect(c).toMatchObject({ unit: "56", unitFrom: "code", type: "79", typeFrom: "code" });
  });
  it("a work order on another unit keeps that unit", () => {
    const c = classifyWorkOrder({ owner: m("a", "MCC #4 - LRU Switch House Cleaning", { Equipment: "6308.04" }), book, projectUnits: ["56"] });
    expect(c).toMatchObject({ unit: "63", type: "08" });
  });
  it("no code: tag letters for the type, the project's one unit", () => {
    const c = classifyWorkOrder({ owner: m("a", "Re-Install V-12A with New Compressor Orifice", { "Work Order": "304528" }), book, projectUnits: ["56"] });
    expect(c).toMatchObject({ unit: "56", unitFrom: "project", type: "10", typeFrom: "tag" });
  });
  it("two codes in the name: their shared unit, no type", () => {
    const c = classifyWorkOrder({ owner: m("a", 'Modify 4" Piping from E-2 (5630.12) to V-2 (5610.15)'), book, projectUnits: ["56", "55"] });
    expect(c).toMatchObject({ unit: "56", unitFrom: "code" });
    expect(c.typeFrom).not.toBe("code");
  });
  it("confirmed values win", () => {
    const c = classifyWorkOrder({ owner: m("a", "E-27", { Equipment: "5630.06", [EQUIP_UNIT]: "55", [EQUIP_TYPE]: "28" }), book, projectUnits: [] });
    expect(c).toMatchObject({ unit: "55", unitFrom: "saved", type: "28", typeFrom: "saved" });
  });
  it("nothing to go on: no type, the project's main unit, said so", () => {
    const c = classifyWorkOrder({ owner: m("a", "Chem Cleaning"), book, projectUnits: ["56", "55"] });
    expect(c).toMatchObject({ unit: "56", unitFrom: "main", type: null });
    expect(classifyWorkOrder({ owner: m("a", "Chem Cleaning"), book, projectUnits: [] })).toMatchObject({ unit: null, type: null });
  });
});

describe("steps and filters", () => {
  const all = [m("w", "E-27 - Propane Condenser", { Equipment: "5630.06" }), m("s1", "Set Blinds", {}, "w"), m("w2", "Chem Cleaning")];
  const byId = new Map(all.map((x) => [x.id!, x]));
  const classes = classesFor([{ owner: all[0] }, { owner: all[2] }], all, book, ["56"]);
  it("a step takes its work order's class", () => {
    expect(classOfStep(all[1], byId, classes)).toMatchObject({ unit: "56", type: "30" });
  });
  it("filters by unit and type, with No type as a choice", () => {
    expect(classPasses(classes.get("w"), ["56"], ["30"])).toBe(true);
    expect(classPasses(classes.get("w"), [], ["10"])).toBe(false);
    expect(classPasses(classes.get("w2"), [], [NONE])).toBe(true);
  });
  it("lists the choices in use", () => {
    const ch = classChoices(classes.values(), book);
    expect(ch.types.map((t) => t.label)).toEqual(["Exchangers", "No type set"]);
    expect(ch.units[0].label).toBe("LPG Recovery Unit (LRU) (56)");
  });
});


describe("Setup matching with the site code", () => {
  const ms = [
    m("e27", "E-27 - Propane Condenser", { Equipment: "5630.06", "Work Order": "310337" }),
    m("mcc", "MCC #4 - LRU Switch House Cleaning", { Equipment: "6308.04", "Work Order": "308260" }),
  ];
  const registry = [{ id: "crude-e27", tag: "E-27", unitCode: "20" }];
  it("the Crude Unit's E-27 isn't the LRU's: added under the LRU, not flagged", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, registry, ["56"], book);
    const e27 = r.find((x) => x.ownerId === "e27")!;
    expect(e27).toMatchObject({ state: "not_in_registry", asset: null, otherUnit: false });
    expect(e27.cls).toMatchObject({ unit: "56", type: "30", unitFrom: "code" });
    expect(r.find((x) => x.ownerId === "mcc")!.cls).toMatchObject({ unit: "63", type: "08" });
    expect(undecided(r)).toHaveLength(2);
  });
  it("confirmed: nothing left", () => {
    const saved = ms.map((x) => ({ ...x, attributes: { ...x.attributes, equipment_none: true, [EQUIP_UNIT]: x.id === "e27" ? "56" : "63", [EQUIP_TYPE]: x.id === "e27" ? "30" : "08" } }));
    expect(undecided(matchWorkOrders(setupOrders(saved), saved, registry, ["56"], book))).toHaveLength(0);
  });
});

describe("the equipment ID decides, whatever name the registry lists it under", () => {
  const ms = [
    m("v7", "V-7 - Transmix Fractionator", { Equipment: "5510.19", "Work Order": "301235" }),
    m("pipe", "V-7 - Overhead and Bottoms Piping", { Equipment: "5510.19", "Work Order": "310989" }),
  ];
  const registry = [
    { id: "crude-v7", tag: "V-7", unitCode: "20", code: "2010.7" },
    { id: "kht-v7", tag: "V-7", unitCode: "30", code: "3010.03" },
    { id: "tmx-v5", tag: "V-5", unitCode: "55", code: "5510.09" },
    { id: "tmx-19", tag: "V-5", unitCode: "55", code: "5510.19" },
  ];
  it("5510.19 is found though the registry calls it V-5, and says so", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, registry, ["55"], book);
    for (const id of ["v7", "pipe"]) {
      expect(r.find((x) => x.ownerId === id)).toMatchObject({ tag: "V-7", state: "found", otherUnit: false, byId: true, listedAs: "V-5", asset: { id: "tmx-19" } });
    }
  });
  it("renamed in the registry: found, nothing more to say", () => {
    const fixed = registry.map((a) => (a.id === "tmx-19" ? { ...a, tag: "V-7" } : a));
    const v7 = matchWorkOrders(setupOrders(ms), ms, fixed, ["55"], book).find((x) => x.ownerId === "v7")!;
    expect(v7).toMatchObject({ state: "found", asset: { id: "tmx-19" } });
    expect(v7.listedAs).toBeUndefined();
  });
  it("no ID on the work order: the name looks for it, as before", () => {
    const bare = [m("v7", "V-7 - Transmix Fractionator", { "Work Order": "301235" })];
    const v7 = matchWorkOrders(setupOrders(bare), bare, registry, ["55"], book).find((x) => x.ownerId === "v7")!;
    expect(v7.byId).toBeUndefined();
    expect(v7.asset?.id).not.toBe("tmx-19");
  });
  it("linked by its ID under the work order's own name: still says how the registry lists it", () => {
    const saved = ms.map((x) => (x.id === "v7" ? { ...x, attributes: { ...x.attributes, equipment_tag: "V-7", equipment_asset_id: "tmx-19" } } : x));
    const v7 = matchWorkOrders(setupOrders(saved), saved, registry, ["55"], book).find((x) => x.ownerId === "v7")!;
    expect(v7).toMatchObject({ state: "linked", listedAs: "V-5", asset: { id: "tmx-19" } });
  });
});

describe("a work order whose name and equipment ID are two different pieces", () => {
  const registry = [
    { id: "h1", tag: "H-1", unitCode: "55", code: "5535.01" },
    { id: "h2", tag: "H-2", unitCode: "55", code: "5535.02" },
  ];
  const ms = [
    m("a", "Shutdown-Required Fire Eye Cleaning at H-1", { Equipment: "5535.01", "Work Order": "300823" }),
    m("b", "Shutdown-Required Fire Eye Cleaning at H-1", { Equipment: "5535.02", "Work Order": "300824" }),
  ];
  it("neither is taken: a person picks, and it stays to do", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, registry, ["55"], book);
    expect(r.find((x) => x.ownerId === "a")).toMatchObject({ state: "found", asset: { id: "h1" } });
    const b = r.find((x) => x.ownerId === "b")!;
    expect(b).toMatchObject({ state: "two_answers", asset: null, clash: { byId: { id: "h2" }, byName: { id: "h1" } } });
    expect(b.listedAs).toBeUndefined();
    expect(undecided(r).map((x) => x.ownerId)).toContain("b");
  });
  it("picked: linked, nothing more asked", () => {
    const saved = ms.map((x) => (x.id === "b" ? { ...x, attributes: { ...x.attributes, equipment_tag: "H-2", equipment_asset_id: "h2" } } : x));
    const b = matchWorkOrders(setupOrders(saved), saved, registry, ["55"], book).find((x) => x.ownerId === "b")!;
    expect(b).toMatchObject({ state: "linked", asset: { id: "h2" } });
    expect(b.clash).toBeUndefined();
  });
});

describe("a name kept with nothing to link it to, once the registry can answer", () => {
  const ms = [m("v7", "V-7 - Transmix Fractionator", { Equipment: "5510.19", "Work Order": "301235", equipment_tag: "V-7" })];
  it("nothing in the registry: decided, as before", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, [{ id: "crude-v7", tag: "V-7", unitCode: "20", code: "2010.7" }], ["55"], book);
    expect(r[0]).toMatchObject({ state: "linked", asset: null });
  });
  it("its ID is in the registry now: asked again, found by its ID", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, [{ id: "tmx-19", tag: "V-5", unitCode: "55", code: "5510.19" }], ["55"], book);
    expect(r[0]).toMatchObject({ state: "found", byId: true, listedAs: "V-5", asset: { id: "tmx-19" } });
    expect(undecided(r)).toHaveLength(1);
  });
});

describe("two pieces of one name in a unit", () => {
  const registry = [
    { id: "v5-wrong", tag: "V-5", unitCode: "55", code: "5510.19" },
    { id: "v5", tag: "V-5", unitCode: "55", code: "5510.09" },
  ];
  const ms = [m("s", "V-5 - Transmix Unit 2 Splitter", { Equipment: "5510.09", "Work Order": "310256" })];
  it("the ID says which: found, no question", () => {
    const r = matchWorkOrders(setupOrders(ms), ms, registry, ["55"], book);
    expect(r[0]).toMatchObject({ state: "found", byId: true, asset: { id: "v5" } });
    expect(r[0].clash).toBeUndefined();
    expect(r[0].listedAs).toBeUndefined();
  });
});
