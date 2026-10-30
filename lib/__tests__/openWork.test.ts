import { describe, it, expect } from "vitest";
import { overdueOpenWork, startedEarlyWork, predecessorConflicts } from "@/lib/openWork";
import type { Milestone } from "@/types/schema";

const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00-05:00`);
const mk = (p: Partial<Milestone> & { id: string; name: string; plannedStartAt: number; plannedAt: number }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

const todayStart = at("2026-10-27", "00:00"), todayEnd = at("2026-10-28", "00:00");

describe("open work that must surface on today", () => {
  const parent = mk({ id: "p", name: "E-12", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-29", "10:00") });
  const dueYesterdayOpen = mk({ id: "a", name: "Pull bundle", parentId: "p", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "14:00"), status: "in_progress", percentComplete: 60 });
  const dueYesterdayDone = mk({ id: "b", name: "Set blinds", parentId: "p", plannedStartAt: at("2026-10-26", "06:00"), plannedAt: at("2026-10-26", "08:00"), status: "completed", percentComplete: 100 });
  const dueTwoDaysAgoNotStarted = mk({ id: "c", name: "Old step", parentId: "p", plannedStartAt: at("2026-10-25", "06:00"), plannedAt: at("2026-10-25", "10:00") });
  const today = mk({ id: "d", name: "Today step", parentId: "p", plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "12:00") });
  const tomorrowStarted = mk({ id: "e", name: "Tomorrow, begun", parentId: "p", plannedStartAt: at("2026-10-28", "08:00"), plannedAt: at("2026-10-28", "12:00"), status: "in_progress", percentComplete: 20 });
  const tomorrowUntouched = mk({ id: "f", name: "Tomorrow, untouched", parentId: "p", plannedStartAt: at("2026-10-28", "12:00"), plannedAt: at("2026-10-28", "14:00") });
  const all = [parent, dueYesterdayOpen, dueYesterdayDone, dueTwoDaysAgoNotStarted, today, tomorrowStarted, tomorrowUntouched];

  it("carry-over = open leaves whose planned finish has passed, oldest due first; done ones and parents excluded", () => {
    expect(overdueOpenWork(all, todayStart).map((w) => w.leaf.id)).toEqual(["c", "a"]);
  });
  it("critical-path carry-overs go first", () => {
    expect(overdueOpenWork(all, todayStart, new Set(["a"])).map((w) => w.leaf.id)).toEqual(["a", "c"]);
  });
  it("started early = underway leaves planned for a later day", () => {
    expect(startedEarlyWork(all, todayEnd).map((w) => w.leaf.id)).toEqual(["e"]);
  });
  it("a completed-early future step is neither overdue nor 'started early' - it's just done", () => {
    const doneEarly = mk({ id: "g", name: "Done early", plannedStartAt: at("2026-10-29", "08:00"), plannedAt: at("2026-10-29", "12:00"), status: "completed", percentComplete: 100 });
    expect(overdueOpenWork([doneEarly], todayStart)).toEqual([]);
    expect(startedEarlyWork([doneEarly], todayEnd)).toEqual([]);
  });
});

describe("dependency conflicts when pulling work forward", () => {
  const pred = mk({ id: "pred", name: "Hydroblast", plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "16:00") });
  const predDone = mk({ id: "pd", name: "Blinds", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "10:00"), status: "completed", percentComplete: 100 });
  const task = mk({ id: "t", name: "Inspect", plannedStartAt: at("2026-10-28", "08:00"), plannedAt: at("2026-10-28", "10:00"), dependsOn: ["pred", "pd", "ghost"] });
  const byId = new Map<string, Milestone>([["pred", pred], ["pd", predDone], ["t", task]]);
  it("flags unfinished predecessors that finish after the new start, ignores done and unknown ones", () => {
    const c = predecessorConflicts(task, at("2026-10-27", "10:00"), byId);
    expect(c.map((x) => x.pred.id)).toEqual(["pred"]);
  });
  it("is quiet when the new start is after every predecessor finishes", () => {
    expect(predecessorConflicts(task, at("2026-10-27", "16:00"), byId)).toEqual([]);
  });
});
