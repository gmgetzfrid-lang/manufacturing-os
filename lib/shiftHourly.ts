// shiftHourly - the shift's notes by the hour, for the report, email and
// exported log: the meeting that starts the shift (who attended), the first
// hour (start of shift, permitting), every hour, then the meeting that
// starts the next shift (lib/shiftMeeting). Each hour
// says its own entries (lib/timeLog: starts, progress, holds, done, each
// comment with the entry it was typed with, the shift's notes and
// incidents), one line each, in fixed words: nothing made up, nothing
// written by a model. An hour someone types over is theirs, kept as typed.

import type { TimeLogRow } from "@/lib/timeLog";
import type { Milestone } from "@/types/schema";
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
  /** Its text is only what the person added; the hour's entries still
   *  show (live), but for `hide`. Without it (typed earlier), the text is
   *  the whole hour as it was typed. */
  own?: boolean;
  /** Lines from the entries taken out or reworded when it was typed (by
   *  their words): one that changes on the work order shows again. */
  hide?: string[];
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
 *  the meeting at its end (the one that starts the next shift). */
export type SlotKind = "meeting" | "permit" | "work" | "break" | "handover";
export interface HourSlot {
  key: string; kind: SlotKind; start: number; end: number;
  /** A break's name ("Lunch") and how long it is. */
  label?: string; minutes?: number;
  /** The work from the end meeting to the end of the shift (5:30 to 6:00
   *  PM): its own row, shown only when something was logged then. */
  tail?: boolean;
}

/** A break on the shift, as set in the shift times: when, and how long. */
export interface HourBreak { at: number; minutes: number; label: string }

const HOUR = 3_600_000;

/** The shift by the hour, meeting to meeting: its meeting (the minutes
 *  before it starts, from the shift times), the first hour (start of
 *  shift, permitting), each hour, then the meeting that starts the next
 *  shift (5:30 AM to 5:30 PM on a 6-to-6 day). The meetings hold no work:
 *  what's logged from 5:30 PM on is its own row after the meeting. Its
 *  breaks sit at their times. */
export function hourSlots(shift: { start: number; end: number }, meetingBeforeMin: number, breaks: HourBreak[] = []): HourSlot[] {
  const lead = Math.max(0, meetingBeforeMin) * 60_000;
  const until = Math.max(shift.start + HOUR, shift.end - lead);
  const out: HourSlot[] = [{ key: "meeting", kind: "meeting", start: shift.start - lead, end: shift.start }];
  for (let t = shift.start; t < until; t += HOUR) out.push({ key: String(t), kind: t === shift.start ? "permit" : "work", start: t, end: Math.min(t + HOUR, until) });
  if (until < shift.end) {
    out.push({ key: "meeting:end", kind: "handover", start: until, end: shift.end });
    out.push({ key: String(until), kind: "work", start: until, end: shift.end, tail: true });
  }
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

/** The hour a time is in: before the shift, its meeting; past the last
 *  hour, the last hour. Breaks and the end meeting hold no entries: what's
 *  logged then is its hour's. */
export function slotOf(at: number, slots: HourSlot[]): HourSlot {
  const hours = slots.filter((x) => x.kind === "work" || x.kind === "permit");
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

/** The entries that finish a whole work order: a step marked done that was
 *  the last of its work order's steps to finish, every one of them done
 *  now. Earlier lines about the work order aren't. */
export function workOrderClosers(milestones: Milestone[]): (r: TimeLogRow) => boolean {
  const byId = new Map(milestones.filter((m) => m.id).map((m) => [m.id!, m]));
  const kids = new Map<string, Milestone[]>();
  for (const m of milestones) if (m.parentId) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);
  const leaves = (id: string): Milestone[] => (kids.get(id) ?? []).flatMap((c) => (c.id && kids.has(c.id) ? leaves(c.id) : [c]));
  const done = (m: Milestone) => m.status === "completed" || (m.percentComplete ?? 0) >= 100;
  const memo = new Map<string, number | null>();
  // When a work order's last step finished, if all of them have.
  const closedAt = (wo: string): number | null => {
    if (memo.has(wo)) return memo.get(wo)!;
    const ls = leaves(wo).filter((m) => !m.cancelledAt);
    const at = ls.length && ls.every(done) ? Math.max(...ls.map((m) => (m.actualAt ? new Date(m.actualAt).getTime() : -Infinity))) : null;
    memo.set(wo, at);
    return at;
  };
  return (r) => {
    if (!r.id || !r.what.startsWith("Done")) return false;
    const m = byId.get(r.id);
    if (!m || !done(m)) return false;
    // A task with no steps of its own under a work order: it is the work order.
    if (!m.parentId) return true;
    const at = closedAt(m.parentId);
    return at != null && r.at >= at - 60_000;
  };
}

/** An hour's entries, in the order they happened, one line a step ("started,
 *  done 9:30 AM"); an entry off the hour says its time; the same line twice
 *  is said once. What started, finished or was held is `lines`; a step that
 *  only moved its % that hour is `progress` ("50% to 75%"). */
export function hourParts(rows: TimeLogRow[], hourStart: number, tz: string, closes?: (r: TimeLogRow) => boolean): { lines: string[]; progress: string[]; closed: string[] } {
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
  const lines: string[] = [], progress: string[] = [], closed: string[] = [];
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
    // The line that finished a whole work order.
    if (closes && to === lines && g.some(closes) && !closed.includes(line)) closed.push(line);
  }
  return { lines, progress, closed };
}

