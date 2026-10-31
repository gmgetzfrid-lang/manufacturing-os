// shiftHourly — the shift's notes by the hour, for the report, email and
// exported log: the meeting that starts the shift (who attended), the first
// hour (start of shift, permitting), then every hour to the end. Each hour
// says its own entries (lib/timeLog: starts, progress, holds, done, each
// comment with the entry it was typed with, the shift's notes and
// incidents), one line each, in fixed words: nothing made up, nothing
// written by a model. An hour someone types over is theirs, kept as typed.

import type { TimeLogRow } from "@/lib/timeLog";
import { timeInShift, type ShiftBreak, type ShiftWindow } from "@/lib/shiftReport";
import { noEmDash } from "@/lib/noEmDash";

export interface HourlyLine {
  id: string;
  /** When (plant time on the shift) — by the hour: its hour's start. */
  at: number;
  text: string;
  /** What its hour's entries were when it was written (hourSource). */
  src?: string;
  /** Typed by a person: kept as typed. */
  hand?: boolean;
  /** Said plainly from the entries — worded again the next time. */
  plain?: boolean;
  /** An earlier draft's check (notes before they were by the hour). */
  flags?: string[];
}

export interface HourlyNotes {
  /** 2: by the hour. Earlier notes were one line per entry time, a draft
   *  until approved. */
  v?: 2;
  lines: HourlyLine[];
  /** Earlier drafts: entry times they left out. */
  missing?: string[];
  model?: string;
  madeAt?: number;
  madeBy?: string | null;
  /** Earlier drafts: approved for the report and email. */
  approved?: { at: number; by?: string | null } | null;
  /** Rows taken off the log (a meeting that wasn't held), by key. */
  skip?: string[];
}

/** The meeting that starts the shift, permitting, the hours, a break, and
 *  the turnover meeting at its end (with the next shift). */
export type SlotKind = "meeting" | "permit" | "work" | "break" | "handover";
export interface HourSlot {
  key: string; kind: SlotKind; start: number; end: number;
  /** A break's name ("Lunch") and how long it is. */
  label?: string; minutes?: number;
}

/** A break on the shift, as set in the shift times: when, and how long. */
export interface HourBreak { at: number; minutes: number; label: string }

const HOUR = 3_600_000;

/** The shift by the hour, meeting to meeting: its meeting (the minutes
 *  before it starts, from the shift times), the first hour (start of
 *  shift, permitting), each hour, then the turnover meeting with the next
 *  shift (5:30 AM to 6:00 PM on a 6-to-6 day). Its breaks sit at their
 *  times. */
export function hourSlots(shift: { start: number; end: number }, meetingBeforeMin: number, breaks: HourBreak[] = []): HourSlot[] {
  const lead = Math.max(0, meetingBeforeMin) * 60_000;
  const until = Math.max(shift.start + HOUR, shift.end - lead);
  const out: HourSlot[] = [{ key: "meeting", kind: "meeting", start: shift.start - lead, end: shift.start }];
  for (let t = shift.start; t < until; t += HOUR) out.push({ key: String(t), kind: t === shift.start ? "permit" : "work", start: t, end: Math.min(t + HOUR, until) });
  if (until < shift.end) out.push({ key: "meeting:end", kind: "handover", start: until, end: shift.end });
  for (const b of breaks) {
    if (!(b.at >= shift.start && b.at < until)) continue;
    // After the hour it falls in: "12:00 PM" the hour's work, then "Lunch".
    const i = out.findIndex((x) => (x.kind === "work" || x.kind === "permit") && b.at >= x.start && b.at < x.end);
    const after = i < 0 ? out.length : out.findIndex((x, j) => j > i && (x.kind !== "break" || x.start > b.at));
    const slot: HourSlot = { key: `break:${b.at}`, kind: "break", start: b.at, end: b.at + b.minutes * 60_000, label: b.label, minutes: b.minutes };
    out.splice(after < 0 ? out.length : after, 0, slot);
  }
  return out;
}

