// intelligence Round G — the integrator's final independent review at the
// I-33 merge (2026-10-21) and its ruling (DEC-90, fail-safe).
//
// The review found Substituted expressions the evaluator read only IN PART —
// a clause or a word inside the expression ("1.3 × 285 psig (from the
// nameplate) × 20,000 psi / 17,100 psi"), or the expression continued on the
// next written line — and showed the value of that part (370.5 psig for an
// expression worth 433.3 psig) under "Computed by the app from the cited
// inputs"; and a decimal-comma "0,850" read as 850. Those are fixed and
// pinned below, but by the ruling the evaluator ships OFF behind the server
// switch ASK_CALC_EVALUATOR: off, presentComputedResults is never called and
// the answer is the I-25 answer, byte for byte; the label neutralization
// stays on in both states. Every other attempt of the review is kept as a pin
// (the value it shows, or the refusal).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
// The evaluator's entry point, spied on so a test can say it was never called.
vi.mock("@/lib/knowledgeAskGuards", async (orig) => {
  const real = await orig<typeof import("@/lib/knowledgeAskGuards")>();
  return { ...real, presentComputedResults: vi.fn(real.presentComputedResults) };
});

import { POST } from "@/app/api/knowledge/ask/route";
import {
  evaluateSubstitutedLine, presentComputedResults, withholdModelResults, neutralizeComputedLabels, askCalcEvaluatorOn,
  isServerComputedLine, isServerComputedLead, serverComputedLines, hasComputedLine,
  COMPUTED_LABEL, AI_WRITTEN_LABEL, RESULT_WITHHELD, RESULT_WITHHELD_NOTE, RESULT_WITHHELD_COMPUTED_NOTE,
  type CalcSources,
} from "@/lib/knowledgeAskGuards";
import { parseAnswerBlocks } from "@/lib/knowledgeText";

const root = resolve(__dirname, "..", "..");
const routeSrc = readFileSync(resolve(root, "app/api/knowledge/ask/route.ts"), "utf8");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");

const sources = (cited: Record<number, string>, user = ""): CalcSources =>
  ({ cited: new Map(Object.entries(cited).map(([k, v]) => [Number(k), v])), user });
/** A code passage with the factors, the allowable stresses and a few values
 *  in other units; the asker's own pressure, a bar value and an OD. */
