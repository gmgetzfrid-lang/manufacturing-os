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

import { POST } from "@/app/api/knowledge/ask/route";
import {
  evaluateSubstitutedLine, presentComputedResults, withoutComputedLines, withholdModelResults, formatComputed,
  COMPUTED_LABEL, COMPUTED_DISAGREES_NOTE, COMPUTED_TOLERANCE, RESULT_WITHHELD, RESULT_WITHHELD_NOTE, CUT_OFF_LINE,
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
    // Another dimension cannot be compared: no claim either way (the number
    // is withheld regardless).
    expect(at("427.5 in")).toBeNull();
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
    expect(out.text.endsWith(RESULT_WITHHELD_NOTE)).toBe(true);
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
    expect(body.answer.endsWith(RESULT_WITHHELD_NOTE)).toBe(true);
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
    expect(routeSrc).toMatch(/if \(!partial\) \{[\s\S]{0,600}extractCitationNumbers\(modelText\)[\s\S]{0,400}pageTextOf\.get\(`\$\{c\.document_id\}:\$\{c\.page\}`\)[\s\S]{0,200}presentComputedResults\(modelText, answer, \{ cited, user: `\$\{question\}\\n\$\{inputs\}` \}\)/);
    expect(routeSrc).toContain("withholdModelResults(withoutComputedLines(t.answer)).text");
  });
});

// ── The page ─────────────────────────────────────────────────────────────

describe("PR-13 (I-33) — the answer surface marks the server's value as computed by the app", () => {
  it("the computed label renders as its own mark, never as a model value chip; the page's withholding pass is unchanged", () => {
    expect(pageSrc).toContain('import { withholdModelResults, RESULT_WITHHELD, COMPUTED_LABEL } from "@/lib/knowledgeAskGuards";');
    expect(pageSrc).toMatch(/if \(part === `\*\*\$\{COMPUTED_LABEL\}\*\*`\) \{\s*return \(\s*<span key=\{i\} data-computed-by-app="true"/);
    // The mark is checked before the generic bold branch.
    expect(pageSrc.indexOf("data-computed-by-app")).toBeLessThan(pageSrc.indexOf('if (part.startsWith("**") && part.endsWith("**"))'));
    expect(pageSrc).toMatch(/const shown = useMemo\(\(\) => withholdModelResults\(answer\.answer\), \[answer\.answer\]\);/);
    // The inline split reads the label as one bold part.
    expect(`**${COMPUTED_LABEL}**`).toMatch(/^\*\*[^*]+\*\*$/);
  });
});