/** An hour's lines, as one list: what happened, then what moved. */
export function hourItems(rows: TimeLogRow[], hourStart: number, tz: string): string[] {
  const p = hourParts(rows, hourStart, tz);
  return [...p.lines, ...p.progress];
}

/** The hours as the report, email and exported log say them, up to `upTo`
 *  (the meeting always): an hour typed over, as typed; otherwise its
 *  entries, one line each (none while they're still being read). The
 *  meetings say nothing here: their record does (lib/shiftMeeting).
 *  `off`: meetings not held; `show`: rows shown before their time. */
export function hourlyRows(n: HourlyNotes | null | undefined, slots: HourSlot[], upTo: number, entries: TimeLogRow[] | null | undefined, tz: string,
  opts: { off?: string[]; show?: string[]; closes?: (r: TimeLogRow) => boolean } = {}): HourlyRow[] {
  const typed = typedBySlot(n, slots);
  const said = rowsBySlot(entries ?? [], slots);
  // A row taken off the log (a meeting that wasn't held) stays off.
  const skip = new Set([...(n?.skip ?? []), ...(opts.off ?? [])]);
  const show = new Set(opts.show ?? []);
  const rows = slots.filter((x) => !skip.has(x.key) && (x.kind === "meeting" || x.start <= upTo || show.has(x.key))).map((slot) => {
    const meeting = slot.kind === "meeting" || slot.kind === "handover";
    if (meeting || slot.kind === "break") return { slot, lines: [], progress: [], closed: [], typed: false, text: "", said: "", auto: [] } as HourlyRow;
    const auto = hourParts(said.get(slot.key) ?? [], slot.start, tz, opts.closes);
    const all = [...auto.lines, ...auto.progress];
    const base = { slot, said: all.join("\n"), auto: all };
    const ls = typed.get(slot.key) ?? [];
    const words = ls.flatMap((l) => l.text.split("\n")).map((x) => noEmDash(x).trim()).filter(Boolean);
    // Nothing typed: its entries say it.
    if (!ls.length) return { ...base, lines: auto.lines, progress: auto.progress, closed: auto.closed, typed: false, text: auto.lines.join("\n") } as HourlyRow;
    // The work order's lines stay live (but for what was taken out or
    // reworded when it was typed); what the person added comes after.
    const inAuto = (x: string) => all.some((a) => sameLine(a, x));
    const own = ls.some((l) => l.own);
    const hide = own ? ls.flatMap((l) => l.hide ?? []) : [];
    const hidden = (x: string) => hide.some((h) => sameLine(h, x));
    const extras = words.filter((x) => !inAuto(x));
    const lines = [...auto.lines.filter((x) => !hidden(x)), ...extras];
    const closed = [...auto.closed.filter((x) => !hidden(x)), ...typedClosed(extras, auto.closed.filter(hidden))];
    // A work order line typed here that isn't one of the entries now (a
    // time fixed, an entry changed or taken back): said, to remove or keep.
    // Typed earlier (the whole hour as typed): said whenever; since: once
    // the entries change after it was typed.
    const mismatch = extras.filter(generated);
    const src = ls.map((l) => l.src).find((x) => x != null);
    const stale = mismatch.length > 0 && (!own || (src != null && src !== base.said));
    return { ...base, lines, progress: auto.progress.filter((x) => !hidden(x)), closed, typed: true, text: lines.join("\n"), ...(stale ? { stale: true, mismatch } : {}) } as HourlyRow;
  }).filter((r) => !r.slot.tail || r.lines.length > 0 || r.progress.length > 0);
  // An hour with nothing in it and a break in it (lunch): the break's row
  // says it, one row; the hour is kept on it (to type into or add work at).
  const empty = (r: HourlyRow) => r.slot.kind === "work" && !r.slot.tail && !r.lines.length && !r.progress.length;
  const inHour = (b: HourlyRow, r: HourlyRow) => b.slot.kind === "break" && b.slot.start >= r.slot.start && b.slot.start < r.slot.end;
  const out: HourlyRow[] = [];
  for (const r of rows) {
    if (empty(r) && rows.some((b) => inHour(b, r))) continue;
    const hour = r.slot.kind === "break" ? rows.find((h) => empty(h) && inHour(r, h)) : undefined;
    out.push(hour && !out.some((x) => x.hour === hour.slot) ? { ...r, hour: hour.slot } : r);
  }
  return out;
}

