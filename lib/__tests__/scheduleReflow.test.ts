// Tests for the on-the-fly reschedule engine. These pin down the
// field scenarios the user described:
//   - drag a parent → whole series moves
//   - drag 3 of 10 sub-items early → only those move, parent bleeds,
//     the other 7 stay on the plan
//   - cleaning-crew holdup → pull some forward, push others back

import { describe, it, expect } from "vitest";
import {
  computeTreeMove, previewMove, defaultMoveMode, computeEdgeResize, computeSummaryResize,
  startForDuration, addUtcDays, type ReflowNode,
} from "@/lib/scheduleReflow";

const iso = (d: string) => `${d}T00:00:00.000Z`;
function find(changes: { id: string; plannedStartAt: string; plannedAt: string }[], id: string) {
  return changes.find((c) => c.id === id);
}

// Parent P spanning Mon–Wed with three 1-day leaves on Mon, Tue, Wed.
const tree: ReflowNode[] = [
  { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
  { id: "a", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02") },
  { id: "b", parentId: "P", plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03") },
  { id: "c", parentId: "P", plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04") },
];

describe("computeTreeMove", () => {
  it("no-op for zero delta", () => {
    expect(computeTreeMove(tree, "a", 0)).toEqual([]);
  });

  it("dragging the parent moves the whole series together", () => {
    const ch = computeTreeMove(tree, "P", -1); // one day earlier
    // All four rows shift by -1 day.
    expect(ch).toHaveLength(4);
    expect(find(ch, "a")!.plannedAt).toBe(iso("2026-03-01"));
    expect(find(ch, "b")!.plannedAt).toBe(iso("2026-03-02"));
    expect(find(ch, "c")!.plannedAt).toBe(iso("2026-03-03"));
    expect(find(ch, "P")!.plannedStartAt).toBe(iso("2026-03-01"));
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-03"));
  });

  it("dragging one leaf earlier moves ONLY it; siblings stay; parent bleeds", () => {
    // Representative of "did the first part early, come back for the rest":
    // pull 'a' (the first item) a week early. 'b' and 'c' stay on plan.
    const ch = computeTreeMove(tree, "a", -7);
    expect(find(ch, "b")).toBeUndefined();
    expect(find(ch, "c")).toBeUndefined();
    expect(find(ch, "a")!.plannedAt).toBe(iso("2026-02-23"));
    // Parent now spans from the early 'a' through the still-planned 'c'.
    expect(find(ch, "P")!.plannedStartAt).toBe(iso("2026-02-23"));
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-04")); // finish unchanged
  });

  it("moving an interior leaf within the envelope does NOT change the parent", () => {
    // Tree with slack: items on Mon, Wed, Fri inside a Mon–Fri parent.
    const slack: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-06") },
      { id: "mon", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-02") },
      { id: "wed", parentId: "P", plannedStartAt: iso("2026-03-04"), plannedAt: iso("2026-03-04") },
      { id: "fri", parentId: "P", plannedStartAt: iso("2026-03-06"), plannedAt: iso("2026-03-06") },
    ];
    // Move the Wed item to Thu — still strictly inside Mon..Fri.
    const ch = computeTreeMove(slack, "wed", 1);
    expect(find(ch, "wed")!.plannedAt).toBe(iso("2026-03-05"));
    expect(find(ch, "P")).toBeUndefined(); // envelope unchanged
    expect(find(ch, "mon")).toBeUndefined();
    expect(find(ch, "fri")).toBeUndefined();
  });

  it("holdup scenario: pull one forward and push another back, independently", () => {
    // Jump ahead on 'a' (3 days early); separately push held-up 'c' 3 days late.
    const early = computeTreeMove(tree, "a", -3);
    expect(find(early, "a")!.plannedAt).toBe(iso("2026-02-27"));
    expect(find(early, "b")).toBeUndefined();
    expect(find(early, "c")).toBeUndefined();
    expect(find(early, "P")!.plannedStartAt).toBe(iso("2026-02-27"));

    const late = computeTreeMove(tree, "c", 3);
    expect(find(late, "c")!.plannedAt).toBe(iso("2026-03-07"));
    expect(find(late, "a")).toBeUndefined();
    expect(find(late, "P")!.plannedAt).toBe(iso("2026-03-07"));
  });

  it("multi-day leaf keeps its own duration when moved", () => {
    const t2: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-06") },
      { id: "x", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") }, // 3-day
    ];
    const ch = computeTreeMove(t2, "x", 2);
    expect(find(ch, "x")!.plannedStartAt).toBe(iso("2026-03-04"));
    expect(find(ch, "x")!.plannedAt).toBe(iso("2026-03-06")); // still 3 days
  });

  it("reflows multiple ancestor levels", () => {
    const deep: ReflowNode[] = [
      { id: "root", parentId: null,   plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-03") },
      { id: "mid",  parentId: "root", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-03") },
      { id: "leaf", parentId: "mid",  plannedStartAt: iso("2026-03-03"), plannedAt: iso("2026-03-03") },
    ];
    const ch = computeTreeMove(deep, "leaf", 5); // push leaf out
    expect(find(ch, "leaf")!.plannedAt).toBe(iso("2026-03-08"));
    expect(find(ch, "mid")!.plannedAt).toBe(iso("2026-03-08"));
    expect(find(ch, "root")!.plannedAt).toBe(iso("2026-03-08"));
  });
});

describe("defer vs extend", () => {
  // A 3-day task: Mon→Wed.
  const task: ReflowNode[] = [
    { id: "t", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
  ];

  it("defer slides start AND finish (duration unchanged)", () => {
    const ch = computeTreeMove(task, "t", 2, "defer");
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-04"));
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-06"));
  });

  it("extend moves finish only (duration grows)", () => {
    const ch = computeTreeMove(task, "t", 2, "extend");
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-02")); // start stays
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-06"));      // finish +2
  });

  it("defaultMoveMode: in-progress slipping later = extend; else defer; earlier = defer", () => {
    expect(defaultMoveMode("in_progress", 1)).toBe("extend");
    expect(defaultMoveMode("in_progress", -1)).toBe("defer");
    expect(defaultMoveMode("on_hold", 1)).toBe("defer");
    expect(defaultMoveMode("planned", 2)).toBe("defer");
    expect(defaultMoveMode(undefined, 1)).toBe("defer");
  });

  it("previewMove reports the duration impact", () => {
    const defer = previewMove(task, "t", 2, "defer");
    expect(defer.addsDuration).toBe(false);
    expect(defer.durationDaysBefore).toBe(3);
    expect(defer.durationDaysAfter).toBe(3);

    const extend = previewMove(task, "t", 2, "extend");
    expect(extend.addsDuration).toBe(true);
    expect(extend.durationDaysBefore).toBe(3);
    expect(extend.durationDaysAfter).toBe(5);
  });
});

describe("computeEdgeResize", () => {
  const task: ReflowNode[] = [
    { id: "P", parentId: null, plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
    { id: "t", parentId: "P", plannedStartAt: iso("2026-03-02"), plannedAt: iso("2026-03-04") },
  ];

  it("dragging the finish edge later grows the duration; parent envelopes it", () => {
    const ch = computeEdgeResize(task, "t", "finish", 2);
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-02")); // start unchanged
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-06"));      // finish +2
    expect(find(ch, "P")!.plannedAt).toBe(iso("2026-03-06"));      // parent grew
  });

  it("dragging the start edge later shrinks the duration (finish stays)", () => {
    const ch = computeEdgeResize(task, "t", "start", 1);
    expect(find(ch, "t")!.plannedStartAt).toBe(iso("2026-03-03"));
    expect(find(ch, "t")!.plannedAt).toBe(iso("2026-03-04"));
  });

  it("never lets an edge cross the other (min 1-day span)", () => {
    const ch = computeEdgeResize(task, "t", "start", 10); // way past finish
    const start = Date.parse(find(ch, "t")!.plannedStartAt);
    const finish = Date.parse(find(ch, "t")!.plannedAt);
    expect(finish).toBeGreaterThanOrEqual(start);
  });

  it("no-op for zero delta", () => {
    expect(computeEdgeResize(task, "t", "finish", 0)).toEqual([]);
  });
});

// PT SCH-11: the summary resize rounded every child's INSTANT to UTC midnight,
// so a phase of MS Project's usual 08:00 / 17:00 tasks stretched "+1 day" moved
// L2's finish two days and its start one (measured: L1 06-01T08:00→06-02T17:00
// became 06-01T00:00→06-03T00:00; L2 06-03T08:00→06-05T17:00 became
// 06-04T00:00→06-07T00:00). The MOVE is now rounded to whole days, so each
// child keeps its clock time; the stretch is proportional from the fixed edge,
// so the far child moves by exactly the delta and none moves further.
describe("SCH-11 · a summary resize keeps each child's clock time", () => {
  const t = (s: string) => `${s}:00.000Z`;
  const phase: ReflowNode[] = [
    { id: "P", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-05T17:00") },
    { id: "L1", parentId: "P", plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-02T17:00") },
    { id: "L2", parentId: "P", plannedStartAt: t("2026-06-03T08:00"), plannedAt: t("2026-06-05T17:00") },
  ];
  it("+1 day on the finish edge: the phase ends exactly one day later; no child moves more than a day; clock times kept", () => {
    const ch = computeSummaryResize(phase, "P", "finish", 1);
    const by = Object.fromEntries(ch.map((c) => [c.id, c]));
    expect(by["P"].plannedAt).toBe(t("2026-06-06T17:00"));     // exactly +1 day
    expect(by["P"].plannedStartAt).toBe(t("2026-06-01T08:00")); // anchored start
    expect(by["L2"].plannedAt).toBe(t("2026-06-06T17:00"));     // the edge child: +1 day, still 17:00
    expect(by["L2"].plannedStartAt).toBe(t("2026-06-03T08:00"));// start moved by 0 whole days
    expect(by["L1"]).toBeUndefined();                           // rounds to no move
    for (const c of ch) {
      expect(c.plannedStartAt.slice(11, 16)).toBe("08:00");
      expect(c.plannedAt.slice(11, 16)).toBe("17:00");
    }
  });
  it("−1 day on the start edge mirrors it", () => {
    const ch = computeSummaryResize(phase, "P", "start", -1);
    const by = Object.fromEntries(ch.map((c) => [c.id, c]));
    expect(by["P"].plannedStartAt).toBe(t("2026-05-31T08:00"));
    expect(by["P"].plannedAt).toBe(t("2026-06-05T17:00"));
    for (const c of ch) expect([c.plannedStartAt.slice(11, 16), c.plannedAt.slice(11, 16)]).toEqual(["08:00", "17:00"]);
  });
  it("date-only children behave exactly as before (midnight stays midnight)", () => {
    const d = (s: string) => `${s}T00:00:00.000Z`;
    const ch = computeSummaryResize([
      { id: "P", parentId: null, plannedStartAt: d("2026-03-02"), plannedAt: d("2026-03-05") },
      { id: "a", parentId: "P", plannedStartAt: d("2026-03-02"), plannedAt: d("2026-03-03") },
      { id: "b", parentId: "P", plannedStartAt: d("2026-03-04"), plannedAt: d("2026-03-05") },
    ], "P", "finish", 3);
    const by = Object.fromEntries(ch.map((c) => [c.id, c]));
    expect(by["P"].plannedAt).toBe(d("2026-03-08"));
    expect(by["b"].plannedAt).toBe(d("2026-03-08"));
    for (const c of ch) expect(c.plannedStartAt.endsWith("T00:00:00.000Z") && c.plannedAt.endsWith("T00:00:00.000Z")).toBe(true);
  });
});

// PT SCH-12: setTaskDuration did `start.setDate(finish.getDate() − (days − 1))`
// — local-calendar arithmetic on a UTC instant — so a 3-day task ending
// 2 Nov started 30 Oct 23:00Z in America/Los_Angeles (a 4-day bar). The one
// UTC helper is exact in every zone, at both DST boundaries.
describe("SCH-12 · duration arithmetic in UTC, across DST, in a negative-offset zone", () => {
  const inZone = <T,>(zone: string, fn: () => T): T => {
    const tz = process.env.TZ;
    try { process.env.TZ = zone; return fn(); } finally { process.env.TZ = tz; }
  };
  for (const zone of ["America/Los_Angeles", "UTC", "Asia/Tokyo", "Pacific/Auckland"]) {
    it(`${zone}: a 3-day task ending 2 Nov starts 31 Oct; ending 10 Mar starts 8 Mar`, () => {
      inZone(zone, () => {
        expect(startForDuration("2026-11-02T00:00:00.000Z", 3)).toBe("2026-10-31T00:00:00.000Z");
        expect(startForDuration("2026-03-10T00:00:00.000Z", 3)).toBe("2026-03-08T00:00:00.000Z");
        expect(startForDuration("2026-11-02T17:00:00.000Z", 1)).toBe("2026-11-02T17:00:00.000Z");
        expect(addUtcDays("2026-11-01T08:00:00.000Z", 1)).toBe("2026-11-02T08:00:00.000Z");
      });
    });
  }
});
