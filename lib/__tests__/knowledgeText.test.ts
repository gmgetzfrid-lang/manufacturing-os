// Tests for the pure text machinery behind the AI knowledge libraries —
// chunking, model-output parsing, citation extraction, retrieval merging.

import { describe, it, expect } from "vitest";
import {
  chunkPageText, parseSearchQueries, parseRefineQueries, parseFollowupPlan,
  extractCitationNumbers, mergeRetrieved, isSectionHeading, splitPageIntoSections,
  parseAnswerBlocks, explodeRunOn, proofTerms, highlightQuote, ensurePdfPolyfills, sanitizeStorageText, type RetrievedChunk,
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

  it("ignores zero and 4-digit numbers, keeps 3-digit markers", () => {
    expect(extractCitationNumbers("[0] [1234] no citations here")).toEqual([]);
    expect(extractCitationNumbers("per [117] and [187]")).toEqual([117, 187]);
  });

  it("handles answers with no citations", () => {
    expect(extractCitationNumbers("Not covered by the passages.")).toEqual([]);
  });
});

describe("parseFollowupPlan", () => {
  it("parses the full object", () => {
    expect(parseFollowupPlan('{"queries": ["STD-205 bolting"], "missing_documents": ["ASME B31.3"]}'))
      .toEqual({ queries: ["STD-205 bolting"], missingDocs: ["ASME B31.3"], clarify: null });
  });

  it("treats []/{}/READY as satisfied", () => {
    expect(parseFollowupPlan("[]")).toEqual({ queries: [], missingDocs: [], clarify: null });
    expect(parseFollowupPlan("{}")).toEqual({ queries: [], missingDocs: [], clarify: null });
    expect(parseFollowupPlan("READY")).toEqual({ queries: [], missingDocs: [], clarify: null });
  });

  it("extracts an object wrapped in prose/fences", () => {
    const out = parseFollowupPlan('Here you go:\n```json\n{"queries": [], "missing_documents": ["API 653"]}\n```');
    expect(out.missingDocs).toEqual(["API 653"]);
  });

  it("accepts a bare array as queries-only (old format)", () => {
    expect(parseFollowupPlan('["welder qualification records"]'))
      .toEqual({ queries: ["welder qualification records"], missingDocs: [], clarify: null });
  });

  it("returns nothing on rambling instead of noise queries", () => {
    expect(parseFollowupPlan("The passages look fine.")).toEqual({ queries: [], missingDocs: [], clarify: null });
  });

  it("parses a well-formed clarify proposal", () => {
    const out = parseFollowupPlan(
      '{"queries": [], "missing_documents": [], "clarify": {"question": "Which aspects?", "options": ["Safety", "Fabrication", "Design"]}}',
    );
    expect(out.clarify).toEqual({ question: "Which aspects?", options: ["Safety", "Fabrication", "Design"] });
  });

  it("drops malformed clarify proposals instead of surfacing them broken", () => {
    expect(parseFollowupPlan('{"clarify": {"question": "Pick one", "options": ["only-one"]}}').clarify).toBeNull();
    expect(parseFollowupPlan('{"clarify": {"options": ["a", "b"]}}').clarify).toBeNull();
    expect(parseFollowupPlan('{"clarify": "safety or design?"}').clarify).toBeNull();
  });
});

describe("parseAnswerBlocks important tier", () => {
  it("parses ! lines and keyword prefixes as important", () => {
    const blocks = parseAnswerBlocks(
      "**Answer:** Span is `7 ft` [1].\n! Confirm against Table 121.5 before releasing to the field.\nIMPORTANT: hydrotest is a hold point [2].",
    );
    expect(blocks[1]).toEqual({ type: "important", text: "Confirm against Table 121.5 before releasing to the field." });
    expect(blocks[2]).toEqual({ type: "important", text: "hydrotest is a hold point [2]." });
  });
});

