// Why the job is behind: each step's hours traced to what holds it up.

import { describe, it, expect } from "vitest";
import { behindWhy, behindWhyBlocks, chainText, chainLabel, labelHours, whyTitle } from "@/lib/behindWhy";
import type { GapDriver } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const T0 = Date.parse("2026-10-27T00:00:00Z");
const at = (n: number) => T0 + n * 3_600_000;
const h = (n: number) => new Date(at(n)).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "msproject", createdBy: "u", ...p } as Milestone);
const found = (kind: "added" | "discovery") => ({ discovery: JSON.stringify({ id: "d1", what: "found it", kind, foundAt: at(10), addedAt: at(10), seq: 1, of: 1, impact: { hours: 31, taskFinish: [0, 0], finish: [0, 0], critical: false, pushed: [] } }) });
const drv = (id: string, hours: number): GapDriver => ({ id, name: id, parentName: "V-7", hours, percent: 0, planPct: 100, start: 0, finish: 0 });
const f = { DTs: (ms: number) => `h${Math.round((ms - T0) / 3_600_000)}`, hrs: (x: number) => `${x} h` };

// V-7: open (0–10, done on time) → downcomer clean (added scope, 10–20, done at 41)
//   → clean tower (10–22, 12 h, started 43, 50%) → inspect (22–23) → install (23–71)
const tower = (kind: "added" | "discovery" = "added") => [
  mk({ id: "v7", name: "V-7" }),
  mk({ id: "open", parentId: "v7", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10, status: "completed", percentComplete: 100, actualStartAt: h(0), actualAt: h(10) }),
  mk({ id: "dc", parentId: "v7", source: "manual", attributes: found(kind), plannedStartAt: h(10), plannedAt: h(28), durationHours: 18, dependsOn: ["open"], status: "completed", percentComplete: 100, actualStartAt: h(12), actualAt: h(41) }),
  mk({ id: "clean", parentId: "v7", plannedStartAt: h(10), plannedAt: h(22), durationHours: 12, dependsOn: ["open", "dc"], status: "in_progress", percentComplete: 50, actualStartAt: h(43) }),
  mk({ id: "insp", parentId: "v7", plannedStartAt: h(22), plannedAt: h(23), durationHours: 1, dependsOn: ["clean"] }),
  mk({ id: "inst", parentId: "v7", plannedStartAt: h(23), plannedAt: h(71), durationHours: 48, dependsOn: ["insp"] }),
];

