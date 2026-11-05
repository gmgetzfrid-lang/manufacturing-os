// emailShifts - a pasted email or log with more than one shift in it, split
// into its shifts by its own headers, and each shift into its sections.
//
// A turnaround update email carries its own dates and times: "November 4,
// 2026 6:00 AM – 6:00 PM", "From nights 11/3/26 6:00 PM - 11/4/26 6:00 AM",
// and quoted older updates below. Each header starts a shift: everything
// under it, to the next header, is a log of that shift, so a time written
// with no AM or PM ("4:30") is the one in that shift. The email's own header
// lines (From:, Sent:, To:, Subject:, recipient lists) are left out.
//
// Inside a shift, the sections are told apart by their headings, so some
// can be left out: the plan ("Work to be Completed", "Goals For Tonight"),
// the people (attendees, headcount), safety. An hour-by-hour line ("7:00PM -")
// starts the shift's log even with no heading above it.
//
// Pure: no database, no AI.

import { shiftAt, shiftWindow, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { wallClockToMs, dayKey, fmtInTz } from "@/lib/scheduleTz";

export type SectionKind = "plan" | "done" | "notes" | "people" | "safety" | "followup" | "other";

export const SECTION_WORD: Record<SectionKind, string> = {
  done: "Work completed and status",
  notes: "Shift notes, hour by hour",
  followup: "Follow-up items",
  plan: "Work planned (to be completed, goals)",
  people: "Attendees and headcount",
  safety: "Safety",
  other: "Everything else",
};
/** Left out unless picked: a plan isn't progress, people and safety aren't steps. */
export const DEFAULT_OMIT: SectionKind[] = ["plan", "people", "safety"];

export interface Section { kind: SectionKind; title: string; lines: string[] }
export interface ShiftPart {
  /** "2026-11-04:day" */
  key: string;
  window: ShiftWindow;
  /** The header line it was found by. */
  header: string;
  sections: Section[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_WORDS = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, "i");
const DATE_SLASH = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const TIME = /\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![a-z])/gi;
const SHIFT_WORD = /\b(nights?|night\s*shift|nightshift|days|day\s*shift|dayshift)\b/i;
/** The email's own header lines and recipient lists. */
const EMAIL_HEAD = /^\s*(from|sent|to|cc|bcc|subject|date|reply-to)\s*:/i;
const RECIPIENT = /^\s*[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3}\s*;\s*$/;

/** The date a line names, as "YYYY-MM-DD" (a year left out: the nearest one
 *  not more than a month ahead of now). */
function dateOf(line: string, now: number, tz: string): string | null {
  const nowY = Number(dayKey(now, tz).slice(0, 4));
  const pick = (mo: number, d: number, y: number | null) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let year = y ?? nowY;
    if (year < 100) year += 2000;
    const iso = (yy: number) => `${yy}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (y == null && Date.parse(`${iso(year)}T12:00:00Z`) > now + 31 * 86_400_000) year -= 1;
    return iso(year);
  };
  const w = DATE_WORDS.exec(line);
  if (w) return pick(MONTHS.indexOf(w[1].slice(0, 3).toLowerCase()) + 1, Number(w[2]), w[3] ? Number(w[3]) : null);
  const s = DATE_SLASH.exec(line);
  if (s) return pick(Number(s[1]), Number(s[2]), s[3] ? Number(s[3]) : null);
  return null;
}

/** The shift a header line starts, or null when the line isn't a header:
 *  it needs a date, and a time range of a shift's length or a shift word
 *  ("nights"). The email's own Sent:/Subject: lines never are. */
export function headerShift(line: string, tz: string, times: ShiftTimes, now: number): ShiftWindow | null {
  const l = line.trim();
  if (!l || l.length > 160 || EMAIL_HEAD.test(l)) return null;
  const day = dateOf(l, now, tz);
  if (!day) return null;
  // Two dates more than a day apart ("11/2 to 11/8"): a span of days, not a shift.
  const slashes = [...l.matchAll(new RegExp(DATE_SLASH.source, "g"))].map((m) => dateOf(m[0], now, tz)).filter((x): x is string => !!x);
  if (slashes.length >= 2 && Math.abs(Date.parse(slashes[slashes.length - 1]) - Date.parse(slashes[0])) > 86_400_000) return null;
  const ts = [...l.matchAll(TIME)].map((m) => ({ h: (Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0), m: Number(m[2] ?? 0) }));
  const word = SHIFT_WORD.exec(l)?.[1]?.toLowerCase() ?? null;
  const [y, mo, d] = day.split("-").map(Number);
  if (ts.length >= 2) {
    const start = wallClockToMs({ year: y, month: mo, day: d, hour: ts[0].h, minute: ts[0].m, second: 0 }, tz);
    let span = (ts[1].h * 60 + ts[1].m) - (ts[0].h * 60 + ts[0].m);
    if (span <= 0) span += 24 * 60;
    if (span < 6 * 60 || span > 14 * 60) return null;
    return shiftAt(start + 60_000, tz, times);
  }
  if (word) return shiftWindow(day, /night/.test(word) ? "night" : "day", tz, times);
  return null;
}

function sectionKind(line: string): SectionKind | null {
  const l = line.trim().replace(/[:\-–—\s]+$/, "");
  if (!l || l.length > 70) return null;
  if (/attendees|head\s*count|personnel|manpower|roster/i.test(l)) return "people";
  if (/^safety\b/i.test(l)) return "safety";
  if (/to be (completed|done|worked)|^goals?\b|\bgoals? for\b|look\s*ahead|plan(ned)? for|scheduled for (today|tonight)|^plan$/i.test(l)) return "plan";
  if (/^follow[- ]?up|action items|open items/i.test(l)) return "followup";
  if (/work (completed|done)|completed between|overall status|status on|accomplishments?|progress (today|tonight)/i.test(l)) return "done";
  if (/^shift notes?$|^notes$|hour[- ]by[- ]hour|^log$/i.test(l)) return "notes";
  return null;
}
/** An hour-by-hour line: "7:00PM-", "12:00", "1:00AM- WO# 310359…", "9:00 – 20 trays…". */
const HOURLY = /^\s*\d{1,2}(?::[0-5]\d)?\s*(?:[ap]\.?\s*m\.?)?\s*(?:[-–—:]|$)/i;

/** Split a pasted note into its shifts. Null when it names none (then it's
 *  read as one note, about the shift picked). */
export function splitShifts(text: string, tz: string, times: ShiftTimes, now: number): ShiftPart[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const parts: ShiftPart[] = [];
  let cur: ShiftPart | null = null;
  const preamble: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/ /g, " ").replace(/\s+$/, "");
    if (EMAIL_HEAD.test(line) || RECIPIENT.test(line)) continue;
    const w = headerShift(line, tz, times, now);
    // A shift that has begun (the one going now too); a header for one to
    // come ("goals for tomorrow") isn't a log.
    if (w && w.start <= now) {
      const key = `${w.dayKey}:${w.kind}`;
      cur = parts.find((p) => p.key === key) ?? null;
      if (!cur) { cur = { key, window: w, header: line.trim(), sections: [{ kind: "other", title: "", lines: [] }] }; parts.push(cur); }
      else cur.sections.push({ kind: "other", title: "", lines: [] });
      continue;
    }
    if (!cur) { preamble.push(line); continue; }
    const sec = cur.sections[cur.sections.length - 1];
    const k = sectionKind(line);
    if (k) { cur.sections.push({ kind: k, title: line.trim(), lines: [] }); continue; }
    // The hour-by-hour log starts with its first time, heading or not.
    if (HOURLY.test(line) && sec.kind !== "notes" && sec.kind !== "done") { cur.sections.push({ kind: "notes", title: "Hour by hour", lines: [line] }); continue; }
    sec.lines.push(line);
  }
  if (!parts.length) return null;
  for (const p of parts) p.sections = p.sections.filter((s) => s.lines.some((l) => l.trim()));
  return parts;
}

/** The words of one shift to read, the sections left out taken out. */
export function partText(p: ShiftPart, omit: Iterable<SectionKind>): string {
  const off = new Set(omit);
  return p.sections.filter((s) => !off.has(s.kind))
    .map((s) => [s.title, ...s.lines].filter(Boolean).join("\n").trim())
    .filter(Boolean).join("\n\n").trim();
}

/** The section kinds found, with how many lines each. */
export function sectionsFound(parts: ShiftPart[]): Array<{ kind: SectionKind; lines: number }> {
  const n = new Map<SectionKind, number>();
  for (const p of parts) for (const s of p.sections) n.set(s.kind, (n.get(s.kind) ?? 0) + s.lines.filter((l) => l.trim()).length);
  const order: SectionKind[] = ["done", "notes", "followup", "other", "plan", "people", "safety"];
  return order.filter((k) => n.has(k)).map((k) => ({ kind: k, lines: n.get(k)! }));
}

/** "Wed Nov 4 day shift". */
export const partLabel = (w: ShiftWindow, tz: string) => `${fmtInTz(w.start, tz, { weekday: "short", month: "short", day: "numeric" })} ${w.kind} shift`;