describe("isSectionHeading", () => {
  it("accepts numbered and keyword headings", () => {
    expect(isSectionHeading("5.3 Pipe Supports")).toBe(true);
    expect(isSectionHeading("12.1.4 Hydrostatic Testing Requirements")).toBe(true);
    expect(isSectionHeading("SECTION 7 — TESTING")).toBe(true);
    expect(isSectionHeading("APPENDIX C Tables")).toBe(true);
  });

  it("rejects prose, values, and long lines", () => {
    expect(isSectionHeading("the spacing shall not exceed 7 ft")).toBe(false);
    expect(isSectionHeading("3/4 in. NPS")).toBe(false);
    expect(isSectionHeading("5.3 " + "very long heading text ".repeat(8))).toBe(false);
    expect(isSectionHeading("")).toBe(false);
  });
});

describe("splitPageIntoSections", () => {
  it("splits at headings and carries the section forward", () => {
    const { segments, lastSection } = splitPageIntoSections([
      "continued text from the previous page about materials",
      "5.3 Pipe Supports",
      "Supports shall be spaced per Table 5-1.",
      "Spacing for water service is given below.",
      "5.4 Anchors",
      "Anchors shall be welded.",
    ], "5.2 Materials");
    expect(segments).toHaveLength(3);
    expect(segments[0].section).toBe("5.2 Materials");
    expect(segments[1].section).toBe("5.3 Pipe Supports");
    expect(segments[1].text).toContain("Table 5-1");
    expect(segments[2].section).toBe("5.4 Anchors");
    expect(lastSection).toBe("5.4 Anchors");
  });

  it("handles pages with no headings (inherit carry) and null carry", () => {
    const a = splitPageIntoSections(["just body text on this page"], "4.1 Scope");
    expect(a.segments[0].section).toBe("4.1 Scope");
    expect(a.lastSection).toBe("4.1 Scope");
    const b = splitPageIntoSections(["body text before any heading exists"], null);
    expect(b.segments[0].section).toBeNull();
  });
});

