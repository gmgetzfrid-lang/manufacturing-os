// lib/__tests__/reminderParse.test.ts
//
// Pins the natural-language reminder parser. Every assertion checks the
// resolved LOCAL Y/M/D/H/M (via new Date(result.remindAt) getters, NOT the
// raw ISO string) so the suite is timezone-independent, plus the hasTime
// flag. NOW is fixed for determinism.
//
// Calendar anchor: Fri Jun 19 2026 10:00 local.
//   - Mon Jun 22 2026 is the upcoming Monday.
//   - Jun has 30 days; Jun 15 is already past at NOW.

import { describe, it, expect } from "vitest";
import { parseReminder, type ParsedReminder } from "@/lib/reminderParse";

const NOW = new Date(2026, 5, 19, 10, 0, 0); // Fri Jun 19 2026 10:00 local

// Sanity: confirm our calendar assumptions hold against the real calendar.
describe("calendar anchor sanity", () => {
  it("Jun 19 2026 is a Friday", () => {
    expect(NOW.getDay()).toBe(5);
  });
  it("Jun 22 2026 is a Monday", () => {
    expect(new Date(2026, 5, 22).getDay()).toBe(1);
  });
});

// Resolve and assert local parts. `r` may be null; we assert non-null first.
function expectAt(
  r: ParsedReminder | null,
  y: number,
  mo: number, // 0-based month
  d: number,
  h: number,
  min: number,
  hasTime: boolean,
): void {
  expect(r).not.toBeNull();
  const dt = new Date((r as ParsedReminder).remindAt);
  expect([
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate(),
    dt.getHours(),
    dt.getMinutes(),
  ]).toEqual([y, mo, d, h, min]);
  expect((r as ParsedReminder).hasTime).toBe(hasTime);
}

const run = (text: string) => parseReminder(text, { now: NOW });

describe("relative offsets", () => {
  it('"in 2 hours" -> Jun 19 12:00, hasTime', () => {
    expectAt(run("remind me in 2 hours to call Joe"), 2026, 5, 19, 12, 0, true);
  });
  it('"in 30 minutes" -> Jun 19 10:30, hasTime', () => {
    expectAt(run("in 30 minutes"), 2026, 5, 19, 10, 30, true);
  });
  it('"in 15 min" -> Jun 19 10:15, hasTime', () => {
    expectAt(run("ping me in 15 min"), 2026, 5, 19, 10, 15, true);
  });
  it('"in 30 mins" -> Jun 19 10:30', () => {
    expectAt(run("in 30 mins"), 2026, 5, 19, 10, 30, true);
  });
  it('"in 3 days" -> Jun 22 09:00, hasTime false', () => {
    expectAt(run("in 3 days"), 2026, 5, 22, 9, 0, false);
  });
  it('"in 2 weeks" -> Jul 3 09:00, hasTime false', () => {
    expectAt(run("in 2 weeks"), 2026, 6, 3, 9, 0, false);
  });
  it('"in an hour" -> Jun 19 11:00, hasTime', () => {
    expectAt(run("in an hour"), 2026, 5, 19, 11, 0, true);
  });
  it('"in a hour" -> Jun 19 11:00, hasTime', () => {
    expectAt(run("in a hour"), 2026, 5, 19, 11, 0, true);
  });
  it('"in a couple hours" -> Jun 19 12:00 (=2h)', () => {
    expectAt(run("in a couple hours"), 2026, 5, 19, 12, 0, true);
  });
  it('"in a couple of hours" -> Jun 19 12:00 (=2h)', () => {
    expectAt(run("in a couple of hours"), 2026, 5, 19, 12, 0, true);
  });
  it('"in a few hours" -> Jun 19 13:00 (=3h)', () => {
    expectAt(run("in a few hours"), 2026, 5, 19, 13, 0, true);
  });
  it('"in a day" -> Jun 20 09:00, hasTime false', () => {
    expectAt(run("in a day"), 2026, 5, 20, 9, 0, false);
  });
  it('"in a week" -> Jun 26 09:00, hasTime false', () => {
    expectAt(run("in a week"), 2026, 5, 26, 9, 0, false);
  });
});

