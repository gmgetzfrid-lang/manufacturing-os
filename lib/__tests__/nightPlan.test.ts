// The next shift's plan, set by hand: it becomes the shift's list (day work
// put on nights included), what the schedule had that isn't on it reads as
// put off, and the morning after reads the shift against it.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, type ShiftTimes, type ShiftPlan } from "@/lib/shiftReport";
import { planChoices, planSearchPool, searchPlanPool, planToSave, expectOf, planSetText, offPlanText, planCheckText } from "@/lib/nightPlan";
import { nextOf, turnoverPlan } from "@/lib/turnoverPlan";
import { buildShiftSheet, workOrderOfStep } from "@/lib/shiftSheet";
import type { Milestone } from "@/types/schema";

const tz = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`2026-${d}T${hm}:00-07:00`)).toISOString();
const ms = (d: string, hm: string) => Date.parse(at(d, hm));
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", percentComplete: 0, attributes: {}, dependsOn: [], ...p } as Milestone);
const day27 = shiftWindow("2026-10-27", "day", tz, times);
const night27 = shiftWindow("2026-10-27", "night", tz, times);
const t = { D: (x: number) => new Date(x).toISOString().slice(5, 10), T: (x: number) => new Date(x).toISOString().slice(11, 16), DTs: (x: number) => new Date(x).toISOString().slice(5, 16) };

const schedule: Milestone[] = [
  mk({ id: "v1", name: "V-01 - Tower", workOrderRef: "304528", isSummary: true }),
  // Round-the-clock tower work, its crew set to days only (stale night setup).
  mk({ id: "tower", parentId: "v1", name: "Clean Tower", responsibleParty: "Schultz", staffedShift: "day", durationHours: 24, plannedStartAt: at("10-27", "06:00"), plannedAt: at("10-28", "18:00"), status: "in_progress", percentComplete: 30, actualStartAt: at("10-27", "07:00") }),
  mk({ id: "e12", name: "E-12 - Exchanger", workOrderRef: "301502", isSummary: true }),
  // On the schedule for the night.
  mk({ id: "blast", parentId: "e12", name: "Hydroblast Bundle", responsibleParty: "Ancon", durationHours: 8, plannedStartAt: at("10-27", "19:00"), plannedAt: at("10-28", "03:00") }),
  mk({ id: "test", parentId: "e12", name: "Hydrotest", responsibleParty: "Ancon", durationHours: 4, plannedStartAt: at("10-28", "01:00"), plannedAt: at("10-28", "05:00") }),
  // Days later: ready to start early.
  mk({ id: "blinds", name: "Set Blinds", workOrderRef: "300100", responsibleParty: "Maintenance (KE)", durationHours: 4, plannedStartAt: at("10-28", "20:00"), plannedAt: at("10-29", "00:00") }),
  mk({ id: "held", name: "Scaffold", workOrderRef: "300200", responsibleParty: "Brand", status: "on_hold", statusReason: "No scaffold", plannedStartAt: at("10-27", "20:00"), plannedAt: at("10-27", "23:00") }),
];
const now = ms("10-27", "17:30");
const base = buildShiftReport({ milestones: schedule, tz, times, shift: day27, now, lookAheadUntil: Infinity });

describe("without a plan, the schedule's own list", () => {
  it("the night's list is the file's night work; the tower (day crew only) waits for days", () => {
    expect(base.goals.byPlan).toBe(false);
    expect(base.goals.all.map((r) => r.leaf.id).sort()).toEqual(["blast", "test"]);
    expect([...base.goals.paused, ...base.goals.movedOff].map((r) => r.leaf.id)).toContain("tower");
  });
});

