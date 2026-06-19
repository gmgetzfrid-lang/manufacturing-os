// lib/reminderParse.ts
//
// Natural-language "when should I be reminded?" parser for the scratchpad.
//
// PURE: no imports, no side effects, no external deps. Fully deterministic
// when given a fixed `now`. Everything is computed in LOCAL time off the
// provided `now` (Date setHours/setDate math) and emitted as an ISO string
// via Date.prototype.toISOString().
//
// Given a free-form line ("remind me in 2 hours to call Joe", "follow up
// with Bob on july 1 about the valve") it scans for ONE scheduling phrase,
// resolves it to a FUTURE local datetime, and returns it. Returns null when
// there is no scheduling/reminder phrase at all.

export interface ParsedReminder {
  /** ISO datetime string (new Date(...).toISOString()). */
  remindAt: string;
  /** The substring from the input that triggered the parse. */
  matchedText: string;
  /** true when an explicit clock time was given; false when defaulted. */
  hasTime: boolean;
}

interface Options {
  now?: Date;
  dayStartHour?: number;
  dayEndHour?: number;
}

// --- small helpers -----------------------------------------------------------

/** Clone a date and set h:m:0:0 on it. */
function at(base: Date, hour: number, minute: number): Date {
  const d = new Date(base.getTime());
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Clone `base` and add `days` whole days (via setDate, so DST-safe-ish). */
function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

interface ClockTime {
  hour: number;
  minute: number;
}

// Matches a clock time: "3", "3pm", "3 pm", "3:30pm", "15:00", "noon",
// "midnight". Returns null if the string isn't a time. Used both to test a
// candidate and to consume a trailing "at <time>".
function parseClockTime(raw: string | null | undefined): ClockTime | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "noon") return { hour: 12, minute: 0 };
  if (s === "midnight") return { hour: 0, minute: 0 };

  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];

  if (minute > 59) return null;

  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (ap === "pm" && hour !== 12) hour += 12; // 12pm = noon (12:00)
    if (ap === "am" && hour === 12) hour = 0; // 12am = midnight (00:00)
  } else {
    if (hour > 23) return null;
  }
  return { hour, minute };
}

// A trailing optional time, e.g. "... at 3pm", "... 3:30pm", "... at noon".
// `(?:at\s+)?` so both "tomorrow at 3pm" and "tomorrow 3:30pm" work. Kept as a
// source fragment so callers can splice it onto their own anchor regex.
const TIME_SUFFIX =
  "(?:\\s+(?:at\\s+)?(noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?))?";

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_ALT = Object.keys(MONTHS).join("|");

/** Resolve a candidate Date to ISO, only if it's a real date. */
function emit(d: Date, matchedText: string, hasTime: boolean): ParsedReminder | null {
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return { remindAt: new Date(t).toISOString(), matchedText, hasTime };
}

// --- main --------------------------------------------------------------------

