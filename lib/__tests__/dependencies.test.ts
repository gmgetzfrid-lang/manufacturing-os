// lib/__tests__/dependencies.test.ts
import { describe, it, expect } from "vitest";
import {
  cascadeDependents, wouldCreateCycle, dependentsClosure, linkCyclePath, fsLagHours, reflowNodesFromMilestones,
  CascadeRefusedError, afterLagMs, fsReadyMs, WORK_DAY_HOURS, DAY_MS, type ReflowNode,
  planCascade, computeTreeMove, isLocked, outlineLoop,
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

  // The FIFO relaxation re-pushed a task every time a longer path reached it:
  // A plus a chain X1 → … → X40 where every Xi also depends on A, listed in
  // reverse (the database returns same-day rows in no fixed order), took ~800
  // steps against a guard of 512 and was REFUSED as "runaway" with nothing
  // moved. Each task is now settled once, in topological order.
  const fanIn = (n: number, reversed: boolean): ReflowNode[] => {
    const xs: ReflowNode[] = Array.from({ length: n }, (_, i) => ({
      id: `X${i + 1}`, parentId: null, plannedStartAt: d("2026-06-02"), plannedAt: d("2026-06-02"),
      dependsOn: i === 0 ? ["A"] : ["A", `X${i}`],
    }));
    return [{ id: "A", parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-10") }, ...(reversed ? xs.reverse() : xs)];
  };
  it("SCH-4 · a reversed fan-in of 40 (A plus X1 → … → X40, each also on A) is WRITTEN, not refused as runaway", () => {
    const changes = cascadeDependents(fanIn(40, true), ["A"]);
    const by = Object.fromEntries(changes.map((c) => [c.id, c]));
    expect(changes).toHaveLength(40);
    expect(day(by["X1"].plannedStartAt)).toBe("2026-06-11");
    expect(day(by["X2"].plannedStartAt)).toBe("2026-06-12");
    expect(day(by["X40"].plannedStartAt)).toBe("2026-07-20"); // 06-10 + 40 days: one day per link, no more
    // the same network in forward order gives exactly the same writes
    const fwd = Object.fromEntries(cascadeDependents(fanIn(40, false), ["A"]).map((c) => [c.id, c]));
    expect(fwd).toEqual(by);
  });
  it("SCH-4 · a 400-task reversed fan-in settles too (each task once — ~80,000 relaxation steps before)", () => {
    const changes = cascadeDependents(fanIn(400, true), ["A"]);
    expect(changes).toHaveLength(400);
    expect(day(changes.find((c) => c.id === "X400")!.plannedStartAt)).toBe("2027-07-15"); // 2026-06-10 + 400 days
  });
  it("SCH-4 · a stored loop downstream that no push reaches is left alone (only a loop the move drives is refused)", () => {
    // a moved within its float: x still starts after it, so nothing is pushed —
    // the old loop b ↔ c further down (an old import) is not the move's business.
    const nodes: ReflowNode[] = [
      { id: "a", parentId: null, plannedStartAt: d("2026-01-01"), plannedAt: d("2026-01-03") },
      { id: "x", parentId: null, plannedStartAt: d("2026-01-06"), plannedAt: d("2026-01-07"), dependsOn: ["a"] },
      { id: "b", parentId: null, plannedStartAt: d("2026-01-10"), plannedAt: d("2026-01-11"), dependsOn: ["x", "c"] },
      { id: "c", parentId: null, plannedStartAt: d("2026-01-12"), plannedAt: d("2026-01-13"), dependsOn: ["b"] },
    ];
    expect(cascadeDependents(nodes, ["a"])).toEqual([]);
    // …and once the move does reach it, it is refused with the loop named.
    const pushed = nodes.map((n) => (n.id === "a" ? { ...n, plannedAt: d("2026-01-12") } : n));
    expect(() => cascadeDependents(pushed, ["a"])).toThrow(CascadeRefusedError);
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

  it("a stored lag is honoured as WORKING time (and a lead pulls the constraint in)", () => {
    // a finishes Wed 2026-06-03 17:00.
    const nodes = (lag: number): ReflowNode[] => [
      { id: "a", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-03T17:00") },
      { id: "b", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-01T17:00"), dependsOn: ["a"], lagHours: { a: lag } },
    ];
    // +24h = 3 working days: Thu, Fri, (weekend), Mon → ready Mon 06-08 17:00 → b 06-09 08:00.
    // (Applied as elapsed hours it required only Thu 06-04 17:00 → 06-05 08:00.)
    expect(cascadeDependents(nodes(24), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-09T08:00"));
    // no lag: 06-04 08:00.
    expect(cascadeDependents(nodes(0), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-04T08:00"));
    // −16h = a 2-working-day lead: Mon 06-01 17:00 → b 06-02 08:00.
    expect(cascadeDependents(nodes(-16), ["a"]).find((c) => c.id === "b")!.plannedStartAt).toBe(t("2026-06-02T08:00"));
  });

  it("'+5d' (stored +40h) is five working days, not 1⅔ calendar days", () => {
    // The predecessor is pushed to finish Fri 2026-06-05 17:00; FS +5d.
    const nodes: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-05T17:00") },
      { id: "s", parentId: null, plannedStartAt: t("2026-06-01T08:00"), plannedAt: t("2026-06-02T17:00"), dependsOn: ["p"], lagHours: { p: 40 } },
    ];
    const s = cascadeDependents(nodes, ["p"]).find((c) => c.id === "s")!;
    // Lag days Mon 06-08 … Fri 06-12 → ready Fri 06-12 17:00 → the next 08:00 is Sat 06-13
    // (no project calendar: the push itself may land on a weekend — the scheduling tool
    // would say Mon 06-15). As elapsed hours the same link required only Sun 06-07 09:00
    // and laid s on Mon 06-08, a week early.
    expect(s.plannedStartAt).toBe(t("2026-06-13T08:00"));
    expect(s.plannedAt).toBe(t("2026-06-14T17:00"));
    // A date-only finish on Fri 06-05 with +1d: the lag day is Monday, so the successor starts Tuesday.
    const dateOnly: ReflowNode[] = [
      { id: "p", parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") },
      { id: "s", parentId: null, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-01"), dependsOn: ["p"], lagHours: { p: 8 } },
    ];
    expect(day(cascadeDependents(dateOnly, ["p"]).find((c) => c.id === "s")!.plannedStartAt)).toBe("2026-06-09");
  });

  it("afterLagMs: working days skip the weekend, hours under a day are clock hours, a lead walks back", () => {
    const at = (s: string) => Date.parse(t(s));
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(WORK_DAY_HOURS).toBe(8);
    expect(iso(afterLagMs(at("2026-06-05T17:00"), 8))).toBe(t("2026-06-08T17:00"));   // Fri 17:00 + 1d → Mon 17:00
    expect(iso(afterLagMs(at("2026-06-03T17:00"), 8))).toBe(t("2026-06-04T17:00"));   // Wed → Thu
    expect(iso(afterLagMs(fsReadyMs(at("2026-06-05T00:00")), 8))).toBe(t("2026-06-09T00:00")); // date-only Fri + 1d → Tue
    expect(iso(afterLagMs(at("2026-06-03T12:00"), 4))).toBe(t("2026-06-03T16:00"));   // +4h: clock hours
    expect(iso(afterLagMs(at("2026-06-03T17:00"), 12))).toBe(t("2026-06-04T21:00"));  // 1d 4h
    expect(iso(afterLagMs(at("2026-06-08T17:00"), -8))).toBe(t("2026-06-07T17:00"));  // Mon − 1d (the latest ready that still clears Monday)
    expect(iso(afterLagMs(at("2026-06-03T17:00"), -16))).toBe(t("2026-06-01T17:00")); // Wed − 2d → Mon
    expect(afterLagMs(at("2026-06-03T17:00"), 0)).toBe(at("2026-06-03T17:00"));
    expect(afterLagMs(at("2026-06-03T17:00"), null)).toBe(at("2026-06-03T17:00"));
    expect(afterLagMs(at("2026-06-03T17:00"), Number.NaN)).toBe(at("2026-06-03T17:00"));
  });

  it("afterLagMs: the whole-week skip agrees with a day-by-day walk, and a lag walked back then forward never ends late", () => {
    const works = (a: number) => { const wd = new Date(a + DAY_MS - 1).getUTCDay(); return wd !== 0 && wd !== 6; };
    const walk = (from: number, days: number, dir: 1 | -1) => {
      let tt = from, left = days;
      if (dir > 0) { while (left > 0) { if (works(tt)) left--; tt += DAY_MS; } }
      else { while (left > 0) { tt -= DAY_MS; if (works(tt)) left--; } }
      return tt;
    };
    for (let dd = 0; dd < 14; dd++) {
      for (const hh of [0, 8, 17]) {
        const from = Date.parse(d("2026-06-01")) + dd * DAY_MS + hh * 3_600_000;
        for (let wdays = 0; wdays <= 30; wdays++) {
          expect(afterLagMs(from, wdays * 8)).toBe(walk(from, wdays, 1));
          expect(afterLagMs(from, -wdays * 8)).toBe(walk(from, wdays, -1));
          for (const extra of [0, 3, 7.5]) {
            const lag = wdays * 8 + extra;
            expect(afterLagMs(afterLagMs(from, -lag), lag)).toBeLessThanOrEqual(from);
          }
        }
      }
    }
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

// PT SCH-4 / SCH-9 (fifth review pass): a successor of a PHASE waits for all
// the work inside it (the cascade's own rule since the fourth pass), but the
// link checks walked task-level links only — so a loop through a phase could
// be created, and a move that reached one fell into the relaxation branch,
// which carried a sub-task its own link had already pushed by the whole delta
// again (written a day later than any link required) and never refused the
// loop. The link checks and the cascade now read one graph (phaseGraph).
describe("SCH-4 / SCH-9 · a loop through a phase: refused when the link is made, and refused by the cascade", () => {
  const N = (id: string, parentId: string | null, s: string, f: string, deps: string[] = []): ReflowNode =>
    ({ id, parentId, plannedStartAt: d(`2026-${s}`), plannedAt: d(`2026-${f}`), dependsOn: deps, status: "planned" });
  // The reviewer's plan: A1 (in phase A); phase Q waits for A; X (in Q) waits for A1.
  const base = (): ReflowNode[] => [
    N("A1", "A", "06-01", "06-05"), N("A", null, "06-01", "06-05"),
    N("Q", null, "06-08", "06-09", ["A"]), N("X", "Q", "06-08", "06-09", ["A1"]),
  ];
  // The board's move: the tree move, then the cascade over the moved rows (ExecutionView withCascade).
  const drag = (nodes: ReflowNode[], id: string, delta: number) => {
    const primary = computeTreeMove(nodes, id, delta, "defer");
    const by = new Map(primary.map((c) => [c.id, c]));
    const updated = nodes.map((n) => (by.has(n.id) ? { ...n, plannedStartAt: by.get(n.id)!.plannedStartAt, plannedAt: by.get(n.id)!.plannedAt } : n));
    return planCascade(updated, primary.map((c) => c.id));
  };
  const dates = (changes: Array<{ id: string; plannedStartAt: string; plannedAt: string }>) =>
    Object.fromEntries(changes.map((c) => [c.id, `${day(c.plannedStartAt).slice(5)}→${day(c.plannedAt).slice(5)}`]));

  it("without a loop: A1 +3 d pushes X and Q to Jun 9–10", () => {
    expect(dates(drag(base(), "A1", 3).changes)).toEqual({ Q: "06-09→06-10", X: "06-09→06-10" });
  });

  it("the reviewer's probe: Y (in Q) waits for Z, Z waits for phase Q — the move is refused with the loop named, nothing written", () => {
    const nodes = [...base(), N("Y", "Q", "06-08", "06-09", ["Z"]), N("Z", null, "06-20", "06-21", ["Q"])];
    let err: unknown = null;
    try { drag(nodes, "A1", 3); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CascadeRefusedError); // was: X written Jun 10–11, Q Jun 9–11, no refusal
    expect((err as CascadeRefusedError).kind).toBe("cycle");
    expect((err as CascadeRefusedError).edges.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["Y>Q:within", "Q>Z:link", "Z>Y:link"]);
  });

  it("…and the link that closes it is refused when it is made (the picker and updateMilestone)", () => {
    const nodes = [...base(), N("Y", "Q", "06-08", "06-09"), N("Z", null, "06-20", "06-21", ["Q"])];
    expect(linkCyclePath(nodes, "Y", "Z")).toEqual(["Y", "Q", "Z", "Y"]); // Y is inside Q, Z waits for Q
    expect(wouldCreateCycle(nodes, "Y", "Z")).toBe(true);
    expect(dependentsClosure(nodes, "Y").has("Z")).toBe(true); // the picker no longer offers Z
    // The same the other way round: Z → Y exists; "Z waits for Q" would close it.
    const other = [...base(), N("Y", "Q", "06-08", "06-09", ["Z"]), N("Z", null, "06-20", "06-21")];
    expect(linkCyclePath(other, "Z", "Q")).toEqual(["Z", "Y", "Q", "Z"]); // Y (inside Q) waits for Z
    expect(dependentsClosure(other, "Z").has("Q")).toBe(true);
  });

  it("a phase may not wait for its own work, or for a task that waits for its work; nor may a task wait for its own phase", () => {
    const nodes: ReflowNode[] = [
      N("P", null, "06-01", "06-05"), N("c", "P", "06-01", "06-02"), N("d", "P", "06-03", "06-05"),
      N("X", null, "06-08", "06-09", ["c"]),
    ];
    expect(linkCyclePath(nodes, "P", "c")).toEqual(["P", "c", "P"]);
    expect(linkCyclePath(nodes, "P", "X")).toEqual(["P", "c", "X", "P"]); // P carries c, X waits for c
    // Sixth review pass: a task linked to its own phase waits for itself (P
    // finishes when d does) — it was accepted, and every move then pushed d
    // past its own finish again.
    expect(linkCyclePath(nodes, "d", "P")).toEqual(["d", "P", "d"]);
    expect(wouldCreateCycle(nodes, "d", "P")).toBe(true);
    expect(linkCyclePath(nodes, "X", "P")).toBeNull();
    const closure = dependentsClosure(nodes, "P");
    expect([...closure].sort()).toEqual(["P", "X", "c", "d"]);
    expect([...dependentsClosure(nodes, "d")].sort()).toEqual(["P", "d"]); // the picker no longer offers d's own phase
  });

  it("a loop of plain task links the move reaches but never pushes round is still left alone — and a sub-task its own link pushed is carried only by the rest", () => {
    // W waits for X with weeks of slack; the old loop b ↔ c hangs off W (an old import).
    const nodes = [
      ...base(),
      N("W", null, "07-01", "07-02", ["X"]), N("b", null, "07-10", "07-11", ["W", "c"]), N("c", null, "07-12", "07-13", ["b"]),
    ];
    // X is pushed +1 by its own link, then Q +1, which used to carry X +1 again (X Jun 10–11, Q Jun 9–11).
    expect(dates(drag(nodes, "A1", 3).changes)).toEqual({ Q: "06-09→06-10", X: "06-09→06-10" });
  });

  // Every plan built only from links the check accepts is one the cascade
  // can order (never refused as a loop), the picker's closure agrees with the
  // check for every pair, and the relaxation branch (forced by an old loop
  // hanging off the moved task, which no push reaches) writes exactly what
  // the topological pass writes.
  it("fuzz (1,500 seeded plans with phases, links to phases and completed rows)", () => {
    const rng = (seed: number) => { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; };
    const iso = (ms: number) => new Date(ms).toISOString();
    let refused = 0, closureMismatch = 0, branchMismatch = 0, compared = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const r = rng(seed);
      const n = 3 + Math.floor(r() * 8);
      const nodes: ReflowNode[] = [];
      for (let i = 0; i < n; i++) {
        const s0 = Date.UTC(2026, 5, 1) + Math.floor(r() * 10) * DAY_MS;
        nodes.push({ id: `n${i}`, parentId: i > 0 && r() < 0.45 ? `n${Math.floor(r() * i)}` : null, plannedStartAt: iso(s0), plannedAt: iso(s0 + Math.floor(r() * 3) * DAY_MS), dependsOn: [], status: r() < 0.12 ? "completed" : "planned" });
      }
      for (let k = 0; k < n * 2; k++) {
        const a = nodes[Math.floor(r() * n)], b = nodes[Math.floor(r() * n)];
        if (!a.dependsOn!.includes(b.id) && !linkCyclePath(nodes, a.id, b.id)) a.dependsOn = [...a.dependsOn!, b.id];
      }
      for (const a of nodes) {
        const closure = dependentsClosure(nodes, a.id);
        for (const b of nodes) if (closure.has(b.id) !== (linkCyclePath(nodes, a.id, b.id) !== null)) closureMismatch++;
      }
      const leaves = nodes.filter((x) => !nodes.some((k) => k.parentId === x.id) && !isLocked(x));
      if (leaves.length === 0) continue;
      const pick = leaves[Math.floor(r() * leaves.length)];
      const primary = computeTreeMove(nodes, pick.id, 1 + Math.floor(r() * 4), "defer");
      if (primary.length === 0) continue;
      const by = new Map(primary.map((c) => [c.id, c]));
      const updated = nodes.map((x) => (by.has(x.id) ? { ...x, plannedStartAt: by.get(x.id)!.plannedStartAt, plannedAt: by.get(x.id)!.plannedAt } : x));
      let topo;
      try { topo = planCascade(updated, primary.map((c) => c.id)); } catch (e) { if (e instanceof CascadeRefusedError) { refused++; continue; } throw e; }
      const old: ReflowNode[] = [
        { id: "W", plannedStartAt: d("2027-01-01"), plannedAt: d("2027-01-02"), dependsOn: [pick.id] },
        { id: "b", plannedStartAt: d("2027-01-10"), plannedAt: d("2027-01-11"), dependsOn: ["W", "c"] },
        { id: "c", plannedStartAt: d("2027-01-12"), plannedAt: d("2027-01-13"), dependsOn: ["b"] },
      ];
      const relaxed = planCascade([...updated, ...old], primary.map((c) => c.id));
      compared++;
      const key = (p: { changes: Array<{ id: string }>; held: Array<{ id: string }> }) => JSON.stringify({
        changes: p.changes.filter((c) => !["W", "b", "c"].includes(c.id)).sort((x, y) => x.id.localeCompare(y.id)),
        held: p.held.map((h) => h.id).filter((h) => !["W", "b", "c"].includes(h)).sort(),
      });
      if (key(topo) !== key(relaxed)) branchMismatch++;
    }
    expect(compared).toBeGreaterThan(1000);
    expect({ refused, closureMismatch, branchMismatch }).toEqual({ refused: 0, closureMismatch: 0, branchMismatch: 0 });
  });
});

// PT SCH-4 / SCH-9 (sixth review pass): a task linked to its own phase. The
// link check accepted it and the cascade read the phase at its stored finish
// — the envelope round the task itself — so every move pushed the task past
// it again: the reviewer's probe wrote t1 Jun 6–7, Jun 8–9, Jun 10–11 for
// three one-day drags of its sibling, and Jun 11–12 for a drag of t1 one day
// EARLIER. It is a loop (the phase finishes when its work does) and is now
// refused when it is made and whenever a move reaches a stored one.
describe("SCH-4 / SCH-9 · a task linked to its own phase is a loop", () => {
  const N = (id: string, parentId: string | null, s: string, f: string, deps: string[] = []): ReflowNode =>
    ({ id, parentId, plannedStartAt: d(`2026-${s}`), plannedAt: d(`2026-${f}`), dependsOn: deps, status: "planned" });
  const drag = (nodes: ReflowNode[], id: string, delta: number) => {
    const primary = computeTreeMove(nodes, id, delta, "defer");
    const by = new Map(primary.map((c) => [c.id, c]));
    const updated = nodes.map((n) => (by.has(n.id) ? { ...n, plannedStartAt: by.get(n.id)!.plannedStartAt, plannedAt: by.get(n.id)!.plannedAt } : n));
    return { primary, plan: planCascade(updated, primary.map((c) => c.id)) };
  };
  const refusal = (fn: () => unknown) => {
    try { fn(); } catch (e) { return e; }
    return null;
  };
  // The reviewer's plan: phase P (Jun 1–4) holds t1 (Jun 1–2) and t2 (Jun 3–4).
  const plan = (t1Deps: string[] = []): ReflowNode[] => [
    N("P", null, "06-01", "06-04"), N("t1", "P", "06-01", "06-02", t1Deps), N("t2", "P", "06-03", "06-04"),
  ];

  it("the link is refused when it is made, named through the phases between (the picker and updateMilestone)", () => {
    expect(linkCyclePath(plan(), "t1", "P")).toEqual(["t1", "P", "t1"]); // was null: saved
    expect(dependentsClosure(plan(), "t1").has("P")).toBe(true);
    // Nested: t inside Q inside P — waiting for either phase is a loop.
    const nested: ReflowNode[] = [N("P", null, "06-01", "06-09"), N("Q", "P", "06-01", "06-05"), N("t", "Q", "06-01", "06-02")];
    expect(linkCyclePath(nested, "t", "P")).toEqual(["t", "Q", "P", "t"]);
    expect(linkCyclePath(nested, "t", "Q")).toEqual(["t", "Q", "t"]);
    expect([...dependentsClosure(nested, "t")].sort()).toEqual(["P", "Q", "t"]);
    // A phase linked to its own parent phase is the same loop.
    expect(linkCyclePath(nested, "Q", "P")).toEqual(["Q", "P", "Q"]);
  });

  it("a stored one: a sibling's drag is refused with the loop named, not written two days out (the probe)", () => {
    const err = refusal(() => drag(plan(["P"]), "t2", 1));
    expect(err).toBeInstanceOf(CascadeRefusedError); // was: t1 written Jun 6–7
    expect((err as CascadeRefusedError).kind).toBe("cycle");
    expect((err as CascadeRefusedError).edges.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["t1>P:within", "P>t1:link"]);
    // ExecutionView renders the "within" step as "(its phase)": “t1” → (its phase) “P” → “t1”.
  });

  it("…and a drag of the task itself, earlier or later, is refused (it was written one day LATER for a drag earlier)", () => {
    for (const delta of [-1, 1]) {
      const err = refusal(() => drag(plan(["P"]), "t1", delta));
      expect(err).toBeInstanceOf(CascadeRefusedError);
      expect((err as CascadeRefusedError).edges.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["t1>P:within", "P>t1:link"]);
    }
  });

  it("without the link the same drag writes t2 and the phase only", () => {
    const { primary, plan: p } = drag(plan(), "t2", 1);
    expect(primary.map((c) => c.id).sort()).toEqual(["P", "t2"]);
    expect(p.changes).toEqual([]);
  });

  it("a successor OUTSIDE the phase still waits for all the work inside it", () => {
    const nodes = [...plan(), N("S", null, "06-05", "06-06", ["P"])];
    const { plan: p } = drag(nodes, "t2", 2);
    expect(p.changes.map((c) => `${c.id} ${day(c.plannedStartAt).slice(5)}→${day(c.plannedAt).slice(5)}`)).toEqual(["S 06-07→06-08"]);
  });
});

// PT SCH-4 / PC SCHED-5 (seventh review pass): a locked node — completed, an
// actual, an imported row — is never shifted, so no push can go round a loop
// through it. The cascade walked its links anyway and refused every move that
// reached such a loop: a COMPLETED task linked to its own phase blocked every
// drag in the phase (base and the fifth pass wrote them), and the only remedy
// was to edit a finished task's links (impossible for an imported row).
// Eighth review pass: only a locked node with no open work inside it. A
// locked PHASE that still holds open work is read at the finish of that
// work, which moves, so a loop through it is refused like any phase loop.
describe("SCH-4 / SCHED-5 · a loop through a locked task is no loop for the cascade", () => {
  const N = (id: string, parentId: string | null, s: string, f: string, deps: string[] = [], extra: Partial<ReflowNode> = {}): ReflowNode =>
    ({ id, parentId, plannedStartAt: d(`2026-${s}`), plannedAt: d(`2026-${f}`), dependsOn: deps, status: "planned", ...extra });
  const drag = (nodes: ReflowNode[], id: string, delta: number) => {
    const primary = computeTreeMove(nodes, id, delta, "defer");
    const by = new Map(primary.map((c) => [c.id, c]));
    const updated = nodes.map((n) => (by.has(n.id) ? { ...n, plannedStartAt: by.get(n.id)!.plannedStartAt, plannedAt: by.get(n.id)!.plannedAt } : n));
    return { primary, plan: planCascade(updated, primary.map((c) => c.id)) };
  };
  const span = (cs: Array<{ id: string; plannedStartAt: string; plannedAt: string }>) =>
    cs.map((c) => `${c.id} ${day(c.plannedStartAt).slice(5)}→${day(c.plannedAt).slice(5)}`).sort();

  it("the probe: P holds t1 (completed, linked to P), t2 and t3 — a drag of t2, or of t3, is written, never refused", () => {
    const nodes = [
      N("P", null, "06-01", "06-10"), N("t1", "P", "06-01", "06-02", ["P"], { status: "completed" }),
      N("t2", "P", "06-03", "06-04"), N("t3", "P", "06-05", "06-10"),
    ];
    const a = drag(nodes, "t2", 1); // was: "The dependency links form a loop (t1 → P, P → t1); nothing was moved."
    expect(span(a.primary)).toEqual(["t2 06-04→06-05"]);
    expect(a.plan.changes).toEqual([]);
    expect(a.plan.held.map((h) => h.id)).toEqual(["t1"]); // the done task's link to its own phase is reported, never met
    const b = drag(nodes, "t3", 1);
    expect(span(b.primary)).toEqual(["P 06-01→06-11", "t3 06-06→06-11"]);
    expect(b.plan.changes).toEqual([]);
    // The same link on an open task is still a loop, and still refused.
    const open = nodes.map((n) => (n.id === "t1" ? { ...n, status: "planned" } : n));
    expect(() => drag(open, "t2", 1)).toThrow(CascadeRefusedError);
  });

  it("the fifth pass's phase loop through a completed task: t2 (in P) waits for X, X (completed) waits for P — a drag of t3 is written", () => {
    const nodes = [
      N("P", null, "06-03", "06-10"), N("t2", "P", "06-03", "06-04", ["X"]),
      N("X", null, "05-20", "05-21", ["P"], { status: "completed" }), N("t3", "P", "06-05", "06-10"),
    ];
    const { primary, plan: p } = drag(nodes, "t3", 1);
    expect(span(primary)).toEqual(["P 06-03→06-11", "t3 06-06→06-11"]);
    expect(p.changes).toEqual([]);
    expect(p.held.map((h) => h.id)).toEqual(["X"]);
    // An actual finish locks it the same way; with X open, the loop is refused.
    expect(() => drag(nodes.map((n) => (n.id === "X" ? { ...n, status: "planned", actualAt: d("2026-05-21") } : n)), "t3", 1)).not.toThrow();
    expect(() => drag(nodes.map((n) => (n.id === "X" ? { ...n, status: "planned" } : n)), "t3", 1)).toThrow(CascadeRefusedError);
  });

  it("a loop through a locked PHASE's own work: the phase is held, its work still pushed — and a pushed phase still carries the work inside a locked sub-phase", () => {
    // L (an imported summary) waits for X; X waits for c, which sits inside L.
    const nodes = [
      N("L", null, "06-01", "06-05", ["X"], { locked: true }), N("c", "L", "06-01", "06-02"),
      N("X", null, "06-03", "06-04", ["c"]),
    ];
    const { plan: p } = drag(nodes, "c", 2);
    expect(span(p.changes)).toEqual(["X 06-05→06-06"]);
    expect(p.held.map((h) => h.id)).toEqual(["L"]);
    // A (manual) holds the locked sub-phase K, which holds k. Pushing A's
    // predecessor Z carries A's work through K to k; K stays put, so A
    // re-envelopes round K and k (Jun 1–10, unchanged).
    const carry = [
      N("Z", null, "05-25", "05-29"), N("A", null, "06-01", "06-10", ["Z"]),
      N("K", "A", "06-01", "06-05", [], { locked: true }), N("k", "K", "06-01", "06-05"),
    ];
    const { plan: q } = drag(carry, "Z", 7);
    expect(span(q.changes)).toEqual(["k 06-06→06-10"]);
  });

  // Review (eighth pass) probe: the seventh pass treated EVERY locked node
  // as fixed and dropped its links, but a locked phase that still holds open
  // work is read at phaseFinish — the finish of that work — which moves. P
  // (open) holds S (completed / imported) which holds u (open); P also holds
  // a, and P waits for S (stored before the link checks refused it). A +3
  // drag of P, or of u and a together, wrote u Jun 24–26 and a Jun 17–28
  // (+16 days), nothing held, nothing refused; the sixth pass refused it.
  it("a phase waiting for its own LOCKED sub-phase that holds open work is a loop — refused, never absorbed with a wrong carry", () => {
    const plan = (lock: Partial<ReflowNode>, uExtra: Partial<ReflowNode> = {}) => [
      N("P", null, "06-01", "06-12", ["S"]), N("S", "P", "06-01", "06-10", [], lock),
      N("u", "S", "06-08", "06-10", [], uExtra), N("a", "P", "06-01", "06-12"),
    ];
    const dragMany = (nodes: ReflowNode[], ids: string[], delta: number) => {
      const primary = new Map<string, { id: string; plannedStartAt: string; plannedAt: string }>();
      for (const id of ids) for (const c of computeTreeMove(nodes, id, delta, "defer")) if (!primary.has(c.id)) primary.set(c.id, c);
      const updated = nodes.map((n) => (primary.has(n.id) ? { ...n, plannedStartAt: primary.get(n.id)!.plannedStartAt, plannedAt: primary.get(n.id)!.plannedAt } : n));
      return { primary: [...primary.values()], plan: planCascade(updated, [...primary.keys()]) };
    };
    const refusal = (f: () => unknown) => {
      try { f(); } catch (e) { return e instanceof CascadeRefusedError ? e.edges.map((x) => `${x.from}>${x.to}:${x.via}`) : String(e); }
      return null;
    };
    for (const lock of [{ status: "completed" }, { locked: true }, { actualAt: d("2026-06-10") }] as Array<Partial<ReflowNode>>) {
      const nodes = plan(lock);
      // Was written: u 06-24→06-26, a 06-17→06-28, P 06-01→06-28, held [].
      expect(refusal(() => drag(nodes, "P", 3))).toEqual(["P>S:contains", "S>P:link"]);
      expect(refusal(() => dragMany(nodes, ["u", "a"], 3))).toEqual(["P>S:contains", "S>P:link"]);
      // A move that does not reach the loop is written as before (u's own
      // phases' successors do not include P, which contains it).
      expect(span(drag(nodes, "u", 2).primary)).toEqual(["u 06-10→06-12"]);
    }
    // With no open work left inside S (u done too), S's finish never moves:
    // no push can go round it, so the drag is written, exactly +3.
    const done = plan({ status: "completed" }, { status: "completed" });
    const { primary, plan: p } = drag(done, "P", 3);
    expect(span(primary)).toEqual(["P 06-01→06-15", "a 06-04→06-15"]); // a +3; P re-envelopes round S, which stays
    expect(p.changes).toEqual([]);
    expect(p.held).toEqual([]);
    // When the waiting phase is locked too, nothing can carry a push round
    // the loop (a locked node is never pushed): the move is written, and each
    // locked phase whose link into its own work is now broken is held — L
    // (imported) waits for its sub-phase K (completed), K waits for its own
    // task k. The seventh pass never reached L, so held read [K].
    const locked = [
      N("L", null, "06-01", "06-12", ["K"], { locked: true }), N("K", "L", "06-01", "06-10", ["k"], { status: "completed" }),
      N("k", "K", "06-08", "06-10"),
    ];
    const { primary: kp, plan: kq } = drag(locked, "k", 2);
    expect(span(kp)).toEqual(["k 06-10→06-12"]);
    expect(kq.changes).toEqual([]);
    expect(kq.held.map((h) => h.id).sort()).toEqual(["K", "L"]);
  });
});

// PT SCH-4 / SCH-9 (sixth review pass): a loop through a phase can be made
// without any new link — by putting a task inside a phase whose successor it
// already leads up to (the board's "Group under a parent → Use existing").
// outlineLoop is the check groupTasksUnderParent runs on the outline as it
// would be.
describe("SCH-4 / SCH-9 · outlineLoop: a regroup that would close a loop through a phase", () => {
  const N = (id: string, parentId: string | null, s: string, f: string, deps: string[] = []): ReflowNode =>
    ({ id, parentId, plannedStartAt: d(`2026-${s}`), plannedAt: d(`2026-${f}`), dependsOn: deps, status: "planned" });
  // The reviewer's probe: manual phase P holds p1; X waits for P; t waits for X.
  const before = (): ReflowNode[] => [
    N("P", null, "06-01", "06-05"), N("p1", "P", "06-01", "06-05"),
    N("X", null, "06-08", "06-09", ["P"]), N("t", null, "06-10", "06-11", ["X"]),
  ];
  const regroup = (nodes: ReflowNode[], ids: string[], parentId: string) =>
    nodes.map((n) => (ids.includes(n.id) ? { ...n, parentId } : n));

  it("grouping t under P closes X → t → (its phase) P → X; before it, there is none", () => {
    expect(outlineLoop(before(), ["t"])).toBeNull();
    const loop = outlineLoop(regroup(before(), ["t"], "P"), ["t"]);
    expect(loop?.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["t>P:within", "P>X:link", "X>t:link"]);
  });

  it("…which every move reaching it would refuse — the probe's p1 one day earlier, written before the regroup", () => {
    const move = (nodes: ReflowNode[]) => {
      const primary = computeTreeMove(nodes, "p1", -1, "defer");
      const by = new Map(primary.map((c) => [c.id, c]));
      const updated = nodes.map((n) => (by.has(n.id) ? { ...n, plannedStartAt: by.get(n.id)!.plannedStartAt, plannedAt: by.get(n.id)!.plannedAt } : n));
      return planCascade(updated, primary.map((c) => c.id));
    };
    expect(move(before()).changes).toEqual([]);
    expect(() => move(regroup(before(), ["t"], "P"))).toThrow(CascadeRefusedError);
  });

  it("a regroup that closes nothing is clear, a task that waits for its new phase is a loop, and plain-link loops are not its business", () => {
    // Q is unrelated to X / t: grouping t under it is fine.
    expect(outlineLoop(regroup([...before(), N("Q", null, "06-01", "06-02")], ["t"], "Q"), ["t"])).toBeNull();
    // t waits for Q; grouping t under Q makes t wait for itself.
    const own = regroup([...before(), N("Q", null, "06-01", "06-02"), N("u", null, "06-01", "06-01")].map((n) => (n.id === "t" ? { ...n, dependsOn: ["Q"] } : n)), ["t"], "Q");
    expect(outlineLoop(own, ["t"])?.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["t>Q:within", "Q>t:link"]);
    // An old loop of plain links downstream is left to the cascade's relaxation.
    const plain = [...before(), N("b", null, "07-01", "07-02", ["t", "c"]), N("c", null, "07-03", "07-04", ["b"])];
    expect(outlineLoop(plain, ["t"])).toBeNull();
  });

  // Review (seventh pass) probe: a loop already in the data — t1 linked to
  // its own phase P, reached from u through t2 — was reported for grouping u
  // under the unrelated R. With the outline as it is, only a loop the regroup
  // closes is reported.
  it("given the outline as it is, a loop already there is not the regroup's; one it closes is (a plain-link loop it turns into a phase loop included)", () => {
    const was = [
      N("P", null, "06-01", "06-05"), N("t1", "P", "06-01", "06-02", ["P"]), N("t2", "P", "06-03", "06-05", ["u"]),
      N("u", null, "05-28", "05-29"), N("R", null, "05-25", "05-29"),
    ];
    const str = (l: ReturnType<typeof outlineLoop>) => l?.map((e) => `${e.from}>${e.to}:${e.via}`) ?? null;
    expect(str(outlineLoop(was, ["u"]))).toEqual(["t1>P:within", "P>t1:link"]); // there already
    const after = regroup(was, ["u"], "R");
    expect(str(outlineLoop(after, ["u"]))).toEqual(["t1>P:within", "P>t1:link"]); // what refused it
    expect(outlineLoop(after, ["u"], was)).toBeNull();
    // With the stale loop still there, a regroup that closes a new one is named by the new one.
    const more = [...was, N("X", null, "06-08", "06-09", ["P"]), N("t", null, "06-10", "06-11", ["X"])];
    expect(str(outlineLoop(regroup(more, ["t"], "P"), ["t"], more))).toEqual(["t>P:within", "P>X:link", "X>t:link"]);
    // b ↔ c, an old plain-link loop (left to the cascade's relaxation); c also waits for Q. Grouping
    // b under Q makes c wait for b through Q too — now a loop through a phase, refused whenever reached.
    const plain = [N("Q", null, "06-01", "06-02"), N("b", null, "06-03", "06-04", ["c"]), N("c", null, "06-05", "06-06", ["b", "Q"])];
    expect(outlineLoop(plain, ["b"])).toBeNull();
    expect(str(outlineLoop(regroup(plain, ["b"], "Q"), ["b"], plain))).toEqual(["b>Q:within", "Q>c:link", "c>b:link"]);
  });

  it("each moved task's whole subtree is checked: grouping a phase whose sub-task leads up to the target's successor", () => {
    const nodes: ReflowNode[] = [
      N("P", null, "06-01", "06-05"), N("X", null, "06-08", "06-09", ["P"]),
      N("G", null, "06-10", "06-12"), N("g1", "G", "06-10", "06-11", ["X"]),
    ];
    expect(outlineLoop(nodes, ["G"])).toBeNull();
    expect(outlineLoop(regroup(nodes, ["G"], "P"), ["G"])?.map((e) => `${e.from}>${e.to}:${e.via}`)).toEqual(["g1>P:within", "P>X:link", "X>g1:link"]);
  });
});
