// Tests for the pure text machinery behind the AI knowledge libraries —
// chunking, model-output parsing, citation extraction, retrieval merging.

import { describe, it, expect } from "vitest";
import {
  chunkPageText, parseSearchQueries, parseRefineQueries, extractCitationNumbers,
  mergeRetrieved, type RetrievedChunk,
} from "../knowledgeText";

describe("chunkPageText", () => {
  it("drops page furniture (too little text)", () => {
    expect(chunkPageText("Page 4")).toEqual([]);
    expect(chunkPageText("   ")).toEqual([]);
  });

  it("returns one chunk for a short page", () => {
    const text = "Flange bolting shall be torqued per the sequence in Appendix C. ".repeat(3);
    const chunks = chunkPageText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Flange bolting");
  });

  it("splits long pages with overlap so boundary facts appear twice", () => {
    const sentence = "The minimum design metal temperature shall be verified against UCS-66. ";
    const text = sentence.repeat(60); // ~4200 chars
    const chunks = chunkPageText(text);
    expect(chunks.length).toBeGreaterThan(2);
    // Every chunk is within a sane size envelope.
    for (const c of chunks) {
      expect(c.length).toBeGreaterThanOrEqual(40);
      expect(c.length).toBeLessThanOrEqual(1500);
    }
    // Overlap: the tail of chunk 1 shares content with the head of chunk 2.
    const tail = chunks[0].slice(-80);
    expect(chunks[1].includes(tail.slice(0, 40)) || chunks[1].startsWith(tail.slice(-40))).toBe(true);
  });

  it("normalizes whitespace from PDF extraction artifacts", () => {
    const chunks = chunkPageText("Valve   spacing\n\nshall   be\t\tper   spec.   More words to pass the minimum length filter here.");
    expect(chunks[0]).not.toMatch(/\s{2,}/);
  });
});

describe("parseSearchQueries", () => {
  it("parses a clean JSON array", () => {
    expect(parseSearchQueries('["flange rating", "ASME B16.5"]', "q")).toEqual([
      "flange rating", "ASME B16.5",
    ]);
  });

  it("parses an array wrapped in prose or a code fence", () => {
    const out = parseSearchQueries(
      'Here are the queries:\n```json\n["relief valve set pressure", "PSV sizing"]\n```',
      "q",
    );
    expect(out).toEqual(["relief valve set pressure", "PSV sizing"]);
  });

  it("falls back to the raw question when the model rambles", () => {
    expect(parseSearchQueries("I think you should search for flanges.", "original question"))
      .toEqual(["original question"]);
  });

  it("caps at 5 queries and drops non-strings", () => {
    const out = parseSearchQueries('["a","b","c","d","e","f",42,""]', "q");
    expect(out).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("parseRefineQueries", () => {
  it("treats [] as satisfied — no new queries", () => {
    expect(parseRefineQueries("[]")).toEqual([]);
    expect(parseRefineQueries("  []  ")).toEqual([]);
  });

  it("treats a READY sentinel as satisfied", () => {
    expect(parseRefineQueries("READY — the passages cover it.")).toEqual([]);
  });

  it("returns new queries when the model provides them", () => {
    expect(parseRefineQueries('["pipe support spacing table", "maximum span"]'))
      .toEqual(["pipe support spacing table", "maximum span"]);
  });

  it("returns no queries (not a fallback) on unparseable rambling", () => {
    expect(parseRefineQueries("The passages seem fine to me.")).toEqual([]);
  });
});

describe("extractCitationNumbers", () => {
  it("returns ordered, deduped markers", () => {
    expect(extractCitationNumbers("Per [2], torque is 250 ft-lb [2][1]. See also [3].")).toEqual([2, 1, 3]);
  });

  it("ignores zero and huge numbers", () => {
    expect(extractCitationNumbers("[0] [999] no citations here")).toEqual([]);
  });

  it("handles answers with no citations", () => {
    expect(extractCitationNumbers("Not covered by the passages.")).toEqual([]);
  });
});

describe("mergeRetrieved", () => {
  const mk = (id: string, rank: number): RetrievedChunk => ({
    id, document_id: "d1", page: 1, content: `content ${id} `.repeat(10), rank,
  });

  it("dedupes by id keeping the best rank and sorts descending", () => {
    const merged = mergeRetrieved([
      [mk("a", 0.2), mk("b", 0.9)],
      [mk("a", 0.7), mk("c", 0.5)],
    ]);
    expect(merged.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(merged.find((c) => c.id === "a")?.rank).toBe(0.7);
  });

  it("caps the count and truncates chunk content", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`c${i}`, i / 30));
    const merged = mergeRetrieved([many], 14, 50);
    expect(merged).toHaveLength(14);
    for (const c of merged) expect(c.content.length).toBeLessThanOrEqual(50);
  });
});
