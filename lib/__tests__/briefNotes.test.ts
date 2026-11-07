// The shift notes in the plant's shift update: short, one paragraph a time,
// crew first, no work order numbers; an hour typed over said as typed.

import { describe, it, expect } from "vitest";
import { briefNotes, briefWhat, hourSlots, hourlyRows, type HourlyNotes } from "@/lib/shiftHourly";
import type { TimeLogRow } from "@/lib/timeLog";

const tz = "America/Los_Angeles";
const at = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00-08:00`);
const row = (hhmm: string, x: Partial<TimeLogRow>): TimeLogRow => ({
  at: at(hhmm), id: "s", shift: "Mon, Nov 2 · Day", task: "", wo: "", step: "", crew: "", what: "Started", pct: "0%", comment: "", enteredBy: "", enteredAt: null, ...x,
});
const shift = { start: at("06:00"), end: at("18:00") };
const slots = hourSlots(shift, 30, [{ at: at("09:00"), minutes: 15, label: "Break" }]);

describe("briefWhat", () => {
  it("the equipment and step in a few words", () => {
    expect(briefWhat("PSVs", "PSV-210 - V-12B Discharge Bottle Pressure Relief")).toBe("PSV-210");
    expect(briefWhat("E-02 - De-Butanizer Condenser", "Set Blinds; Verify LOTO")).toBe("E-02 Set Blinds; Verify LOTO");
    expect(briefWhat("WO 310661", "Pull V-12A - 2nd Stage Suction Bottle")).toBe("Pull V-12A");
    expect(briefWhat("LRU VFD Compressor Replacement (AFE# 25206)", "Old VFD Removal")).toBe("LRU VFD Compressor Replacement Old VFD Removal");
    expect(briefWhat("V-24", "Hydroblast V-24 Shell")).toBe("Hydroblast V-24 Shell");
  });
});

describe("briefNotes", () => {
  const entries = [
    row("07:00", { id: "a", task: "V-4", wo: "1", step: "Clean Components", crew: "Ancon" }),
    row("08:00", { id: "b", task: "V-2", wo: "2", step: "Inspect Bottom Flange", crew: "MI (KE)" }),
    row("08:00", { id: "c", task: "E-23", wo: "3", step: "Hydro", crew: "Schultz", what: "Progress", pct: "0% → 50%", comment: "up on pressure" }),
    row("08:35", { id: "d", task: "PSVs", wo: "310728", step: "PSV-210 - V-12B Discharge Bottle Pressure Relief", crew: "Maintenance (KE)", what: "Done" }),
    row("09:00", { id: "e", task: "PSVs", wo: "310733", step: "PSV-607 - E-26 Membrane Residue Cooler", crew: "Maintenance (KE)" }),
    row("09:00", { id: "e", task: "PSVs", wo: "310733", step: "PSV-607 - E-26 Membrane Residue Cooler", crew: "Maintenance (KE)", what: "Progress", pct: "0% → 25%" }),
  ];
  const hr = (n?: HourlyNotes) => hourlyRows(n ?? null, slots, at("18:00"), entries, tz);
  it("one paragraph a time, each entry at its own half hour, crew first, no WO numbers", () => {
    const out = briefNotes(hr(), entries, slots, tz);
    expect(out[0]).toEqual({ clock: "5:30 AM", text: "Shift change meeting." });
    const by = Object.fromEntries(out.map((x) => [x.clock, x.text]));
    expect(by["7:00"]).toBe("Ancon: V-4 Clean Components started");
    expect(by["8:00"]).toBe("MI (KE): V-2 Inspect Bottom Flange started, Schultz: E-23 Hydro 0% to 50%. Up on pressure.");
    expect(by["8:30"]).toBe("Maintenance (KE): PSV-210 done");
    // The break and what happened at its time: one paragraph.
    expect(by["9:00"]).toBe("Maintenance (KE): PSV-607 started, 0% to 25%, Break, 15 min.");
    expect(out.map((x) => x.text).join(" ")).not.toMatch(/WO |310728/);
    expect(new Set(out.map((x) => x.clock)).size).toBe(out.length);
    expect(out[out.length - 1]).toEqual({ clock: "5:30 PM", text: "Shift change meeting." });
    expect(out.map((x) => x.clock)).toEqual(["5:30 AM", "7:00", "8:00", "8:30", "9:00", "5:30 PM"]);
  });
  it("what was typed into an hour, as typed, after its entries", () => {
    const typed: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("07:00"), text: "Ancon cleaning V-4 components", hand: true, own: true }] };
    const out = briefNotes(hr(typed), entries, slots, tz);
    expect(out.find((x) => x.clock === "7:00")?.text).toBe("Ancon: V-4 Clean Components started, Ancon cleaning V-4 components");
  });
  it("an hour where an entry was taken out: said as it stands", () => {
    const typed: HourlyNotes = { v: 2, lines: [{ id: "t", at: at("07:00"), text: "Ancon cleaning V-4 components", hand: true, own: true, hide: ["**WO 1 V-4**, Ancon: Clean Components started."] }] };
    const out = briefNotes(hr(typed), entries, slots, tz);
    expect(out.find((x) => x.clock === "7:00")?.text).toBe("Ancon cleaning V-4 components");
  });
});
