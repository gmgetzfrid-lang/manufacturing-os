// lib/__tests__/dependencies.test.ts
import { describe, it, expect } from "vitest";
import {
  cascadeDependents, wouldCreateCycle, dependentsClosure, linkCyclePath, fsLagHours, reflowNodesFromMilestones,
  CascadeRefusedError, type ReflowNode,
} from "@/lib/scheduleReflow";
import type { Milestone } from "@/types/schema";

const d = (s: string) => `${s}T00:00:00.000Z`;
const day = (iso: string) => iso.slice(0, 10);

describe("wouldCreateCycle", () => {
  const nodes: ReflowNode[] = [
    { id: "a", parentId: null, plannedAt: d("2026-01-05") },
    { id: "b", parentId: null, plannedAt: d("2026-01-10"), dependsOn: ["a"] },
    { id: "c", parentId: null, plannedAt: d("2026-01-15"), dependsOn: ["b"] },
  ];
  it("flags a self-dependency", () => {
    expect(wouldCreateCycle(nodes, "a", "a")).toBe(true);
  });
  it("flags a back-edge (c→a when a→b→c already)", () => {
    // adding 'a depends on c' would cycle (c already depends on a transitively)
    expect(wouldCreateCycle(nodes, "a", "c")).toBe(true);
  });
  it("allows a forward edge", () => {
    // 'c depends on a' is fine (no cycle)
    expect(wouldCreateCycle(nodes, "c", "a")).toBe(false);
  });
});

