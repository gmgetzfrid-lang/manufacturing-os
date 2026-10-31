// The meeting that starts each shift: who attended from each crew, head
// counts, the safety topic; one record per meeting, on the shift it starts.

import { describe, it, expect } from "vitest";
import { crewNames, withName, renamed, withoutName, setNames, meetingLines, meetingParts, meetingCrews, totalOnSite, meetingRows, meetingTitle, knownNames, earlierMeetingLines, rosterFor, meetingRecord, hasOwnRoster } from "@/lib/shiftMeeting";
import type { ShiftRecord } from "@/lib/shiftRecord";

describe("names at the meeting", () => {
  it("added once, changed in place, removed; the old supervisor counts as the first name", () => {
    expect(withName(["Mike Leonard"], "  joe   brown ")).toEqual(["Mike Leonard", "joe brown"]);
    expect(withName(["Mike Leonard"], "mike leonard")).toEqual(["Mike Leonard"]);
    expect(withName(["Mike Leonard"], "   ")).toEqual(["Mike Leonard"]);
    expect(renamed(["A", "B", "C"], "B", "Bea")).toEqual(["A", "Bea", "C"]);
    expect(renamed(["A", "B"], "B", "a")).toEqual(["A"]);
    expect(renamed(["A", "B"], "Z", "Q")).toEqual(["A", "B"]);
    expect(withoutName(["A", "B"], "A")).toEqual(["B"]);
    expect(crewNames({ supervisor: "Mike" })).toEqual(["Mike"]);
    expect(crewNames({ names: [], supervisor: "Mike" })).toEqual([]);
    expect(setNames({ supervisor: "Mike", headcount: 9 }, (n) => withName(n, "Joe"))).toEqual({ headcount: 9, names: ["Mike", "Joe"] });
  });
});

describe("the meeting as the log says it", () => {
  const rec: ShiftRecord = {
    crews: { Ancon: { headcount: 4 }, Schultz: { names: ["Mike Leonard", "Joe Brown"], headcount: 10 }, Ops: { names: ["Ray"] }, Blank: {} },
    meeting: { safety: "Line of fire", note: "Crane inspection at 7 PM\n\nGate 3 closed" },
  };
  it("each crew with someone named or counted, the plan's crews first; the total; the topic; the notes", () => {
    expect(meetingCrews(rec, ["Schultz"]).map((x) => x.crew)).toEqual(["Schultz", "Ancon", "Ops"]);
    expect(meetingLines(rec, 0, ["Schultz"])).toEqual([
      "Schultz: supervisor Mike Leonard, Joe Brown, 10 employees on site", "Ancon: 4 employees on site", "Ops: supervisor Ray", "Total on site: 14",
      "Safety topic: Line of fire", "Crane inspection at 7 PM", "Gate 3 closed",
    ]);
    // As a table: resource, supervisor, employees on site.
    expect(meetingParts(rec, 0, ["Schultz"])).toEqual({
      rows: [{ crew: "Schultz", supervisor: "Mike Leonard, Joe Brown", onSite: 10 }, { crew: "Ancon", supervisor: "", onSite: 4 }, { crew: "Ops", supervisor: "Ray", onSite: null }],
      total: 14, safety: "Line of fire", notes: ["Crane inspection at 7 PM", "Gate 3 closed"],
    });
    // One crew counted: no total line (it would say the same thing).
    expect(meetingLines({ crews: { Schultz: { headcount: 1 } } }, 0)).toEqual(["Schultz: 1 employee on site"]);
    expect(totalOnSite([{ headcount: null }])).toBeNull();
    expect(totalOnSite([{ headcount: 0 }, { headcount: 3 }])).toBe(3);
    expect(meetingLines(undefined, 0)).toEqual([]);
  });
  it("what was typed at the meeting before it had its own place still shows", () => {
    const old: ShiftRecord = { hourly: { v: 2, lines: [{ id: "a", at: 50, text: "Talked about heat stress", hand: true }, { id: "b", at: 150, text: "Hour note", hand: true }] } };
    expect(earlierMeetingLines(old, 100)).toEqual(["Talked about heat stress"]);
    expect(meetingLines(old, 100)).toEqual(["Talked about heat stress"]);
  });
  it("off when not held; the end meeting shows early once something is entered", () => {
    expect(meetingRows({ meeting: { off: true } }, undefined, 0)).toEqual({ off: ["meeting"], show: [] });
    expect(meetingRows(undefined, rec, 0)).toEqual({ off: [], show: ["meeting:end"] });
    expect(meetingRows(undefined, { meeting: { off: true } }, 0)).toEqual({ off: ["meeting:end"], show: [] });
    expect(meetingTitle("day")).toBe("Day shift meeting");
    expect(meetingTitle("night")).toBe("Night shift meeting");
  });
  it("names entered before, by crew, to pick from", () => {
    const all = new Map<string, ShiftRecord>([["a", rec], ["b", { crews: { Schultz: { names: ["Al Diaz", "joe brown"] }, Ops: { supervisor: "Kim" } } }]]);
    expect(knownNames(all)).toEqual({ Schultz: ["Al Diaz", "Joe Brown", "Mike Leonard"], Ops: ["Kim", "Ray"] });
  });
});

describe("names and head counts carry from the last same shift until changed", () => {
  const recs = new Map<string, ShiftRecord>([
    ["2026-10-28:day", { crews: { Schultz: { names: ["Mike"], headcount: 10 } } }],
    ["2026-10-28:night", { crews: { Schultz: { names: ["Al"], headcount: 6 } } }],
    ["2026-10-29:day", { meeting: { safety: "Heat" } }],
    ["2026-10-30:day", { crews: { Schultz: { names: ["Sub Sam"], headcount: 9 } } }],
    ["2026-11-01:day", { meeting: { ownCrews: true }, crews: {} }],
  ]);
  it("day to day, night to night; a shift's own change is its own", () => {
    expect(rosterFor(recs, "2026-10-29:day")).toEqual({ crews: { Schultz: { names: ["Mike"], headcount: 10 } }, from: "2026-10-28:day" });
    expect(rosterFor(recs, "2026-10-29:night").from).toBe("2026-10-28:night");
    expect(rosterFor(recs, "2026-10-30:day")).toEqual({ crews: { Schultz: { names: ["Sub Sam"], headcount: 9 } }, from: null });
    expect(rosterFor(recs, "2026-10-31:day").from).toBe("2026-10-30:day");
    // Everyone taken off on a shift: that's its own (nothing carried in).
    expect(rosterFor(recs, "2026-11-01:day")).toEqual({ crews: {}, from: null });
    expect(rosterFor(recs, "2026-11-02:day").from).toBe("2026-11-01:day");
    // Nothing earlier: nothing.
    expect(rosterFor(recs, "2026-10-27:day")).toEqual({ crews: {}, from: null });
  });
  it("the record as the meeting reads it keeps its own topic and notes", () => {
    const m = meetingRecord(recs, "2026-10-29:day");
    expect(m.from).toBe("2026-10-28:day");
    expect(m.record).toEqual({ meeting: { safety: "Heat" }, crews: { Schultz: { names: ["Mike"], headcount: 10 } } });
    expect(hasOwnRoster(recs.get("2026-10-29:day"))).toBe(false);
    expect(hasOwnRoster({ meeting: { ownCrews: true } })).toBe(true);
  });
});

