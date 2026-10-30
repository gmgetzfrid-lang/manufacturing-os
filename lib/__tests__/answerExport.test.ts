// Tests for the email/print export of a library answer and the answer
// parts it depends on (settle box, engineering trail, don't-miss lane,
// compliance verdicts, mode line).

import { describe, it, expect } from "vitest";
import { buildAnswerExport } from "../answerExport";
import { parseAnswerBlocks, structureAnswer, splitVerdict, extractAnswerMeta } from "../knowledgeText";
import type { KnowledgeAnswer } from "../knowledge";

const raw = [
  "**Mode:** compliance",
  "**Answering for:** 304 stainless · welded = seam welded at the mill · line 73-VR-1004",
  "**Answer:** DOES NOT COMPLY - line class **1S4** calls for seamless A312 only, and welded pipe was installed [3].",
  "**To settle this:**",
  "- **ASME B31.3 Table A-1B** - EP 5-2-1 §2.0 invokes it; it gives the joint factor [1].",
  "- **Best answer with what I have:** it does not comply unless the Owner's Engineer approves a deviation.",
  "**Why:**",
  "- **Requirement:** seamless A312 TP304 [3] - **Found:** seam-welded A312 - **Gap:** product form",
  "**Engineering trail:**",
  "- **EP 5-2-1 Table 1** → austenitic Cr-Ni → Table 4 [1]",
  "- **Line class 1S4** → seamless only [3]",
  "**Before you act:**",
  "- **Approval:** submit a deviation request [3].",
  "**Don't miss:**",
  "- Sour service: hardness limits still apply [2].",
  "- second item [2].",
  "- third item that should overflow [2].",
].join("\n");

describe("answer parts", () => {
  it("reads the mode line and compliance verdict", () => {
    const meta = extractAnswerMeta(raw);
    expect(meta.mode).toBe("compliance");
    expect(meta.answer.startsWith("**Answering for:**")).toBe(false);
    const parts = structureAnswer(parseAnswerBlocks(meta.answer), meta.mode);
    expect(splitVerdict(parts.hero ?? "").verdict).toBe("fails");
    expect(parts.settle).toHaveLength(2);
    expect(parts.trail.filter((b) => b.type === "bullet")).toHaveLength(2);
    expect(parts.why).toHaveLength(1);
    expect(parts.dontMiss).toHaveLength(2);
    expect(parts.more.some((b) => b.text.includes("third item"))).toBe(true);
  });

  it("knows the other compliance verdicts", () => {
    expect(splitVerdict("COMPLIES - all welds per EP 5-5-1 [2].").verdict).toBe("complies");
    expect(splitVerdict("CAN'T DETERMINE - the line class isn't loaded.").verdict).toBe("undetermined");
  });
});

describe("buildAnswerExport", () => {
  const meta = extractAnswerMeta(raw);
  const answer: KnowledgeAnswer = {
    answer: meta.answer, answeringFor: meta.answeringFor, answerMode: "compliance",
    provider: "anthropic", model: "m", mode: "library",
    citations: [
      { n: 1, documentName: "EP-5-2-1.pdf", page: 17, section: "14.0 TABLES", role: "context",
        quote: "Austenitic (Cr-Ni) Steel Table 4", highlight: "Austenitic (Cr-Ni) Steel Table 4" },
      { n: 3, documentName: "EP-5-2-3", page: 40, role: "decides", claim: "1S4 is seamless only",
        quote: "Pipe: ASTM A312 TP304 Seamless", highlight: "ASTM A312 TP304 Seamless" },
    ],
  };
  const exp = buildAnswerExport("Did they install the right pipe?", answer);
  const at = (needle: string) => { const i = exp.html.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  it("puts the verdict banner first and the deciding proof right under the answer", () => {
    expect(at("DOES NOT COMPLY")).toBeLessThan(at("THE REQUIREMENT - QUOTED"));
    expect(at("THE REQUIREMENT - QUOTED")).toBeLessThan(at("1S4 is seamless only"));
    expect(at("1S4 is seamless only")).toBeLessThan(at("TO SETTLE THIS"));
    expect(at("ENGINEERING TRAIL")).toBeLessThan(at("SUPPORTING PASSAGES"));
    expect(at("SUPPORTING PASSAGES")).toBeLessThan(at("EP-5-2-1 · p.17"));
  });

  it("marks the deciding words and tags each quote with document and page", () => {
    expect(exp.html).toContain(">ASTM A312 TP304 Seamless</span>");
    expect(exp.html).toContain("[3] EP-5-2-3 · p.40");
  });

  it("marks an uncited claim NO SOURCE in both versions, but not a settle-this request", () => {
    const e = buildAnswerExport("q", { ...answer, answer: [
      "**Answer:** NOT SETTLED - the library gives the rule but not its reason [3].",
      "**To settle this:**",
      "- **ASME B31.3** - EP 5-2-1 references it [1].",
      "- **The standard's basis document** - explains why the rule exists.",
      "**Why:**",
      "- Fillet welds in a fitting transition can't be examined.",
    ].join("\n") });
    expect(e.html.match(/NO SOURCE/g)).toHaveLength(1);
    expect(e.text).toContain("1. Fillet welds in a fitting transition can't be examined. [NO SOURCE]");
    expect(e.text).toContain("- The standard's basis document - explains why the rule exists.\n");
  });

  it("is table-based with inline styles only (what Outlook and Gmail keep)", () => {
    expect(exp.html.startsWith("<table")).toBe(true);
    expect(exp.html).not.toMatch(/<style|class=|display:flex/);
  });

  it("escapes HTML and renders markup, not raw asterisks", () => {
    const e = buildAnswerExport("<script>", { ...answer, answer: "**Answer:** YES - **bold** `1S4` [1][3]." });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("<b>bold</b>");
    expect(e.html).not.toMatch(/\*\*/);
    expect(e.html).toContain(">[1, 3]</sup>");
  });

  it("has a readable plain-text version for clients that drop HTML", () => {
    expect(exp.text).toMatch(/^QUESTION: Did they install the right pipe\?/);
    expect(exp.text).toContain("DOES NOT COMPLY - line class 1S4 calls for seamless A312 only");
    expect(exp.text.indexOf("THE PROOF")).toBeLessThan(exp.text.indexOf("TO SETTLE THIS"));
    expect(exp.text).toContain("[3] 1S4 is seamless only - EP-5-2-3 · p.40");
    expect(exp.text).toContain('"ASTM A312 TP304 Seamless"');
  });
});

describe("web sources in the export", () => {
  it("lists them apart from the documents, with link and quoted text", () => {
    const e = buildAnswerExport("q", {
      answer: "**Answer:** NO - the library prohibits it [1]; ASME explains the reason [2].",
      provider: "anthropic", model: "m", mode: "library", knowledgeSource: "documents_and_web",
      citations: [
        { n: 1, documentName: "EP-5-2-2", page: 6, role: "decides", quote: "Slip-on flanges shall not be attached directly to fittings.", highlight: "Slip-on flanges shall not be attached directly to fittings" },
        { n: 2, url: "https://www.asme.org/x", title: "ASME - flange attachment", quote: "Slip-on flanges require straight pipe." },
      ],
    });
    expect(e.html.indexOf("THE PROOF")).toBeLessThan(e.html.indexOf("FROM THE WEB"));
    expect(e.html).toContain('href="https://www.asme.org/x"');
    expect(e.text).toContain('[2] ASME - flange attachment - https://www.asme.org/x');
    expect(e.text).toContain('"Slip-on flanges require straight pipe."');
  });
});
