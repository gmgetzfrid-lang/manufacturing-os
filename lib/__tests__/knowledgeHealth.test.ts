import { describe, it, expect } from "vitest";
import { classifyDoc, summarize, STUCK_AFTER_MS, type SourceDocFacts, type MirrorFacts } from "@/lib/knowledgeHealth";

const NOW = 1_800_000_000_000;
const doc = (over: Partial<SourceDocFacts> = {}): SourceDocFacts => ({
  id: "d1", name: "EP 5-2-1", blocked: null, currentVersionId: "v2", fileUrl: "orgs/o/l/ep.pdf", fileType: "application/pdf", ...over,
});
const mirror = (over: Partial<MirrorFacts> = {}): MirrorFacts => ({
  id: "k1", status: "ready", sourceVersionId: "v2", pagesIndexed: 10, pageCount: 10, error: null, touchedAt: NOW - 1000, ...over,
});

describe("classifyDoc - one status per source document", () => {
  it("indexed: current revision, every page read", () => expect(classifyDoc(doc(), mirror(), NOW)).toBe("indexed"));
  it("partial: ready but pages missing", () => expect(classifyDoc(doc(), mirror({ pagesIndexed: 4 }), NOW)).toBe("partial"));
  it("partial: ready with nothing read", () => expect(classifyDoc(doc(), mirror({ pagesIndexed: 0, pageCount: null }), NOW)).toBe("partial"));
  it("outdated: the document has a newer revision", () => expect(classifyDoc(doc(), mirror({ sourceVersionId: "v1" }), NOW)).toBe("outdated"));
  it("waiting: queued", () => expect(classifyDoc(doc(), mirror({ status: "pending" }), NOW)).toBe("waiting"));
  it("indexing: moving", () => expect(classifyDoc(doc(), mirror({ status: "indexing" }), NOW)).toBe("indexing"));
  it("stuck: indexing with no movement", () =>
    expect(classifyDoc(doc(), mirror({ status: "indexing", touchedAt: NOW - STUCK_AFTER_MS - 1 }), NOW)).toBe("stuck"));
  it("failed: keeps the reason", () => expect(classifyDoc(doc(), mirror({ status: "error", error: "bad PDF" }), NOW)).toBe("failed"));
  it("missing: should be mirrored and isn't", () => expect(classifyDoc(doc(), null, NOW)).toBe("missing"));
  it("retired: set aside here", () => expect(classifyDoc(doc(), mirror({ status: "retired" }), NOW)).toBe("retired"));
  it("retired: set aside in another library - restorable, not missing", () => expect(classifyDoc(doc(), null, NOW, true)).toBe("retired"));
  it("notPdf: CAD / images can't be read", () => expect(classifyDoc(doc({ fileUrl: "a/b/plot.dwg", fileType: "application/acad" }), null, NOW)).toBe("notPdf"));
  it("noFile: nothing attached", () => expect(classifyDoc(doc({ currentVersionId: null, blocked: "no_file" }), null, NOW)).toBe("noFile"));
  it("heldBack wins over everything", () => expect(classifyDoc(doc({ blocked: "held_back" }), mirror(), NOW)).toBe("heldBack"));
  it("notCurrent: superseded or archived", () => expect(classifyDoc(doc({ blocked: "not_current" }), null, NOW)).toBe("notCurrent"));
});

describe("summarize", () => {
  it("buckets always add up to the source total", () => {
    const docs = [
      doc({ id: "a" }), doc({ id: "b" }), doc({ id: "c", fileUrl: "x.dwg", fileType: null }),
      doc({ id: "d", blocked: "held_back" }), doc({ id: "e" }),
    ];
    const mirrors = new Map([["a", mirror({ id: "ka" })], ["b", mirror({ id: "kb", status: "error", error: "x" })]]);
    const s = summarize(docs, mirrors, [], NOW);
    expect(Object.values(s.counts).reduce((n, c) => n + c, 0)).toBe(docs.length);
    expect(s.counts).toMatchObject({ indexed: 1, failed: 1, notPdf: 1, heldBack: 1, missing: 1 });
    expect(s.indexable).toBe(3);
    expect(s.healthy).toBe(false);
  });

  it("finds leftovers: index entries with no wanted document behind them", () => {
    const s = summarize([doc({ id: "a" })], new Map([["a", mirror()]]), [
      { id: "k9", name: "Old.pdf", sourceDocumentId: "gone", status: "ready" },
      { id: "k8", name: "Parked.pdf", sourceDocumentId: "parked", status: "retired" },
      { id: "k7", name: "Held.pdf", sourceDocumentId: "held", status: "ready" },
    ], NOW);
    expect(s.leftovers.map((l) => l.mirrorId)).toEqual(["k9", "k7"]);
    expect(s.healthy).toBe(false);
  });

  it("a held-back document's leftover index is a leftover (it must leave search)", () => {
    const s = summarize([doc({ id: "h", blocked: "held_back" })], new Map(), [
      { id: "kh", name: "Held.pdf", sourceDocumentId: "h", status: "ready" },
    ], NOW);
    expect(s.leftovers).toHaveLength(1);
  });

  it("healthy when everything indexable is indexed and nothing is left over", () => {
    const s = summarize([doc({ id: "a" }), doc({ id: "c", fileUrl: "x.dwg", fileType: null })], new Map([["a", mirror()]]), [], NOW);
    expect(s.healthy).toBe(true);
  });
});
