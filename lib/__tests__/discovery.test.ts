// Discovery work: put into the schedule after the step it was found on,
// holding up what it should, pushing what's linked downstream — and the
// impact said before it's saved and kept after.

import { describe, it, expect } from "vitest";
import { planDiscovery, defaultAfter, defaultHolds, discoveries, impactLine, discoveryAttr, discoveryOf, earliestStart, followsUntil, addedTitle, kindOf, relinkWithout, type DiscoveryRecord } from "@/lib/discovery";
import type { Milestone } from "@/types/schema";

const UTC = "UTC";
const T0 = Date.parse("2026-10-27T06:00:00Z");
const h = (n: number) => new Date(T0 + n * 3_600_000).toISOString();
const mk = (p: Partial<Milestone> & { id: string }): Milestone =>
  ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);

// V-7: open (0–10, under way) → clean (10–20) → close (20–30) → [startup S 30–34]
// E-13: one step (0–8), off the path.
const base = () => [
  mk({ id: "v7", name: "V-7" }), mk({ id: "e13", name: "E-13" }), mk({ id: "su", name: "Start-up" }),
  mk({ id: "open", parentId: "v7", plannedStartAt: h(0), plannedAt: h(10), status: "in_progress", percentComplete: 40, actualStartAt: h(0) }),
  mk({ id: "clean", parentId: "v7", plannedStartAt: h(10), plannedAt: h(20), dependsOn: ["open"] }),
  mk({ id: "close", parentId: "v7", plannedStartAt: h(20), plannedAt: h(30), dependsOn: ["clean"] }),
  mk({ id: "S", parentId: "su", plannedStartAt: h(30), plannedAt: h(34), dependsOn: ["close"] }),
  mk({ id: "x", parentId: "e13", plannedStartAt: h(0), plannedAt: h(8) }),
];
const now = T0 + 4 * 3_600_000;

describe("discovery work into the schedule", () => {
  it("found and planned are two different times: it starts when it's planned to, not when it was found", () => {
    // Found at hour 2; the step it follows is planned done at 10.
    expect(earliestStart(base(), "open", now)).toBe(T0 + 10 * 3_600_000);
    expect(earliestStart(base(), null, now)).toBe(now);
    expect(followsUntil(base(), "open")).toBe(T0 + 10 * 3_600_000);
    const asap = planDiscovery(base(), { taskId: "v7", what: "Tray 14", foundAt: T0 + 2 * 3_600_000, steps: [{ name: "Weld", hours: 4 }], afterId: "open" }, { now, tz: UTC });
    expect([asap.steps[0].plannedStartAt, asap.steps[0].plannedAt]).toEqual([h(10), h(14)]);
    // Planned for a set time — the next morning.
    const set = planDiscovery(base(), { taskId: "v7", what: "Tray 14", foundAt: T0 + 2 * 3_600_000, steps: [{ name: "Weld", hours: 4 }, { name: "QC", hours: 1 }], afterId: "open", startAt: T0 + 24 * 3_600_000 }, { now, tz: UTC });
    expect(set.steps.map((x) => [x.plannedStartAt, x.plannedAt])).toEqual([[h(24), h(28)], [h(28), h(29)]]);
  });
  it("defaults: after the step under way, holding up what waits on it", () => {
    expect(defaultAfter(base(), "v7")).toBe("open");
    expect(defaultHolds(base(), "v7", "open")).toEqual(["clean"]);
  });
  it("added on a calendar day: after the last step done by then, so it can start that day", () => {
    const done = base().map((m) => (m.id === "open" ? { ...m, status: "completed" as const, actualAt: h(9) } : m));
    // A day already gone: only what was done by its start counts.
    expect(defaultAfter(done, "v7", { from: T0 + 12 * 3_600_000, now })).toBe("open");
    expect(defaultAfter(done, "v7", { from: T0 + 8 * 3_600_000, now })).toBeNull();
    expect(defaultAfter(base(), "v7", { from: T0 + 2 * 3_600_000, now })).toBeNull();
    // A day to come: planned done by then counts too.
    expect(defaultAfter(base(), "v7", { from: T0 + 24 * 3_600_000, now })).toBe("clean");
  });
  it("runs after the step it follows, holds up the next, pushes everything linked downstream", () => {
    const p = planDiscovery(base(), { taskId: "v7", what: "Tray 14 cracked", foundAt: now, steps: [{ name: "Weld repair tray 14", crew: "Ancon", hours: 8 }, { name: "QC weld", crew: "Inspector", hours: 2 }], afterId: "open", holdsIds: ["clean"] }, { now, tz: UTC });
    expect(p.steps.map((s) => [s.name, s.plannedStartAt, s.plannedAt, s.dependsOn])).toEqual([
      ["Weld repair tray 14", h(10), h(18), ["open"]],
      ["QC weld", h(18), h(20), ["new:0"]],
    ]);
    expect(p.links).toEqual([{ id: "clean", dependsOn: ["open", "new:1"] }]);
    const moved = Object.fromEntries(p.moves.map((c) => [c.id, [c.plannedStartAt, c.plannedAt]]));
    expect(moved.clean).toEqual([h(20), h(30)]);
    expect(moved.close).toEqual([h(30), h(40)]);
    expect(moved.S).toEqual([h(40), h(44)]);
    expect(p.impact.hours).toBe(10);
    expect(p.impact.taskFinish).toEqual([Date.parse(h(30)), Date.parse(h(40))]);
    expect((p.impact.finish[1] - p.impact.finish[0]) / 3_600_000).toBe(10);
    expect(p.impact.critical).toBe(true);
    expect(p.impact.pushed.map((x) => [x.id, x.hours])).toEqual([["clean", 10], ["close", 10], ["S", 10]]);
    expect(impactLine(p.impact, (n) => `${n} h`)).toBe("10 h of work · task finish +10 h · turnaround finish +10 h · on the critical path");
  });
  it("off the path, with room: nothing moves but the task", () => {
    const p = planDiscovery(base(), { taskId: "e13", what: "Extra plug", foundAt: now, steps: [{ name: "Plug tube", hours: 4 }], afterId: "x" }, { now, tz: UTC });
    expect(p.moves).toEqual([]);
    expect(p.impact.finish[1]).toBe(p.impact.finish[0]);
    expect(p.impact.critical).toBe(false);
    expect(impactLine(p.impact, (n) => `${n} h`)).toBe("4 h of work · task finish +4 h · turnaround finish unchanged");
  });
  it("never starts before it's found", () => {
    const p = planDiscovery(base(), { taskId: "e13", what: "Found late", foundAt: now, steps: [{ name: "Fix", hours: 1 }], afterId: null }, { now: T0 + 20 * 3_600_000, tz: UTC });
    expect(p.steps[0].plannedStartAt).toBe(h(20));
  });
});

