// A crew held over past the end of its shift (overtime): its work stays on
// the shift that held it, until it's sent home.

import { describe, it, expect } from "vitest";
import { overtimeOf, overtimeEnd, inOvertime, shiftEntries, overtimeLine, sentHomeLine, timeAfter } from "@/lib/holdOver";
import { hourSlots, hourlyRows, slotClocks } from "@/lib/shiftHourly";
import { meetingRows } from "@/lib/shiftMeeting";
import { shiftLog, logHasWork } from "@/lib/hourlyLog";
import { scheduleAt } from "@/lib/progressHistory";
import { shiftWindow, timeOnDay, type ShiftTimes } from "@/lib/shiftReport";
import { dayKey } from "@/lib/scheduleTz";
import type { TimeLogRow } from "@/lib/timeLog";
import type { ShiftRecord } from "@/lib/shiftRecord";
import type { Milestone } from "@/types/schema";

const TZ = "America/Los_Angeles";
const TIMES: ShiftTimes = { dayStart: "06:00", nightStart: "18:00", meetingBefore: 30 };
const DAY = shiftWindow("2026-10-31", "day", TZ, TIMES);
const NIGHT = shiftWindow("2026-10-31", "night", TZ, TIMES);
const H = 3_600_000;
const at = (hhmm: string) => DAY.start + (Number(hhmm.slice(0, 2)) - 6) * H + Number(hhmm.slice(3)) * 60_000;
const row = (t: number, p: Partial<TimeLogRow>): TimeLogRow => ({ at: t, shift: "", task: "E-12 - Exchanger", wo: "301502", step: "Shell Side Hydro", crew: "Schultz", what: "Progress", pct: "25% → 50%", comment: "", enteredBy: "", enteredAt: null, id: "ssh", ...p });
const held: ShiftRecord = { holdOver: [{ id: "h", crew: "Schultz", hands: 6, note: "Exchanger hands only", until: at("21:30"), takeover: "Maintenance (KE)", at: 0 }] };

describe("the crew held over", () => {
  const w = overtimeOf(held.holdOver, DAY.end, NIGHT.end, NIGHT.end);
  it("from the end of the shift to when it was sent home", () => {
    expect(w).toEqual([{ crew: "Schultz", from: DAY.end, to: at("21:30"), open: false, hands: 6, note: "Exchanger hands only", takeover: "Maintenance (KE)" }]);
    expect(overtimeEnd(w, DAY.end)).toBe(at("21:30"));
    expect(overtimeLine(w)).toBe("Overtime: Schultz held over, 6 hands. Exchanger hands only.");
    expect(sentHomeLine(w)).toBe("Schultz sent home. Maintenance (KE) takes over.");
    // Still on: up to now.
    expect(overtimeOf([{ ...held.holdOver![0], until: null }], DAY.end, at("20:00"), NIGHT.end)[0]).toMatchObject({ to: at("20:00"), open: true });
  });
  it("its work in its overtime is the day shift's; the night's log leaves it out", () => {
    const rows = [row(at("17:10"), { what: "Started", pct: "0%" }), row(at("19:22"), {}), row(at("21:40"), { crew: "Maintenance (KE)", step: "Disassemble" }), row(at("20:00"), { crew: "Ancon", step: "Other" })];
    expect(inOvertime(w, "schultz", at("19:22"))).toBe(true);
    // Logged as it was sent home: the day crew's last.
    expect(inOvertime(w, "Schultz", at("21:30"))).toBe(true);
    expect(inOvertime(w, "Schultz", at("21:31"))).toBe(false);
    expect(shiftEntries(rows, DAY, w, []).map((r) => r.at)).toEqual([at("17:10"), at("19:22")]);
    expect(shiftEntries(rows, NIGHT, [], w).map((r) => r.at)).toEqual([at("21:40"), at("20:00")]);
  });
  it("a time picked for sent home: after the shift's end, past midnight the next day", () => {
    expect(timeAfter(DAY.end, "21:30", TZ, timeOnDay, dayKey)).toBe(at("21:30"));
    expect(timeAfter(DAY.end, "01:15", TZ, timeOnDay, dayKey)).toBe(at("21:30") + 3 * H + 45 * 60_000);
  });
});