const SRC = sources({
  1: "The hydrostatic test pressure shall be 1.5 times the design pressure. The stress ratio factor is 1.3. " +
    "S = 20,000 psi at test temperature and 17,100 psi at design temperature.",
  2: "Joint efficiency E = 0,850 (decimal comma). Prüffaktor 1,430. Range 100-150 psig. Thickness 12 in, 300 mm. " +
    "Torque 50 ft·lbf. Force 25 lbf. Mass 50 lb. Temperature 70 °F, 294 K. 10 kPa, 1 MPa. Ratio 0.5. 4 bolts. Atmosphere 14.7 psia. Exponent 2.",
}, "design pressure = 285 psig; 20 bar; OD 10.75 in");
const value = (line: string, s: CalcSources = SRC): string => {
  const r = evaluateSubstitutedLine(line, s);
  return r.ok ? r.step.display : `refused: ${r.reason}`;
};
const sub = (expr: string) => `**Substituted:** P_T = ${expr}`;
const computedOf = (answer: string): string[] => answer.split("\n")
  .filter((l) => l.startsWith(`**${COMPUTED_LABEL}**`))
  .map((l) => /`([^`]+)`/.exec(l)?.[1] ?? "");

afterEach(() => { delete process.env.ASK_CALC_EVALUATOR; });

// ── The blockers the review found (fixed; and the reason the switch is off) ──

describe("final review at the I-33 merge — an expression read only in part never shows the part's value (blocker)", () => {
  // 1.3 × 285 psig × 20,000 / 17,100 = 433.3 psig; its first part, 370.5 psig.
  it.each([
    ["a bracketed 'from' aside", "1.3 × 285 psig (from the nameplate) × 20,000 psi / 17,100 psi"],
    ["a ', per …,' aside", "1.3 × 285 psig, per UG-99, × 20,000 psi / 17,100 psi"],
    ["a bare 'per' aside", "1.3 × 285 psig per UG-99 × 20,000 psi / 17,100 psi"],
    ["a semicolon", "1.3 × 285 psig; × 20,000 psi / 17,100 psi"],
    ["a 'with' aside", "1.3 × 285 psig with margin × 20,000 psi / 17,100 psi"],
    ["an 'if' aside", "1.3 × 285 psig if hydro × 20,000 psi / 17,100 psi"],
    ["a '(see note)' aside", "1.3 × 285 psig (see note) × 20,000 psi / 17,100 psi"],
    ["a '(where …)' aside mid-expression", "1.3 × 285 psig (where P = design) × 20,000 psi / 17,100 psi"],
    ["a 'for the shell' aside", "1.3 × 285 psig for the shell × 20,000 psi / 17,100 psi"],
    ["'given'", "1.3 × 285 psig given × 20,000 psi / 17,100 psi"],
    ["'when'", "1.3 × 285 psig when cold × 20,000 psi / 17,100 psi"],
    ["'using'", "1.3 × 285 psig using × 20,000 psi / 17,100 psi"],
    ["'from'", "1.3 × 285 psig from × 20,000 psi / 17,100 psi"],
    ["', and' a second product", "1.3 × 285 psig, and 1.5 × 285 psig"],
    ["struck-through text (a '~' terminator)", "1.3 × 285 psig ~~× 20,000 psi / 17,100 psi~~"],
  ])("%s: refused (was 370.5 psig under the computed label)", (_v, expr) => {
    expect(value(sub(expr))).toMatch(/^refused: arithmetic on the line that the evaluated expression does not account for/);
  });

  it("an 'is' in the middle: refused (was 427.5 psig for '1.5 × 285 psig is the test pressure × 1.3')", () => {
    expect(value("**Substituted:** 1.5 × 285 psig is the test pressure × 1.3")).toMatch(/^refused: arithmetic on the line/);
  });

  it("REGRESSION: an input clause, a citation or a trailing aside after the whole expression still computes", () => {
    expect(value(sub("1.5 × 285 psig (where P = 285 psig is the design pressure)"))).toBe("427.5 psig");
    expect(value("**Substituted:** S_r = 1.3 × 20,000 psi / 17,100 psi (where S is the allowable stress)")).toBe("1.52047");
    expect(value(sub("1.5 × 285 psig, for the shell"))).toBe("427.5 psig");
    expect(value(sub("1.5 × 285 psig × 1.3 (per UG-99)"))).toBe("555.75 psig");
    expect(value(sub("1.5 × 285 psig [1] = 427.5 psig (2.947 MPa)"))).toBe("427.5 psig");
    expect(value(sub("1.5 × 285 psig = 427.5 psig, with P = 285 psig [1]"))).toBe("427.5 psig");
  });

  const answerWith = (substituted: string) =>
    `**Answer:** Compute P_T below [1].\n- P = \`285 psig\` (USER-PROVIDED)\n${substituted}\n**Check:** page 4 [1].`;
  it.each([
    ["an indented operator line", "**Substituted:** P_T = 1.3 × 285 psig\n  × 20,000 psi / 17,100 psi"],
    ["a bracketed product on the next line", "**Substituted:** P_T = (1.3 × 285 psig)\n× (20,000 psi / 17,100 psi)"],
    ["a bold continuation label", "**Substituted:** P_T = 1.3 × 285 psig\n**Substituted (cont.):** × 20,000 psi / 17,100 psi"],
    ["a blank line, then a dot operator", "**Substituted:** P_T = 1.3 × 285 psig\n\n  ⋅ 20,000 psi / 17,100 psi"],
    ["a division on the next line", "**Substituted:** P_T = 1.3 × 285 psig × 20,000 psi\n/ 17,100 psi"],
    ["a bracket on the next line (implicit product)", "**Substituted:** P_T = 1.3 × 285 psig\n(20,000 psi / 17,100 psi)"],
  ])("an expression continued on the next line (%s): nothing computed (was 370.5 psig, inserted between its halves)", (_v, sublines) => {
    const model = answerWith(sublines);
    const r = presentComputedResults(model, model, SRC);
    expect(r.computed).toBe(0);
    expect(r.text).toBe(model);
  });

  it("REGRESSION: the next line being another Substituted line, a Check line or an input bullet still computes", () => {
    for (const next of ["**Substituted:** t = 1.3 × 285 psig", "**Check:** the factor on page 4 [1].", "- P = `285 psig` (USER-PROVIDED)"]) {
      const model = `**Answer:** below [1].\n**Substituted:** P_T = 1.5 × 285 psig\n${next}`;
      expect(computedOf(presentComputedResults(model, model, SRC).text)[0]).toBe("427.5 psig");
    }
  });

  it("a decimal comma with a leading zero ('0,850') is no number, never 850 (was 242,250 psig)", () => {
    expect(value(sub("0,850 × 285 psig"))).toMatch(/^refused/);
    // …nor does a source's "0,850" hold an 850 a later operand may bind.
    expect(value(sub("850 × 285 psig"), sources({ 1: "E = 0,850" }, "285 psig"))).toMatch(/^refused: an operand no cited source holds: 850/);
    expect(value(sub("0.85 × 285 psig"), sources({ 1: "E = 0,850" }, "285 psig"))).toMatch(/^refused: an operand no cited source holds: 0.85/);
  });

  it("RESIDUAL (recorded on PR-13; why the evaluator ships off): a European '1,430' with three decimals is read as 1430", () => {
    // A German code's "Prüffaktor 1,430" is 1.43; the evaluator, which reads
    // "20,000" as twenty thousand, cannot tell them apart.
    expect(value(sub("1,430 × 20 bar"))).toBe("28,600 bar");
  });
});

