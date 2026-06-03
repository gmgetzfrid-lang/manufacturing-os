// lib/__tests__/nudges.test.ts
import { describe, it, expect } from "vitest";
import { computeNudges } from "@/lib/nudges";
import type { InboxSnapshot } from "@/lib/inbox";

function snap(p: Partial<InboxSnapshot>): InboxSnapshot {
  return {
    ticketsAssigned: [], ticketsUnread: [], ticketsWatching: [],
    myCheckouts: [], myStaleCheckouts: [],
    myOpenHolds: [], markupRequestsToMe: [],
    milestonesUpcoming: [], unreadNotificationCount: 0,
    ...p,
  } as unknown as InboxSnapshot;
}

describe("computeNudges", () => {
  it("is empty when nothing needs attention", () => {
    expect(computeNudges(snap({}))).toEqual([]);
  });

  it("nudges on stale checkouts (high)", () => {
    const n = computeNudges(snap({ myStaleCheckouts: [{}, {}] as never }));
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe("stale-checkouts");
    expect(n[0].severity).toBe("high");
    expect(n[0].message).toContain("2");
  });

  it("nudges only on holds open longer than 14 days", () => {
    const fresh = { openedAt: new Date().toISOString(), reason: "Client Review" };
    const old = { openedAt: new Date(Date.now() - 20 * 86400000).toISOString(), reason: "Awaiting Engineering" };
    expect(computeNudges(snap({ myOpenHolds: [fresh] as never }))).toEqual([]);
    const n = computeNudges(snap({ myOpenHolds: [old] as never }));
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe("stale-holds");
    expect(n[0].message).toContain("Awaiting Engineering");
  });

  it("nudges on overdue milestones (dueInDays <= 0)", () => {
    const n = computeNudges(snap({ milestonesUpcoming: [{ __dueInDays: 0 }, { __dueInDays: 3 }] as never }));
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe("overdue-milestones");
    expect(n[0].message).toContain("1 milestone");
  });

  it("sorts high severity before medium", () => {
    const n = computeNudges(snap({
      markupRequestsToMe: [{ id: "x", documentId: "d", createdAt: "" }] as never, // medium
      myStaleCheckouts: [{}] as never, // high
    }));
    expect(n[0].severity).toBe("high");
    expect(n[n.length - 1].severity).toBe("medium");
  });
});