/** The hour a time is in: before the shift, its meeting; from the
 *  turnover meeting on, that meeting; past the last hour, the last hour.
 *  Breaks hold no entries: what's logged then is its hour's. */
export function slotOf(at: number, slots: HourSlot[]): HourSlot {
  const hours = slots.filter((x) => x.kind === "work" || x.kind === "permit" || x.kind === "handover");
  if (!hours.length || at < hours[0].start) return slots[0];
  return hours.find((x) => at >= x.start && at < x.end) ?? hours[hours.length - 1];
}

/** The lines someone typed: by the hour, or an earlier draft someone
 *  approved (kept as theirs). Anything written for them is not kept: the
 *  hours say their entries, as they stand now. */
export function typedLines(n?: HourlyNotes | null): HourlyLine[] {
  if (!n) return [];
  if (n.v === 2) return n.lines.filter((l) => l.hand);
  return n.approved ? n.lines.map((l) => ({ ...l, hand: true })) : [];
}

/** Each hour's typed lines, by its key. */
export function typedBySlot(n: HourlyNotes | null | undefined, slots: HourSlot[]): Map<string, HourlyLine[]> {
  const out = new Map<string, HourlyLine[]>();
  for (const l of [...typedLines(n)].sort((a, b) => a.at - b.at)) {
    const k = slotOf(l.at, slots).key;
    out.set(k, [...(out.get(k) ?? []), l]);
  }
  return out;
}

/** Each hour's entries, by its key (the meeting has none). */
export function rowsBySlot(rows: TimeLogRow[], slots: HourSlot[]): Map<string, TimeLogRow[]> {
  const out = new Map<string, TimeLogRow[]>();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) {
    const k = slotOf(r.at, slots).key;
    if (k === "meeting") continue;
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

/** "5:09 PM" in plant time. */
const clock = (at: number, tz: string) =>
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).replace(/[  ]/g, " ");
/** A comment as typed, as a sentence: "bundles all in" → "Bundles all in." */
const sentence = (s: string) => {
  const t = noEmDash(s).replace(/\s+/g, " ").trim();
  if (!t) return "";
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(c) ? c : `${c}.`;
};

/** A line's bold part, marked **like this**: the work order it's about. */
export const boldRuns = (line: string): Array<{ t: string; b: boolean }> =>
  line.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((t) => (/^\*\*[^*]+\*\*$/.test(t) ? { t: t.slice(2, -2), b: true } : { t, b: false }));
/** The line as plain text (email, Excel, copied text). */
export const plainLine = (line: string) => line.replace(/\*\*([^*]+)\*\*/g, "$1");

const isFound = (r: TimeLogRow) => /^(Discovery found|Added scope raised)/.test(r.what);
/** The work order a line is about, in bold, and who: "**WO 301502 E-12**, Schultz: ". */
const headOf = (r: TimeLogRow) => {
  const title = [r.wo ? `WO ${r.wo}` : "", shortTask(r.task)].filter(Boolean).join(" ").trim();
  return `${title ? `**${noEmDash(title)}**` : ""}${r.crew ? `${title ? ", " : ""}${r.crew}` : ""}${title || r.crew ? ": " : ""}`;
};
/** What happened to the step, in a few words: "started", "50% to 65%", "done". */
function eventOf(r: TimeLogRow): string {
  const m = /(\d+)% → (\d+)%/.exec(r.pct);
  const from = m ? Number(m[1]) : null, to = m ? Number(m[2]) : Number(/(\d+)%/.exec(r.pct)?.[1] ?? NaN);
  const w = r.what;
  return w === "Started" ? (Number.isFinite(to) && to > 0 ? `started, ${to}%` : "started")
    : w === "Progress" ? (from != null ? `${from}% to ${to}%` : `${to}%`)
      : w === "Progress corrected down" ? `corrected to ${to}% (was ${from ?? "-"}%)`
        : w.startsWith("Done") ? `done${w.includes("(was") ? ` ${w.slice(5)}` : ""}`
          : w.startsWith("Off ") ? `back in progress (was ${w.startsWith("Off hold") ? "on hold" : "blocked"})`
            : w === "On hold" ? "on hold"
              : w === "Blocked" ? "blocked"
                : w === "Reopened" ? "reopened"
                  : w === "Missed" ? "marked missed"
                    : w === "Set back to not started" ? "set back to not started"
                      : w === "Why it's behind" ? "behind plan"
                        : w === "Comment" ? ""
                          : w.toLowerCase();
}

