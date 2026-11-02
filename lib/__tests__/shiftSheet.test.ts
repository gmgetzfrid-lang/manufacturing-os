// The shift sheet: one page for the field, only the shift's work, by
// equipment in WO number order, and what's written on it back in at the
// times written.

import { describe, it, expect } from "vitest";
import { buildShiftSheet, shiftSheetHtml, sheetPages, splitTag, planEntry, planWords, sheetTimes, entryLines, sheetIds, type SheetLine } from "@/lib/shiftSheet";
import { shiftWindow, type ShiftTimes } from "@/lib/shiftReport";
import type { Milestone } from "@/types/schema";

const tz = "America/Los_Angeles";
const times: ShiftTimes = { dayStart: "06:00", nightStart: "18:00", breaks: [{ shift: "day", start: "11:00", minutes: 30, label: "Lunch" }] };
const at = (d: string, hm: string) => new Date(Date.parse(`2026-${d}T${hm}:00-07:00`)).toISOString();
const ms = (d: string, hm: string) => Date.parse(at(d, hm));
const mk = (p: Partial<Milestone> & { id: string; name: string }): Milestone => ({ orgId: "o", projectId: "p", weight: 1, status: "planned", source: "manual", createdBy: "u", percentComplete: 0, attributes: {}, dependsOn: [], ...p } as Milestone);
const day27 = shiftWindow("2026-10-27", "day", tz, times);

const schedule: Milestone[] = [
  mk({ id: "e12", name: "E-12 - Transmix Feed/Trans. Diesel Exchanger No. 2", workOrderRef: "301502", isSummary: true }),
  mk({ id: "e12a", parentId: "e12", name: "Pull Bundle", responsibleParty: "Schultz", plannedStartAt: at("10-26", "14:00"), plannedAt: at("10-26", "17:00") }),
  mk({ id: "e12b", parentId: "e12", name: "Hydroblast Tubes and Shell", responsibleParty: "Ancon", plannedStartAt: at("10-27", "08:00"), plannedAt: at("10-27", "12:00") }),
  mk({ id: "e12c", parentId: "e12", name: "Install Bundle", responsibleParty: "Schultz", plannedStartAt: at("10-28", "06:00"), plannedAt: at("10-28", "10:00") }),
  mk({ id: "v7", name: "V-7 - Transmix Fractionator", workOrderRef: "301235", isSummary: true }),
  mk({ id: "v7a", parentId: "v7", name: "Open Internal Manways", responsibleParty: "Schultz", plannedStartAt: at("10-26", "06:00"), plannedAt: at("10-26", "16:00"), status: "completed", percentComplete: 100, actualStartAt: at("10-26", "07:00"), actualAt: at("10-26", "15:00") }),
  mk({ id: "v7b", parentId: "v7", name: "Clean Tower", responsibleParty: "Schultz", plannedStartAt: at("10-26", "16:00"), plannedAt: at("10-27", "16:00"), status: "in_progress", percentComplete: 40, actualStartAt: at("10-26", "16:30") }),
  mk({ id: "v7c", parentId: "v7", name: "Inspect for Cleanliness", responsibleParty: "Inspector (KE)", plannedStartAt: at("10-27", "16:00"), plannedAt: at("10-27", "17:00"), status: "on_hold", statusReason: "Waiting on scaffold" }),
  mk({ id: "blinds", name: "Set Blinds", workOrderRef: "300100" }),
  mk({ id: "blinds1", parentId: "blinds", name: "Set Blinds on H-1", responsibleParty: "Maintenance (KE)", plannedStartAt: at("10-29", "06:00"), plannedAt: at("10-29", "10:00"), status: "in_progress", percentComplete: 20, actualStartAt: at("10-26", "09:00") }),
];

describe("which work is on the sheet", () => {
  const sheet = buildShiftSheet({ milestones: schedule, tz, times, target: day27, now: ms("10-27", "05:30") });
  const lines = sheet.groups.flatMap((g) => g.lines);
  const kind = (id: string) => lines.find((l) => l.id === id)?.kind;
  it("carried over, going (started ahead of plan too), planned, and ready to start early; not held, not done", () => {
    expect(kind("e12a")).toBe("late");
    expect(kind("e12b")).toBe("due");
    expect(kind("v7b")).toBe("going");
    expect(kind("blinds1")).toBe("going");
    expect(kind("e12c")).toBe("early");
    expect(kind("v7c")).toBeUndefined();
    expect(kind("v7a")).toBeUndefined();
    expect(sheet.count).toBe(5);
  });
  it("by work order, WO number order; in each, by plan, early ones last", () => {
    expect(sheet.groups.map((g) => g.wo)).toEqual(["300100", "301235", "301502"]);
    expect(sheet.groups[2]).toMatchObject({ tag: "E-12", rest: "Transmix Feed/Trans. Diesel Exchanger No. 2" });
    expect(sheet.groups[2].lines.map((l) => l.id)).toEqual(["e12a", "e12b", "e12c"]);
  });
  it("a WO number copied down onto each step still groups under the equipment", () => {
    const copied = schedule.map((m) => (m.parentId === "e12" ? { ...m, workOrderRef: "301502" } : m));
    const s = buildShiftSheet({ milestones: copied, tz, times, target: day27, now: ms("10-27", "05:30") });
    expect(s.groups.find((g) => g.wo === "301502")?.lines.length).toBe(3);
  });
});

