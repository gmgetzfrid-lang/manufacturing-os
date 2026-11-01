// Shift notes by the hour: the meeting, the first hour (permitting), then
// each hour, saying that hour's entries one line each in fixed words, with
// each comment as it was typed. Nothing made up; an hour typed over is kept.

import { describe, it, expect } from "vitest";
import {
  hourlyClocks, slotClocks, workOrderClosers, typedClosed, typedHour, hourSlots, slotOf, rowsBySlot, typedLines, hourlyRows, breakLabel, entryLine, hourItems, hourParts, plainLine, boldRuns, type HourlyNotes,
} from "@/lib/shiftHourly";
import type { TimeLogRow } from "@/lib/timeLog";
import type { Milestone } from "@/types/schema";

const tz = "America/Los_Angeles";
const at = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00-07:00`);
const row = (hhmm: string, x: Partial<TimeLogRow>): TimeLogRow => ({
  at: at(hhmm), id: "s", shift: "Mon, Oct 26 · Day", task: "", wo: "", step: "", crew: "", what: "Started", pct: "0%", comment: "", enteredBy: "", enteredAt: null, ...x,
});
const rows: TimeLogRow[] = [
  row("08:00", { id: "v7", task: "V-7 - Transmix Charge Drum", wo: "301235", step: "Set Blinds", crew: "Schultz", comment: "majority of the crew in site safety orientation (6am-7:15am)" }),
  row("08:00", { id: "e12", task: "E-12 - Exchanger", wo: "301502", step: "Set Blinds", crew: "Schultz" }),
  row("14:30", { id: "e17", task: "E-17 - Exchanger", wo: "301501", step: "Pull Bundle", crew: "Schultz", what: "Progress", pct: "0% → 20%", comment: "Pulled 2/5 bundles" }),
  row("16:00", { id: "uit", task: "UIT-013 - Meter", step: "Calibrate Equipment", what: "Comment", pct: "", comment: "Picked up expected back tue 10/27/26" }),
];

const shift = { start: at("06:00"), end: at("18:00") };
const slots = hourSlots(shift, 30);
const key = (hhmm: string) => String(at(hhmm));

describe("the shift by the hour", () => {
  it("the meeting, the first hour (permitting), each hour, then the meeting that starts the next shift", () => {
    expect(slots).toHaveLength(15);
    expect(slots[0]).toEqual({ key: "meeting", kind: "meeting", start: at("05:30"), end: at("06:00") });
    expect(slots[1]).toEqual({ key: key("06:00"), kind: "permit", start: at("06:00"), end: at("07:00") });
    expect(slots[2]).toMatchObject({ kind: "work", start: at("07:00"), end: at("08:00") });
    // 5:00 to 5:30 PM is the last hour; then the meeting that starts the
    // next shift; work logged from 5:30 on is its own row after it.
    expect(slots[12]).toMatchObject({ kind: "work", start: at("17:00"), end: at("17:30") });
    expect(slots[13]).toEqual({ key: "meeting:end", kind: "handover", start: at("17:30"), end: at("18:00") });
    expect(slots[14]).toEqual({ key: key("17:30"), kind: "work", start: at("17:30"), end: at("18:00"), tail: true });
    expect(hourlyClocks(slots.map((x) => x.start), tz).slice(0, 4)).toEqual(["5:30 AM", "6:00", "7:00", "8:00"]);
  });
  it("a time falls in its hour", () => {
    expect(slotOf(at("06:20"), slots).kind).toBe("permit");
    expect(slotOf(at("05:45"), slots).kind).toBe("meeting");
    expect(slotOf(at("14:30"), slots).key).toBe(key("14:00"));
    expect(slotOf(at("17:40"), slots).key).toBe(key("17:30"));
    expect(slotOf(at("17:30"), slots).key).toBe(key("17:30"));
    expect(slotOf(at("17:20"), slots).key).toBe(key("17:00"));
    expect([...rowsBySlot(rows, slots).keys()]).toEqual([key("08:00"), key("14:00"), key("16:00")]);
  });
});

describe("each entry: the work order in bold, who, then the step and what happened", () => {
  it("who, which step, what happened, and the comment as typed", () => {
    expect(entryLine(rows[0])).toBe("**WO 301235 V-7**, Schultz: Set Blinds started. Majority of the crew in site safety orientation (6am-7:15am)");
    expect(entryLine(rows[1])).toBe("**WO 301502 E-12**, Schultz: Set Blinds started.");
    expect(entryLine(rows[2])).toBe("**WO 301501 E-17**, Schultz: Pull Bundle 0% to 20%. Pulled 2/5 bundles.");
    expect(entryLine(rows[3])).toBe("**UIT-013**: Calibrate Equipment. Picked up expected back tue 10/27/26.");
    const s = (x: Partial<TimeLogRow>) => entryLine(row("09:00", { task: "E-14 - Cooler", step: "LV-009B", crew: "Maintenance", ...x }));
    expect(s({ what: "Done", pct: "40% → 100%" })).toBe("**E-14**, Maintenance: LV-009B done.");
    expect(s({ what: "Done (was on hold)", pct: "100%" })).toBe("**E-14**, Maintenance: LV-009B done (was on hold).");
    expect(s({ what: "On hold", pct: "40%", comment: "waiting on the crane" })).toBe("**E-14**, Maintenance: LV-009B on hold. Waiting on the crane.");
    expect(s({ what: "Off hold, in progress", pct: "40%" })).toBe("**E-14**, Maintenance: LV-009B back in progress (was on hold).");
    expect(s({ what: "Started", pct: "0% → 25%" })).toBe("**E-14**, Maintenance: LV-009B started, 25%.");
    expect(s({ what: "Progress corrected down", pct: "50% → 40%" })).toBe("**E-14**, Maintenance: LV-009B corrected to 40% (was 50%).");
    expect(s({ what: "Why it's behind", pct: "", comment: "no crane" })).toBe("**E-14**, Maintenance: LV-009B behind plan. No crane.");
    // The task's own name, set apart from the step: not "Clean fuel gas header Reinstall piping done".
    expect(entryLine(row("09:00", { task: "Clean fuel gas supply header to H-1", wo: "311050", step: "Reinstall piping", crew: "Maintenance (KE)", what: "Done", pct: "100%" })))
      .toBe("**WO 311050 Clean fuel gas supply header to H-1**, Maintenance (KE): Reinstall piping done.");
    expect(plainLine("**WO 311050 E-12**, Schultz: Hydro done.")).toBe("WO 311050 E-12, Schultz: Hydro done.");
    expect(boldRuns("**WO 311050 E-12**, Schultz: Hydro done.")).toEqual([{ t: "WO 311050 E-12", b: true }, { t: ", Schultz: Hydro done.", b: false }]);
  });
  it("found work, and the shift's own notes and incidents", () => {
    expect(entryLine(row("15:00", { id: undefined, task: "V-8 - Reflux Drum", step: "Welded fabrication", crew: "Maintenance (KE)", what: "Discovery found", pct: "",
      comment: "Corroded vortex break. Fabricating in house - 3 h of work · task finish +23 h · approved by TA management" })))
      .toBe("**V-8**, Maintenance (KE): Discovery found, Welded fabrication. Corroded vortex break. Fabricating in house. 3 h of work, task finish +23 h, approved by TA management.");
    expect(entryLine(row("09:00", { id: undefined, task: "Notes & actions", what: "Note", pct: "", comment: "crane on site" }))).toBe("Note: Crane on site.");
    expect(entryLine(row("09:00", { id: undefined, task: "Safety", what: "Safety incident - Near miss", pct: "", comment: "dropped wrench" }))).toBe("Safety incident - Near miss: Dropped wrench.");
  });
  it("an hour: in the order it happened, one line a step, the time when it's off the hour, the same line once, no em dash", () => {
    // Started at 2:00, 20% at 2:30: one line.
    expect(hourItems([rows[2], row("14:00", { id: "e17", task: "E-17 - Exchanger", wo: "301501", step: "Pull Bundle", crew: "Schultz" })], at("14:00"), tz))
      .toEqual(["**WO 301501 E-17**, Schultz: Pull Bundle started, 0% to 20% 2:30 PM. Pulled 2/5 bundles."]);
    // Two steps: two lines, an entry off the hour with its time.
    expect(hourItems([rows[2], rows[1]], at("14:00"), tz)).toEqual(["**WO 301502 E-12**, Schultz: Set Blinds started.", "2:30 PM **WO 301501 E-17**, Schultz: Pull Bundle 0% to 20%. Pulled 2/5 bundles."]);
    expect(hourItems([rows[1], rows[1]], at("08:00"), tz)).toEqual(["**WO 301502 E-12**, Schultz: Set Blinds started."]);
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
    expect(r[3].text).toBe("**WO 301502 E-12**, Schultz: Set Blinds started.\n**WO 301235 V-7**, Schultz: Set Blinds started. Majority of the crew in site safety orientation (6am-7:15am)");
    expect(r[9].lines).toEqual(["Bundle 2 of 5 out."]);
    // A meeting that wasn't held, taken off: gone from the log; the rest stay.
    const end = hourlyRows({ v: 2, lines: [], skip: ["meeting:end"] }, slots, at("18:00"), rows, tz);
    expect(end.some((x) => x.slot.key === "meeting:end")).toBe(false);
    expect(hourlyRows({ v: 2, lines: [] }, slots, at("18:00"), rows, tz).at(-1)?.slot.kind).toBe("handover");
    // Off on the meeting's own record: gone too.
    expect(hourlyRows({ v: 2, lines: [] }, slots, at("18:00"), rows, tz, { off: ["meeting"] })[0].slot.kind).toBe("permit");
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
  it("what moved its % that hour is said apart: nothing stuck, nothing from earlier, no 0% that didn't move", () => {
    const hr = [
      row("10:00", { id: "w1", task: "V-7 - Piping", wo: "310989", step: "Welded pipe replacements (1 of 2)", crew: "Maintenance (KE)", what: "Progress", pct: "50% → 75%", comment: "hydro complete" }),
      row("10:00", { id: "m1", task: "V-8 - Drum", wo: "310507", step: "Close Manway Cover", crew: "Schultz", what: "Started", pct: "0%" }),
      row("10:45", { id: "m2", task: "V-7 - Tower", wo: "301235", step: "Install Internal Manways", crew: "Schultz", what: "Progress", pct: "0% → 22%", comment: "13 of 57 trays installed" }),
    ];
    expect(hourParts(hr, at("10:00"), tz)).toEqual({
      lines: ["**WO 310507 V-8**, Schultz: Close Manway Cover started."],
      progress: ["**WO 310989 V-7**, Maintenance (KE): Welded pipe replacements (1 of 2) 50% to 75%. Hydro complete.", "10:45 AM **WO 301235 V-7**, Schultz: Install Internal Manways 0% to 22%. 13 of 57 trays installed."],
      closed: [],
    });
    // The same change saved twice (its comment on its own line): said once.
    expect(hourParts([hr[2], { ...hr[2], at: at("10:46"), comment: "" }], at("10:00"), tz).progress).toEqual(["10:45 AM **WO 301235 V-7**, Schultz: Install Internal Manways 0% to 22%. 13 of 57 trays installed."]);
    // The app's own "Discovery:" note on the step it follows: the discovery's line says it.
    expect(hourParts([row("10:00", { id: "i1", task: "V-7 - Tower", step: "Inspect", what: "Comment", pct: "", comment: "Discovery: flange swapped" })], at("10:00"), tz)).toEqual({ lines: [], progress: [], closed: [] });
  });
});

describe("the meetings hold no work", () => {
  it("work logged during the end meeting: its own row after it, only when there is some", () => {
    const late = [...rows, row("17:40", { id: "e9", task: "E-9 - Cooler", wo: "301600", step: "Box Up", what: "Done", pct: "100%" })];
    const r = hourlyRows({ v: 2, lines: [] }, slots, at("18:00"), late, tz);
    expect(r.slice(-2).map((x) => [x.slot.kind, x.slot.tail ?? false, x.lines])).toEqual([
      ["handover", false, []],
      ["work", true, ["5:40 PM **WO 301600 E-9**: Box Up done."]],
    ]);
    // Nothing then: no row.
    expect(hourlyRows({ v: 2, lines: [] }, slots, at("18:00"), rows, tz).some((x) => x.slot.tail)).toBe(false);
  });
  it("the end meeting shows before its time once it has something entered", () => {
    expect(hourlyRows(undefined, slots, at("15:10"), rows, tz).some((x) => x.slot.kind === "handover")).toBe(false);
    expect(hourlyRows(undefined, slots, at("15:10"), rows, tz, { show: ["meeting:end"] }).at(-1)?.slot.kind).toBe("handover");
  });
});


describe("clocks", () => {
  it("the meetings, and the row after one, always say AM or PM", () => {
    const c = slotClocks(slots, tz);
    expect(c[0]).toBe("5:30 AM");
    expect(c[1]).toBe("6:00 AM");
    expect(c[2]).toBe("7:00");
    expect(c.slice(-3)).toEqual(["5:00", "5:30 PM", "5:30 PM"]);
  });
});

describe("the line that finished a whole work order", () => {
  const mk = (p: Partial<Milestone> & { id: string }): Milestone => ({ orgId: "o", projectId: "p", name: p.id, weight: 1, status: "planned", source: "msproject", createdBy: "u", ...p } as Milestone);
  const iso = (hhmm: string) => new Date(at(hhmm)).toISOString();
  const ms = [
    mk({ id: "e13", name: "E-13 - Exchanger" }),
    mk({ id: "a", parentId: "e13", name: "Hydro", status: "completed", actualAt: iso("08:00") }),
    mk({ id: "b", parentId: "e13", name: "QC Complete", status: "completed", actualAt: iso("09:30") }),
    mk({ id: "v8", name: "V-8 - Drum" }),
    mk({ id: "c", parentId: "v8", name: "Close", status: "completed", actualAt: iso("10:00") }),
    mk({ id: "d", parentId: "v8", name: "Box up", status: "in_progress" }),
  ];
  const closes = workOrderClosers(ms);
  const done = (id: string, hhmm: string) => row(hhmm, { id, task: "E-13 - Exchanger", wo: "310505", step: id, crew: "Schultz", what: "Done", pct: "100%" });
  it("the last step done, every step of it done now: that line only", () => {
    expect(closes(done("b", "09:30"))).toBe(true);
    // An earlier step of the same work order: not the one that finished it.
    expect(closes(done("a", "08:00"))).toBe(false);
    // A started line, not a finish.
    expect(closes({ ...done("b", "09:30"), what: "Started" })).toBe(false);
    // A work order with a step still open: not finished.
    expect(closes(done("c", "10:00"))).toBe(false);
  });
  it("its line is kept apart so it can be shown in green", () => {
    const p = hourParts([done("b", "09:30"), row("09:10", { id: "x", task: "V-7", step: "Pull", crew: "Ancon", what: "Started" })], at("09:00"), tz, closes);
    expect(p.closed).toEqual(["9:30 AM **WO 310505 E-13**, Schultz: b done."]);
    expect(p.lines).toContain(p.closed[0]);
  });
});

describe("lunch with nothing logged in its hour", () => {
  it("one row: the break, standing for its hour", () => {
    const withLunch = hourSlots(shift, 30, [{ at: at("11:00"), minutes: 30, label: "Lunch" }]);
    const r = hourlyRows({ v: 2, lines: [] }, withLunch, at("18:00"), rows, tz);
    expect(r.filter((x) => x.slot.start === at("11:00")).map((x) => x.slot.kind)).toEqual(["break"]);
    expect(r.find((x) => x.slot.kind === "break")?.hour?.key).toBe(key("11:00"));
    // Something logged in the hour: both rows.
    const busy = hourlyRows({ v: 2, lines: [] }, withLunch, at("18:00"), [...rows, row("11:40", { id: "z", task: "V-9", step: "Pull", crew: "Ancon", what: "Started" })], tz);
    expect(busy.filter((x) => x.slot.start === at("11:00")).map((x) => x.slot.kind)).toEqual(["work", "break"]);
  });
});


describe("an hour typed into", () => {
  const qc = (hhmm: string) => row(hhmm, { id: "q", task: "E-13 - Cooler", wo: "310505", step: "QC Complete", crew: "Schultz", what: "Done", pct: "100%" });
  const nine = (n: HourlyNotes | undefined, rows: TimeLogRow[], closes?: (r: TimeLogRow) => boolean) =>
    hourlyRows(n, slots, at("18:00"), rows, tz, { closes }).find((x) => x.slot.start === at("09:00") && x.slot.kind === "work")!;
  it("saves what was added and what was taken out or reworded; nothing of theirs is the entries", () => {
    const auto = ["**WO 1 V-7**, Ancon: Pull started.", "**WO 2 E-4**, Schultz: QC done."];
    expect(typedHour(auto.join("\n"), auto)).toBeNull();
    expect(typedHour(`${auto[0]}\nCrane on site.`, auto)).toEqual({ extras: ["Crane on site."], hide: [auto[1]] });
    expect(typedHour("**WO 2 E-4**, Schultz: QC done, all signed.", auto)).toEqual({ extras: ["**WO 2 E-4**, Schultz: QC done, all signed."], hide: auto });
  });
  it("the work order's lines stay live: a time fixed on it shows, what was typed stays", () => {
    const typed: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("09:00"), text: "Crane on site.", hand: true, own: true, hide: [], src: "" }] };
    expect(nine(typed, [qc("09:30")]).lines).toEqual(["9:30 AM **WO 310505 E-13**, Schultz: QC Complete done.", "Crane on site."]);
    // Moved to 10:15 on the work order: gone from 9:00, the note stays.
    expect(nine(typed, [qc("10:15")]).lines).toEqual(["Crane on site."]);
  });
  it("a line taken out stays out until it changes on the work order", () => {
    const line = "9:30 AM **WO 310505 E-13**, Schultz: QC Complete done.";
    const typed: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("09:00"), text: "", hand: true, own: true, hide: [line], src: line }] };
    expect(nine(typed, [qc("09:30")]).lines).toEqual([]);
    expect(nine(typed, [qc("09:40")]).lines).toEqual(["9:40 AM **WO 310505 E-13**, Schultz: QC Complete done."]);
  });
  it("a reworded closing line keeps its green", () => {
    const line = "9:30 AM **WO 310505 E-13**, Schultz: QC Complete done.";
    const mine = "**WO 310505 E-13**, Schultz: QC done, all signed.";
    const typed: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("09:00"), text: mine, hand: true, own: true, hide: [line], src: line }] };
    const r = nine(typed, [qc("09:30")], (x) => x.id === "q");
    expect(r.lines).toEqual([mine]);
    expect(r.closed).toEqual([mine]);
    expect(typedClosed(["Hydro on WO 310505 started", "WO 310505 E-13 QC complete, signed off"], [line])).toEqual(["WO 310505 E-13 QC complete, signed off"]);
  });
  it("a work order line typed here that isn't on the work order now is said, to remove or keep", () => {
    // Typed earlier (the whole hour): a copied line whose entry moved away.
    const earlier: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("09:00"), text: "Staging spools.\n9:30 AM **WO 310505 E-13**, Schultz: QC Complete done.", hand: true }] };
    const r = nine(earlier, [qc("10:15")]);
    expect(r.lines).toEqual(["Staging spools.", "9:30 AM **WO 310505 E-13**, Schultz: QC Complete done."]);
    expect(r.stale).toBe(true);
    expect(r.mismatch).toEqual(["9:30 AM **WO 310505 E-13**, Schultz: QC Complete done."]);
    // Typed since: said once the entries change after it was typed.
    const mine = "**WO 310505 E-13**, seals going back in.";
    const since = (src: string): HourlyNotes => ({ v: 2, lines: [{ id: "t", at: at("09:00"), text: mine, hand: true, own: true, hide: [], src }] });
    const now = nine(undefined, [qc("09:30")]).said;
    expect(nine(since(now), [qc("09:30")]).stale).toBeUndefined();
    expect(nine(since(now), [qc("09:50")]).mismatch).toEqual([mine]);
  });
});
