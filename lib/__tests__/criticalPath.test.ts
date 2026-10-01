// lib/__tests__/criticalPath.test.ts
//
// PT SCH-15 / PC SCHED-10: the critical path is derived from the dependency
// links (a backward pass over the scheduled network, total float per leaf),
// not from date contiguity. The auditor's three measured failures of the
// retired heuristic are pinned here as their CPM answers: (a) a long-lead
// driver more than 14 days back is on the path when its link (with its lag)
// makes it the driver; (b) two parallel chains are not merged — the chain
// with float is off the path, and a date-contiguous task with no link is not
// pulled in; (c) a task at 90% contributes 10% of its hours to "remaining".
//
// Review fix pass: gaps and float are measured in WORKING time (Monday to
// Friday) — a weekly chain handed off Friday → Monday is one driving chain,
// not a path cut back to the last week — and a finished task with the latest
// planned date no longer empties the path.
//
// Third fix pass: on the Mon–Fri clock weekend work weighed nothing, so a
// weekend shutdown or a 7-day outage marked tasks with real slack (or every
// task) critical.
//
// Fourth fix pass: the third pass inferred the WEEK for the whole plan (one
// unfinished weekend leaf put every day on the clock), so a single Saturday
// job broke a Mon–Fri chain at every Friday-to-Monday hand-off ([W1,W2,W3]
// became [W3]). The worked weekend DAYS are now inferred instead — the
// Saturdays and Sundays spanned by an unfinished leaf that starts or finishes
// on one — and each counts only for the linked network that works it
// (`calendar: "worked-weekends"`, `workedWeekendDays`).
//
// Fifth fix pass: per network was still too wide — in a fully linked plan
// (a shared start or finish milestone, a Saturday feeder into week 3) the
// network is the whole plan, and the chain lost its Friday predecessor
// ([W2, W3]). Each hand-off is now measured on its SUCCESSOR's clock: Mon–Fri
// plus the weekend days of the successor and of the work leading up to it.
// The captions count only the weekend days the path itself was measured with.
//
// Sixth fix pass: the successor's clock counted the weekend days of every
// task it waits for, so one Saturday delivery feeding W5 gave W4 — and every
// week behind it — a day of float, and the highlighted path became [S, W5].
// Each hand-off is now measured on its OWN two tasks' weekend days only, so a
// Mon–Fri task feeding a Monday start is critical whatever weekend work also
// feeds it (P6 / MS Project). A task linked to its own phase is a loop here,
// as in the link check and the cascade.
//
// Seventh fix pass: only a loop's MEMBERS are left out (Tarjan); the leaves
// downstream of it keep their place, so one task linked to its own phase no
// longer takes every later phase off the path.

import { describe, it, expect } from "vitest";
import { computeCriticalPath, pathCalendarLabel } from "@/lib/criticalPath";
import { afterLagMs, lagWorkingMs, linkCyclePath, planCascade, reflowNodesFromMilestones, workingGapMs, workingTimeMs, CascadeRefusedError, DAY_MS } from "@/lib/scheduleReflow";
import type { Milestone } from "@/types/schema";

const mk = (o: Partial<Milestone>): Milestone => ({
  orgId: "o", name: "t", weight: 1, plannedAt: "2026-03-10T00:00:00Z",
  status: "planned", source: "manual", createdBy: "u", ...o,
});
const d = (s: string) => `${s}T00:00:00Z`;

