import { describe, it, expect } from "vitest";
import { assembleFlowsBrowse, type FlowsBrowseInputs } from "@/lib/flowsBrowse";

// The picker's promise: the hierarchy the user actually filed things into
// (DC library / folder), with nothing silently hidden — and a NAMED answer
// for every way a document can be invisible: unwatched container, unlinked
// sibling folder, sync not run yet, not a PDF, or held by the AI boundary.

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
  dcHeldDocs: [],
  nonPdfDocIds: new Set(),
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
    const { libraries: [lib] } = assembleFlowsBrowse(inputs);
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
      { id: "x1", libraryId: "dl1", collectionId: "fB" },
      { id: "x2", libraryId: "dl1", collectionId: "fB" },
      { id: "x3", libraryId: "dl1", collectionId: null },
    ];
    const { libraries: [lib] } = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([
      { label: "North Library / P&IDs", docCount: 2 },
      { label: "North Library / (library root)", docCount: 1 },
    ]);
  });

  it("reports nothing missing when a whole DC library is the source, but counts pendingSync until mirrored", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.dcCountableDocs = [
      { id: "x1", libraryId: "dl1", collectionId: "fB" },
      { id: "x2", libraryId: "dl1", collectionId: null },
    ];
    const { libraries: [lib], unwatched } = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([]);
    // Watched + readable + not mirrored yet = a Sync fixes exactly these.
    expect(lib.pendingSync).toBe(2);
    expect(unwatched).toEqual([]);
  });

  it("mirrored docs don't count as pendingSync; non-PDF revisions are their own bucket", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.knowledgeDocs = [
      { id: "k1", name: "PFD Book", libraryId: "kl1", pageCount: 12, status: "ready", sourceDocumentId: "d1" },
    ];
    inputs.dcDocContainers = new Map([["d1", { libraryId: "dl1", collectionId: "fA" }]]);
    inputs.dcCountableDocs = [
      { id: "d1", libraryId: "dl1", collectionId: "fA" }, // mirrored
      { id: "d2", libraryId: "dl1", collectionId: "fA" }, // native CAD, no PDF
      { id: "d3", libraryId: "dl1", collectionId: "fA" }, // waiting on sync
    ];
    inputs.nonPdfDocIds = new Set(["d2"]);
    const { libraries: [lib] } = assembleFlowsBrowse(inputs);
    expect(lib.pendingSync).toBe(1);
    expect(lib.notPdf).toBe(1);
  });

  it("tallies AI-boundary holds by reason for watched containers only", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcHeldDocs = [
      { libraryId: "dl1", collectionId: "fA1", reason: "no_file" },
      { libraryId: "dl1", collectionId: "fA", reason: "not_current" },
      { libraryId: "dl1", collectionId: "fA", reason: "not_current" },
      { libraryId: "dl1", collectionId: "fB", reason: "held_back" }, // unwatched → not this KL's story
    ];
    const { libraries: [lib] } = assembleFlowsBrowse(inputs);
    expect(lib.held).toEqual(expect.arrayContaining([
      { reason: "no_file", count: 1 },
      { reason: "not_current", count: 2 },
    ]));
    expect(lib.held).toHaveLength(2);
  });

  it("org-wide unwatched: a container no knowledge library watches is named — the 'new folder is missing' answer", () => {
    const inputs = base();
    inputs.dcLibraryNames.set("dl2", "Drawings");
    inputs.dcFolders.set("fNew", { name: "New PFDs", libraryId: "dl2", parentId: null, pathNames: ["New PFDs"] });
    // kl1 watches North Library's PFDs folder; the whole Drawings library
    // (with the user's brand-new folder) is linked NOWHERE.
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcCountableDocs = [
      { id: "n1", libraryId: "dl2", collectionId: "fNew" },
      { id: "n2", libraryId: "dl2", collectionId: "fNew" },
      { id: "n3", libraryId: "dl1", collectionId: "fA1" }, // watched → not unwatched
    ];
    const { unwatched } = assembleFlowsBrowse(inputs);
    expect(unwatched).toEqual([{ label: "Drawings / New PFDs", docCount: 2 }]);
  });

  it("subtree coverage: watching a parent folder covers its children", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcCountableDocs = [{ id: "x1", libraryId: "dl1", collectionId: "fA1" }];
    const { libraries: [lib], unwatched } = assembleFlowsBrowse(inputs);
    expect(lib.missing).toEqual([]);
    expect(unwatched).toEqual([]);
  });
});
