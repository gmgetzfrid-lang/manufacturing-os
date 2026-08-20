import { describe, it, expect } from "vitest";
import { assembleFlowsBrowse, type FlowsBrowseInputs } from "@/lib/flowsBrowse";

// The picker's promise: the hierarchy the user actually filed things into
// (DC library / folder), with nothing silently hidden — and a named answer
// when a folder ISN'T there ("never linked", not "lost").

const base = (): FlowsBrowseInputs => ({
  knowledgeLibraries: [{ id: "kl1", name: "Refinery Reference" }],
  knowledgeDocs: [],
  sources: [],
  dcLibraryNames: new Map([["dl1", "North Library"]]),
  dcFolders: new Map([
    ["fA", { name: "PFDs", libraryId: "dl1", parentId: null, pathNames: ["PFDs"] }],
    ["fA1", { name: "Unit 20", libraryId: "dl1", parentId: "fA", pathNames: ["PFDs", "Unit 20"] }],
    ["fB", { name: "P&IDs", libraryId: "dl1", parentId: null, pathNames: ["P&IDs"] }],
  ]),
  dcDocContainers: new Map(),
  dcCountableDocs: [],
});

describe("assembleFlowsBrowse", () => {
  it("groups docs under their DC library / folder path, uploads last", () => {
    const inputs = base();
    inputs.knowledgeDocs = [
      { id: "k1", name: "PFD Book", libraryId: "kl1", pageCount: 12, status: "ready", sourceDocumentId: "d1" },
      { id: "k2", name: "Direct upload", libraryId: "kl1", pageCount: 2, status: "ready", sourceDocumentId: null },
      { id: "k3", name: "Root doc", libraryId: "kl1", pageCount: 1, status: "ready", sourceDocumentId: "d2" },
    ];
    inputs.dcDocContainers = new Map([
      ["d1", { libraryId: "dl1", collectionId: "fA1" }],
      ["d2", { libraryId: "dl1", collectionId: null }],
    ]);
    const [lib] = assembleFlowsBrowse(inputs);
    expect(lib.docCount).toBe(3);
    expect(lib.groups.map((g) => g.label)).toEqual([
      "North Library / (library root)",
      "North Library / PFDs / Unit 20",
      "Uploaded directly",
    ]);
  });

  it("names folders a folder-scoped source leaves uncovered — the missing folder is explained, not lost", () => {
    const inputs = base();
    // The knowledge library watches only the PFDs folder…
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    // …but the DC library also holds P&IDs and root-level docs.
    inputs.dcCountableDocs = [
      { libraryId: "dl1", collectionId: "fB" },
      { libraryId: "dl1", collectionId: "fB" },
      { libraryId: "dl1", collectionId: null },
      { libraryId: "dl1", collectionId: "fA1" }, // inside watched subtree → covered
    ];
    const [lib] = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([
      { label: "North Library / P&IDs", docCount: 2 },
      { label: "North Library / (library root)", docCount: 1 },
    ]);
  });

  it("reports nothing missing when a whole DC library is the source", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.dcCountableDocs = [
      { libraryId: "dl1", collectionId: "fB" },
      { libraryId: "dl1", collectionId: null },
    ];
    const [lib] = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([]);
  });

  it("subtree coverage: watching a parent folder covers its children", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcCountableDocs = [{ libraryId: "dl1", collectionId: "fA1" }];
    const [lib] = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([]);
  });

  it("never flags DC libraries no source touches — an unrelated library is not 'missing'", () => {
    const inputs = base();
    inputs.dcLibraryNames.set("dl2", "South Library");
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcCountableDocs = [{ libraryId: "dl2", collectionId: null }];
    const [lib] = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([]);
  });
});
