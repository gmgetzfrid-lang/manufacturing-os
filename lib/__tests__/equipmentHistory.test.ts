import { describe, it, expect } from "vitest";
import { shapeHistory } from "@/lib/equipmentHistory";

const row = (p: Record<string, unknown>) => ({
  id: "x", project_id: "p1", parent_id: null, name: "", attributes: null, work_order_ref: null, status: "planned", percent_complete: 0,
  planned_start_at: null, planned_at: null, actual_start_at: null, actual_at: null, cancelled_at: null, ...p,
}) as Parameters<typeof shapeHistory>[0][number];

describe("equipment work history", () => {
  const projects = new Map([["p1", { name: "Nov 2026 LRU", status: "active", tz: "America/Los_Angeles" }], ["p0", { name: "2024 LRU", status: "completed", tz: null }]]);
  it("each work order with its steps, dates and project, newest first", () => {
    const tasks = [
      row({ id: "old", project_id: "p0", name: "E-27 - Clean", attributes: { "Work Order": "200001" }, planned_start_at: "2024-03-01T14:00:00Z" }),
      row({ id: "e27", name: "E-27 - Propane Condenser", attributes: { "Work Order": "310337" }, planned_start_at: "2026-11-03T14:00:00Z" }),
      row({ id: "e27", name: "E-27 - Propane Condenser" }),
    ];
    const steps = [
      row({ id: "s1", parent_id: "e27", status: "completed", actual_start_at: "2026-11-03T15:00:00Z", actual_at: "2026-11-03T18:00:00Z", planned_start_at: "2026-11-03T14:00:00Z", planned_at: "2026-11-03T16:00:00Z" }),
      row({ id: "s2", parent_id: "e27", status: "in_progress", percent_complete: 50, actual_start_at: "2026-11-04T15:00:00Z", planned_at: "2026-11-05T16:00:00Z" }),
      row({ id: "s3", parent_id: "old", status: "completed", actual_start_at: "2024-03-01T15:00:00Z", actual_at: "2024-03-02T15:00:00Z" }),
    ];
    const h = shapeHistory(tasks, steps, projects);
    expect(h.map((j) => j.taskId)).toEqual(["e27", "old"]);
    expect(h[0]).toMatchObject({ wo: "310337", projectName: "Nov 2026 LRU", status: "in_progress", steps: 2, stepsDone: 1, pct: 75, actualFinish: null });
    expect(h[1]).toMatchObject({ status: "completed", stepsDone: 1, actualFinish: Date.parse("2024-03-02T15:00:00Z") });
  });
});
