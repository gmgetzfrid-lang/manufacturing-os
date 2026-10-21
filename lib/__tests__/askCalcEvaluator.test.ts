// intelligence Round G (I-33 DETERMINISTIC CALCULATION EVALUATOR) — PR-13,
// PR-9 done-when 2: the ask route computes a Substituted line's result on
// the server from the answer's own cited inputs and shows it labelled as
// computed by the app; anything it cannot parse, bind or reconcile adds
// nothing and the I-25 withholding net stands. Pure evaluator cases, then
// the route driven under mock (askRouteHarness.ts), then the page.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { resetDb, rowsOf, type Row } from "./knowledgeFakeDb";
import { h, resetHarness, baseTables, kdoc, kchunk, ORG, LIB } from "./askRouteHarness";

vi.mock("@/lib/supabaseAdmin", async () => ({ supabaseAdmin: (await import("./askRouteHarness")).adminStandIn }));
vi.mock("@/lib/ai/providerCall", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/providerCall")>()),
  callAiModel: vi.fn(async (input: { system: string; user: string; maxTokens?: number; images?: unknown[] }) =>
    (await import("./askRouteHarness")).scriptedCall(input)),
}));
vi.mock("@/lib/ai/embeddings", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/embeddings")>();
  const harness = await import("./askRouteHarness");
  return {
    ...real,
    embedPassages: vi.fn(async (req: { provider: string; model: string; passages: readonly string[] }) => harness.scriptedEmbed(req)),
    embedQuery: vi.fn(async (provider: string, model: string, _key: string, q: string) =>
      (await harness.scriptedEmbed({ provider, model, passages: [q] })).vectors[0]),
  };
});
vi.mock("@/lib/knowledgePageRender", () => ({ renderKnowledgePages: vi.fn(async () => []), MAX_DEEP_READ_PAGES: 6 }));
vi.mock("@/lib/codebookServer", async () => ({
  loadCodebookAdmin: vi.fn(async () => ({ legendDocIds: (await import("./askRouteHarness")).h.legendDocIds })),
  codebookToDecoderText: () => "",
}));
vi.mock("@/lib/aiInstructionsServer", () => ({ loadOrgInstructionsBlock: vi.fn(async () => "") }));
vi.mock("@/lib/answerSkillsServer", async () => {
  const harness = await import("./askRouteHarness");
  return {
    loadAnswerSkillsBlock: vi.fn(async () => harness.h.skills.block),
    loadAnswerSkills: vi.fn(async () => harness.h.skills),
  };
});
vi.mock("@/lib/knowledgeTagResolve", () => ({ resolveTagAgainstIndex: vi.fn(async (_o: string, t: string) => ({ resolved: t })) }));
vi.mock("@/lib/ai/keyVault", () => ({ openAiKey: (k: string | null) => k }));
// (I-33 fix pass 5) The evaluator's entry point, passed through unchanged
// unless a test makes it throw (the route's fail-safe).
vi.mock("@/lib/knowledgeAskGuards", async (orig) => {
  const real = await orig<typeof import("@/lib/knowledgeAskGuards")>();
  return { ...real, presentComputedResults: vi.fn(real.presentComputedResults) };
});

import { POST } from "@/app/api/knowledge/ask/route";
import {
  evaluateSubstitutedLine, presentComputedResults, withoutComputedLines, withholdModelResults, formatComputed,
  neutralizeComputedLabels, answerHasComputation,
  COMPUTED_LABEL, COMPUTED_DISAGREES_NOTE, COMPUTED_TOLERANCE, RESULT_WITHHELD, RESULT_WITHHELD_NOTE, CUT_OFF_LINE,
  AI_WRITTEN_LABEL, RESULT_WITHHELD_COMPUTED_NOTE, RESULT_WITHHELD_TITLE, RESULT_WITHHELD_COMPUTED_TITLE, hasComputedLine,
  type CalcSources,
} from "@/lib/knowledgeAskGuards";

const root = resolve(__dirname, "..", "..");
const guardsSrc = readFileSync(resolve(root, "lib/knowledgeAskGuards.ts"), "utf8");
const routeSrc = readFileSync(resolve(root, "app/api/knowledge/ask/route.ts"), "utf8");
const pageSrc = readFileSync(resolve(root, "app/(protected)/knowledge/[id]/page.tsx"), "utf8");

const sources = (cited: Record<number, string>, user = ""): CalcSources =>
  ({ cited: new Map(Object.entries(cited).map(([k, v]) => [Number(k), v])), user });
