// lib/__tests__/reflowAncestors.test.ts
//
// Tests for reflowAllAncestors — the bottom-up envelope recompute used after
// a direct leaf edit (e.g. setTaskDuration) so parent/summary bars always
// cover their children.

import { describe, it, expect } from "vitest";
import { reflowAllAncestors, type ReflowNode } from "@/lib/scheduleReflow";

const iso = (d: string) => `${d}T12:00:00.000Z`;

describe("reflowAllAncestors", () => {
  it("returns no changes when parents already envelope their children", () => {
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: iso("2026-01-01"), plannedAt: iso("2026-01-10") },
      { id: "a", parentId: "p", plannedStartAt: iso("2026-01-01"), plannedAt: iso("2026-01-05") },
      { id: "b", parentId: "p", plannedStartAt: iso("2026-01-06"), plannedAt: iso("2026-01-10") },
    ];
    expect(reflowAllAncestors(nodes)).toEqual([]);
  });

  it("grows a parent when a child now starts earlier (duration extended back)", () => {
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: iso("2026-01-05"), plannedAt: iso("2026-01-10") },
      // child 'a' was set to a 9-day duration, so it now starts Jan 02 (before parent's Jan 05)
      { id: "a", parentId: "p", plannedStartAt: iso("2026-01-02"), plannedAt: iso("2026-01-10") },
    ];
    const changes = reflowAllAncestors(nodes);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("p");
    expect(changes[0].plannedStartAt).toBe(iso("2026-01-02"));
    expect(changes[0].plannedAt).toBe(iso("2026-01-10"));
  });

  it("propagates through multiple levels deepest-first", () => {
    const nodes: ReflowNode[] = [
      { id: "root", parentId: null, plannedStartAt: iso("2026-03-01"), plannedAt: iso("2026-03-05") },
      { id: "mid", parentId: "root", plannedStartAt: iso("2026-03-01"), plannedAt: iso("2026-03-05") },
      // leaf pokes out the far end
      { id: "leaf", parentId: "mid", plannedStartAt: iso("2026-03-01"), plannedAt: iso("2026-03-20") },
    ];
    const changes = reflowAllAncestors(nodes);
    const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
    // both mid and root must stretch to the leaf's finish
    expect(byId["mid"].plannedAt).toBe(iso("2026-03-20"));
    expect(byId["root"].plannedAt).toBe(iso("2026-03-20"));
    expect(byId["leaf"]).toBeUndefined(); // leaves are never rewritten
  });

  it("ignores nodes with a missing/orphaned parent reference", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: "ghost", plannedStartAt: iso("2026-01-01"), plannedAt: iso("2026-01-05") },
    ];
    expect(reflowAllAncestors(nodes)).toEqual([]);
  });

  it("falls back to plannedAt as the start when plannedStartAt is null", () => {
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: iso("2026-01-08"), plannedAt: iso("2026-01-08") },
      { id: "a", parentId: "p", plannedStartAt: null, plannedAt: iso("2026-01-08") },
    ];
    // parent already matches the single child's point span → no change
    expect(reflowAllAncestors(nodes)).toEqual([]);
  });
});