describe("what to pick from", () => {
  const groups = planChoices(base);
  it("the schedule's night work, the day crew's under way, ready early; nothing held; each once", () => {
    const of = (id: string) => groups.find((g) => g.rows.some((r) => r.leaf.id === id))?.id;
    expect(of("blast")).toBe("scheduled");
    expect(of("tower")).toBe("other");
    expect(of("blinds")).toBe("early");
    expect(of("held")).toBeUndefined();
    const ids = groups.flatMap((g) => g.rows.map((r) => r.leaf.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("a search finds any open step by WO, name or crew, every word; held ones shown, not pickable", () => {
    const pool = planSearchPool(base, groups);
    const byId = new Map(schedule.map((m) => [m.id!, m]));
    expect(searchPlanPool(pool, "304528", (id) => workOrderOfStep(id, byId)?.wo).map((x) => x.row.leaf.id)).toEqual(["tower"]);
    expect(searchPlanPool(pool, "ancon hydro").map((x) => x.row.leaf.id).sort()).toEqual(["blast", "test"]);
    expect(searchPlanPool(pool, "scaffold")).toMatchObject([{ held: true }]);
    expect(searchPlanPool(pool, "  ")).toEqual([]);
  });
});

describe("the plan as saved", () => {
  it("ids once, in the order ticked; a typed % only for steps on it, 0 to 100", () => {
    const p = planToSave(["tower", "blast", "tower"], { tower: "60", blast: "", gone: "50" }, "Gary", 1);
    expect(p).toEqual({ ids: ["tower", "blast"], expect: { tower: 60 }, setAt: 1, by: "Gary" });
    expect(expectOf("140")).toBe(100);
    expect(expectOf(" 45% ")).toBe(45);
    expect(expectOf("")).toBeUndefined();
  });
});

describe("with a plan, it is the night's list", () => {
  const plan: ShiftPlan = { ids: ["tower", "blast", "blinds"], expect: { tower: 70 }, setAt: ms("10-27", "16:10"), by: "Gary" };
  const r = buildShiftReport({ milestones: schedule, tz, times, shift: day27, now, plan });
  const row = (id: string) => r.goals.all.find((x) => x.leaf.id === id);
  it("only the plan's steps, day-crew tower work included; the rest of the schedule kept apart", () => {
    expect(r.goals.byPlan).toBe(true);
    expect(r.goals.all.map((x) => x.leaf.id).sort()).toEqual(["blast", "blinds", "tower"]);
    expect(r.goals.offPlan.map((x) => x.leaf.id)).toEqual(["test"]);
    expect([...r.goals.paused, ...r.goals.movedOff, ...r.goals.otherShift].some((x) => x.leaf.id === "tower")).toBe(false);
  });
  it("the % said for a step is its goal; work outside its planned hours gets the shift's hours", () => {
    expect(row("tower")?.goalPct).toBe(70);
    expect(row("blinds")?.hoursNext).toBe(4);
    expect(row("blinds")?.goalPct).toBe(100);
    expect(row("tower")?.hoursNext).toBeGreaterThan(0);
  });
  it("labels: a later step reads start early; under way reads continues", () => {
    expect(nextOf(r, row("blinds")!, "next", t)).toMatchObject({ label: "Start early", tone: "emerald" });
    expect(nextOf(r, row("tower")!, "next", t).label).toBe("Continues");
  });
  it("the turnover's next list is the plan", () => {
    const tp = turnoverPlan(r, () => false);
    expect(tp.items.filter((x) => x.kind === "next").map((x) => x.r.leaf.id).sort()).toEqual(["blast", "blinds", "tower"]);
  });
  it("words: who set it, what it leaves off", () => {
    expect(planSetText(plan, t)).toMatch(/^Plan set by Gary, /);
    expect(offPlanText(r)).toBe("Not on the plan, put off: 1 step the schedule had for the night shift (Hydrotest).");
    expect(offPlanText(base)).toBeNull();
  });
  it("the night's shift sheet is the plan, nothing added", () => {
    const sheet = buildShiftSheet({ milestones: schedule, tz, times, target: night27, now, plan });
    expect(sheet.groups.flatMap((g) => g.lines.map((l) => l.id)).sort()).toEqual(["blast", "blinds", "tower"]);
  });
  it("an empty plan leaves the shift nothing", () => {
    const e = buildShiftReport({ milestones: schedule, tz, times, shift: day27, now, plan: { ids: [] } });
    expect(e.goals.all).toEqual([]);
    expect(e.goals.offPlan.map((x) => x.leaf.id).sort()).toEqual(["blast", "test"]);
  });
});

describe("the morning after: the night against its plan", () => {
  // The night: blast done, tower moved 30 → 50, blinds not started, and
  // the hydrotest (not on the plan) done.
  const after = schedule.map((m) => m.id === "blast" ? { ...m, status: "completed", percentComplete: 100, actualStartAt: at("10-27", "19:00"), actualAt: at("10-28", "02:00") }
    : m.id === "tower" ? { ...m, percentComplete: 50 }
      : m.id === "test" ? { ...m, status: "completed", percentComplete: 100, actualStartAt: at("10-28", "02:00"), actualAt: at("10-28", "04:30") } : m) as Milestone[];
  const reviewPlan: ShiftPlan = { ids: ["tower", "blast", "blinds"] };
  const startPct = new Map([["tower", 30], ["blast", 0], ["test", 0], ["blinds", 0]]);
  const r = buildShiftReport({ milestones: after, tz, times, shift: night27, now: ms("10-28", "05:30"), reviewPlan, startPct });
  it("done, moved, not started, and what it did off the plan", () => {
    const p = r.review.plan!;
    expect(p.planned).toBe(3);
    expect(p.done.map((x) => x.leaf.id)).toEqual(["blast"]);
    expect(p.moved.map((x) => x.leaf.id)).toEqual(["tower"]);
    expect(p.untouched.map((x) => x.leaf.id)).toEqual(["blinds"]);
    expect(p.extra.map((x) => x.leaf.id)).toEqual(["test"]);
  });
  it("in one line", () => {
    expect(planCheckText(r)).toBe("Night plan: 3 steps. 1 done, 1 moved forward, 1 not started (Set Blinds). Also worked 1 not on it (Hydrotest).");
  });
  it("no plan given: no line", () => {
    expect(planCheckText(buildShiftReport({ milestones: after, tz, times, shift: night27, now: ms("10-28", "05:30") }))).toBeNull();
  });
});