/** The hydrotest library's sources: the cited factor and the asker's pressure. */
const HYDRO = sources({ 1: "The hydrostatic test pressure shall be 1.5 times the design pressure." }, "design pressure = 285 psig");
const okValue = (line: string, s: CalcSources = HYDRO) => {
  const r = evaluateSubstitutedLine(line, s);
  return r.ok ? r.step.display : `refused: ${r.reason}`;
};
const refused = (line: string, s: CalcSources = HYDRO) => {
  const r = evaluateSubstitutedLine(line, s);
  return r.ok ? null : r.reason;
};
const computedOf = (answer: string): string[] => answer.split("\n")
  .filter((l) => l.startsWith(`**${COMPUTED_LABEL}**`))
  .map((l) => /`([^`]+)`/.exec(l)?.[1] ?? "");

// ── The evaluator (pure) ─────────────────────────────────────────────────

describe("PR-13 (I-33) — the evaluator: a hand-written parser, every operand bound to a cited input, units checked", () => {
  it("the protocol's own line: P_T = 1.5 × 285 psig is 427.5 psig, in the operand's unit, each input named with its source", () => {
    const r = evaluateSubstitutedLine("**Substituted:** P_T = 1.5 × `285 psig`", HYDRO);
    expect(r).toEqual({
      ok: true,
      step: {
        symbol: "P_T", value: 427.5, unit: "psig", display: "427.5 psig", model: null, resultStart: -1, resultEnd: -1,
        inputs: [{ text: "1.5", source: "[1]" }, { text: "285 psig", source: "your value" }],
      },
    });
  });

  it.each([
    ["×", "1.5 × 285 psig"], ["x", "1.5 x 285 psig"], ["*", "1.5 * 285 psig"], ["·", "1.5 · 285 psig"],
    ["⋅", "1.5 ⋅ 285 psig"], ["∙", "1.5 ∙ 285 psig"], ["✕", "1.5 ✕ 285 psig"], ["✖", "1.5 ✖ 285 psig"],
    ["⨯ (PR-13 gap)", "1.5 ⨯ 285 psig"], ["• (PR-13 gap)", "1.5 • 285 psig"], ["∗ (PR-13 gap)", "1.5 ∗ 285 psig"],
    ["times", "1.5 times 285 psig"], ["multiplied by", "1.5 multiplied by 285 psig"],
    ["implicit after a bare factor (PR-13 gap)", "1.5 (285 psig)"], ["implicit between brackets", "(285 psig)(1.5)"],
    ["a citation after an operand", "1.5 [1] × `285 psig`"], ["value chips and bold", "**1.5** × `285 psig`"],
  ])("operator variant %s", (_v, expr) => {
    expect(okValue(`**Substituted:** P_T = ${expr}`)).toBe("427.5 psig");
  });

  it.each([
    ["/", "285 psig / 2"], ["÷", "285 psig ÷ 2"], ["divided by", "285 psig divided by 2"],
  ])("division variant %s", (_v, expr) => {
    expect(okValue(`**Substituted:** P = ${expr}`, sources({ 1: "half, so divide by 2" }, "285 psig"))).toBe("142.5 psig");
  });

  it.each([
    ["=", "="], ["＝ (fullwidth)", "＝"], ["﹦ (small, PR-13 gap)", "﹦"], ["≈", "≈"], ["≃", "≃"], ["≅ (PR-13 gap)", "≅"],
    ["≒ (PR-13 gap)", "≒"], ["→", "→"], ["⇒", "⇒"], ["equals", "equals"], ["is", "is"], ["gives", "gives"], ["yields", "yields"],
  ])("terminator variant %s: the model's own result after it is found and compared", (_v, term) => {
    const r = evaluateSubstitutedLine(`**Substituted:** P_T = 1.5 × 285 psig ${term} 427.5 psig`, HYDRO);
    expect(r.ok && r.step.display).toBe("427.5 psig");
    expect(r.ok && r.step.model).toEqual({ text: "427.5 psig", agrees: true });
    expect(r.ok && r.step.resultStart).toBeGreaterThan(0);
  });

  it(`the model's result agrees within ${COMPUTED_TOLERANCE * 100} % (three significant figures) and disagrees past it`, () => {
    const at = (m: string) => {
      const r = evaluateSubstitutedLine(`**Substituted:** P_T = 1.5 × 285 psig = ${m}`, HYDRO);
      return r.ok ? r.step.model?.agrees : "refused";
    };
    expect(at("428 psig")).toBe(true);
    expect(at("427.5 psig")).toBe(true);
    expect(at("2.948 MPa")).toBe(true); // the same pressure in another unit
    expect(at("430 psig")).toBe(false);
    expect(at("285 psig")).toBe(false);
    // (I-33 fix pass 2) A result in another dimension is a unit mismatch the
    // evaluator cannot reconcile: the line is refused (the number withheld).
    expect(at("427.5 in")).toBe("refused");
  });

  it("the B31.3 wall-thickness form: implicit products, nested brackets, a sum of a plain stress and a gauge pressure — the result in inches", () => {
    const s = sources({ 2: "t = PD / 2(SEW + PY) where E = 1.0 and Y = 0.4. Table A-1: S = 20,000 psi" }, "P = 285 psig, D = 10.75 in");
    const r = evaluateSubstitutedLine("**Substituted:** t = (285 psig)(10.75 in) / (2 × (20,000 psi × 1.0 + 285 psig × 0.4)) = 0.0763 in [2]", s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.step.unit).toBe("in");
    expect(r.step.value).toBeCloseTo(285 * 10.75 / (2 * (20000 + 285 * 0.4)), 12);
    expect(r.step.display).toBe("0.0761596 in");
    expect(r.step.model).toEqual({ text: "0.0763 in", agrees: true });
  });

  it.each([
    ["bar(g)", "**Substituted:** P_T = 1.5 × 19.65 bar(g)", "19.65 bar(g)", "29.475 bar(g)"],
    ["bar (g) — a spaced suffix (PR-13 gap)", "**Substituted:** P_T = 1.5 × 19.65 bar (g)", "19.65 bar (g)", "29.475 bar (g)"],
    ["bar(abs) (PR-13 gap)", "**Substituted:** P_T = 1.5 × 20 bar(abs)", "20 bar(abs)", "30 bar(abs)"],
    ["mm² (PR-13 gap)", "**Substituted:** A = 2 × 10 mm²", "10 mm², 2", "20 mm²"],
    ["lbf/in²", "**Substituted:** P_T = 1.5 × 285 lbf/in²", "285 lbf/in²", "427.5 lbf/in²"],
    ["N/mm²", "**Substituted:** S_T = 1.5 × 138 N/mm²", "138 N/mm²", "207 N/mm²"],
    ["kg/m3", "**Substituted:** ρ_T = 1.1 × 1000 kg/m3", "1.1, 1000 kg/m3", "1,100 kg/m3"],
    ["a result in a unit no operand carries is refused, never guessed", "**Substituted:** m = 1000 kg/m3 × 2 m3", "1000 kg/m3, 2 m3",
      "refused: a result in a unit no operand carries"],
  ])("unit variant %s", (_v, line, cited, shown) => {
    expect(okValue(line, sources({ 1: `factor 1.5; ${cited}` }))).toBe(shown);
  });

  it("an operand binds to the same quantity written in another unit ('20 ksi' against a passage's '20,000 psi'), and the result is in the first operand's unit", () => {
    const s = sources({ 1: "Allowable stress 20,000 psi; test factor 1.5" });
    expect(okValue("**Substituted:** S_T = 1.5 × 20 ksi", s)).toBe("30 ksi");
    expect(okValue("**Substituted:** S_T = 1.5 × 137.9 MPa", s)).toBe("refused: an operand no cited source holds: 137.9 MPa");
    // N/mm² and MPa are one quantity.
    expect(okValue("**Substituted:** S_T = 1.5 × 138 MPa", sources({ 1: "S = 138 N/mm²; factor 1.5" }))).toBe("207 MPa");
  });

  it("units of one dimension are reconciled exactly before they are summed or divided (psi with ksi, in with mm)", () => {
    const s = sources({ 1: "20 ksi, 500 psi, 2 in, 25.4 mm" });
    expect(okValue("**Substituted:** S = 20 ksi + 500 psi", s)).toBe("20.5 ksi");
    expect(okValue("**Substituted:** r = 2 in / 25.4 mm", s)).toBe("2");
  });

  it.each([
    ["a space", "1 600 kPa"], ["a no-break space", "1 600 kPa"], ["a narrow no-break space", "1 600 kPa"],
    ["a thin space", "1 600 kPa"], ["a comma", "1,600 kPa"],
  ])("SI digit grouping with %s is one number", (_v, value) => {
    expect(okValue(`**Substituted:** P_T = 1.43 × ${value}`, sources({ 1: "PT = 1.43 PS" }, "PS = 1 600 kPa"))).toBe("2,288 kPa");
  });

  it("an exponent number and a power: 1.5e3 and (2 in)^2", () => {
    expect(okValue("**Substituted:** F = 1.5e3 N × 2", sources({ 1: "load 1500 N, 2 bolts" }))).toBe("3,000 N");
    // A result whose unit no operand carries (in² from "2 in") is not shown: refused, never guessed.
    expect(okValue("**Substituted:** A = (2 in)^2", sources({ 1: "side 2 in, squared: exponent 2" }))).toBe("refused: a result in a unit no operand carries");
    expect(okValue("**Substituted:** A = (2 in)^2 / 1 in", sources({ 1: "side 2 in, squared: exponent 2, per 1 in" }))).toBe("4 in");
  });

  it("a later step binds to the value an earlier step computed — never to the model's own number", () => {
    const s = sources({ 1: "PT = 1.5 P; t = PT D / 2 S" }, "P = 285 psig, D = 10.75 in, S = 20,000 psi");
    const model = "**Substituted:** P_T = 1.5 × 285 psig\n**Substituted:** t = 427.5 psig × 10.75 in / (2 × 20,000 psi)";
    const out = presentComputedResults(model, model, s);
    expect(computedOf(out.text)).toEqual(["427.5 psig", "0.114891 in"]);
    expect(out.text).toContain("427.5 psig, an earlier step the app computed");
    // The model's own rounded 428 is not the server's 427.5: step 2 is not computed.
    const off = "**Substituted:** P_T = 1.5 × 285 psig\n**Substituted:** t = 428 psig × 10.75 in / (2 × 20,000 psi)";
    expect(computedOf(presentComputedResults(off, off, s).text)).toEqual(["427.5 psig"]);
  });

  describe("fail-safe: anything it cannot do adds nothing", () => {
    it.each([
      ["an operand no cited source holds", "**Substituted:** P_T = 1.5 × 300 psig", "an operand no cited source holds: 300 psig"],
      ["an operand citing a source that does not hold it", "**Substituted:** P_T = 1.5 [1] × 1.25", "an operand no cited source holds: 1.25"],
      ["an operand citing a source the answer was not given", "**Substituted:** P_T = 1.5 [7] × 285 psig", "an operand citing a source the answer was not given"],
      ["a temperature", "**Substituted:** T = 1.5 × 285 °F", "a temperature (a scale with an offset is never worked)"],
      ["a division by zero", "**Substituted:** P = 285 psig / (1.5 - 1.5)", "a division by zero"],
      ["a sum of two dimensions", "**Substituted:** P = 285 psig + 1.5 in", "an operand no cited source holds: 1.5 in"],
      ["an ambiguous a / b × c", "**Substituted:** P = 285 psig / 1.5 × 1.5", "an ambiguous division: a / b × c"],
      ["an ambiguous a / (b)(c)", "**Substituted:** P = (285 psig) / (1.5)(1.5)", "an ambiguous division: a / b × c"],
      ["an unclosed bracket", "**Substituted:** P = 1.5 × (285 psig", "an unclosed bracket"],
      ["a hyphen range", "**Substituted:** P = 1,600-2,288 kPa", "no worked expression on the line"],
      ["an en dash", "**Substituted:** P = 285 psig – 1.5", "no worked expression on the line"],
      ["a unit the evaluator does not know", "**Substituted:** P = 1.5 × 285 widgets", "no worked expression on the line"],
      ["'lb' (mass or force?)", "**Substituted:** F = 1.5 × 285 lb", "no worked expression on the line"],
      ["prose it cannot account for", "**Substituted:** P_T = 1.5 × 285 psig plus a margin", "no worked expression on the line"],
      ["a symbol left in the formula", "**Substituted:** P_T = 1.5 × P", "no worked expression on the line"],
      ["a lone value (nothing worked)", "**Substituted:** P = 285 psig", "no worked expression on the line"],
      ["a decimal comma", "**Substituted:** P_T = 1,5 × 285 psig", "no worked expression on the line"],
      ["a power of a unit that is not a small whole number", "**Substituted:** A = (285 psig)^1.5", "a unit raised to a power that is not a small whole number"],
    ])("%s", (_v, line, reason) => {
      expect(refused(line)).toBe(reason);
    });

    it("gauge and absolute pressure never mix; a pressure summed across references is never shown as a pressure", () => {
      const s = sources({ 1: "285 psig, 14.7 psi, 299.7 psia, factor 1.5" });
      expect(refused("**Substituted:** P = 299.7 psia - 285 psig", s)).toBe("gauge and absolute pressure in one expression");
      // 285 psig + 14.7 psi would be labelled "psig" while it is absolute.
      expect(refused("**Substituted:** P_abs = 285 psig + 14.7 psi", s)).toBe("a pressure summed across gauge, absolute or plain units");
      // The same mixed sum consumed by a division (the B31.3 shape) is a length, not a pressure: fine.
      expect(okValue("**Substituted:** r = 285 psig / (14.7 psi + 285 psig)", s)).toBe("0.950951");
    });

    it("a non-finite result is refused", () => {
      expect(refused("**Substituted:** x = 1e300 × 1e300", sources({ 1: "1e300 is not printed; 1E300 neither" }))).toMatch(/operand no cited source|not a finite number/);
      expect(refused("**Substituted:** x = 9e307 × 9e307 × 9e307", sources({ 1: "values 9e307" }))).toMatch(/operand no cited source|not a finite number/);
    });

    it("bounds: a line past 600 characters, brackets nested past 12, and more than 20 Substituted lines are not evaluated", () => {
      expect(refused(`**Substituted:** P = 1.5 × 285 psig${" ".repeat(600)}`)).toBe("a line longer than the evaluator reads");
      const deep = `**Substituted:** P = ${"(".repeat(13)}1.5 × 285 psig${")".repeat(13)}`;
      expect(refused(deep)).toBe("brackets nested too deep");
      const many = Array.from({ length: 25 }, () => "**Substituted:** P_T = 1.5 × 285 psig").join("\n");
      expect(computedOf(presentComputedResults(many, many, HYDRO).text)).toHaveLength(20);
    });

    it("a number an identifier owns never binds an operand ('Class 300', 'UG-99', 'B31.3', '§345.4', a citation marker, '341.4.1')", () => {
      const s = sources({ 1: "Class 300 flanges per UG-99 and ASME B31.3 §345.4 [2], para 341.4.1; factor 1.5" });
      for (const v of ["300", "300 psig", "99", "31.3", "345.4", "2", "4.1"]) {
        expect(refused(`**Substituted:** P = 1.5 × ${v}`, s)).toBe(`an operand no cited source holds: ${v}`);
      }
      // The same value printed as a value binds.
      expect(okValue("**Substituted:** P = 1.5 × 300 psig", sources({ 1: "factor 1.5; rating 300 psig" }))).toBe("450 psig");
    });

    it("the evaluator runs no code: no eval, no Function, no dependency — only its own tokenizer, which refuses anything else", () => {
      const evaluator = guardsSrc.slice(guardsSrc.indexOf("PR-13 (intelligence I-33; DEC-90 A17's later path)"));
      expect(evaluator).not.toMatch(/\beval\s*\(|new\s+Function|\bFunction\s*\(|require\s*\(|import\s*\(/);
      // The module's one import is the drawing-text helpers it had before I-33.
      expect(guardsSrc.split("\n").filter((l) => /^import /.test(l)))
        .toEqual(['import { refSeries, sheetDrawingNumbers } from "@/lib/drawingText";']);
      for (const hostile of ["1.5 × constructor", "1.5 × process.exit(1)", "1.5 × (()=>285)()", "1.5 × `${285}`", "1.5 × 0x11D"]) {
        expect(refused(`**Substituted:** P = ${hostile}`)).toBe("no worked expression on the line");
      }
    });

    it("the evaluator is fast enough for a whole answer: 20 long Substituted lines in well under a second", () => {
      const line = `**Substituted:** P = ${Array.from({ length: 70 }, () => "1.5").join(" × ")}`;
      const answer = Array.from({ length: 20 }, () => line).join("\n");
      const t0 = performance.now();
      presentComputedResults(answer, answer, HYDRO);
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  });

  it("formatComputed: six significant figures, thousands grouped, no trailing zeros", () => {
    expect(formatComputed(427.5)).toBe("427.5");
    expect(formatComputed(0.07615964005)).toBe("0.0761596");
    expect(formatComputed(30000)).toBe("30,000");
    expect(formatComputed(-1234.5678)).toBe("-1,234.57");
    expect(formatComputed(0)).toBe("0");
    expect(formatComputed(1.5e-9)).toBe("1.5e-9");
  });
});

// ── The presentation (pure) ──────────────────────────────────────────────

describe("PR-13 (I-33) — presentComputedResults: adds the server's value, never un-withholds the model's", () => {
  const MODEL =
    "**Answer:** Compute P_T from the substituted expression below [1].\n" +
    "- P = `285 psig` (USER-PROVIDED)\n" +
    "**Substituted:** P_T = 1.5 × `285 psig`\n" +
    "**Check:** the 1.5 factor on page 4 [1].";
  const LINE = `**${COMPUTED_LABEL}** P_T is \`427.5 psig\` — evaluated on the server from the Substituted expression above, ` +
    "each input matched to its source (1.5 [1]; 285 psig, your value); not the AI's arithmetic.";

  it("the computed line goes right under the Substituted line; nothing else changes", () => {
    const out = presentComputedResults(MODEL, MODEL, HYDRO);
    expect(out).toEqual({ text: MODEL.replace("`285 psig`\n**Check", `\`285 psig\`\n${LINE}\n**Check`), computed: 1, disagreed: 0 });
    expect(withoutComputedLines(out.text)).toBe(MODEL);
  });

  it("the model's own result stays withheld when it agrees, and when it differs the answer says so and withholds it wherever else it is written", () => {
    const agree = MODEL.replace("`285 psig`\n**Check", "`285 psig` = `427.5 psig`\n**Check");
    const shownA = withholdModelResults(agree, "design pressure = 285 psig\n1.5 times").text;
    const a = presentComputedResults(agree, shownA, HYDRO);
    expect(a.disagreed).toBe(0);
    expect(withoutComputedLines(a.text)).not.toContain("427.5");
    expect(a.text).toContain(`**Substituted:** P_T = 1.5 × \`285 psig\` = ${RESULT_WITHHELD}`);
    expect(computedOf(a.text)).toEqual(["427.5 psig"]);

    // The model's 430 psig, written after a terminator the net does not read
    // ("≅") and also printed by a passage (so rule (c) let it stand) — it
    // differs from 427.5 psig.
    const differ = "**Answer:** The test pressure is `430 psig` [1].\n- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × `285 psig` ≅ `430 psig`\n**Check:** the factor [1].";
    const shownD = withholdModelResults(differ, "design pressure = 285 psig\n1.5 times\nrelief set at 430 psig").text;
    expect(shownD).toContain("The test pressure is `430 psig` [1]"); // the I-25 net's coincidence gap
    const d = presentComputedResults(differ, shownD, HYDRO);
    expect(d.disagreed).toBe(1);
    expect(d.text).not.toContain("430");
    expect(d.text).toContain(`**Answer:** The test pressure is ${RESULT_WITHHELD} [1].`);
    expect(d.text.split("\n")).toContain(COMPUTED_DISAGREES_NOTE);
    expect(d.text.split("\n").indexOf(COMPUTED_DISAGREES_NOTE)).toBe(d.text.split("\n").findIndex((l) => l.startsWith(`**${COMPUTED_LABEL}**`)) + 1);
  });

  it("PR-13 gap closed on a Substituted line: a result after '≅' that a passage happens to print is withheld (the net left it shown)", () => {
    const model = "- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig` ≅ 427.5 psig";
    const shown = withholdModelResults(model, "285 psig 1.5 427.5 psig").text;
    expect(shown).toBe(model); // I-25: the terminator is not read and 427.5 psig is grounded
    const out = presentComputedResults(model, shown, HYDRO);
    expect(out.text.split("\n")[1]).toBe(`**Substituted:** P_T = 1.5 × \`285 psig\` ≅ ${RESULT_WITHHELD}`);
    // (I-33 fix pass 2) The app computed a value: the note says so.
    expect(out.text.endsWith(RESULT_WITHHELD_COMPUTED_NOTE)).toBe(true);
    // The same when nothing can be computed (an operand unbound): still withheld.
    const unbound = presentComputedResults(model, shown, sources({}, ""));
    expect(unbound.computed).toBe(0);
    expect(unbound.text.split("\n")[1]).toBe(`**Substituted:** P_T = 1.5 × \`285 psig\` ≅ ${RESULT_WITHHELD}`);
  });

  it("REGRESSION: an input clause after the model's result keeps its input; only the result is withheld (as the I-25 net does)", () => {
    const model = "- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × P = 1.5 × 285 psig = 427.5 psig (where P = 285 psig is the design pressure)";
    const shown = withholdModelResults(model, "design pressure = 285 psig\n1.5 times").text;
    const out = presentComputedResults(model, shown, HYDRO).text;
    expect(out.split("\n")[1]).toBe(
      `**Substituted:** P_T = 1.5 × P = 1.5 × 285 psig = ${RESULT_WITHHELD} (where P = 285 psig is the design pressure)`);
    expect(computedOf(out)).toEqual(["427.5 psig"]);
    // The same with the result after a terminator the net does not read.
    const variant = model.replace("= 427.5 psig (where", "≅ 427.5 psig (where");
    const shownV = withholdModelResults(variant, "design pressure = 285 psig\n1.5 times\n427.5 psig").text;
    expect(presentComputedResults(variant, shownV, HYDRO).text.split("\n")[1]).toBe(
      `**Substituted:** P_T = 1.5 × P = 1.5 × 285 psig ≅ ${RESULT_WITHHELD} (where P = 285 psig is the design pressure)`);
  });

  it("a differing model result equal to one of the line's inputs is never spread (the input stays everywhere)", () => {
    const model = "**Answer:** The design pressure is `285 psig` [1].\n**Substituted:** P_T = 1.5 × 285 psig ≅ 285 psig";
    const out = presentComputedResults(model, withholdModelResults(model, "285 psig 1.5").text, HYDRO).text;
    expect(out.split("\n")[0]).toBe("**Answer:** The design pressure is `285 psig` [1].");
    expect(out.split("\n")[1]).toBe(`**Substituted:** P_T = 1.5 × 285 psig ≅ ${RESULT_WITHHELD}`);
    expect(out.split("\n")).toContain(COMPUTED_DISAGREES_NOTE);
  });

  it("REGRESSION: an answer with no Substituted line — a lookup, prose arithmetic, a worked chain — is the very same string", () => {
    for (const text of [
      "**Answer:** Torque the bolts to `250 ft-lb` [1].\n**Basis:**\n- Use **3/4 in** bolts; torque = `250 ft-lb` [2]",
      "**Answer:** `285 psig` [1].\n**Basis:**\n- Class 150 [1] / 100 °F [1] = 285 psig",
      "**Answer:** The factor is 1.5 [1]. For your vessel the test pressure is 428 psig.",
      "**Answer:** The test pressure is 1.5 times the design pressure of 285 psig [1], so [result withheld].",
      "- P_T = 1.5 × `285 psig` = [result withheld] [1]\n\n" + RESULT_WITHHELD_NOTE,
      "",
    ]) {
      const out = presentComputedResults(text, text, HYDRO);
      expect(out.text).toBe(text);
      expect(out.computed).toBe(0);
      expect(withoutComputedLines(text)).toBe(text);
    }
  });

  it("the page's own pass changes nothing the server presented (idempotent), so a reopened answer shows the same", () => {
    for (const model of [MODEL, MODEL.replace("`285 psig`\n**Check", "`285 psig` = `430 psig`\n**Check")]) {
      const shown = withholdModelResults(model, "design pressure = 285 psig\n1.5 times").text;
      const out = presentComputedResults(model, shown, HYDRO).text;
      expect(withholdModelResults(out)).toEqual({ text: out, withheld: 0 });
    }
  });

  it("withoutComputedLines takes out only the evaluator's lines", () => {
    const out = presentComputedResults(MODEL.replace("`285 psig`\n**Check", "`285 psig` = 430 psig\n**Check"),
      withholdModelResults(MODEL.replace("`285 psig`\n**Check", "`285 psig` = 430 psig\n**Check"), "285 psig 1.5").text, HYDRO).text;
    expect(out).toContain(COMPUTED_DISAGREES_NOTE);
    expect(withoutComputedLines(out)).not.toContain(COMPUTED_LABEL);
    expect(withoutComputedLines(out)).not.toContain(COMPUTED_DISAGREES_NOTE);
    expect(withoutComputedLines(out)).toContain("**Check:** the 1.5 factor on page 4 [1].");
  });
});

// ── The net's hyphen-range shape (seen at the I-25 merge) ─────────────────

describe("PR-13 (I-33) — the hyphen range: '1,600-2,288 kPa' withholds the range end whole, never '1,600-2,[result withheld]'", () => {
  const marked = (line: string) => `**Substituted:** P_T = 1.43 × \`1,600 kPa\` [1]\n${line}`;

  it("reproduction → fix: an ungrounded range end is withheld whole", () => {
    const r = withholdModelResults(marked("**Answer:** the test range is 1,600-2,288 kPa."), "PS = 1,600 kPa; PT = 1.43 PS");
    // 53b7973: "the test range is 1,600-2,[result withheld]."
    expect(r.text.split("\n")[1]).toBe(`**Answer:** the test range is 1,600-${RESULT_WITHHELD}.`);
    expect(r.text).not.toContain("2,");
  });

  it("a range the grounding prints is shown whole; SI-grouped too", () => {
    for (const range of ["1,600-2,288 kPa", "1 600-2 288 kPa"]) {
      const answer = marked(`**Answer:** the operating range is ${range} [1].`);
      const r = withholdModelResults(answer, `PS = 1,600 kPa; PT = 1.43 PS; operating range ${range}`);
      expect(r.text.split("\n")[1]).toBe(`**Answer:** the operating range is ${range} [1].`);
    }
  });

  it("REGRESSION: dates, identifiers and lookups with hyphens are untouched; an unmarked answer is byte-for-byte", () => {
    const lookup = "**Answer:** Per ASME B16.5-2017 Table 2-1.1 and V-101-2, issued 2026-10-01, the range is 150-300 psig [1].";
    expect(withholdModelResults(lookup)).toEqual({ text: lookup, withheld: 0 });
    const r = withholdModelResults(marked("Per ASME B16.5-2017 and V-101-2, issued 2026-10-01."), "PS = 1,600 kPa; PT = 1.43 PS");
    expect(r.text.split("\n")[1]).toBe("Per ASME B16.5-2017 and V-101-2, issued 2026-10-01.");
  });
});

// ── The route ────────────────────────────────────────────────────────────

const ask = (body: Record<string, unknown>) => POST(new NextRequest("http://x/api/knowledge/ask", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" },
  body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
}));
const QUERY_GEN = { text: '["hydrostatic test pressure", "design pressure"]', usage: { inputTokens: 300, outputTokens: 20 } };
const REFINE_NONE = { text: '{"queries": [], "missing_documents": []}', usage: { inputTokens: 500, outputTokens: 15 } };
const answerOf = (text: string, extra: Record<string, unknown> = {}) => ({ text, usage: { inputTokens: 4000, outputTokens: 180 }, ...extra });
const HYDRO_PASSAGE =
  "The relief valve set pressure shall not exceed the design pressure of the vessel. " +
  "The hydrostatic test pressure shall be 1.5 times the design pressure.";
function hydrotestLibrary(extra: Record<string, Row[]> = {}) {
  resetDb({
    ...baseTables(),
    knowledge_documents: [kdoc("k-std", { name: "Relief standard.pdf" })],
    knowledge_chunks: [
      kchunk("k-std", HYDRO_PASSAGE, { id: "c-1", page: 4, section: "5.1 Relief" }),
      kchunk("k-std", "Set pressure tolerance for relief devices is plus or minus three percent.", { id: "c-2", page: 5, section: "5.2 Tolerance" }),
    ],
    ...extra,
  });
}
const PROTOCOL =
  "**Answer:** Compute P_T from the substituted expression below [1].\n**Basis:**\n" +
  "- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`\n**Check:** the 1.5 factor on page 4 [1].";

beforeEach(() => {
  resetHarness();
});

describe("PR-13 / PR-9 done-when 2 (I-33) — the ask route presents the server's value, labelled; the withholding stays the fallback", () => {
  it("reproduction → fix: a protocol answer gains the server-computed value under its Substituted line — on the response and the row", async () => {
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(PROTOCOL)];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    // 53b7973 returned PROTOCOL unchanged: no value at all.
    expect(body.answer).toBe(PROTOCOL.replace("`285 psig`\n**Check",
      `\`285 psig\`\n**${COMPUTED_LABEL}** P_T is \`427.5 psig\` — evaluated on the server from the Substituted expression above, ` +
      "each input matched to its source (1.5 [1]; 285 psig, your value); not the AI's arithmetic.\n**Check"));
    expect(body.arithmetic).toBe("unverified");
    expect(body.citations.map((c: { n: number }) => c.n)).toEqual([1]);
    const row = rowsOf("knowledge_questions")[0];
    expect(row.answer).toBe(body.answer);
    expect(row.context).toMatchObject({ arithmetic: "unverified" });
  });

  it("the model's own differing result stays withheld everywhere, and the answer says it differs", async () => {
    hydrotestLibrary();
    const text = "**Answer:** The test pressure is `430 psig` [1].\n- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × `285 psig` = `430 psig`\n**Check:** the factor on page 4 [1].";
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    expect(body.answer).not.toContain("430");
    expect(computedOf(body.answer)).toEqual(["427.5 psig"]);
    expect(body.answer.split("\n")).toContain(COMPUTED_DISAGREES_NOTE);
    expect(body.answer.endsWith(RESULT_WITHHELD_COMPUTED_NOTE)).toBe(true);
    expect(body.answer).not.toContain(RESULT_WITHHELD_NOTE);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(body.answer);
  });

  it("fail-safe: an operand no cited source holds (the factor from an uncited passage) adds nothing — the I-25 answer, byte for byte", async () => {
    hydrotestLibrary();
    // The answer cites [2] (tolerance) only; the 1.5 factor's passage [1] is not cited.
    const text = "**Answer:** Compute it below [2].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`";
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    expect(body.answer).toBe(text);
    expect(computedOf(body.answer)).toEqual([]);
  });

  it("a cut-off answer is never evaluated (its expression may be cut short)", async () => {
    hydrotestLibrary();
    const text = "**Answer:** Compute it below [1].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`";
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text, { stopReason: "max_tokens" })];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    expect(body.partial).toBe(true);
    expect(body.answer).toBe(`${text}\n\n${CUT_OFF_LINE}`);
  });

  it("REGRESSION: a lookup answer and an answer with no Substituted line are returned and stored byte-for-byte", async () => {
    for (const text of [
      "**Answer:** The set pressure must not exceed the vessel design pressure [1].\n**Basis:**\n- Tolerance is plus or minus three percent [2].",
      "**Answer:** The factor is 1.5 [1]. For your vessel the test pressure is 428 psig.",
    ]) {
      resetHarness();
      hydrotestLibrary();
      h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
      const body = await (await ask({ question: "What is the hydrotest pressure for a 285 psig vessel?" })).json();
      expect(body.answer).toBe(text);
      expect(body.arithmetic).toBeUndefined();
      expect(rowsOf("knowledge_questions")[0].answer).toBe(text);
    }
  });

  it("a value an earlier answer's evaluator computed never grounds this answer's number (it never un-withholds a model number)", async () => {
    hydrotestLibrary();
    const earlier = presentComputedResults(PROTOCOL, PROTOCOL, HYDRO).text;
    expect(earlier).toContain("`427.5 psig`");
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(
      "**Answer:** As before, test at `427.5 psig` [1].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`")];
    const body = await (await ask({
      question: "And the test pressure again?", inputs: "design pressure = 285 psig",
      history: [{ question: "What is the hydrotest pressure?", answer: earlier }],
    })).json();
    expect(body.answer.split("\n")[0]).toBe(`**Answer:** As before, test at ${RESULT_WITHHELD} [1].`);
    expect(computedOf(body.answer)).toEqual(["427.5 psig"]);
  });

  it("the internet answer is unchanged: its branch never reaches the evaluator or the withholding (decision recorded in PR-13)", () => {
    const internet = routeSrc.slice(routeSrc.indexOf('if (mode === "internet") {'), routeSrc.indexOf("const arithmetic = "));
    const branch = internet.slice(0, internet.indexOf("\n  }\n"));
    expect(branch.length).toBeGreaterThan(200);
    expect(branch).not.toContain("presentComputedResults");
    expect(branch).not.toContain("withholdModelResults");
  });

  it("the route evaluates only after the net, on the model's own text, with the answer's cited passages (and their shown pages' text) and the asker's values", () => {
    expect(routeSrc).toMatch(/const modelText = answer;\s*answer = withholdModelResults\(answer, grounding\)\.text;/);
    expect(routeSrc).toMatch(/if \(!partial\) \{[\s\S]{0,600}extractCitationNumbers\(modelText\)[\s\S]{0,400}pageTextOf\.get\(`\$\{c\.document_id\}:\$\{c\.page\}`\)[\s\S]{0,500}presentComputedResults\(modelText, answer, \{ cited, user: `\$\{question\}\\n\$\{inputs\}` \}\)/);
    expect(routeSrc).toContain("withholdModelResults(withoutComputedLines(t.answer)).text");
  });
});