describe("discovery as the reports read it", () => {
  it("groups each find's steps, oldest first", () => {
    const rec = (id: string, seq: number, of: number, foundAt: number): DiscoveryRecord => ({ id, what: `found ${id}`, foundAt, addedAt: foundAt, seq, of, impact: { hours: 1, taskFinish: [0, 0], finish: [0, 0], critical: false, pushed: [] } });
    const ms = [...base(),
      mk({ id: "d2", parentId: "v7", attributes: { discovery: discoveryAttr(rec("B", 1, 1, 200)) } }),
      mk({ id: "d1b", parentId: "v7", attributes: { discovery: discoveryAttr(rec("A", 2, 2, 100)) } }),
      mk({ id: "d1a", parentId: "v7", attributes: { discovery: discoveryAttr(rec("A", 1, 2, 100)) } }),
    ];
    const ds = discoveries(ms);
    expect(ds.map((d) => [d.record.id, d.steps.map((s) => s.id), d.task?.id])).toEqual([["A", ["d1a", "d1b"], "v7"], ["B", ["d2"], "v7"]]);
  });
});

import { vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
import { buildShiftReport, shiftWindow } from "@/lib/shiftReport";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import { buildTimeLog } from "@/lib/timeLog";

describe("discovery on the turnover and in the time log", () => {
  const LA = "America/Los_Angeles";
  const times = { dayStart: "06:00", nightStart: "18:00" };
  const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
  const f = { D: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 10), DTs: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 16), T: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(11, 16), win: () => "", hrs: (n: number) => `${n} h` };
  const found = Date.parse(at("2026-10-27", "14:30"));
  const rec: DiscoveryRecord = { id: "D1", what: "Tray 14 cracked at the weld", foundAt: found, foundBy: "Gabe", approvedBy: "TA manager", addedAt: found, seq: 1, of: 1,
    impact: { hours: 8, taskFinish: [0, 8 * 3_600_000], finish: [0, 6 * 3_600_000], critical: true, pushed: [] } };
  const ms = [mk({ id: "v7", name: "V-7 Tower", workOrderRef: "301235" }),
    mk({ id: "w", parentId: "v7", name: "Weld repair tray 14", responsibleParty: "Ancon", durationHours: 8, plannedStartAt: at("2026-10-27", "19:00"), plannedAt: at("2026-10-28", "03:00"), attributes: { discovery: discoveryAttr(rec) } })];
  const day = shiftWindow("2026-10-27", "day", LA, times);
  const report = buildShiftReport({ milestones: ms, tz: LA, times, shift: day, now: day.end });
  it("its own section at the end of the email, with what it did - and a tag on its step", () => {
    const sections = turnoverUpdate(report, f, { pctOf: () => 0, finishOf: () => undefined, discovery: discoveries(ms) });
    expect(sections[sections.length - 1].id).toBe("discovery");
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections });
    expect(text).toMatch(/DISCOVERY WORK - DAY SHIFT 10-27 - 1 added this shift · 8 h added · turnaround \+6 h · 1 on the critical path · so far 1 \(8 h, finish \+6 h\)/);
    expect(text).toMatch(/Tray 14 cracked at the weld/);
    expect(text).toMatch(/Weld repair tray 14 - Ancon, 8 h · not started/);
    expect(text).toMatch(/8 h of work · task finish \+8 h · turnaround finish \+6 h · on the critical path/);
    expect(text).toMatch(/Discovery - Tray 14 cracked at the weld/);
  });
  it("added scope reads as added scope - the section, the step's tag, the time log", () => {
    const asAdded = ms.map((m) => { const d = discoveryOf(m); return d ? { ...m, attributes: { ...(m.attributes ?? {}), discovery: discoveryAttr({ ...d, kind: "added" }) } } as Milestone : m; });
    const sections = turnoverUpdate(report, f, { pctOf: () => 0, finishOf: () => undefined, discovery: discoveries(asAdded) });
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections });
    expect(text).toMatch(/ADDED SCOPE - DAY SHIFT 10-27 - 1 added this shift/);
    expect(text).not.toMatch(/DISCOVERY WORK/);
    const rows = buildTimeLog({ milestones: asAdded, log: [], notes: [], tz: LA, times });
    expect(rows.find((r) => r.what === "Added scope raised")).toMatchObject({ at: found, step: "Weld repair tray 14" });
    expect(addedTitle(["discovery", "added"])).toBe("Discovery & added scope");
    expect(kindOf(undefined)).toBe("discovery");
  });
  it("in the time log, when it was found", () => {
    const rows = buildTimeLog({ milestones: ms, log: [], notes: [], tz: LA, times });
    expect(rows.find((r) => r.what === "Discovery found")).toMatchObject({ at: found, task: "V-7 Tower", wo: "301235", step: "Weld repair tray 14", crew: "Ancon", enteredBy: "Gabe" });
  });
});

