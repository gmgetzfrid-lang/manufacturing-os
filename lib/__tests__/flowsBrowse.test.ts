import { describe, it, expect } from "vitest";
import { assembleFlowsBrowse, type FlowsBrowseInputs } from "@/lib/flowsBrowse";

// The picker's promise: the DOCUMENT-CONTROL tree, exactly as filed —
// libraries, nested folders, every controlled document — with a named AI
// state on each row. A new folder can never "go missing": the moment it
// holds a document it is a node in the tree, whatever the doc's state.

const base = (): FlowsBrowseInputs => ({
  knowledgeLibraries: [{ id: "kl1", name: "Refinery Reference" }],
  knowledgeDocs: [],
  sources: [],
  dcLibraryNames: new Map([["dl1", "Drawings"]]),
  dcFolders: new Map([
    ["fA", { name: "PFDs", libraryId: "dl1", parentId: null  }],
    ["fA1", { name: "Unit 20", libraryId: "dl1", parentId: "fA" }],
    ["fB", { name: "P&IDs", libraryId: "dl1", parentId: null }],
  ]),
  dcDocs: [],
  nonPdfDocIds: new Set(),
});

describe("assembleFlowsBrowse — the DC tree with AI states", () => {
  it("nests folders exactly as document control files them", () => {
    const inputs = base();
    inputs.dcDocs = [
      { id: "d1", name: "PFD Book", libraryId: "dl1", collectionId: "fA1", block: null },
      { id: "d2", name: "Root doc", libraryId: "dl1", collectionId: null, block: null },
    ];
    const { tree } = assembleFlowsBrowse(inputs);
    expect(tree).toHaveLength(1);
    const lib = tree[0];
    expect(lib.name).toBe("Drawings");
    expect(lib.totalDocs).toBe(2);
    expect(lib.docs.map((d) => d.name)).toEqual(["Root doc"]);
    // PFDs → Unit 20 → PFD Book, nested; empty P&IDs folder folds away.
    expect(lib.folders.map((f) => f.name)).toEqual(["PFDs"]);
    expect(lib.folders[0].folders[0].name).toBe("Unit 20");
    expect(lib.folders[0].folders[0].docs[0].name).toBe("PFD Book");
  });

  it("a brand-new folder with an unlinked doc APPEARS, state 'unwatched' — never missing", () => {
    const inputs = base();
    inputs.dcFolders.set("fNew", { name: "New PFDs", libraryId: "dl1", parentId: null });
    // The knowledge library watches only the old PFDs folder.
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcDocs = [{ id: "n1", name: "New PFD", libraryId: "dl1", collectionId: "fNew", block: null }];
    const { tree } = assembleFlowsBrowse(inputs);
    const folder = tree[0].folders.find((f) => f.name === "New PFDs");
    expect(folder).toBeDefined();
    expect(folder!.watched).toBe(false);
    expect(folder!.docs[0].state).toBe("unwatched");
  });

  it("mirrored docs are 'ready' with the knowledge doc id the reader needs", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.knowledgeDocs = [
      { id: "k1", name: "PFD Book (mirror)", libraryId: "kl1", pageCount: 12, status: "ready", sourceDocumentId: "d1" },
    ];
    inputs.dcDocs = [{ id: "d1", name: "PFD Book", libraryId: "dl1", collectionId: "fA", block: null }];
    const { tree } = assembleFlowsBrowse(inputs);
    const row = tree[0].folders[0].docs[0];
    expect(row.state).toBe("ready");
    expect(row.kdocId).toBe("k1");
    expect(row.pageCount).toBe(12);
    expect(tree[0].watched).toBe(true);
  });

  it("watched-but-unmirrored splits into pending_sync vs not_pdf; boundary blocks keep their reason", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.dcDocs = [
      { id: "d1", name: "Waiting", libraryId: "dl1", collectionId: "fA", block: null },
      { id: "d2", name: "Native CAD", libraryId: "dl1", collectionId: "fA", block: null },
      { id: "d3", name: "Old rev", libraryId: "dl1", collectionId: "fA", block: "not_current" },
      { id: "d4", name: "Secret", libraryId: "dl1", collectionId: "fA", block: "held_back" },
    ];
    inputs.nonPdfDocIds = new Set(["d2"]);
    const { tree } = assembleFlowsBrowse(inputs);
    const states = Object.fromEntries(tree[0].folders[0].docs.map((d) => [d.name, d.state]));
    expect(states).toEqual({
      Waiting: "pending_sync",
      "Native CAD": "not_pdf",
      "Old rev": "not_current",
      Secret: "held_back",
    });
  });

  it("watching a parent folder covers its children (subtree rule)", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "folder", sourceId: "fA" }];
    inputs.dcDocs = [{ id: "d1", name: "Deep doc", libraryId: "dl1", collectionId: "fA1", block: null }];
    const { tree } = assembleFlowsBrowse(inputs);
    const unit20 = tree[0].folders[0].folders[0];
    expect(unit20.watched).toBe(true);
    expect(unit20.docs[0].state).toBe("pending_sync");
  });

  it("direct AI uploads (and mirrors whose DC doc vanished) group under their knowledge library", () => {
    const inputs = base();
    inputs.knowledgeDocs = [
      { id: "k1", name: "Uploaded PFD", libraryId: "kl1", pageCount: 3, status: "ready", sourceDocumentId: null },
      { id: "k2", name: "Orphan mirror", libraryId: "kl1", pageCount: 1, status: "ready", sourceDocumentId: "gone" },
    ];
    const { uploads } = assembleFlowsBrowse(inputs);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].knowledgeLibraryName).toBe("Refinery Reference");
    expect(uploads[0].docs.map((d) => d.name)).toEqual(["Orphan mirror", "Uploaded PFD"]);
  });

  it("libraries with no documents anywhere fold away", () => {
    const inputs = base();
    inputs.dcLibraryNames.set("dl2", "Empty Library");
    inputs.dcDocs = [{ id: "d1", name: "Doc", libraryId: "dl1", collectionId: null, block: null }];
    const { tree } = assembleFlowsBrowse(inputs);
    expect(tree.map((l) => l.name)).toEqual(["Drawings"]);
  });
});

describe("assembleFlowsBrowse — mirror status honesty", () => {
  it("a pending/stale mirror is 'indexing', never 'ready' — Read must not scan page 1 of an unpaged file", () => {
    const inputs = base();
    inputs.sources = [{ knowledgeLibraryId: "kl1", sourceType: "library", sourceId: "dl1" }];
    inputs.knowledgeDocs = [
      { id: "k1", name: "Fresh mirror", libraryId: "kl1", pageCount: null, status: "pending", sourceDocumentId: "d1" },
      { id: "k2", name: "Rev-up mirror", libraryId: "kl1", pageCount: 9, status: "stale", sourceDocumentId: "d2" },
    ];
    inputs.dcDocs = [
      { id: "d1", name: "Fresh", libraryId: "dl1", collectionId: "fA", block: null },
      { id: "d2", name: "Revved", libraryId: "dl1", collectionId: "fA", block: null },
    ];
    const { tree } = assembleFlowsBrowse(inputs);
    const states = tree[0].folders[0].docs.map((d) => d.state);
    expect(states).toEqual(["indexing", "indexing"]);
    // The kdoc id still rides along for when it flips ready.
    expect(tree[0].folders[0].docs[0].kdocId).toBe("k1");
  });
});
