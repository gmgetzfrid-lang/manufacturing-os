import { describe, it, expect } from "vitest";
import { assetFolderName, planSync, planTree, syncCount, typeFolderName, typeKeyOf, unitFolderName, type FolderFact, type TreeAsset } from "@/lib/equipmentLibrary";

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

describe("kept in step with the registry and the site codebook", () => {
  const numbered = [{ id: "tx", name: "Exchangers", code: "30" }, { id: "tv", name: "Vessels", code: "10" }];
  const tree = { libraryId: "L", collectionId: null, units: { "20": "f20" }, types: { [typeKeyOf("20", "tx")]: "t1", [typeKeyOf("20", "tv")]: "t2" }, assets: { 1: "a1", 3: "a3" } };
  const facts = (m: Record<string, [string, string | null]>) => new Map<string, FolderFact>(Object.entries(m).map(([id, [name, parentId]]) => [id, { name, parentId }]));
  const now = facts({ f20: ["20 - Crude Unit", null], t1: ["Exchangers", "f20"], t2: ["Vessels", "f20"], a1: ["X-1 MIDDLE NAPHTHA COOLER (2030.01)", "t1"], a3: ["V-4 FRACTIONATOR TOWER (2010.04)", "t2"] });

  it("numbers type folders as the site encoding does", () => {
    expect(typeFolderName(numbered[0])).toBe("30 - Exchangers");
    expect(typeFolderName(undefined)).toBe("No type yet");
    const p = planSync({ units, types: numbered, assets: [assets[0], assets[2]], tree, folders: now });
    expect(p.rename).toEqual([{ id: "t1", from: "Exchangers", to: "30 - Exchangers" }, { id: "t2", from: "Vessels", to: "10 - Vessels" }]);
  });

  it("gives every unit in the codebook a folder, with equipment or not", () => {
    const p = planSync({ units, types: numbered, assets: [assets[0], assets[2]], tree, folders: now });
    expect(p.make.filter((f) => f.level === 1).map((f) => f.name)).toEqual(["30 - Kerosene Hydrotreater (KHT)", "42 - Solar"]);
    // Asked for only units with equipment: none made.
    expect(planSync({ units, types: numbered, assets: [assets[0], assets[2]], tree: { ...tree, allUnits: false }, folders: now }).make).toEqual([]);
  });

  it("new equipment gets its folder; a renamed piece's folder is renamed", () => {
    const renamed = { ...assets[0], description: "MIDDLE NAPHTHA TRIM COOLER" };
    const p = planSync({ units, types: numbered, assets: [renamed, assets[1], assets[2]], tree: { ...tree, allUnits: false }, folders: now });
    expect(p.make.map((f) => f.name)).toEqual(["X-2 VGO COOLER (2030.02)"]);
    expect(p.rename).toContainEqual({ id: "a1", from: "X-1 MIDDLE NAPHTHA COOLER (2030.01)", to: "X-1 MIDDLE NAPHTHA TRIM COOLER (2030.01)" });
  });

  it("equipment that gets its type (or moves unit) has its folder moved", () => {
    const untyped = { ...tree, types: { ...tree.types, [typeKeyOf("20", null)]: "tn" }, allUnits: false };
    const was = facts({ f20: ["20 - Crude Unit", null], t1: ["30 - Exchangers", "f20"], t2: ["10 - Vessels", "f20"], tn: ["No type yet", "f20"], a1: ["X-1 MIDDLE NAPHTHA COOLER (2030.01)", "tn"], a3: ["V-4 FRACTIONATOR TOWER (2010.04)", "t2"] });
    const p = planSync({ units, types: numbered, assets: [assets[0], assets[2]], tree: untyped, folders: was });
    expect(p.move).toEqual([{ id: "a1", assetId: "1", toTypeKey: typeKeyOf("20", "tx") }]);
    expect(p.rename).toEqual([]);
    // In step: nothing to do.
    const done = planSync({ units, types: numbered, assets: [assets[0], assets[2]], tree: { ...tree, allUnits: false }, folders: facts({ f20: ["20 - Crude Unit", null], t1: ["30 - Exchangers", "f20"], t2: ["10 - Vessels", "f20"], a1: ["X-1 MIDDLE NAPHTHA COOLER (2030.01)", "t1"], a3: ["V-4 FRACTIONATOR TOWER (2010.04)", "t2"] }) });
    expect(syncCount(done)).toBe(0);
  });
});