describe("final review at the I-33 merge — the label is the server's alone (forged-label paths)", () => {
  const SERVER_LINE = `**${COMPUTED_LABEL}** P_T is \`427.5 psig\` — evaluated on the server from the Substituted expression above, ` +
    "each input matched to its source (1.5 [1]; 285 psig, your value); not the AI's arithmetic.";

  it("a model's 'not **Computed by the app from the cited inputs:**' is neutralized (the bold shape has no 'not' exemption)", () => {
    const out = neutralizeComputedLabels(`**Answer:** This is not **${COMPUTED_LABEL}** 500 psig.`);
    expect(out).not.toContain(`**${COMPUTED_LABEL}**`);
    expect(out).toContain(AI_WRITTEN_LABEL);
    expect(neutralizeComputedLabels(out)).toBe(out);
    // The prose form keeps its exemption, and the AI-written label stays idempotent.
    for (const t of ["This is not computed by the app: it is from page 4 [1].", `${AI_WRITTEN_LABEL} 481 psig`]) {
      expect(neutralizeComputedLabels(t)).toBe(t);
    }
  });

  it("…so the page's run-on hard wrap can never leave a model's label opening a block", () => {
    const filler = "word ".repeat(60);
    const model = `**Answer:** ${filler}this is not ${SERVER_LINE} ${filler}`;
    const out = neutralizeComputedLabels(model);
    for (const b of parseAnswerBlocks(out)) expect(b.text.startsWith(`**${COMPUTED_LABEL}**`)).toBe(false);
    expect(serverComputedLines(out)).toEqual([]);
  });

  it("the model's copy of the computed withheld note is marked AI-written, and the plain note is still appended", () => {
    const model = `**Answer:** below [1].\n**Substituted:** P_T = 1.5 × 285 psig = 500 psig\n${RESULT_WITHHELD_COMPUTED_NOTE}`;
    const n = neutralizeComputedLabels(model);
    expect(n.split("\n")[2]).toBe(`${AI_WRITTEN_LABEL} ${RESULT_WITHHELD_COMPUTED_NOTE}`);
    const w = withholdModelResults(n, "285 psig; 1.5 times");
    expect(w.text.endsWith(`\n\n${RESULT_WITHHELD_NOTE}`)).toBe(true);
    expect(w.text).not.toContain("500 psig");
  });

  it("the page's mark needs a line in the server's exact shape (or its carved lead); a bare or near-copy label is none", () => {
    expect(isServerComputedLine(SERVER_LINE)).toBe(true);
    expect(isServerComputedLine(`**${COMPUTED_LABEL}** P_T is \`450 psig\``)).toBe(false);
    expect(isServerComputedLine(`${SERVER_LINE} And 450 psig.`)).toBe(false);
    expect(isServerComputedLine(SERVER_LINE.replace("on the server", "by the AI"))).toBe(false);
    const lines = serverComputedLines(`x\n${SERVER_LINE}\n**${COMPUTED_LABEL}** 450 psig`);
    expect(lines).toEqual([SERVER_LINE]);
    expect(isServerComputedLead(SERVER_LINE, lines)).toBe(true);
    expect(isServerComputedLead(SERVER_LINE.slice(0, 120), lines)).toBe(true);
    expect(isServerComputedLead(`${SERVER_LINE.slice(0, 120)} …`, lines)).toBe(true);
    expect(isServerComputedLead(`**${COMPUTED_LABEL}** 450 psig`, lines)).toBe(false);
    expect(isServerComputedLead(SERVER_LINE, [])).toBe(false);
    expect(hasComputedLine(`**${COMPUTED_LABEL}** P_T is \`450 psig\``)).toBe(false);
  });
});

