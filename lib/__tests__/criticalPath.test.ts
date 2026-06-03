import { describe, it, expect } from "vitest";
import { computeCriticalPathLite } from "@/lib/criticalPath";
import type { Milestone } from "@/types/schema";

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", ...o,
});

describe("computeCriticalPathLite", () => {
  it("flags the unfinished task that ends at the project finish", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-02T00:00:00Z", status: "completed" }),
      mk({ id: "b", plannedStartAt: "2026-03-02T00:00:00Z", plannedAt: "2026-03-05T00:00:00Z", status: "in_progress" }),
      mk({ id: "c", plannedStartAt: "2026-03-05T00:00:00Z", plannedAt: "2026-03-08T00:00:00Z", status: "planned" }),
    ];
    const r = computeCriticalPathLite(ms);
    expect(r.ids.has("c")).toBe(true);            // ends at the finish
    expect(r.ids.has("b")).toBe(true);            // contiguous predecessor
    expect(r.ids.has("a")).toBe(false);           // already done — not driving
    expect(r.finish).toBe("2026-03-08T00:00:00.000Z");
  });

  it("sums remaining hours on the chain", () => {
    const ms: Milestone[] = [
      mk({ id: "b", plannedStartAt: "2026-03-02T00:00:00Z", plannedAt: "2026-03-05T00:00:00Z", status: "planned", durationHours: 20 }),
      mk({ id: "c", plannedStartAt: "2026-03-05T00:00:00Z", plannedAt: "2026-03-08T00:00:00Z", status: "planned", durationHours: 12 }),
    ];
    const r = computeCriticalPathLite(ms);
    expect(r.remainingHours).toBe(32);
  });

  it("ignores a parallel short task that doesn't reach the finish", () => {
    const ms: Milestone[] = [
      mk({ id: "long", plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-10T00:00:00Z", status: "planned" }),
      mk({ id: "short", plannedStartAt: "2026-03-01T00:00:00Z", plannedAt: "2026-03-02T00:00:00Z", status: "planned" }),
    ];
    const r = computeCriticalPathLite(ms);
    expect(r.ids.has("long")).toBe(true);
    expect(r.ids.has("short")).toBe(false);
  });

  it("empty-safe", () => {
    const r = computeCriticalPathLite([]);
    expect(r.ids.size).toBe(0);
    expect(r.finish).toBeNull();
  });
});
