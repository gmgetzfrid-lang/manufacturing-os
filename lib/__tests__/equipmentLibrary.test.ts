import { describe, it, expect } from "vitest";
import { assetFolderName, planTree, typeKeyOf, unitFolderName, type TreeAsset } from "@/lib/equipmentLibrary";

const units = [{ code: "20", label: "Crude Unit" }, { code: "30", label: "Kerosene Hydrotreater (KHT)" }, { code: "42", label: "Solar" }];
const types = [{ id: "tx", name: "Exchangers" }, { id: "tv", name: "Vessels" }];
const a = (id: string, tag: string, code: string, unitCode: string | null, typeId: string | null, description: string): TreeAsset => ({ id, tag, code, unitCode, typeId, description });
const assets = [
  a("1", "X-1", "2030.01", "20", "tx", "MIDDLE NAPHTHA COOLER"),
  a("2", "X-2", "2030.02", "20", "tx", "VGO COOLER"),
  a("3", "V-4", "2010.04", "20", "tv", "FRACTIONATOR TOWER"),
  a("4", "E-7", "3030.07", "30", "tx", "Feed/Effluent Exchanger"),
  a("5", "X-2", "2030.02", "20", "tx", "VGO COOLER"),       // a second copy of X-2 in the registry
  a("6", "P-9", "9999.09", null, null, "Spare pump"),
];

describe("the Equipment Files library, laid out like the operating areas", () => {
  it("names folders the way Operating areas shows them", () => {
    expect(unitFolderName(units[0])).toBe("20 - Crude Unit");
    expect(assetFolderName(assets[0])).toBe("X-1 MIDDLE NAPHTHA COOLER (2030.01)");
    expect(assetFolderName(assets[3])).toBe("E-7 Feed/Effluent Exchanger (3030.07)".replace("/", "-"));
  });

  it("nests unit › type › each piece of equipment, only units with equipment unless asked", () => {
    const p = planTree({ units, types, assets, equipmentFolders: true });
    const names = (level: number) => p.folders.filter((f) => f.level === level).map((f) => f.name);
    expect(names(1)).toEqual(["20 - Crude Unit", "30 - Kerosene Hydrotreater (KHT)", "No operating area"]);
    expect(names(2)).toEqual(["Exchangers", "Vessels", "Exchangers", "No type yet"]);
    expect(names(3)).toContain("X-1 MIDDLE NAPHTHA COOLER (2030.01)");
    // Two registry copies of X-2 share one folder.
    const x2 = p.folders.find((f) => f.name === "X-2 VGO COOLER (2030.02)")!;
    expect(x2.assetIds).toEqual(["2", "5"]);
    expect(p.counts).toEqual({ units: 3, types: 4, equipment: 5 });
    expect(p.example).toEqual(["20 - Crude Unit", "Exchangers", "X-1 MIDDLE NAPHTHA COOLER (2030.01)"]);
    expect(planTree({ units, types, assets, allUnits: true }).counts.units).toBe(4);   // Solar too
    expect(planTree({ units, types, assets, equipmentFolders: false }).counts.equipment).toBe(0);
  });

  it("pushed again, makes only what's new", () => {
    const existing = { libraryId: "L", collectionId: null, units: { "20": "f20", "30": "f30", __none: "fn" }, types: { [typeKeyOf("20", "tx")]: "t1", [typeKeyOf("20", "tv")]: "t2", [typeKeyOf("30", "tx")]: "t3", [typeKeyOf("__none", null)]: "t4" }, assets: { 1: "a1", 2: "a2", 3: "a3", 4: "a4", 5: "a2", 6: "a6" } };
    expect(planTree({ units, types, assets, existing, equipmentFolders: true }).folders).toEqual([]);
    const more = [...assets, a("7", "X-9", "2030.09", "20", "tx", "NEW COOLER"), a("8", "V-1", "4210.01", "42", "tv", "SOLAR TANK")];
    const p = planTree({ units, types, assets: more, existing, equipmentFolders: true });
    expect(p.folders.map((f) => `${f.level}:${f.name}`)).toEqual(["3:X-9 NEW COOLER (2030.09)", "1:42 - Solar", "2:Vessels", "3:V-1 SOLAR TANK (4210.01)"]);
  });
});
