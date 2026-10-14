import { describe, it, expect } from "vitest";
import { equipmentFromFolderName, planStructure } from "@/lib/estate/folderMarks";

describe("folder marks", () => {
  it("reads an equipment tag and name out of a folder name", () => {
    expect(equipmentFromFolderName("H-1 Crude Heater")).toEqual({ tag: "H-1", name: "Crude Heater" });
    expect(equipmentFromFolderName("H-1 - Crude heater")).toEqual({ tag: "H-1", name: "Crude heater" });
    expect(equipmentFromFolderName("P101A")).toEqual({ tag: "P-101A", name: null });
    expect(equipmentFromFolderName("Crude Heater (H-2)")).toEqual({ tag: "H-2", name: "Crude Heater" });
    expect(equipmentFromFolderName("Unit 20")).toBeNull();
    expect(equipmentFromFolderName("Rev1")).toBeNull();
    expect(equipmentFromFolderName("Heaters")).toBeNull();
  });

  it("plans an area / type / equipment library level by level", () => {
    const folders = [
      { id: "a", parentId: null, name: "20 - Crude" },
      { id: "b", parentId: "a", name: "Heaters" },
      { id: "c", parentId: "b", name: "H-1 Crude Heater" },
      { id: "d", parentId: "b", name: "H-2 Crude Heater" },
      { id: "e", parentId: null, name: "Misc" },
      { id: "f", parentId: "c", name: "Inspections" },
    ];
    const rows = planStructure(folders, ["area", "type", "equipment"], {
      unit: (n) => (n.includes("Crude") ? { code: "20", label: "Crude Unit" } : null),
      asset: (t) => (t === "H-1" ? { id: "asset-h1" } : null),
    });
    const by = new Map(rows.map((r) => [r.folderId, r]));
    expect(by.get("a")).toMatchObject({ kind: "area", ref: "20", status: "match" });
    expect(by.get("e")).toMatchObject({ kind: "area", status: "unmatched" });
    expect(by.get("b")).toMatchObject({ kind: "type", value: "Heaters" });
    expect(by.get("c")).toMatchObject({ kind: "equipment", value: "H-1 · Crude Heater", ref: "asset-h1", status: "match" });
    expect(by.get("d")).toMatchObject({ kind: "equipment", status: "new" });
    // Deeper than the levels given: left alone (documents' own folders).
    expect(by.has("f")).toBe(false);
  });
});