// ── Every other attempt of the review, kept as a pin ─────────────────────

describe("final review at the I-33 merge — attempts that show the right value or refuse (pins)", () => {
  it.each([
    // Pressure units: gauge, absolute, plain, SI prefixes and their case.
    ["1.5 × 285 psig", "427.5 psig"],
    ["1.5 × 285 PSIG", "427.5 PSIG"],
    ["1.5×285psig", "427.5 psig"],
    ["1.5 × 285 psi g", "refused"],
    ["285 psig + 14.7 psia", "refused: gauge and absolute pressure in one expression"],
    ["285 psig − 10 kPa", "refused: a pressure summed across gauge, absolute or plain units"],
    ["1.5 × 285 psig − 20 bar", "refused: a pressure summed across gauge, absolute or plain units"],
    ["1 MPa / 10 kPa", "100"],
    ["1 MPa × 0.5", "0.5 MPa"],
    ["1 mPa × 0.5", "refused"],
    // Lengths: in and mm, an inch mark.
    ["12 in × 0.5", "6 in"],
    ["300 mm − 12 in", "-4.8 mm"],
    ["300 mm + 12\"", "604.8 mm"],
    ["300 mm + 12 \"", "refused"],
    // Temperatures are never worked.
    ["70 °F × 1.5", "refused: a temperature (a scale with an offset is never worked)"],
    ["294 K × 1.5", "refused: a temperature (a scale with an offset is never worked)"],
    // Torque and force; "lb" (mass or force?) is not read.
    ["50 ft·lbf × 0.5", "25 ft·lbf"],
    ["25 lbf × 0.5", "12.5 lbf"],
    ["50 lb × 0.5", "refused"],
    ["25 lbf × 12 in", "refused: a result in a unit no operand carries"],
    // Implicit multiplication, unary minus, nesting.
    ["1.5(285 psig)", "427.5 psig"],
    ["(1.5)(285 psig)", "427.5 psig"],
    ["-1.5 × -285 psig", "427.5 psig"],
    ["285 psig × -0.5^2", "-71.25 psig"],
    ["((((285 psig)))) × ((1.5))", "427.5 psig"],
    ["(285 psig × 1.5", "refused: an unclosed bracket"],
    ["285 psig × 1.5)", "refused: text the expression does not account for"],
    // Division is the term's last operator.
    ["285 psig × 1.5 ÷ 0.5", "855 psig"],
    ["285 psig ÷ 0.5 × 1.5", "refused: an ambiguous division: a / b × c"],
    ["285 psig / 2(1.5)", "refused: an ambiguous division: a / b × c"],
    // Percentages.
    ["150 % × 285 psig", "427.5 psig"],
    ["150 percent of 285 psig", "427.5 psig"],
    ["1.5 of 285 psig", "refused"],
    ["1.5 × 285 psig × 100 %", "refused: an operand no cited source holds: 100 %"],
    // Fractions, decimal commas, SI grouping.
    ["0.5 × 3/4 in", "refused"],
    ["1,5 bar × 0.5", "refused"],
    ["1.5 × 20 000 psi", "30,000 psi"],
    ["1.5 × 2 85 psig", "refused"],
    // Ranges and tolerances.
    ["100-150 psig × 0.5", "refused"],
    ["1.5 ± 0.1 × 285 psig", "refused"],
    // Unicode look-alikes: a zero-width space, fullwidth digits, a Cyrillic x.
    ["1.5 × 2​85 psig", "refused"],
    ["１.５ × 285 psig", "refused"],
    ["1.5 х 285 psig", "refused"],
    // Citations bind only in the source they name.
    ["1.5 [1] × 285 psig", "427.5 psig"],
    ["1.5 [2] × 285 psig", "refused: an operand no cited source holds: 1.5"],
    ["1.5 [3] × 285 psig", "refused: an operand citing a source the answer was not given"],
  ])("P_T = %s → %s", (expr, expected) => {
    const got = value(sub(expr));
    if (expected === "refused") expect(got).toMatch(/^refused/);
    else expect(got).toBe(expected);
  });

  it("numbers next to identifiers: 'P1 = …' names P1; '2T = …' names nothing; '2T' inside the expression is refused", () => {
    expect(evaluateSubstitutedLine("**Substituted:** P1 = 1.5 × 285 psig", SRC)).toMatchObject({ ok: true, step: { symbol: "P1" } });
    expect(evaluateSubstitutedLine("**Substituted:** 2T = 1.5 × 285 psig", SRC)).toMatchObject({ ok: true, step: { symbol: null } });
    expect(value(sub("1.5 × 2T"))).toMatch(/^refused/);
  });

  it("a value repeated in the sources in another unit binds only in its own unit and number", () => {
    expect(value(sub("1.5 × 285"))).toMatch(/^refused: an operand no cited source holds: 285/);
    expect(value(sub("1.5 × 19.65 bar"))).toMatch(/^refused: an operand no cited source holds: 19.65 bar/);
  });

  it("the asker's own values bind (named 'your value'), and only those the asker gave", () => {
    const r = evaluateSubstitutedLine(sub("1.5 × 20 bar"), SRC);
    expect(r).toMatchObject({ ok: true, step: { display: "30 bar", inputs: [{ text: "1.5", source: "[1]" }, { text: "20 bar", source: "your value" }] } });
    expect(value(sub("1.5 × 21 bar"))).toMatch(/^refused: an operand no cited source holds: 21 bar/);
  });

  it("an extremely long line is not read; a line of 600 characters or less is", () => {
    expect(value(sub(`1.5 × 285 psig${" ".repeat(600)}`))).toBe("refused: a line longer than the evaluator reads");
    expect(value(sub(`1.5 × 285 psig${" ".repeat(500)}`))).toBe("427.5 psig");
  });

  it("the model's own result stays withheld whatever the evaluator does; a differing one is never shown", () => {
    const model = "**Answer:** below [1].\n**Substituted:** P_T = 1.5 × 285 psig = 600 psig\nSo test at 600 psig.";
    const shown = withholdModelResults(model, "design pressure = 285 psig\n1.5 times");
    const r = presentComputedResults(model, shown.text, SRC);
    expect(r.text).not.toContain("600");
    expect(computedOf(r.text)).toEqual(["427.5 psig"]);
  });

  it("an answer with no Substituted line comes back as the very same string", () => {
    const text = "**Answer:** The factor is 1.5 [1]. For your vessel the test pressure is 428 psig.";
    expect(presentComputedResults(text, text, SRC).text).toBe(text);
  });
});

