// A trace that answers confidently and wrongly is worse than no trace at all
// — somebody blinds the wrong valve. The cases that matter here are the ones
// where the honest answer is "I don't know": not connected, too far to say,
// and off-page runs that must never be quietly walked through as if the whole
// route were on one sheet.

import { describe, it, expect } from "vitest";
import {
  tracePath, traceNeighbourhood, findBrokenConnectors, normalizeTag,
  type LineEdge,
} from "@/lib/pidTrace";

//  P-101 ──L1(2 valves)──> E-101 ──L2──> T-201 ──L3(offpage)──> C-301
//                            │
//                            └──L4──> V-150
const LINES: LineEdge[] = [
  { lineId: "L-44-001", from: "P-101", to: "E-101", drawingId: "PID-44-012",
    components: [
      { tag: "HV-1002", kind: "valve", position: 0.7 },
      { tag: "CV-1001", kind: "check", position: 0.2 },
    ] },
  { lineId: "L-44-002", from: "E-101", to: "T-201", drawingId: "PID-44-012",
    components: [{ tag: "PSV-2001", kind: "relief", position: 0.5 }] },
  { lineId: "L-44-098", from: "T-201", to: "C-301", drawingId: "PID-44-013", offPage: true },
  { lineId: "L-44-004", from: "E-101", to: "V-150", drawingId: "PID-44-012" },
];

describe("normalizeTag", () => {
  it("makes tag identity punctuation-blind, like the rest of the system", () => {
    expect(normalizeTag("e-101")).toBe(normalizeTag("E 101"));
    expect(normalizeTag("E_101")).toBe("E101");
  });
});

describe("tracePath", () => {
  it("lists what sits between two pieces of equipment, in flow order", () => {
    const r = tracePath(LINES, "P-101", "E-101");
    expect(r.found).toBe(true);
    expect(r.path).toEqual(["P101", "E101"]);
    // Ordered by position along the run, not by the order they were captured.
    expect(r.components.map((c) => c.tag)).toEqual(["CV-1001", "HV-1002"]);
    expect(r.drawings).toEqual(["PID-44-012"]);
  });

  it("walks multiple runs and accumulates everything on the way", () => {
    const r = tracePath(LINES, "P-101", "T-201");
    expect(r.path).toEqual(["P101", "E101", "T201"]);
    expect(r.steps).toHaveLength(2);
    expect(r.components.map((c) => c.tag)).toEqual(["CV-1001", "HV-1002", "PSV-2001"]);
  });

  it("traces backwards and reverses the component order with it", () => {
    // Asked the other way round, the same valves are encountered in reverse.
    const r = tracePath(LINES, "E-101", "P-101");
    expect(r.found).toBe(true);
    expect(r.components.map((c) => c.tag)).toEqual(["HV-1002", "CV-1001"]);
  });

  it("flags a route that leaves the sheet instead of hiding it", () => {
    const r = tracePath(LINES, "T-201", "C-301");
    expect(r.found).toBe(true);
    expect(r.steps[0].offPage).toBe(true);
    expect(r.drawings).toEqual(["PID-44-013"]);
  });

  it("takes the shortest route, not any route", () => {
    const withDetour: LineEdge[] = [
      ...LINES,
      { lineId: "L-X-1", from: "P-101", to: "V-150" },
      { lineId: "L-X-2", from: "V-150", to: "T-201" },
    ];
    const r = tracePath(withDetour, "P-101", "T-201");
    expect(r.path.length).toBeLessThanOrEqual(3);
  });

  it("says so when nothing connects them", () => {
    const r = tracePath(LINES, "P-101", "X-999");
    expect(r.found).toBe(false);
    expect(r.reason).toMatch(/doesn't appear/i);
  });

  it("distinguishes 'too far to say' from 'not connected'", () => {
    // A chain longer than the hop budget is NOT proof of isolation, and
    // reporting it as such is how someone concludes two systems are separate
    // when they are one line apart beyond the horizon.
    const chain: LineEdge[] = Array.from({ length: 12 }, (_, i) => ({
      lineId: `L-${i}`, from: `EQ-${i}`, to: `EQ-${i + 1}`,
    }));
    const r = tracePath(chain, "EQ-0", "EQ-12", 4);
    expect(r.found).toBe(false);
    expect(r.reason).toMatch(/may still be connected/i);
    expect(r.reason).not.toMatch(/No traced route/);
  });

  it("handles start === end without inventing a run", () => {
    const r = tracePath(LINES, "E-101", "e 101");
    expect(r.found).toBe(true);
    expect(r.steps).toEqual([]);
  });

  it("requires both ends", () => {
    expect(tracePath(LINES, "", "E-101").reason).toMatch(/required/i);
  });

  it("survives an empty line set", () => {
    expect(tracePath([], "A-1", "B-2").found).toBe(false);
  });
});

describe("traceNeighbourhood", () => {
  it("answers 'what am I touching if I blind this', with distance", () => {
    const near = traceNeighbourhood(LINES, "E-101", 1);
    expect(near.map((n) => n.tag).sort()).toEqual(["P101", "T201", "V150"]);
    expect(near.every((n) => n.hops === 1)).toBe(true);
  });

  it("widens by hop and keeps the closer things first", () => {
    const near = traceNeighbourhood(LINES, "P-101", 2);
    expect(near[0]).toEqual({ tag: "E101", hops: 1 });
    expect(near.some((n) => n.tag === "T201" && n.hops === 2)).toBe(true);
  });

  it("never includes the equipment you started from", () => {
    expect(traceNeighbourhood(LINES, "E-101", 3).some((n) => n.tag === "E101")).toBe(false);
  });

  it("is empty for equipment nothing connects to", () => {
    expect(traceNeighbourhood(LINES, "X-999", 2)).toEqual([]);
  });
});

describe("findBrokenConnectors", () => {
  it("finds a continuation that nothing catches on the receiving sheet", () => {
    // L-44-098 leaves for C-301, and C-301 is the source of no other run.
    const broken = findBrokenConnectors(LINES);
    expect(broken).toHaveLength(1);
    expect(broken[0].lineId).toBe("L-44-098");
    expect(broken[0].danglingAt).toBe("C-301");
  });

  it("is quiet when the continuation lands", () => {
    const complete: LineEdge[] = [
      ...LINES,
      { lineId: "L-44-099", from: "C-301", to: "D-401", drawingId: "PID-44-013" },
    ];
    expect(findBrokenConnectors(complete)).toEqual([]);
  });

  it("ignores runs that never leave the sheet", () => {
    const onSheet: LineEdge[] = [{ lineId: "L-1", from: "A-1", to: "B-2" }];
    expect(findBrokenConnectors(onSheet)).toEqual([]);
  });
});