// ── The page ─────────────────────────────────────────────────────────────

describe("PR-13 (I-33) — the answer surface marks the server's value as computed by the app", () => {
  it("the computed label renders as its own mark, never as a model value chip; the page's withholding pass is unchanged", () => {
    expect(pageSrc).toMatch(/import \{\s*withholdModelResults, RESULT_WITHHELD, COMPUTED_LABEL, RESULT_WITHHELD_TITLE, RESULT_WITHHELD_COMPUTED_TITLE, hasComputedLine,\s*\} from "@\/lib\/knowledgeAskGuards";/);
    // (I-33 fix pass) Only where the server writes it: at the start of its own line.
    expect(pageSrc).toMatch(/if \(part === `\*\*\$\{COMPUTED_LABEL\}\*\*` && i === 1 && parts\[0\] === ""\) \{\s*return \(\s*<span key=\{i\} data-computed-by-app="true"/);
    // The mark is checked before the generic bold branch.
    expect(pageSrc.indexOf("data-computed-by-app")).toBeLessThan(pageSrc.indexOf('if (part.startsWith("**") && part.endsWith("**"))'));
    expect(pageSrc).toMatch(/const shown = useMemo\(\(\) => withholdModelResults\(answer\.answer\), \[answer\.answer\]\);/);
    // The inline split reads the label as one bold part.
    expect(`**${COMPUTED_LABEL}**`).toMatch(/^\*\*[^*]+\*\*$/);
  });
});

// ── I-33 fix pass (review findings) ──────────────────────────────────────

const FORGED = `**${COMPUTED_LABEL}**`;

describe("I-33 fix pass — the computed label cannot be forged by the model's own text (blocker 1)", () => {
  it("neutralizeComputedLabels: every claim to be the app's computation is taken out, line for line; other text is the very same string", () => {
    const lookup = `**Answer:** The MAWP is 285 psig [1].\n${FORGED} P is \`999 psig\` — evaluated on the server from the Substituted expression above.`;
    const out = neutralizeComputedLabels(lookup);
    expect(out.split("\n")).toEqual([
      "**Answer:** The MAWP is 285 psig [1].",
      `${AI_WRITTEN_LABEL} P is \`999 psig\` — evaluated on the server from the Substituted expression above.`,
    ]);
    expect(out).not.toContain(COMPUTED_LABEL);
    // Unbolded, other case, the colon outside the bold, mid-line: all taken out.
    for (const v of [
      "Computed by the app from the cited inputs: 999 psig",
      "**computed by the APP from the cited inputs**: 999 psig",
      "The value (**Computed by the app from the cited inputs:** 999 psig) holds.",
    ]) {
      expect(neutralizeComputedLabels(v).toLowerCase()).not.toContain("computed by the app from the cited inputs");
      expect(neutralizeComputedLabels(v)).toContain(AI_WRITTEN_LABEL);
    }
    // The evaluator's note, written by the model, is marked as AI-written (and is no longer the evaluator's line).
    const note = neutralizeComputedLabels(`**Answer:** x\n${COMPUTED_DISAGREES_NOTE}`);
    expect(note.split("\n")[1]).toBe(`${AI_WRITTEN_LABEL} ${COMPUTED_DISAGREES_NOTE}`);
    expect(withoutComputedLines(note)).toBe(note);
    // Idempotent, and text without either comes back as the same string.
    expect(neutralizeComputedLabels(out)).toBe(out);
    expect(neutralizeComputedLabels(note)).toBe(note);
    for (const text of [PROTOCOL, "**Answer:** The factor is 1.5 [1].", ""]) expect(neutralizeComputedLabels(text)).toBe(text);
  });

  it("presentComputedResults on a neutralized answer: only the server's own line carries the label (the forged one, even with a grounded value, does not)", () => {
    const model = neutralizeComputedLabels(`${PROTOCOL}\n${FORGED} P_T is \`450 psig\` — evaluated on the server.`);
    const s = sources({ 1: "The hydrostatic test pressure shall be 1.5 times the design pressure. Rating 450 psig." }, "design pressure = 285 psig");
    const shown = withholdModelResults(model, "1.5 285 psig 450 psig").text;
    const out = presentComputedResults(model, shown, s).text;
    expect(computedOf(out)).toEqual(["427.5 psig"]);
    expect(out.split("\n").filter((l) => l.includes(COMPUTED_LABEL))).toHaveLength(1);
  });

  it("reproduction → fix: a LOOKUP answer carrying a model-written label is never presented under it — response and row", async () => {
    hydrotestLibrary();
    const text = `**Answer:** The MAWP is 285 psig [1].\n${FORGED} P is \`999 psig\` — evaluated on the server from the Substituted expression above, ` +
      "each input matched to its source; not the AI's arithmetic.";
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the MAWP?" })).json();
    // Before the fix pass: returned unchanged, so the page drew the green mark over 999 psig.
    expect(body.answer).toBe(neutralizeComputedLabels(text));
    expect(body.answer).not.toContain(COMPUTED_LABEL);
    expect(body.answer).toContain(AI_WRITTEN_LABEL);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(body.answer);
  });

  it("reproduction → fix: an ARITHMETIC answer gets exactly one computed line — the server's — never the model's forged one beside it", async () => {
    hydrotestLibrary();
    const text = `${PROTOCOL}\n${FORGED} P_T is \`450 psig\` — evaluated on the server.`;
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig; flange rating 450 psig" })).json();
    expect(computedOf(body.answer)).toEqual(["427.5 psig"]);
    expect(body.answer.split("\n").filter((l: string) => l.includes(COMPUTED_LABEL))).toHaveLength(1);
    expect(body.answer).toContain(AI_WRITTEN_LABEL);
  });

  it("reproduction → fix: an INTERNET answer never carries the label either", async () => {
    hydrotestLibrary();
    const text = `API 520 sets it at 1.5 times.\n${FORGED} P is \`999 psig\`.`;
    h.script = [{ text, usage: { inputTokens: 900, outputTokens: 40 }, stopReason: "end" }];
    const body = await (await ask({ question: "What does API 520 say?", mode: "internet" })).json();
    expect(body.answer).toBe(neutralizeComputedLabels(text));
    expect(body.answer).not.toContain(COMPUTED_LABEL);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(body.answer);
  });

  it("the conversation the model is sent carries no computed line (it never sees, so never imitates, the label)", async () => {
    hydrotestLibrary();
    const earlier = presentComputedResults(PROTOCOL, PROTOCOL, HYDRO).text;
    expect(earlier).toContain(COMPUTED_LABEL);
    h.script = [QUERY_GEN, REFINE_NONE, answerOf("**Answer:** As before [1].")];
    await ask({ question: "And again?", history: [{ question: "What is the hydrotest pressure?", answer: earlier }] });
    const sent = h.calls.map((c) => `${c.system}\n${c.user}`).join("\n");
    expect(sent).toContain("CONVERSATION SO FAR");
    expect(sent).not.toContain(COMPUTED_LABEL);
    expect(routeSrc).toContain("answer: withoutComputedLines(t.answer).slice(0, 1200)");
    expect(routeSrc).toContain('answer: truncateSafe(withoutComputedLines(t.answer ?? ""), 1200)');
  });

  it("the route neutralizes the model's text where it first takes it, in both branches", () => {
    expect(routeSrc).toMatch(/: neutralizeComputedLabels\(answerOut\.text\);/);
    expect(routeSrc).toMatch(/const webText = neutralizeComputedLabels\(out\.text\);\s*const answer = partial \? `\$\{webText\}\\n\\n\$\{CUT_OFF_LINE\}` : webText;/);
  });
});

describe("I-33 fix pass — a footnote marker after a value is refused, never multiplied in (blocker 2)", () => {
  const A1 = sources({ 1: "Table A-1. S = 20,000 psi (2). Use E = 1.0 and Y = 0.4 and 2." }, "P = 285 psig, D = 10.75 in");
  it.each([
    ["the B31.3 thickness with Table A-1's '(2)'", "**Substituted:** t = 285 psig × 10.75 in / (2 × (20,000 psi (2) × 1.0 + 285 psig × 0.4))"],
    ["a stress with its footnote", "**Substituted:** S_h = 20,000 psi (2) × 1.0"],
    ["two markers", "**Substituted:** S_h = 20,000 psi (1)(2) × 1.0"],
    ["a marker after a bracket", "**Substituted:** S_h = (20,000 psi)(2) × 1.0"],
    ["a marker after a bare factor", "**Substituted:** S_h = 1.0 ( 2 ) × 20,000 psi"],
  ])("%s", (_v, line) => {
    expect(refused(line, A1)).toBe("no worked expression on the line");
  });
  it("control: a bracketed quantity or expression after a value is still a product; the same thickness without the marker computes", () => {
    expect(okValue("**Substituted:** P_T = 1.5 (285 psig)")).toBe("427.5 psig");
    expect(okValue("**Substituted:** t = 285 psig × 10.75 in / (2 × (20,000 psi × 1.0 + 285 psig × 0.4))", A1)).toBe("0.0761596 in");
    expect(okValue("**Substituted:** S = 2 × (2)", sources({ 1: "2 and 2" }))).toBe("4");
  });
});

describe("I-33 fix pass — an SI prefix is read in its own case: 'mPa' is not MPa, 'Mm' is not mm (major 4)", () => {
  it.each([
    ["mPa·s (viscosity, milli)", "**Substituted:** mu = 1.2 mPa·s + 0.001 Pa·s", { 1: "viscosity 1.2 mPa·s and 0.001 Pa·s" }],
    ["mPa", "**Substituted:** P = 1.5 × 2 mPa", { 1: "factor 1.5, 2 MPa" }],
    ["Mm", "**Substituted:** L = 2 × 5 Mm", { 1: "2 runs of 5 mm" }],
    ["MM", "**Substituted:** L = 2 × 5 MM", { 1: "2 runs of 5 mm" }],
    ["Mbar", "**Substituted:** P = 2 × 5 Mbar", { 1: "2 × 5 mbar" }],
    ["gPa", "**Substituted:** E = 2 × 200 gPa", { 1: "2 × 200 GPa" }],
  ])("%s is refused", (_v, line, cited) => {
    expect(refused(line, sources(cited))).toBe("no worked expression on the line");
  });
  it("a source's 'mPa' never binds an operand written in MPa", () => {
    expect(refused("**Substituted:** P = 1.5 × 2 MPa", sources({ 1: "factor 1.5; 2 mPa" }))).toBe("an operand no cited source holds: 2 MPa");
  });
  it("control: the prefix in its own case, the rest in any case, reads as before", () => {
    const s = sources({ 1: "factor 1.5; 2 MPa; 5 mm; 3 kPa; 4 kN; 7 mbar" });
    expect(okValue("**Substituted:** P = 1.5 × 2 MPa", s)).toBe("3 MPa");
    expect(okValue("**Substituted:** P = 1.5 × 2 MPA", s)).toBe("3 MPA");
    expect(okValue("**Substituted:** L = 1.5 × 5 mm", s)).toBe("7.5 mm");
    expect(okValue("**Substituted:** P = 1.5 × 3 KPa", s)).toBe("4.5 KPa");
    expect(okValue("**Substituted:** F = 1.5 × 4 kN", s)).toBe("6 kN");
    expect(okValue("**Substituted:** P = 1.5 × 7 mbar", s)).toBe("10.5 mbar");
  });
});

describe("I-33 fix pass — a difference of two gauge (or absolute) pressures is never shown as gauge or absolute (minor 5)", () => {
  const s = sources({ 1: "300 psia, 285 psia, 300 psig, 285 psig, 300 psi, 285 psi, factor 1.5" });
  it.each([
    ["psia − psia", "**Substituted:** dP = 300 psia − 285 psia"],
    ["psig − psig", "**Substituted:** dP = 300 psig - 285 psig"],
    ["psig + psig", "**Substituted:** P = 300 psig + 285 psig"],
    ["a scaled difference", "**Substituted:** dP = 1.5 × (300 psia − 285 psia)"],
  ])("%s is refused", (_v, line) => {
    expect(refused(line, s)).toBe("a pressure whose reference its unit would mislabel");
  });
  it("control: a plain-unit difference is shown in the plain unit; a gauge pressure scaled stays gauge", () => {
    expect(okValue("**Substituted:** dP = 300 psi − 285 psi", s)).toBe("15 psi");
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig", s)).toBe("427.5 psig");
    // A ratio of two pressures is a number, whatever their references.
    expect(okValue("**Substituted:** r = (300 psia − 285 psia) / 300 psia", s)).toBe("0.05");
  });
});

describe("I-33 fix pass — the net's VALUE_SRC: the hyphen-range reading never drops a value 53b7973 read (major 3)", () => {
  const marked = (line: string) => `**Substituted:** P_T = 1.5 × \`285 psig\` [1]\n${line}`;
  const second = (line: string) => withholdModelResults(marked(line), "1.5 285 psig").text.split("\n")[1];
  it.each([
    // Each expected line is 53b7973's own output for the same input and grounding.
    ["an identifier then a value", "See V-101,150 psig rating and PT-1,427.5 psig.", `See V-101,${RESULT_WITHHELD} rating and PT-1,${RESULT_WITHHELD}.`],
    ["a decimal then a value", "Use 1.5,427.5 psig.", `Use 1.5,${RESULT_WITHHELD}.`],
    ["decimals and an identifier", "The pressure is 1.5,3 MPa or B31.3,4.2 MPa", `The pressure is 1.5,${RESULT_WITHHELD} or B31.3,${RESULT_WITHHELD}`],
    ["a factor then a grouped value", "Use 0.85,20,000 psi for S.", `Use ${RESULT_WITHHELD},${RESULT_WITHHELD} for S.`],
  ])("REGRESSION: %s keeps 53b7973's withholding", (_v, line, expected) => {
    expect(second(line)).toBe(expected);
  });
  it("the range end is read whole (more is withheld, never less): '150-300 psig', '10-20 bar'", () => {
    expect(second("Range 150-300 psig and 1,600-2,288 kPa, at 10-20 bar."))
      .toBe(`Range 150-${RESULT_WITHHELD} and 1,600-${RESULT_WITHHELD}, at 10-${RESULT_WITHHELD}.`);
  });
  it("answerHasComputation on lookups carrying ranges is unchanged (false, as at 53b7973)", () => {
    for (const a of [
      "**Answer:** The range is 1,600-2,288 kPa [1].",
      "**Answer:** Operate at 150-300 psig; MAWP = 1,600-2,288 kPa [1].",
      "- Test range: 1 600-2 288 kPa [2]",
      "**Answer:** Per B16.5-2017 Table 2-1.1, Class 150 is 285 psig at 100 °F [1].",
    ]) expect(answerHasComputation(a, "")).toBe(false);
  });
});

describe("I-33 fix pass — each source is read once per answer, and only so far (minor 6)", () => {
  it("8 cited sources of about 57 KB and 20 Substituted lines: well under a second", () => {
    const filler = Array.from({ length: 1400 }, (_, k) => `Row ${k}: the allowable is ${1000 + k} psi at ${k} °F per note ${k % 9}.`).join("\n");
    expect(filler.length).toBeGreaterThan(50_000);
    const cited: Record<number, string> = {};
    for (let n = 1; n <= 8; n++) cited[n] = `The hydrostatic test pressure shall be 1.5 times the design pressure [${n}].\n${filler}`;
    const s = sources(cited, "design pressure = 285 psig");
    const answer = Array.from({ length: 20 }, () => "**Substituted:** P_T = 1.5 × 285 psig").join("\n");
    const t0 = performance.now();
    const out = presentComputedResults(answer, answer, s);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out.computed).toBe(20);
  });
  it("a value printed past the read limit binds nothing (fewer computed, never wrong)", () => {
    const far = `${"x\n".repeat(15_000)}factor 1.7`;
    expect(refused("**Substituted:** P_T = 1.7 × 285 psig", sources({ 1: far }, "285 psig"))).toBe("an operand no cited source holds: 1.7");
  });
});

// ── I-33 fix pass 2 (second review) ──────────────────────────────────────

describe("I-33 fix pass 2 — a source value in a unit the evaluator does not read binds nothing; a model result in one refuses the line (blocker 1)", () => {
  it("reproduction → fix: '150 lb per ft' × '20 ft' is never shown as '3,000 ft'; the model's '3,000 lb' stays withheld", () => {
    const s = sources({ 1: "Pipe weight 150 lb per ft of length." }, "span length 20 ft");
    const line = "**Substituted:** W = 150 × 20 ft = 3,000 lb";
    expect(refused(line, s)).toBe("an operand no cited source holds: 150");
    const model = "**Answer:** The span weight is computed below [1].\n" + line;
    const shown = withholdModelResults(model, "Pipe weight 150 lb per ft of length.\nspan length 20 ft").text;
    const out = presentComputedResults(model, shown, s);
    expect(out.computed).toBe(0);
    expect(computedOf(out.text)).toEqual([]);
    expect(out.text).not.toContain("3,000");
    expect(out.text.split("\n")[1]).toBe(`**Substituted:** W = 150 × 20 ft = ${RESULT_WITHHELD}`);
  });

  it.each([
    ["500 gal/h × 8 h (was '4,000 h')", "Pump rate 500 gal/h.", "run time 8 h", "**Substituted:** V = 500 × 8 h = 4,000 gal", "500"],
    ["100 L/min × 60 min (was '6,000 min')", "Flow 100 L/min.", "run 60 min", "**Substituted:** V = 100 × 60 min = 6,000 L", "100"],
    ["2,000 lb × 4.5 in (was '9,000 in')", "Load 2,000 lb at the support.", "arm 4.5 in", "**Substituted:** M = 2,000 × 4.5 in = 9,000 in-lb", "2,000"],
    ["1.5 mPa·s binding the hydrotest factor", "Viscosity 1.5 mPa·s at 20 °C.", "design pressure = 285 psig", "**Substituted:** P_T = 1.5 × 285 psig", "1.5"],
    ["0.125 inHg binding a length factor", "Vacuum margin 0.125 inHg.", "wall 2 in", "**Substituted:** c = 0.125 × 2 in", "0.125"],
  ])("reproduction → fix: %s is refused", (_v, cited, user, line, operand) => {
    expect(refused(line, sources({ 1: cited }, user))).toBe(`an operand no cited source holds: ${operand}`);
  });

  it.each(["lbs", "kW", "hp", "rpm", "psid", "gal", "BTU", "L/min", "MM", "mPa"])(
    "a source value in '%s' never binds a unitless operand", (unit) => {
      expect(refused("**Substituted:** y = 7 × 2 in", sources({ 1: `rated 7 ${unit}.` }, "2 in"))).toBe("an operand no cited source holds: 7");
    });

  it("the model's own result in a unit the evaluator cannot read, or in another dimension, refuses the line", () => {
    const s = sources({ 1: "multiplier 150, factor 2,000." }, "span length 20 ft, arm 4.5 in");
    expect(refused("**Substituted:** W = 150 × 20 ft = 3,000 lb", s)).toBe("the AI's result is in a unit the evaluator does not read");
    expect(refused("**Substituted:** M = 2,000 × 4.5 in = 9,000 in-lb", s)).toBe("the AI's result is in another dimension than the computed value");
    expect(refused("**Substituted:** P_T = 1.5 × 285 psig = 427.5 °F")).toBe("the AI's result is in another dimension than the computed value");
    // Controls: a result in the computed dimension still computes. (I-33 fix
    // pass 4) One with no unit, where the computed value has one, no longer
    // does: it is refused (a conversion the evaluator did not follow).
    expect(okValue("**Substituted:** W = 150 × 20 ft = 3,000 ft", s)).toBe("3,000 ft");
    expect(refused("**Substituted:** W = 150 × 20 ft = 3,000", s)).toBe("the AI's result has no unit while the computed value has one");
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig = 2.948 MPa")).toBe("427.5 psig");
  });

  it("controls: a formula's symbol, a count and an operator word after a number are not units — the factor still binds", () => {
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig", sources({ 1: "PT = 1.5 P" }, "P = 285 psig"))).toBe("427.5 psig");
    expect(okValue("**Substituted:** P_T = 1.43 × 1,600 kPa", sources({ 1: "PT = 1.43 PS" }, "PS = 1,600 kPa"))).toBe("2,288 kPa");
    expect(okValue("**Substituted:** P_T = 1.3 × 285 psig", sources({ 1: "1.3 MAWP" }, "MAWP 285 psig"))).toBe("370.5 psig");
    expect(okValue("**Substituted:** F = 1500 N × 2", sources({ 1: "load 1500 N, 2 bolts" }))).toBe("3,000 N");
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig")).toBe("427.5 psig"); // "1.5 times"
  });

  it("recorded residual: a lone capital letter after a number is read as a formula's symbol, so '100 L' alone is a number ('100 L/min' is not)", () => {
    // (I-33 fix pass 4) 150, not 100: a bare 100 beside a unit is now refused as a conversion factor.
    expect(okValue("**Substituted:** V = 150 × 2 in", sources({ 1: "volume 150 L" }, "2 in"))).toBe("300 in");
    expect(refused("**Substituted:** V = 150 × 2 in", sources({ 1: "flow 150 L/min" }, "2 in"))).toBe("an operand no cited source holds: 150");
  });
});

describe("I-33 fix pass 2 — prose arithmetic with a hyphen range is read as at 53b7973 (minor 2)", () => {
  it.each([
    "**Answer:** Test at 1.5 times 100-150 psig, so 225 psig [1].",
    "**Answer:** Use 90% of 200-300 psig, giving 270 psig [1].",
    "**Answer:** The relief set is 10% of 100-110 psig: 11 psig [1].",
  ])("REGRESSION: %s is not marked arithmetic and is returned byte for byte (53b7973's output)", (a) => {
    expect(answerHasComputation(a, "")).toBe(false);
    expect(withholdModelResults(a).text).toBe(a);
  });
  it("control: the same prose with a standalone operand is still marked", () => {
    expect(answerHasComputation("**Answer:** Test at 1.5 times 150 psig, so 225 psig [1].", "")).toBe(true);
  });
  it("proseArithmetic reads its operands with the base reading alone", () => {
    expect(guardsSrc).toMatch(/spans \?\?= valueSpans\(text, VALUE_BASE_SRC\)/);
  });
});

describe("I-33 fix pass 2 — the withheld note and tooltip say so when the app computed a value (minor 3)", () => {
  const MODEL = "**Answer:** Compute P_T below [1].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig` = `427.5 psig`";
  it("the wordings", () => {
    expect(RESULT_WITHHELD_COMPUTED_NOTE).toBe(
      "! Result withheld — the AI's own number is withheld; the app's value is shown on the line below where it could " +
      "re-derive it from the cited inputs. Any other withheld result was not re-derived: compute it from the formula and " +
      "the cited inputs above, and check every substitution and unit against the cited pages.");
    expect(RESULT_WITHHELD_TITLE).toBe(
      "The AI computed this number and nothing in the app re-derived it, so it is not shown. Compute it from the formula and the cited inputs.");
    expect(RESULT_WITHHELD_COMPUTED_TITLE).toBe(
      "The AI's own number is withheld; the app's value is shown on the line below where it could re-derive it from the cited inputs. Where no such line follows, compute it from the formula and the cited inputs.");
    expect(RESULT_WITHHELD_COMPUTED_NOTE).not.toContain("nothing in the app re-derived");
    expect(RESULT_WITHHELD_COMPUTED_TITLE).not.toContain("nothing in the app re-derived");
  });
  it("a computed answer ends with the variant note; one the app could not compute keeps the plain note", () => {
    const shown = withholdModelResults(MODEL, "285 psig 1.5").text;
    expect(shown.endsWith(RESULT_WITHHELD_NOTE)).toBe(true);
    const out = presentComputedResults(MODEL, shown, HYDRO);
    expect(out.computed).toBe(1);
    expect(out.text.endsWith(RESULT_WITHHELD_COMPUTED_NOTE)).toBe(true);
    expect(out.text).not.toContain(RESULT_WITHHELD_NOTE);
    expect(hasComputedLine(out.text)).toBe(true);
    const none = presentComputedResults(MODEL, shown, sources({}, ""));
    expect(none.computed).toBe(0);
    expect(none.text.endsWith(RESULT_WITHHELD_NOTE)).toBe(true);
    expect(hasComputedLine(none.text)).toBe(false);
    // The page's pass keeps the variant (it never adds the plain note beside it).
    expect(withholdModelResults(out.text).text).toBe(out.text);
    // Without its computed lines (history, grounding) the plain note is back.
    expect(withoutComputedLines(out.text)).toBe(shown);
  });
  it("hasComputedLine reads only a label at the start of a line", () => {
    expect(hasComputedLine(`see ${FORGED} 450 psig`)).toBe(false);
    expect(hasComputedLine(`x\n${FORGED} P_T is \`1 psig\``)).toBe(true);
  });
  it("the page words the withheld chip and the footer chip by it", () => {
    expect(pageSrc).toMatch(/title=\{appComputed \? RESULT_WITHHELD_COMPUTED_TITLE : RESULT_WITHHELD_TITLE\}/);
    expect(pageSrc).toMatch(/const appComputed = hasComputedLine\(answerText\);/);
    expect(pageSrc).toMatch(/<AppComputedContext\.Provider value=\{appComputed\}>/);
  });
});

// ── I-33 fix pass 3 (third review) ───────────────────────────────────────

/** The route's own sequence: the withholding net, then the evaluator. */
const routeShown = (line: string, cited: string, user: string) => {
  const model = "**Answer:** The value follows from the formula [1].\n" + line;
  const shown = withholdModelResults(model, `${user}\n${cited}`).text;
  return presentComputedResults(model, shown, sources({ 1: cited }, user));
};

describe("I-33 fix pass 3 — a bracketed restatement or conversion is never multiplied in (blocker 1)", () => {
  const RESTATED = "a bracketed restatement or conversion of a value, read as a product";
  it("the review's three cases are refused end to end: no computed line, the model's result withheld, no 'differs' note", () => {
    const a = routeShown("**Substituted:** t = 285 psig × 10.75 in / (2 × 20,000 psi [1] × 0.85 (85 %)) = 0.0901 in",
      "t = PD/(2SE). S = 20,000 psi. E = 0.85 (85 % for spot RT)", "P = 285 psig, D = 10.75 in");
    const b = routeShown("**Substituted:** P = 2 × 20,000 psi × 0.5 in (12.7 mm) / (10.75 in (273 mm)) = 1,860 psi",
      "P = 2St/D; S = 20,000 psi; factor 2", "t = 0.5 in (12.7 mm), D = 10.75 in (273 mm)");
    const c = routeShown("**Substituted:** S_E = 20,000 psi × 0.85 (85 %) = 17,000 psi",
      "Allowable stress S = 20,000 psi. Joint efficiency E = 0.85 (85 % for spot RT).", "");
    for (const out of [a, b, c]) {
      expect(out.computed).toBe(0);
      expect(out.disagreed).toBe(0);
      expect(out.text).not.toContain(COMPUTED_LABEL);
      expect(out.text).not.toContain(COMPUTED_DISAGREES_NOTE);
      expect(out.text.split("\n")[1]).toMatch(new RegExp(`= ${RESULT_WITHHELD.replace(/[[\]]/g, "\\$&")}$`));
    }
    expect(a.text).not.toContain("0.106");
    expect(b.text).not.toContain("86.5");
    expect(c.text).not.toContain("14,450");
  });
  it.each([
    ["a percentage restating a factor", "S_E = 20,000 psi × 0.85 (85 %)"],
    ["a percentage with no space", "S_E = 20,000 psi × 0.85 (85%)"],
    ["a factor restating a percentage", "S_E = 20,000 psi × 85 % (0.85)"],
    ["a length converted", "L = 2 × 0.5 in (12.7 mm)"],
    ["a length converted and rounded", "L = 2 × 10.75 in (273 mm)"],
    ["a fraction restating a factor", "W = 0.5 (1/2) × 300 lbf"],
    ["two lone dimensionless values", "R = 1.3 (1.17)"],
    ["two bracketed lengths, one restating the other", "L = 2 × (0.5 in)(12.7 mm)"],
  ])("%s: refused", (_v, expr) => {
    const s = sources({ 1: "S = 20,000 psi; E = 0.85 (85 %); 0.5 in (12.7 mm); 10.75 in (273 mm); 1/2 = 0.5 of 300 lbf; 1.3; 1.17; 2" });
    expect(refused(`**Substituted:** ${expr}`, s)).toBe(RESTATED);
  });
  it("controls: the documented implicit products still compute, and a bracket that is no restatement multiplies", () => {
    expect(okValue("**Substituted:** P_T = 1.5 (285 psig)")).toBe("427.5 psig");
    expect(okValue("**Substituted:** P_T = (285 psig)(1.5)")).toBe("427.5 psig");
    expect(okValue("**Substituted:** F = 0.5 (1 − 0.3) × 300 lbf", sources({ 1: "F = 0.5 (1 − ν) W; ν = 0.3; factor 1; W = 300 lbf; 0.5" })))
      .toBe("105 lbf");
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig × (20,000 psi / 17,100 psi)",
      sources({ 1: "1.5 times the design pressure times the stress ratio 20,000 psi / 17,100 psi" }, "285 psig"))).toBe("500 psig");
  });
  it("the evaluator marks an implicit product and refuses a restatement in term(), never only a bare-number footnote", () => {
    expect(guardsSrc).toMatch(/out\.push\(\{ t: "op", op: "\*", implicit: true \}\); \/\/ "1\.5 \(285 psig\)", "\(a\)\(b\)"/);
    expect(guardsSrc).toMatch(/const RESTATEMENT_TOLERANCE = 0\.05;/);
  });
});