describe("cascadeDependents — finish-to-start", () => {
  it("pushes a dependent so it starts after its predecessor finishes", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") }, // a moved to finish Jan10
      { id: "b", parentId: null, plannedStartAt: d("2026-01-03"), plannedAt: d("2026-01-06"), dependsOn: ["a"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    // b must start the day after a finishes (Jan11) and keep its 3-day span
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11");
    expect(day(by["b"].plannedAt)).toBe("2026-01-14");
  });

  it("cascades transitively (a→b→c)", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04"), dependsOn: ["a"] },
      { id: "c", parentId: null, plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-06"), dependsOn: ["b"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11"); // after a (Jan10)
    expect(day(by["b"].plannedAt)).toBe("2026-01-13");      // 2-day span preserved
    expect(day(by["c"].plannedStartAt)).toBe("2026-01-14"); // day after b's new finish (Jan13)
  });

  it("never pulls a dependent earlier (only pushes forward)", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-03") },
      { id: "b", parentId: null, plannedStartAt: d("2026-02-01"), plannedAt: d("2026-02-05"), dependsOn: ["a"] }, // already far after
    ];
    expect(cascadeDependents(nodes, ["a"])).toEqual([]); // b already satisfies the constraint
  });

  it("carries a dependent's subtree when it shifts", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-08"), dependsOn: ["a"] },
      { id: "b1", parentId: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04") },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(by["b1"]).toBeDefined();
    expect(day(by["b1"].plannedStartAt)).toBe("2026-01-11"); // moved with b
  });

  // PT SCH-4: a cycle used to be "safe" only in that it terminated — each pass
  // pushed the pair out again, so the guard became a multiplier on the runaway
  // (measured: 2-node cycle, A 2026-06-01 → 2027-01-27; in a 200-row project,
  // ~13.7 years). It is now REFUSED with its links named, and nothing moves.
  it("SCH-4 · a 2-node cycle is a refusal naming both links, not a 240-day shift", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05"), dependsOn: ["b"] },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-05"), dependsOn: ["a"] },
    ];
    let err: unknown = null;
    try { cascadeDependents(nodes, ["a"]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CascadeRefusedError);
    expect((err as CascadeRefusedError).kind).toBe("cycle");
    expect((err as CascadeRefusedError).edges).toEqual([
      { from: "a", to: "b", via: "link" },
      { from: "b", to: "a", via: "link" },
    ]);
  });

  it("SCH-4 · the same cycle inside a 200-row project is still a refusal (the guard no longer multiplies it)", () => {
    const filler: ReflowNode[] = Array.from({ length: 198 }, (_, i) => ({ id: `f${i}`, parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-02") }));
    const nodes: ReflowNode[] = [
      ...filler,
      { id: "A", parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-01"), dependsOn: ["B"] },
      { id: "B", parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-01"), dependsOn: ["A"] },
    ];
    expect(() => cascadeDependents(nodes, ["A"])).toThrow(/loop \(A → B, B → A\); nothing was moved/);
  });

  it("SCH-4 · a loop through a carried sub-task (phase depends on its own child's successor) is refused with every edge", () => {
    // P contains p1; p1 → X; X → P. Pushing X pushes P, which carries p1, which pushes X again.
    const nodes: ReflowNode[] = [
      { id: "P", parentId: null, plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02"), dependsOn: ["X"] },
      { id: "p1", parentId: "P", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02") },
      { id: "X", parentId: null, plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-03"), dependsOn: ["p1"] },
    ];
    let err: unknown = null;
    try { cascadeDependents(nodes, ["X"]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CascadeRefusedError);
    const edges = (err as CascadeRefusedError).edges.map((e) => `${e.from}>${e.to}:${e.via}`);
    expect(edges).toEqual(["X>P:link", "P>p1:contains", "p1>X:link"]);
  });

  it("SCH-4 · a diamond (a→b, a→c, b→c) is not mistaken for a loop", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-03"), dependsOn: ["a"] },
      { id: "c", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-02"), dependsOn: ["a", "b"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(day(by["b"].plannedStartAt)).toBe("2026-01-11");
    expect(day(by["c"].plannedStartAt)).toBe("2026-01-13"); // after b's new finish (Jan 12)
  });

  it("SCH-4 · a dependent's sub-task's own successors are cascaded too", () => {
    // b is pushed; its child b1 carries along; x depends on b1 and must follow.
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-10") },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04"), dependsOn: ["a"] },
      { id: "b1", parentId: "b", plannedStartAt: d("2026-01-02"), plannedAt: d("2026-01-04") },
      { id: "x", parentId: null, plannedStartAt: d("2026-01-05"), plannedAt: d("2026-01-05"), dependsOn: ["b1"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((c) => [c.id, c]));
    expect(day(by["b1"].plannedAt)).toBe("2026-01-13");
    expect(day(by["x"].plannedStartAt)).toBe("2026-01-14");
  });
});

// PC SCHED-13: the FS constraint is successor.start >= predecessor ready +
// stored lag. "Ready" is the finish instant for a timed finish and the next
// midnight for a date-only one (the board draws a date-only finish to the end
// of its day). A pushed task moves by whole days and keeps its clock time.
describe("SCHED-13 · finish-to-start with real clock times (08:00 / 17:00) and lag", () => {
  const t = (s: string) => `${s}:00.000Z`;

  it("an imported same-day chain that already satisfies FS is not pushed", () => {
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-01T12:00") },
      { id: "b", parentId: null, plannedStartAt: t("2026-06-01T13:00"), plannedAt: t("2026-06-01T17:00"), dependsOn: ["a"] },
      { id: "c", parentId: null, plannedStartAt: t("2026-06-02T08:00"), plannedAt: t("2026-06-02T17:00"), dependsOn: ["b"] },
    ];
    expect(cascadeDependents(nodes, ["a"])).toEqual([]);
  });

  it("a pushed successor keeps its 08:00 start (next morning), not the predecessor's 17:00", () => {
    // a slipped to finish 06-03 17:00; b (08:00–17:00 on 06-02) must follow.
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-03T17:00") },
      { id: "b", parentId: null, plannedStartAt: t("2026-06-02T08:00"), plannedAt: t("2026-06-02T17:00"), dependsOn: ["a"] },
      { id: "c", parentId: null, plannedStartAt: t("2026-06-03T08:00"), plannedAt: t("2026-06-04T17:00"), dependsOn: ["b"] },
    ];
    const by = Object.fromEntries(cascadeDependents(nodes, ["a"]).map((x) => [x.id, x]));
    expect(by["b"].plannedStartAt).toBe(t("2026-06-04T08:00"));
    expect(by["b"].plannedAt).toBe(t("2026-06-04T17:00"));
    expect(by["c"].plannedStartAt).toBe(t("2026-06-05T08:00"));
    expect(by["c"].plannedAt).toBe(t("2026-06-06T17:00"));
    // the chain absorbed no extra day per link
  });

  it("a stored lag is honoured (and a lead pulls the constraint in)", () => {
    const nodes = (lag: number): ReflowNode[] => [
      { id: "a", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-03T17:00") },
      { id: "b", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-01T17:00"), dependsOn: ["a"], lagHours: { a: lag } },
    ];
    // +24h: ready 06-04 17:00 → b's first 08:00 at/after that is 06-05 08:00.
    expect(cascadeDependents(nodes(24), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-05T08:00"));
    // no lag: 06-04 08:00.
    expect(cascadeDependents(nodes(0), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-04T08:00"));
    // −16h lead: ready 06-03 01:00 → 06-03 08:00.
    expect(cascadeDependents(nodes(-16), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-03T08:00"));
  });

  it("lag is read from the importer's attributes.source_links through the predecessor's external ref", () => {
    expect(fsLagHours("FS msp-uid:1 +8h; SS msp-uid:3", "msp-uid:1")).toBe(8);
    expect(fsLagHours("FS msp-uid:1 -4.5h", "msp-uid:1")).toBe(-4.5);
    expect(fsLagHours("FS msp:1 +3 mons (lag not understood)", "msp:1")).toBe(0);
    expect(fsLagHours("SS p6:7 +8h", "p6:7")).toBe(0); // not FS: not applied
    expect(fsLagHours(undefined, "x")).toBe(0);
    const ms = [
      { id: "A", orgId: "o", name: "A", weight: 1, status: "planned", source: "msproject", createdBy: "u", externalRef: "msp-uid:1", plannedAt: t("2026-06-01T17:00") },
      { id: "B", orgId: "o", name: "B", weight: 1, status: "planned", source: "msproject", createdBy: "u", externalRef: "msp-uid:2", plannedAt: t("2026-06-02T17:00"), dependsOn: ["A"], attributes: { source_links: "FS msp-uid:1 +8h" } },
    ] as Milestone[];
    const nodes = reflowNodesFromMilestones(ms);
    expect(nodes.find((n) => n.id === "B")!.lagHours).toEqual({ A: 8 });
    expect(nodes.find((n) => n.id === "A")!.lagHours).toBeNull();
  });
});

describe("SCH-9 · the cycle check over the full set, in one walk, with the loop named", () => {
  const nodes: ReflowNode[] = [
    { id: "a", parentId: null, plannedAt: d("2026-01-05") },
    { id: "b", parentId: null, plannedAt: d("2026-01-10"), dependsOn: ["a"] }, // b may be a row the view hides
    { id: "c", parentId: null, plannedAt: d("2026-01-15"), dependsOn: ["b"] },
    { id: "z", parentId: null, plannedAt: d("2026-01-15") },
  ];
  it("dependentsClosure = the tasks that may not become a predecessor (self + every transitive dependent)", () => {
    expect([...dependentsClosure(nodes, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...dependentsClosure(nodes, "z")]).toEqual(["z"]);
    // agrees with wouldCreateCycle for every candidate
    for (const cand of ["a", "b", "c", "z"]) {
      expect(dependentsClosure(nodes, "a").has(cand)).toBe(wouldCreateCycle(nodes, "a", cand));
    }
  });
  it("linkCyclePath names the loop an added link would close, through the hidden middle row", () => {
    expect(linkCyclePath(nodes, "a", "c")).toEqual(["a", "b", "c", "a"]);
    expect(linkCyclePath(nodes, "c", "a")).toBeNull();
    expect(linkCyclePath(nodes, "a", "a")).toEqual(["a", "a"]);
  });
  it("with the middle row filtered OUT of the node list the old guard passed the cycle — the full set catches it", () => {
    const filtered = nodes.filter((n) => n.id !== "b");
    expect(wouldCreateCycle(filtered, "a", "c")).toBe(false); // the defect: a filtered view hides the loop
    expect(wouldCreateCycle(nodes, "a", "c")).toBe(true);
  });
});
