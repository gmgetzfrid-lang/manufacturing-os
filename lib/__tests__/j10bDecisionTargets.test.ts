// projects Round G — J10b UI REMAINDERS: projects-tab A11Y-14. The decision
// controls outside the Quality tab — the intake approvals and link
// controls, the bid table's actions and quote links, the change-order
// decisions, the Costs tab's ledger and entry controls — were 12-19 px boxes.
// They now carry the Quality tab's floor, lifted into ONE shared constant
// (components/projects/decisionTarget.ts): 24 px, 44 px on a coarse pointer,
// set on the control, never by a bare element rule; their clusters are
// spaced 8 px. A census (as a11yProjects.test.ts "A11Y-8 —" does for the
// Quality tab) pins it: every button whose click starts a write carries the
// floor, counted so a new one added without it fails here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Each `<button …>` opening tag, braces balanced. */
function buttonTags(s: string): string[] {
  const tags: string[] = [];
  for (let at = s.indexOf("<button"); at >= 0; at = s.indexOf("<button", at + 1)) {
    let depth = 0, i = at;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
      else if (s[i] === ">" && depth === 0) break;
    }
    tags.push(s.slice(at, i + 1));
  }
  return tags;
}

const CENSUS: Array<{ file: string; writes: RegExp; min: number; must: string[] }> = [
  {
    file: "components/projects/IntakePanel.tsx",
    writes: /onClick=\{(?:\(\) => (?:void (?:approve|reject|reissue|revoke|updateAssigned|createLink)\(|\{ void navigator\.clipboard|\{ setAssignOpen\())/,
    min: 9,
    must: ["void approve(p)", "void reject(p)", "void revoke(l)", "void reissue(l)", "void createLink()"],
  },
  {
    file: "components/projects/cost/QuotesPanel.tsx",
    writes: /onClick=\{(?:\(\) => (?:void (?:typeTotal|decline|create|submit|makeRfq|copy|reissue|revoke)\(|accountId && void onPost\()|onClick\}|async \(\) => \{\s*if \(!\(await appConfirm\(\{ message: `Void )/,
    min: 15,
    must: ["void typeTotal(doc)", "void decline(doc)", "void onPost(accountId)", "onClick={onClick}", "message: `Void ", "void revoke(l)"],
  },
  {
    file: "components/projects/cost/ChangeOrdersPanel.tsx",
    writes: /onClick=\{\(\) => void (?:decide|unwind|submit)\(/,
    min: 4,
    must: ['void decide(co, "approved"', 'void decide(co, "rejected")', "void unwind(co)"],
  },
  {
    file: "components/projects/CostsTab.tsx",
    writes: /onClick=\{(?:\(\) => void (?:repair|repairCo|submit|link|add)\(|async \(\) => \{\s*if \(!\(await appConfirm\(\{ message: `Void this )/,
    min: 9,
    must: ['void repair(d, "repost")', 'void repairCo(c, "reverse")', "message: `Void this ", "void link(p)", "void add()"],
  },
];

describe("A11Y-14 — decision controls outside the Quality tab carry the 24 / 44 px floor", () => {
  it("one shared constant, imported by the Quality tab and by every surface below", () => {
    const shared = src("components/projects/decisionTarget.ts");
    expect(shared).toContain('export const DECISION_TARGET = "min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3";');
    for (const f of ["components/projects/QualityTab.tsx", ...CENSUS.map((c) => c.file)]) {
      const s = src(f);
      expect(s, f).toContain('import { DECISION_TARGET } from "@/components/projects/decisionTarget";');
      expect(s, f).not.toMatch(/const DECISION_TARGET =/);
    }
    // no bare element rule in the shared stylesheet
    expect(src("app/globals.css")).not.toMatch(/@media \(pointer: coarse\)\s*\{\s*button\b/);
  });

  for (const { file, writes, min, must } of CENSUS) {
    it(`${file}: every button whose click starts a write carries the floor (counted)`, () => {
      const writers = buttonTags(src(file)).filter((t) => writes.test(t));
      const bare = writers.filter((t) => !t.includes("${DECISION_TARGET}"));
      expect(bare).toEqual([]);
      expect(writers.length).toBeGreaterThanOrEqual(min);
      for (const label of must) expect(writers.some((t) => t.includes(label)), label).toBe(true);
    });
  }

  it("decision clusters are spaced 8 px (gap-2 / ml-2), never 4-6 px", () => {
    const intake = src("components/projects/IntakePanel.tsx");
    const approve = intake.slice(intake.lastIndexOf("<span", intake.indexOf("void approve(p)")), intake.indexOf("void approve(p)"));
    expect(approve).toContain('className="ml-auto flex items-center gap-2"');
    const revoke = intake.slice(intake.lastIndexOf('<span className="ml-auto', intake.indexOf("void revoke(l)")), intake.indexOf("void revoke(l)"));
    expect(revoke).toContain('className="ml-auto flex items-center gap-2"');
    const co = src("components/projects/cost/ChangeOrdersPanel.tsx");
    const decide = co.slice(co.lastIndexOf("<span", co.indexOf('void decide(co, "approved"')), co.indexOf('void decide(co, "approved"'));
    expect(decide).toContain('className="ml-auto inline-flex items-center gap-2"');
    const costs = src("components/projects/CostsTab.tsx");
    expect((costs.match(/<span className="inline-flex items-center gap-2 ml-auto">/g) ?? []).length).toBe(2);
    const quotes = src("components/projects/cost/QuotesPanel.tsx");
    expect((quotes.match(/\$\{DECISION_TARGET\} ml-2 inline-flex/g) ?? []).length).toBe(2);   // correct total, Decline beside Award
    expect(quotes).toContain('<span className="inline-flex items-center gap-2">\n      <select value={accountId}');
  });
});