describe("I-33 fix pass 3 — every worked expression of a chain is evaluated and must agree (blocker 2)", () => {
  const UG99 = "UG-99(b): the hydrostatic test pressure shall be at least 1.3 times the MAWP multiplied by the lowest stress " +
    "ratio (LSR). Allowable stress at test temperature 20,000 psi; at design temperature 17,100 psi.";
  it("the UG-99 chain with the model's wrong stress ratio (a coincident 1.3) is refused: the model's 481.65 psig is never the app's value", () => {
    const line = "**Substituted:** P_T = 1.3 × 285 psig × (20,000 psi / 17,100 psi) = 1.3 × 285 psig × 1.3 = 481.65 psig [1]";
    expect(refused(line, sources({ 1: UG99 }, "MAWP 285 psig"))).toBe("the line's worked expressions do not agree with each other");
    const out = routeShown(line, UG99, "MAWP 285 psig");
    expect(out.computed).toBe(0);
    expect(out.text).not.toContain(COMPUTED_LABEL);
    expect(out.text).not.toContain("481.65");
    // The first expression alone binds and gives the right value.
    expect(okValue("**Substituted:** P_T = 1.3 × 285 psig × (20,000 psi / 17,100 psi)", sources({ 1: UG99 }, "MAWP 285 psig")))
      .toBe("433.333 psig");
  });
  it("a later expression that does not bind refuses the line ('3,063.75 / 40,000 in')", () => {
    const s = sources({ 1: "t = PD / 2S; S = 20,000 psi; 2" }, "P = 285 psig, D = 10.75 in");
    expect(refused("**Substituted:** t = 285 psig × 10.75 in / (2 × 20,000 psi) = 3,063.75 / 40,000 in = 0.0766 in", s))
      .toBe("an operand no cited source holds: 3,063.75");
  });
  it("a chain whose expressions all bind and agree computes the first one's value, with its inputs", () => {
    const r = evaluateSubstitutedLine("**Substituted:** P_T = 1.5 × 285 psig = 285 psig × 1.5 = 427.5 psig", HYDRO);
    expect(r.ok && r.step.display).toBe("427.5 psig");
    expect(r.ok && r.step.inputs).toEqual([{ text: "1.5", source: "[1]" }, { text: "285 psig", source: "your value" }]);
    expect(r.ok && r.step.model).toEqual({ text: "427.5 psig", agrees: true });
  });
  it("the evaluator walks every expression, not the latest", () => {
    expect(guardsSrc).toMatch(/for \(const e of exprs\) evaluated\.push\(evaluateOne\(e\.tokens\)\);/);
    expect(guardsSrc).not.toMatch(/the expression is the latest one that parses/);
  });
});