describe("on paper", () => {
  const sheet = buildShiftSheet({ milestones: schedule, tz, times, target: day27, now: ms("10-27", "05:30") });
  const html = shiftSheetHtml(sheet, { project: "Transmix-1", tz, times });
  it("the shift on top, the equipment big, page n of N", () => {
    expect(html).toContain("Day shift · Tue, Oct 27 · 6 AM to 6 PM");
    expect(html).toContain('<span class="tag">E-12</span>');
    expect(html).toContain("WO 301502 · Transmix Feed/Trans. Diesel Exchanger No. 2");
    expect(html).toContain("Page 1 of 1");
    expect(html).toContain("% at lunch");
  });
  it("started before the shift says going; late says when it was due; early says when it's planned", () => {
    expect(html).toContain('<td class="bx on">going</td>');
    expect(html).toContain('<span class="late">due Mon 5 PM</span>');
    expect(html).toContain("planned Wed 6 AM");
    expect(html).toContain("could start early");
  });
  it("the plan: times inside the shift alone, the day with anything outside it", () => {
    const l = (s: number, f: number): SheetLine => ({ id: "x", name: "x", crew: "", kind: "due", started: false, planStart: s, planFinish: f, dueAt: f, critical: false });
    expect(planWords(l(ms("10-27", "08:00"), ms("10-27", "12:00")), day27, tz)).toBe("8 AM to 12 PM");
    expect(planWords(l(ms("10-27", "16:00"), ms("10-28", "04:00")), day27, tz)).toBe("4 PM to Wed 4 AM");
    expect(planWords(l(ms("10-27", "10:30"), ms("10-27", "11:45")), day27, tz)).toBe("10:30 AM to 11:45 AM");
  });
  it("a long list goes over pages; the work order carried over says continued; blank lines at the end", () => {
    const many: Milestone[] = [mk({ id: "big", name: "E-20 - Overhead Trim Cooler", workOrderRef: "301499" })];
    for (let i = 0; i < 45; i++) many.push(mk({ id: `s${i}`, parentId: "big", name: `Step ${i + 1}`, responsibleParty: "Schultz", plannedStartAt: at("10-27", "07:00"), plannedAt: at("10-27", "16:00") }));
    const h = shiftSheetHtml(buildShiftSheet({ milestones: many, tz, times, target: day27, now: ms("10-27", "05:30") }), { project: "P", tz, times });
    const pages = sheetPages(h);
    expect(pages).toBeGreaterThan(1);
    expect(h).toContain(`Page ${pages} of ${pages}`);
    expect(h).toContain('<div class="cont">continued</div>');
    expect(h).toContain("Not on the sheet");
  });
});