/** One entry, one line: the work order in bold, who, then the step and
 *  what happened to it, and the comment typed with it as it was typed.
 *  "**WO 301502 E-12**, Schultz: Install Bundle 50% to 65%. Bundles in." */
export function entryLine(r: TimeLogRow): string {
  const said = sentence(r.comment);
  // The shift's own notes and incidents: as written.
  if (!r.step && !r.id && !isFound(r)) return `${r.what}: ${said || "-"}`;
  const found = /^(Discovery found|Added scope raised)/.exec(r.what);
  if (found) {
    // "Corroded vortex break. Fabricating in house - 3 h of work · task finish +23 h · approved by TA management"
    const [what, ...rest] = r.comment.split(" - ");
    // What it adds and does, without the "unchanged" lines.
    const impact = rest.join(" - ").split(/\s*·\s*/).filter((x) => x && !/unchanged$/.test(x.trim())).join(", ");
    return `${headOf(r)}${found[1]}${r.step ? `, ${r.step}` : ""}. ${sentence(what)}${impact ? ` ${sentence(impact)}` : ""}`.trim();
  }
  const ev = eventOf(r);
  return `${headOf(r)}${`${r.step} ${ev}`.trim()}.${said ? ` ${said}` : ""}`;
}

/** The note the app leaves on the step discovery follows ("Discovery: …"):
 *  the discovery's own line says it. */
const autoNote = (r: TimeLogRow) => r.what === "Comment" && /^(Discovery|Added scope): /.test(r.comment.trim());
/** Only % moved: no start, finish or hold. */
const PROGRESS = new Set(["Progress", "Progress corrected down"]);

/** An hour's entries, in the order they happened, one line a step ("started,
 *  done 9:30 AM"); an entry off the hour says its time; the same line twice
 *  is said once. What started, finished or was held is `lines`; a step that
 *  only moved its % that hour is `progress` ("50% to 75%"). */
export function hourParts(rows: TimeLogRow[], hourStart: number, tz: string): { lines: string[]; progress: string[] } {
  const sorted = [...rows].filter((r) => !autoNote(r)).sort((a, b) => a.at - b.at || a.crew.localeCompare(b.crew) || a.task.localeCompare(b.task));
  const groups: TimeLogRow[][] = [];
  const byStep = new Map<string, TimeLogRow[]>();
  for (const r of sorted) {
    const k = r.id && r.step && !isFound(r) ? r.id : null;
    const g = k ? byStep.get(k) : undefined;
    if (g) {
      // The same entry twice is said once.
      if (!g.some((x) => x.at === r.at && x.what === r.what && x.pct === r.pct && x.comment === r.comment)) g.push(r);
      continue;
    }
    const ng = [r];
    groups.push(ng);
    if (k) byStep.set(k, ng);
  }
  const off = (r: TimeLogRow) => r.at - hourStart >= 60_000;
  const lines: string[] = [], progress: string[] = [];
  for (const g of groups) {
    const [r] = g;
    let line: string;
    if (g.length === 1) line = `${off(r) ? `${clock(r.at, tz)} ` : ""}${entryLine(r)}`;
    else {
      // Each change once: the same one saved twice is said once.
      const events: string[] = [], seen = new Set<string>();
      g.forEach((x, i) => { const e = eventOf(x); if (!e || seen.has(e)) return; seen.add(e); events.push(`${e}${i > 0 && off(x) ? ` ${clock(x.at, tz)}` : ""}`); });
      const said = [...new Set(g.map((x) => sentence(x.comment)).filter(Boolean))];
      line = `${off(r) ? `${clock(r.at, tz)} ` : ""}${headOf(r)}${`${r.step} ${events.join(", ")}`.trim()}.${said.length ? ` ${said.join(" ")}` : ""}`;
    }
    line = noEmDash(line);
    const to = g.every((x) => PROGRESS.has(x.what)) ? progress : lines;
    if (!to.includes(line)) to.push(line);
  }
  return { lines, progress };
}

