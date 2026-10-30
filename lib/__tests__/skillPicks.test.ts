import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: {} }));
import { skillFits, BUILTIN_ANSWER_SKILLS } from "@/lib/answerSkillsData";
import { skillsInPlay, buildAnswerSkillsBlock, type SkillRow } from "@/lib/answerSkillsServer";

const builtin = (key: string) => ({ builtin_key: key, instructions: BUILTIN_ANSWER_SKILLS.find((b) => b.builtin_key === key)!.instructions });

describe("which skill fits a question - the prompt bar's hint", () => {
  it("the selection skill fits a selection question, not a yes/no one", () => {
    expect(skillFits(builtin("catalog_selection"), "What piping spec should I use for 150 class sour gas")).toBe(true);
    expect(skillFits(builtin("catalog_selection"), "Can I use a 300 class flange on a vessel")).toBe(false);
  });
  it("others fit their own kinds of question", () => {
    expect(skillFits(builtin("basis_of_design"), "why do we require NACE trim")).toBe(true);
    expect(skillFits(builtin("troubleshooting_protocol"), "the pump keeps tripping on high vibration")).toBe(true);
    expect(skillFits(builtin("change_impact"), "can we replace the 304 pipe with 316")).toBe(true);
  });
  it("a workspace's own skill fits on the examples in its APPLIES WHEN line", () => {
    const mine = { builtin_key: null, instructions: 'APPLIES WHEN the question asks "how long is the inspection interval" for a vessel.\n- do x' };
    expect(skillFits(mine, "How long is the inspection interval for V-305?")).toBe(true);
    expect(skillFits(mine, "what gasket for steam")).toBe(false);
  });
  it("every built-in has a cue", () => {
    for (const b of BUILTIN_ANSWER_SKILLS) expect(() => new RegExp(b.cue)).not.toThrow();
  });
});

describe("skills picked for one question", () => {
  const rows: SkillRow[] = [
    { id: "11111111-1111-1111-1111-111111111111", builtin_key: "a", name: "On by default", instructions: "APPLIES WHEN x. Otherwise ignore this skill.", enabled: true, visibility: "org", created_by: null },
    { id: "22222222-2222-2222-2222-222222222222", builtin_key: "b", name: "Off by default", instructions: "APPLIES WHEN y. Otherwise ignore this skill.", enabled: false, visibility: "org", created_by: null },
    { id: "33333333-3333-3333-3333-333333333333", builtin_key: null, name: "Someone's private", instructions: "APPLIES WHEN z.", enabled: true, visibility: "private", created_by: "other" },
  ];
  it("no pick: the workspace's enabled skills", () => {
    expect(skillsInPlay(rows, "me").map((r) => r.name)).toEqual(["On by default"]);
  });
  it("a pick: exactly those - a disabled one switched on for this question, never a teammate's private one", () => {
    const ids = ["22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
    expect(skillsInPlay(rows, "me", ids).map((r) => r.name)).toEqual(["Off by default"]);
    expect(buildAnswerSkillsBlock(rows, "me", ids)).toMatch(/Off by default/);
    expect(buildAnswerSkillsBlock(rows, "me", [])).toBe("");
  });
});

describe("a skill's SEARCH: notes go to the query writer, not the answer", () => {
  it("splits them out", async () => {
    const { searchNotesOf, BUILTIN_ANSWER_SKILLS } = await import("@/lib/answerSkillsData");
    const { buildAnswerSkillsBlock } = await import("@/lib/answerSkillsServer");
    const instructions = "APPLIES WHEN x. Otherwise ignore this skill.\n- answer rule\nSEARCH: quote the class as \"class 150\"";
    expect(searchNotesOf(instructions)).toEqual(["quote the class as \"class 150\""]);
    const block = buildAnswerSkillsBlock([{ builtin_key: null, name: "S", instructions, enabled: true, visibility: "org", created_by: null }], null);
    expect(block).toContain("answer rule");
    expect(block).not.toContain("SEARCH:");
    const ratings = BUILTIN_ANSWER_SKILLS.find((b) => b.builtin_key === "pressure_ratings")!;
    expect(new RegExp(ratings.cue, "i").test("can I use a 300# flange on a 150 class line")).toBe(true);
    expect(new RegExp(ratings.cue, "i").test("why is hydrotest required")).toBe(false);
  });
});
