// The report's tables in the order dragged at the meeting — the screen and
// the email the same, the next crew's numbers following it.

import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildShiftReport, shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import { turnoverPlan, doneByTask, inOrder } from "@/lib/turnoverPlan";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import { moveIds } from "@/components/projects/SortRows";
import type { Milestone } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", responsibleParty: "Ancon", shift: "both", ...p } as Milestone);
const f = { D: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 10), DTs: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 16), T: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };

const v7 = mk({ id: "v7", name: "V-7 Fractionator" });
const e17 = mk({ id: "e17", name: "E-17 Exchanger" });
const tonight = (id: string, parentId: string, hm: string) => mk({ id, name: `Step ${id}`, parentId, plannedStartAt: at("2026-10-27", hm), plannedAt: at("2026-10-27", `${Number(hm.slice(0, 2)) + 2}:00`) });
const doneToday = (id: string, parentId: string) => mk({ id, name: `Step ${id}`, parentId, status: "completed", percentComplete: 100, actualAt: at("2026-10-27", "10:00"), plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "10:00") });
const ms = [v7, e17, tonight("a", "v7", "19"), tonight("b", "e17", "20"), tonight("c", "v7", "21"), doneToday("d1", "v7"), doneToday("d2", "e17")];
const day = shiftWindow("2026-10-27", "day", LA, times);
const report = buildShiftReport({ milestones: ms, tz: LA, times, shift: day, now: day.end, startPct: new Map(ms.map((m) => [m.id!, m.status === "completed" ? 0 : 0])) });

describe("dragged order", () => {
  it("puts the dragged ones first, anything new after, in the usual order", () => {
    expect(inOrder(["a", "b", "c", "d"], (x) => x, ["c", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(inOrder(["a", "b"], (x) => x, undefined)).toEqual(["a", "b"]);
  });
  it("the next crew's list follows it — its numbers too", () => {
    const usual = turnoverPlan(report, () => false).items.filter((x) => x.kind === "next").map((x) => x.r.leaf.id);
    expect(usual).toEqual(["a", "b", "c"]);
    const mine = turnoverPlan(report, () => false, { next: ["c", "b", "a"] }).items.filter((x) => x.kind === "next").map((x) => x.r.leaf.id);
    expect(mine).toEqual(["c", "b", "a"]);
  });
  it("Done follows it, task by task", () => {
    const plan = turnoverPlan(report, () => false, { done: ["e17", "v7"] });
    expect(doneByTask(report, plan, f).map((x) => x.key)).toEqual(["e17", "v7"]);
    expect(doneByTask(report, turnoverPlan(report, () => false), f).map((x) => x.key)).toEqual(["v7", "e17"]);
  });
  it("the email keeps the order, naming a task again where it comes back", () => {
    const text = (order?: { next: string[] }) => toPlainText({ kind: "k", project: "p", when: "w", asOf: "a",
      sections: turnoverUpdate(report, f, { pctOf: () => 0, finishOf: () => undefined, order }) });
    const nextOf = (t: string) => t.slice(t.indexOf("NEXT"), t.indexOf("\n\n", t.indexOf("NEXT")));
    const mine = nextOf(text({ next: ["a", "b", "c"] }));
    expect(mine.indexOf("Step a")).toBeLessThan(mine.indexOf("Step b"));
    expect(mine.indexOf("Step b")).toBeLessThan(mine.indexOf("Step c"));
    expect(mine.match(/V-7 Fractionator/g)?.length).toBe(2);
    // The usual way: each task once, its steps under it.
    expect(nextOf(text()).match(/V-7 Fractionator/g)?.length).toBe(1);
  });
});

describe("dragging", () => {
  it("moves a row before another", () => {
    expect(moveIds(["a", "b", "c", "d"], ["d"], 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveIds(["a", "b", "c", "d"], ["a"], 3)).toEqual(["b", "c", "d", "a"]);
  });
  it("moves a task's rows together", () => {
    expect(moveIds(["a", "b", "c", "d"], ["c", "d"], 1)).toEqual(["a", "c", "d", "b"]);
  });
});
