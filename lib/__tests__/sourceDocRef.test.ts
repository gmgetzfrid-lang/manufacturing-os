// Ticket → source-document backlink parsing (LIFE-13).
//
// The ticket page renders a live source-document card from
// metadata.source_document. Three producers write three shapes; these tests
// pin each shape VERBATIM so a producer change cannot silently blank the
// card, and pin the drift rules so a ticket that captured no rev can never
// claim the document is current (or stale).

import { describe, it, expect } from "vitest";
import { parseSourceDocument, parseSourceDocuments, buildSourceDocumentRef, revDrift } from "@/lib/sourceDocRef";

describe("parseSourceDocument", () => {
  it("accepts the CheckInPanel shape (document_number, rev, path:null)", () => {
    const ref = parseSourceDocument({
      source_document: { id: "d1", document_number: "P-200-301", title: "Flare header", rev: "3", path: null },
    });
    expect(ref).toEqual({ id: "d1", documentNumber: "P-200-301", title: "Flare header", rev: "3", path: null, versionId: null });
  });

  it("accepts the requests/new shape and normalizes '' fields to null", () => {
    const ref = parseSourceDocument({
      source_document: { id: "d1", document_number: "", title: "", rev: "", path: "" },
    });
    expect(ref).toEqual({ id: "d1", documentNumber: null, title: null, rev: null, path: null, versionId: null });
  });

  it("accepts the transitionIn shape (`number` key, no rev)", () => {
    const ref = parseSourceDocument({
      source_document: { id: "d1", number: "P-200-301", title: "Flare header" },
    });
    expect(ref?.documentNumber).toBe("P-200-301");
    expect(ref?.rev).toBeNull();
  });

  it("returns null with no metadata, no source_document, or no id", () => {
    expect(parseSourceDocument(undefined)).toBeNull();
    expect(parseSourceDocument({})).toBeNull();
    expect(parseSourceDocument({ source_document: { document_number: "P-1" } })).toBeNull();
    expect(parseSourceDocument({ source_document: { id: "  " } })).toBeNull();
  });
});

describe("revDrift", () => {
  it("matches equal revisions, whitespace- and case-insensitively", () => {
    expect(revDrift("3", "3")).toBe("same");
    expect(revDrift(" 3 ", "3")).toBe("same");
    expect(revDrift("rev A", "Rev A")).toBe("same");
  });

  it("flags a drifted revision", () => {
    expect(revDrift("3", "4")).toBe("drifted");
  });

  it("reports unknown when either side is missing — never a false claim", () => {
    expect(revDrift(null, "4")).toBe("unknown");
    expect(revDrift("3", null)).toBe("unknown");
    expect(revDrift("", "4")).toBe("unknown");
  });
});

describe("HAND-7 — the canonical shape carries the version the request was raised against", () => {
  it("the builder writes version_id (null when unknown) and the parser reads it back", () => {
    const ref = buildSourceDocumentRef({ id: "d1", documentNumber: "P-1", title: "T", rev: "3", versionId: "v3" });
    expect(ref).toEqual({ id: "d1", document_number: "P-1", title: "T", rev: "3", version_id: "v3" });
    expect(parseSourceDocument({ source_document: ref })?.versionId).toBe("v3");
    expect(buildSourceDocumentRef({ id: "d1" })?.version_id).toBeNull();
  });

  it("revDrift decides by version id when both sides carry one — a relabelled or re-issued rev cannot fool it", () => {
    expect(revDrift({ versionId: "v3", rev: "3" }, { versionId: "v4", rev: "3" })).toBe("drifted");
    expect(revDrift({ versionId: "v3", rev: "3" }, { versionId: "v3", rev: "3A" })).toBe("same");
  });

  it("without a version on either side it falls back to the rev labels, and never claims what it cannot back", () => {
    expect(revDrift({ versionId: null, rev: "3" }, { versionId: "v4", rev: "4" })).toBe("drifted");
    expect(revDrift({ versionId: "v3", rev: null }, { versionId: null, rev: "4" })).toBe("unknown");
    expect(revDrift({}, {})).toBe("unknown");
    // the string form (the ticket page's call) is unchanged
    expect(revDrift("3", "3")).toBe("same");
  });
});

describe("GAP-8 — every source document a ticket names", () => {
  it("the singular primary first, then the array beside it, deduplicated; a single-source row reads as one", () => {
    const meta = {
      source_document: { id: "a", document_number: "P-1", rev: "1" },
      source_documents: [{ id: "a" }, { id: "b", number: "P-2" }, { nope: true }, "x"],
    };
    expect(parseSourceDocuments(meta).map((r) => [r.id, r.documentNumber])).toEqual([["a", "P-1"], ["b", "P-2"]]);
    expect(parseSourceDocuments({ source_document: { id: "a" } }).map((r) => r.id)).toEqual(["a"]);
    expect(parseSourceDocuments({})).toEqual([]);
    expect(parseSourceDocuments(null)).toEqual([]);
  });
});
