// Ticket → source-document backlink parsing (LIFE-13).
//
// The ticket page renders a live source-document card from
// metadata.source_document. Three producers write three shapes; these tests
// pin each shape VERBATIM so a producer change cannot silently blank the
// card, and pin the drift rules so a ticket that captured no rev can never
// claim the document is current (or stale).

import { describe, it, expect } from "vitest";
import { parseSourceDocument, revDrift } from "@/lib/sourceDocRef";

describe("parseSourceDocument", () => {
  it("accepts the CheckInPanel shape (document_number, rev, path:null)", () => {
    const ref = parseSourceDocument({
      source_document: { id: "d1", document_number: "P-200-301", title: "Flare header", rev: "3", path: null },
    });
    expect(ref).toEqual({ id: "d1", documentNumber: "P-200-301", title: "Flare header", rev: "3", path: null });
  });

  it("accepts the requests/new shape and normalizes '' fields to null", () => {
    const ref = parseSourceDocument({
      source_document: { id: "d1", document_number: "", title: "", rev: "", path: "" },
    });
    expect(ref).toEqual({ id: "d1", documentNumber: null, title: null, rev: null, path: null });
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
