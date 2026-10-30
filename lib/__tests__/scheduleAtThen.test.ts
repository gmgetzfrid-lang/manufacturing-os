// A past shift's report knows only what had happened by then: no start
// that came later, and no work added later.

import { describe, it, expect } from "vitest";
import { scheduleAt } from "@/lib/progressHistory";
import type { Milestone } from "@/types/schema";

const t = (d: string) => Date.parse(d);
const mk = (p: Partial<Milestone> & { id: string }): Milestone => ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "msproject", createdBy: "u", ...p } as Milestone);
const row = (id: number, mid: string, at: string, o: [string | null, number | null], n: [string, number]) =>
  ({ id, milestone_id: mid, at, old_status: o[0], old_percent: o[1], new_status: n[0], new_percent: n[1] }) as never;

const live = [
  mk({ id: "a", status: "in_progress", percentComplete: 40, actualStartAt: "2026-10-28T15:00:00Z" }),
  mk({ id: "b", status: "completed", percentComplete: 100, actualStartAt: "2026-10-26T15:00:00Z", actualAt: "2026-10-27T15:00:00Z" }),
  mk({ id: "found", source: "manual", createdAt: "2026-10-29T23:00:00Z", attributes: { discovery: JSON.stringify({ foundAt: t("2026-10-29T22:00:00Z") }) } }),
];
const log = [
  row(1, "a", "2026-10-23T00:00:00Z", [null, null], ["planned", 0]),
  row(2, "b", "2026-10-26T15:00:00Z", ["planned", 0], ["in_progress", 0]),
  row(3, "b", "2026-10-27T15:00:00Z", ["in_progress", 0], ["completed", 100]),
  row(4, "a", "2026-10-28T15:00:00Z", ["planned", 0], ["in_progress", 40]),
];

describe("the schedule as it stood then", () => {
  it("a step that started later hasn't started then", () => {
    const then = scheduleAt(live, log, t("2026-10-26T20:00:00Z")).milestones;
    const a = then.find((m) => m.id === "a")!;
    expect(a.status).toBe("planned");
    expect(a.actualStartAt).toBeUndefined();
    const b = then.find((m) => m.id === "b")!;
    expect(b.status).toBe("in_progress");
    expect(b.actualStartAt).toBe("2026-10-26T15:00:00Z");
    expect(b.actualAt).toBeUndefined();
  });
  it("work found later isn't on it; on the day it was found, it is", () => {
    expect(scheduleAt(live, log, t("2026-10-27T00:00:00Z")).milestones.map((m) => m.id)).toEqual(["a", "b"]);
    expect(scheduleAt(live, log, t("2026-10-30T00:00:00Z")).milestones.map((m) => m.id)).toEqual(["a", "b", "found"]);
  });
  it("as of now: nothing changes", () => {
    const now = scheduleAt(live, log, t("2026-10-30T12:00:00Z")).milestones;
    expect(now.find((m) => m.id === "a")).toBe(live[0]);
    expect(now.find((m) => m.id === "b")).toBe(live[1]);
  });
});
