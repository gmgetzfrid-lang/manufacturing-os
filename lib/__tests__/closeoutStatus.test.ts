// A finished job: every step done, when the last one finished against the
// plan (clocks going back counted right), and it opens on its close-out.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import { workSummary, vsPlanWords, opensOnCloseout } from "@/lib/closeoutStatus";

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
