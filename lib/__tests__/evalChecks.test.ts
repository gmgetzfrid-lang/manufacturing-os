import { describe, it, expect } from "vitest";
import { runChecks, passed, type AnswerUnderTest } from "@/lib/eval/checks";
import { funnelFor } from "@/lib/ask/askTrace";
import { docsNamedIn, designationMatcher } from "@/lib/ask/designations";

const docs = ["EP 5-2-3 - Kern Engineering Piping Standards", "EP 10-2-1 - Material Requirements for Aggressive Environmental Services", "EP 1-4-1 - Definitions", "E2G Piping Specs (All)"];
const base = (over: Partial<AnswerUnderTest>): AnswerUnderTest => ({
  question: "What piping spec should I use for 150 class sour gas stream?",
  answer: "", citations: [], libraryDocNames: docs, ...over,
});
const code = (r: ReturnType<typeof runChecks>, c: string) => r.find((x) => x.code === c);

describe("answer checks — the failures that started this", () => {
  const bad = base({
    answer: [
      "**Answer:** Use FAAA1G, the Class 1500 sour spec [1].",
      "Sour gas is wet H2S service [2].",
      "**To settle this:**",
      "- **EP 5-2-3 class index** — please provide it",
      "**Why:**",
      "- Class 1500 spec lists NACE trim [1].",
    ].join("\n"),
    citations: [
      { n: 1, documentName: "E2G Piping Specs (All)", page: 812, quote: "FAAA1G Class 1500 sour hydrocarbon", role: "decides", highlight: "FAAA1G" },
      { n: 2, documentName: "EP 10-2-1 - Material Requirements", page: 12, quote: "3.20 Wet H2S service — free water with H2S above 50 ppmw", role: "context" },
    ],
  });
  const r = runChecks(bad, { mustCite: [{ document: "EP 5-2-3", page: 7 }] });

  it("catches the class mix-up in the answer line and in the decisive page", () => {
    expect(code(r, "class_mixup")?.pass).toBe(false);
    expect(code(r, "class_mixup")?.detail).toMatch(/Class 1500/);
  });
  it("catches 'sour gas is wet H2S' when no cited passage says both", () => {
    expect(code(r, "unproven_link")?.pass).toBe(false);
  });
  it("catches asking for EP 5-2-3, which the library holds", () => {
    expect(code(r, "asks_for_held")?.pass).toBe(false);
  });
  it("catches the missed page", () => {
    expect(code(r, "missed_page")?.pass).toBe(false);
    expect(passed(r)).toBe(false);
  });
});

describe("answer checks — what a good answer looks like passes", () => {
  const good = base({
    answer: [
      "**Answer:** Use AAAA2HN, the Class 150 class the index lists for wet H2S service [1], if the gas carries free water [2].",
      "Sour gas becomes wet H2S service only if free water is present [2].",
      "**To settle this:**",
      "- **Free water in the stream** — only you know the process conditions",
    ].join("\n"),
    citations: [
      { n: 1, documentName: "EP 5-2-3 - Kern Engineering Piping Standards", page: 7, quote: "AAAA2HN – Wet H2S per EP 10-2-1 (200 BHN max) Class 150", role: "decides", highlight: "AAAA2HN" },
      { n: 2, documentName: "EP 10-2-1 - Material Requirements", page: 12, quote: "Wet H2S service: free water with H2S", role: "limits", highlight: "Wet H2S" },
    ],
  });
  it("passes every check", () => {
    const r = runChecks(good, { mustCite: [{ document: "EP 5-2-3", page: 7 }], mustContain: ["AAAA2HN"] });
    expect(r.filter((x) => !x.pass)).toEqual([]);
  });
  it("a conditional tie ('only if') is a distinction, not an unproven link", () => {
    const r = runChecks(good, {});
    expect(code(r, "unproven_link")?.pass).toBe(true);
  });
  it("a link IS allowed when a cited passage mentions both terms", () => {
    const r = runChecks(base({
      answer: "**Answer:** Sour gas is treated as wet H2S service here [1].",
      citations: [{ n: 1, documentName: "EP 10-2-1", page: 3, quote: "Sour gas streams shall be treated as wet H2S service", role: "decides", highlight: "Sour gas" }],
    }), {});
    expect(code(r, "unproven_link")?.pass).toBe(true);
  });
  it("forbidden phrases and alternative wordings", () => {
    const r = runChecks(good, { mustNot: ["Class 1500"], mustContain: ["free water | water present"] });
    expect(r.filter((x) => !x.pass)).toEqual([]);
  });
});

describe("document numbers match whole numbers only", () => {
  it("EP 1-4 is not EP 1-4-1", () => {
    expect(designationMatcher("EP 1-4").test("EP 1-4-1 - DEFINITIONS")).toBe(false);
    expect(designationMatcher("EP 1-4-1").test("EP 1-4-1 - DEFINITIONS")).toBe(true);
    expect(docsNamedIn("see EP 10-2-1 §3.20", docs.map((name) => ({ name })), 2).map((d) => d.name)).toEqual([docs[1]]);
  });
});

describe("research record: where did the expected page drop out?", () => {
  const names = new Map([["d1", "EP 5-2-3 - Piping Standards"]]);
  const stage = (name: string, hits: Array<{ documentId: string; page: number }>) => ({ name, at: 0, data: { hits: hits.map((h) => ({ chunkId: "c", ...h })) } });
  const want = { documentName: /EP 5-2-3/, page: 7 };
  it("never found", () => expect(funnelFor([stage("round1", [])], want, names, [])).toBe("never_found"));
  it("found, ranked out", () => expect(funnelFor([stage("round1", [{ documentId: "d1", page: 7 }]), stage("passages", [])], want, names, [])).toBe("found_not_given"));
  it("given, not cited", () => expect(funnelFor([stage("passages", [{ documentId: "d1", page: 8 }])], want, names, [])).toBe("given_not_cited"));
  it("cited", () => expect(funnelFor([], want, names, [{ documentId: "d1", page: 7 }])).toBe("cited"));
});

describe("two classes named: a Class 300 part in a Class 150 line", () => {
  it("naming Class 300 in the answer is not a mix-up; naming 1500 is", () => {
    const q = "can I use 300 class flanges in a 150 class line bolting to a vessel nozzle";
    const ok = runChecks({ question: q, answer: "**Answer:** YES, WITH CONDITIONS — the Class 150 line class carries Class 300 flanges for Class 300 equipment nozzles [1].", citations: [{ n: 1, documentName: "Spec", page: 3, quote: "Class 300 flanged equipment nozzles", role: "decides", highlight: "x" }], libraryDocNames: [] }, {});
    expect(ok.find((r) => r.code === "class_mixup")?.pass).toBe(true);
    const bad = runChecks({ question: q, answer: "**Answer:** Use the Class 1500 flange [1].", citations: [], libraryDocNames: [] }, {});
    expect(bad.find((r) => r.code === "class_mixup")?.pass).toBe(false);
  });
});

describe("documents named by title, not number", () => {
  it("'E2G Piping Specs (All)' is recognised as a held document", async () => {
    const { docsTitledIn } = await import("@/lib/ask/designations");
    const held = [{ name: "E2G Piping Specs (All).pdf" }, { name: "Index.pdf" }];
    expect(docsTitledIn("- **E2G Piping Specs (All)** — the Class 150 sections", held, 1).map((d) => d.name)).toEqual(["E2G Piping Specs (All).pdf"]);
    expect(docsTitledIn("see the index of classes", held, 1)).toEqual([]);
  });
});