// ── The ruling: ASK_CALC_EVALUATOR, default OFF ──────────────────────────

const ask = (body: Record<string, unknown>) => POST(new NextRequest("http://x/api/knowledge/ask", {
  method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" },
  body: JSON.stringify({ orgId: ORG, libraryId: LIB, ...body }),
}));
const QUERY_GEN = { text: '["hydrostatic test pressure", "design pressure"]', usage: { inputTokens: 300, outputTokens: 20 } };
const REFINE_NONE = { text: '{"queries": [], "missing_documents": []}', usage: { inputTokens: 500, outputTokens: 15 } };
const answerOf = (text: string) => ({ text, usage: { inputTokens: 4000, outputTokens: 180 } });
function hydrotestLibrary(extra: Record<string, Row[]> = {}) {
  resetDb({
    ...baseTables(),
    knowledge_documents: [kdoc("k-std", { name: "Relief standard.pdf" })],
    knowledge_chunks: [
      kchunk("k-std", "The relief valve set pressure shall not exceed the design pressure of the vessel. " +
        "The hydrostatic test pressure shall be 1.5 times the design pressure.", { id: "c-1", page: 4, section: "5.1 Relief" }),
      kchunk("k-std", "Set pressure tolerance for relief devices is plus or minus three percent.", { id: "c-2", page: 5, section: "5.2 Tolerance" }),
    ],
    ...extra,
  });
}
const PROTOCOL =
  "**Answer:** Compute P_T from the substituted expression below [1].\n**Basis:**\n" +
  "- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`\n**Check:** the 1.5 factor on page 4 [1].";
const WORKED =
  "**Answer:** The test pressure is below [1].\n- P = `285 psig` (USER-PROVIDED)\n" +
  "**Substituted:** P_T = 1.5 × `285 psig` = `427.5 psig`";
const SERVER_SHAPED_FORGERY =
  "**Answer:** Test at the value below [1].\n- P = `285 psig` (USER-PROVIDED)\n**Substituted:** P_T = 1.5 × `285 psig`\n" +
  `**${COMPUTED_LABEL}** P_T is \`500 psig\` — evaluated on the server from the Substituted expression above, ` +
  "each input matched to its source (1.5 [1]; 285 psig, your value); not the AI's arithmetic.";
