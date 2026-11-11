// The map of a folder shows that folder: its subfolders, its files, and
// under each file the equipment on it. Nothing from anywhere else.

import { describe, it, expect } from "vitest";
import { buildFolderMap, folderDocLabels, equipOnDocId, RUN, type FolderMapDoc } from "@/lib/folderMap";
import { docHref } from "@/lib/findCore";

const sheet = (n: number, number = "5502-D 2000"): FolderMapDoc => ({ id: `d${n}`, number, title: number, name: `${number}_SHT0${n}_R1.pdf`, sheet: `0${n}`, href: "" });

describe("a unit's P&ID folder", () => {
  const docs = [sheet(3), sheet(4), sheet(7)];
  const onDoc = new Map([
    ["d3", [{ id: "h1", tag: "H-1" }]],
    ["d4", [{ id: "e13", tag: "E-13" }, { id: "e14", tag: "E-14" }]],
    ["d7", [{ id: "b1", tag: "B-1" }, { id: "h2", tag: "H-2" }, { id: "e13", tag: "E-13" }]],
  ]);
  const m = buildFolderMap({ folder: { id: "f55", name: "55 - Transmix" }, subfolders: [], docs, onDoc });
  const kids = (id: string) => m.tree.filter((n) => n.parentId === id);

  it("the folder is the root, its files hang off it", () => {
    expect(m.tree.filter((n) => !n.parentId).map((n) => n.label)).toEqual(["55 - Transmix"]);
    expect(kids(m.rootId).map((n) => [n.kind, n.label])).toEqual([["document", "5502-D 2000 · Sh 3"], ["document", "5502-D 2000 · Sh 4"], ["document", "5502-D 2000 · Sh 7"]]);
  });
  it("the equipment on each file hangs off that file", () => {
    expect(kids("doc:d4").map((n) => n.label)).toEqual(["E-13", "E-14"]);
    expect(kids("doc:d7").map((n) => n.label)).toEqual(["B-1", "E-13", "H-2"]);
  });
  it("equipment on two sheets is under both, and is one piece of equipment", () => {
    const a = m.tree.find((n) => n.id === equipOnDocId("e13", "d4"))!, b = m.tree.find((n) => n.id === equipOnDocId("e13", "d7"))!;
    expect(a.graphId).toBe("asset:e13");
    expect(b.graphId).toBe("asset:e13");
    expect(m.nodes.filter((n) => n.id === "asset:e13")).toHaveLength(1);
  });
  it("the file's name is kept for its icon", () => {
    expect(m.fileNames["doc:d3"]).toBe("5502-D 2000_SHT03_R1.pdf");
  });
});

describe("what a file is called", () => {
  it("its number; the sheet only when the number repeats here", () => {
    const l = folderDocLabels([sheet(1), sheet(2), { id: "p", number: "5503-D 1000", title: "PFD Book", name: "x.pdf", sheet: null, href: "" }, { id: "n", number: null, title: "Vendor manual", name: "m.pdf", sheet: null, href: "" }]);
    expect([...l.values()]).toEqual(["5502-D 2000 · Sh 1", "5502-D 2000 · Sh 2", "5503-D 1000", "Vendor manual"]);
  });
});

describe("other folders", () => {
  it("subfolders first, by name; an empty folder is just itself", () => {
    const m = buildFolderMap({ folder: { id: null, name: "Drawings" }, subfolders: [{ id: "b", name: "PFD's", count: 2 }, { id: "a", name: "P&ID's", count: 58 }], docs: [] });
    expect(m.rootId).toBe("folder:top");
    expect(m.tree.slice(1).map((n) => [n.kind, n.label])).toEqual([["folder", "P&ID's (58)"], ["folder", "PFD's (2)"]]);
    expect(buildFolderMap({ folder: { id: "x", name: "Empty" }, subfolders: [], docs: [] }).tree).toHaveLength(1);
  });
  it("a big folder's files are put in runs, every file still there", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `d${i}`, number: `EP 5-${i + 1}`, title: null, name: null, sheet: null, href: "" }));
    const m = buildFolderMap({ folder: { id: "f", name: "Procedures" }, subfolders: [], docs: many });
    const runs = m.tree.filter((n) => n.parentId === m.rootId);
    expect(runs.map((r) => r.kind)).toEqual(["group", "group", "group"]);
    expect(runs[0].label).toBe(`EP 5-1 to EP 5-${RUN} (${RUN})`);
    expect(m.tree.filter((n) => n.kind === "document")).toHaveLength(100);
  });
  it("a short list says how many are not shown", () => {
    const m = buildFolderMap({ folder: { id: "f", name: "F" }, subfolders: [], docs: [sheet(1)], more: 140 });
    expect(m.tree[m.tree.length - 1].label).toBe("140 more not shown here");
  });
});

describe("a link to a document", () => {
  it("opens its folder with it picked, not the top of the library", () => {
    expect(docHref({ id: "d1", libraryId: "L", folderId: "F" })).toBe("/documents/L?folderId=F&doc=d1");
    expect(docHref({ id: "d1", libraryId: "L", folderId: null }, true)).toBe("/documents/L?doc=d1&fs=1");
  });
});