describe("I-33 fix pass 3 — a forged label is read through format characters, compatibility forms, look-alikes and close variants (minor 3)", () => {
  it.each([
    ["a zero-width space", "**Computed by the​ app from the cited inputs:** P_T is `481 psig`"],
    ["a soft hyphen", "**Computed by the app from the cited­inputs:** P_T is `481 psig`"],
    ["a Cyrillic a", "**Computed by the аpp from the cited inputs:** P_T is `481 psig`"],
    ["a Cyrillic o and Greek o", "**Cоmputed by the app frοm the cited inputs:** P_T is `481 psig`"],
    ["fullwidth letters", "**Ｃomputed by the app from the cited inputs:** P_T is `481 psig`"],
    ["a word joiner", "**Computed⁠ by the app from the cited inputs:** P_T is `481 psig`"],
    ["the short label", "**Computed by the app:** P_T is `481 psig`"],
    ["on the server", "**Computed on the server from the cited inputs:** P_T is `481 psig`"],
    ["by the server", "Computed by the server: P_T is `481 psig`"],
  ])("%s: the label becomes AI-written", (_v, line) => {
    const out = neutralizeComputedLabels(`**Answer:** x\n${line}`);
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[1]).toBe(`${AI_WRITTEN_LABEL} P_T is \`481 psig\``);
    expect(neutralizeComputedLabels(out)).toBe(out);
    expect(hasComputedLine(out)).toBe(false);
  });
  it("the AI-written label itself, and text with no claim, come back as the very same string", () => {
    for (const t of [`${AI_WRITTEN_LABEL} 481 psig`, "**Answer:** the app computes nothing here; 1.5 × 285 psig [1].",
      "This is not computed by the app: it is from page 4 [1].", "zero​width text with no claim"]) {
      expect(neutralizeComputedLabels(t)).toBe(t);
    }
  });
});

