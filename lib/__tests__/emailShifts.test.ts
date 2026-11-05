import { describe, it, expect } from "vitest";
import { splitShifts, partText, headerShift, sectionsFound, DEFAULT_OMIT } from "@/lib/emailShifts";
import type { ShiftTimes } from "@/lib/shiftReport";

const TZ = "America/Los_Angeles";
const times = { dayStart: "06:00", nightStart: "18:00" } as unknown as ShiftTimes;
const NOW = Date.parse("2026-11-05T09:00:00-08:00");

// The shape of a real update email (names changed).
const EMAIL = `Pat Lee

A Person;
B Person;
Good evening everyone,
    Please see today's turnaround update below:

LRU Turnaround November 2026                                         November 4, 2026 6:00 AM – 6:00 PM
5:30 AM Meeting Attendees
Operations – A Person
Safety
No Safety Incidents
Safety Topics – SIMOPS, crane work
Work to be Completed After 5:30 AM Meeting
Schultz
Continue tunneling V-1
Work Completed Between 5:30 AM an 6:00 PM
Schultz
Continued tunneling V-1 (13 trays removed on shift, 37 total removed)
Follow-Up Items
Determine if not reinstalling V-3 trays is a viable option.
Shift Notes
5:30 AM – Shift change meeting.
4:30 – 5 trays remaining on V-1, 11 trays remaining in V-3.
Personnel Headcount
Schultz – 30

From nights 11/3/26 6:00 PM - 11/4/26 6:00 AM:

Goals For Tonight:
WO# 310359 -V-1- Continue pulling trays
 7:00PM-
WO# 310359- V-1- Setting up to remove trays
12:00
WO# 310352- V-2- MW open
Overall Status On Tonight's Progress:
WO# 310359 -V-1- 5 Trays out overall

Thanks,

From: Pat Lee <pat@example.com>
Sent: Tuesday, November 3, 2026 5:56 PM
To: A Person <a@example.com>; B Person <b@example.com>
Subject: Re: LRU TAR - Monday November 2nd, 2026 - UPDATE

LRU Turnaround November 2026                                         November 3, 2026 6:00 AM – 6:00 PM
Work Completed Between 5:30 AM an 6:00 PM
Began tunneling V-3, (3 trays removed on shift, 3 total pulled)

From nights 11/2/26 6:00 PM - 11/3/26 6:00 AM:

 7:00PM-
WO# 310456 -E2- Pulling bundle 20%
`;

describe("splitting a pasted email into its shifts", () => {
  const parts = splitShifts(EMAIL, TZ, times, NOW)!;
  it("finds each shift by its own header, the email's Sent and Subject lines aside", () => {
    expect(parts.map((p) => p.key)).toEqual(["2026-11-04:day", "2026-11-03:night", "2026-11-03:day", "2026-11-02:night"]);
  });
  it("tells the sections apart; the hour by hour starts with its first time", () => {
    const day = parts[0].sections.map((s) => s.kind);
    expect(day).toEqual(["people", "safety", "plan", "done", "followup", "notes", "people"]);
    expect(parts[1].sections.map((s) => s.kind)).toEqual(["plan", "notes", "done"]);
    expect(parts[3].sections.map((s) => s.kind)).toEqual(["notes"]);
  });
  it("leaves out the plan, people and safety by default", () => {
    const t = partText(parts[0], DEFAULT_OMIT);
    expect(t).toContain("37 total removed");
    expect(t).toContain("4:30 – 5 trays remaining");
    expect(t).not.toContain("Continue tunneling V-1");
    expect(t).not.toContain("SIMOPS");
    expect(t).not.toContain("Schultz – 30");
    const night = partText(parts[1], DEFAULT_OMIT);
    expect(night).toContain("Setting up to remove trays");
    expect(night).not.toContain("Continue pulling trays");
  });
  it("never reads the email's own header lines or recipients", () => {
    const all = parts.map((p) => partText(p, [])).join("\n");
    expect(all).not.toMatch(/example\.com|Sent:|Subject:/);
  });
  it("counts the sections found", () => {
    expect(sectionsFound(parts).map((s) => s.kind)).toEqual(["done", "notes", "followup", "other", "plan", "people", "safety"].filter((k) => sectionsFound(parts).some((s) => s.kind === k)));
  });
  it("a note with no shift headers isn't split", () => {
    expect(splitShifts("E-02 head off. V-1 trays 50.", TZ, times, NOW)).toBeNull();
  });
});

describe("header lines", () => {
  it("a date with a shift's time range, or with a shift word", () => {
    expect(headerShift("November 4, 2026 6:00 AM – 6:00 PM", TZ, times, NOW)?.kind).toBe("day");
    expect(headerShift("Nights 11/3", TZ, times, NOW)).toMatchObject({ kind: "night", dayKey: "2026-11-03" });
  });
  it("not a header: a date alone, a sent time, a span of days", () => {
    expect(headerShift("Sent: Tuesday, November 3, 2026 5:56 PM", TZ, times, NOW)).toBeNull();
    expect(headerShift("Monday November 2nd, 2026", TZ, times, NOW)).toBeNull();
    expect(headerShift("Expected Timeline: Monday 11/2/26 @ 6:00AM to Sunday 11/8/26 @ 4:00PM", TZ, times, NOW)).toBeNull();
  });
});
