// A project split into phases: each step's phase, the AFE split with a
// slider (always 100%), and the phase a day falls in.

import { describe, it, expect } from "vitest";
import type { Milestone } from "@/types/schema";
import {
  rowsForPhase, normalizePhases, fitShares, evenShares, moveDivider, setShare, phaseAmount, shareOfAmount, startPhases,
  phaseIndex, inPhase, phaseOnDay, phaseRef, phaseDates, phaseProblems, PHASE_ATTR, type ProjectPhase,
} from "@/lib/projectPhases";

const P: ProjectPhase[] = [
  { id: "a", name: "Transmix-1", start: "2026-10-31", end: "2026-11-07", share: 50 },
  { id: "b", name: "Transmix-2", start: "2026-11-08", end: "2026-11-15", share: 50 },
];
const m = (id: string, parentId: string | null, attributes: Record<string, unknown> = {}) => ({ id, name: id, parentId, attributes } as unknown as Milestone);

describe("the split", () => {
  it("even, and always 100", () => {
    expect(evenShares(2)).toEqual([50, 50]);
    expect(evenShares(3)).toEqual([33.4, 33.3, 33.3]);
    expect(fitShares([1, 1, 1]).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    expect(fitShares([0, 0])).toEqual([50, 50]);
    expect(fitShares([30, 30])).toEqual([50, 50]);
  });
  it("dragging a line moves only the two phases beside it", () => {
    expect(moveDivider([50, 50], 0, 60)).toEqual([60, 40]);
    expect(moveDivider([40, 30, 30], 1, 55)).toEqual([40, 15, 45]);
    expect(moveDivider([50, 50], 0, 120)).toEqual([100, 0]);
    expect(moveDivider([50, 50], 0, -5)).toEqual([0, 100]);
  });
  it("typing a share takes it from the next phase (the one before, for the last)", () => {
    expect(setShare([50, 50], 0, 70)).toEqual([70, 30]);
    expect(setShare([40, 30, 30], 2, 20)).toEqual([40, 40, 20]);
    expect(setShare([50, 50], 0, 140)).toEqual([100, 0]);
  });
  it("dollars both ways", () => {
    expect(phaseAmount(1_083_000, 50)).toBe(541_500);
    expect(shareOfAmount(1_083_000, 541_500)).toBe(50);
    expect(shareOfAmount(0, 5)).toBe(0);
  });
});

describe("phases as saved", () => {
  it("cleans what's saved", () => {
    const n = normalizePhases([{ id: "a", name: " X ", start: "2026-10-31", end: "bad", share: 30 }, { id: "a", name: "dup" }, { id: "b", share: 10 }, "junk"]);
    expect(n).toEqual([{ id: "a", name: "X", start: "2026-10-31", end: null, share: 75 }, { id: "b", name: "Phase 2", start: null, end: null, share: 25 }]);
    expect(normalizePhases(null)).toEqual([]);
  });
  it("starting phases: the schedule there is phase 1, the AFE even", () => {
    const s = startPhases("Transmix", { start: "2026-10-31", end: "2026-11-07" });
    expect(s.map((p) => [p.name, p.start, p.share])).toEqual([["Transmix 1", "2026-10-31", 50], ["Transmix 2", null, 50]]);
    expect(s[0].id).not.toBe(s[1].id);
  });
  it("what's wrong before saving", () => {
    expect(phaseProblems(P)).toEqual([]);
    expect(phaseProblems([{ ...P[0], end: "2026-10-01" }, { ...P[1], name: "Transmix-1", share: 40 }])).toEqual([
      "Transmix-1 finishes before it starts.", "Two phases have the same name.", "The shares add up to 90%, not 100%.",
    ]);
  });
});

describe("each step's phase", () => {
  const ms = [
    m("t1", null), m("s1", "t1"),
    m("t2", null, { [PHASE_ATTR]: "b" }), m("s2", "t2"), m("s3", "s2"),
    m("t3", null, { [PHASE_ATTR]: "gone" }),
  ];
  it("its tag, a task above it, else the first phase", () => {
    const idx = phaseIndex(ms, P);
    expect([...idx.entries()]).toEqual([["t1", "a"], ["s1", "a"], ["t2", "b"], ["s2", "b"], ["s3", "b"], ["t3", "a"]]);
  });
  it("one phase's schedule, or the whole project", () => {
    expect(inPhase(ms, P, "b").map((x) => x.id)).toEqual(["t2", "s2", "s3"]);
    expect(inPhase(ms, P, null)).toHaveLength(6);
    expect(inPhase(ms, [], "b")).toHaveLength(6);
  });
});

describe("dates", () => {
  it("the phase a day falls in", () => {
    expect(phaseOnDay("2026-11-02", P)?.id).toBe("a");
    expect(phaseOnDay("2026-11-08", P)?.id).toBe("b");
    expect(phaseOnDay("2026-10-01", P)).toBeNull();
    expect(phaseOnDay("2026-12-01", [{ ...P[1], end: null }])?.id).toBe("b");
  });
  it("words", () => {
    expect(phaseDates(P[0])).toBe("Oct 31 – Nov 7");
    expect(phaseDates({ ...P[1], end: null })).toBe("from Nov 8");
    expect(phaseDates({ ...P[1], start: null, end: null })).toBe("no dates");
  });
  it("a phase's import keys never match another phase's", () => {
    expect(phaseRef("b", "msp-uid:5")).toBe("b:msp-uid:5");
    expect(phaseRef("b", null)).toBeUndefined();
  });
});

describe("a schedule imported into a phase", () => {
  const rows = [
    { externalRef: "msp-uid:1", parentExternalRef: null, attributes: { "Work Order": "1" } },
    { externalRef: "msp-uid:2", parentExternalRef: "msp-uid:1", dependsOnExternalRefs: ["msp-uid:1"], linksByRef: { "msp-uid:1": { type: "FS" } } },
  ];
  it("phase 2: its own keys, parents and links, tagged", () => {
    const r = rowsForPhase(rows, "b", true);
    expect(r[0]).toMatchObject({ externalRef: "b:msp-uid:1", parentExternalRef: null, attributes: { "Work Order": "1", [PHASE_ATTR]: "b" } });
    expect(r[1]).toMatchObject({ externalRef: "b:msp-uid:2", parentExternalRef: "b:msp-uid:1", dependsOnExternalRefs: ["b:msp-uid:1"], linksByRef: { "b:msp-uid:1": { type: "FS" } } });
  });
  it("the phase there first keeps the keys its rows were imported with", () => {
    const r = rowsForPhase(rows, "a", false);
    expect(r[1]).toMatchObject({ externalRef: "msp-uid:2", parentExternalRef: "msp-uid:1", attributes: { [PHASE_ATTR]: "a" } });
  });
});