describe("end of day family", () => {
  it('"by end of day" -> Jun 19 17:00, hasTime', () => {
    expectAt(run("get this done by end of day"), 2026, 5, 19, 17, 0, true);
  });
  it('"end of day" -> Jun 19 17:00', () => {
    expectAt(run("end of day"), 2026, 5, 19, 17, 0, true);
  });
  it('"end of the day" -> Jun 19 17:00', () => {
    expectAt(run("wrap up by end of the day"), 2026, 5, 19, 17, 0, true);
  });
  it('"before end of day" -> Jun 19 17:00', () => {
    expectAt(run("before end of day"), 2026, 5, 19, 17, 0, true);
  });
  it('"eod" -> Jun 19 17:00', () => {
    expectAt(run("need it eod"), 2026, 5, 19, 17, 0, true);
  });
  it('"by eod" -> Jun 19 17:00', () => {
    expectAt(run("by eod please"), 2026, 5, 19, 17, 0, true);
  });
  it("rolls to tomorrow when dayEndHour already passed", () => {
    // now is 18:00, dayEndHour 17 -> tomorrow 17:00
    const late = new Date(2026, 5, 19, 18, 0, 0);
    const r = parseReminder("end of day", { now: late });
    expect(r).not.toBeNull();
    const dt = new Date((r as ParsedReminder).remindAt);
    expect([dt.getMonth(), dt.getDate(), dt.getHours()]).toEqual([5, 20, 17]);
  });
});

describe("tomorrow", () => {
  it('"tomorrow" -> Jun 20 09:00, hasTime false', () => {
    expectAt(run("tomorrow"), 2026, 5, 20, 9, 0, false);
  });
  it('"tomorrow at 3pm" -> Jun 20 15:00, hasTime', () => {
    expectAt(run("tomorrow at 3pm"), 2026, 5, 20, 15, 0, true);
  });
  it('"tomorrow at 15:00" -> Jun 20 15:00, hasTime', () => {
    expectAt(run("tomorrow at 15:00"), 2026, 5, 20, 15, 0, true);
  });
  it('"tomorrow 3:30pm" -> Jun 20 15:30, hasTime', () => {
    expectAt(run("tomorrow 3:30pm"), 2026, 5, 20, 15, 30, true);
  });
});

describe("today at <time>", () => {
  it('"today at 2pm" -> Jun 19 14:00, hasTime', () => {
    expectAt(run("today at 2pm"), 2026, 5, 19, 14, 0, true);
  });
  it('"today at 8am" keeps today even though it is past', () => {
    expectAt(run("today at 8am"), 2026, 5, 19, 8, 0, true);
  });
});

describe("next week", () => {
  it('"next week" -> Jun 26 09:00, hasTime false', () => {
    expectAt(run("let us revisit next week"), 2026, 5, 26, 9, 0, false);
  });
});

describe("weekdays", () => {
  it('"monday" -> Jun 22 09:00 (upcoming Monday), hasTime false', () => {
    expectAt(run("monday"), 2026, 5, 22, 9, 0, false);
  });
  it('"next monday" -> Jun 29 09:00 (upcoming + 7), hasTime false', () => {
    expectAt(run("next monday"), 2026, 5, 29, 9, 0, false);
  });
  it('"friday" today-is-Friday -> Jun 26 (next week), hasTime false', () => {
    expectAt(run("friday"), 2026, 5, 26, 9, 0, false);
  });
  it('"monday at 2pm" -> Jun 22 14:00, hasTime', () => {
    expectAt(run("monday at 2pm"), 2026, 5, 22, 14, 0, true);
  });
  it('"next friday" -> Jul 3 (Friday + 7 + this-week roll), hasTime false', () => {
    // today is Friday -> upcoming Friday is Jun 26, +7 = Jul 3
    expectAt(run("next friday"), 2026, 6, 3, 9, 0, false);
  });
});

describe("bare clock time", () => {
  it('"at 3pm" (future) -> Jun 19 15:00, hasTime', () => {
    expectAt(run("at 3pm"), 2026, 5, 19, 15, 0, true);
  });
  it('"at 8am" (past 10:00) -> Jun 20 08:00, hasTime', () => {
    expectAt(run("at 8am"), 2026, 5, 20, 8, 0, true);
  });
  it('"at 3:30 pm" -> Jun 19 15:30, hasTime', () => {
    expectAt(run("at 3:30 pm"), 2026, 5, 19, 15, 30, true);
  });
  it('"at 15:00" -> Jun 19 15:00, hasTime', () => {
    expectAt(run("at 15:00"), 2026, 5, 19, 15, 0, true);
  });
  it('"at noon" -> Jun 19 12:00, hasTime', () => {
    expectAt(run("at noon"), 2026, 5, 19, 12, 0, true);
  });
  it('"at midnight" (past nothing; 00:00 is past today) -> Jun 20 00:00', () => {
    // 00:00 today < 10:00 now -> rolls to tomorrow midnight
    expectAt(run("at midnight"), 2026, 5, 20, 0, 0, true);
  });
});

