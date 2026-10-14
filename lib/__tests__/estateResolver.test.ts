// The resolver is the part of the system that stops a file estate from
// rotting: every folder and file gets told which unit, project and
// equipment it belongs to, with a reason, and anything uncertain waits for
// a human. These tests pin the rules on names people actually use.

import { describe, it, expect } from "vitest";
import { resolveTarget, unitFromName, type ResolveContext } from "@/lib/estate/resolver";
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

describe("unit from a name", () => {
  it("reads a codebook unit from a folder name or its leading code", () => {
    expect(unitFromName("20 - Crude", ctx)?.code).toBe("20");
    expect(unitFromName("Crude Unit PIDs", ctx)?.code).toBe("20");
    expect(unitFromName("Unit 45", ctx)?.code).toBe("45");
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
    expect(edges[0].summary).toMatch(/names Crude Unit \(20\)/);
  });
  it("links an alias-named folder as strong, for review", () => {
    const edges = resolveTarget({ kind: "folder", id: "f2", name: "Born", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    const unit = edges.find((e) => e.type === "belongs_to_unit")!;
    expect(unit).toMatchObject({ b: "cbunit:20", tier: "strong" });
    expect(unit.summary).toMatch(/"born", which people use for Crude Unit/);
  });
  it("inherits the unit from a linked ancestor when its own name is silent", () => {
    const edges = resolveTarget({ kind: "folder", id: "f3", name: "Heaters", path: ["20 - Crude"], pathIds: ["f-crude"] }, ctx);
    expect(edges).toEqual([expect.objectContaining({ b: "cbunit:20", tier: "provable", summary: expect.stringMatching(/sits under a folder linked to Crude Unit/) })]);
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