/** An hour's lines, as one list: what happened, then what moved. */
export function hourItems(rows: TimeLogRow[], hourStart: number, tz: string): string[] {
  const p = hourParts(rows, hourStart, tz);
  return [...p.lines, ...p.progress];
}

/** The hours as the report, email and exported log say them, up to `upTo`
 *  (the meeting always): an hour typed over, as typed; otherwise its
 *  entries, one line each (none while they're still being read). */
export function hourlyRows(n: HourlyNotes | null | undefined, slots: HourSlot[], upTo: number, entries: TimeLogRow[] | null | undefined, tz: string): Array<{ slot: HourSlot; lines: string[]; progress: string[]; typed: boolean; text: string }> {
  const typed = typedBySlot(n, slots);
  const said = rowsBySlot(entries ?? [], slots);
  // A row taken off the log (a meeting that wasn't held) stays off.
  const skip = new Set(n?.skip ?? []);
  return slots.filter((x) => !skip.has(x.key) && (x.kind === "meeting" || x.start <= upTo)).map((slot) => {
    const own = (typed.get(slot.key) ?? []).flatMap((l) => l.text.split("\n")).map((x) => noEmDash(x).trim()).filter(Boolean);
    // An hour typed over is all theirs; otherwise its entries say it.
    const parts = own.length || slot.kind === "meeting" || slot.kind === "break" ? { lines: own, progress: [] } : hourParts(said.get(slot.key) ?? [], slot.start, tz);
    return { slot, lines: parts.lines, progress: parts.progress, typed: own.length > 0, text: parts.lines.join("\n") };
  });
}

/** What each kind of hour is called. */
export const SLOT_LABEL: Record<SlotKind, string> = { meeting: "Shift meeting", permit: "Start of shift - permitting", work: "", break: "Break", handover: "Turnover meeting" };

/** "Lunch, 30 min" - a break as its row says it. */
export const breakLabel = (x: HourSlot) => `${x.label || "Break"}${x.minutes ? `, ${x.minutes} min` : ""}`;

/** "8:00 AM" on the first line and wherever AM/PM changes, "8:30" between
 *  — the way a shift writes its notes. */
export function hourlyClocks(ats: number[], tz: string): string[] {
  let prev = "";
  return ats.map((at) => {
    const [t, ap] = clock(at, tz).split(" ");
    const out = ap !== prev ? `${t} ${ap}` : t;
    prev = ap;
    return out;
  });
}

/** "E-20 - Transmix Charge Exchanger" → "E-20". */
export const shortTask = (t: string) => t.replace(/\s+[-–—]\s+.*$/, "").trim();

/** The shift's breaks as times on it (lib/shiftReport ShiftTimes.breaks). */
export function breaksOn(shift: ShiftWindow, breaks: ShiftBreak[] | undefined, tz: string): HourBreak[] {
  return (breaks ?? []).filter((b) => b.shift === shift.kind).map((b) => ({ at: timeInShift(shift, b.start, tz), minutes: b.minutes, label: b.label }))
    .filter((b): b is HourBreak => b.at != null).sort((a, b) => a.at - b.at);
}
