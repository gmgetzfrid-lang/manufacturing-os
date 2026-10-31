// The meeting that starts each shift: who attended from each crew, head
// counts, the safety topic; one record per meeting, on the shift it starts.

import { describe, it, expect } from "vitest";
import { crewNames, withName, renamed, withoutName, setNames, meetingLines, meetingCrews, totalOnSite, meetingRows, meetingTitle, knownNames, earlierMeetingLines } from "@/lib/shiftMeeting";
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
      "Schultz, 10 on site: Mike Leonard, Joe Brown", "Ancon, 4 on site", "Ops: Ray", "Total on site: 14",
      "Safety topic: Line of fire", "Crane inspection at 7 PM", "Gate 3 closed",
    ]);
    // One crew counted: no total line (it would say the same thing).
    expect(meetingLines({ crews: { Schultz: { headcount: 10 } } }, 0)).toEqual(["Schultz, 10 on site"]);
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
