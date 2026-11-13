import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork } from "@/lib/asBuiltWork";
import { buildLookBack } from "@/lib/lookBack";
import { discoveries } from "@/lib/discovery";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { lateOrders } from "@/lib/lateWork";
import { buildReview, pointOf } from "@/lib/postEventReview";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [] };
const at = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h + 7)).toISOString();
const order = (id: string, name: string): Milestone => ({ id, name, status: "completed", plannedAt: at(30, 18), isSummary: true } as unknown as Milestone);
const step = (id: string, parentId: string, name: string, crew: string, plan: [string, string], act: [string, string]): Milestone =>
  ({ id, parentId, name, status: "completed", percentComplete: 100, responsibleParty: crew, plannedStartAt: plan[0], plannedAt: plan[1], baselineStartAt: plan[0], baselineFinishAt: plan[1], actualStartAt: act[0], actualAt: act[1], durationHours: (Date.parse(plan[1]) - Date.parse(plan[0])) / 3_600_000 } as unknown as Milestone);
const done = (id: string, a: string, b: string): ProgressLogRow[] => [
  { milestone_id: id, at: a, old_status: "planned", new_status: "in_progress", old_percent: 0, new_percent: 10 },
  { milestone_id: id, at: b, old_status: "in_progress", new_status: "completed", old_percent: 10, new_percent: 100 },
];
// Three kinds of late, none of them a case the review has a rule for by name:
// a pump whose rebuild ran long, a strainer that sat before the next crew
// took it, and a gauge job that simply started late. And one on time.
const rows: Array<[Milestone, [string, string]]> = [
  [step("a1", "wa", "Pull Pump", "Mech", [at(26, 8), at(26, 10)], [at(26, 8), at(26, 10)]), [at(26, 8), at(26, 10)]],
  [step("a2", "wa", "Rebuild Pump (Seal and Bearings)", "Shop", [at(26, 10), at(26, 16)], [at(26, 10), at(28, 10)]), [at(26, 10), at(28, 10)]],
  [step("b1", "wb", "Pull Strainer", "Mech", [at(26, 8), at(26, 9)], [at(26, 8), at(26, 9)]), [at(26, 8), at(26, 9)]],
  [step("b2", "wb", "Clean Strainer", "Clean", [at(26, 9), at(26, 11)], [at(27, 15), at(27, 17)]), [at(27, 15), at(27, 17)]],
  [step("c1", "wc", "Replace Gauge", "Inst", [at(26, 8), at(26, 10)], [at(27, 14), at(27, 16)]), [at(27, 14), at(27, 16)]],
  [step("d1", "wd", "Swap Filter", "Mech", [at(26, 12), at(26, 14)], [at(26, 12), at(26, 14)]), [at(26, 12), at(26, 14)]],
];
const all: Milestone[] = [order("wa", "P-101 - Charge Pump"), order("wb", "S-4 - Suction Strainer"), order("wc", "PI-220 - Gauge"), order("wd", "F-9 - Filter"), ...rows.map((r) => r[0])];
const log = rows.flatMap(([m, t]) => done(m.id!, t[0], t[1]));
const kids = new Map<string, Milestone[]>();
for (const m of all) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
const work = buildAsBuiltWork({ built, milestones: all, log, notes: [], records: new Map(), companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });

describe("every late work order, and where its hours went", () => {
  const late = lateOrders(built, work);
  it("reads any work order the same way: a step over plan, a wait before the next crew, a late start", () => {
    expect(late.map((o) => [o.order.split(" - ")[0], o.lateH, o.parts[0].kind, o.parts[0].hours, o.parts[0].crew])).toEqual([
      ["P-101", 42, "over", 42, "Shop"],
      ["S-4", 30, "wait", 30, "Clean"],
      ["PI-220", 30, "start", 30, "Inst"],
    ]);
  });
  it("each one that nothing else explains becomes a conclusion with its own change", () => {
    const look = buildLookBack({ milestones: all, notes: [], discoveries: discoveries(all), now: Date.parse(at(31, 12)), tz });
    const r = buildReview({ built, work, notes: [], look, discoveries: discoveries(all), tz });
    const by = (tag: string) => pointOf(r, "Phase 1", tz).conclusions.find((c) => c.title.startsWith(tag))!;
    expect(by("P-101").title).toBe("P-101 finished 42 h after its plan: Rebuild Pump took 48 h against 6 h planned");
    expect(by("P-101").change).toBe("Find out why Rebuild Pump took 48 h, and plan it at what it really takes.");
    expect([by("S-4").category, by("S-4").change]).toEqual(["Contractors and resourcing", "Put Clean Strainer on Clean's list for the day it opens."]);
    expect([by("PI-220").category, by("PI-220").change]).toEqual(["Execution control", "Start PI-220 on its planned day, or move it in the plan to when Inst can take it."]);
    // The one that ran to plan is not mentioned.
    expect(r.late.some((o) => o.order.startsWith("F-9"))).toBe(false);
  });
});