export function parseReminder(text: string, opts?: Options): ParsedReminder | null {
  if (!text) return null;
  const now = opts?.now ?? new Date();
  const dayStartHour = opts?.dayStartHour ?? 9;
  const dayEndHour = opts?.dayEndHour ?? 17;
  const lower = text.toLowerCase();

  // 1) Relative offsets: "in <n|word> <unit>", plus "in a couple/few <unit>".
  {
    const re =
      /\bin\s+(?:(\d+)|an?|a\s+couple(?:\s+of)?|a\s+few|couple(?:\s+of)?|few)\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/;
    const m = lower.match(re);
    if (m) {
      const qty = relativeQty(m[0]);
      const unit = m[2];
      let target: Date;
      let hasTime: boolean;
      if (/^min/.test(unit)) {
        target = new Date(now.getTime() + qty * 60_000);
        hasTime = true;
      } else if (/^h/.test(unit)) {
        target = new Date(now.getTime() + qty * 3_600_000);
        hasTime = true;
      } else if (/^day/.test(unit)) {
        target = at(addDays(now, qty), dayStartHour, 0);
        hasTime = false;
      } else {
        // weeks
        target = at(addDays(now, qty * 7), dayStartHour, 0);
        hasTime = false;
      }
      return emit(target, m[0], hasTime);
    }
  }

  // 2) "end of day" family -> today @ dayEndHour, else tomorrow.
  {
    const re = /\b(?:by\s+|before\s+)?end of (?:the )?day\b|\b(?:by\s+)?eod\b/;
    const m = lower.match(re);
    if (m) {
      let target = at(now, dayEndHour, 0);
      if (target.getTime() <= now.getTime()) target = at(addDays(now, 1), dayEndHour, 0);
      return emit(target, m[0], true);
    }
  }

  // 3) "tomorrow" with optional time.
  {
    const re = new RegExp("\\btomorrow" + TIME_SUFFIX, "");
    const m = lower.match(re);
    if (m) {
      const clock = parseClockTime(m[1]);
      const base = addDays(now, 1);
      const target = clock ? at(base, clock.hour, clock.minute) : at(base, dayStartHour, 0);
      return emit(target, m[0], clock !== null);
    }
  }

  // 4) "today at <time>" -> today at that time (keep today even if past).
  {
    const re =
      /\btoday\s+(?:at\s+)?(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/;
    const m = lower.match(re);
    if (m) {
      const clock = parseClockTime(m[1]);
      if (clock) {
        return emit(at(now, clock.hour, clock.minute), m[0], true);
      }
    }
  }

  // 5) "next week" -> now + 7 days @ dayStartHour.
  {
    const m = lower.match(/\bnext week\b/);
    if (m) {
      return emit(at(addDays(now, 7), dayStartHour, 0), m[0], false);
    }
  }

  // 6) Weekday names with optional leading "next " and optional time.
  {
    const re = new RegExp(
      "\\b(next\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)" +
        TIME_SUFFIX,
      "",
    );
    const m = lower.match(re);
    if (m) {
      const isNext = Boolean(m[1]);
      const targetDow = WEEKDAYS[m[2]];
      const clock = parseClockTime(m[3]);

      // Days until the NEXT occurrence strictly after today.
      let delta = (targetDow - now.getDay() + 7) % 7;
      if (delta === 0) delta = 7; // today is that weekday -> next week
      if (isNext) delta += 7; // "next <day>" = a week beyond the upcoming one

      const base = addDays(now, delta);
      const target = clock ? at(base, clock.hour, clock.minute) : at(base, dayStartHour, 0);
      return emit(target, m[0], clock !== null);
    }
  }

  // 8) Explicit calendar dates. Checked BEFORE the bare "at <time>" fallback:
  //    in "july 1 at 3pm" / "7/1 at 2pm" the time belongs to the date phrase,
  //    so a date match must win over treating "at 3pm" as a standalone time.
  {
    const dated = matchCalendarDate(lower, now, dayStartHour);
    if (dated) return dated;
  }

  // 7) Bare clock time "at <time>" (no day word) -> today if future, else tomorrow.
  {
    const re = /\bat\s+(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/;
    const m = lower.match(re);
    if (m) {
      const clock = parseClockTime(m[1]);
      if (clock) {
        let target = at(now, clock.hour, clock.minute);
        if (target.getTime() <= now.getTime()) target = at(addDays(now, 1), clock.hour, clock.minute);
        return emit(target, m[0], true);
      }
    }
  }

  return null;
}

// Map the matched "in ..." phrase to a quantity. Number words: a/an=1,
// couple=2, few=3.
function relativeQty(phrase: string): number {
  const digits = phrase.match(/\d+/);
  if (digits) return parseInt(digits[0], 10);
  if (/\bfew\b/.test(phrase)) return 3;
  if (/\bcouple\b/.test(phrase)) return 2;
  return 1; // a / an
}

// Resolve an explicit calendar date (with optional trailing time) to a future
// datetime, or null if no date phrase is present. Covers ISO, "month day" /
// "day month", US m/d[/y], and "the Nth". Default time = dayStartHour; hasTime
// is true only when a clock time was actually parsed.
function matchCalendarDate(
  lower: string,
  now: Date,
  dayStartHour: number,
): ParsedReminder | null {
  // a) ISO "2026-07-01" [optional time].
  {
    const re = new RegExp("\\b(\\d{4})-(\\d{2})-(\\d{2})\\b" + TIME_SUFFIX, "");
    const m = lower.match(re);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      const clock = parseClockTime(m[4]);
      if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
        const d = new Date(now.getTime());
        d.setFullYear(y, mo, day);
        const target = clock ? at(d, clock.hour, clock.minute) : at(d, dayStartHour, 0);
        return emit(target, m[0], clock !== null);
      }
    }
  }

  // b) "july 1", "jul 1st", "on july 1", "1 july" [optional time].
  //    Year = current; bump to next year if the date already passed.
  {
    // month-first: "[on] july 1[st]"
    const reMF = new RegExp(
      "\\b(?:on\\s+)?(" + MONTH_ALT + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b" + TIME_SUFFIX,
      "",
    );
    // day-first: "1[st] july"
    const reDF = new RegExp(
      "\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + MONTH_ALT + ")\\b" + TIME_SUFFIX,
      "",
    );

    const mMF = lower.match(reMF);
    const mDF = lower.match(reDF);
    // Prefer whichever appears earliest in the text.
    let chosen: { full: string; mon: number; day: number; timeRaw: string | undefined } | null = null;
    if (mMF && (!mDF || (mMF.index ?? 0) <= (mDF.index ?? 0))) {
      chosen = { full: mMF[0], mon: MONTHS[mMF[1]], day: parseInt(mMF[2], 10), timeRaw: mMF[3] };
    } else if (mDF) {
      chosen = { full: mDF[0], mon: MONTHS[mDF[2]], day: parseInt(mDF[1], 10), timeRaw: mDF[3] };
    }
    if (chosen && chosen.day >= 1 && chosen.day <= 31) {
      const clock = parseClockTime(chosen.timeRaw);
      const hour = clock ? clock.hour : dayStartHour;
      const minute = clock ? clock.minute : 0;
      let d = new Date(now.getTime());
      d.setFullYear(now.getFullYear(), chosen.mon, chosen.day);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() <= now.getTime()) {
        d = new Date(now.getTime());
        d.setFullYear(now.getFullYear() + 1, chosen.mon, chosen.day);
        d.setHours(hour, minute, 0, 0);
      }
      return emit(d, chosen.full, clock !== null);
    }
  }

  // c) "7/1" or "7/1/2026" (US m/d[/y]) [optional time].
  {
    const re = new RegExp(
      "\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b" + TIME_SUFFIX,
      "",
    );
    const m = lower.match(re);
    if (m) {
      const mon = parseInt(m[1], 10) - 1;
      const day = parseInt(m[2], 10);
      const clock = parseClockTime(m[4]);
      if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
        const hour = clock ? clock.hour : dayStartHour;
        const minute = clock ? clock.minute : 0;
        if (m[3]) {
          let year = parseInt(m[3], 10);
          if (year < 100) year += 2000;
          const d = new Date(now.getTime());
          d.setFullYear(year, mon, day);
          d.setHours(hour, minute, 0, 0);
          return emit(d, m[0], clock !== null);
        }
        // No year: current, bump to next year if passed.
        let d = new Date(now.getTime());
        d.setFullYear(now.getFullYear(), mon, day);
        d.setHours(hour, minute, 0, 0);
        if (d.getTime() <= now.getTime()) {
          d = new Date(now.getTime());
          d.setFullYear(now.getFullYear() + 1, mon, day);
          d.setHours(hour, minute, 0, 0);
        }
        return emit(d, m[0], clock !== null);
      }
    }
  }

  // d) "on the 15th" / "the 15th" -> 15th of this month, else next month.
  {
    const re = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/;
    const m = lower.match(re);
    if (m) {
      const day = parseInt(m[1], 10);
      if (day >= 1 && day <= 31) {
        let d = new Date(now.getTime());
        d.setDate(day);
        d.setHours(dayStartHour, 0, 0, 0);
        if (d.getTime() <= now.getTime() || d.getDate() !== day) {
          d = new Date(now.getTime());
          d.setDate(1);
          d.setMonth(d.getMonth() + 1, day);
          d.setHours(dayStartHour, 0, 0, 0);
        }
        return emit(d, m[0], false);
      }
    }
  }

  return null;
}
