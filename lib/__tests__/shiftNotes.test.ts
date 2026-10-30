// The shift notes squeezed into the turnover: the time each step was done
// (on or off), where the whole task stands, why a step is behind, each
// crew's supervisor and head count, safety incidents, notes & actions —
// and the separate time log.

import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import { buildShiftReport, parseClock, shiftWindow, timeInShift, type ShiftTimes } from "@/lib/shiftReport";
import { turnoverUpdate, crewLine } from "@/lib/managementUpdate";
import { toEmailHtml, toPlainText } from "@/lib/reportExport";
import { compareShiftKeys, lastSameKind, openFollowUps, type ShiftRecord } from "@/lib/shiftRecord";
import { buildTimeLog, describeChange } from "@/lib/timeLog";
import type { Milestone, MilestoneNote } from "@/types/schema";

const LA = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00" };
const at = (d: string, hm: string) => new Date(Date.parse(`${d}T${hm}:00-07:00`)).toISOString();
const t = (d: string, hm: string) => Date.parse(at(d, hm));
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone =>
  ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", ...p } as Milestone);
const f = { D: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 10), DTs: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(5, 16), T: (x: number) => new Date(x - 7 * 3600e3).toISOString().slice(11, 16), win: () => "", hrs: (h: number) => `${h} h` };
const day = shiftWindow("2026-10-27", "day", LA, times);

describe("the time you put in", () => {
  it("reads 24-hour, with or without the colon", () => {
    expect(parseClock("14:30")).toEqual({ h: 14, m: 30 });
    expect(parseClock("1430")).toEqual({ h: 14, m: 30 });
    expect(parseClock("930")).toEqual({ h: 9, m: 30 });
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("2:5")).toBeNull();
  });
  it("lands on the shift - a night shift's small hours are the next morning", () => {
    expect(timeInShift(day, "14:30", LA)).toBe(t("2026-10-27", "14:30"));
    expect(timeInShift(day, "19:00", LA)).toBeNull(); // not on a 6–18 day shift
    const night = shiftWindow("2026-10-27", "night", LA, times);
    expect(timeInShift(night, "02:15", LA)).toBe(t("2026-10-28", "02:15"));
    expect(timeInShift(night, "22:00", LA)).toBe(t("2026-10-27", "22:00"));
    expect(timeInShift(night, "12:00", LA)).toBeNull();
  });
});

describe("the shift's own record", () => {
  const recs = new Map<string, ShiftRecord>([
    ["2026-10-26:day", { crews: { Ancon: { supervisor: "J. Rodriguez", headcount: 8 } }, notes: [{ id: "n1", at: t("2026-10-26", "11:00"), text: "Gaskets not on site", followUp: true }] }],
    ["2026-10-26:night", { crews: { Ancon: { headcount: 6 } }, notes: [{ id: "n2", at: t("2026-10-26", "23:00"), text: "Cleared one", followUp: true, cleared: { at: 1 } }] }],
    ["2026-10-27:day", {}],
  ]);
  it("orders shifts: day before night, then the next day", () => {
    expect(["2026-10-27:day", "2026-10-26:night", "2026-10-26:day"].sort(compareShiftKeys)).toEqual(["2026-10-26:day", "2026-10-26:night", "2026-10-27:day"]);
  });
  it("suggests the last same shift's supervisors and head counts", () => {
    expect(lastSameKind(recs, "2026-10-27:day")?.key).toBe("2026-10-26:day");
    expect(lastSameKind(recs, "2026-10-27:night")?.crews.Ancon.headcount).toBe(6);
  });
  it("keeps open follow-ups on later reports until cleared", () => {
    const open = openFollowUps(recs, "2026-10-27:day");
    expect(open.map((n) => n.text)).toEqual(["Gaskets not on site"]);
    expect(open[0].shiftKey).toBe("2026-10-26:day");
  });
  it("says a crew as supervisor and head count, '-' when nothing's entered", () => {
    expect(crewLine({ supervisor: "Mike Leonard", headcount: 6 })).toBe("Mike Leonard · 6 on site");
    expect(crewLine({ headcount: 0 })).toBe("0 on site");
    expect(crewLine(undefined)).toBe("-");
  });
});