describe("computeCriticalPath — CPM over the finish-to-start links", () => {
  it("a linked chain to the finish is the path; a finished task is not driving", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-01"), status: "completed" }),
      mk({ id: "b", plannedStartAt: d("2026-03-02"), plannedAt: d("2026-03-04"), status: "in_progress", dependsOn: ["a"] }),
      mk({ id: "c", plannedStartAt: d("2026-03-05"), plannedAt: d("2026-03-08"), status: "planned", dependsOn: ["b"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["b", "c"]);
    expect(r.ids.has("a")).toBe(false);            // done — not driving
    expect(r.finish).toBe("2026-03-08T00:00:00.000Z");
    expect(r.floatDays.get("b")).toBe(0);
    expect(r.linked).toBe(true);
  });

  it("(a) long-lead driver: a delivery three weeks before install is critical when its link's lag makes it the driver", () => {
    // Delivery done Tue 2026-02-10; a P6 lag of 3 working weeks (lag_hr_cnt 120 = 15 × 8 h);
    // install starts Wed 2026-03-04 — exactly when those 15 working days run out.
    const ms: Milestone[] = [
      mk({ id: "delivery", externalRef: "p6:1", plannedStartAt: d("2026-01-01"), plannedAt: d("2026-02-10") }),
      mk({ id: "install", externalRef: "p6:2", plannedStartAt: d("2026-03-04"), plannedAt: d("2026-03-13"), dependsOn: ["delivery"], attributes: { source_links: "FS p6:1 +120h" } }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.ids.has("install")).toBe(true);
    expect(r.ids.has("delivery")).toBe(true);   // the heuristic dropped it (gap > 14 days)
    expect(r.floatDays.get("delivery")).toBe(0);
    // Without the lag the same delivery genuinely has three weeks of float — 15
    // working days (21 calendar days) — and CPM says so.
    const noLag = computeCriticalPath(ms.map((m) => (m.id === "install" ? { ...m, attributes: {} } : m)));
    expect(noLag.ids.has("delivery")).toBe(false);
    expect(noLag.floatDays.get("delivery")).toBe(15);
    // The lag is WORKING time (PC SCHED-13): read as 120 elapsed hours (5 calendar days)
    // an install on Mon 02-16 would satisfy it and the delivery would show 16 days of float
    // in the plan above; as 15 working days it has not run out by 02-16 — negative float.
    const early = computeCriticalPath(ms.map((m) => (m.id === "install" ? { ...m, plannedStartAt: d("2026-02-16"), plannedAt: d("2026-02-25") } : m)));
    expect(early.floatDays.get("delivery")).toBeLessThan(0);
    expect(early.ids.has("delivery")).toBe(true);
  });

  it("(b) parallel chains are not merged: the chain with float is off the path; an unlinked date-contiguous task is not pulled in", () => {
    const ms: Milestone[] = [
      mk({ id: "A1", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-05") }),
      mk({ id: "A2", plannedStartAt: d("2026-03-06"), plannedAt: d("2026-03-10"), dependsOn: ["A1"] }),
      mk({ id: "B1", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02") }),
      mk({ id: "B2", plannedStartAt: d("2026-03-03"), plannedAt: d("2026-03-07"), dependsOn: ["B1"] }),
      mk({ id: "C", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-05") }), // ends the day before A2 starts, no link
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["A1", "A2"]);
    // Two weekend days carry work (A1, B1 and C start Sun 03-01; B2 finishes
    // Sat 03-07); Sun 03-08 carries none. B2 is ready Sun 03-08 00:00 and could
    // slip to Wed 03-11 00:00: Monday and Tuesday, 2 days (the idle Sunday is
    // not one). C (unlinked) is weighed against the finish on the clock of the
    // chain that sets it (A1 → A2, which works Sun 03-01, not Sat 03-07):
    // ready Fri 03-06, it has Friday, Monday and Tuesday — 3.
    expect(r.calendar).toBe("worked-weekends");
    // The path's own weekend day (A1 starts Sun 03-01); B2's Saturday is off it.
    expect(r.workedWeekendDays).toEqual(["2026-03-01"]);
    expect(r.floatDays.get("B1")).toBe(2);
    expect(r.floatDays.get("B2")).toBe(2);
    expect(r.floatDays.get("C")).toBe(3);
    expect(r.unlinked).toBe(1);
  });

  it("(c) remaining hours count only the work left: a 100h task at 90% contributes 10h", () => {
    const ms: Milestone[] = [
      mk({ id: "x", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10"), status: "in_progress", percentComplete: 90, durationHours: 100 }),
    ];
    expect(computeCriticalPath(ms).remainingHours).toBe(10);
  });

  it("an overnight hand-off (17:00 → next 08:00) stays on the path; a link to a phase applies to its leaves", () => {
    const ms: Milestone[] = [
      mk({ id: "weld", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-01T17:00:00Z" }),
      mk({ id: "P", isSummary: true, plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-03T17:00:00Z", dependsOn: ["weld"] }),
      mk({ id: "nde", parentId: "P", plannedStartAt: "2026-06-02T08:00:00Z", plannedAt: "2026-06-02T17:00:00Z" }),
      mk({ id: "hydro", parentId: "P", plannedStartAt: "2026-06-03T08:00:00Z", plannedAt: "2026-06-03T17:00:00Z", dependsOn: ["nde"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["hydro", "nde", "weld"]);
    expect(r.ids.has("P")).toBe(false); // a summary is an envelope, never itself on the path
  });

  it("without links only the tasks ending at the finish drive it (and the count of unlinked tasks says so)", () => {
    const ms: Milestone[] = [
      mk({ id: "long", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10") }),
      mk({ id: "short", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02") }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids]).toEqual(["long"]);
    expect(r.linked).toBe(false);
    expect(r.unlinked).toBe(2);
  });

  it("a loop in the links is reported and left out, never followed", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-02"), dependsOn: ["b"] }),
      mk({ id: "b", plannedStartAt: d("2026-03-03"), plannedAt: d("2026-03-04"), dependsOn: ["a"] }),
      mk({ id: "z", plannedStartAt: d("2026-03-01"), plannedAt: d("2026-03-10") }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.cycle?.sort()).toEqual(["a", "b"]);
    expect([...r.ids]).toEqual(["z"]);
  });

  it("a weekly Mon–Fri chain (date-only, FS) is ONE driving chain: every Friday → Monday hand-off drives, zero float throughout", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
      mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2"] }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("mon-fri");
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]); // was ["W3"]: 2 calendar days of "float" at each weekend
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.floatDays.get("W2")).toBe(0);
    expect(r.floatDays.get("W3")).toBe(0);
  });

  it("an MS Project chain (Mon–Fri 08:00–17:00) handed off Fri 17:00 → Mon 08:00 is on the path end to end", () => {
    const ms: Milestone[] = [
      mk({ id: "order", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" }),
      mk({ id: "install", plannedStartAt: "2026-06-08T08:00:00Z", plannedAt: "2026-06-12T17:00:00Z", dependsOn: ["order"] }),
      mk({ id: "test", plannedStartAt: "2026-06-15T08:00:00Z", plannedAt: "2026-06-15T17:00:00Z", dependsOn: ["install"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["install", "order", "test"]); // was ["test"]: 63 calendar hours at each weekend
    // Float still counts the off-shift clock time (no project calendar): 15
    // working hours per Friday-evening-to-Monday-morning hand-off — which is
    // why a driving link is judged on its own gap, not on the float.
    expect(r.floatDays.get("install")).toBe(0.6);
    expect(r.floatDays.get("order")).toBe(1.3);
  });

  it("a genuine working day of float mid-week is still not driving (Wed finish → Fri start)", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-03") }), // Mon–Wed
      mk({ id: "b", plannedStartAt: d("2026-06-05"), plannedAt: d("2026-06-05"), dependsOn: ["a"] }), // Fri
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids]).toEqual(["b"]);
    expect(r.floatDays.get("a")).toBe(1); // Thursday
  });

  it("a completed task still carrying the latest planned date does not empty the path; a finished successor does not constrain", () => {
    const ms: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-03") }),
      mk({ id: "b", plannedStartAt: d("2026-06-04"), plannedAt: d("2026-06-05"), dependsOn: ["a"] }),
      // Final inspection, done early — plan not updated; linked after b.
      mk({ id: "z", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), status: "completed", dependsOn: ["b"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["a", "b"]); // was []: the button and the Report section vanished
    expect(r.floatDays.get("a")).toBe(0);
    expect(r.floatDays.get("b")).toBe(0);
    expect(r.finish).toBe("2026-06-19T00:00:00.000Z"); // the envelope still shows the latest planned finish
    // The same with an ACTUAL finish recorded instead of the status.
    const actual = computeCriticalPath(ms.map((m) => (m.id === "z" ? { ...m, status: "in_progress" as const, actualAt: d("2026-06-05") } : m)));
    expect([...actual.ids].sort()).toEqual(["a", "b"]);
  });

  // Review (third pass) probes: on the Mon–Fri clock both came back with
  // tasks that have real slack at 0 float — [Z, P, Y, X] and [Q, B, A].
  // Sixth pass, restated: P is a Mon–Fri task (Thu–Fri) feeding Z's Monday
  // start; the outage crew's weekend is not P's, so P has no float — P6 and
  // MS Project report it critical (TF 0) on its own calendar. The third to
  // fifth passes gave it the outage's weekend (2 d).
  it("a 7-day outage (Sat → Sun → Mon): the weekend chain drives, and the Friday task feeding the Monday restart is critical too", () => {
    const ms: Milestone[] = [
      mk({ id: "X", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06") }), // Sat
      mk({ id: "Y", plannedStartAt: d("2026-06-07"), plannedAt: d("2026-06-07"), dependsOn: ["X"] }), // Sun
      mk({ id: "Z", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-08"), dependsOn: ["Y", "P"] }), // Mon
      mk({ id: "P", plannedStartAt: d("2026-06-04"), plannedAt: d("2026-06-05") }), // Thu–Fri
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("worked-weekends");
    expect(r.workedWeekendDays).toEqual(["2026-06-06", "2026-06-07"]);
    expect([...r.ids].sort()).toEqual(["P", "X", "Y", "Z"]);
    expect(r.floatDays.get("P")).toBe(0); // was 2 (Saturday and Sunday, the outage crew's)
    expect(r.floatDays.get("X")).toBe(0);
    expect(r.floatDays.get("Y")).toBe(0);
  });

  it("a weekend-only shutdown: the timed Sat → Sun chain drives; an unlinked Saturday-morning job 29 hours before the finish does not", () => {
    const ms: Milestone[] = [
      mk({ id: "A", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-06T17:00:00Z" }),
      mk({ id: "B", plannedStartAt: "2026-06-07T08:00:00Z", plannedAt: "2026-06-07T17:00:00Z", dependsOn: ["A"] }),
      mk({ id: "Q", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-06T12:00:00Z" }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("worked-weekends");
    expect([...r.ids].sort()).toEqual(["A", "B"]);
    expect(r.floatDays.get("Q")).toBe(1.2); // 29 h
    expect(r.floatDays.get("A")).toBe(0.6); // the overnight hand-off, 15 h
    expect(r.floatDays.get("B")).toBe(0);
  });

  it("a lag counts only the weekend days its own link's two tasks work, in the backward pass and the driving test alike", () => {
    const ms: Milestone[] = [
      mk({ id: "X", externalRef: "msp:1", plannedStartAt: d("2026-06-05"), plannedAt: d("2026-06-05") }), // Fri, ready Sat 00:00
      mk({ id: "W", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06"), dependsOn: ["X"] }), // Sat
      // Z waits for W too, but W's Saturday is neither X's nor Z's (sixth
      // pass: it counted as Z's input): +1 working day from Sat 00:00 spends
      // Monday, and Z starts Tue — exactly on it, so X drives Z.
      mk({ id: "Z", externalRef: "msp:2", plannedStartAt: d("2026-06-09"), plannedAt: d("2026-06-09"), dependsOn: ["X", "W"], attributes: { source_links: "FS msp:1 +8h" } }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["X", "Z"]);
    expect(r.floatDays.get("X")).toBe(0); // was 1
    expect(r.floatDays.get("W")).toBe(1); // ready Sun 00:00 → Tue 00:00: Monday
    expect(r.calendar).toBe("mon-fri"); // the path (X, Z: Friday, Tuesday) counts no weekend day
    // Z on the Monday: on X's and Z's clock (Mon–Fri) the +8 h lag from
    // Friday night is not met by Monday 00:00 — a working day short, as P6
    // reports a lag on the predecessor's calendar.
    const tight = computeCriticalPath(ms.map((m) => (m.id === "Z" ? { ...m, plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-08") } : m)));
    expect([...tight.ids].sort()).toEqual(["W", "X", "Z"]);
    expect(tight.floatDays.get("X")).toBe(-1); // was 0: W's Saturday paid the lag
    expect(tight.calendar).toBe("worked-weekends"); // W, on the path, works its Saturday
    expect(tight.workedWeekendDays).toEqual(["2026-06-06"]);
    // With the Saturday job done, nobody works that Saturday: the lag spends
    // Monday, and the Tuesday start is exactly on it.
    const idle = computeCriticalPath(ms.map((m) => (m.id === "W" ? { ...m, status: "completed" as const } : m)));
    expect(idle.calendar).toBe("mon-fri");
    expect([...idle.ids].sort()).toEqual(["X", "Z"]);
    expect(idle.floatDays.get("X")).toBe(0);
    // A Saturday job that Z does NOT wait for (a sibling after X) is not on
    // Z's clock: the lag spends Monday and X drives Z.
    const sibling = computeCriticalPath(ms.map((m) => (m.id === "Z" ? { ...m, dependsOn: ["X"] } : m)));
    expect([...sibling.ids].sort()).toEqual(["X", "Z"]);
    expect(sibling.floatDays.get("X")).toBe(0);
  });

  it("only UNFINISHED weekend work switches the clock: a completed Saturday task leaves a weekday chain on Mon–Fri", () => {
    const ms: Milestone[] = [
      mk({ id: "S", plannedStartAt: d("2026-05-30"), plannedAt: d("2026-05-30"), status: "completed" }), // Sat, done
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05"), dependsOn: ["S"] }),
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("mon-fri");
    expect([...r.ids].sort()).toEqual(["W1", "W2"]);
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.workedWeekendDays).toEqual([]);
    expect(pathCalendarLabel(r.calendar)).toBe("working days Mon–Fri");
    expect(pathCalendarLabel("worked-weekends", 2)).toBe("working days Mon–Fri, plus the 2 weekend days with work planned on them");
    expect(pathCalendarLabel("worked-weekends", 1)).toBe("working days Mon–Fri, plus the 1 weekend day with work planned on it");
  });

  // Review (fourth pass) probes: with the week inferred for the whole plan,
  // one unrelated unfinished Saturday task turned each of these into its last
  // week only — [W3] (W1 at 4 d of float, W2 at 2 d) and [test] (5.3 d, 2.6 d).
  it("one unrelated Saturday job does not break a Mon–Fri chain: every Friday → Monday hand-off still drives", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
      mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2"] }),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06") }), // Sat: overtime, a cutover — unlinked
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]);
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.floatDays.get("W2")).toBe(0);
    expect(r.floatDays.get("W3")).toBe(0);
    // S is weighed against the finish: ready Sun 06-07, ten weekdays before it.
    expect(r.floatDays.get("S")).toBe(10);
    // The chain was measured Mon–Fri, and the captions say so (fifth pass:
    // they counted S's Saturday, which no hand-off of the chain uses).
    expect(r.calendar).toBe("mon-fri");
    expect(r.workedWeekendDays).toEqual([]);
  });

  it("one unrelated 4-hour Saturday task does not break an MS Project chain (Fri 17:00 → Mon 08:00 hand-offs)", () => {
    const ms: Milestone[] = [
      mk({ id: "order", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" }),
      mk({ id: "install", plannedStartAt: "2026-06-08T08:00:00Z", plannedAt: "2026-06-12T17:00:00Z", dependsOn: ["order"] }),
      mk({ id: "test", plannedStartAt: "2026-06-15T08:00:00Z", plannedAt: "2026-06-15T17:00:00Z", dependsOn: ["install"] }),
      mk({ id: "S", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-06T12:00:00Z" }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("mon-fri"); // the chain's clock; S's Saturday is off it
    expect([...r.ids].sort()).toEqual(["install", "order", "test"]);
    expect(r.floatDays.get("install")).toBe(0.6); // as with no Saturday task at all
    expect(r.floatDays.get("order")).toBe(1.3);
  });

  it("a Saturday task linked INTO the chain works that Saturday for it, and the chain stays whole through it", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06"), dependsOn: ["W1"] }), // Sat
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["S"] }),
      mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2"] }),
      // A parallel Friday task feeding W2.
      mk({ id: "F", plannedStartAt: d("2026-06-05"), plannedAt: d("2026-06-05") }),
    ];
    const withF = ms.map((m) => (m.id === "W2" ? { ...m, dependsOn: ["S", "F"] } : m));
    const r = computeCriticalPath(withF);
    expect([...r.ids].sort()).toEqual(["F", "S", "W1", "W2", "W3"]);
    for (const id of ["W1", "S", "W2", "W3"]) expect(r.floatDays.get(id)).toBe(0);
    // F (a Friday task) feeding W2 (Monday) is critical: S's Saturday is not
    // F's or W2's (sixth pass: W2's clock counted it, F had 1 d).
    expect(r.floatDays.get("F")).toBe(0);
    expect(r.calendar).toBe("worked-weekends");
    expect(r.workedWeekendDays).toEqual(["2026-06-06"]);
  });

  it("a long task whose both ends fall on weekdays marks no weekend day (a Mon → Wed task over a weekend)", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
      mk({ id: "L", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-10") }), // Mon → Wed, spans 06-06/07
      mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2", "L"] }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.calendar).toBe("mon-fri");
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]);
    expect(r.floatDays.get("L")).toBe(2); // Thursday and Friday
  });

  // Review (fifth pass) probes: per linked network, a weekend job broke the
  // chain whenever it was linked anywhere into the chain's network — at
  // 830bcdb these gave [W2, W3], [W2, W3], [FIN, W3, W2] and [FIN, W2, W3].
  const weeks = (): Milestone[] => [
    mk({ id: "W1", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
    mk({ id: "W2", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["W1"] }),
    mk({ id: "W3", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["W2"] }),
  ];
  it("(a) a Saturday delivery feeding week 3 does not cut week 1 off the chain", () => {
    const ms = [
      ...weeks().map((m) => (m.id === "W3" ? { ...m, dependsOn: ["W2", "S"] } : m)),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06") }), // Sat
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]);
    expect(r.floatDays.get("W1")).toBe(0); // was 1
    expect(r.floatDays.get("S")).toBe(5); // ready Sun 06-07; W3 starts Mon 06-15
    expect(r.calendar).toBe("mon-fri");
  });
  it("(b) a COMPLETED start milestone linked to the chain and to a Saturday job does not join their clocks", () => {
    const ms = [
      mk({ id: "M0", plannedStartAt: d("2026-05-29"), plannedAt: d("2026-05-29"), status: "completed" }),
      ...weeks().map((m) => (m.id === "W1" ? { ...m, dependsOn: ["M0"] } : m)),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06"), dependsOn: ["M0"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["W1", "W2", "W3"]);
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.floatDays.get("S")).toBe(10);
  });
  it("(c) a DCMA-linked plan (start milestone → chain → finish milestone, start → Saturday job → finish) keeps the whole chain", () => {
    const ms = [
      mk({ id: "M0", plannedStartAt: d("2026-05-29"), plannedAt: d("2026-05-29") }), // Fri
      ...weeks().map((m) => (m.id === "W1" ? { ...m, dependsOn: ["M0"] } : m)),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-06"), dependsOn: ["M0"] }),
      mk({ id: "FIN", plannedStartAt: d("2026-06-22"), plannedAt: d("2026-06-22"), dependsOn: ["W3", "S"] }), // Mon
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["FIN", "M0", "W1", "W2", "W3"]);
    for (const id of ["M0", "W1", "W2", "W3", "FIN"]) expect(r.floatDays.get(id)).toBe(0);
    // FIN's clock works S's Saturday, but no hand-off of the chain spans it.
    expect(r.floatDays.get("S")).toBe(10);
    expect(r.calendar).toBe("mon-fri");
  });
  it("(d) an MS Project chain plus a Friday night shift (22:00 → Sat 06:00) linked into the finish milestone keeps the whole chain", () => {
    const ms: Milestone[] = [
      mk({ id: "W1", plannedStartAt: "2026-06-01T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" }),
      mk({ id: "W2", plannedStartAt: "2026-06-08T08:00:00Z", plannedAt: "2026-06-12T17:00:00Z", dependsOn: ["W1"] }),
      mk({ id: "W3", plannedStartAt: "2026-06-15T08:00:00Z", plannedAt: "2026-06-19T17:00:00Z", dependsOn: ["W2"] }),
      mk({ id: "N", plannedStartAt: "2026-06-05T22:00:00Z", plannedAt: "2026-06-06T06:00:00Z" }),
      mk({ id: "T", plannedStartAt: "2026-06-08T22:00:00Z", plannedAt: "2026-06-09T06:00:00Z", dependsOn: ["N"] }),
      mk({ id: "FIN", plannedStartAt: "2026-06-19T17:00:00Z", plannedAt: "2026-06-19T17:00:00Z", dependsOn: ["W3", "T"] }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["FIN", "W1", "W2", "W3"]);
    expect(r.floatDays.get("W2")).toBe(0.6); // 15 h, as with no night shift
    expect(r.floatDays.get("W1")).toBe(1.3); // was 2.3
    expect(r.calendar).toBe("mon-fri");
  });
  it("weekend work that feeds the SAME successor gives its weekday predecessor no float (the fifth pass's outage rule, withdrawn)", () => {
    // W2 (Mon) waits for W1 (Mon–Fri) and for a weekend job S (Sat → Sun).
    // W1 runs Mon–Fri: if it slips a working day, W2 slips. The fifth pass
    // gave W1 the weekend as float (2 d) and took it off the path.
    const ms = [
      ...weeks().map((m) => (m.id === "W2" ? { ...m, dependsOn: ["W1", "S"] } : m)),
      mk({ id: "S", plannedStartAt: d("2026-06-06"), plannedAt: d("2026-06-07") }),
    ];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["S", "W1", "W2", "W3"]);
    expect(r.floatDays.get("W1")).toBe(0);
    expect(r.floatDays.get("S")).toBe(0);
    expect(r.workedWeekendDays).toEqual(["2026-06-06", "2026-06-07"]);
  });

  // Review (sixth pass) probe: on the successor's inputs' clock this gave
  // [S, W5], W1–W4 at 1 d of float each ("plus the 1 weekend day").
  it("a Saturday delivery the weekend before the install week does not take the Mon–Fri chain behind it off the path", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    const mon = Date.UTC(2026, 5, 1);
    const W = [0, 1, 2, 3, 4].map((w) => mk({ id: `W${w + 1}`, plannedStartAt: at(mon + w * 7 * DAY_MS), plannedAt: at(mon + w * 7 * DAY_MS + 4 * DAY_MS), dependsOn: w ? [`W${w}`] : [] }));
    const sat = mon + 3 * 7 * DAY_MS + 5 * DAY_MS; // Sat Jun 27
    const ms = [...W.map((m) => (m.id === "W5" ? { ...m, dependsOn: ["W4", "S"] } : m)), mk({ id: "S", plannedStartAt: at(sat), plannedAt: at(sat) })];
    const r = computeCriticalPath(ms);
    expect([...r.ids].sort()).toEqual(["S", "W1", "W2", "W3", "W4", "W5"]);
    for (const id of ["W1", "W2", "W3", "W4", "W5", "S"]) expect(r.floatDays.get(id)).toBe(0);
    expect(r.workedWeekendDays).toEqual(["2026-06-27"]); // S's own Saturday, on the path
    const without = computeCriticalPath(W);
    expect([...without.ids].sort()).toEqual(["W1", "W2", "W3", "W4", "W5"]);
    expect(without.calendar).toBe("mon-fri");
  });

  it("a weekend crew's overnight counts both crews' days; a weekday task into a Sunday start counts the Sunday morning only", () => {
    // A (Sat 08–17) → B (Sun 08–17): the rest of A's Saturday and B's Sunday
    // morning, 15 h. F (Fri 08–17) → B: F's Friday evening and B's Sunday
    // morning, 15 h; F's calendar has no Saturday.
    const ms: Milestone[] = [
      mk({ id: "A", plannedStartAt: "2026-06-06T08:00:00Z", plannedAt: "2026-06-06T17:00:00Z" }),
      mk({ id: "F", plannedStartAt: "2026-06-05T08:00:00Z", plannedAt: "2026-06-05T17:00:00Z" }),
      mk({ id: "B", plannedStartAt: "2026-06-07T08:00:00Z", plannedAt: "2026-06-07T17:00:00Z", dependsOn: ["A", "F"] }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.floatDays.get("A")).toBe(0.6);
    expect(r.floatDays.get("F")).toBe(0.6);
    expect([...r.ids].sort()).toEqual(["A", "B", "F"]);
  });

  // PT SCH-4 (sixth pass): the link check, the cascade and the path read a
  // task linked to its own phase the same way — a loop. The path read it as
  // "waits for every sibling", so one such task was analysed and two were
  // reported as a loop of each other.
  it("a task linked to a phase it sits in is a loop — reported and left out, as the link check and the cascade read it", () => {
    const phase = (deps: Record<string, string[]>): Milestone[] => [
      mk({ id: "P", isSummary: true, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "t1", parentId: "P", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-02"), dependsOn: deps.t1 ?? [] }),
      mk({ id: "t2", parentId: "P", plannedStartAt: d("2026-06-03"), plannedAt: d("2026-06-05"), dependsOn: deps.t2 ?? [] }),
      mk({ id: "S", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-09"), dependsOn: ["P"] }),
    ];
    const one = computeCriticalPath(phase({ t1: ["P"] }));
    // Was null: t1 read as waiting for t2. Only t1 is in the loop: S, the
    // finish, waits for all of P and keeps its place, driven by t2 (seventh
    // review pass: S was left out with the loop, and the path read [t2]).
    expect(one.cycle).toEqual(["t1"]);
    expect(one.floatDays.has("t1")).toBe(false);
    expect([...one.ids].sort()).toEqual(["S", "t2"]);
    expect(one.floatDays.get("S")).toBe(0);
    const nodes = reflowNodesFromMilestones(phase({}));
    expect(linkCyclePath(nodes, "t1", "P")).toEqual(["t1", "P", "t1"]);
    expect(() => planCascade(reflowNodesFromMilestones(phase({ t1: ["P"] })), ["t2"])).toThrow(CascadeRefusedError);
    const two = computeCriticalPath(phase({ t1: ["P"], t2: ["P"] }));
    expect(two.cycle?.sort()).toEqual(["t1", "t2"]); // the two wait for each other; S is not a member
    expect([...two.ids]).toEqual(["S"]);
    // A phase linked to a task inside it is the same loop.
    const back = computeCriticalPath(phase({}).map((m) => (m.id === "P" ? { ...m, dependsOn: ["t1"] } : m)));
    expect(back.cycle).toEqual(["t1"]);
    expect([...back.ids].sort()).toEqual(["S", "t2"]);
  });

  // Review (seventh pass) probe: Kahn's leftover — the loop AND everything
  // after it in link order — was reported as the loop and left out, so one
  // task linked to its own phase took every later phase off the path: ids
  // [t2], cycle [t1, q1, q2, R], while the finish is R on Jun 26.
  it("a loop upstream leaves out its members only: every leaf downstream keeps its place on the path", () => {
    const plan = (t1Deps: string[]): Milestone[] => [
      mk({ id: "P", isSummary: true, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "t1", parentId: "P", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-02"), dependsOn: t1Deps }),
      mk({ id: "t2", parentId: "P", plannedStartAt: d("2026-06-03"), plannedAt: d("2026-06-05") }),
      mk({ id: "Q", isSummary: true, plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-19"), dependsOn: ["P"] }),
      mk({ id: "q1", parentId: "Q", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12") }),
      mk({ id: "q2", parentId: "Q", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["q1"] }),
      mk({ id: "R", plannedStartAt: d("2026-06-22"), plannedAt: d("2026-06-26"), dependsOn: ["Q"] }),
    ];
    const r = computeCriticalPath(plan(["P"]));
    expect(r.cycle).toEqual(["t1"]);
    expect([...r.ids].sort()).toEqual(["R", "q1", "q2", "t2"]);
    for (const id of ["R", "q1", "q2", "t2"]) expect(r.floatDays.get(id)).toBe(0);
    const without = computeCriticalPath(plan([]));
    expect(without.cycle).toBeNull();
    expect([...without.ids].sort()).toEqual(["R", "q1", "q2", "t2"]); // the same path as with the loop
    // A plain loop of task links upstream is the same: a ↔ b, b → c → d.
    const plain: Milestone[] = [
      mk({ id: "a", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-02"), dependsOn: ["b"] }),
      mk({ id: "b", plannedStartAt: d("2026-06-03"), plannedAt: d("2026-06-05"), dependsOn: ["a"] }),
      mk({ id: "c", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-12"), dependsOn: ["b"] }),
      mk({ id: "e", plannedStartAt: d("2026-06-15"), plannedAt: d("2026-06-19"), dependsOn: ["c"] }),
    ];
    const pl = computeCriticalPath(plain);
    expect(pl.cycle?.sort()).toEqual(["a", "b"]);
    expect([...pl.ids].sort()).toEqual(["c", "e"]);
  });

  it("a loop through a FINISHED task is no loop for the path (a done task gates nothing and waits for nothing)", () => {
    const ms: Milestone[] = [
      mk({ id: "P", isSummary: true, plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-05") }),
      mk({ id: "t1", parentId: "P", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-02"), dependsOn: ["P"], status: "completed" }),
      mk({ id: "t2", parentId: "P", plannedStartAt: d("2026-06-03"), plannedAt: d("2026-06-05") }),
      mk({ id: "S", plannedStartAt: d("2026-06-08"), plannedAt: d("2026-06-09"), dependsOn: ["P"] }),
      // x (done) and y wait for each other.
      mk({ id: "x", plannedStartAt: d("2026-06-01"), plannedAt: d("2026-06-01"), dependsOn: ["y"], actualAt: d("2026-06-01") }),
      mk({ id: "y", plannedStartAt: d("2026-06-02"), plannedAt: d("2026-06-09"), dependsOn: ["x"] }),
    ];
    const r = computeCriticalPath(ms);
    expect(r.cycle).toBeNull();
    expect([...r.ids].sort()).toEqual(["S", "t2", "y"]);
  });

  it("empty-safe", () => {
    const r = computeCriticalPath([]);
    expect(r.ids.size).toBe(0);
    expect(r.finish).toBeNull();
    expect(r.calendar).toBe("mon-fri");
  });
});

describe("the working clock the critical path measures on (scheduleReflow)", () => {
  const t = (iso: string) => Date.parse(iso);
  it("stops over the weekend: Sat and Sun read as the Monday 00:00 after them", () => {
    expect(workingTimeMs(t("2026-06-06T00:00:00Z"))).toBe(workingTimeMs(t("2026-06-08T00:00:00Z")));
    expect(workingTimeMs(t("2026-06-07T13:30:00Z"))).toBe(workingTimeMs(t("2026-06-08T00:00:00Z")));
    expect(workingGapMs(t("2026-06-01T00:00:00Z"), t("2026-06-08T00:00:00Z"))).toBe(5 * DAY_MS);
  });
  it("Fri 17:00 → Mon 08:00 is 15 working hours; the gap is signed", () => {
    expect(workingGapMs(t("2026-06-05T17:00:00Z"), t("2026-06-08T08:00:00Z"))).toBe(15 * 3_600_000);
    expect(workingGapMs(t("2026-06-08T08:00:00Z"), t("2026-06-05T17:00:00Z"))).toBe(-15 * 3_600_000);
  });
  it("any seven calendar days hold five working days, wherever they start (before 1970 too)", () => {
    for (const iso of ["2026-06-03T09:15:00Z", "2026-06-06T00:00:00Z", "2026-06-07T23:59:00Z", "1969-12-31T12:00:00Z"]) {
      expect(workingGapMs(t(iso), t(iso) + 7 * DAY_MS)).toBe(5 * DAY_MS);
    }
  });
  it("lagWorkingMs is the working-clock length afterLagMs walks (a lag from any weekday or date-only ready instant; a lead from a date-only one)", () => {
    expect(lagWorkingMs(40)).toBe(5 * DAY_MS);
    expect(lagWorkingMs(-8)).toBe(-DAY_MS);
    expect(lagWorkingMs(12)).toBe(DAY_MS + 4 * 3_600_000);
    expect(lagWorkingMs(null)).toBe(0);
    for (const iso of ["2026-06-01T00:00:00Z", "2026-06-03T17:00:00Z", "2026-06-05T17:00:00Z", "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z"]) {
      for (const lag of [8, 16, 40, 120]) expect(workingGapMs(t(iso), afterLagMs(t(iso), lag))).toBe(lagWorkingMs(lag));
    }
    for (const iso of ["2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z", "2026-06-10T00:00:00Z"]) {
      for (const lag of [-8, -16, -40, -120]) expect(workingGapMs(t(iso), afterLagMs(t(iso), lag))).toBe(lagWorkingMs(lag));
    }
  });
});