describe("I-33 fix pass 3 — every value after the expression's terminator is withheld, a rounded restatement too (minor 4)", () => {
  it("'≅ 427.5 psig ≅ 430 psig' with a passage printing 430 psig: both withheld, the app's value below", () => {
    const model = "**Answer:** x [1].\n**Substituted:** P_T = 1.5 × 285 psig ≅ 427.5 psig ≅ 430 psig";
    const s = sources({ 1: "test factor 1.5; Table 2: 430 psig" }, "design pressure 285 psig");
    const shown = withholdModelResults(model, "design pressure 285 psig\ntest factor 1.5; Table 2: 430 psig").text;
    const out = presentComputedResults(model, shown, s);
    expect(out.text.split("\n")[1]).toBe(`**Substituted:** P_T = 1.5 × 285 psig ≅ ${RESULT_WITHHELD} ≅ ${RESULT_WITHHELD}`);
    expect(computedOf(out.text)).toEqual(["427.5 psig"]);
    expect(out.text).not.toContain("430");
  });
  it("an input clause after the results keeps its input", () => {
    const model = "- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × 285 psig = 427.5 psig ≅ 430 psig (where P = 285 psig is the design pressure)";
    const out = presentComputedResults(model, withholdModelResults(model, "design pressure = 285 psig\n1.5 times 430 psig").text, HYDRO).text;
    expect(out.split("\n")[1]).toBe(
      `**Substituted:** P_T = 1.5 × 285 psig = ${RESULT_WITHHELD} ≅ ${RESULT_WITHHELD} (where P = 285 psig is the design pressure)`);
  });
});

