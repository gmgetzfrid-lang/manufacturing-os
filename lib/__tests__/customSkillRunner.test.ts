// intelligence Round G (I-08) fix pass — LNK-6: a Connection Skill pattern
// cannot hold the request. The patterns run in a real worker thread and the
// runner terminates it on a hard deadline, whatever the regex is doing:
//   * a pattern INSIDE the bounded subset that still backtracks
//     catastrophically (the subset is a filter, not a proof) is stopped at
//     the per-text ceiling and reported as a hard overrun;
//   * the run's budget stops a skill mid-way;
//   * a soft overrun (read between matches, inside the worker) is per TEXT:
//     it skips the rest of that document only and keeps the worker — a long
//     manual of fast pages trips nothing; a terminated worker is replaced
//     on the next skill;
//   * under budget, the worker's matches make exactly the drafts the
//     in-thread path makes.

import { describe, it, expect } from "vitest";
import { workerSkillMatcher, SKILL_DOC_HARD_MS } from "@/lib/customSkillRunner";
import {
  patternSafetyIssue, compileSkillPatterns, proposeCustomReferences, customSkillDrafts, runCustomSkill,
  MAX_MATCHES_PER_TEXT, type TextOccurrence,
} from "@/lib/linkProposalLogic";

const limits = (over: Partial<{ softDocMs: number; budgetMs: number; maxMatches: number }> = {}) =>
  ({ softDocMs: 50, budgetMs: 15_000, maxMatches: MAX_MATCHES_PER_TEXT, ...over });

// Inside the subset, and cubic on a long run of letters (≈1 s at 800
// characters in V8; 5,000 would take minutes).
const SLOW = "\\w+a\\w+Q";
const PATHOLOGICAL = "a".repeat(5_000);

describe("LNK-6 — the subset is a filter; the worker's deadline is the guarantee", () => {
  it("the slow pattern is inside the subset (so only the deadline can stop it)", () => {
    expect(patternSafetyIssue(SLOW)).toBeNull();
    expect(compileSkillPatterns([SLOW]).regexes).toHaveLength(1);
  });

  it("a match that never returns is terminated at the per-text ceiling and named", async () => {
    const texts = ["see WO-10001", PATHOLOGICAL, "WO-10002"];
    const m = workerSkillMatcher({ hardDocMs: 300 })(texts, ["d1", "d2", "d3"]);
    try {
      const t0 = Date.now();
      const res = await m.match([SLOW], limits());
      const took = Date.now() - t0;
      expect(res.error).toBeNull();
      expect(res.terminated).toMatchObject({ index: 1 });
      expect(res.terminated!.ms).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(5_000);
      expect(res.found[0]).toEqual([]); // text 0 finished before the hang
      // the terminated worker is replaced for the next skill
      const next = await m.match(["\\bWO-\\d{5}\\b"], limits());
      expect(next.terminated).toBeNull();
      expect(next.found).toEqual([["WO-10001"], [], ["WO-10002"]]);
    } finally {
      await m.close();
    }
  }, 20_000);

  it("a catastrophic pattern the subset refuses is stopped just the same if it ever reached the runner", async () => {
    const m = workerSkillMatcher({ hardDocMs: 200 })([`${"a".repeat(40)}!`], ["d1"]);
    try {
      const res = await m.match(["(a+)+b"], limits());
      expect(res.terminated).toMatchObject({ index: 0 });
    } finally {
      await m.close();
    }
  }, 20_000);

  it("the run's budget stops a skill mid-way, whatever the per-text ceiling", async () => {
    const m = workerSkillMatcher({ hardDocMs: 60_000 })([PATHOLOGICAL], ["d1"]);
    try {
      const t0 = Date.now();
      const res = await m.match([SLOW], limits({ budgetMs: 300 }));
      expect(res.budgetSpent).toBe(true);
      expect(res.terminated).toBeNull();
      expect(Date.now() - t0).toBeLessThan(5_000);
      // no budget left: nothing runs
      const none = await m.match(["x"], limits({ budgetMs: 0 }));
      expect(none.budgetSpent).toBe(true);
    } finally {
      await m.close();
    }
  }, 20_000);

  it("a soft overrun is read between matches inside the worker: it skips the rest of THAT document, and the worker is kept", async () => {
    const m = workerSkillMatcher()(["WO-10001 WO-10002", "WO-10003", "WO-10004"], ["d1", "d1", "d2"]);
    try {
      const res = await m.match(["\\bWO-\\d{5}\\b"], limits({ softDocMs: -1 }));
      // every text is over a negative budget: each document is skipped once, at its first text
      expect(res.skipped.map((x) => x.index)).toEqual([0, 2]);
      expect(res.terminated).toBeNull();
      expect(res.found).toEqual([]);
      const again = await m.match(["\\bWO-\\d{5}\\b"], limits());
      expect(again.skipped).toEqual([]);
      expect(again.found).toEqual([["WO-10001", "WO-10002"], ["WO-10003"], ["WO-10004"]]);
    } finally {
      await m.close();
    }
  }, 20_000);

  it("fix pass 2: one slow page skips its document; the other documents still run", async () => {
    // Page 0 of d1 backtracks for tens of ms (inside the subset, under the
    // 1 s ceiling); page 1 of d1 is skipped with it; d2 runs.
    const m = workerSkillMatcher()(["a".repeat(300), "ba1Q", "ba1Q"], ["d1", "d1", "d2"]);
    try {
      const res = await m.match([SLOW], limits({ softDocMs: 5 }));
      expect(res.terminated).toBeNull();
      expect(res.skipped.map((x) => x.index)).toEqual([0]);
      expect(res.skipped[0].ms).toBeGreaterThan(5);
      expect(res.found[1]).toBeUndefined();
      expect(res.found[2]).toEqual(["ba1Q"]);
    } finally {
      await m.close();
    }
  }, 20_000);

  it("fix pass 2: the budget is per text — a long manual of fast pages trips nothing", async () => {
    // ≈3 MB in 1,200 pages of ONE document, eight identifier patterns, no
    // matches: tens of ms in all (the old per-document sum switched skills
    // off for this), microseconds per page.
    const page = "Inspect the pump seal and record the reading on the round sheet. ".repeat(38);
    const texts = Array.from({ length: 1_200 }, () => page);
    const patterns = ["\\bWO-\\d{5}\\b", "\\b[A-Z]{1,3}\\d{3,5}\\b", "\\bPTW-\\d{4,6}\\b", "\\bSOP-\\d{3}\\b",
      "\\bMOC-\\d{4}\\b", "\\bP&ID-\\d{3}\\b", "\\bTAG-\\d{2,5}\\b", "\\bNCR-\\d{4}\\b"];
    expect(compileSkillPatterns(patterns).errors).toEqual([]);
    const m = workerSkillMatcher()(texts, texts.map(() => "manual"));
    try {
      const res = await m.match(patterns, limits());
      expect(res.skipped).toEqual([]);
      expect(res.terminated).toBeNull();
      expect(res.found.filter(Array.isArray)).toHaveLength(1_200);
    } finally {
      await m.close();
    }
  }, 30_000);

  it("the default per-text ceiling is a second", () => {
    expect(SKILL_DOC_HARD_MS).toBe(1_000);
  });
});