const askHydro = async () => (await ask({ question: "What is the hydrotest pressure?", inputs: "design pressure = 285 psig" })).json();

beforeEach(() => {
  resetHarness();
  vi.mocked(presentComputedResults).mockClear();
});

describe("DEC-90 ruling at the I-33 merge — ASK_CALC_EVALUATOR, default OFF: the I-25 answer, byte for byte", () => {
  it("the switch reads exactly \"true\"; unset or anything else is off", () => {
    delete process.env.ASK_CALC_EVALUATOR;
    expect(askCalcEvaluatorOn()).toBe(false);
    for (const v of ["", "TRUE", "True", "1", "on", "yes", "true "]) {
      process.env.ASK_CALC_EVALUATOR = v;
      expect(askCalcEvaluatorOn()).toBe(false);
    }
    process.env.ASK_CALC_EVALUATOR = "true";
    expect(askCalcEvaluatorOn()).toBe(true);
  });

  it("switch unset: the protocol answer is returned and stored exactly as at I-25 (53b7973), and the evaluator is never called", async () => {
    delete process.env.ASK_CALC_EVALUATOR;
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(PROTOCOL)];
    const body = await askHydro();
    expect(body.answer).toBe(PROTOCOL);
    expect(body.arithmetic).toBe("unverified");
    expect(rowsOf("knowledge_questions")[0].answer).toBe(PROTOCOL);
    expect(presentComputedResults).not.toHaveBeenCalled();
  });

  it("switch unset: a worked result is withheld exactly as I-25 withholds it — no computed line, the plain note", async () => {
    delete process.env.ASK_CALC_EVALUATOR;
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(WORKED)];
    const body = await askHydro();
    expect(body.answer).toBe(WORKED.replace("= `427.5 psig`", `= ${RESULT_WITHHELD}`) + `\n\n${RESULT_WITHHELD_NOTE}`);
    expect(computedOf(body.answer)).toEqual([]);
    expect(body.answer).not.toContain(RESULT_WITHHELD_COMPUTED_NOTE);
    expect(presentComputedResults).not.toHaveBeenCalled();
  });

  it("switch unset, with a value that is not exactly \"true\": still the I-25 answer", async () => {
    process.env.ASK_CALC_EVALUATOR = "1";
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(PROTOCOL)];
    expect((await askHydro()).answer).toBe(PROTOCOL);
    expect(presentComputedResults).not.toHaveBeenCalled();
  });

  it("switch on: today's branch behaviour — the server's value under the Substituted line", async () => {
    process.env.ASK_CALC_EVALUATOR = "true";
    hydrotestLibrary();
    h.script = [QUERY_GEN, REFINE_NONE, answerOf(PROTOCOL)];
    const body = await askHydro();
    expect(presentComputedResults).toHaveBeenCalledTimes(1);
    expect(computedOf(body.answer)).toEqual(["427.5 psig"]);
    expect(serverComputedLines(body.answer)).toHaveLength(1);
  });

  it.each([["off", undefined], ["on", "true"]])(
    "switch %s: a model line forged in the server's exact shape is neutralized — the page has no server line to mark",
    async (_state, env) => {
      if (env === undefined) delete process.env.ASK_CALC_EVALUATOR;
      else process.env.ASK_CALC_EVALUATOR = env;
      hydrotestLibrary();
      h.script = [QUERY_GEN, REFINE_NONE, answerOf(SERVER_SHAPED_FORGERY)];
      const body = await askHydro();
      expect(body.answer).toContain(AI_WRITTEN_LABEL);
      expect(body.answer).not.toContain("500 psig");
      const lines = serverComputedLines(body.answer);
      // Off: none at all. On: only the server's own line, with its own value.
      expect(computedOf(lines.join("\n"))).toEqual(env === undefined ? [] : ["427.5 psig"]);
    },
  );

  it("the route reads the switch before the evaluator and keeps the neutralization outside it", () => {
    expect(routeSrc).toMatch(/if \(!partial && askCalcEvaluatorOn\(\)\) \{/);
    expect(routeSrc).toContain(": neutralizeComputedLabels(answerOut.text);");
    expect(routeSrc).toContain("const webText = neutralizeComputedLabels(out.text);");
  });

  it(".env.example names the switch, commented out (default off)", () => {
    expect(envExample).toMatch(/^# ASK_CALC_EVALUATOR=$/m);
    expect(envExample).toMatch(/default off[^\n]*\n(?:#[^\n]*\n)*# ASK_CALC_EVALUATOR=/i);
  });
});