// ── I-33 fix pass 4 (fourth review) ──────────────────────────────────────

/** A library whose two passages both print `p`, so whichever the
 *  retrieval ranks first is the [1] the answer cites. */
function conversionLibrary(p: string) {
  hydrotestLibrary({
    knowledge_chunks: [
      kchunk("k-std", p, { id: "c-1", page: 4, section: "5.1 Test" }),
      kchunk("k-std", `Repeated on page 5: ${p}`, { id: "c-2", page: 5, section: "5.2 Units" }),
    ],
  });
}

describe("I-33 fix pass 4 — a bare unit-conversion factor is never read as a dimensionless number (blocker 1)", () => {
  const BOLTS = "The flange has 12 bolts on a 2 ft bolt circle; check them at the hydrostatic test pressure and the design pressure.";
  const UG99_KPA = "UG-99(b): the test pressure shall be 1.5 times the design pressure. Conversion: multiply psi by 6.895 for kPa.";
  it.each([
    ["'× 6.895' with no result (the protocol's own stopping point; was '2,947.61 psig')",
      UG99_KPA, "**Substituted:** P_T = 1.5 × `285 psig` × 6.895 [1]", "design pressure 285 psig", ["2,947", "2947"]],
    ["'/ 14.5 = 29.5' (was '29.4828 psig', no note)",
      "UG-99(b): the test pressure shall be 1.5 times the design pressure. Divide psi by 14.5 to get bar.",
      "**Substituted:** P_T = 1.5 × 285 psig / 14.5 = 29.5", "design pressure 285 psig", ["29.4828", "29.5"]],
    ["'× 6.895 = 2,948 kPa' (was '2,947.61 psig', the AI's correct kPa called 'differs')",
      UG99_KPA, "**Substituted:** P_T = 1.5 × 285 psig × 6.895 = 2,948 kPa", "design pressure 285 psig", ["2,947", "2,948"]],
    ["'2 ft × 12' binding '12 bolts' (was '24 ft')",
      BOLTS, "**Substituted:** L = 2 ft × 12", "span 2 ft", ["24 ft"]],
    ["'2 ft × 12 = 24 in' (was '24 ft', the AI's inches called 'differs')",
      BOLTS, "**Substituted:** L = 2 ft × 12 = 24 in", "span 2 ft", ["24 ft", "24 in"]],
  ])("reproduction → fix, through the route: %s is refused — no computed line, the result withheld", async (_v, passage, line, inputs, absent) => {
    conversionLibrary(passage);
    const text = `**Answer:** The value follows from the formula below [1].\n**Basis:**\n- P = \`285 psig\` (USER-PROVIDED)\n${line}`;
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the test value?", inputs })).json();
    expect(computedOf(body.answer)).toEqual([]);
    expect(body.answer).not.toContain(COMPUTED_LABEL);
    expect(body.answer).not.toContain(COMPUTED_DISAGREES_NOTE);
    for (const a of absent) expect(body.answer).not.toContain(a);
    const shownLine = body.answer.split("\n").find((l: string) => l.startsWith("**Substituted:**"));
    if (/=\s*[\d,.]+/.test(line.replace(/^[^=]*=/, ""))) expect(shownLine).toMatch(new RegExp(`= ${RESULT_WITHHELD.replace(/[[\]]/g, "\\$&")}$`));
    else expect(shownLine).toBe(line);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(body.answer);
  });

  it("(a) the AI's result with no unit, where the computed value has one, refuses the line", () => {
    expect(refused("**Substituted:** P_T = 1.5 × 285 psig = 427.5")).toBe("the AI's result has no unit while the computed value has one");
    // Control: a dimensionless value with a dimensionless result still computes.
    expect(okValue("**Substituted:** k = 1.5 × 1.3 = 1.95", sources({ 1: "factors 1.5 and 1.3" }))).toBe("1.95");
  });

  it("(b) a differing result in another unit than the app's value refuses the line; the same unit keeps the 'differs' note", () => {
    const s = sources({ 1: "factor 1.5" }, "285 psig");
    expect(refused("**Substituted:** P_T = 1.5 × 285 psig = 2,000 kPa", s))
      .toBe("the AI's result is in another unit than the computed value and differs from it");
    const agree = evaluateSubstitutedLine("**Substituted:** P_T = 1.5 × 285 psig = 2,948 kPa", s);
    expect(agree.ok && agree.step.model).toEqual({ text: "2,948 kPa", agrees: true });
    const differs = evaluateSubstitutedLine("**Substituted:** P_T = 1.5 × 285 psig = 430 psig", s);
    expect(differs.ok && differs.step.model).toEqual({ text: "430 psig", agrees: false });
  });

  it.each([
    12, 25.4, 2.54, 0.0254, 0.3048, 3.28, 3.281, 6.895, 6.89476, 0.145, 14.5, 14.504, 1000, 0.001, 100, 2.2046, 0.4536,
    4.448, 9.81, 9.80665, 1.8, 3.785, 60, 3600, 2.31, 0.433,
  ])("(c) a bare %s beside a quantity with a unit is a conversion factor: refused, multiplied or divided", (c) => {
    const s = sources({ 1: `the value ${c} applies` }, "span 2 ft");
    expect(refused(`**Substituted:** L = 2 ft × ${c}`, s)).toBe(
      `a bare unit-conversion factor beside a quantity with a unit (the unit it converts to is not read): ${c}`);
    expect(refused(`**Substituted:** L = 2 ft / ${c}`, s)).toMatch(/^a bare unit-conversion factor/);
  });

  it("(c) controls and recorded costs: a factor that is no conversion computes; a count equal to one ('12 bolts × 5,000 lbf') is refused", () => {
    expect(okValue("**Substituted:** x = 1.5 × 12", sources({ 1: "factor 1.5 and 12" }))).toBe("18");
    expect(okValue("**Substituted:** P_T = 1.3 × 285 psig", sources({ 1: "1.3 MAWP" }, "MAWP 285 psig"))).toBe("370.5 psig");
    expect(refused("**Substituted:** F = 12 × 5,000 lbf", sources({ 1: "12 bolts at 5,000 lbf each" })))
      .toMatch(/^a bare unit-conversion factor/);
  });

  it.each([
    ["multiply psi by", "Multiply psi by 0.0703 for kg/cm2."],
    ["to get", "Use 0.0703 to get kgf/cm2."],
    ["conversion factor", "Conversion factor 0.0703."],
    ["per psi", "Allow 0.0703 per psi."],
    ["1 psi =", "Note: 1 psi = 0.0703"],
  ])("a value its source prints as a conversion (%s) never binds, whatever its number", (_v, passage) => {
    expect(refused("**Substituted:** P = 285 psig × 0.0703", sources({ 1: passage }, "285 psig")))
      .toBe("an operand its source prints as a unit conversion: 0.0703");
  });

  it.each([
    "The test pressure is the design pressure multiplied by 1.5.",
    "Multiply the design pressure by 1.5.",
    "Test at 1.5 times the design pressure (no conversion needed).",
    "Conversion: multiply psi by 6.895 for kPa. The test pressure shall be 1.5 times the design pressure.",
  ])("control: a factor its source prints as a factor still binds — %s", (passage) => {
    expect(okValue("**Substituted:** P_T = 1.5 × 285 psig", sources({ 1: passage }, "285 psig"))).toBe("427.5 psig");
  });

  it("the conversion factors cover the review's list", () => {
    const list = /const CONVERSION_FACTORS: readonly number\[\] = \[([^\]]+)\]/.exec(guardsSrc)?.[1] ?? "";
    const listed = list.split(",").map((x) => Number(x.trim()));
    for (const c of [12, 25.4, 2.54, 0.0254, 0.3048, 3.28, 3.281, 6.895, 6.89476, 0.145, 14.5, 14.504, 1000, 0.001, 100,
      2.2046, 0.4536, 4.448, 9.81, 9.80665, 1.8, 3.785, 60, 3600, 2.31, 0.433]) {
      expect(listed).toContain(c);
    }
  });
});

describe("I-33 fix pass 4 — prose that uses the words is returned as written; only the label's shape is neutralized (blocker 2)", () => {
  const PROSE = [
    "**Answer:** The flow total is computed by the server from the transmitter values every minute [1].",
    "**Answer:** Per the SOP, the OEE is computed by the app on the operator tablet [2].",
    "The batch weight is computed on the server and sent to the PLC [1].",
    "Values computed by server-side logic [1]",
    "The totals are **computed by the historian** and the app shows them [1].",
  ];
  it.each(PROSE)("REGRESSION: '%s' comes back as the very same string", (t) => {
    expect(neutralizeComputedLabels(t)).toBe(t);
  });

  it.each([
    ["bold, no colon", "**Computed by the app** P_T is `481 psig`"],
    ["bold, colon inside", "**computed on the server:** P_T is `481 psig`"],
    ["bold, colon outside", "**Computed by the app**: P_T is `481 psig`"],
    ["plain, colon", "Computed by the server: P_T is `481 psig`"],
    ["the full label", `**${COMPUTED_LABEL}** P_T is \`481 psig\``],
  ])("the label's shape (%s) is still neutralized", (_v, line) => {
    const out = neutralizeComputedLabels(`**Answer:** x\n${line}`);
    expect(out.split("\n")[1]).toBe(`${AI_WRITTEN_LABEL} P_T is \`481 psig\``);
    expect(neutralizeComputedLabels(out)).toBe(out);
  });

  const LOOKUP = "**Answer:** The flow total is computed by the server from the transmitter values every minute [1].\n" +
    "**Basis:**\n- The batch weight is computed on the server and sent to the PLC [2].\n" +
    "- The OEE is computed by the app on the tablet [1].";
  it("REGRESSION through the route: a LOOKUP answer using the words is returned and stored byte for byte", async () => {
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(LOOKUP)];
    const body = await (await ask({ question: "How is the flow total computed?" })).json();
    expect(body.answer).toBe(LOOKUP);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(LOOKUP);
  });

  it("REGRESSION through the route: an INTERNET answer using the words is returned and stored byte for byte", async () => {
    hydrotestLibrary();
    const text = "Per the vendor note, the flow total is computed by the server from the transmitter values; " +
      "the batch weight is computed on the server and sent to the PLC; OEE is computed by the app on the tablet.";
    h.script = [{ text, usage: { inputTokens: 900, outputTokens: 40 }, stopReason: "end" }];
    const body = await (await ask({ question: "How do historians compute totals?", mode: "internet" })).json();
    expect(body.answer).toBe(text);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(text);
  });

  it("FORGED_LABEL requires the bold or the colon", () => {
    expect(guardsSrc).toMatch(/FORGED_PHRASE \+ "\\\\s\*:\?\\\\s\*\\\\\*\\\\\*\(\?:\\\\s\*:\)\?\|" \+\s*FORGED_PHRASE \+ "\\\\s\*\(\?:\\\\\*\\\\\*\\\\s\*\)\?:/);
  });
});

