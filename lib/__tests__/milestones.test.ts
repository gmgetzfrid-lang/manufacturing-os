// lib/__tests__/milestones.test.ts
//
// Pure-function test for computeScheduleMetrics — the heart of the
// Phase 7 earned-value widget. SPI math errors would silently
// mis-color the schedule.

import { describe, it, expect } from "vitest";
import { computeScheduleMetrics } from "@/lib/milestones";
import type { Milestone } from "@/types/schema";

const mk = (overrides: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "m", weight: 1,
  plannedAt: new Date().toISOString(),
  status: "planned",
  source: "manual",
  createdBy: "u",
  ...overrides,
});

describe("computeScheduleMetrics", () => {
  it("returns zeros for empty input", () => {
    const m = computeScheduleMetrics([]);
    expect(m.totalWeight).toBe(0);
    expect(m.plannedValue).toBe(0);
    expect(m.earnedValue).toBe(0);
    expect(m.spi).toBe(1);            // no plan ⇒ trivially "on track"
    expect(m.byStatus).toEqual({ planned: 0, in_progress: 0, completed: 0, missed: 0, blocked: 0, on_hold: 0 });
  });

  it("SPI = 1.0 when earned matches planned exactly", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const milestones: Milestone[] = [
      mk({ plannedAt: "2026-06-01T00:00:00Z", actualAt: "2026-06-01T00:00:00Z", status: "completed", weight: 1 }),
      mk({ plannedAt: "2026-06-10T00:00:00Z", actualAt: "2026-06-10T00:00:00Z", status: "completed", weight: 1 }),
    ];
    const m = computeScheduleMetrics(milestones, { now });
    expect(m.plannedValue).toBe(2);
    expect(m.earnedValue).toBe(2);
    expect(m.spi).toBe(1);
  });

  it("SPI < 1.0 when behind schedule", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const milestones: Milestone[] = [
      mk({ plannedAt: "2026-06-01T00:00:00Z", actualAt: "2026-06-01T00:00:00Z", status: "completed", weight: 1 }),
      mk({ plannedAt: "2026-06-10T00:00:00Z", status: "planned", weight: 1 }), // due, not done
    ];
    const m = computeScheduleMetrics(milestones, { now });
    expect(m.plannedValue).toBe(2);
    expect(m.earnedValue).toBe(1);
    expect(m.spi).toBe(0.5);
  });

  it("weight contributes proportionally", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const milestones: Milestone[] = [
      mk({ plannedAt: "2026-06-01T00:00:00Z", actualAt: "2026-06-01T00:00:00Z", status: "completed", weight: 3 }),
      mk({ plannedAt: "2026-06-10T00:00:00Z", status: "planned", weight: 1 }),
    ];
    const m = computeScheduleMetrics(milestones, { now });
    expect(m.plannedValue).toBe(4);
    expect(m.earnedValue).toBe(3);
    expect(m.spi).toBe(0.75);
  });

  it("counts statuses correctly", () => {
    const milestones: Milestone[] = [
      mk({ status: "planned" }),
      mk({ status: "planned" }),
      mk({ status: "in_progress" }),
      mk({ status: "completed" }),
      mk({ status: "blocked" }),
      mk({ status: "missed" }),
    ];
    const m = computeScheduleMetrics(milestones);
    expect(m.byStatus).toEqual({ planned: 2, in_progress: 1, completed: 1, missed: 1, blocked: 1, on_hold: 0 });
  });

  it("future-planned milestones don't count toward plannedValue yet", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const milestones: Milestone[] = [
      mk({ plannedAt: "2026-06-15T00:00:00Z", status: "planned", weight: 1 }),
    ];
    const m = computeScheduleMetrics(milestones, { now });
    expect(m.plannedValue).toBe(0);
    expect(m.totalWeight).toBe(1);
  });

  it("plannedEndAt = latest plannedAt across milestones", () => {
    const milestones: Milestone[] = [
      mk({ plannedAt: "2026-06-01T00:00:00Z" }),
      mk({ plannedAt: "2026-06-30T00:00:00Z" }),
      mk({ plannedAt: "2026-06-15T00:00:00Z" }),
    ];
    const m = computeScheduleMetrics(milestones);
    expect(m.plannedEndAt).toBe("2026-06-30T00:00:00.000Z");
  });
});
