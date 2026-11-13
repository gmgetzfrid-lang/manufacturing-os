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
  // Late against its own date, done before the three above, nothing waiting on it.
  [step("e1", "we", "Swap Thermometer", "Inst", [at(26, 8), at(26, 10)], [at(27, 10), at(27, 12)]), [at(27, 10), at(27, 12)]],
];
const all: Milestone[] = [order("wa", "P-101 - Charge Pump"), order("wb", "S-4 - Suction Strainer"), order("wc", "PI-220 - Gauge"), order("wd", "F-9 - Filter"), order("we", "TI-7 - Thermometer"), ...rows.map((r) => r[0])];
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
      ["TI-7", 26, "start", 26, "Inst"],
    ]);
  });
  const look = buildLookBack({ milestones: all, notes: [], discoveries: discoveries(all), now: Date.parse(at(31, 12)), tz });
  const r = buildReview({ built, work, notes: [], look, discoveries: discoveries(all), tz });
  it("work among the last to finish is told, with the facts and no advice the record can't back", () => {
    const by = (tag: string) => r.findings.find((f) => f.title.startsWith(tag))!;
    // Open from start to finish is not hours worked: the as-built record says progress was logged on two shifts.
    expect(by("P-101").title).toBe("P-101 finished 42 h after its plan: Rebuild Pump was open 48 h, with progress logged on 2 shifts");
    expect(by("P-101").observation).toContain("Rebuild Pump (Shop) was open 48 h from start to finish, with progress logged on 2 shifts; planned as 6 h of work.");
    expect([by("P-101").next, by("P-101").ask, by("P-101").gap]).toEqual(["", "", "No reason was written on the step."]);
    expect(by("S-4").category).toBe("contractors");
    expect(by("PI-220").category).toBe("execution");
    // None is on the slide: each waits for a person to say what, if anything, to change.
    const pt = pointOf(r, "Phase 1", tz);
    expect(pt.conclusions).toEqual([]);
    expect(pt.pending.filter((c) => /^(P-101|S-4|PI-220)/.test(c.title)).every((c) => c.ask === "")).toBe(true);
  });
  it("a job that finished after its own date but cost nothing is not a finding", () => {
    // It is in the table of late work, for anyone who asks, and nowhere else.
    expect(r.late.some((o) => o.order.startsWith("TI-7"))).toBe(true);
    expect(r.findings.some((f) => f.title.startsWith("TI-7"))).toBe(false);
    expect(r.late.some((o) => o.order.startsWith("F-9"))).toBe(false);
  });
});
