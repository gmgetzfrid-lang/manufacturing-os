import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow, crewsOnReport, filterShiftReport, UNASSIGNED } from "@/lib/shiftReport";
import { quickLook, quickLookIndex, searchSteps } from "@/lib/taskQuickLook";
import { DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`); // CDT
const mk = (p: Partial<Milestone> & { id: string; name: string; plannedStartAt: string | number; plannedAt: string | number }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

// Day shift Oct 26 (05:30–17:30), turnover to the night shift.
const e12 = mk({ id: "e12", name: "E-12 - Exchanger No. 2", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "10:00"), isSummary: true });
const blinds = mk({ id: "a", name: "Set Blinds", parentId: "e12", responsibleParty: "Schultz 2", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00"), status: "completed", percentComplete: 100, durationHours: 2 });
const pull = mk({ id: "b", name: "Pull Bundle", parentId: "e12", responsibleParty: "Schultz 2", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "14:00"), status: "in_progress", percentComplete: 50, durationHours: 6 });
const blast = mk({ id: "c", name: "Hydroblast 10K Tubes", parentId: "e12", responsibleParty: "Evergreen 1", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-26", "22:00"), status: "planned", durationHours: 4, dependsOn: ["b"] });
const inspect = mk({ id: "d", name: "Inspect Tubes", parentId: "e12", responsibleParty: "Inspector", plannedStartAt: at("2026-10-26", "22:00"), plannedAt: at("2026-10-27", "04:00"), status: "planned", durationHours: 6, dependsOn: ["c"] });
const retube = mk({ id: "e", name: "Close Up", parentId: "e12", plannedStartAt: at("2026-10-27", "04:00"), plannedAt: at("2026-10-27", "10:00"), status: "planned", durationHours: 6 });
const all = [e12, blinds, pull, blast, inspect, retube];
const shift = shiftWindow("2026-10-26", "day", CHI);
const report = buildShiftReport({ milestones: all, criticalIds: new Set(), tz: CHI, shift, now: shift.end });

describe("one crew at a time", () => {
  it("lists every crew on the turnover, busiest first, unassigned last", () => {
    const crews = crewsOnReport(report);
    expect(crews[0]).toEqual({ who: "Schultz 2", steps: 2 });
    expect(crews.map((c) => c.who)).toContain("Evergreen 1");
    expect(crews.map((c) => c.who)).toContain("Inspector");
    if (crews.some((c) => c.who === UNASSIGNED)) expect(crews.at(-1)!.who).toBe(UNASSIGNED);
  });

  it("narrows every list to the crew, keeps the whole job's standing", () => {
    const ev = filterShiftReport(report, "Evergreen 1");
    expect(ev.review.done).toEqual([]);
    expect(ev.goals.all.map((r) => r.leaf.id)).toEqual(["c"]);
    expect(ev.goals.mustDoHours).toBe(4);
    expect(ev.overall).toEqual(report.overall);
    const sc = filterShiftReport(report, "Schultz 2");
    expect(sc.review.done.map((r) => r.leaf.id)).toEqual(["a"]);
    expect(sc.goals.all.every((r) => r.leaf.responsibleParty === "Schultz 2")).toBe(true);
  });
});

describe("a step's card", () => {
  const idx = quickLookIndex(all);
  const night = report.next;
  const o = { tz: CHI, times: DEFAULT_SHIFT_TIMES, asOf: shift.end, goalAt: night.end };

  it("answers: goal by end of shift, finish, equipment finish, what's next, what it waits on", () => {
    const q = quickLook("c", idx, o)!;
    expect(q.goal).toBe(100);                       // finishes 22:00, inside the night shift
    expect(q.finish).toBe(at("2026-10-26", "22:00"));
    expect(q.equipment).toMatchObject({ name: "E-12 - Exchanger No. 2", finish: at("2026-10-27", "10:00"), done: 1, total: 5 });
    expect(q.next.map((s) => s.name)).toEqual(["Inspect Tubes"]);     // what waits on it
    expect(q.waitsOn.map((s) => s.name)).toEqual(["Pull Bundle"]);    // 50%, not done
  });

  it("a step that runs past the shift gets its share as the goal", () => {
    const q = quickLook("e", idx, o)!;
    expect(q.goal).toBeGreaterThan(0);
    expect(q.goal).toBeLessThan(100);
  });

  it("with nothing waiting on it, the next step is the next one on the equipment; the last says so", () => {
    expect(quickLook("a", idx, o)!.next.map((s) => s.name)).toEqual(["Pull Bundle"]);
    expect(quickLook("e", idx, o)!.next).toEqual([]);
    expect(quickLook("e12", idx, o)).toBeNull();     // equipment, not a step
  });

  it("search finds steps by equipment, name, crew", () => {
    expect(searchSteps("e-12", idx).map((s) => s.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(searchSteps("hydroblast", idx).map((s) => s.id)).toEqual(["c"]);
    expect(searchSteps("evergreen", idx).map((s) => s.id)).toEqual(["c"]);
    expect(searchSteps("  ", idx)).toEqual([]);
  });
});
