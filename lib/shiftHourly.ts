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
}

export type SlotKind = "meeting" | "permit" | "work" | "break";
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
 *  shift, permitting), then each hour until the next shift's meeting
 *  (5:30 AM to 5:30 PM on a 6-to-6 day). Its breaks sit at their times. */
export function hourSlots(shift: { start: number; end: number }, meetingBeforeMin: number, breaks: HourBreak[] = []): HourSlot[] {
  const lead = Math.max(0, meetingBeforeMin) * 60_000;
  const until = Math.max(shift.start + HOUR, shift.end - lead);
  const out: HourSlot[] = [{ key: "meeting", kind: "meeting", start: shift.start - lead, end: shift.start }];
  for (let t = shift.start; t < until; t += HOUR) out.push({ key: String(t), kind: t === shift.start ? "permit" : "work", start: t, end: Math.min(t + HOUR, until) });
  for (const b of breaks) {
    if (!(b.at >= shift.start && b.at < until)) continue;
    // After the hour it falls in: "12:00 PM" the hour's work, then "Lunch".
    const i = out.findIndex((x) => x.kind !== "meeting" && x.kind !== "break" && b.at >= x.start && b.at < x.end);
    const after = i < 0 ? out.length : out.findIndex((x, j) => j > i && (x.kind !== "break" || x.start > b.at));
    const slot: HourSlot = { key: `break:${b.at}`, kind: "break", start: b.at, end: b.at + b.minutes * 60_000, label: b.label, minutes: b.minutes };
    out.splice(after < 0 ? out.length : after, 0, slot);
  }
  return out;
}

/** The hour a time is in: before the shift, its meeting; after, its last
 *  hour. Breaks hold no entries: what's logged then is its hour's. */
export function slotOf(at: number, slots: HourSlot[]): HourSlot {
  const hours = slots.filter((x) => x.kind !== "meeting" && x.kind !== "break");
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
  new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).replace(/[\u202f\u00a0]/g, " ");
/** A comment as typed, as a sentence: "bundles all in" → "Bundles all in." */
const sentence = (s: string) => {
  const t = noEmDash(s).replace(/\s+/g, " ").trim();
  if (!t) return "";
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(c) ? c : `${c}.`;
};

/** One entry, one line, in fixed words: who, which step, what happened,
 *  and the comment typed with it as it was typed. */
export function entryLine(r: TimeLogRow): string {
  const said = sentence(r.comment);
  // The shift's own notes and incidents: as written.
  if (!r.step && !r.id && !/^(Discovery|Added scope)/.test(r.what)) return `${r.what}: ${said || "-"}`;
  const who = r.crew ? `${r.crew}: ` : "";
  const found = /^(Discovery found|Added scope raised)/.exec(r.what);
  if (found) {
    // "Corroded vortex break. Fabricating in house - 3 h of work · task finish +23 h · approved by TA management"
    const [what, ...impact] = r.comment.split(" - ");
    return `${who}${found[1]} on ${shortTask(r.task)}${r.step ? `, ${r.step}` : ""}. ${sentence(what)}${impact.length ? ` ${sentence(impact.join(" - ").replace(/\s*·\s*/g, ", "))}` : ""}`.trim();
  }
  const where = `${shortTask(r.task)} ${r.step}`.trim();
  const m = /(\d+)% → (\d+)%/.exec(r.pct);
  const from = m ? Number(m[1]) : null, to = m ? Number(m[2]) : Number(/(\d+)%/.exec(r.pct)?.[1] ?? NaN);
  const w = r.what;
  const event =
    w === "Started" ? (Number.isFinite(to) && to > 0 ? `started, ${to}%` : "started")
      : w === "Progress" ? `${to}%${from != null ? ` (was ${from}%)` : ""}`
        : w === "Progress corrected down" ? `corrected to ${to}%${from != null ? ` (was ${from}%)` : ""}`
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
  return `${who}${where}${event ? ` ${event}` : ""}.${said ? ` ${said}` : ""}`;
}

/** An hour's entries, one line each, in the order they happened (an entry
 *  off the hour says its time). The same line twice is said once. */
