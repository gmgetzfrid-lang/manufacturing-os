// Changing what the next shift does, in the schedule itself: swap, pull
// in, push out — the planned dates move (the baseline doesn't), linked work
// after a moved step moves too, and the next shift's list follows.

import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
import { planShiftChange, planNote, laterShifts } from "@/lib/shiftPlan";
import { buildShiftReport, shiftWindow, nextShift, type ShiftTimes } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-07:00`);
const iso = (d: string, hm: string) => new Date(at(d, hm)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", shift: "both", ...p } as Milestone);

// Mon Oct 26. The night shift (18:00–06:00) is planned to do E-16's
// cleaning; E-17's bundle pull (Ancon, same area) is planned Wednesday.
// E-17's reinstall waits on the pull; Start-up waits on the reinstall.
const e16 = mk({ id: "e16", name: "E-16 Cooler", workOrderRef: "301240" });
const e17 = mk({ id: "e17", name: "E-17 Exchanger", workOrderRef: "301235" });
const base = () => [e16, e17,
  mk({ id: "clean", name: "Clean bundle", parentId: "e16", responsibleParty: "Ancon", plannedStartAt: iso("2026-10-26", "18:00"), plannedAt: iso("2026-10-27", "02:00"), workOrderRef: "301240" }),
  mk({ id: "pull", name: "Pull bundle", parentId: "e17", responsibleParty: "Ancon", plannedStartAt: iso("2026-10-28", "07:00"), plannedAt: iso("2026-10-28", "15:00"), workOrderRef: "301235" }),
  mk({ id: "reinstall", name: "Reinstall bundle", parentId: "e17", responsibleParty: "Ancon", plannedStartAt: iso("2026-10-28", "15:00"), plannedAt: iso("2026-10-28", "17:00"), dependsOn: ["pull"] }),
];
const day = shiftWindow("2026-10-26", "day", LA, times);
const night = nextShift(day, LA, times);
const now = at("2026-10-26", "17:30");
const o = { next: night, now, tz: LA, times };
const nextList = (ms: Milestone[]) => buildShiftReport({ milestones: ms, tz: LA, times, shift: day, now }).goals.all.map((r) => r.leaf.id);
const applied = (ms: Milestone[], moves: Array<{ id: string; plannedStartAt: string; plannedAt: string }>) =>
  ms.map((m) => { const c = moves.find((x) => x.id === m.id); return c ? { ...m, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : m; });

describe("plan the next shift", () => {
  it("swap: the one pulled in takes its place tonight; the one out takes the slot it had", () => {
    expect(nextList(base())).toEqual(["clean"]);
    const c = planShiftChange(base(), { kind: "swap", inId: "pull", outId: "clean" }, o)!;
    expect(c.in!.to).toEqual([at("2026-10-26", "18:00"), at("2026-10-27", "02:00")]);
    expect(c.out!.to).toEqual([at("2026-10-28", "07:00"), at("2026-10-28", "15:00")]);
    // Linked work after the pulled step doesn't come forward on its own;
    // nothing waits on the cleaning, so nothing else moves.
    expect(c.pushed).toEqual([]);
    expect(c.waits).toEqual([]);
    // The next shift's list is what was decided.
    expect(nextList(applied(base(), c.moves))).toEqual(["pull"]);
  });
  it("push out: off tonight, to the shift picked - and linked work after it moves too", () => {
    const ms = base().map((m) => (m.id === "reinstall" ? { ...m, plannedStartAt: iso("2026-10-27", "02:00"), plannedAt: iso("2026-10-27", "04:00"), dependsOn: ["clean"] } : m));
    const to = laterShifts(night, (w) => nextShift(w, LA, times))[0];       // Tue day
    const c = planShiftChange(ms, { kind: "push", outId: "clean", to: to.start }, o)!;
    expect(c.out!.to[0]).toBe(at("2026-10-27", "06:00"));
    expect(c.pushed.map((p) => [p.id, p.hours])).toEqual([["reinstall", 12]]);
    expect(nextList(applied(ms, c.moves))).toEqual([]);
  });
  it("pull in: what it still waits on is said before it's saved", () => {
    const c = planShiftChange(base(), { kind: "pull", inId: "reinstall" }, o)!;
    expect(c.in!.to[0]).toBe(at("2026-10-26", "18:00"));
    expect(c.waits.map((w) => w.name)).toEqual(["Pull bundle"]);
  });
  it("the task around a moved step refits to it", () => {
    const ms = [...base()].map((m) => (m.id === "e17" ? { ...m, plannedStartAt: iso("2026-10-28", "07:00"), plannedAt: iso("2026-10-28", "17:00") } : m));
    const c = planShiftChange(ms, { kind: "pull", inId: "pull" }, o)!;
    expect(c.moves.find((x) => x.id === "e17")?.plannedStartAt).toBe(iso("2026-10-26", "18:00"));
  });
  it("the reason goes on each step moved, in plain words", () => {
    const c = planShiftChange(base(), { kind: "swap", inId: "pull", outId: "clean" }, o)!;
    const lines = planNote(c, "crew's already in the area", () => "Mon night");
    expect(lines).toEqual([
      { id: "pull", body: "Re-planned to Mon night in place of WO 301240 Clean bundle - crew's already in the area" },
      { id: "clean", body: "Re-planned to Mon night - WO 301235 Pull bundle done first - crew's already in the area" },
    ]);
  });
});

describe("the crew that's there does it", () => {
  it("day-crew work pulled onto a night: worked on either crew's hours, by the crew named - and it's on the night's list", () => {
    const ms = base().map((m) => (m.id === "pull" ? { ...m, staffedShift: "day" as const, responsibleParty: "Schultz" } : m));
    const c = planShiftChange(ms, { kind: "swap", inId: "pull", outId: "clean" }, { ...o, crew: "Ancon" })!;
    expect(c.crewHours).toEqual(["Pull bundle is day-crew work"]);
    expect(c.inPatch).toEqual({ shift: "swing", responsibleParty: "Ancon" });
    const after = applied(ms, c.moves).map((m) => (m.id === "pull" ? { ...m, ...c.inPatch, staffedShift: undefined } : m));
    expect(nextList(after)).toEqual(["pull"]);
  });
  it("the shift's own work, by its own crew: nothing else changes", () => {
    const c = planShiftChange(base(), { kind: "swap", inId: "pull", outId: "clean" }, { ...o, crew: "Ancon" })!;
    expect(c.inPatch).toBeUndefined();
  });
});