describe("parseAnswerBlocks", () => {
  it("parses the Answer/Basis/Check structure", () => {
    const blocks = parseAnswerBlocks(
      "**Answer:** Maximum span is 7 ft [2].\n**Basis:**\n- Per §5.3 Pipe Supports [2]\n- Water service governs [1]\n**Check:** Confirm against Table 5-1 on page 47.",
    );
    expect(blocks[0]).toEqual({ type: "hero", text: "Maximum span is 7 ft [2]." });
    expect(blocks[1]).toEqual({ type: "label", text: "Basis" });
    expect(blocks[2].type).toBe("bullet");
    expect(blocks[4].type).toBe("text");
    expect(blocks[4].text).toContain("Check:");
  });

  it("degrades to text blocks when the model ignores the format", () => {
    const blocks = parseAnswerBlocks("The passages do not cover this topic.\nTry rephrasing.");
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    expect(blocks).toHaveLength(2);
  });

  it("treats numbered list items as bullets", () => {
    const blocks = parseAnswerBlocks("1. Verify preheat [1]\n2) Record interpass temp [2]");
    expect(blocks[0]).toEqual({ type: "bullet", text: "Verify preheat [1]" });
    expect(blocks[1]).toEqual({ type: "bullet", text: "Record interpass temp [2]" });
    // "1.5 NPS" is a designation, not a list item — needs the space after the dot
    expect(parseAnswerBlocks("1.5 NPS pipe requires support [1].")[0].type).toBe("text");
  });

  it("parses markdown and fully-bold headings as labels", () => {
    const blocks = parseAnswerBlocks("### Preheat requirements\n- 200F minimum [1]\n**Governing documents (which wins)**\n- Spec beats code [2]");
    expect(blocks[0]).toEqual({ type: "label", text: "Preheat requirements" });
    expect(blocks[2]).toEqual({ type: "label", text: "Governing documents (which wins)" });
  });

  it("accepts wider label lines — digits, parens, slashes", () => {
    const blocks = parseAnswerBlocks("**Table 121.5 limits (SA-106/B):**\n- 7 ft max [1]");
    expect(blocks[0]).toEqual({ type: "label", text: "Table 121.5 limits (SA-106/B)" });
  });

  it("promotes a plain-text heading sitting above bullets to a label", () => {
    const blocks = parseAnswerBlocks("Preheat requirements\n- 200F minimum for P-No 4 [1]\n- verify with contact pyrometer [2]");
    expect(blocks[0]).toEqual({ type: "label", text: "Preheat requirements" });
    expect(blocks[1].type).toBe("bullet");
  });

  it("escalates Note:/Caution:/Gap: lines to the important tier", () => {
    const blocks = parseAnswerBlocks("**Answer:** 7 ft [1].\nNote: table extraction can jumble numbers.");
    expect(blocks[1]).toEqual({ type: "important", text: "table extraction can jumble numbers." });
  });

  it("does NOT promote real sentences or cited lines to labels", () => {
    // ends with a period → real prose, even above bullets
    const a = parseAnswerBlocks("The weld failed inspection.\n- reject code UT-4 [1]");
    expect(a[0].type).toBe("text");
    // carries a citation → it's a fact, not a heading
    const b = parseAnswerBlocks("Preheat is 200F [1]\n- applies to P-No 4 [1]");
    expect(b[0].type).toBe("text");
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

describe("ensurePdfPolyfills", () => {
  it("installs a working Math.sumPrecise where the runtime lacks one", () => {
    ensurePdfPolyfills();
    const sum = (Math as Math & { sumPrecise: (v: Iterable<number>) => number }).sumPrecise;
    expect(typeof sum).toBe("function");
    expect(sum([1, 2, 3.5])).toBeCloseTo(6.5, 12);
    expect(sum([])).toBe(0);
    // The whole point: naive left-to-right addition loses the small term.
    expect(sum([1e16, 1, -1e16])).toBe(1);
  });

  it("is idempotent", () => {
    ensurePdfPolyfills();
    ensurePdfPolyfills();
    const sum = (Math as Math & { sumPrecise: (v: Iterable<number>) => number }).sumPrecise;
    expect(sum([2, 2])).toBe(4);
  });
});

// Tables used to be destroyed BEFORE chunking: all whitespace collapsed to
// single spaces, turning a stress table into an undelimited number soup the
// answer prompt had to disclaim. These pin the new contract: a table is one
// chunk, rows intact, caption attached — because "see Table 3" in prose is
// only answerable if a chunk exists that IS Table 3.
describe("table-aware chunking", () => {
  const TABLE = [
    "TABLE 3 — BOLT TORQUE",
    "Size | Torque | Lubricant",
    '1/2" | 30 ft-lb | dry',
    '3/4" | 100 ft-lb | dry',
    '1" | 245 ft-lb | moly',
  ].join("\n");

  it("keeps a table as ONE chunk with rows and caption intact", () => {
    const prose = "Bolting shall follow the torques given. ".repeat(40);
    const chunks = chunkPageText(`${prose}\n${TABLE}\n${prose}`);
    const tableChunk = chunks.find((c) => c.includes("TABLE 3"));
    expect(tableChunk).toBeTruthy();
    expect(tableChunk).toContain('3/4" | 100 ft-lb');
    expect(tableChunk!.split("\n").length).toBeGreaterThanOrEqual(5);
  });

  it("re-heads each part of an oversized table with caption + header row", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `${i} | value-${i} | note-${i}`);
    const big = ["TABLE 9 — LONG", "id | value | note", ...rows].join("\n");
    const chunks = chunkPageText(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.startsWith("TABLE 9 — LONG")).toBe(true);
      expect(c.split("\n")[1]).toBe("id | value | note");
    }
  });

  it("column-aligned text-layer tables are detected too", () => {
    const t = [
      "FIGURE 5-1  SPAN LIMITS",
      "NPS 2      3.0 m      2.1 m",
      "NPS 4      4.3 m      3.0 m",
      "NPS 6      5.2 m      3.7 m",
    ].join("\n");
    const chunks = chunkPageText(`intro text that is long enough to matter here\n${t}`);
    const tc = chunks.find((c) => c.includes("FIGURE 5-1"));
    expect(tc).toBeTruthy();
    expect(tc).toContain("NPS 4");
  });

  it("plain prose still chunks exactly as before", () => {
    const prose = "This is a sentence about pipe supports. ".repeat(120);
    const chunks = chunkPageText(prose);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.includes("\n")).toBe(false);
  });
});

