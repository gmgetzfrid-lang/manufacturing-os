// Shift notes by the hour: the meeting, the first hour (permitting), then
// each hour — written from that hour's entries and checked against them;
// anything the entries don't say is said plainly instead.

import { describe, it, expect } from "vitest";
import {
  flagsFor, parseHourly, hourlyClocks, factLine, clock24, hourSlots, slotOf, rowsBySlot, linesBySlot, hoursToWrite, hourSource,
  wordHours, plainHour, liveLines, hourlyRows, hourlyPrompt, breakLabel, ongoingByHour, type HourlyNotes,
} from "@/lib/shiftHourly";
import type { TimeLogRow } from "@/lib/timeLog";

const tz = "America/Los_Angeles";
const at = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00-07:00`);
const row = (hhmm: string, x: Partial<TimeLogRow>): TimeLogRow => ({
  at: at(hhmm), shift: "Mon, Oct 26 · Day", task: "", wo: "", step: "", crew: "", what: "Started", pct: "0%", comment: "", enteredBy: "", enteredAt: null, ...x,
});
const rows: TimeLogRow[] = [
  row("08:00", { task: "V-7 - Transmix Charge Drum", wo: "301235", step: "Set Blinds; Verify LOTO", crew: "Schultz", comment: "Majority of Schultz was going through site safety orientation (6am-7:15am)" }),
  row("08:00", { task: "E-12 - Exchanger", wo: "301502", step: "Set Blinds; Verify LOTO", crew: "Schultz" }),
  row("14:30", { task: "E-17 - Exchanger", wo: "301501", step: "Pull Bundle", crew: "Schultz", what: "Progress", pct: "0% → 20%", comment: "Pulled 2/5 bundles" }),
  row("16:00", { task: "UIT-013 - Meter", step: "Calibrate Equipment", comment: "Picked up expected back tue 10/27/26" }),
];

const shift = { start: at("06:00"), end: at("18:00") };
const slots = hourSlots(shift, 30);
const key = (hhmm: string) => String(at(hhmm));

describe("the shift by the hour", () => {
  it("the meeting, the first hour (permitting), then each hour to the end", () => {
    expect(slots).toHaveLength(13);
    expect(slots[0]).toEqual({ key: "meeting", kind: "meeting", start: at("05:30"), end: at("06:00") });
    expect(slots[1]).toEqual({ key: key("06:00"), kind: "permit", start: at("06:00"), end: at("07:00") });
    expect(slots[2]).toMatchObject({ kind: "work", start: at("07:00"), end: at("08:00") });
    // To the next shift's meeting: 5:00 to 5:30 PM is the last of it.
    expect(slots[12]).toMatchObject({ kind: "work", start: at("17:00"), end: at("17:30") });
    expect(hourlyClocks(slots.map((x) => x.start), tz).slice(0, 4)).toEqual(["5:30 AM", "6:00", "7:00", "8:00"]);
  });
  it("a time falls in its hour", () => {
    expect(slotOf(at("06:20"), slots).kind).toBe("permit");
    expect(slotOf(at("05:45"), slots).kind).toBe("meeting");
    expect(slotOf(at("14:30"), slots).key).toBe(key("14:00"));
    expect(slotOf(at("18:30"), slots).key).toBe(key("17:00"));
  });
  it("an hour is written when its entries change, never once it's typed over", () => {
    const by = rowsBySlot(rows, slots);
    expect([...by.keys()]).toEqual([key("08:00"), key("14:00"), key("16:00")]);
    const first = hoursToWrite(slots, by, new Map(), tz, false);
    expect(first.write.map((w) => w.slot.key)).toEqual([key("08:00"), key("14:00"), key("16:00")]);
    // Written: nothing to do until an entry changes.
    const notes: HourlyNotes = { v: 2, lines: first.write.map((w, i) => ({ id: `l${i}`, at: w.slot.start, text: "x", src: w.src })) };
    expect(hoursToWrite(slots, by, linesBySlot(notes, slots), tz, true)).toEqual({ write: [], clear: [] });
    const more = rowsBySlot([...rows, row("14:45", { task: "E-17 - Exchanger", step: "Pull Bundle", crew: "Schultz", what: "Progress", pct: "20% → 40%" })], slots);
    expect(hoursToWrite(slots, more, linesBySlot(notes, slots), tz, false).write.map((w) => w.slot.key)).toEqual([key("14:00")]);
    // Typed over: kept.
    const typed: HourlyNotes = { v: 2, lines: [...notes.lines.filter((l) => l.at !== at("14:00")), { id: "t", at: at("14:00"), text: "mine", hand: true }] };
    expect(hoursToWrite(slots, more, linesBySlot(typed, slots), tz, false).write).toEqual([]);
    // Its entries gone: cleared.
    expect(hoursToWrite(slots, rowsBySlot(rows.slice(0, 2), slots), linesBySlot(notes, slots), tz, false).clear).toEqual([key("14:00"), key("16:00")]);
    // Said plainly last time: worded again when asked to.
    const plain: HourlyNotes = { v: 2, lines: notes.lines.map((l, i) => (i === 0 ? { ...l, plain: true } : l)) };
    expect(hoursToWrite(slots, by, linesBySlot(plain, slots), tz, true).write.map((w) => w.slot.key)).toEqual([key("08:00")]);
    expect(hoursToWrite(slots, by, linesBySlot(plain, slots), tz, false).write).toEqual([]);
  });
  it("the source changes with any entry, not with nothing", () => {
    expect(hourSource(rows.slice(0, 2), tz)).toBe(hourSource([rows[1], rows[0]], tz));
    expect(hourSource(rows.slice(0, 2), tz)).not.toBe(hourSource([rows[0], { ...rows[1], comment: "x" }], tz));
  });
});

describe("breaks, and what crews kept working on", () => {
  it("a break sits after the hour it falls in, and takes no entries", () => {
    const withBreaks = hourSlots(shift, 30, [{ at: at("09:00"), minutes: 15, label: "Break" }, { at: at("12:00"), minutes: 30, label: "Lunch" }]);
    const i = withBreaks.findIndex((x) => x.kind === "break" && x.label === "Lunch");
    expect(withBreaks[i - 1]).toMatchObject({ kind: "work", start: at("12:00") });
    expect(withBreaks[i]).toMatchObject({ start: at("12:00"), end: at("12:30"), minutes: 30 });
    expect(breakLabel(withBreaks[i])).toBe("Lunch, 30 min");
    expect(slotOf(at("12:10"), withBreaks).kind).toBe("work");
  });
  it("the model's lines come back one item each", () => {
    expect(parseHourly('{"hours":[{"hour":"07:00","lines":["Schultz setting blinds.","Crane on site."]}]}')).toEqual([{ time: "07:00", text: "Schultz setting blinds.\nCrane on site." }]);
  });
  it("an hour with nothing new entered still says what each crew was on", () => {
    const steps = [
      { id: "a", name: "Clean Tower", task: "V-7 - Fractionator", crew: "Ancon", worksShift: true },
      { id: "b", name: "Hydro", task: "E-12 - Exchanger", crew: "Schultz", worksShift: true },
      { id: "c", name: "Night job", task: "E-1 - X", crew: "Schultz", worksShift: false },
    ];
    const log = [
      { milestone_id: "a", at: new Date(at("06:30")).toISOString(), new_status: "in_progress" },
      { milestone_id: "b", at: new Date(at("07:15")).toISOString(), new_status: "in_progress" },
      { milestone_id: "b", at: new Date(at("10:20")).toISOString(), new_status: "on_hold" },
      { milestone_id: "c", at: new Date(at("06:10")).toISOString(), new_status: "in_progress" },
    ];
    const g = ongoingByHour(slots, steps, log, at("11:30"));
    expect(g.get(key("07:00"))).toEqual(["Ancon - V-7 Clean Tower"]); // Hydro started this hour: its own line says so
    expect(g.get(key("08:00"))).toEqual(["Ancon - V-7 Clean Tower", "Schultz - E-12 Hydro"]);
    expect(g.get(key("11:00"))).toEqual(["Ancon - V-7 Clean Tower"]); // Hydro on hold
    expect(g.has(key("12:00"))).toBe(false); // not yet
  });
});

describe("checked against the hour's entries", () => {
  const hours = [...rowsBySlot(rows, slots)].map(([k, rs]) => ({ slot: slots.find((x) => x.key === k)!, rows: rs }));
  it("a faithful line has no flags", () => {
    expect(flagsFor("Schultz setting blinds on V-7 and E-12 (most of the crew in site safety orientation 6:00–7:15).", rows.slice(0, 2))).toEqual([]);
    expect(flagsFor("Pulling E-17 bundle, 2 of 5 out.", [rows[2]])).toEqual([]);
    expect(flagsFor("UIT-013 picked up for calibration, expected back Tue 10/27.", [rows[3]])).toEqual([]);
  });
  it("flags a tag, a number, a date or a time the entries don't have", () => {
    expect(flagsFor("Crane moved to X-11.", rows)).toEqual(["not in the entries: X-11"]);
    expect(flagsFor("Pulling E-17 bundle, 3 of 5 out.", [rows[2]])).toEqual(["number not in the entries: 3"]);
    expect(flagsFor("UIT-013 back on 10/29, done by 11:30.", [rows[3]]).join(" | ")).toMatch(/date not in the entries: 10\/29.*time not in the entries: 11:30/);
  });
  it("wording that says what the entries don't - or no wording - is said plainly", () => {
    const w = wordHours([
      { time: "08:00", text: "Schultz setting blinds on V-7 and E-12." },
      { time: "14:00", text: "Pulling E-17 bundle, 3 of 5 out." },
    ], hours, tz);
    expect(w.get(key("08:00"))).toEqual({ text: "Schultz setting blinds on V-7 and E-12.", plain: false });
    expect(w.get(key("14:00"))).toEqual({ text: "Schultz: E-17 Pull Bundle to 20% - Pulled 2/5 bundles.", plain: true });
    expect(w.get(key("16:00"))?.plain).toBe(true);
  });
  it("says a step's entry, or the shift's own note, plainly", () => {
    expect(plainHour(rows.slice(0, 2))).toBe("Schultz: V-7 Set Blinds; Verify LOTO started - Majority of Schultz was going through site safety orientation (6am-7:15am); E-12 Set Blinds; Verify LOTO started.");
    // One line per crew, and per note.
    expect(plainHour([rows[2], row("14:40", { task: "Notes & actions", what: "Note", comment: "Crane on site" })]).split("\n")).toEqual([
      "Schultz: E-17 Pull Bundle to 20% - Pulled 2/5 bundles.", "Note: Crane on site."]);
    expect(plainHour([row("09:00", { task: "Notes & actions", what: "Note", comment: "Crane on site" })])).toBe("Note: Crane on site.");
    expect(plainHour([
      row("10:00", { task: "V-7 - Piping", step: "Inspect", crew: "Schultz", what: "Comment", comment: "Discovery: low TML" }),
      row("10:00", { task: "V-7 - Piping", step: "Welded pipe", crew: "Schultz", what: "Discovery found", comment: "low TML - 32 h of work · task finish +24 h" }),
      row("10:30", { task: "E-14 - Cooler", step: "LV-009B", crew: "Maintenance", what: "Off hold, in progress", comment: "Putting the valve back in" }),
    ])).toBe("Schultz: V-7 Welded pipe discovery - low TML.\nMaintenance: E-14 LV-009B back in progress - Putting the valve back in.");
  });
  it("asks for each hour with its entries", () => {
    const p = hourlyPrompt(hours, { tz, shiftTitle: "Day shift Mon Oct 26", window: "6:00–18:00" });
    expect(p).toContain("HOUR 08:00 (08:00–09:00), 2 entries");
    expect(p).toContain("HOUR 14:00 (14:00–15:00), 1 entry");
  });
});

describe("what stands, and what the report shows", () => {
  const lines = [{ id: "a", at: at("08:00"), text: "x" }];
  it("an earlier draft nobody approved is written again; one approved is kept as typed", () => {
    expect(liveLines({ lines })).toEqual([]);
    expect(liveLines({ lines, approved: { at: 1 } })).toEqual([{ ...lines[0], hand: true }]);
    expect(liveLines({ v: 2, lines })).toEqual(lines);
  });
  it("each hour so far, the meeting always", () => {
    const r = hourlyRows({ v: 2, lines: [{ id: "a", at: at("08:00"), text: "Blinds set." }] }, slots, at("08:30"));
    expect(r.map((x) => [x.slot.kind, x.text])).toEqual([["meeting", ""], ["permit", ""], ["work", ""], ["work", "Blinds set."]]);
  });
});

describe("reading and showing", () => {
  it("reads the JSON, or plain lines", () => {
    expect(parseHourly('{"hours":[{"hour":"7:00","text":"Permits signed."}]}')).toEqual([{ time: "07:00", text: "Permits signed." }]);
    expect(parseHourly('Here: {"lines":[{"time":"8:00","text":" Blinds  set. "}]}')).toEqual([{ time: "08:00", text: "Blinds set." }]);
    expect(parseHourly("08:00 – Blinds set.\n12:30 PM - Manways open.")).toEqual([{ time: "08:00", text: "Blinds set." }, { time: "12:30", text: "Manways open." }]);
  });
  it("AM/PM on the first line and when it changes", () => {
    expect(hourlyClocks([at("06:00"), at("07:00"), at("12:30"), at("14:00")], tz)).toEqual(["6:00 AM", "7:00", "12:30 PM", "2:00"]);
  });
  it("one entry per prompt line", () => {
    expect(factLine(rows[2], tz)).toBe('14:30 | Progress 0% → 20% | Pull Bundle | E-17 - Exchanger (WO 301501) | crew Schultz | comment: "Pulled 2/5 bundles"');
    expect(clock24(at("06:05"), tz)).toBe("06:05");
  });
});