/** An hour typed over where a work order was finished: the typed line
 *  that still names that work order ("WO 310505") stays green; of several,
 *  the one that says it's done (else the last). */
export function typedClosed(typed: string[], closed: string[]): string[] {
  const out: string[] = [];
  for (const c of closed) {
    const head = boldRuns(c).find((r) => r.b)?.t ?? "";
    const key = (/^WO\s+\S+/i.exec(head)?.[0] ?? head).toLowerCase();
    if (!key) continue;
    const hits = typed.filter((t) => plainLine(t).toLowerCase().includes(key));
    if (!hits.length) continue;
    const pick = hits.filter((t) => /\b(done|complete|completed|finished)\b/i.test(plainLine(t)));
    const line = (pick.length ? pick : hits).at(-1)!;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** An hour of the notes as said: its lines, what moved, the lines that
 *  finished a whole work order; a break's row carries the empty hour it
 *  stands for (`hour`). */
export interface HourlyRow {
  slot: HourSlot; lines: string[]; progress: string[]; closed: string[]; typed: boolean; text: string; hour?: HourSlot;
  /** What its entries say now (kept with a typed hour, to see if they change). */
  said: string;
  /** Its entries' lines now (what moved its % too). */
  auto: string[];
  /** A work order line typed into it isn't one of its entries now. */
  stale?: boolean;
  /** Those lines. */
  mismatch?: string[];
}

/** Two lines that say the same, bold and spacing aside. */
export const sameLine = (a: string, b: string) => {
  const n = (x: string) => plainLine(x).replace(/\s+/g, " ").trim().toLowerCase();
  return n(a) === n(b);
};
/** A work order line as the app writes it (its WO in bold). */
export const isWorkOrderLine = (x: string) => /\*\*[^*]+\*\*/.test(x);
const generated = isWorkOrderLine;

/** An hour as typed, saved: what the person added (not already one of the
 *  entries' lines), and the entries' lines they took out or reworded. Null:
 *  nothing of theirs (the hour shows its entries). */
export function typedHour(text: string, auto: string[]): { extras: string[]; hide: string[] } | null {
  const lines = text.split("\n").map((x) => noEmDash(x).replace(/\s+/g, " ").trim()).filter(Boolean);
  const extras = lines.filter((x) => !auto.some((a) => sameLine(a, x)));
  const hide = auto.filter((a) => !lines.some((x) => sameLine(a, x)));
  return extras.length || hide.length ? { extras, hide } : null;
}

/** What each kind of hour is called. */
export const SLOT_LABEL: Record<SlotKind, string> = { meeting: "Shift meeting", permit: "Start of shift - permitting", work: "", break: "Break", handover: "Shift meeting" };

/** "Lunch, 30 min" - a break as its row says it. */
export const breakLabel = (x: HourSlot) => `${x.label || "Break"}${x.minutes ? `, ${x.minutes} min` : ""}`;

/** "8:00 AM" on the first line and wherever AM/PM changes, "8:30" between
 *  - the way a shift writes its notes. `full`: rows that always say AM or
 *  PM (the meetings, and the row after one). */
export function hourlyClocks(ats: number[], tz: string, full: boolean[] = []): string[] {
  let prev = "";
  return ats.map((at, i) => {
    const [t, ap] = clock(at, tz).split(" ");
    const out = ap !== prev || full[i] || full[i - 1] ? `${t} ${ap}` : t;
    prev = ap;
    return out;
  });
}
/** The clocks of the rows of the notes, the meetings always with AM or PM. */
export const slotClocks = (slots: HourSlot[], tz: string) =>
  hourlyClocks(slots.map((x) => x.start), tz, slots.map((x) => x.kind === "meeting" || x.kind === "handover"));

/** "E-20 - Transmix Charge Exchanger" → "E-20". */
export const shortTask = (t: string) => t.replace(/\s+[-–—]\s+.*$/, "").trim();

/** The shift's breaks as times on it (lib/shiftReport ShiftTimes.breaks). */
export function breaksOn(shift: ShiftWindow, breaks: ShiftBreak[] | undefined, tz: string): HourBreak[] {
  return (breaks ?? []).filter((b) => b.shift === shift.kind).map((b) => ({ at: timeInShift(shift, b.start, tz), minutes: b.minutes, label: b.label }))
    .filter((b): b is HourBreak => b.at != null).sort((a, b) => a.at - b.at);
}
