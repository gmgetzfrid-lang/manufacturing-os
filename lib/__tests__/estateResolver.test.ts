// The resolver is the part of the system that stops a file estate from
// rotting: every folder and file gets told which unit, project and
// equipment it belongs to, with a reason, and anything uncertain waits for
// a human. These tests pin the rules on names people actually use.

import { describe, it, expect } from "vitest";
import { resolveTarget, unitFromName, unitHintFromName, type ResolveContext } from "@/lib/estate/resolver";
import type { FinderAlias } from "@/lib/fileFinder/aliasTypes";

const born: FinderAlias = { id: "al1", orgId: "o", term: "born", termCanonical: "BORN", means: "crude", meansCanonical: "CRUDE", kind: "unit", origin: "human", hits: 0, misses: 0, note: null, createdByName: null, createdAt: "" };

const ctx: ResolveContext = {
  units: [{ code: "20", label: "Crude Unit" }, { code: "45", label: "Transmix" }],
  aliases: [born],
  projects: [{ id: "p1", name: "AFE200155 Crude heater retube" }],
  assets: new Map([["U1A", { id: "a-u1a", tag: "U1-A" }], ["X35", { id: "a-x35", tag: "X-35" }]]),
  unitFromDrawingNumber: (raw) => (/^2002-/.test(raw) ? "20" : null),
  folderUnits: new Map([["f-crude", "20"]]),
  folderProjects: new Map(),
};

// The site's own unit names, as they are in its codebook.
const site: ResolveContext = {
  ...ctx,
  units: [
    { code: "10", label: "Engineering" }, { code: "20", label: "Crude Unit" }, { code: "25", label: "Diesel Hydrotreater Unit (DHT)" },
    { code: "30", label: "Kerosene Hydrotreater (KHT)" }, { code: "31", label: "Naptha Hydrotreater Unit (NHT)" },
    { code: "46", label: "Sour Water Stripper (Sulfur Plant)" }, { code: "47", label: "Amine Unit (Sulfur Plant)" },
    { code: "50", label: "Re-Run Unit (O.O.S.)" }, { code: "55", label: "Transmix Unit (Old Solvent Unit)" }, { code: "56", label: "LPG Recovery Unit (LRU)" },
    { code: "57", label: "S.W.S. No. 1" }, { code: "60", label: "Water (Utility)" }, { code: "65", label: "Sewer (Utility)" },
    { code: "71", label: "Transfer" }, { code: "72", label: "Storage" }, { code: "80", label: "Main Office" }, { code: "81", label: "General Plant" },
  ],
  aliases: [],
};

