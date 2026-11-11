// Linking work orders to a unit's equipment, and adding equipment without
// duplicates: the ID is one piece plant-wide, the name repeats unit to unit.

import { describe, it, expect } from "vitest";
import { nameKey, idKey, sameEquipmentId, scheduleId, idProblem, checkNew, unitEquipment, sameNameElsewhere, requestOf, requestValue, equipmentLabel, descriptionFrom, EQUIP_REQUEST, type PickAsset } from "@/lib/equipmentPick";
import type { Milestone } from "@/types/schema";

const reg: PickAsset[] = [
  { id: "c7", tag: "V-7", unitCode: "20", code: "2010.07" },
  { id: "c21", tag: "V-21", unitCode: "20", code: "2010.21" },
  { id: "x31", tag: "X-31 (2030.31)", unitCode: "20", code: null },
  { id: "t8", tag: "V-8", unitCode: "55", code: "5510.08" },
  { id: "t12", tag: "E-12", unitCode: "55", code: "5530.12" },
];

describe("one piece of equipment", () => {
  it("a name: V-7, v 7, V07 and V-07 are one; the ID written in a name is left off", () => {
    expect(new Set(["V-7", "v 7", "V07", "V-07"].map(nameKey)).size).toBe(1);
    expect(nameKey("X-31 (2030.31)")).toBe("x31");
    expect(nameKey("V-70")).not.toBe(nameKey("V-7"));
  });
  it("an ID: 2010.7 and 2010.07 are one; 2010.70 is another", () => {
    expect(idKey("2010.07")).toBe(idKey("2010.7"));
    expect(sameEquipmentId("2010.02B", "2010.2b")).toBe(true);
    expect(sameEquipmentId("2010.70", "2010.7")).toBe(false);
    expect(sameEquipmentId(null, "2010.7")).toBe(false);
  });
});

describe("the ID: the plant's own number, never worked out from the name", () => {
  it("from the work order's Equipment column (or a task above it)", () => {
    const wo = { id: "w", name: "V-7 - Transmix Fractionator", parentId: null, attributes: { Equipment: "5510.19", "Work Order": "301235" } } as unknown as Milestone;
    const step = { id: "s", name: "Open manways", parentId: "w", attributes: {} } as unknown as Milestone;
    const byId = new Map([["w", wo], ["s", step]]);
    expect(scheduleId(step, byId)).toBe("5510.19");
    expect(scheduleId({ id: "x", name: "E-12", parentId: null, attributes: { Equipment: "5535.02 (BMS)" } } as unknown as Milestone, new Map())).toBeNull();
  });
  it("an ID must be written as one and start with its unit", () => {
    expect(idProblem("", "55")).toBe("Enter its ID, as the plant numbers it.");
    expect(idProblem("55 10 19", "55")).toMatch(/^Write the ID as the plant does/);
    expect(idProblem("6415-126", "55")).toBe("6415-126 isn't on unit 55: it starts with 64. Put the project on that unit too, then add it there.");
    expect(idProblem("5510.19", "55")).toBeNull();
    expect(idProblem("5516-TV-110", "55")).toBeNull();
    expect(idProblem("7126.37B", "71")).toBeNull();
  });
});

describe("adding equipment without duplicates", () => {
  it("the same name on the same unit is pointed out (link it if it's that one), the ID decides", () => {
    expect(checkNew({ tag: "V-08", code: "5510.31", unitCode: "55" }, reg)).toEqual({ kind: "same_name", asset: reg[3] });
    // Its own ID: the one already there.
    expect(checkNew({ tag: "V-08", code: "5510.08", unitCode: "55" }, reg)).toEqual({ kind: "same_id", asset: reg[3] });
  });
  it("the same name on another unit is another piece: it can be added", () => {
    expect(checkNew({ tag: "V-7", code: "5510.07", unitCode: "55" }, reg)).toEqual({ kind: "ok" });
  });
  it("an ID already used is refused, written either way", () => {
    expect(checkNew({ tag: "V-9", code: "5530.12", unitCode: "55" }, reg)).toEqual({ kind: "same_id", asset: reg[4] });
    expect(checkNew({ tag: "V-9", code: "5510.8", unitCode: "55" }, reg)).toEqual({ kind: "same_id", asset: reg[3] });
  });
  it("a bad ID or no name is said", () => {
    expect(checkNew({ tag: "V-9", code: "2010.09", unitCode: "55" }, reg).kind).toBe("bad_id");
    expect(checkNew({ tag: "V-9", code: "", unitCode: "55" }, reg).kind).toBe("bad_id");
    expect(checkNew({ tag: "  ", code: "5510.09", unitCode: "55" }, reg).kind).toBe("no_name");
  });
});

