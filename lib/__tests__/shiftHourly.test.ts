// Shift notes by the hour: the meeting, the first hour (permitting), then
// each hour, saying that hour's entries one line each in fixed words, with
// each comment as it was typed. Nothing made up; an hour typed over is kept.

import { describe, it, expect } from "vitest";
import {
  hourlyClocks, hourSlots, slotOf, rowsBySlot, typedLines, hourlyRows, breakLabel, ongoingByHour, entryLine, hourItems, type HourlyNotes,
} from "@/lib/shiftHourly";
import type { TimeLogRow } from "@/lib/timeLog";

const tz = "America/Los_Angeles";
const at = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00-07:00`);
const row = (hhmm: string, x: Partial<TimeLogRow>): TimeLogRow => ({
  at: at(hhmm), id: "s", shift: "Mon, Oct 26 · Day", task: "", wo: "", step: "", crew: "", what: "Started", pct: "0%", comment: "", enteredBy: "", enteredAt: null, ...x,
});
const rows: TimeLogRow[] = [
  row("08:00", { task: "V-7 - Transmix Charge Drum", wo: "301235", step: "Set Blinds", crew: "Schultz", comment: "majority of the crew in site safety orientation (6am-7:15am)" }),
  row("08:00", { task: "E-12 - Exchanger", wo: "301502", step: "Set Blinds", crew: "Schultz" }),
  row("14:30", { task: "E-17 - Exchanger", wo: "301501", step: "Pull Bundle", crew: "Schultz", what: "Progress", pct: "0% → 20%", comment: "Pulled 2/5 bundles" }),
  row("16:00", { task: "UIT-013 - Meter", step: "Calibrate Equipment", what: "Comment", pct: "", comment: "Picked up expected back tue 10/27/26" }),
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
    expect([...rowsBySlot(rows, slots).keys()]).toEqual([key("08:00"), key("14:00"), key("16:00")]);
  });
});

describe("each entry in fixed words", () => {
  it("who, which step, what happened, and the comment as typed", () => {
    expect(entryLine(rows[0])).toBe("Schultz: V-7 Set Blinds started. Majority of the crew in site safety orientation (6am-7:15am)");
    expect(entryLine(rows[1])).toBe("Schultz: E-12 Set Blinds started.");
    expect(entryLine(rows[2])).toBe("Schultz: E-17 Pull Bundle 20% (was 0%). Pulled 2/5 bundles.");
    expect(entryLine(rows[3])).toBe("UIT-013 Calibrate Equipment. Picked up expected back tue 10/27/26.");
    const s = (x: Partial<TimeLogRow>) => entryLine(row("09:00", { task: "E-14 - Cooler", step: "LV-009B", crew: "Maintenance", ...x }));
    expect(s({ what: "Done", pct: "40% → 100%" })).toBe("Maintenance: E-14 LV-009B done.");
    expect(s({ what: "Done (was on hold)", pct: "100%" })).toBe("Maintenance: E-14 LV-009B done (was on hold).");
    expect(s({ what: "On hold", pct: "40%", comment: "waiting on the crane" })).toBe("Maintenance: E-14 LV-009B on hold. Waiting on the crane.");
    expect(s({ what: "Off hold, in progress", pct: "40%" })).toBe("Maintenance: E-14 LV-009B back in progress (was on hold).");
    expect(s({ what: "Started", pct: "0% → 25%" })).toBe("Maintenance: E-14 LV-009B started, 25%.");
    expect(s({ what: "Progress corrected down", pct: "50% → 40%" })).toBe("Maintenance: E-14 LV-009B corrected to 40% (was 50%).");
    expect(s({ what: "Why it's behind", pct: "", comment: "no crane" })).toBe("Maintenance: E-14 LV-009B behind plan. No crane.");
  });
  it("found work, and the shift's own notes and incidents", () => {
    expect(entryLine(row("15:00", { id: undefined, task: "V-8 - Reflux Drum", step: "Welded fabrication", crew: "Maintenance (KE)", what: "Discovery found", pct: "",
      comment: "Corroded vortex break. Fabricating in house - 3 h of work · task finish +23 h · approved by TA management" })))
      .toBe("Maintenance (KE): Discovery found on V-8, Welded fabrication. Corroded vortex break. Fabricating in house. 3 h of work, task finish +23 h, approved by TA management.");
    expect(entryLine(row("09:00", { id: undefined, task: "Notes & actions", what: "Note", pct: "", comment: "crane on site" }))).toBe("Note: Crane on site.");
    expect(entryLine(row("09:00", { id: undefined, task: "Safety", what: "Safety incident - Near miss", pct: "", comment: "dropped wrench" }))).toBe("Safety incident - Near miss: Dropped wrench.");
  });
  it("an hour: in the order it happened, the time when it's off the hour, the same line once, no em dash", () => {
    expect(hourItems([rows[2], row("14:00", { task: "E-17 - Exchanger", step: "Pull Bundle", crew: "Schultz" })], at("14:00"), tz))
      .toEqual(["Schultz: E-17 Pull Bundle started.", "2:30 PM Schultz: E-17 Pull Bundle 20% (was 0%). Pulled 2/5 bundles."]);
    expect(hourItems([rows[1], rows[1]], at("08:00"), tz)).toEqual(["Schultz: E-12 Set Blinds started."]);
    expect(hourItems([row("08:00", { task: "E-12 \u2014 Exchanger", step: "Blinds", comment: "in \u2014 out" })], at("08:00"), tz)[0]).not.toContain("\u2014");
  });
});

describe("what stands, and what the report shows", () => {
  const lines = [{ id: "a", at: at("08:00"), text: "x" }];
  it("only what someone typed is kept: anything written for them is said from the entries again", () => {
    expect(typedLines({ lines })).toEqual([]);
    expect(typedLines({ lines, approved: { at: 1 } })).toEqual([{ ...lines[0], hand: true }]);
    expect(typedLines({ v: 2, lines })).toEqual([]);
    expect(typedLines({ v: 2, lines: [{ ...lines[0], hand: true }] })).toEqual([{ ...lines[0], hand: true }]);
  });
  it("each hour so far, the meeting always: typed over as typed, else its entries", () => {
    const notes: HourlyNotes = { v: 2, lines: [{ id: "a", at: at("14:00"), text: "Bundle 2 of 5 out.", hand: true }, { id: "b", at: at("08:00"), text: "Model wording", src: "x" }] };
    const r = hourlyRows(notes, slots, at("16:30"), rows, tz);
    expect(r.map((x) => [x.slot.kind, x.typed, x.lines.length])).toEqual([
      ["meeting", false, 0], ["permit", false, 0], ["work", false, 0], ["work", false, 2], ["work", false, 0], ["work", false, 0], ["work", false, 0], ["work", false, 0],
      ["work", false, 0], ["work", true, 1], ["work", false, 0], ["work", false, 1],
    ]);
    expect(r[3].text).toBe("Schultz: E-12 Set Blinds started.\nSchultz: V-7 Set Blinds started. Majority of the crew in site safety orientation (6am-7:15am)");
    expect(r[9].lines).toEqual(["Bundle 2 of 5 out."]);
    // Still being read: nothing yet, not a guess.
    expect(hourlyRows(undefined, slots, at("09:00"), null, tz)[3].lines).toEqual([]);
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
  it("an hour with nothing new entered still says what each crew was on, and where it stood", () => {
    const steps = [
      { id: "a", name: "Clean Tower", task: "V-7 - Fractionator", crew: "Ancon", worksShift: true },
      { id: "b", name: "Hydro", task: "E-12 - Exchanger", crew: "Schultz", worksShift: true },
      { id: "c", name: "Night job", task: "E-1 - X", crew: "Schultz", worksShift: false },
    ];
    const log = [
      { milestone_id: "a", at: new Date(at("06:30")).toISOString(), new_status: "in_progress", new_percent: 0 },
      { milestone_id: "a", at: new Date(at("09:10")).toISOString(), new_status: "in_progress", new_percent: 40 },
      { milestone_id: "b", at: new Date(at("07:15")).toISOString(), new_status: "in_progress", new_percent: 10 },
      { milestone_id: "b", at: new Date(at("10:20")).toISOString(), new_status: "on_hold", new_percent: 10 },
      { milestone_id: "c", at: new Date(at("06:10")).toISOString(), new_status: "in_progress", new_percent: 0 },
    ];
    const g = ongoingByHour(slots, steps, log, at("11:30"));
    expect(g.get(key("07:00"))).toEqual(["Ancon - V-7 Clean Tower 0%"]); // Hydro started this hour: its own line says so
    expect(g.get(key("08:00"))).toEqual(["Ancon - V-7 Clean Tower 0%", "Schultz - E-12 Hydro 10%"]);
    expect(g.get(key("10:00"))).toEqual(["Ancon - V-7 Clean Tower 40%"]); // Hydro held this hour: said on its own line
    expect(g.get(key("11:00"))).toEqual(["Ancon - V-7 Clean Tower 40%"]); // Hydro on hold
    expect(g.has(key("12:00"))).toBe(false); // not yet
  });
});
