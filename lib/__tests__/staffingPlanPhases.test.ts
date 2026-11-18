import { describe, it, expect } from "vitest";
import { mergePlan, withoutRange, sourcesOf, planSpan, type StaffingPlan } from "@/lib/staffingPlan";

const plan = (file: string, days: string[], n: number): StaffingPlan => ({
  file, at: "2026-11-01T00:00:00Z", by: "eng@kern.test",
  shifts: Object.fromEntries(days.flatMap((d) => [[`${d}:day`, { direct: n, indirect: 2 }], [`${d}:night`, { direct: n - 2, indirect: 1 }]])),
  crafts: [{ name: `Craft ${file}`, code: "", direct: true }],
  byCraft: Object.fromEntries(days.map((d) => [`${d}:day`, { [`Craft ${file}`]: n }])),
});
const p1 = { from: "2026-10-24", to: "2026-10-31" }, p2 = { from: "2026-11-07", to: "2026-11-15" };

describe("a staffing plan per phase", () => {
  const one = mergePlan(null, plan("phase1.xlsx", ["2026-10-26", "2026-10-27"], 14), p1);
  const both = mergePlan(one, plan("phase2.xlsx", ["2026-11-09", "2026-11-10"], 9), p2);
  it("a second phase's sheet keeps the first phase's dates", () => {
    expect(Object.keys(both.shifts).sort()).toEqual(["2026-10-26:day", "2026-10-26:night", "2026-10-27:day", "2026-10-27:night", "2026-11-09:day", "2026-11-09:night", "2026-11-10:day", "2026-11-10:night"]);
    expect(sourcesOf(both).map((s) => s.file)).toEqual(["phase1.xlsx", "phase2.xlsx"]);
    expect(both.crafts?.map((c) => c.name).sort()).toEqual(["Craft phase1.xlsx", "Craft phase2.xlsx"]);
  });
  it("a new sheet for a phase replaces only that phase", () => {
    const again = mergePlan(both, plan("phase1-rev.xlsx", ["2026-10-28"], 20), p1);
    expect(Object.keys(again.shifts).filter((k) => k < "2026-11")).toEqual(["2026-10-28:day", "2026-10-28:night"]);
    expect(again.shifts["2026-11-09:day"].direct).toBe(9);
    expect(sourcesOf(again).map((s) => s.file)).toEqual(["phase1-rev.xlsx", "phase2.xlsx"]);
  });
  it("a sheet that runs past the phase only puts in the phase's dates", () => {
    const x = mergePlan(null, plan("season.xlsx", ["2026-10-26", "2026-11-09"], 10), p1);
    expect(planSpan(x)).toEqual({ from: "2026-10-26", to: "2026-10-26" });
  });
  it("removing a phase's plan keeps the rest; removing the last leaves none", () => {
    const left = withoutRange(both, p2)!;
    expect(planSpan(left)).toEqual({ from: "2026-10-26", to: "2026-10-27" });
    expect(sourcesOf(left).map((s) => s.file)).toEqual(["phase1.xlsx"]);
    expect(withoutRange(left, p1)).toBeNull();
  });
  it("a plan saved before there were phases' sources reads as one", () => {
    const old = plan("season.xlsx", ["2026-10-26", "2026-11-09"], 10);
    expect(sourcesOf(old)).toEqual([{ file: "season.xlsx", from: "2026-10-26", to: "2026-11-09", at: old.at, by: old.by }]);
  });
});
