import { describe, it, expect } from "vitest";
import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { shiftAt } from "@/lib/shiftReport";
import { waitingAndReady } from "@/lib/waitingReady";

const tz = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00", breaks: [] };
// Mon Oct 26 2026, local times (PDT, -7).
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h + 7, m)).toISOString();
const order = (id: string, name: string): Milestone => ({ id, name, status: "in_progress", plannedAt: at(30, 18), isSummary: true } as unknown as Milestone);
const step = (x: Partial<Milestone> & { id: string; name: string; parentId: string }): Milestone => ({ status: "in_progress", plannedAt: at(26, 18), percentComplete: 0, ...x } as Milestone);
const row = (id: string, t: string, to: number, st: ProgressLogRow["new_status"] = "in_progress"): ProgressLogRow => ({ milestone_id: id, at: t, old_status: "in_progress", new_status: st, old_percent: 0, new_percent: to });
const note = (id: string, typed: string, body: string): MilestoneNote => ({ milestoneId: id, kind: "note", body, createdAt: typed, createdBy: "u", orgId: "o" });

const all: Milestone[] = [
  order("wv", "Control Valves"), order("we", "E-13 - Air Condenser"), order("wg", "Clean fuel gas header"), order("wt", "V-7 - Fractionator"),
  step({ id: "tv", parentId: "wv", name: "TV-006 (Service Valve)", responsibleParty: "Maintenance (KE)" }),
  step({ id: "bl", parentId: "we", name: "Pull Blinds", responsibleParty: "Schultz" }),
  step({ id: "ot", parentId: "wt", name: "Open manways", responsibleParty: "Schultz" }),
  step({ id: "pu", parentId: "wg", name: "Remove piping", responsibleParty: "Maintenance (KE)", status: "completed", actualAt: at(26, 16) }),
  step({ id: "hb", parentId: "wg", name: "Hydroblast piping", responsibleParty: "Ancon", status: "planned", dependsOn: ["pu"], plannedStartAt: at(26, 8) }),
  step({ id: "tr", parentId: "wt", name: "Clean trays", responsibleParty: "Schultz" }),
];
const log: ProgressLogRow[] = [
  row("tv", at(26, 8), 50), row("tv", at(29, 15), 100, "completed"),
  row("bl", at(27, 7), 30), row("bl", at(29, 10), 100, "completed"),
  row("ot", at(28, 9), 60),
  row("pu", at(26, 16), 100, "completed"),
  // The tower ran on nights: worked the nights of the 26th and 27th.
  row("tr", at(26, 20), 20), row("tr", at(27, 21), 50),
];
const notes = [note("tv", at(26, 13), "Caltrol picked up expected back in 72 hrs.")];
const on = (d: number, h: number) => waitingAndReady({ milestones: all, log, notes, tz, times, shift: shiftAt(Date.parse(at(d, h)), tz, times) });

describe("a shift's waiting and ready lists", () => {
  it("started jobs with nothing logged this shift, with the reason on record and how long", () => {
    const r = on(28, 12);
    // The trays' crew was on another step of the same work order: nothing says why the trays sat.
    expect(r.waiting.map((j) => [j.id, j.shifts, j.cause])).toEqual([["bl", 1, "crew_elsewhere"], ["tr", 1, "none"]]);
    expect(r.waiting.find((j) => j.id === "bl")!.crewOn).toEqual(["V-7 - Fractionator"]);
    // The valve is out for service: a planned step, listed apart from waiting.
    expect(r.service.map((j) => [j.id, j.shifts])).toEqual([["tv", 2]]);
    expect(r.service[0].said).toContain("Caltrol");
  });
  it("ready jobs that did not start: everything before them done before the shift began", () => {
    expect(on(26, 12).ready).toEqual([]);
    const r = on(28, 12).ready;
    expect(r.map((j) => [j.id, j.shifts])).toEqual([["hb", 2]]);
  });
  it("a night shift counts only for work that ran on nights", () => {
    const r = on(28, 22);
    // The valve and the blinds are day work. The tower ran on nights, so
    // both of its open steps count.
    expect(r.waiting.map((j) => j.id).sort()).toEqual(["ot", "tr"]);
    expect(r.ready).toEqual([]);
  });
  it("reads the shift as it stood at its end: later progress doesn't clear it", () => {
    // TV-006 finished on the 29th; on the 27th it was still sitting.
    expect(on(27, 12).service.map((j) => j.id)).toContain("tv");
    expect(on(29, 12).service.map((j) => j.id)).not.toContain("tv");
  });
});
