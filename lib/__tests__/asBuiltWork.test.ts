import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import { buildAsBuilt } from "@/lib/asBuiltSchedule";
import { buildAsBuiltWork, toolHoursOf } from "@/lib/asBuiltWork";
import type { ProgressLogRow } from "@/lib/progressHistory";
import type { ShiftRecord } from "@/lib/shiftRecord";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [{ shift: "day" as const, start: "11:00", minutes: 30, label: "Lunch" }] };
// Mon Oct 26 2026, local times (PDT, -7).
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
const ms = (x: Partial<Milestone> & { id: string; name: string }): Milestone => ({ status: "completed", plannedAt: at(26, 18), percentComplete: 100, durationHours: 8, ...x } as Milestone);

const wo: Milestone = { id: "wo", name: "PSVs", status: "completed", plannedAt: at(26, 18), isSummary: true, attributes: { "Work Order": "300" } } as unknown as Milestone;
const psv = ms({ id: "psv", parentId: "wo", name: "PSV-021 swap", plannedStartAt: at(26, 10), plannedAt: at(26, 18), actualStartAt: at(26, 10), actualAt: at(30, 21, 30), actualParty: "Maintenance (KE)" });
const pull = ms({ id: "pull", parentId: "wo", name: "Remove piping", plannedStartAt: at(26, 6), plannedAt: at(26, 8), actualStartAt: at(26, 14), actualAt: at(26, 16), responsibleParty: "Maintenance (KE)", durationHours: 2 });
const blast = ms({ id: "blast", parentId: "wo", name: "Hydroblast piping", plannedStartAt: at(26, 8), plannedAt: at(26, 10), actualStartAt: at(28, 19), actualAt: at(29, 1), responsibleParty: "Ancon", durationHours: 2, dependsOn: ["pull"] });
const other = ms({ id: "other", parentId: "wo2", name: "E-12 hydroblast", plannedStartAt: at(27, 6), plannedAt: at(27, 10), actualStartAt: at(27, 7), actualAt: at(28, 15), responsibleParty: "Ancon", durationHours: 4 });
const wo2: Milestone = { id: "wo2", name: "E-12", status: "completed", plannedAt: at(27, 18), isSummary: true, attributes: { "Work Order": "301" } } as unknown as Milestone;
const all = [wo, wo2, psv, pull, blast, other];
const kids = new Map<string, Milestone[]>([["wo", [psv, pull, blast]], ["wo2", [other]]]);
const row = (id: string, t: string, from: number | null, to: number | null, st: ProgressLogRow["new_status"], old: ProgressLogRow["old_status"] = "in_progress"): ProgressLogRow => ({ milestone_id: id, at: t, old_status: old, new_status: st, old_percent: from, new_percent: to });
const log: ProgressLogRow[] = [
  row("psv", at(26, 10), 0, 0, "in_progress", "planned"),
  row("psv", at(27, 11), 0, 20, "in_progress"),
  row("psv", at(28, 14), 20, 40, "in_progress"),
  row("psv", at(30, 13), 40, 75, "in_progress"),
  row("psv", at(30, 21, 30), 75, 100, "completed"),
  row("pull", at(26, 16), 0, 100, "completed", "planned"),
  row("other", at(27, 9), 0, 50, "in_progress", "planned"),
  row("other", at(27, 20), 50, 80, "in_progress"),
  row("other", at(28, 15), 80, 100, "completed"),
  row("blast", at(29, 1), 0, 100, "completed", "planned"),
];
const note = (id: string, t: string, body: string): MilestoneNote => ({ milestoneId: id, kind: "note", body, createdAt: t, createdBy: "u", orgId: "o" });
const notes = [note("psv", at(27, 11), "PSV pulled. Discovered plugging in line."), note("psv", at(28, 10), "New PSV installed ready for E/I to run tubing for pilot"), note("psv", at(28, 14, 5), "Progress → 40%")];
const records = new Map<string, ShiftRecord>([["2026-10-27:day", { crews: { Ancon: { headcount: 10 } } }], ["2026-10-28:day", { crews: { Ancon: { headcount: 10, direct: 8, indirect: 2 } } }]]);

const built = buildAsBuilt({ milestones: all, childrenByParent: kids, tz });
const work = buildAsBuiltWork({ built, milestones: all, log, notes, records, companyOf: (c) => c, tz, times, now: Date.parse(at(31, 12)) });

describe("as-built work, shift by shift", () => {
  it("works only on shifts where progress moved, at the time it was set for", () => {
    expect(work.steps.get("psv")!.worked).toEqual(["2026-10-26:day", "2026-10-27:day", "2026-10-28:day", "2026-10-30:day", "2026-10-30:night"]);
  });
  it("in-progress waits, with the comments up to the end of each wait (not the ones that only repeat a number)", () => {
    const w = work.steps.get("psv")!.waits;
    expect(w.map((r) => [r.from, r.shifts])).toEqual([["2026-10-26:night", 1], ["2026-10-27:night", 1], ["2026-10-28:night", 3]]);
    expect(w[2].why).toEqual(["PSV pulled. Discovered plugging in line.", "New PSV installed ready for E/I to run tubing for pilot"]);
    expect(w[0].why).toEqual([]);
  });
  it("ready but not started: the shifts, and what its crew moved instead", () => {
    const r = work.steps.get("blast")!.ready!;
    expect(r.shifts).toEqual(["2026-10-26:night", "2026-10-27:day", "2026-10-27:night", "2026-10-28:day"]);
    expect(r.busyOn).toEqual(["E-12"]);
    expect(r.crewLogged).toBe(true);
  });
  it("a work order is worked where any step moved, waiting where one waited", () => {
    const o = work.orders.get([...work.orders.keys()].find((k) => built.orders.find((x) => x.key === k)?.name === "PSVs")!)!;
    expect(o.cells[0]).toBe("work");
    expect(o.cells[1]).toBe("wait");
  });
  it("crews: steps moved, plan hours of progress, counts, and a pace only from enough counts", () => {
    const ancon = work.crews.find((c) => c.crew === "Ancon")!;
    expect(ancon.byShift["2026-10-27:day"]).toMatchObject({ moved: 1, earned: 2, counted: { total: 10 } });
    expect(ancon.byShift["2026-10-28:day"].counted).toEqual({ total: 10, direct: 8, indirect: 2 });
    expect(ancon.pace?.from).toBe("counted");
    expect(work.totals).toMatchObject({ waitedSteps: 1, waitedShifts: 5, readySteps: 1, readyShifts: 4, countedShifts: 2 });
  });
  it("tool hours: the shift less breaks and the first hour", () => {
    expect(toolHoursOf(times)).toEqual({ day: 10.5, night: 11 });
  });
});