describe("sanitizeStorageText", () => {
  // Characters are built with fromCharCode so this source file itself stays
  // free of control bytes and lone surrogates.
  const NUL = String.fromCharCode(0);
  const LONE_HIGH = String.fromCharCode(0xd835);
  const LONE_LOW = String.fromCharCode(0xdd53);

  it("drops the lone surrogates a broken PDF CMap emits", () => {
    // This is the exact poison behind 'chunk insert failed: invalid input
    // syntax for type json' — an unpaired \udXXX escape in the insert body.
    expect(sanitizeStorageText(`V-101${LONE_HIGH} relief header`)).toBe("V-101 relief header");
    expect(sanitizeStorageText(`${LONE_LOW}see Table 3`)).toBe("see Table 3");
  });

  it("keeps a properly paired surrogate (real astral character)", () => {
    const bold = LONE_HIGH + LONE_LOW; // U+1D553 as a valid pair
    expect(sanitizeStorageText(`x${bold}y`)).toBe(`x${bold}y`);
  });

  it("drops NUL and control bytes but keeps newlines and tabs", () => {
    const dirty = `line one${NUL}\nline${String.fromCharCode(8)} two\tend`;
    expect(sanitizeStorageText(dirty)).toBe("line one\nline two\tend");
  });

  it("survives round-tripping through JSON like the insert body does", () => {
    const dirty = `PSV-12${LONE_HIGH}${NUL} set at 250 psig`;
    const clean = sanitizeStorageText(dirty);
    // JSON.parse(JSON.stringify(...)) is what PostgREST effectively does —
    // clean text must make it through without an unpaired escape.
    expect(JSON.parse(JSON.stringify(clean))).toBe("PSV-12 set at 250 psig");
    expect(clean.includes(NUL)).toBe(false);
  });
});

describe("explodeRunOn — the wall-of-text killer", () => {
  // The exact answer a user reported as "an ugly wall of text all ran
  // together": one 600-char sentence plus a trailing Note. It must come
  // apart into a short headline, scannable bullets, and an escalated note.
  const RUN_ON =
    "For a pump suction line, welding is governed by EP 5-5-1 (fabrication) plus its mandatory " +
    "welding supplement EP 5-5-2, with rotating-equipment-specific requirements in EP 5-6-2 — and " +
    "the pump-specific drivers are joint type (butt weld for vibration/fatigue/cyclic service, " +
    "socket weld only where permitted), Field Fit Welds at the pump so spools can be aligned " +
    "without field cutting, GTAW root pass with argon back purge on all compressor piping and " +
    "low-alloy/stainless tie-ins, and flange-face alignment to EP 5-6-2 rather than the looser " +
    "code tolerance. Note: the retrieved passages do not include the body of EP 5-6-2 (only " +
    "excerpts on NPSH), so its exact flange-alignment values and any additional pump-piping weld " +
    "rules are not in hand.";

  it("splits the reported run-on into hero + bullets + escalated note", () => {
    const blocks = explodeRunOn(RUN_ON)!;
    expect(blocks).not.toBeNull();
    expect(blocks[0].type).toBe("hero");
    expect(blocks[0].text.length).toBeLessThan(220);
    expect(blocks[0].text).toContain("EP 5-5-1");
    expect(blocks[1]).toEqual({ type: "label", text: "Key points" });
    const bullets = blocks.filter((b) => b.type === "bullet");
    expect(bullets.length).toBeGreaterThanOrEqual(4);
    expect(bullets.some((b) => b.text.includes("GTAW root pass"))).toBe(true);
    // The paren list survives intact — commas inside parens never split.
    expect(bullets.some((b) => b.text.includes("(butt weld for vibration/fatigue/cyclic service, socket weld only where permitted)"))).toBe(true);
    const important = blocks.filter((b) => b.type === "important");
    expect(important).toHaveLength(1);
    expect(important[0].text).toContain("EP 5-6-2");
    expect(important[0].text.startsWith("Note:")).toBe(false);
  });

  it("leaves short answers and unsplittable text alone", () => {
    expect(explodeRunOn("Maximum span is 7 ft [2].")).toBeNull();
    expect(explodeRunOn("x".repeat(400))).toBeNull();
  });

  it("splits multi-sentence walls on sentence boundaries", () => {
    const text =
      "The governing spec is EP 4-2-1 for all carbon steel lines in this service. " +
      "Preheat to 200F applies for wall thickness over 25mm per Table 3. " +
      "Hydrotest at 1.5 times design pressure is a hold point requiring inspector signoff. " +
      "PWHT is required above 19mm nominal thickness in sour service per the supplement.";
    const blocks = explodeRunOn(text)!;
    expect(blocks[0].type).toBe("hero");
    expect(blocks[0].text).toContain("EP 4-2-1");
    expect(blocks.filter((b) => b.type === "bullet").length).toBe(3);
  });

  it("is applied by parseAnswerBlocks to run-on heroes", () => {
    const blocks = parseAnswerBlocks(`**Answer:** ${RUN_ON}`);
    expect(blocks[0].type).toBe("hero");
    expect(blocks[0].text.length).toBeLessThan(220);
    expect(blocks.some((b) => b.type === "label" && b.text === "Key points")).toBe(true);
    expect(blocks.filter((b) => b.type === "bullet").length).toBeGreaterThanOrEqual(4);
  });

  it("is applied by parseAnswerBlocks to giant bare paragraphs, without the Key points label", () => {
    const blocks = parseAnswerBlocks(RUN_ON);
    expect(blocks[0].type).toBe("text");
    expect(blocks.some((b) => b.type === "label")).toBe(false);
    expect(blocks.filter((b) => b.type === "bullet").length).toBeGreaterThanOrEqual(4);
    expect(blocks.filter((b) => b.type === "important")).toHaveLength(1);
  });
});

