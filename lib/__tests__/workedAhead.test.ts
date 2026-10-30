// What the user found missing: work done early and progress made on the
// shift must show; at the turnover, work due by the shift's end carries
// over; and done-early is said as a fact of the plan.

import { describe, it, expect } from "vitest";
import { buildShiftReport, shiftWindow } from "@/lib/shiftReport";
import { scheduleAt } from "@/lib/progressHistory";
import { turnoverUpdate } from "@/lib/managementUpdate";
import { toPlainText } from "@/lib/reportExport";
import { applyNightStaffing } from "@/lib/nightStaffing";
import type { Milestone } from "@/types/schema";

const CHI = "America/Chicago";
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-05:00`)).toISOString();
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = { D: (x: number) => new Date(x).toISOString().slice(5, 10), DTs: (x: number) => new Date(x).toISOString().slice(5, 16), T: (x: number) => new Date(x).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };
const day = shiftWindow("2026-10-26", "day", CHI); // 05:30–17:30

const e17 = mk({ id: "e17", name: "E-17 Exchanger" });
// Planned today, moved 0 → 40 during the day.
const pull = mk({ id: "pb", name: "Pull bundle", parentId: "e17", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "16:00"), durationHours: 8, status: "in_progress", percentComplete: 40, responsibleParty: "Schultz" });
// Planned TOMORROW, done today (worked ahead).
const remove = mk({ id: "rc", name: "Remove components", parentId: "e17", plannedStartAt: at("2026-10-27", "08:00"), plannedAt: at("2026-10-27", "12:00"), durationHours: 4, status: "completed", percentComplete: 100, actualAt: at("2026-10-26", "15:00") });
// Planned TOMORROW, 30% today (partial early work).
const hydro = mk({ id: "hy", name: "Hydroblast", parentId: "e17", plannedStartAt: at("2026-10-28", "06:00"), plannedAt: at("2026-10-28", "12:00"), durationHours: 6, status: "in_progress", percentComplete: 30 });
const all = [e17, pull, remove, hydro];
const log = [
  { milestone_id: "pb", at: at("2026-10-26", "10:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 40 },
  { milestone_id: "rc", at: at("2026-10-26", "15:00"), old_status: "planned", old_percent: 0, new_status: "completed", new_percent: 100 },
  { milestone_id: "hy", at: at("2026-10-26", "16:00"), old_status: "planned", old_percent: 0, new_status: "in_progress", new_percent: 30 },
  { milestone_id: "e17", at: at("2026-10-20", "00:00"), old_status: null, old_percent: null, new_status: "planned", new_percent: 0 },
] as const;
const startPct = new Map(scheduleAt(all, [...log].sort((a, b) => a.at.localeCompare(b.at)) as never, day.start).milestones.map((m) => [m.id!, m.percentComplete ?? 0]));

describe("work done early and progress made show on the turnover", () => {
  const r = buildShiftReport({ milestones: all, tz: CHI, shift: day, now: day.end, startPct });
  it("knows what moved this shift, from where", () => {
    expect(r.review.knownStart).toBe(true);
    expect(r.review.progressed.map((x) => [x.leaf.id, x.pctStart, x.percent])).toEqual([["pb", 0, 40], ["hy", 0, 30]]);
  });
  it("work planned for later that was done or moved is ahead of plan", () => {
    expect(r.review.ahead.map((x) => x.leaf.id).sort()).toEqual(["hy", "rc"]);
    expect(r.review.done.map((x) => x.leaf.id)).toContain("rc");
  });
  it("the email says so: ahead, planned when, and what moved this shift - each step once", () => {
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r, f, { pctOf: () => 40, finishOf: () => undefined }) });
    expect(text).toMatch(/DONE - DAY SHIFT/);
    // One row for E-17: everything the shift did on it — finished AND in
    // progress (the bundle pulled to 40% gets its credit), and the hours.
    const doneSec = text.slice(text.search(/^DONE - /m), text.search(/^NEXT - |^CARRIES /m));
    // Still going: where it stands against the plan, and the task's hours
    // with it (+5.8 early, −4.8 behind on the bundle pull).
    expect(doneSec).toMatch(/E-17 Exchanger - Last done: Remove components; In progress: Hydroblast \(30%\) \(\+1 more going\) · Schultz · Behind plan, Pull bundle: plan had 100% by now · \+1 h/);
    // Unfinished and due: it carries — where it stands, and its own hours on its own row.
    expect(text).toMatch(/Pull bundle · Schultz · was due 10-26T21:00 · done 40% · −4.8 h/);
    // Why it's ahead: both early steps, with the hours each is worth.
    // No bottom-line box: the numbers, and each step's hours in "vs plan".
    expect(text).not.toMatch(/BOTTOM LINE/);
    expect(text).toMatch(/Work ahead: 1 h/);
    // Carries over to the next day shift, dated: Mon's day shift → Tue.
    expect(text).toMatch(/^CARRIES OVER TO DAY SHIFT - 10-27/m);
    // The 40% counts: an 8 h pull the plan has done by now, 40% done → 4.8 h behind, not 8.
    expect(text).toMatch(/Pull bundle · .* · done 40% · −4.8 h/);
    // Every % reads as where it is now — never "0% → 25%".
    expect(text).not.toMatch(/% → /);
    // One row per task under Done: its last step, and the count.
    expect(doneSec.match(/E-17 Exchanger/g)?.length).toBe(1);
  });
  it("without the record of the shift's start, later work with progress still shows - as entered", () => {
    const r2 = buildShiftReport({ milestones: all, tz: CHI, shift: day, now: day.end });
    expect(r2.review.knownStart).toBe(false);
    expect(r2.review.ahead.map((x) => x.leaf.id).sort()).toEqual(["hy", "rc"]);
    const text = toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(r2, f, { pctOf: () => 40, finishOf: () => undefined }) });
    expect(text).toMatch(/E-17 Exchanger - Last done: Remove components; In progress: Hydroblast \(30%\) · Done early, planned 10-27T13:00/);
    expect(text).not.toMatch(/% → /); // where it is now — never a "0% → …" to puzzle out
  });
});

describe("at the turnover meeting, work due by the shift's end carries over", () => {
  // Day shift ends 17:30; the meeting is at 17:00. A day step due 17:30 at 25%.
  const behind = mk({ id: "b", name: "Pull bundle E-12", plannedStartAt: at("2026-10-26", "13:30"), plannedAt: at("2026-10-26", "17:30"), durationHours: 4, status: "in_progress", percent: 25, percentComplete: 25 } as never);
  it("mid-shift it's still the shift's; at the meeting it carries to the next day shift", () => {
    const mid = buildShiftReport({ milestones: [behind], tz: CHI, shift: day, now: Date.parse(at("2026-10-26", "15:00")) });
    expect(mid.review.carryOver).toEqual([]);
    const meeting = buildShiftReport({ milestones: [behind], tz: CHI, shift: day, now: Date.parse(at("2026-10-26", "17:05")) });
    expect(meeting.review.carryOver.map((x) => x.leaf.id)).toEqual(["b"]);
    expect(meeting.goals.otherShift.map((x) => x.leaf.id)).toEqual(["b"]);   // the night report hands it to days
  });
});

describe("with night crews set, PSV and calibration aren't handed to nights", () => {
  const tower = mk({ id: "v7", name: "V-7" });
  const manways = mk({ id: "mw", name: "Open internal manways", parentId: "v7", plannedStartAt: at("2026-10-26", "05:30"), plannedAt: at("2026-10-28", "17:30"), shift: "swing" });
  const psvs = mk({ id: "ps", name: "PSVs" });
  const psv = mk({ id: "p21", name: "PSV-021 swap", parentId: "ps", plannedStartAt: at("2026-10-26", "15:00"), plannedAt: at("2026-10-26", "23:00"), durationHours: 8, status: "in_progress", percentComplete: 25, responsibleParty: "Maintenance (KE)" });
  const meter = mk({ id: "ut", name: "UIT-013" });
  const cal = mk({ id: "ca", name: "Calibrate equipment", parentId: "ut", plannedStartAt: at("2026-10-26", "10:00"), plannedAt: at("2026-10-29", "03:00"), status: "in_progress", percentComplete: 45, attributes: { work_hours: "00:00-24:00" } });
  const ms = applyNightStaffing([tower, manways, psvs, psv, meter, cal], ["v7"]);
  it("the night list has the tower only; PSV and calibration carry to days", () => {
    const r = buildShiftReport({ milestones: ms, tz: CHI, shift: day, now: Date.parse(at("2026-10-26", "17:05")) });
    expect(r.goals.all.map((x) => x.leaf.id)).toEqual(["mw"]);
    const toDays = [...r.goals.otherShift, ...r.goals.movedOff, ...r.goals.paused].map((x) => x.leaf.id).sort();
    expect(toDays).toEqual(["ca", "p21"]);
  });
});

describe("ahead or behind is explained, and adds up", () => {
  const r = buildShiftReport({ milestones: all, tz: CHI, shift: day, now: day.end, startPct });
  it("the steps ahead less the steps behind are exactly the gap", () => {
    const d = r.overall.drivers;
    expect(Math.round((d.behindHours - d.aheadHours) * 10) / 10).toBe(r.goals.gapHours);
    expect(d.ahead.map((x) => x.id)).toEqual(expect.arrayContaining(["rc", "hy"]));
    expect(d.ahead.find((x) => x.id === "rc")).toMatchObject({ percent: 100, planPct: 0, hours: 4 });
  });
  it("a step finished this shift with no finish time recorded is still done this shift (the log says it was open)", () => {
    const noTime = all.map((m) => (m.id === "rc" ? { ...m, actualAt: undefined } : m));
    const r2 = buildShiftReport({ milestones: noTime, tz: CHI, shift: day, now: day.end, startPct });
    expect(r2.review.done.map((x) => x.leaf.id)).toContain("rc");
    // …but one already done when the shift began is not this shift's news.
    const before = new Map(startPct); before.set("rc", 100);
    const r3 = buildShiftReport({ milestones: noTime, tz: CHI, shift: day, now: day.end, startPct: before });
    expect(r3.review.done.map((x) => x.leaf.id)).not.toContain("rc");
  });
});

describe("the bottom line names jobs by their tag", () => {
  it("a long equipment name shortens to its tag", async () => {
    const { equipmentTag } = await import("@/lib/safetyMoment");
    expect(equipmentTag("E-17 - Transmix Feed/Trans. Diesel Exchanger No. 1", "Pull Bundle")).toBe("E-17");
  });
});

describe("crews box", () => {
  it("names a step with no crew on it, so the missing crew can be filled in", async () => {
    const { crewsOf, turnoverPlan } = await import("@/lib/turnoverPlan");
    const noCrew = mk({ id: "nc", name: "Set blinds", parentId: "e17", plannedStartAt: at("2026-10-26", "08:00"), plannedAt: at("2026-10-26", "10:00"), durationHours: 2, status: "completed", percentComplete: 100 });
    const r3 = buildShiftReport({ milestones: [...all, noCrew], tz: CHI, shift: day, now: day.end, startPct });
    const cr = crewsOf(r3, turnoverPlan(r3, () => false), (h) => `${h} h`);
    const row = cr.worked.find((x) => x.crew === "No crew named")!;
    // The count stays short (fits beside the name on a phone); the steps go under the name.
    expect(row.text).toBe("2 of 3 done");
    expect(row.note).toContain("E-17 Exchanger: Set blinds");
    expect(row.note).toMatch(/no responsible party set$/);
  });
});

describe("crews box on a phone", () => {
  it("counts read short and never wrap: '12 of 15 done', non-breaking spaces", async () => {
    const { toEmailHtml } = await import("@/lib/reportExport");
    const html = toEmailHtml({ kind: "k", project: "p", when: "w", asOf: "a", sections: [{ title: "Crews", blocks: [{ k: "columns", cols: [{ title: "Day", rows: [{ title: "Schultz", value: "12 of 15 done" }] }] }] }] });
    expect(html).toContain("12&nbsp;of&nbsp;15&nbsp;done");
  });
});

describe("a step finished on an earlier shift and marked done again isn't this shift's work", () => {
  // Done Sunday; a second "done" tap Monday re-stamped its finish time
  // without a status change (so no log row).
  const rc = mk({ id: "rc2", name: "Remove components", parentId: "e17", plannedStartAt: at("2026-10-25", "08:00"), plannedAt: at("2026-10-25", "12:00"), durationHours: 4, status: "completed", percentComplete: 100, actualAt: at("2026-10-26", "15:27") });
  const ms2 = [e17, rc];
  const log2 = [{ milestone_id: "rc2", at: at("2026-10-25", "16:58"), old_status: "in_progress", old_percent: 50, new_status: "completed", new_percent: 100 }];
  const start2 = new Map(scheduleAt(ms2, log2 as never, day.start).milestones.map((m) => [m.id!, m.status === "completed" ? 100 : m.percentComplete ?? 0]));
  it("the log has it done before the shift began, so it isn't under Done", () => {
    expect(start2.get("rc2")).toBe(100);
    const r = buildShiftReport({ milestones: ms2, tz: CHI, shift: day, now: day.end, startPct: start2 });
    expect(r.review.done.map((x) => x.leaf.id)).not.toContain("rc2");
  });
  it("finished on the shift, it still is", () => {
    const fresh = [{ ...log2[0], at: at("2026-10-26", "15:27") }];
    const s = new Map(scheduleAt(ms2, fresh as never, day.start).milestones.map((m) => [m.id!, m.status === "completed" ? 100 : m.percentComplete ?? 0]));
    expect(s.get("rc2")).toBe(50);
    const r = buildShiftReport({ milestones: ms2, tz: CHI, shift: day, now: day.end, startPct: s });
    expect(r.review.done.map((x) => x.leaf.id)).toContain("rc2");
  });
});