describe("unit from a name", () => {
  it("is proven when the unit's code leads the name and the name says the unit", () => {
    expect(unitFromName("20 - Crude", ctx)).toMatchObject({ code: "20", proof: "code+name" });
    expect(unitFromName("Unit 45", ctx)).toMatchObject({ code: "45", proof: "code+name" });
    expect(unitFromName("56 - LRU", site)).toMatchObject({ code: "56", proof: "code+name" });
    expect(unitFromName("30 - KHT", site)).toMatchObject({ code: "30", proof: "code+name" });
    expect(unitFromName("55 - Transmix", site)).toMatchObject({ code: "55", proof: "code+name" });
  });
  it("is a proposal when the name says the unit with no code", () => {
    expect(unitFromName("Crude Unit PIDs", ctx)).toMatchObject({ code: "20", proof: "name" });
    expect(unitFromName("Section 9 - Storage Tanks", site)).toMatchObject({ code: "72", proof: "name" });
    expect(unitFromName("Sewer Systems", site)).toMatchObject({ code: "65", proof: "name" });
  });
  it("one shared word proves nothing (the wrong links this site had)", () => {
    // "No" is the only word in "S.W.S. No. 1"; "Main" is in "Main Office";
    // "Run" is in "Re-Run Unit"; "Transfer" is a unit, "Heat Transfer" is not.
    expect(unitFromName("LED Stanchion Light Handrail Mount with No Post", site)).toBeNull();
    expect(unitFromName("Bend Parallel to Main Line", site)).toBeNull();
    expect(unitFromName("Pipe Guide for Insulated Vertical Run Pipe", site)).toBeNull();
    expect(unitFromName("8 - Heat Transfer Equipment", site)).toBeNull();
  });
  it("a leading number on its own is a section number, not a unit", () => {
    expect(unitFromName("10 - Material Requirements", site)).toBeNull();
    expect(unitFromName("20_PIDs", ctx)).toBeNull();
  });
  it("a name in brackets shared by several units names none of them", () => {
    expect(unitFromName("Utility", site)).toBeNull();
    expect(unitFromName("Sulfur Plant", site)).toBeNull();
  });
  it("the looser hint, for suggestions only, takes one telling word", () => {
    expect(unitHintFromName("Crude heater job", ctx)).toBe("20");
    expect(unitHintFromName("Bend Parallel to Main Line", site)).toBeNull();
    expect(unitHintFromName("Hydrotreater notes", site)).toBeNull(); // three units are hydrotreaters
  });
  it("reads a taught alias as a unit, marked as such", () => {
    const r = unitFromName("Born", ctx);
    expect(r).toMatchObject({ code: "20", via: "alias" });
  });
  it("says nothing for a name that names nothing", () => {
    expect(unitFromName("Dave's stuff", ctx)).toBeNull();
  });
});

