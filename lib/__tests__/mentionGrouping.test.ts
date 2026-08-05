// Grouping is what turns a mention table into a backlinks panel. Get the
// ordering wrong and the drawing that names a pump forty times sits below a
// standard that names it once — which reads as "these are equally relevant"
// and they are not.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { groupByDocument, type MentionEvidence } from "@/lib/mentions";

function mention(over: Partial<MentionEvidence>): MentionEvidence {
  return {
    assetId: "a-1", assetTag: "E-101",
    knowledgeDocumentId: "k-1", documentId: null,
    documentName: "STD-14 Pipe Supports", libraryId: "lib-1",
    page: 1, snippet: "…E-101 shall be supported…", matchedText: "E-101",
    count: 1, confidence: 0.95, origin: "tag",
    ...over,
  };
}

describe("groupByDocument", () => {
  it("folds pages of one document into a single entry", () => {
    const out = groupByDocument([
      mention({ page: 3, count: 2 }),
      mention({ page: 7, count: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pages).toHaveLength(2);
    expect(out[0].totalMentions).toBe(7);
  });

  it("puts the document that talks about it most at the top", () => {
    const out = groupByDocument([
      mention({ knowledgeDocumentId: "k-1", documentName: "Standard", count: 1 }),
      mention({ knowledgeDocumentId: "k-2", documentName: "P&ID", count: 40, page: 2 }),
    ]);
    expect(out.map((d) => d.documentName)).toEqual(["P&ID", "Standard"]);
  });

  it("orders pages within a document by how much they say, not by page number", () => {
    const out = groupByDocument([
      mention({ page: 2, count: 1 }),
      mention({ page: 9, count: 12 }),
      mention({ page: 4, count: 3 }),
    ]);
    expect(out[0].pages.map((p) => p.page)).toEqual([9, 4, 2]);
  });

  it("keeps a controlled document and a knowledge document apart", () => {
    // Same name, different sources. Merging them would attribute a passage to
    // a document it isn't in.
    const out = groupByDocument([
      mention({ knowledgeDocumentId: "k-1", documentId: null }),
      mention({ knowledgeDocumentId: null, documentId: "d-1" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("reports the strongest confidence in the group", () => {
    const out = groupByDocument([
      mention({ page: 1, confidence: 0.6 }),
      mention({ page: 2, confidence: 0.98 }),
    ]);
    expect(out[0].bestConfidence).toBeCloseTo(0.98);
  });

  it("survives an empty set", () => {
    expect(groupByDocument([])).toEqual([]);
  });
});