describe("LNK-6 — under budget the worker's matches make the in-thread drafts", () => {
  it("customSkillDrafts over the worker's found strings equals proposeCustomReferences", async () => {
    const occ: TextOccurrence[] = [
      { documentId: "a", text: "Repairs per WO-10023 and WO-10023 again; see WO-10024.", page: 2, sourceRev: "3" },
      { documentId: "b", text: "Nothing here." },
      { documentId: "c", text: "Cross-ref WO-10023." },
    ];
    const index = new Map([["wo10023", ["b"]], ["wo10024", ["x", "y"]]]);
    const rule = { id: "r1", name: "Work orders" };
    const { regexes } = compileSkillPatterns(["\\bWO-\\d{5}\\b"]);
    const m = workerSkillMatcher()(occ.map((o) => o.text), occ.map((o) => o.documentId));
    try {
      const res = await m.match(regexes.map((r) => r.source), limits());
      const viaWorker = customSkillDrafts(rule, occ, res.found, index);
      const inThread = proposeCustomReferences({ ...rule, regexes }, occ, index);
      expect(viaWorker).toEqual(inThread);
      expect(viaWorker.length).toBeGreaterThan(0);
      for (const d of viaWorker) expect(d.evidence.sourceDocumentId).toMatch(/^[ac]$/);
    } finally {
      await m.close();
    }
  }, 20_000);

  it("the in-thread run honours the run deadline between matches", () => {
    let clock = 0;
    const { regexes } = compileSkillPatterns(["\\bWO-\\d{5}\\b"]);
    const res = runCustomSkill({ id: "r", name: "WO", regexes },
      [{ documentId: "d1", text: "WO-10001 WO-10002" }], new Map(),
      { budgetMs: 1_000, deadline: 15, now: () => (clock += 10) });
    expect(res.deadlineHit).toBe(true);
    expect(res.overBudget).toBeNull();
  });

  it("fix pass 2: the in-thread run's budget is per text too — two pages under it never add up to an overrun", () => {
    let clock = 0;
    const { regexes } = compileSkillPatterns(["\\bWO-\\d{5}\\b"]);
    // every now() advances 10: each page takes ~20-30, two pages ~50+ together
    const res = runCustomSkill({ id: "r", name: "WO", regexes },
      [{ documentId: "d1", text: "WO-10001" }, { documentId: "d1", text: "WO-10002" }, { documentId: "d1", text: "WO-10003" }],
      new Map([["wo10003", ["d2"]]]), { budgetMs: 40, now: () => (clock += 10) });
    expect(res.skipped).toEqual([]);
    expect(res.drafts).toHaveLength(1);
  });
});