describe("picking from the unit", () => {
  it("only the project's unit; by name, ID or typed loosely", () => {
    expect(unitEquipment(reg, ["55"], "").map((a) => a.id)).toEqual(["t12", "t8"]);
    expect(unitEquipment(reg, ["55"], "v8").map((a) => a.id)).toEqual(["t8"]);
    expect(unitEquipment(reg, ["55"], "5530.12").map((a) => a.id)).toEqual(["t12"]);
    expect(unitEquipment(reg, ["55"], "V-7")).toEqual([]);
  });
  it("the same name on another unit is said, never offered", () => {
    expect(sameNameElsewhere("V-07", reg, ["55"]).map((a) => a.id)).toEqual(["c7"]);
    expect(sameNameElsewhere("V-8", reg, ["55"])).toEqual([]);
  });
});

describe("an ask kept on the work order", () => {
  it("reads back what was asked, by whom", () => {
    const m = { attributes: { [EQUIP_REQUEST]: requestValue({ tag: "V-9 ", unit: "55", by: "u1", byName: "Gabe", at: "2026-11-09T14:00:00Z" }) } };
    expect(requestOf(m)).toEqual({ tag: "V-9", unit: "55", by: "u1", byName: "Gabe", at: "2026-11-09T14:00:00Z" });
    expect(requestOf({ attributes: {} })).toBeNull();
    expect(requestOf({ attributes: { [EQUIP_REQUEST]: "{\"tag\":\"\"}" } })).toBeNull();
    expect(requestOf({ attributes: { [EQUIP_REQUEST]: "not json" } })).toBeNull();
  });
});

describe("how equipment is written", () => {
  it("name, (ID), what it is", () => {
    expect(equipmentLabel({ tag: "E-26", code: "5530.19", description: "Debutanizer Trim Cooler" })).toBe("E-26 (5530.19) Debutanizer Trim Cooler");
    expect(equipmentLabel({ tag: "V-7", code: null, description: null })).toBe("V-7");
    // An ID written into the name the old way still shows once.
    expect(equipmentLabel({ tag: "X-31 (2030.31)", code: null, description: "Overhead Condenser" })).toBe("X-31 (2030.31) Overhead Condenser");
  });
  it("what it is, from the work order's name", () => {
    expect(descriptionFrom("V-7 - Transmix Fractionator", "V-7")).toBe("Transmix Fractionator");
    expect(descriptionFrom("E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", "E-12")).toBe("Transmix Feed/Trans. Diesel Exchanger No. 2");
    expect(descriptionFrom("V-07 Transmix Fractionator", "V-7")).toBe("Transmix Fractionator");
    expect(descriptionFrom("Clean fuel gas supply header to H-1", "H-1")).toBe("");
    expect(descriptionFrom("V-8 - Transmix Reflux Drum", "V-7")).toBe("");
  });
  it("found by what it is, too", () => {
    const r: PickAsset[] = [{ id: "a", tag: "E-26", unitCode: "55", code: "5530.19", description: "Debutanizer Trim Cooler" }];
    expect(unitEquipment(r, ["55"], "trim cooler").map((a) => a.id)).toEqual(["a"]);
  });
});

describe("linked equipment on a work order that calls it by another name", () => {
  it("same name: the registry's label", async () => {
    const { linkedLabel } = await import("@/lib/equipmentPick");
    expect(linkedLabel({ tag: "V-7", code: "5510.19", description: "Transmix Fractionator" }, "V-7")).toBe("V-7 (5510.19) Transmix Fractionator");
    expect(linkedLabel({ tag: "V-7", code: "5510.19", description: null }, null)).toBe("V-7 (5510.19)");
  });
  it("another name: the work order's name, the ID, and how the list has it", async () => {
    const { linkedLabel } = await import("@/lib/equipmentPick");
    expect(linkedLabel({ tag: "V-5", code: "5510.19", description: "TRANSMIX UNIT 2 SPLITTER" }, "V-7")).toBe("V-7 (5510.19) · listed as V-5");
  });
});
