import { describe, it, expect } from "vitest";
import { buildEstateTree, categoryOf } from "@/lib/estateTree";

const N = (id: string, type: string, label: string, sub?: string) => ({ id, type, label, sub });
const E = (a: string, b: string, type: string) => ({ a, b, type });

describe("the estate as a tree", () => {
  it("nests area → equipment → drawings, with documents tied to the area beside the equipment", () => {
    const nodes = [
      N("cbunit:20", "unit", "Crude Unit"), N("unit:x", "unit", "Crude Unit", "20"),
      N("asset:v14", "asset", "V-14"), N("asset:p51", "asset", "P-51"),
      N("doc:s5", "document", "SHT05"), N("doc:spec", "document", "Crude spec"), N("doc:lost", "document", "Lost"),
      N("lib:eng", "library", "Engineering"), N("doc:lib", "document", "Library only"),
    ];
    const edges = [
      E("asset:v14", "cbunit:20", "unit"), E("asset:p51", "unit:x", "unit"),
      E("doc:s5", "asset:v14", "tag"), E("doc:s5", "asset:p51", "tag"),
      E("doc:spec", "cbunit:20", "unit"), E("doc:lib", "lib:eng", "library"),
    ];
    const t = buildEstateTree(nodes, edges);
    const parent = (id: string) => t.find((n) => n.id === id)?.parentId;
    expect(t.filter((n) => n.kind === "area").map((n) => n.id)).toEqual(["cbunit:20"]); // legacy unit merged by code
    expect(parent("asset:v14")).toBe("cbunit:20");
    expect(parent("asset:p51")).toBe("cbunit:20");
    expect(parent("doc:s5")).toBe("asset:v14");                 // one place: the first equipment
    expect(parent("doc:spec")).toBe("cbunit:20");
    expect(parent("doc:lost")).toBe("__unplaced__");
    expect(parent("doc:lib")).toBe("orphanlib:eng");
    expect(new Set(t.map((n) => n.id)).size).toBe(t.length);   // nothing twice
  });
  it("splits a large area by equipment type", () => {
    const assets = Array.from({ length: 12 }, (_, i) => N(`asset:${i}`, "asset", i < 7 ? `V-${i + 1}` : `P-${i + 1}`));
    const t = buildEstateTree([N("cbunit:20", "unit", "Crude"), ...assets], assets.map((a) => E(a.id, "cbunit:20", "unit")));
    const cats = t.filter((n) => n.kind === "category").map((n) => n.label);
    expect(cats).toEqual(["Vessels / Drums (7)", "Pumps (5)"]);
    expect(t.find((n) => n.id === "asset:0")?.parentId).toBe("cat:cbunit:20:Vessels / Drums");
  });
  it("names equipment types by the longest known prefix", () => {
    expect(categoryOf("PSV-21")).toBe("Relief valves (PSV)");
    expect(categoryOf("TK-101")).toBe("Tanks");
    expect(categoryOf("QQ-1")).toBe("Other equipment");
    // What the sheet calls it wins over the tag's letters: a crude heater
    // tagged F-2 sits with the H-1 heater, not with the filters.
    expect(categoryOf("H-1", "CRUDE HEATER")).toBe("Heaters / Furnaces");
    expect(categoryOf("F-2", "CRUDE HEATER")).toBe("Heaters / Furnaces");
    expect(categoryOf("H-1")).toBe("Heaters / Furnaces");
    expect(categoryOf("E-5", "CRUDE PREHEATER")).toBe("Exchangers");
    expect(categoryOf("P-3", "BOILER FEED PUMP")).toBe("Pumps");
    // A type a person set wins over both.
    expect(categoryOf("F-2", "CRUDE HEATER", "Fired heaters")).toBe("Fired heaters");
  });
});
