// The Documents home map shows the libraries and the top folders in each,
// named as in the lists, and a click opens the one clicked.

import { describe, it, expect } from "vitest";
import { buildLibrariesMap, libraryMapTarget, LIBS_ROOT } from "@/lib/libraryMap";

const libs = [
  { id: "L1", name: "Drawings", folders: [{ id: "f2", name: "PFD's" }, { id: "f1", name: "P&ID's" }] },
  { id: "L2", name: "Procedures", folders: [] },
];

describe("the libraries map", () => {
  const m = buildLibrariesMap(libs);
  const kids = (id: string) => m.tree.filter((n) => n.parentId === id).map((n) => n.label);

  it("has one root, the libraries under it, named as in the list", () => {
    expect(m.tree.filter((n) => !n.parentId).map((n) => n.id)).toEqual([LIBS_ROOT]);
    expect(kids(LIBS_ROOT)).toEqual(["Drawings", "Procedures"]);
  });
  it("puts each library's top folders under it, in name order", () => {
    expect(kids("lib:L1")).toEqual(["P&ID's", "PFD's"]);
    expect(kids("lib:L2")).toEqual([]);
  });
  it("opens a library, or a folder in its own library", () => {
    expect(libraryMapTarget(m, "lib:L2")).toEqual({ libraryId: "L2", folderId: null });
    expect(libraryMapTarget(m, "folder:f1")).toEqual({ libraryId: "L1", folderId: "f1" });
    expect(libraryMapTarget(m, "folder:nope")).toBeNull();
    expect(libraryMapTarget(m, LIBS_ROOT)).toBeNull();
  });
});
