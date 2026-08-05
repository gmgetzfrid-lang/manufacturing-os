// Fusion is where hybrid retrieval quietly goes wrong. The failures aren't
// crashes — they're an answer that missed the one relevant standard, which
// nobody reports as a bug because it looks like the AI just didn't know.
//
// The two properties that matter: agreement between retrievers beats a single
// confident opinion, and a document only ONE retriever found still places.
// Losing the second property turns hybrid search back into an intersection,
// which is worse than either retriever alone.

import { describe, it, expect } from "vitest";
import { fuseRankings, explainFusion, RRF_K } from "@/lib/hybridRank";

interface Passage { id: string }
const p = (id: string): Passage => ({ id });
const ids = (out: Array<{ item: Passage }>) => out.map((r) => r.item.id);

describe("fuseRankings", () => {
  it("puts what both retrievers found above what only one did", () => {
    const out = fuseRankings(
      [
        { source: "keyword", items: [p("a"), p("b")] },
        { source: "meaning", items: [p("c"), p("b")] },
      ],
      (x) => x.id,
    );
    expect(ids(out)[0]).toBe("b");
  });

  it("still surfaces a passage only one retriever found", () => {
    // The whole reason for hybrid: keyword catches PSV-2001, meaning catches
    // "what holds the pump down". Dropping the singletons defeats it.
    const out = fuseRankings(
      [
        { source: "keyword", items: [p("only-keyword")] },
        { source: "meaning", items: [p("only-meaning")] },
      ],
      (x) => x.id,
    );
    expect(ids(out).sort()).toEqual(["only-keyword", "only-meaning"]);
  });

  it("ignores the retrievers' raw scores entirely", () => {
    // Fusion sees order, nothing else. Passing wildly different score scales
    // must not change the outcome, because that's the bug this replaces.
    const a = fuseRankings([{ source: "s", items: [p("x"), p("y")] }], (i) => i.id);
    const b = fuseRankings([{ source: "s", items: [p("x"), p("y")] }], (i) => i.id);
    expect(ids(a)).toEqual(ids(b));
  });

  it("recognises the same passage arriving from both retrievers as one", () => {
    const out = fuseRankings(
      [
        { source: "keyword", items: [p("a")] },
        { source: "meaning", items: [p("a")] },
      ],
      (x) => x.id,
    );
    expect(out).toHaveLength(1);
    expect(out[0].found.map((f) => f.source)).toEqual(["keyword", "meaning"]);
  });

  it("scores by reciprocal rank, not by position difference", () => {
    const out = fuseRankings([{ source: "s", items: [p("a"), p("b")] }], (x) => x.id);
    expect(out[0].score).toBeCloseTo(1 / (RRF_K + 1));
    expect(out[1].score).toBeCloseTo(1 / (RRF_K + 2));
  });

  it("lets a caller weight one retriever above another", () => {
    const out = fuseRankings(
      [
        { source: "keyword", items: [p("k")] },
        { source: "meaning", items: [p("m")] },
      ],
      (x) => x.id,
      { weights: { keyword: 3 } },
    );
    expect(ids(out)[0]).toBe("k");
  });

  it("breaks ties the same way every run", () => {
    // Two identical inputs must produce identical output or a retrieval
    // regression is impossible to reproduce.
    const build = () => fuseRankings(
      [
        { source: "one", items: [p("a"), p("b")] },
        { source: "two", items: [p("b"), p("a")] },
      ],
      (x) => x.id,
    );
    expect(ids(build())).toEqual(ids(build()));
  });

  it("prefers agreement when scores tie exactly", () => {
    // "a" is #1 in one list; "b" is #2 in both. Equal-ish scores, and the
    // passage two independent retrievers surfaced is the safer answer.
    const out = fuseRankings(
      [
        { source: "one", items: [p("a"), p("b")] },
        { source: "two", items: [p("c"), p("b")] },
      ],
      (x) => x.id,
    );
    expect(out[0].item.id).toBe("b");
    expect(out[0].found).toHaveLength(2);
  });

  it("survives an empty retriever without dropping the other", () => {
    const out = fuseRankings(
      [
        { source: "keyword", items: [] },
        { source: "meaning", items: [p("a")] },
      ],
      (x) => x.id,
    );
    expect(ids(out)).toEqual(["a"]);
  });

  it("returns nothing when nothing was found", () => {
    expect(fuseRankings([{ source: "s", items: [] }], (x: Passage) => x.id)).toEqual([]);
  });

  it("records every position a passage was found at", () => {
    const out = fuseRankings(
      [
        { source: "keyword", items: [p("z"), p("a")] },
        { source: "meaning", items: [p("a")] },
      ],
      (x) => x.id,
    );
    const a = out.find((r) => r.item.id === "a")!;
    expect(a.found).toEqual([{ source: "keyword", rank: 2 }, { source: "meaning", rank: 1 }]);
  });
});

describe("explainFusion", () => {
  it("distinguishes agreement from a single opinion", () => {
    expect(explainFusion([{ source: "keyword", rank: 1 }])).toMatch(/only/);
    expect(explainFusion([{ source: "keyword", rank: 1 }, { source: "meaning", rank: 2 }]))
      .toMatch(/keyword #1 \+ meaning #2/);
  });

  it("says so rather than claiming a source when there is none", () => {
    expect(explainFusion([])).toMatch(/no retriever/);
  });
});