export function hourItems(rows: TimeLogRow[], hourStart: number, tz: string): string[] {
  const out: string[] = [];
  for (const r of [...rows].sort((a, b) => a.at - b.at || a.crew.localeCompare(b.crew) || a.task.localeCompare(b.task))) {
    const line = noEmDash(`${r.at - hourStart >= 60_000 ? `${clock(r.at, tz)} ` : ""}${entryLine(r)}`);
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The hours as the report, email and exported log say them, up to `upTo`
 *  (the meeting always): an hour typed over, as typed; otherwise its
 *  entries, one line each (none while they're still being read). */
export function hourlyRows(n: HourlyNotes | null | undefined, slots: HourSlot[], upTo: number, entries: TimeLogRow[] | null | undefined, tz: string): Array<{ slot: HourSlot; lines: string[]; typed: boolean; text: string }> {
  const typed = typedBySlot(n, slots);
  const said = rowsBySlot(entries ?? [], slots);
  return slots.filter((x) => x.kind === "meeting" || x.start <= upTo).map((slot) => {
    const own = (typed.get(slot.key) ?? []).flatMap((l) => l.text.split("\n")).map((x) => noEmDash(x).trim()).filter(Boolean);
    const lines = own.length || slot.kind === "meeting" || slot.kind === "break" ? own : hourItems(said.get(slot.key) ?? [], slot.start, tz);
    return { slot, lines, typed: own.length > 0, text: lines.join("\n") };
  });
}

/** What each kind of hour is called. */
export const SLOT_LABEL: Record<SlotKind, string> = { meeting: "Shift meeting", permit: "Start of shift - permitting", work: "", break: "Break" };

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

/** What each crew kept working on, hour by hour, when nothing new was
 *  entered for it that hour: steps under way at the hour's start (by the
 *  progress log, not held) whose crew works this shift, with where each
 *  stood then. "Schultz - V-7 Clean Tower 50%, E-12 Tube Side Hydro 0%".
 *  Only hours up to `upTo`. */
export function ongoingByHour(
  slots: HourSlot[],
  steps: Array<{ id: string; name: string; task: string; crew: string; worksShift: boolean }>,
  log: Array<{ milestone_id: string; at: string; new_status: string; new_percent?: number | null }>,
  upTo: number,
): Map<string, string[]> {
  const byStep = new Map<string, Array<{ t: number; status: string; pct: number | null }>>();
  for (const r of log) {
    const t = Date.parse(r.at);
    if (Number.isFinite(t)) byStep.set(r.milestone_id, [...(byStep.get(r.milestone_id) ?? []), { t, status: r.new_status, pct: r.new_percent ?? null }]);
  }
  for (const v of byStep.values()) v.sort((a, b) => a.t - b.t);
  const out = new Map<string, string[]>();
  for (const slot of slots) {
    if ((slot.kind !== "work" && slot.kind !== "permit") || slot.start > upTo) continue;
    const crews = new Map<string, string[]>();
    for (const s of steps) {
      if (!s.worksShift) continue;
      const rows = byStep.get(s.id) ?? [];
      // Something entered for it this hour: the hour's own lines say it.
      if (rows.some((r) => r.t >= slot.start && r.t < slot.end)) continue;
      const before = rows.filter((r) => r.t < slot.start);
      const last = before[before.length - 1];
      if (last?.status !== "in_progress") continue;
      const k = s.crew || "No crew named";
      crews.set(k, [...(crews.get(k) ?? []), noEmDash(`${shortTask(s.task)} ${s.name}${last.pct != null ? ` ${last.pct}%` : ""}`.trim())]);
    }
    // The same step name at the same % twice (two pipe jobs) is said once, with how many.
    const said = (names: string[]) => [...new Set(names)].map((n) => { const k = names.filter((x) => x === n).length; return k > 1 ? `${n} (${k})` : n; });
    if (crews.size) out.set(slot.key, [...crews].map(([crew, names]) => `${crew} - ${said(names).join(", ")}`));
  }
  return out;
}

/** The shift's breaks as times on it (lib/shiftReport ShiftTimes.breaks). */
export function breaksOn(shift: ShiftWindow, breaks: ShiftBreak[] | undefined, tz: string): HourBreak[] {
  return (breaks ?? []).filter((b) => b.shift === shift.kind).map((b) => ({ at: timeInShift(shift, b.start, tz), minutes: b.minutes, label: b.label }))
    .filter((b): b is HourBreak => b.at != null).sort((a, b) => a.at - b.at);
}