describe("explicit calendar dates", () => {
  it('ISO "2026-07-01" -> Jul 1 2026 09:00, hasTime false', () => {
    expectAt(run("2026-07-01"), 2026, 6, 1, 9, 0, false);
  });
  it('ISO with time "2026-07-01 at 14:30" -> Jul 1 14:30, hasTime', () => {
    expectAt(run("2026-07-01 at 14:30"), 2026, 6, 1, 14, 30, true);
  });
  it('"july 1" -> Jul 1 2026 09:00, hasTime false', () => {
    expectAt(run("follow up with Bob on july 1 about the valve"), 2026, 6, 1, 9, 0, false);
  });
  it('"jul 1" -> Jul 1 2026 09:00', () => {
    expectAt(run("jul 1"), 2026, 6, 1, 9, 0, false);
  });
  it('"july 1st" -> Jul 1 2026 09:00', () => {
    expectAt(run("july 1st"), 2026, 6, 1, 9, 0, false);
  });
  it('"1 july" -> Jul 1 2026 09:00', () => {
    expectAt(run("1 july"), 2026, 6, 1, 9, 0, false);
  });
  it('"on july 1" -> Jul 1 2026 09:00', () => {
    expectAt(run("on july 1"), 2026, 6, 1, 9, 0, false);
  });
  it('"july 1 at 3pm" -> Jul 1 15:00, hasTime', () => {
    expectAt(run("july 1 at 3pm"), 2026, 6, 1, 15, 0, true);
  });
  it('past-month "january 5" bumps to next year -> Jan 5 2027 09:00', () => {
    expectAt(run("january 5"), 2027, 0, 5, 9, 0, false);
  });
  it('"7/1" (m/d) -> Jul 1 2026 09:00, hasTime false', () => {
    expectAt(run("7/1"), 2026, 6, 1, 9, 0, false);
  });
  it('"7/1/2026" (m/d/y) -> Jul 1 2026 09:00', () => {
    expectAt(run("7/1/2026"), 2026, 6, 1, 9, 0, false);
  });
  it('"7/1 at 2pm" -> Jul 1 14:00, hasTime', () => {
    expectAt(run("7/1 at 2pm"), 2026, 6, 1, 14, 0, true);
  });
  it('past "1/5" bumps to next year -> Jan 5 2027 09:00', () => {
    expectAt(run("1/5"), 2027, 0, 5, 9, 0, false);
  });
  it('"on the 15th" (past Jun 15) -> Jul 15 09:00, hasTime false', () => {
    expectAt(run("on the 15th"), 2026, 6, 15, 9, 0, false);
  });
  it('"the 25th" (future this month) -> Jun 25 09:00', () => {
    expectAt(run("the 25th"), 2026, 5, 25, 9, 0, false);
  });
});

describe("no scheduling intent", () => {
  it("returns null for a plain journal sentence", () => {
    expect(run("today I looked at the pump and it was fine")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(run("")).toBeNull();
  });
  it("returns null for unrelated text", () => {
    expect(run("the valve gasket needs replacing")).toBeNull();
  });
});

describe("matchedText", () => {
  it('extracts "in 2 hours" from a sentence', () => {
    const r = run("remind me in 2 hours to call Joe");
    expect(r?.matchedText).toBe("in 2 hours");
  });
  it('extracts the july date from a sentence', () => {
    const r = run("follow up with Bob on july 1 about the valve");
    expect(r?.matchedText).toContain("july 1");
  });
});

describe("custom dayStart / dayEnd hours", () => {
  it("honors dayEndHour for end of day", () => {
    const r = parseReminder("end of day", { now: NOW, dayEndHour: 18 });
    const dt = new Date((r as ParsedReminder).remindAt);
    expect([dt.getDate(), dt.getHours()]).toEqual([19, 18]);
  });
  it("honors dayStartHour for tomorrow", () => {
    const r = parseReminder("tomorrow", { now: NOW, dayStartHour: 8 });
    const dt = new Date((r as ParsedReminder).remindAt);
    expect([dt.getDate(), dt.getHours()]).toEqual([20, 8]);
  });
});
