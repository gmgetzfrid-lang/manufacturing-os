import { describe, it, expect } from "vitest";
import { computeTreeMove, computeEdgeResize, computeSummaryResize, sequenceSiblings, type ReflowNode } from "@/lib/scheduleReflow";
import { clockLabel, dayKey } from "@/lib/scheduleTz";

const CHI = "America/Chicago";
const n = (id: string, parentId: string | null, start: string, finish: string): ReflowNode =>
  ({ id, parentId, plannedStartAt: start, plannedAt: finish, status: "planned" } as ReflowNode);

describe("reflow in plant time", () => {
  it("keeps the clock time when a move crosses the fall-back DST change", () => {
    // 8:00–16:00 CDT on Oct 31; +1 day lands on Nov 1 (25-hour day), +2 on Nov 2 (CST).
    const task = n("t", null, "2026-10-31T13:00:00Z", "2026-10-31T21:00:00Z");
    const [c] = computeTreeMove([task], "t", 2, "defer", CHI);
    expect(dayKey(Date.parse(c.plannedStartAt), CHI)).toBe("2026-11-02");
    expect(clockLabel(Date.parse(c.plannedStartAt), CHI)).toBe("8:00");
    expect(clockLabel(Date.parse(c.plannedAt), CHI)).toBe("16:00");
    // In UTC the same move drifts an hour on the plant clock — the old behaviour.
    const [u] = computeTreeMove([task], "t", 2, "defer", "UTC");
    expect(clockLabel(Date.parse(u.plannedStartAt), CHI)).toBe("8:00".replace("8", "7"));
  });

  it("edge resize and sequencing step by plant days", () => {
    const a = n("a", "p", "2026-10-31T13:00:00Z", "2026-10-31T21:00:00Z");
    const b = n("b", "p", "2026-10-31T13:00:00Z", "2026-10-31T21:00:00Z");
    const p = n("p", null, "2026-10-31T13:00:00Z", "2026-10-31T21:00:00Z");
    const [r] = computeEdgeResize([p, a, b], "a", "finish", 2, CHI).filter((c) => c.id === "a");
    expect(clockLabel(Date.parse(r.plannedAt), CHI)).toBe("16:00");
    // Timed steps chain back-to-back: b starts when a's 16:00 finish lands,
    // the same day — not a whole day later.
    const seq = sequenceSiblings([p, a, b], "p", CHI).find((c) => c.id === "b")!;
    expect(dayKey(Date.parse(seq.plannedStartAt), CHI)).toBe("2026-10-31");
    expect(clockLabel(Date.parse(seq.plannedStartAt), CHI)).toBe("16:00");
  });

  it("summary resize snaps to plant midnight, not UTC midnight", () => {
    const p = n("p", null, "2026-10-05T05:00:00Z", "2026-10-09T05:00:00Z"); // Oct 5–9 at Chicago midnight
    const a = n("a", "p", "2026-10-05T05:00:00Z", "2026-10-07T05:00:00Z");
    const b = n("b", "p", "2026-10-07T05:00:00Z", "2026-10-09T05:00:00Z");
    const changes = computeSummaryResize([p, a, b], "p", "finish", 4, CHI);
    for (const c of changes) {
      expect(clockLabel(Date.parse(c.plannedStartAt), CHI)).toBe("");
      expect(clockLabel(Date.parse(c.plannedAt), CHI)).toBe("");
    }
    expect(dayKey(Date.parse(changes.find((c) => c.id === "p")!.plannedAt), CHI)).toBe("2026-10-13");
  });
});
