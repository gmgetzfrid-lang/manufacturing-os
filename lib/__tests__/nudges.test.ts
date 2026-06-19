// lib/__tests__/nudges.test.ts
import { describe, it, expect } from "vitest";
import { computeNudges } from "@/lib/nudges";
import type { InboxSnapshot } from "@/lib/inbox";

function snap(p: Partial<InboxSnapshot>): InboxSnapshot {
  return {
    ticketsAssigned: [], ticketsUnread: [], ticketsWatching: [],
    myCheckouts: [], myStaleCheckouts: [],
    myOpenHolds: [], markupRequestsToMe: [],
    milestonesUpcoming: [], milestonesOverdue: [], transmittalsAwaitingAck: [], unreadNotificationCount: 0,
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

  it("nudges on overdue milestones from the overdue list", () => {
    const n = computeNudges(snap({ milestonesOverdue: [{ __overdueDays: 4 }] as never }));
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe("overdue-milestones");
    expect(n[0].severity).toBe("high");
    expect(n[0].message).toContain("4d late");
    // Upcoming (not-yet-due) milestones must NOT trigger the overdue nudge.
    expect(computeNudges(snap({ milestonesUpcoming: [{ __dueInDays: 3 }] as never }))).toEqual([]);
  });

  it("nudges on stalled assigned drafting tickets (only actionable statuses, 5+ days)", () => {
    const old = new Date(Date.now() - 9 * 86400000).toISOString();
    const fresh = new Date().toISOString();
    // Stale but in a status the assignee can act on → nudge.
    const n = computeNudges(snap({ ticketsAssigned: [{ status: "DRAFTING", lastModified: old }] as never }));
    expect(n.some((x) => x.id === "stalled-assigned-tickets")).toBe(true);
    // Stale but waiting on someone else (PENDING_REVIEW) → no nudge.
    expect(computeNudges(snap({ ticketsAssigned: [{ status: "PENDING_REVIEW", lastModified: old }] as never }))).toEqual([]);
    // Recently touched → no nudge.
    expect(computeNudges(snap({ ticketsAssigned: [{ status: "DRAFTING", lastModified: fresh }] as never }))).toEqual([]);
  });

  it("nudges only on transmittals unacknowledged 7+ days", () => {
    const fresh = { id: "t1", number: "TR-0001", documentCount: 1, __ageDays: 3 };
    const aging = { id: "t2", number: "TR-0002", documentCount: 2, __ageDays: 10 };
    expect(computeNudges(snap({ transmittalsAwaitingAck: [fresh] as never }))).toEqual([]);
    const n = computeNudges(snap({ transmittalsAwaitingAck: [aging] as never }));
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe("transmittals-unacknowledged");
    expect(n[0].message).toContain("TR-0002");
  });

  it("tolerates a snapshot without the transmittals field (older callers)", () => {
    const s = snap({});
    delete (s as unknown as Record<string, unknown>).transmittalsAwaitingAck;
    expect(() => computeNudges(s)).not.toThrow();
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