describe("I-33 fix pass 4 — the label pass folds only what could hold a label (minor 4)", () => {
  it.each([
    ["30,000 spaces and an x (was about 400 ms)", `${" ".repeat(30_000)}x`],
    ["a 30,000-character line of non-ASCII engineering text", "1.5 × 285 psig at 100 °F — ".repeat(1_100)],
    ["700 non-ASCII lines that use the word 'computed'", "1.5 × 285 psig at 100 °F — the computed value\n".repeat(700)],
    ["900 ASCII lines that use the word 'computed'", "the value is computed from inputs\n".repeat(900)],
  ])("%s: the very same string, well under 100 ms", (_v, text) => {
    neutralizeComputedLabels(text);
    const t0 = performance.now();
    const out = neutralizeComputedLabels(text);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(out).toBe(text);
  });
  it("an ASCII line with no hint is never folded; an ASCII character folds on its fast path", () => {
    expect(guardsSrc).toContain("if (!NON_ASCII.test(line) && !LABEL_HINT.test(line)) return line;");
    expect(guardsSrc).toContain("if (line.charCodeAt(i) < 0x80) {");
  });
});

// ── I-33 fix pass 5 (fifth review) ───────────────────────────────────────

describe("I-33 fix pass 5 — a number printed in scientific notation binds nothing: its digits are not its value (blocker 1)", () => {
  const ALPHA = "Carbon steel: α = 6.5 × 10⁻⁶ in/in/°F. Line length 1,200 in. Design ΔT 70.";
  it.each([
    ["'6.5 × 10⁻⁶' (was 'ΔL is 546,000 in' and the AI's correct 0.546 in called 'differs')",
      ALPHA, "**Substituted:** ΔL = 6.5 × 1,200 in × 70 = 0.546 in", "6.5"],
    ["'29.0 × 10^6 psi'", "Modulus E = 29.0 × 10^6 psi for carbon steel; knockdown 0.9.",
      "**Substituted:** E_eff = 29.0 × 0.9 = 26.1", "29.0"],
    ["the exponent of '29 × 10^6 psi' is no '6 psi'", "Modulus E = 29 × 10^6 psi; factor 2.",
      "**Substituted:** P = 6 psi × 2 = 12 psi", "6 psi"],
    ["'6.5 x 10-6'", "Coefficient 6.5 x 10-6 in/in, length 100 ft, temperature rise 70.",
      "**Substituted:** ΔL = 6.5 × 100 ft × 70 = 45,500 ft", "6.5"],
    ["'3.2E-4' (was 'Q is 1,280'; the true value is 0.128)", "Leak coefficient 3.2E-4 per hour, 400 hours.",
      "**Substituted:** Q = 3.2 × 400 = 1,280", "3.2"],
    ["'1.5e-3' (already refused at 2baf69b: a lower-case 'e' read as an unread unit)",
      "Expansion coefficient 1.5e-3 per degree, run length 100 ft, rise 70.",
      "**Substituted:** ΔL = 1.5 × 100 ft × 70 = 10,500 ft", "1.5"],
    ["'1.5E-3' (was 'ΔL is 10,500 ft')", "Expansion coefficient 1.5E-3 per degree, run length 100 ft, rise 70.",
      "**Substituted:** ΔL = 1.5 × 100 ft × 70 = 10,500 ft", "1.5"],
    ["control: the operand written as '6.5e-6' binds nothing either (the source's value is not read)",
      ALPHA, "**Substituted:** ΔL = 6.5e-6 × 1,200 in × 70 = 0.546 in", "6.5e-6"],
  ])("%s is refused", (_v, passage, line, operand) => {
    expect(refused(line, sources({ 1: passage }))).toBe(`an operand no cited source holds: ${operand}`);
  });

  it("control: the same source's other values still bind ('1,200 in × 70')", () => {
    expect(okValue("**Substituted:** x = 1,200 in × 70 = 84,000 in", sources({ 1: ALPHA }))).toBe("84,000 in");
  });

  it.each([
    ["'6.5 × 10⁻⁶'", ALPHA, "**Substituted:** ΔL = 6.5 × 1,200 in × 70 = 0.546 in", ["546,000", "0.546"]],
    ["'29.0 × 10^6 psi'", "Modulus E = 29.0 × 10^6 psi for carbon steel; knockdown 0.9.",
      "**Substituted:** E_eff = 29.0 × 0.9 = 26.1", ["26.1"]],
    ["'6.5 x 10-6'", "Coefficient 6.5 x 10-6 in/in, length 100 ft, temperature rise 70.",
      "**Substituted:** ΔL = 6.5 × 100 ft × 70 = 45,500 ft", ["45,500"]],
    ["'3.2E-4'", "Leak coefficient 3.2E-4 per hour, 400 hours.", "**Substituted:** Q = 3.2 × 400 = 1,280", ["1,280"]],
    ["'1.5e-3'", "Expansion coefficient 1.5e-3 per degree, run length 100 ft, rise 70.",
      "**Substituted:** ΔL = 1.5 × 100 ft × 70 = 10,500 ft", ["10,500"]],
    ["'1.5E-3'", "Expansion coefficient 1.5E-3 per degree, run length 100 ft, rise 70.",
      "**Substituted:** ΔL = 1.5 × 100 ft × 70 = 10,500 ft", ["10,500"]],
    ["control '6.5e-6'", ALPHA, "**Substituted:** ΔL = 6.5e-6 × 1,200 in × 70 = 0.546 in", ["546,000", "0.546"]],
  ])("reproduction → fix, through the route: %s — no computed line, the result withheld, no 'differs' note", async (_v, passage, line, absent) => {
    // (The trailing sentence is for the scripted retrieval's query words.)
    conversionLibrary(`${passage} Check it at the hydrostatic test pressure and the design pressure.`);
    const text = `**Answer:** The value follows from the formula below [1].\n**Formula:** see the passage [1]\n${line}`;
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the value?" })).json();
    expect(computedOf(body.answer)).toEqual([]);
    expect(body.answer).not.toContain(COMPUTED_LABEL);
    expect(body.answer).not.toContain(COMPUTED_DISAGREES_NOTE);
    for (const a of absent) expect(body.answer).not.toContain(a);
    const shownLine = body.answer.split("\n").find((l: string) => l.startsWith("**Substituted:**"));
    expect(shownLine).toMatch(new RegExp(`= ${RESULT_WITHHELD.replace(/[[\]]/g, "\\$&")}$`));
    expect(rowsOf("knowledge_questions")[0].answer).toBe(body.answer);
  });
});

describe("I-33 fix pass 5 — the computed value is named by the symbol it is assigned to, never an input (major 2)", () => {
  const SRC = sources({ 1: "Hydrotest at 1.5 times the design pressure. Design pressure 285 psig." });
  const symbolOf = (line: string) => {
    const r = evaluateSubstitutedLine(line, SRC);
    if (!r.ok) throw new Error(r.reason);
    return r.step.symbol;
  };
  it.each([
    ["', so P_T' (was 'P is 427.5 psig')", "**Substituted:** P = 285 psig [1], so P_T = 1.5 × 285 psig = 427.5 psig", "P_T"],
    ["'With … : P_T' (was 'With is …')", "**Substituted:** With P = 285 psig [1]: P_T = 1.5 × 285 psig = 427.5 psig", "P_T"],
    ["'→ P_T' (was 'P is …')", "**Substituted:** P = 285 psig [1] → P_T = 1.5 × 285 psig = 427.5 psig", "P_T"],
    ["'with …, P_T' (was 'with is …')", "**Substituted:** with P = 285 psig [1], P_T = 1.5 × 285 psig = 427.5 psig", "P_T"],
    ["'Design P = …; test P_T' names nothing (was 'Design is …')",
      "**Substituted:** Design P = 285 psig; test P_T = 1.5 × 285 psig = 427.5 psig", null],
    ["control: the protocol's own shape", "**Substituted:** P_T = 1.5 × 285 psig", "P_T"],
    ["control: a step label", "**Substituted:** Step 2: P_T = 1.5 × 285 psig", "P_T"],
    ["control: an 'at' qualifier", "**Substituted:** P_T at 100 °F = 1.5 × 285 psig", "P_T"],
    ["control: no symbol written", "**Substituted:** 1.5 × 285 psig", null],
  ])("%s", (_v, line, symbol) => {
    expect(symbolOf(line)).toBe(symbol);
  });

  it("the line the app adds names P_T, or no name at all — never the input", () => {
    const named = presentComputedResults("**Substituted:** P = 285 psig [1], so P_T = 1.5 × 285 psig",
      "**Substituted:** P = 285 psig [1], so P_T = 1.5 × 285 psig", SRC).text.split("\n")[1];
    expect(named.startsWith(`**${COMPUTED_LABEL}** P_T is \`427.5 psig\``)).toBe(true);
    const unnamed = presentComputedResults("**Substituted:** Design P = 285 psig; test P_T = 1.5 × 285 psig",
      "**Substituted:** Design P = 285 psig; test P_T = 1.5 × 285 psig", SRC).text.split("\n")[1];
    expect(unnamed.startsWith(`**${COMPUTED_LABEL}** \`427.5 psig\``)).toBe(true);
  });

  it("reproduction → fix, through the route: the input P is never shown as 427.5 psig", async () => {
    hydrotestLibrary();
    const text = "**Answer:** The test pressure follows below [1].\n" +
      "**Substituted:** P = 285 psig [1], so P_T = 1.5 × 285 psig = 427.5 psig";
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const body = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    const line = body.answer.split("\n").find((l: string) => l.startsWith(`**${COMPUTED_LABEL}**`));
    expect(line).toContain("P_T is `427.5 psig`");
    expect(line).not.toContain("** P is");
  });
});

describe("I-33 fix pass 5 — an evaluator fault never fails the answer: the I-25 answer is delivered (minor 3)", () => {
  it("presentComputedResults throwing → 200 with the withheld answer byte for byte, saved, and the fault logged", async () => {
    const text = "**Answer:** The test pressure is below [1].\n- P = `285 psig` (USER-PROVIDED)\n" +
      "**Substituted:** P_T = 1.5 × `285 psig` = `427.5 psig`";
    // The reference: the route's answer when the evaluator adds nothing.
    hydrotestLibrary();
    vi.mocked(presentComputedResults).mockImplementationOnce((_m, shown) => ({ text: shown, computed: 0, disagreed: 0 }));
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const reference = await (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();
    expect(reference.answer).toContain(RESULT_WITHHELD);
    expect(reference.answer).not.toContain("427.5");

    resetHarness();
    hydrotestLibrary();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(presentComputedResults).mockImplementationOnce(() => { throw new RangeError("evaluator fault"); });
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(text)];
    const res = await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answer).toBe(reference.answer);
    expect(rowsOf("knowledge_questions")[0].answer).toBe(reference.answer);
    expect(errors.mock.calls.some((c) => c[0] === "[knowledge/ask] evaluator failed")).toBe(true);
    errors.mockRestore();
  });
});

describe("I-33 fix pass 5 — an inch mark is shown as 'in', never a detached quote (minor 4)", () => {
  it.each([['"'], ["″"]])("10.75%s → '0.0765938 in'", (mark) => {
    const s = sources({ 1: `P 285 psig, D 10.75${mark}, S 20,000 psi, factor 2` });
    expect(okValue(`**Substituted:** t = 285 psig × 10.75${mark} / (2 × 20,000 psi) = 0.0766${mark}`, s)).toBe("0.0765938 in");
  });
});