describe("the turnover email: additions in the sections it already has", () => {
  const v7 = mk({ id: "v7", name: "V-7 - Transmix Fractionator", workOrderRef: "301235" });
  const om = mk({ id: "om", name: "Open Internal Manways", parentId: "v7", responsibleParty: "Schultz", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "18:00"), durationHours: 12, status: "in_progress", percentComplete: 45 });
  const sb = mk({ id: "sb", name: "Set Blinds", parentId: "v7", responsibleParty: "Schultz", plannedStartAt: at("2026-10-27", "06:00"), plannedAt: at("2026-10-27", "08:00"), durationHours: 2, status: "completed", percentComplete: 100, actualAt: at("2026-10-27", "07:40") });
  const ms = [v7, om, sb];
  const startPct = new Map([["om", 12], ["sb", 0], ["v7", 0]]);
  const report = buildShiftReport({ milestones: ms, tz: LA, times, shift: day, now: day.end, startPct });
  const look = (o: Partial<Parameters<typeof turnoverUpdate>[2]> = {}) => ({
    pctOf: () => 25, finishOf: () => undefined,
    timeOf: (id: string) => (id === "sb" ? t("2026-10-27", "07:40") : id === "om" ? t("2026-10-27", "16:36") : undefined),
    taskPct: (id: string) => (id === "v7" ? { pct: 19, plan: 28 } : undefined),
    whyOf: (id: string) => (id === "om" ? "trays heavier fouled than planned" : undefined),
    noteOf: (id: string) => (id === "om" ? "26 of 57 trays removed" : undefined),
    ...o,
  });
  const text = (o?: Partial<Parameters<typeof turnoverUpdate>[2]>) => toPlainText({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(report, f, look(o)) });
  it("Done shows each task's last step done and the one going, labeled, with the whole task's % and why it's behind", () => {
    const s = turnoverUpdate(report, f, look());
    const done = s.find((x) => x.id === "done")!.blocks.find((b) => b.k === "table")!;
    if (done.k !== "table") throw new Error();
    const row = done.rows[0];
    const task = row[0], steps = row[2], result = row[4];
    if (typeof task === "string" || typeof steps === "string" || typeof result === "string") throw new Error();
    expect(task.sub?.[0].t).toBe("task 19% done · plan 28%");
    expect(steps.t).toBe("Last done: Set Blinds");
    expect(steps.lines?.map((l) => l.t)).toEqual(["In progress: Open Internal Manways (45%)"]);
    expect(steps.lines?.[0].note).toBe("26 of 57 trays removed");
    expect(result.t).toBe("Behind plan, plan had 100% by now");
    expect(result.sub?.[0].t).toBe("Why behind: trays heavier fouled than planned");
  });
  it("times are off by default - and on when asked", () => {
    expect(text()).not.toMatch(/07:40 Set Blinds/);
    expect(text({ showTimes: true })).toMatch(/Last done: 07:40 Set Blinds; In progress: 16:36 Open Internal Manways \(45%\) \("26 of 57 trays removed"\) · Schultz · Behind plan/);
  });
  it("crews: who attended the meeting, supervisor and head count - the first line of the notes by the hour", () => {
    const s = text({ crewsThis: { Schultz: { supervisor: "B. Smith", headcount: 14 } }, hourly: [{ clock: "5:30 AM", kind: "meeting", text: "" }] });
    expect(s).toMatch(/5:30 AM - Shift meeting - Schultz: B\. Smith · 14 on site/);
    expect(s).not.toMatch(/^CREWS/m);
    expect(s).not.toMatch(/of \d+ done/);
  });
  it("safety incidents: their own box at the end - none, each one, or not recorded", () => {
    expect(text()).toMatch(/SAFETY INCIDENTS - DAY SHIFT 10-27\n\s+Not recorded\./);
    expect(text({ incidents: { none: true, items: [] } })).toMatch(/SAFETY INCIDENTS - DAY SHIFT 10-27\n\s+None\./);
    expect(text({ incidents: { none: false, items: [{ at: t("2026-10-27", "14:10"), kind: "Near miss", text: "Dropped wrench from deck" }] } })).toMatch(/14:10 - Near miss.*Dropped wrench from deck/);
    const ids = turnoverUpdate(report, f, look()).map((x) => x.id);
    expect(ids[ids.length - 1]).toBe("incidents");
  });
  it("notes & actions at the end: the shift's, and open follow-ups from before", () => {
    const s = text({ shiftNotes: [{ at: t("2026-10-27", "12:01"), text: "Unit evacuated - adjacent unit upset" }, { at: t("2026-10-26", "11:00"), text: "Gaskets not on site", followUp: true, from: "10-26 day" }] });
    expect(s).toMatch(/NOTES & ACTIONS/);
    expect(s).toMatch(/12:01 - .*Unit evacuated/);
    expect(s).toMatch(/Gaskets not on site.*Follow-up, open since 10-26 day/);
  });
  it("in the email itself: the last step, the why in amber under the count", () => {
    const html = toEmailHtml({ kind: "k", project: "p", when: "w", asOf: "a", sections: turnoverUpdate(report, f, look({ showTimes: true })) });
    expect(html).toMatch(/07:40 Set Blinds/);
    expect(html).toMatch(/Why behind: trays heavier fouled than planned/);
    expect(html).toMatch(/task 19% done · plan 28%/);
  });
});

