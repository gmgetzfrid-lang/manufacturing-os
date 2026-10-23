// The schedule audit's findings, one test each, so they stay fixed: the
// report must never say on time or behind and be wrong, and ordinary edits
// must never quietly damage the schedule.

import { describe, it, expect } from "vitest";
import {
  buildShiftReport, shiftWindow, paceOf, isOverdue, expectedFraction, expectedByParent, standingOf, BEHIND_POINTS,
} from "@/lib/shiftReport";
import { clampPercent, buildProgressIndex, overallPercent, effectiveWeight } from "@/lib/scheduleProgress";
import { cascadeDependents, computeSummaryResize, type ReflowNode } from "@/lib/scheduleReflow";
import { computeExecutionReport } from "@/lib/executionReport";
import { turnoverUpdate, noteLine } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import { filterMilestones, EMPTY_FILTER } from "@/lib/scheduleFilter";
import { workShiftOf } from "@/lib/shiftReport";
import { clockLabel, dayKey } from "@/lib/scheduleTz";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-05:00`)).toISOString(); // CDT
const day = (d: string) => new Date(Date.parse(`${d}T00:00:00-05:00`)).toISOString();             // plant midnight
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const ms = (iso: string) => Date.parse(iso);

describe("date-only tasks are due at the end of their day", () => {
  const t = mk({ id: "t", name: "Inspect", plannedStartAt: day("2026-10-26"), plannedAt: day("2026-10-26"), status: "in_progress", percentComplete: 30 });
  it("not overdue at 10:00 on its own day; overdue the next morning", () => {
    expect(isOverdue(t, ms(at("2026-10-26", "10:00")), CHI)).toBe(false);
    expect(paceOf(t, 30, ms(at("2026-10-26", "10:00")), CHI)).not.toBe("overdue");
    expect(isOverdue(t, ms(at("2026-10-27", "06:00")), CHI)).toBe(true);
  });
  it("isn't carried over by the night before its day", () => {
    const night = shiftWindow("2026-10-25", "night", CHI);
    const r = buildShiftReport({ milestones: [t], tz: CHI, shift: night, now: night.end });
    expect(r.review.carryOver).toEqual([]);
  });
});

describe("plan and actual are measured over the same steps, by work-hours", () => {
  it("a step with no dates doesn't drag the actual down", () => {
    const done = mk({ id: "a", name: "A", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "16:00"), status: "completed", percentComplete: 100 });
    const undated = mk({ id: "b", name: "Punch list", durationHours: 10 } as Partial<Milestone> & { id: string; name: string });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [done, undated], tz: CHI, shift, now: shift.end });
    expect(r.overall.actualPct).toBe(100);
    expect(r.overall.plannedPct).toBe(100);
    expect(r.overall.standing).toBe("on track");
    expect(r.overall.unscheduled).toBe(1);
  });
  it("a 1 h slip on an hours-less schedule reads as 1 h, not 50%", () => {
    const small = mk({ id: "s", name: "Small", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "07:00") });
    const big = mk({ id: "b", name: "Big", plannedStartAt: at("2026-10-26", "07:00"), plannedAt: at("2026-10-30", "11:00"), shift: "swing" as Milestone["shift"] });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [small, big], tz: CHI, shift, now: ms(at("2026-10-26", "07:00")) });
    expect(r.goals.gapHours).toBeGreaterThan(0.5);
    expect(r.goals.gapHours).toBeLessThan(1.5);
    expect(r.overall.standing).toBe("on track");
  });
  it("weights an hours-less step by its planned window; a date-only day counts whole", () => {
    expect(effectiveWeight({ plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "10:00") })).toBe(4);
    expect(effectiveWeight({ plannedStartAt: day("2026-10-26"), plannedAt: day("2026-10-28") })).toBe(72);
    expect(effectiveWeight({ durationHours: 5, plannedStartAt: day("2026-10-26"), plannedAt: day("2026-10-28") })).toBe(5);
  });
});

describe("unfinished work never rounds up to complete", () => {
  it("99.6% is 99%", () => {
    expect(clampPercent(99.6)).toBe(99);
    expect(clampPercent(100)).toBe(100);
  });
  it("a parent with a half-done 1 h step under 199 h of done work isn't 100%", () => {
    const p = mk({ id: "p", name: "P" });
    const a = mk({ id: "a", name: "A", parentId: "p", durationHours: 199, status: "completed", percentComplete: 100 });
    const b = mk({ id: "b", name: "B", parentId: "p", durationHours: 1, status: "in_progress", percentComplete: 50 });
    expect(buildProgressIndex([p, a, b]).get("p")!.percent).toBe(99);
    expect(overallPercent([p, a, b])).toBe(99);
  });
});

describe("a main task's plan includes its sub-groups", () => {
  it("expectedByParent rolls up through every level", () => {
    const p = mk({ id: "p", name: "P" });
    const q = mk({ id: "q", name: "Q", parentId: "p" });
    const l1 = mk({ id: "l1", name: "L1", parentId: "p", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00") });
    const l2 = mk({ id: "l2", name: "L2", parentId: "q", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "10:00") });
    const plan = expectedByParent([p, q, l1, l2], ms(at("2026-10-26", "08:00")), CHI);
    expect(plan.get("p")).toBe(50);
    expect(plan.get("q")).toBe(0);
  });
});

describe("a baselined day job moved to nights still shows its slip", () => {
  it("measures against the baseline's own crew hours", () => {
    const t = mk({
      id: "t", name: "Job", plannedStartAt: at("2026-10-26", "20:00"), plannedAt: at("2026-10-27", "04:00"),
      baselineStartAt: at("2026-10-26", "08:00"), baselineFinishAt: at("2026-10-26", "16:00"),
    });
    expect(expectedFraction(t, ms(at("2026-10-26", "12:00")), CHI)).toBeCloseTo(0.5, 2);
  });
});

describe("blocked work is a decision, not the next crew's list", () => {
  it("held steps are under Blocked and out of must-do hours", () => {
    const b = mk({ id: "b", name: "Remove trays", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-27", "04:00"), status: "blocked", statusReason: "crane down", percentComplete: 30, durationHours: 10 });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [b], tz: CHI, shift, now: shift.end });
    expect(r.goals.all).toEqual([]);
    expect(r.goals.mustDoHours).toBe(0);
    expect(r.blocked.map((x) => x.leaf.id)).toEqual(["b"]);
  });
});

describe("mid-shift, work due later today isn't carry-over yet", () => {
  it("a step due 16:00 at 10:00 is still this shift's", () => {
    const t = mk({ id: "t", name: "Hydro", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "16:00") });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [t], tz: CHI, shift, now: ms(at("2026-10-26", "10:00")) });
    expect(r.review.carryOver).toEqual([]);
  });
});

describe("one verdict for behind / on track / ahead", () => {
  it("the headline and the execution report agree", () => {
    expect(standingOf(48, 50)).toBe("on track");
    expect(standingOf(50 - BEHIND_POINTS, 50)).toBe("behind");
    expect(standingOf(50 + BEHIND_POINTS, 50)).toBe("ahead");
  });
  it("done at 100% counts as done in the execution report", () => {
    const t = mk({ id: "t", name: "T", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00"), status: "in_progress", percentComplete: 100 });
    const r = computeExecutionReport([t], { now: new Date(at("2026-10-27", "12:00")), tz: CHI });
    expect(r.done).toBe(1);
    expect(r.overdue).toBe(0);
  });
});

describe("linked steps follow the step before them, without a day gap", () => {
  const n = (id: string, s: string, f: string, deps: string[] = []): ReflowNode => ({ id, plannedStartAt: s, plannedAt: f, dependsOn: deps });
  it("08–10, 10–12, 12–14: moving the first a day moves each one day", () => {
    const a = n("a", at("2026-10-15", "08:00"), at("2026-10-15", "10:00"));
    const b = n("b", at("2026-10-14", "10:00"), at("2026-10-14", "12:00"), ["a"]);
    const c = n("c", at("2026-10-14", "12:00"), at("2026-10-14", "14:00"), ["b"]);
    const out = new Map(cascadeDependents([a, b, c], ["a"], CHI).map((x) => [x.id, x]));
    expect(dayKey(ms(out.get("b")!.plannedStartAt), CHI)).toBe("2026-10-15");
    expect(clockLabel(ms(out.get("b")!.plannedStartAt), CHI)).toBe("10:00");
    expect(dayKey(ms(out.get("c")!.plannedStartAt), CHI)).toBe("2026-10-15");
    expect(clockLabel(ms(out.get("c")!.plannedStartAt), CHI)).toBe("12:00");
  });
  it("stretching a phase keeps its steps' clock times", () => {
    const p: ReflowNode = { id: "p", plannedStartAt: at("2026-10-14", "08:00"), plannedAt: at("2026-10-14", "14:00") };
    const k: ReflowNode = { id: "k", parentId: "p", plannedStartAt: at("2026-10-14", "08:00"), plannedAt: at("2026-10-14", "10:00") };
    const out = computeSummaryResize([p, k], "p", "finish", 1, CHI).find((x) => x.id === "k")!;
    expect(ms(out.plannedAt)).toBeGreaterThan(ms(out.plannedStartAt));
    expect(clockLabel(ms(out.plannedStartAt), CHI)).toBe("8:00");
  });
});

describe("the management email judges a crew on its own work", () => {
  it("a night step doesn't make the day shift's row read blocked", () => {
    const v = mk({ id: "v", name: "V-500" });
    const d1 = mk({ id: "d1", name: "Day step", parentId: "v", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "16:00"), status: "in_progress", percentComplete: 90 });
    const n1 = mk({ id: "n1", name: "Night step", parentId: "v", plannedStartAt: at("2026-10-26", "19:00"), plannedAt: at("2026-10-27", "04:00"), status: "blocked", statusReason: "permit" });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const all = [v, d1, n1];
    const r = buildShiftReport({ milestones: all, tz: CHI, shift, now: shift.end });
    const steps = [d1, n1].map((m) => ({ id: m.id, name: m.name, start: ms(m.plannedStartAt as string), finish: ms(m.plannedAt as string), percent: m.percentComplete ?? 0, pace: paceOf(m, m.percentComplete ?? 0, shift.end, CHI), expectedPct: 0, status: m.status, work: workShiftOf(m, CHI) }));
    const f = { D: (x: number) => new Date(x).toISOString().slice(5, 10), DTs: (x: number) => new Date(x).toISOString().slice(5, 16), T: (x: number) => new Date(x).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };
    const secs = turnoverUpdate(r, f, { pctOf: () => 45, finishOf: () => ms(at("2026-10-27", "04:00")), stepsOf: () => steps });
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: secs });
    const last = text.split("\n").find((l) => l.includes("V-500 — 45%"))!;
    expect(last).toMatch(/Overdue — next step was due/);   // its own day step
    expect(last).not.toMatch(/Blocked/);         // the night step is under Needs a decision
    expect(text).toMatch(/NEEDS A DECISION\n.*Night step · Blocked · permit/);
  });
  it("comments fold line breaks and carry their date when older than the shift", () => {
    const D = (x: number) => new Date(x).toISOString().slice(5, 10);
    const since = ms(at("2026-10-26", "05:30"));
    expect(noteLine({ body: "Sent out\nfor calibration", at: at("2026-10-20", "09:00") }, since, D)).toBe("Sent out for calibration · 10-20");
    expect(noteLine({ body: "Back on site", at: at("2026-10-26", "09:00") }, since, D)).toBe("Back on site");
  });
});

describe("the Day/Night filter matches the day/night marks", () => {
  it("filters by the crew read from the task's times", () => {
    const nightJob = mk({ id: "n", name: "Night job", plannedStartAt: at("2026-10-26", "19:00"), plannedAt: at("2026-10-27", "03:00") });
    const dayJob = mk({ id: "d", name: "Day job", plannedStartAt: at("2026-10-26", "07:00"), plannedAt: at("2026-10-26", "15:00") });
    const ids = filterMilestones([nightJob, dayJob], { ...EMPTY_FILTER, shifts: ["night"] }, { shiftOf: (m) => workShiftOf(m, CHI) });
    expect([...ids]).toEqual(["n"]);
  });
});

import { coerceIsoStrict, dayFirstColumn, parseScheduleFile } from "@/lib/scheduleParsers";

describe("CSV dates are read in plant time, and impossible ones refused", () => {
  it("never rolls 15/08 into another year", () => {
    expect(coerceIsoStrict("15/08/2026", CHI)).toBeNull();
    expect(coerceIsoStrict("15/08/2026", CHI, true)).toBe(day("2026-08-15"));
    expect(coerceIsoStrict("2/30/2026", CHI)).toBeNull();
  });
  it("reads AM/PM and weekday-prefixed MS Project dates in the plant zone", () => {
    expect(coerceIsoStrict("8/15/2026 8:00 AM", CHI)).toBe(new Date(Date.parse("2026-08-15T08:00:00-05:00")).toISOString());
    expect(coerceIsoStrict("Mon 10/26/26 8:00 PM", CHI)).toBe(at("2026-10-26", "20:00"));
    expect(coerceIsoStrict("10/26/2026 12:00 AM", CHI)).toBe(day("2026-10-26"));
  });
  it("tells day-first columns from month-first ones", () => {
    expect(dayFirstColumn(["15/08/2026", "03/09/2026"]).dayFirst).toBe(true);
    expect(dayFirstColumn(["08/15/2026", "09/03/2026"]).dayFirst).toBe(false);
    expect(dayFirstColumn(["15/08/2026", "08/15/2026"]).ambiguous).toBe(true);
  });
});

describe("CSV rows without ids keep their identity when a row is inserted", () => {
  it("keys rows by name, not line number", () => {
    const a = parseScheduleFile("s.csv", "name,start,finish\nPull bundle,2026-10-26 08:00,2026-10-26 12:00\nHydroblast,2026-10-26 12:00,2026-10-26 16:00\n", { timeZone: CHI });
    const b = parseScheduleFile("s.csv", "name,start,finish\nSet blinds,2026-10-26 06:00,2026-10-26 08:00\nPull bundle,2026-10-26 08:00,2026-10-26 12:00\nHydroblast,2026-10-26 12:00,2026-10-26 16:00\n", { timeZone: CHI });
    const refOf = (rs: typeof a.rows, n: string) => rs.find((r) => r.name === n)!.externalRef;
    expect(refOf(b.rows, "Hydroblast")).toBe(refOf(a.rows, "Hydroblast"));
    expect(refOf(b.rows, "Pull bundle")).toBe(refOf(a.rows, "Pull bundle"));
  });
});

import { scheduleAt, type ProgressLogRow } from "@/lib/progressHistory";

describe("an earlier shift shows progress as it stood then", () => {
  const t = mk({ id: "t", name: "Retube", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "16:00"), status: "in_progress", percentComplete: 80 });
  const log: ProgressLogRow[] = [
    { milestone_id: "t", at: at("2026-10-20", "00:00"), old_status: "planned", old_percent: 0, new_status: "planned", new_percent: 0 },
    { milestone_id: "t", at: at("2026-10-26", "10:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 30 },
    { milestone_id: "t", at: at("2026-10-27", "09:00"), old_status: "in_progress", old_percent: 30, new_status: "in_progress", new_percent: 80 },
  ];
  it("at the end of the first day shift it was 30%, not today's 80%", () => {
    const r = scheduleAt([t], log, ms(at("2026-10-26", "17:30")));
    expect(r.milestones[0].percentComplete).toBe(30);
    expect(r.complete).toBe(true);
  });
  it("before its first change it was planned at 0%", () => {
    expect(scheduleAt([t], log, ms(at("2026-10-26", "08:00"))).milestones[0]).toMatchObject({ status: "planned", percentComplete: 0 });
  });
  it("a completion back-dated into the shift counts for that shift", () => {
    const done = { ...t, status: "completed", percentComplete: 100, actualAt: at("2026-10-27", "03:00") } as Milestone;
    const log2 = [...log, { milestone_id: "t", at: at("2026-10-27", "07:00"), old_status: "in_progress", old_percent: 80, new_status: "completed", new_percent: 100 } as ProgressLogRow];
    expect(scheduleAt([done], log2, ms(at("2026-10-27", "05:30"))).milestones[0]).toMatchObject({ status: "completed", percentComplete: 100 });
  });
  it("says when the log doesn't reach back that far", () => {
    expect(scheduleAt([t], log, ms(at("2026-10-19", "12:00"))).complete).toBe(false);
  });
});

import { parseLinkToken, earliestStart } from "@/lib/scheduleLinks";

describe("link types and lags are honoured", () => {
  const n = (id: string, s: string, f: string, deps: string[] = [], links?: ReflowNode["links"]): ReflowNode => ({ id, plannedStartAt: s, plannedAt: f, dependsOn: deps, links });
  it("start-to-start + 2 h: starts two hours after the other starts, not after it ends", () => {
    const a = n("a", at("2026-10-15", "08:00"), at("2026-10-15", "16:00"));
    const b = n("b", at("2026-10-15", "06:00"), at("2026-10-15", "09:00"), ["a"], { a: { type: "SS", lagHours: 2 } });
    const out = cascadeDependents([a, b], ["a"], CHI).find((x) => x.id === "b")!;
    expect(clockLabel(ms(out.plannedStartAt), CHI)).toBe("10:00");
  });
  it("finish-to-start + 12 h cure: starts 12 h after it ends", () => {
    const a = n("a", at("2026-10-15", "08:00"), at("2026-10-15", "16:00"));
    const b = n("b", at("2026-10-15", "17:00"), at("2026-10-15", "20:00"), ["a"], { a: { type: "FS", lagHours: 12 } });
    const out = cascadeDependents([a, b], ["a"], CHI).find((x) => x.id === "b")!;
    expect(out.plannedStartAt).toBe(at("2026-10-16", "04:00"));
  });
  it("finish-to-finish: finishes no earlier than the other", () => {
    expect(earliestStart({ type: "FF", lagHours: 0 }, { start: 0, end: 10 * 3600000 }, 4 * 3600000)).toBe(6 * 3600000);
  });
  it("reads MS Project / CSV predecessor text", () => {
    expect(parseLinkToken("5SS+1d")).toEqual({ id: "5", link: { type: "SS", lagHours: 24 } });
    expect(parseLinkToken("3FF-4h")).toEqual({ id: "3", link: { type: "FF", lagHours: -4 } });
    expect(parseLinkToken("7")).toEqual({ id: "7", link: { type: "FS", lagHours: 0 } });
  });
  it("a start-to-start successor isn't waiting once the other has started", () => {
    const a = mk({ id: "a", name: "Paint", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "16:00"), status: "in_progress", percentComplete: 20 });
    const b = mk({ id: "b", name: "Blast", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "12:00"), dependsOn: ["a"], linkTypes: { a: { type: "SS", lagHours: 0 } } });
    const shift = shiftWindow("2026-10-26", "day", CHI);
    const r = buildShiftReport({ milestones: [a, b], tz: CHI, shift, now: ms(at("2026-10-26", "09:00")) });
    const row = [...r.review.scheduled].find((x) => x.leaf.id === "b")!;
    expect(row.waitingOn).toEqual([]);
  });
});

describe("edge cases", () => {
  it("12 AM / 12 PM read correctly", () => {
    expect(coerceIsoStrict("10/26/2026 12:30 PM", CHI)).toBe(at("2026-10-26", "12:30"));
    expect(coerceIsoStrict("10/26/2026 12:30 AM", CHI)).toBe(at("2026-10-26", "00:30"));
    expect(coerceIsoStrict("10/26/2026 13:30 PM", CHI)).toBeNull();
  });
  it("duplicate names in a CSV without ids get distinct, stable keys", () => {
    const csv = "name,start,finish\nSet blinds,2026-10-26 06:00,2026-10-26 08:00\nSet blinds,2026-10-27 06:00,2026-10-27 08:00\n";
    const r = parseScheduleFile("s.csv", csv, { timeZone: CHI });
    const refs = r.rows.map((x) => x.externalRef);
    expect(new Set(refs).size).toBe(2);
  });
  it("a completed (locked) successor never moves, whatever the link", () => {
    const a: ReflowNode = { id: "a", plannedStartAt: at("2026-10-15", "08:00"), plannedAt: at("2026-10-15", "16:00") };
    const b: ReflowNode = { id: "b", plannedStartAt: at("2026-10-15", "06:00"), plannedAt: at("2026-10-15", "07:00"), status: "completed", dependsOn: ["a"], links: { a: { type: "SS", lagHours: 4 } } };
    expect(cascadeDependents([a, b], ["a"], CHI).find((x) => x.id === "b")).toBeUndefined();
  });
  it("a note dated by number works and an empty one is dropped", () => {
    const D = (x: number) => new Date(x).toISOString().slice(5, 10);
    expect(noteLine({ body: "x", at: ms(at("2026-10-20", "09:00")) }, ms(at("2026-10-26", "05:30")), D)).toBe("x · 10-20");
    expect(noteLine({ body: "   \n " }, 0, D)).toBeUndefined();
  });
  it("the plan by now can't exceed 100% or go negative", () => {
    const t = mk({ id: "t", name: "T", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00") });
    expect(expectedFraction(t, ms(at("2026-10-28", "06:00")), CHI)).toBe(1);
    expect(expectedFraction(t, ms(at("2026-10-20", "06:00")), CHI)).toBe(0);
  });
});

describe("sweep 1 fixes", () => {
  it("weights in the plant zone: a 24 h timed job is 24 h; a date-only task across the clock change is 3 days", () => {
    expect(effectiveWeight({ plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "06:00") }, CHI)).toBe(24);
    const s = new Date(Date.parse("2026-10-31T00:00:00-05:00")).toISOString(), f = new Date(Date.parse("2026-11-02T00:00:00-06:00")).toISOString();
    expect(effectiveWeight({ plannedStartAt: s, plannedAt: f }, CHI)).toBe(72);
    expect(effectiveWeight({ plannedStartAt: at("2026-10-26", "14:00"), plannedAt: at("2026-10-26", "14:00") }, CHI)).toBe(1);
  });
  it("5 points short is behind for a step, as for its task and the job", () => {
    const t = mk({ id: "t", name: "T", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "16:00"), status: "in_progress", percentComplete: 45 });
    const now = ms(at("2026-10-26", "11:00")); // 50% planned
    expect(Math.round(expectedFraction(t, now, CHI) * 100)).toBe(50);
    expect(paceOf(t, 45, now, CHI)).toBe("behind");
  });
  it("the forecast uses every day worked, past the planned end too", () => {
    const steps = Array.from({ length: 10 }, (_, i) => mk({ id: `s${i}`, name: `S${i}`, plannedStartAt: day("2026-10-01"), plannedAt: day("2026-10-04"),
      status: i < 5 ? "completed" : "in_progress", percentComplete: i < 5 ? 100 : 10 }));
    const r = computeExecutionReport(steps, { now: new Date(at("2026-10-11", "12:00")), tz: CHI });
    expect(Date.parse(r.forecastFinish!)).toBeGreaterThan(ms(at("2026-10-19", "00:00")));
  });
});

describe("sweep 3 fixes", () => {
  it("keeps predecessors with any MS Project lag unit", () => {
    expect(parseLinkToken("1FS+30m")).toEqual({ id: "1", link: { type: "FS", lagHours: 0.5 } });
    expect(parseLinkToken("2FS+1ed")).toEqual({ id: "2", link: { type: "FS", lagHours: 24 } });
    expect(parseLinkToken("4SS+50%")).toEqual({ id: "4", link: { type: "SS", lagHours: 0 }, approx: true });
    expect(parseLinkToken("4SS+1mo")?.link.lagHours).toBe(720);
    expect(parseLinkToken("7 weird")).toEqual({ id: "7", link: { type: "FS", lagHours: 0 }, approx: true });
    expect(parseLinkToken("abc")).toBeNull();
  });
  it("a task named \"Heater #1\" keeps its own key", () => {
    const r = parseScheduleFile("s.csv", "name,start,finish\nHeater #1,2026-10-26 06:00,2026-10-26 08:00\nHeater #1,2026-10-27 06:00,2026-10-27 08:00\n", { timeZone: CHI });
    expect(r.rows[0].externalRef).toBe("csv-key:heater #1");
    expect(r.rows[1].externalRef).toBe("csv-key:heater #1␟2");
  });
});
