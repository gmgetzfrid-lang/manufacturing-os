// A finished job: every step done, when the last one finished against the
// plan (clocks going back counted right), and it opens on its close-out.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { workSummary, vsPlanWords, opensOnCloseout, workState, progressWarning } from "@/lib/closeoutStatus";

const m = (id: string, x: Record<string, unknown> = {}) => ({ id, name: id, parentId: null, status: "planned", percentComplete: 0, ...x } as unknown as Milestone);

describe("closeoutStatus", () => {
  const rows = [
    m("t"), m("a", { parentId: "t", status: "completed", plannedAt: "2026-10-31T18:00:00-07:00", actualAt: "2026-11-01T20:00:00-08:00" }),
    m("b", { parentId: "t", percentComplete: 100, plannedAt: "2026-10-30T18:00:00-07:00", actualAt: "2026-11-02T02:30:00-08:00" }),
    m("c", { parentId: "t", cancelledAt: "2026-10-29T00:00:00Z" }),
  ];
  it("every step done: the last finish against the last planned finish", () => {
    const w = workSummary(rows);
    expect(w).toMatchObject({ total: 2, done: 2, allDone: true, hoursAfterPlan: 33.5 });
    expect(new Date(w.finishedAt!).toISOString()).toBe("2026-11-02T10:30:00.000Z");
  });
  it("not all done: no finish", () => {
    const w = workSummary([...rows, m("d", { parentId: "t", plannedAt: "2026-11-01T00:00:00Z" })]);
    expect(w).toMatchObject({ total: 3, done: 2, allDone: false, finishedAt: null, hoursAfterPlan: null });
  });
  it("words", () => {
    expect(vsPlanWords(33.5)).toBe("33.5 h after plan");
    expect(vsPlanWords(-2)).toBe("2 h before plan");
    expect(vsPlanWords(0.2)).toBe("on plan");
  });
  it("opens on the close-out when done or completed", () => {
    const r = [{ id: "t", parent_id: null, status: "in_progress", percent_complete: 50 }, { id: "a", parent_id: "t", status: "completed", percent_complete: 100 }];
    expect(opensOnCloseout("active", r)).toBe(true);
    expect(opensOnCloseout("active", [...r, { id: "b", parent_id: "t", status: "planned", percent_complete: 0 }])).toBe(false);
    expect(opensOnCloseout("completed", [])).toBe(true);
    expect(opensOnCloseout("active", [])).toBe(false);
  });
});

describe("workState with phases", () => {
  const phases = [
    { id: "p1", name: "Phase 1", start: "2026-10-24", end: "2026-10-31", share: 50 },
    { id: "p2", name: "Phase 2", start: "2026-11-07", end: "2026-11-15", share: 50 },
  ];
  const row = (id: string, parent: string | null, status: string, attributes: unknown = null) => ({ id, parent_id: parent, status, percent_complete: status === "completed" ? 100 : 0, is_summary: false, cancelled_at: null, attributes });
  it("Phase 1 done, Phase 2 with no schedule: not done, Phase 2 to schedule", () => {
    const rows = [row("t", null, "planned"), row("a", "t", "completed"), row("b", "t", "completed")];
    const s = workState(rows, phases);
    expect(s.unscheduled.map((p) => p.id)).toEqual(["p2"]);
    expect(s).toMatchObject({ scheduledDone: true, allDone: false });
    expect(opensOnCloseout("active", rows, phases)).toBe(false);
  });
  it("both phases scheduled and done: done", () => {
    const rows = [row("t", null, "planned"), row("a", "t", "completed"), row("t2", null, "planned", { project_phase: "p2" }), row("c", "t2", "completed")];
    expect(workState(rows, phases)).toMatchObject({ unscheduled: [], allDone: true });
    expect(opensOnCloseout("active", rows, phases)).toBe(true);
  });
  it("no phases: every step done is done; marked complete always opens on close-out", () => {
    expect(opensOnCloseout("active", [row("a", null, "completed")])).toBe(true);
    expect(opensOnCloseout("completed", [row("a", null, "planned")])).toBe(true);
  });
});

describe("progressWarning", () => {
  it("says what a clear or replace would cut off", () => {
    const rows = [m("t", {}), m("a", { parentId: "t", status: "completed", percentComplete: 100 }), m("b", { parentId: "t", status: "in_progress", percentComplete: 40 }), m("c", { parentId: "t" })];
    expect(progressWarning(rows)).toBe("2 steps already have progress recorded (1 done, 1 started). This cuts that record off: the reports, the as-built schedule and each shift's history will no longer show it.");
    expect(progressWarning([m("t", {}), m("c", { parentId: "t" })])).toBe("");
  });
});