describe("discovery follows the project's critical-path setting", () => {
  it("'Only what I mark' with nothing marked: not called critical, whatever the links say", () => {
    const draft = { taskId: "v7", what: "Tray 14 cracked", foundAt: now, steps: [{ name: "Weld repair", hours: 8 }], afterId: "open", holdsIds: ["clean"] };
    expect(planDiscovery(base(), draft, { now, tz: UTC, mode: "links" }).impact.critical).toBe(true);
    expect(planDiscovery(base(), draft, { now, tz: UTC, mode: "none" }).impact.critical).toBe(false);
  });
});

describe("a comment typed without a time, in the time log", () => {
  const LA = "America/Los_Angeles";
  const times = { dayStart: "06:00", nightStart: "18:00" };
  const ms = [mk({ id: "v7", name: "V-7 Tower" }), mk({ id: "s", parentId: "v7", name: "Clean trays" })];
  const note = (createdAt: string, happenedAt?: string) => ({ id: createdAt, orgId: "o", milestoneId: "s", kind: "note", body: "Trays 1–10 cleaned", createdBy: "u", createdAt, ...(happenedAt ? { happenedAt } : {}) }) as never;
  it("written at the turnover (just after the shift ended) is the shift that ended - as the report files it", () => {
    const rows = buildTimeLog({ milestones: ms, log: [], notes: [note("2026-10-27T18:20:00-07:00")], tz: LA, times });
    expect(rows[0].shift).toMatch(/Oct 27 · Day/);
  });
  it("with a time put in, that time's shift", () => {
    const rows = buildTimeLog({ milestones: ms, log: [], notes: [note("2026-10-27T18:20:00-07:00", "2026-10-27T18:10:00-07:00")], tz: LA, times });
    expect(rows[0].shift).toMatch(/Oct 27 · Night/);
  });
});

describe("relinkWithout - deleting a discovery keeps the chain", () => {
  it("a step that waited on the removed steps waits on what they waited on", () => {
    // A → D1 → D2 → X (D1, D2 the discovery's steps); Y waits on D2 and B.
    const rows = [
      { id: "A", dependsOn: [] }, { id: "B", dependsOn: [] },
      { id: "D1", dependsOn: ["A"] }, { id: "D2", dependsOn: ["D1"] },
      { id: "X", dependsOn: ["D2"] }, { id: "Y", dependsOn: ["D2", "B"] }, { id: "Z", dependsOn: ["A"] },
    ];
    expect(relinkWithout(rows, new Set(["D1", "D2"]))).toEqual([
      { id: "X", dependsOn: ["A"] },
      { id: "Y", dependsOn: ["A", "B"] },
    ]);
  });
  it("no duplicates, no self-links, no loops", () => {
    const rows = [{ id: "A", dependsOn: [] }, { id: "D", dependsOn: ["A", "X"] }, { id: "X", dependsOn: ["D", "A"] }];
    expect(relinkWithout(rows, new Set(["D"]))).toEqual([{ id: "X", dependsOn: ["A"] }]);
  });
});