describe("why the job is behind", () => {
  it("steps waiting to start go with the step holding them up, and its late start with what it waited for", () => {
    const w = behindWhy({ behind: [drv("inst", 25), drv("clean", 6), drv("insp", 1)], ahead: 3, milestones: tower(), now: at(60) });
    expect(w.total).toBe(32);
    expect(w.ahead).toBe(3);
    expect(w.chains).toHaveLength(1);
    const ch = w.chains[0];
    expect(ch.head.name).toBe("clean");
    expect(ch.steps.map((s) => s.id)).toEqual(["clean", "inst", "insp"]);
    expect(ch.pushed).toMatchObject({ by: "dc", byCause: "added", ready: at(41), lateH: 31 });
    // Planned done at 22; at its pace from 60 it's done at 66: a 44 h slip,
    // 31 h of it the wait for the added scope.
    expect(ch.split.added).toBeCloseTo(32 * 31 / 44, 1);
    expect(ch.split.own).toBeCloseTo(32 * 13 / 44, 1);
    expect(ch.cause).toBe("added");
    // Every hour lands somewhere, once.
    expect(w.byCause.added + w.byCause.own + w.byCause.discovery + w.byCause.held).toBeCloseTo(32, 1);
  });

  it("found work is discovery, not the planner's call", () => {
    const w = behindWhy({ behind: [drv("inst", 25)], ahead: 0, milestones: tower("discovery"), now: at(60) });
    expect(w.chains[0].pushed?.byCause).toBe("discovery");
    expect(w.byCause.discovery).toBeGreaterThan(0);
    expect(w.byCause.added).toBe(0);
  });

  it("a hold is its own cause, with its reason", () => {
    const ms = tower().map((m) => (m.id === "clean" ? { ...m, status: "on_hold" as const, statusReason: "waiting on vac truck" } : m));
    const w = behindWhy({ behind: [drv("clean", 6), drv("inst", 25)], ahead: 0, milestones: ms, now: at(60) });
    expect(w.chains[0].cause).toBe("held");
    expect(w.byCause.held).toBe(31);
    expect(chainText(w.chains[0], f).facts).toContain("On hold - waiting on vac truck");
  });

  it("late with nothing in the way is its own", () => {
    // What it waits on finished on time; it started 20 h late anyway.
    const ms = [
      mk({ id: "a", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10, status: "completed", percentComplete: 100, actualAt: h(9) }),
      mk({ id: "b", plannedStartAt: h(10), plannedAt: h(20), durationHours: 10, dependsOn: ["a"], status: "in_progress", percentComplete: 20, actualStartAt: h(30) }),
    ];
    const w = behindWhy({ behind: [drv("b", 8)], ahead: 0, milestones: ms, now: at(40) });
    expect(w.byCause.own).toBe(8);
    expect(w.chains[0].pushed).toBeUndefined();
    expect(chainText(w.chains[0], f).facts).toBe("Started h30 - 20 h after its planned start, nothing in its way.");
  });

  it("found work running behind its own plan is discovery", () => {
    const ms = tower("discovery").map((m) => (m.id === "dc" ? { ...m, status: "in_progress" as const, percentComplete: 25, actualAt: undefined } : m));
    const w = behindWhy({ behind: [drv("dc", 10)], ahead: 0, milestones: ms, now: at(30) });
    expect(w.chains[0].cause).toBe("discovery");
    expect(w.byCause.discovery).toBe(10);
  });

  it("a link to a whole task waits on all of its steps", () => {
    const ms = [
      mk({ id: "t" }),
      mk({ id: "t1", parentId: "t", plannedStartAt: h(0), plannedAt: h(5), durationHours: 5, status: "in_progress", percentComplete: 10, actualStartAt: h(0) }),
      mk({ id: "n", plannedStartAt: h(5), plannedAt: h(10), durationHours: 5, dependsOn: ["t"] }),
    ];
    const w = behindWhy({ behind: [drv("n", 5)], ahead: 0, milestones: ms, now: at(12) });
    expect(w.chains[0].head.id).toBe("t1");
  });

  it("a step it can't find stays its own line", () => {
    const w = behindWhy({ behind: [{ ...drv("gone", 2), id: null }], ahead: 0, milestones: [], now: at(1) });
    expect(w.total).toBe(2);
    expect(w.byCause.own).toBe(2);
  });

  it("says it in words, and as the email's table", () => {
    const w = behindWhy({ behind: [drv("inst", 25), drv("clean", 6), drv("insp", 1)], ahead: 0, milestones: tower(), now: at(60) });
    const t = chainText(w.chains[0], f);
    expect(t.title).toBe("V-7: clean");
    expect(t.state).toBe("50%");
    expect(t.facts).toBe("Couldn't start until dc (added scope) was done h41 - 31 h after its planned start. Started h43.");
    expect(t.waiting).toBe("Waiting on it: inst 25 h · insp 1 h");
    expect(t.split).toBe("added scope 22.5 h · late or slow 9.5 h");
    const blocks = behindWhyBlocks(w, f);
    expect(blocks[0]).toEqual({ k: "label", text: "Why we're behind - 32 h of work behind plan" });
    expect(blocks[2].k).toBe("table");
  });
});

describe("put off, not behind: how each chain reads", () => {
  // Two steps not started, nothing in their way; one started and slow; one
  // on the critical path; one held.
  const ms = [
    mk({ id: "a", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10 }),
    mk({ id: "b", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10, status: "in_progress", percentComplete: 20, actualStartAt: h(1) }),
    mk({ id: "c", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10 }),
    mk({ id: "d", plannedStartAt: h(0), plannedAt: h(10), durationHours: 10, status: "on_hold", statusReason: "no permit" }),
  ];
  const w = behindWhy({ behind: [drv("a", 10), drv("b", 6), drv("c", 4), drv("d", 3)], ahead: 30, milestones: ms, now: at(12), critical: new Set(["c"]) });
  const lab = (id: string) => chainLabel(w.chains.find((ch) => ch.head.id === id)!);
  it("not started: put off; started: slower than plan; neither flagged", () => {
    expect(lab("a")).toEqual({ short: "put off", flag: false });
    expect(lab("b")).toEqual({ short: "slower than plan", flag: false });
  });
  it("on the critical path, or held: flagged", () => {
    expect(lab("c")).toEqual({ short: "late, critical path", flag: true });
    expect(lab("d")).toEqual({ short: "on hold", flag: true });
  });
  it("hours by how they read, flagged first", () => {
    expect(labelHours(w).map((x) => x.short)).toEqual(["late, critical path", "on hold", "put off", "slower than plan"]);
  });
  it("behind overall: why we're behind, every chain", () => {
    expect(whyTitle(w, f.hrs)).toBe("Why we're behind - 23 h of work behind plan, 30 h ahead elsewhere");
    const blocks = behindWhyBlocks(w, f, 8);
    const table = blocks.find((b) => b.k === "table") as { rows: unknown[][] };
    expect(table.rows).toHaveLength(4);
    expect(blocks.some((b) => b.k === "stats")).toBe(true);
  });
  it("never says the work was done out of order", () => {
    expect(JSON.stringify(behindWhyBlocks(w, f, 8)) + whyTitle(w, f.hrs)).not.toMatch(/out of order/i);
  });
});