describe("the time log - its own export", () => {
  const e17 = mk({ id: "e17", name: "E-17 Exchanger", workOrderRef: "301501" });
  const pb = mk({ id: "pb", name: "Pull Bundle", parentId: "e17", responsibleParty: "Schultz", status: "completed", percentComplete: 100 });
  const psv = mk({ id: "psv", name: "PSV-021", parentId: "e17", responsibleParty: "Maintenance (KE)", status: "on_hold", percentComplete: 25 });
  const note = (id: string, kind: MilestoneNote["kind"], body: string | null, created: string, happened?: string): MilestoneNote =>
    ({ orgId: "o", milestoneId: id, kind, body, createdAt: created, createdBy: "u", createdByName: "ggetzfrid", happenedAt: happened ?? null });
  const log = [
    { milestone_id: "pb", at: at("2026-10-27", "10:00"), entered_at: at("2026-10-27", "16:37"), old_status: "in_progress" as const, old_percent: 20, new_status: "completed" as const, new_percent: 100 },
    { milestone_id: "psv", at: at("2026-10-27", "13:29"), old_status: "in_progress" as const, old_percent: 25, new_status: "on_hold" as const, new_percent: 25 },
  ];
  const notes = [
    note("pb", "status", null, at("2026-10-27", "16:37")),
    note("pb", "note", "Bundle on the pad", at("2026-10-27", "16:37"), at("2026-10-27", "10:00")),
    note("psv", "status", null, at("2026-10-27", "13:29")),
    note("psv", "status", "Waiting on plugging to be removed by Ancon", at("2026-10-27", "13:29")),
    note("psv", "note", "PSV pulled, ready to swap", at("2026-10-27", "13:29")),
  ];
  const rows = buildTimeLog({ milestones: [e17, pb, psv], log, notes, tz: LA, times, records: new Map([["2026-10-27:day", { incidents: { items: [{ id: "i", at: t("2026-10-27", "14:10"), kind: "Near miss" as const, text: "Dropped wrench" }] } }]]) });
  it("each change at the time it happened, with its work order, crew and comment", () => {
    expect(rows[0]).toMatchObject({ task: "E-17 Exchanger", wo: "301501", step: "Pull Bundle", crew: "Schultz", what: "Done", pct: "20% → 100%", comment: "Bundle on the pad", enteredBy: "ggetzfrid" });
    expect(rows[0].at).toBe(t("2026-10-27", "10:00"));
    expect(rows[0].enteredAt).toBe(t("2026-10-27", "16:37")); // typed in later — said so
    expect(rows[0].shift).toBe("Tue, Oct 27 · Day");
  });
  it("a hold carries its reason (not the bare status note beside it), and the comment", () => {
    const h = rows.find((r) => r.step === "PSV-021")!;
    expect(h.what).toBe("On hold");
    expect(h.comment).toBe("Waiting on plugging to be removed by Ancon - PSV pulled, ready to swap");
  });
  it("the shift's incidents are in it too", () => {
    expect(rows.find((r) => r.what === "Safety incident - Near miss")?.comment).toBe("Dropped wrench");
  });
  it("says what a change was", () => {
    expect(describeChange("planned", 0, "in_progress", 15)).toBe("Started");
    expect(describeChange("in_progress", 25, "in_progress", 20)).toBe("Progress corrected down");
    expect(describeChange("on_hold", 0, "in_progress", 25)).toBe("Off hold, in progress");
    expect(describeChange("in_progress", 15, "planned", 0)).toBe("Set back to not started");
    expect(describeChange("on_hold", 0, "completed", 100)).toBe("Done (was on hold)");
  });
});