describe("the day's hours run on into the overtime", () => {
  it("overtime starts, each hour of it, sent home", () => {
    const w = overtimeOf(held.holdOver, DAY.end, NIGHT.end, NIGHT.end);
    const slots = hourSlots(DAY, 30, [], { to: overtimeEnd(w, DAY.end), open: false, label: overtimeLine(w), endLabel: sentHomeLine(w) });
    const ot = slots.slice(slots.findIndex((x) => x.key === "ot"));
    expect(ot.map((x) => [x.kind, slotClocks([x], TZ)[0]])).toEqual([["overtime", "6:00 PM"], ["work", "6:00 PM"], ["work", "7:00 PM"], ["work", "8:00 PM"], ["work", "9:00 PM"], ["overtime", "9:30 PM"]]);
    const r = hourlyRows(undefined, slots, at("21:30"), [row(at("19:22"), { comment: "starting filling for re-test" })], TZ);
    expect(r.find((x) => x.slot.start === at("19:00") && x.slot.ot)?.progress).toEqual(["7:22 PM **WO 301502 E-12**, Schultz: Shell Side Hydro 25% to 50%. Starting filling for re-test."]);
  });
  it("the logs: the day's says the overtime, the night's starts with the crew that took over; no night meeting unless put back", () => {
    const rows = [row(at("19:22"), {}), row(at("21:40"), { crew: "Maintenance (KE)", step: "Disassemble", what: "Started", pct: "0%" })];
    const day = shiftLog({ shift: DAY, tz: TZ, times: TIMES, record: held, rows, steps: [], log: [], now: NIGHT.end + H });
    expect(day.window).toBe("6:00 AM to 6:00 PM, overtime to 9:30 PM");
    expect(day.entries.filter((e) => e.kind === "overtime").map((e) => [e.clock, e.title])).toEqual([["6:00 PM", "Overtime: Schultz held over, 6 hands. Exchanger hands only."], ["9:30 PM", "Schultz sent home. Maintenance (KE) takes over."]]);
    expect(day.entries.find((e) => e.clock === "7:00 PM")?.continuing).toEqual(["7:22 PM **WO 301502 E-12**, Schultz: Shell Side Hydro 25% to 50%."]);
    expect(day.entries.some((e) => e.kind === "handover")).toBe(false);
    const night = shiftLog({ shift: NIGHT, tz: TZ, times: TIMES, prev: held, rows, steps: [], log: [], now: NIGHT.end + H });
    expect(night.entries.some((e) => e.kind === "meeting")).toBe(false);
    expect(night.entries.flatMap((e) => [...e.lines, ...e.continuing]).join(" ")).not.toContain("25% to 50%");
    expect(night.entries.find((e) => e.clock === "9:00 PM")?.lines).toEqual(["9:40 PM **WO 301502 E-12**, Maintenance (KE): Disassemble started."]);
    expect(logHasWork(night)).toBe(true);
  });
  it("the night meeting: off when a crew was held over, unless put back", () => {
    expect(meetingRows(undefined, undefined, 0, { endOff: true }).off).toEqual(["meeting:end"]);
    expect(meetingRows(undefined, { meeting: { off: false } }, 0, { endOff: true }).off).toEqual([]);
    expect(meetingRows(undefined, { meeting: { off: true } }, 0).off).toEqual(["meeting:end"]);
  });
});

describe("the report's progress: a held-over crew's work counts for the day", () => {
  const mk = (p: Partial<Milestone> & { id: string }): Milestone => ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "in_progress", source: "msproject", createdBy: "u", percentComplete: 50, ...p } as Milestone);
  const ms = [mk({ id: "ssh", responsibleParty: "Schultz" }), mk({ id: "x", responsibleParty: "Ancon" })];
  const log = [
    { id: 1, milestone_id: "ssh", at: new Date(at("11:30")).toISOString(), old_status: "in_progress", old_percent: 0, new_status: "in_progress", new_percent: 25 },
    { id: 2, milestone_id: "ssh", at: new Date(at("19:22")).toISOString(), old_status: "in_progress", old_percent: 25, new_status: "in_progress", new_percent: 50 },
    { id: 3, milestone_id: "x", at: new Date(at("11:00")).toISOString(), old_status: "in_progress", old_percent: 0, new_status: "in_progress", new_percent: 20 },
    { id: 4, milestone_id: "x", at: new Date(at("20:00")).toISOString(), old_status: "in_progress", old_percent: 20, new_status: "in_progress", new_percent: 50 },
  ] as Parameters<typeof scheduleAt>[1];
  it("the held-over crew's steps as of sent home; the rest as of the shift's end", () => {
    const cut = DAY.end + H;
    const r = scheduleAt(ms, log, cut, (m) => (m.responsibleParty === "Schultz" ? at("21:30") : cut)).milestones;
    expect(r.map((m) => [m.id, m.percentComplete])).toEqual([["ssh", 50], ["x", 20]]);
    expect(scheduleAt(ms, log, cut).milestones.map((m) => m.percentComplete)).toEqual([25, 20]);
  });
});
