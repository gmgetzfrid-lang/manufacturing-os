// Hour-by-hour shift notes: the model only words them — every line is
// checked against the shift's own entries before anyone approves it.

import { describe, it, expect } from "vitest";
import { checkHourly, parseHourly, hourlyClocks, factLine, approvedLines, clock24 } from "@/lib/shiftHourly";
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

describe("checkHourly", () => {
  it("a faithful line has no flags", () => {
    const out = checkHourly([
      { time: "08:00", text: "Schultz setting blinds on V-7 and E-12 (most of the crew in site safety orientation 6:00–7:15)." },
      { time: "14:30", text: "Pulling E-17 bundle, 2 of 5 out." },
      { time: "16:00", text: "UIT-013 picked up for calibration, expected back Tue 10/27." },
    ], rows, tz);
    expect(out.lines.map((l) => l.flags)).toEqual([[], [], []]);
    expect(out.lines[0].at).toBe(at("08:00"));
    expect(out.missing).toEqual([]);
  });
  it("flags a time, a tag, a number or a date the entries don't have", () => {
    const out = checkHourly([
      { time: "09:00", text: "Crane moved to X-11." },
      { time: "14:30", text: "Pulling E-17 bundle, 3 of 5 out." },
      { time: "16:00", text: "UIT-013 back on 10/29, done by 11:30." },
    ], rows, tz);
    expect(out.lines[0].flags).toEqual(["9:00 AM isn't a time in the entries", "not in the entries: X-11"]);
    expect(out.lines[1].flags).toEqual(["number not in the entries: 3"]);
    expect(out.lines[2].flags.join(" | ")).toMatch(/date not in the entries: 10\/29.*time not in the entries: 11:30/);
  });
  it("lists entry times the notes leave out", () => {
    const out = checkHourly([{ time: "08:00", text: "Schultz setting blinds on V-7 and E-12." }], rows, tz);
    expect(out.missing).toEqual(["2:30 PM E-17", "4:00 PM UIT-013"]);
  });
});

describe("reading and showing", () => {
  it("reads the JSON, or plain lines", () => {
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
  it("nothing reaches the email until approved", () => {
    const lines = [{ id: "a", at: at("08:00"), text: "x" }];
    expect(approvedLines({ lines })).toEqual([]);
    expect(approvedLines({ lines, approved: { at: 1 } })).toEqual(lines);
  });
});
