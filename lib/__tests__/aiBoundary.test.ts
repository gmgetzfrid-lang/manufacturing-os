// The gatekeeper. Every one of these is a document that must NOT reach a
// model, and each is a different bug when it slips: a held-back confidential
// report cited in an answer, a superseded drawing quoted as current, a
// document from a library nobody ever approved for indexing.
//
// The reason strings matter as much as the boolean. "The AI can't see it"
// with no reason is a support ticket.

import { describe, it, expect } from "vitest";
import {
  aiReadability, readableByAi, explainBlock, NOT_CURRENT_STATUSES,
  type BoundaryDoc,
} from "@/lib/aiBoundary";

const doc = (over: Partial<BoundaryDoc> = {}): BoundaryDoc => ({
  id: "d-1", status: "Issued", archivedAt: null, currentVersionId: "v-1",
  aiExcluded: false, ...over,
});

describe("aiReadability", () => {
  it("lets a current, in-scope, un-excluded document through", () => {
    expect(aiReadability(doc(), true)).toEqual({ readable: true, reason: null });
  });

  it("blocks a document a controller held back", () => {
    const v = aiReadability(doc({ aiExcluded: true }), true);
    expect(v.readable).toBe(false);
    expect(v.reason).toBe("held_back");
  });

  it("blocks anything outside a linked knowledge source", () => {
    expect(aiReadability(doc(), false).reason).toBe("out_of_scope");
  });

  it("blocks every status that means 'no longer in force'", () => {
    for (const status of NOT_CURRENT_STATUSES) {
      expect(aiReadability(doc({ status }), true).reason).toBe("not_current");
    }
  });

  it("blocks an archived document whatever its status says", () => {
    // archived_at is set independently of status; checking only one of them
    // is how an archived drawing stays citable.
    expect(aiReadability(doc({ status: "Issued", archivedAt: "2026-01-01" }), true).reason)
      .toBe("not_current");
  });

  it("blocks a document with no current version file", () => {
    expect(aiReadability(doc({ currentVersionId: null }), true).reason).toBe("no_file");
  });

  it("reports held_back ahead of every other reason", () => {
    // A controller's explicit decision is the reason they'll go looking for.
    const v = aiReadability(doc({ aiExcluded: true, status: "Void", currentVersionId: null }), false);
    expect(v.reason).toBe("held_back");
  });

  it("treats a missing status as current rather than blocking it", () => {
    expect(aiReadability(doc({ status: null }), true).readable).toBe(true);
  });
});

describe("readableByAi", () => {
  it("drops documents named in the exclusion set", () => {
    const out = readableByAi([doc({ id: "a" }), doc({ id: "b" })], new Set(["b"]));
    expect(out.map((d) => d.id)).toEqual(["a"]);
  });

  it("honours a per-document scope test", () => {
    const out = readableByAi(
      [doc({ id: "a" }), doc({ id: "b" })], new Set(),
      (d) => d.id === "a",
    );
    expect(out.map((d) => d.id)).toEqual(["a"]);
  });

  it("keeps everything when nothing is excluded and all are in scope", () => {
    expect(readableByAi([doc({ id: "a" }), doc({ id: "b" })], new Set())).toHaveLength(2);
  });

  it("respects a document's own flag as well as the set", () => {
    const out = readableByAi([doc({ id: "a", aiExcluded: true })], new Set());
    expect(out).toEqual([]);
  });

  it("survives an empty batch", () => {
    expect(readableByAi([], new Set())).toEqual([]);
  });
});

describe("explainBlock", () => {
  it("gives a reason a controller can act on for every block", () => {
    for (const reason of ["held_back", "out_of_scope", "not_current", "no_file"] as const) {
      expect(explainBlock(reason).length).toBeGreaterThan(20);
    }
  });
});
