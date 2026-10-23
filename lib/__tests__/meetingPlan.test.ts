import { describe, it, expect } from "vitest";
import { buildKickoff, buildCloseout, defaultMeeting } from "@/lib/meetingPlan";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`);
const mk = (p: Partial<Milestone> & { id: string; name: string; plannedStartAt: string | number; plannedAt: string | number }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

const e12 = mk({ id: "e12", name: "E-12", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-27", "10:00"), isSummary: true });
const a = mk({ id: "a", name: "Set Blinds", parentId: "e12", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00"), durationHours: 2, responsibleParty: "Mechanical" });
const b = mk({ id: "b", name: "Pull Bundle", parentId: "e12", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "14:00"), durationHours: 6, responsibleParty: "Mechanical" });
const c = mk({ id: "c", name: "Hydroblast", parentId: "e12", plannedStartAt: at("2026-10-26", "18:00"), plannedAt: at("2026-10-26", "23:00"), durationHours: 5, responsibleParty: "Cleaning Co" });
const crane = mk({ id: "k", name: "Mobilize crane", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "07:00"), status: "blocked", statusReason: "permit", durationHours: 1 });
const all = [e12, a, b, c, crane];

describe("kick-off agenda", () => {
  const k = buildKickoff({ milestones: all, criticalIds: new Set(["b", "c"]), tz: CHI });
  it("job at a glance", () => {
    expect(k.steps).toBe(4);
    expect(k.hours).toBe(14);
    expect(k.daysTotal).toBe(1);
  });
  it("equipment windows, critical chain, who, and what isn't ready", () => {
    expect(k.groups.map((g) => [g.name, g.steps, g.critical])).toEqual([["E-12", 3, 2], ["Mobilize crane", 1, 0]]);
    expect(k.critical.map((r) => r.leaf.id)).toEqual(["b", "c"]);
    expect(k.people.map((p) => [p.name, p.steps, p.hours])).toEqual([["Mechanical", 2, 8], ["Cleaning Co", 1, 5]]);
    expect(k.notReady.map((r) => r.leaf.id)).toEqual(["k"]);
  });
  it("the first day and night shifts, each with its own work", () => {
    expect(k.firstShifts.map((s) => s.window.kind)).toEqual(["day", "night"]);
    // The blocked crane step is under "not ready", not on the shift's work list.
    expect(k.firstShifts[0].rows.map((r) => r.leaf.id).sort()).toEqual(["a", "b"]);
    expect(k.firstShifts[1].rows.map((r) => r.leaf.id)).toEqual(["c"]);
  });
});

describe("close-out", () => {
  const done = (m: Milestone, actual: number): Milestone => ({ ...m, status: "completed", percentComplete: 100, actualAt: new Date(actual).toISOString() } as Milestone);
  const co = buildCloseout({ milestones: [e12, done(a, at("2026-10-26", "07:30")), done(b, at("2026-10-26", "16:00")), c, crane] });
  it("what finished, late or on time, and what's still open", () => {
    expect([co.done, co.steps, co.onTime, co.late]).toEqual([2, 4, 1, 1]);
    expect(co.open.map((r) => r.leaf.id)).toEqual(["c"]);
    expect(co.blocked.map((r) => r.leaf.id)).toEqual(["k"]);
  });
});

describe("which meeting to open on", () => {
  it("kick-off before day one, turnover during, close-out after", () => {
    expect(defaultMeeting(all, at("2026-10-25", "12:00"))).toBe("kickoff");
    expect(defaultMeeting(all, at("2026-10-26", "12:00"))).toBe("turnover");
    expect(defaultMeeting(all, at("2026-10-29", "12:00"))).toBe("closeout");
  });
});