describe("what's written, back in", () => {
  const ctx = { target: day27, tz, times, now: ms("10-27", "20:00"), started: false, currentPct: 0 };
  it("the columns' times: lunch from the breaks, the end at the turnover meeting", () => {
    const t = sheetTimes(day27, times, tz);
    expect(t.lunch).toBe(ms("10-27", "11:00"));
    expect(t.end).toBe(ms("10-27", "17:30"));
    expect(sheetTimes(day27, { dayStart: "06:00", nightStart: "18:00" }, tz)).toMatchObject({ lunch: ms("10-27", "12:00"), lunchLabel: "% mid-shift" });
  });
  it("start, % at lunch, % at the end: in order, at their times", () => {
    expect(planEntry({ start: "07:30", lunchPct: "40", endPct: "80" }, ctx).events).toEqual([
      { kind: "start", at: ms("10-27", "07:30") }, { kind: "pct", at: ms("10-27", "11:00"), pct: 40 }, { kind: "pct", at: ms("10-27", "17:30"), pct: 80 },
    ]);
  });
  it("done mid-shift: % after it isn't saved; 100% with no time is done at the end", () => {
    expect(planEntry({ start: "07:00", lunchPct: "50", endPct: "100", done: "15:00" }, ctx).events.map((e) => e.kind)).toEqual(["start", "pct", "done"]);
    expect(planEntry({ endPct: "100" }, ctx).events).toEqual([{ kind: "done", at: ms("10-27", "17:30") }]);
    expect(planEntry({ start: "07:00", done: "09:15" }, ctx).events).toEqual([{ kind: "start", at: ms("10-27", "07:00") }, { kind: "done", at: ms("10-27", "09:15") }]);
  });
  it("a hold with why, a note at the last time written", () => {
    expect(planEntry({ endPct: "30", hold: true, note: "Waiting on scaffold" }, ctx).events).toEqual([
      { kind: "pct", at: ms("10-27", "17:30"), pct: 30 }, { kind: "hold", at: ms("10-27", "17:30"), reason: "Waiting on scaffold" },
    ]);
    expect(planEntry({ note: "Crew short two" }, ctx).events).toEqual([{ kind: "note", at: ms("10-27", "17:30"), text: "Crew short two" }]);
  });
  it("going already: the start is left alone", () => {
    expect(planEntry({ start: "07:00", endPct: "60" }, { ...ctx, started: true, currentPct: 40 }).events).toEqual([{ kind: "pct", at: ms("10-27", "17:30"), pct: 60 }]);
  });
  it("entered during the shift: times still to come are put at now", () => {
    expect(planEntry({ start: "07:00", lunchPct: "25" }, { ...ctx, now: ms("10-27", "10:00") }).events).toEqual([{ kind: "start", at: ms("10-27", "07:00") }, { kind: "pct", at: ms("10-27", "10:00"), pct: 25 }]);
  });
  it("what can't be right is said, nothing saved", () => {
    expect(planEntry({ start: "20:00" }, ctx).error).toMatch(/isn't in this shift/);
    expect(planEntry({ start: "10:00", done: "08:00" }, ctx).error).toMatch(/before the start/);
    expect(planEntry({ lunchPct: "60", endPct: "40" }, ctx).error).toMatch(/less than the lunch/);
    expect(planEntry({ endPct: "140" }, ctx).error).toMatch(/0 to 100/);
    expect(planEntry({ endPct: "20" }, { ...ctx, started: true, currentPct: 50 }).error).toMatch(/at 50% already/);
  });
  it("entering a sheet that was printed: the same lines, in the printed order", () => {
    const sheet = buildShiftSheet({ milestones: schedule, tz, times, target: day27, now: ms("10-27", "05:30") });
    const printed = { ids: sheetIds(sheet), printedAt: ms("10-27", "05:30") };
    // Since printed: the late one finished, a step got renamed.
    const later = schedule.map((m) => (m.id === "e12a" ? { ...m, status: "completed" as const, percentComplete: 100, actualAt: at("10-27", "09:00") } : m.id === "e12b" ? { ...m, name: "Hydroblast (10K)" } : m));
    const back = entryLines({ milestones: later, tz, times, target: day27, now: ms("10-27", "19:00"), printed });
    expect(back.flatMap((g) => g.lines.map((l) => l.id))).toEqual(printed.ids);
    expect(back.flatMap((g) => g.lines).find((l) => l.id === "e12b")?.name).toBe("Hydroblast (10K)");
  });
  it("not printed from here: the sheet as it would print, plus what was started or finished in the shift", () => {
    const later = schedule.map((m) => (m.id === "e12c" ? { ...m, status: "completed" as const, percentComplete: 100, actualStartAt: at("10-27", "13:00"), actualAt: at("10-27", "16:00") } : m));
    const ids = entryLines({ milestones: later, tz, times, target: day27, now: ms("10-27", "19:00") }).flatMap((g) => g.lines.map((l) => l.id));
    expect(ids).toContain("e12c");
    expect(ids).toContain("e12b");
  });
});

describe("tags", () => {
  it("the equipment tag at the front of a work order's name", () => {
    expect(splitTag("E-12 - Transmix Feed")).toEqual({ tag: "E-12", rest: "Transmix Feed" });
    expect(splitTag("UIT-013 - Corilois Meter")).toEqual({ tag: "UIT-013", rest: "Corilois Meter" });
    expect(splitTag("PSV-021 - E-13 Fractionator").tag).toBe("PSV-021");
    expect(splitTag("Machine All 4 Nozzle Flange Faces").tag).toBeNull();
    expect(splitTag("Transmix-1 - Shutdown").tag).toBeNull();
  });
});
