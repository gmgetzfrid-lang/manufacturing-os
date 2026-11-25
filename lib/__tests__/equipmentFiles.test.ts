import { describe, it, expect } from "vitest";
import { assetWords, numberFromName, suggestLibrary } from "@/lib/equipmentFiles";

describe("filing a work package's files to its equipment", () => {
  it("names a file's document from its file name", () => {
    expect(numberFromName("X-1_bundle__pull drawing.pdf")).toBe("X-1 bundle pull drawing");
    expect(numberFromName("2030.01 Nameplate.JPG")).toBe("2030.01 Nameplate");
  });
  it("suggests the library for equipment files: one named for equipment, else drawings", () => {
    const libs = [{ id: "p", name: "Procedures" }, { id: "d", name: "Drawings" }, { id: "s", name: "Site Standards" }];
    expect(suggestLibrary(libs)?.id).toBe("d");
    expect(suggestLibrary([...libs, { id: "e", name: "Equipment Files" }])?.id).toBe("e");
    expect(suggestLibrary([{ id: "p", name: "Procedures" }])).toBeNull();
  });
  it("says the equipment the way the work order list does", () => {
    expect(assetWords({ id: "a", tag: "X-1", code: "2030.01", unitCode: "20", description: "MIDDLE NAPHTHA COOLER" })).toBe("X-1 Middle Naphtha Cooler (2030.01)");
    expect(assetWords({ id: "a", tag: "V-4", code: null, unitCode: null, description: null })).toBe("V-4");
  });
});
