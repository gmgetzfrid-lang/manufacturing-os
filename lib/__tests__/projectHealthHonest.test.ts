import { describe, it, expect } from "vitest";
import { computeProjectHealth, type ProjectStateSnapshot } from "@/lib/projectHealth";

const base: ProjectStateSnapshot = {
  hasPurpose: false, hasGoals: false, hasSow: false, jobKind: null,
  budget: 0, committed: 0, spent: 0, cpi: null, accountCount: 0, accountsPinned: 0, partyCount: 0, quoteCount: 0, unawardedRfqGroups: 0, pendingCostDocs: 0,
  openChangeOrders: 0, approvedCoAmount: 0,
  milestoneCount: 235, overdueMilestones: 0, spi: null, hasBaseline: true,
  checklistCount: 0, checklistOpenItems: 0, checklistNeedsEvidence: 0, turnoverRequired: 0, turnoverAccepted: 0, punchOpen: 0,
  intakeLinkCount: 0, membersCount: 1,
};

describe("schedule health says what really happened", () => {
  it("a job that finished late with nothing open is not scored perfect", () => {
    const h = computeProjectHealth({ ...base, finishedSteps: 235, finishedOnTime: 139, finishLateH: 43.5 });
    const s = h.parts.find((p) => p.label === "Schedule")!;
    expect(Math.round(s.score!)).toBe(59);
    expect(s.detail).toBe("Finished 43.5 h after its planned finish · 139 of 235 steps finished on time");
    expect(h.score).toBe(59);
  });
  it("on time is on time", () => {
    const h = computeProjectHealth({ ...base, finishedSteps: 10, finishedOnTime: 10, finishLateH: -2 });
    expect(h.parts.find((p) => p.label === "Schedule")!.detail).toBe("10 of 10 steps finished on time");
    expect(h.score).toBe(100);
  });
});