describe("proofTerms + highlightQuote — the verification moment", () => {
  it("extracts designations, values, and content words; drops glue", () => {
    const terms = proofTerms("Preheat to **200F** minimum per `EP 5-5-2` for P-No 4 material [3]");
    expect(terms).toContain("EP 5-5-2");
    expect(terms).toContain("200F");
    expect(terms).toContain("preheat");
    expect(terms).toContain("minimum");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("must");
  });

  it("marks the claim's terms inside the source quote", () => {
    const segs = highlightQuote(
      "Preheating of P-No 4 materials shall reach 200F before the first pass.",
      proofTerms("Preheat to 200F minimum for P-No 4 [1]"),
    );
    const marked = segs.filter((s) => s.hit).map((s) => s.text.toLowerCase());
    expect(marked).toContain("200f");
    expect(marked.some((t) => t.startsWith("preheat"))).toBe(true);
    // Round trip: segments reassemble to the exact quote.
    expect(segs.map((s) => s.text).join("")).toBe("Preheating of P-No 4 materials shall reach 200F before the first pass.");
  });

  it("handles empty quotes and no terms without throwing", () => {
    expect(highlightQuote("", ["x"])).toEqual([]);
    expect(highlightQuote("some text", [])).toEqual([{ text: "some text", hit: false }]);
  });
});

describe("parseAnswerBlocks — multi-paragraph wall fallback", () => {
  it("bulletizes paragraphs 2+ when an answer has zero structure", () => {
    const p = (s: string) => `${s} and the requirement applies to every line class in this service group [1].`;
    const wall = [p("First topic covers scope"), p("Second topic covers preheat"), p("Third topic covers hydrotest"), p("Fourth topic covers PWHT")].join("\n");
    const blocks = parseAnswerBlocks(wall);
    expect(blocks[0].type).toBe("text");
    expect(blocks.filter((b) => b.type === "bullet").length).toBe(3);
  });

  it("leaves short unstructured answers and structured answers alone", () => {
    const short = parseAnswerBlocks("Not covered.\nTry rephrasing.\nOr upload the document.");
    expect(short.every((b) => b.type === "text")).toBe(true);
    const structured = parseAnswerBlocks("Intro line one [1].\n- already a bullet [1]\nTrailing note line for the reader here [2].");
    expect(structured.filter((b) => b.type === "bullet").length).toBe(1);
  });
});