describe("resolving a folder", () => {
  it("links '20 - Crude' to its unit, provably", () => {
    const edges = resolveTarget({ kind: "folder", id: "f1", name: "20 - Crude", path: [], pathIds: [] }, ctx);
    expect(edges).toEqual([expect.objectContaining({ a: "folder:f1", b: "cbunit:20", type: "belongs_to_unit", tier: "provable", origin: "codebook" })]);
    expect(edges[0].summary).toMatch(/leads with 20 and names Crude Unit/);
  });
  it("links an alias-named folder as strong, for review", () => {
    const edges = resolveTarget({ kind: "folder", id: "f2", name: "Born", path: [], pathIds: [] }, ctx);
    const unit = edges.find((e) => e.type === "belongs_to_unit")!;
    expect(unit).toMatchObject({ b: "cbunit:20", tier: "strong" });
    expect(unit.summary).toMatch(/"born", which people use for Crude Unit/);
  });
  it("a folder under a linked folder takes that link, whatever nickname it carries", () => {
    const edges = resolveTarget({ kind: "folder", id: "f2", name: "Born", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(edges.filter((e) => e.type === "belongs_to_unit")).toEqual([expect.objectContaining({ b: "cbunit:20", tier: "provable" })]);
  });
  it("a name that says a unit with no code waits for a person", () => {
    const edges = resolveTarget({ kind: "folder", id: "f7", name: "Section 9 - Storage Tanks", path: ["Site Standards"], pathIds: ["ss"] }, site);
    expect(edges).toEqual([expect.objectContaining({ b: "cbunit:72", type: "belongs_to_unit", tier: "strong", origin: "resolver" })]);
    expect(edges[0].summary).toMatch(/belong to that unit, or apply to it/);
  });
  it("a title sharing a word with a unit links nothing", () => {
    const edges = resolveTarget({ kind: "document", id: "d9", name: "Pipe Guide for Insulated Vertical Run Pipe.pdf", path: ["Site Standards", "Section 5 - Piping"], pathIds: ["ss", "s5"] }, site);
    expect(edges.filter((e) => e.type === "belongs_to_unit")).toEqual([]);
  });
  it("inherits the unit from a linked ancestor when its own name is silent", () => {
    const edges = resolveTarget({ kind: "folder", id: "f3", name: "Heaters", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(edges.filter((e) => e.type === "belongs_to_unit")).toEqual([expect.objectContaining({ b: "cbunit:20", tier: "provable", summary: expect.stringMatching(/sits under a folder linked to Crude Unit/) })]);
  });
  it("flags a folder that names one unit but is filed under another", () => {
    const edges = resolveTarget({ kind: "folder", id: "f4", name: "Transmix pumps", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(edges.map((e) => e.summary)).toEqual(expect.arrayContaining([expect.stringMatching(/names Transmix but is filed under Crude Unit/)]));
  });
  it("links an AFE folder to its project and the project to the unit", () => {
    const edges = resolveTarget({ kind: "folder", id: "f5", name: "AFE200155 heater", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ a: "folder:f5", b: "proj:p1", type: "in_project", tier: "strong" }),
      expect.objectContaining({ a: "proj:p1", b: "cbunit:20", type: "project_scope", tier: "strong" }),
    ]));
  });
  it("recognises an equipment folder named for a tag", () => {
    const edges = resolveTarget({ kind: "folder", id: "f6", name: "X-35", path: ["Equipment", "20 - Crude", "Exchangers"], pathIds: ["e", "f-crude", "x"] }, ctx);
    expect(edges).toEqual(expect.arrayContaining([expect.objectContaining({ type: "about_asset", b: "asset:a-x35", tier: "strong" })]));
  });
});

describe("resolving a document", () => {
  it("decodes a drawing number to its unit, provably, and tags the equipment read on its pages", () => {
    const edges = resolveTarget({ kind: "document", id: "d1", name: "2002-D-2001_SHT05.pdf", path: ["Drawings"], pathIds: ["dr"], documentNumber: "2002-D-2001", pageTags: ["X-35", "U1A"], versionId: "v1" }, ctx);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ b: "cbunit:20", type: "belongs_to_unit", tier: "provable", origin: "codebook", versionId: "v1" }),
      expect.objectContaining({ b: "asset:a-x35", type: "tagged_to", origin: "vision", tier: "provable" }),
      expect.objectContaining({ b: "asset:a-u1a", type: "tagged_to", origin: "vision" }),
    ]));
  });
  it("tags a file by the code in its name and by the equipment folder it sits in", () => {
    const edges = resolveTarget({ kind: "document", id: "d2", name: "born-u1a datasheet.pdf", path: ["Equipment", "X-35"], pathIds: ["e", "fx"] }, ctx);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ b: "asset:a-u1a", type: "tagged_to", tier: "strong", evidence: expect.objectContaining({ where: "name" }) }),
      expect.objectContaining({ b: "asset:a-x35", type: "tagged_to", tier: "strong", evidence: expect.objectContaining({ where: "folder" }) }),
      expect.objectContaining({ b: "cbunit:20", type: "belongs_to_unit", tier: "strong" }),
    ]));
  });
  it("proposes nothing for a file that says nothing", () => {
    expect(resolveTarget({ kind: "document", id: "d3", name: "scan0001.pdf", path: ["Dave's stuff"], pathIds: ["dv"] }, ctx)).toEqual([]);
  });
});

describe("alias proposals", () => {
  it("proposes a nickname when a plain-named folder sits under a unit", () => {
    const edges = resolveTarget({ kind: "folder", id: "f7", name: "Born", path: ["20 - Crude"], pathIds: ["f-crude"] }, { ...ctx, aliases: [] });
    expect(edges).toEqual(expect.arrayContaining([expect.objectContaining({ a: "term:BORN", b: "cbunit:20", type: "alias_of", tier: "inferred" })]));
  });
  it("does not propose an alias that is already taught, nor for type or unit words", () => {
    const taught = resolveTarget({ kind: "folder", id: "f7", name: "Born", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(taught.some((e) => e.type === "alias_of")).toBe(false);
    const pids = resolveTarget({ kind: "folder", id: "f8", name: "PIDs", path: ["20 - Crude"], pathIds: ["f-crude"] }, { ...ctx, aliases: [] });
    expect(pids.some((e) => e.type === "alias_of")).toBe(false);
  });
});
