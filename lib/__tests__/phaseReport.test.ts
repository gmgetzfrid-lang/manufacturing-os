// How a phase did: its own steps only, progress day by day from the log,
// and its share of the money (lines kept for a phase, the rest by share).

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { phaseStats, phaseReportHtml, slipWords, type CostLine, type CostEntry } from "@/lib/phaseReport";
import { PHASE_ATTR, type ProjectPhase } from "@/lib/projectPhases";

const tz = "America/Los_Angeles";
const at = (d: string, h = "12:00") => `${d}T${h}:00-08:00`;
const P: ProjectPhase[] = [
  { id: "a", name: "Transmix-1", start: "2026-11-01", end: "2026-11-03", share: 50 },
  { id: "b", name: "Transmix-2", start: "2026-11-08", end: "2026-11-10", share: 50 },
];
const m = (id: string, x: Record<string, unknown>) => ({ id, name: id, parentId: null, status: "planned", percentComplete: 0, ...x } as unknown as Milestone);
const ms: Milestone[] = [
  m("t1", {}), // phase 1 task
  m("s1", { parentId: "t1", plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-01", "15:00") }),
  m("s2", { parentId: "t1", plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "16:00"), durationHours: 10, status: "in_progress", percentComplete: 50 }),
  m("t2", { attributes: { [PHASE_ATTR]: "b" } }),
  m("s3", { parentId: "t2", plannedStartAt: at("2026-11-08", "06:00"), plannedAt: at("2026-11-08", "16:00"), durationHours: 20, attributes: { discovery: { id: "d1", seq: 1, what: "x", impact: { hours: 20 } } } }),
];
const log = [{ milestone_id: "s2", at: at("2026-11-02", "10:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 50 }] as never;
const lines: CostLine[] = [
  { id: "L1", name: "Mechanical", budget: 1000, phase_id: null },
  { id: "L2", name: "Cleaning", budget: 400, phase_id: "a" },
];
const entries: CostEntry[] = [
  { cost_account_id: "L1", entry_type: "actual", amount: 300, entry_date: "2026-11-02", status: "posted" },
  { cost_account_id: "L1", entry_type: "actual", amount: 100, entry_date: "2026-11-09", status: "posted" },
  { cost_account_id: "L2", entry_type: "commitment", amount: 200, entry_date: "2026-11-01", status: "posted" },
  { cost_account_id: "L1", entry_type: "actual", amount: 999, entry_date: "2026-11-02", status: "void" },
];
const now = Date.parse(at("2026-11-02", "18:00"));

describe("phaseStats", () => {
  const s = phaseStats({ milestones: ms, phases: P, phase: P[0], log, tz, now, total: 2000, lines, entries });
  it("only the phase's steps", () => {
    expect(s).toMatchObject({ steps: 2, done: 1, hours: 20, actualPct: 75, plannedPct: 100 });
    expect(s.added.count).toBe(0);
  });
  it("shift by shift: the plan stops once it's done; done as built; shifts to come have no done figure", () => {
    expect(s.shifts.map((r) => [r.dayKey, r.kind, r.plan, r.done, r.planEnds, r.current])).toEqual([
      ["2026-11-01", "day", 50, 50, false, false],
      ["2026-11-01", "night", 50, 50, false, false],
      ["2026-11-02", "day", 100, 75, true, false],
      ["2026-11-02", "night", null, 75, false, true],
    ]);
    // s1 was marked done with no start: spread from its planned start, and said so.
    expect(s.startGuessed).toBe(1);
    expect(s.planBasis).toMatchObject({ kind: "schedule", hours: 20, steps: 2 });
  });
  it("the shift under way is measured against the plan by now, not by its end", () => {
    const mid = Date.parse(at("2026-11-02", "11:00"));
    const r = phaseStats({ milestones: ms, phases: P, phase: P[0], log, tz, now: mid, total: 2000, lines, entries });
    const cur = r.shifts.find((x) => x.current)!;
    // s2 planned 6 AM to 4 PM: half way by 11 AM. Plan by now 75%, not the 100% due at 6 PM; done 75%.
    expect([cur.plan, cur.done]).toEqual([75, 75]);
    expect(r.plannedPct).toBe(75);
    expect(r.slip.forGood).toBeNull();
    // Behind now, with the phase still going: said as so far, not "for good".
    const idle = ms.map((x) => (x.id === "s2" ? ({ ...x, status: "planned", percentComplete: 0 } as Milestone) : x));
    const r2 = phaseStats({ milestones: idle, phases: P, phase: P[0], log: [], tz, now: mid, total: 2000, lines, entries });
    expect(slipWords(r2, tz).join(" ")).toMatch(/Behind the plan since Mon, Nov 2 · Day: [\d.]+% done against 75% planned so far, and hasn't caught up yet\./);
    expect(slipWords(r2, tz).join(" ")).not.toMatch(/for good/);
  });
  it("a step reset in the log and then finished counts as built: its % entered, then spread to its finish", () => {
    const ms2 = [
      m("r1", { plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-01", "15:00") }),
      m("r2", { plannedStartAt: at("2026-11-01", "06:00"), plannedAt: at("2026-11-01", "16:00"), durationHours: 10, status: "completed", percentComplete: 100, actualAt: at("2026-11-02", "09:00") }),
    ];
    const log2 = [
      { milestone_id: "r1", at: at("2026-10-31", "10:00"), old_status: "planned", old_percent: 0, new_status: "completed", new_percent: 100 },
      { milestone_id: "r1", at: at("2026-11-01", "08:00"), old_status: "completed", old_percent: 100, new_status: "planned", new_percent: 0 },
      { milestone_id: "r2", at: at("2026-11-01", "12:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 40 },
    ] as never;
    const r = phaseStats({ milestones: ms2, phases: [], phase: null, log: log2, tz, now: Date.parse(at("2026-11-05")), total: null, lines: [], entries: [] });
    expect(r.shifts.map((x) => x.done)).toEqual([77.9, 95, 100]);
    expect(r.shifts.map((x) => x.plan)).toEqual([100, null, null]);
  });
  it("the original plan as saved: re-planned dates don't move it; added work is counted on its own, from when it was found", () => {
    const found = Date.parse(at("2026-11-01", "20:00"));
    const ms3 = [
      m("b1", { plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "16:00"), baselineStartAt: at("2026-11-01", "06:00"), baselineFinishAt: at("2026-11-01", "16:00"), baselineSetAt: at("2026-10-30", "09:00"),
        durationHours: 10, status: "completed", percentComplete: 100, actualStartAt: at("2026-11-02", "06:00"), actualAt: at("2026-11-02", "15:00") }),
      m("a1", { plannedStartAt: at("2026-11-02", "06:00"), plannedAt: at("2026-11-02", "10:00"), durationHours: 4, status: "completed", percentComplete: 100, actualStartAt: at("2026-11-02", "06:00"), actualAt: at("2026-11-02", "09:00"),
        attributes: { discovery: { id: "d1", seq: 1, what: "x", foundAt: found, impact: { hours: 4 } } } }),
    ];
    const r = phaseStats({ milestones: ms3, phases: [], phase: null, log: [], tz, now: Date.parse(at("2026-11-05")), total: null, lines: [], entries: [] });
    expect(r.planBasis).toMatchObject({ kind: "baseline", hours: 10, steps: 1, finish: Date.parse(at("2026-11-01", "16:00")) });
    expect(r.outside).toEqual({ steps: 1, hours: 4 });
    expect(r.plannedFinish).toBe(Date.parse(at("2026-11-01", "16:00")));
    expect(r.shifts.map((x) => [x.plan, x.done, x.addedKnown, x.addedDone])).toEqual([[100, 0, 0, 0], [null, 0, 4, 0], [null, 100, 4, 4]]);
    expect(r.startGuessed).toBe(0);
    // Behind from the plan's finish until the work was done; what was behind, and what ran past it.
    expect(r.shifts.map((x) => x.finishes)).toEqual([false, false, true]);
    expect(r.slip.first?.dayKey).toBe("2026-11-01");
    expect(r.slip.forGood).toBe(r.slip.first);
    expect(r.slip.widest).toMatchObject({ points: 100, hours: 10 });
    expect(r.slip.behind.map((x) => [x.id, x.hoursBehind])).toEqual([["b1", 10]]);
    expect(r.slip.pastPlan.map((x) => [x.id, x.inPlan, x.hoursBehind])).toEqual([["a1", false, 4], ["b1", true, 10]]);
    const html = phaseReportHtml({ project: "T", tz, now: Date.parse(at("2026-11-05")), picked: null, all: r, each: [] });
    expect(html).toContain("Why it finished late");
    expect(html).toContain("Fell behind the plan for good Sun, Nov 1 · Day: 0% done against 100% planned");
    expect(html).toContain("Still going when the plan said done");
    expect(html).toContain("late</b>");
  });
  it("a schedule put in after its planned start, with nothing recorded before then, says so", () => {
    const late = ms.map((x) => ({ ...x, createdAt: at("2026-11-02", "13:00"), ...(x.id === "s1" ? { status: "planned", percentComplete: 0, actualAt: null } : {}) } as Milestone));
    const a = phaseStats({ milestones: late, phases: P, phase: P[0], log: [], tz, now, total: 2000, lines, entries });
    expect(a.loadedLate).toBe(Date.parse(at("2026-11-02", "13:00")));
    expect(slipWords(a, tz)[0]).toMatch(/^The schedule was put in Mon, Nov 2, 1:00 PM, after its planned start \(Sun, Nov 1, 6:00 AM\)/);
    // Recorded work before it was put in (entered after): no such note.
    expect(s.loadedLate).toBeNull();
  });
  it("the whole project in phases: no merged progress line; each phase against its own plan", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    const html = phaseReportHtml({ project: "T", tz, now, picked: null, all, each: [s, b] });
    const whole = html.slice(html.indexOf("Whole project</div>"), html.indexOf("Transmix-1</div>"));
    expect(whole).toContain("Each phase is measured against its own plan below");
    expect(whole).not.toContain("shift by shift");
    expect(html.slice(html.indexOf("Transmix-1</div>"))).toContain("shift by shift");
  });
  it("a phase with no schedule: not 0 of 0, and the whole project isn't done", () => {
    const only1 = ms.filter((x) => !["t2", "s3"].includes(x.id!)).map((x) => (x.id === "s2" ? { ...x, status: "completed", percentComplete: 100, actualAt: at("2026-11-02", "15:00") } as Milestone : x));
    const b = phaseStats({ milestones: only1, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    expect(b).toMatchObject({ noSchedule: true, steps: 0, shifts: [] });
    const a = phaseStats({ milestones: only1, phases: P, phase: P[0], log, tz, now, total: 2000, lines, entries });
    expect(a.finishedAt).toBe(Date.parse(at("2026-11-02", "15:00")));
    const all = phaseStats({ milestones: only1, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    expect(all.missing.map((p) => p.id)).toEqual(["b"]);
    expect(all.phasesDone).toBe(1);
    expect(all.finishedAt).toBeNull();
    const html = phaseReportHtml({ project: "Transmix", tz, now, picked: null, all, each: [a, b] });
    expect(html).toContain("no schedule yet, starts Sun, Nov 8");
    // Phase 1 finished Nov 2; the whole project didn't.
    expect(html).toMatch(/Transmix-1<div[^>]*>[^<]*<\/div><\/td>[\s\S]*?done Nov 2/);
    expect(html).toMatch(/Whole project<\/td>[\s\S]*?not finished/);
  });
  it("money: the phase's share of the AFE, its own lines whole, spend by date", () => {
    expect(s.budget).toBe(1000);
    expect(s.lines).toEqual([{ name: "Mechanical", budget: 500, committed: 0, spent: 300 }, { name: "Cleaning", budget: 400, committed: 200, spent: 0 }]);
    expect([s.committed, s.spent]).toEqual([200, 300]);
  });
  it("phase 2 and the whole project", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    expect(b).toMatchObject({ steps: 1, done: 0, added: { count: 1, steps: 1, hours: 20 }, budget: 1000, spent: 100 });
    expect(b.lines.map((l) => l.name)).toEqual(["Mechanical"]);
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    expect(all).toMatchObject({ steps: 3, budget: 2000, spent: 400, committed: 200 });
  });
  it("the report says it", () => {
    const b = phaseStats({ milestones: ms, phases: P, phase: P[1], log, tz, now, total: 2000, lines, entries });
    const all = phaseStats({ milestones: ms, phases: P, phase: null, log, tz, now, total: 2000, lines, entries });
    const html = phaseReportHtml({ project: "Transmix 1 and 2", tz, now, picked: s, all, each: [s, b] });
    expect(html).toContain("Transmix-1 phase report");
    expect(html).toContain("Whole project");
    expect(html).toContain("$1,000");
    expect(html).not.toMatch(/[—]/);
  });
});
