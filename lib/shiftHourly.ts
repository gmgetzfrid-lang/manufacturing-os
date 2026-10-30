// shiftHourly — the shift's notes by the hour, for the report and email:
// the meeting that starts the shift (who attended), the first hour — start
// of shift, permitting — then every hour to the end, each written from the
// shift's own entries in that hour (lib/timeLog: starts, progress, holds,
// done, comments, the shift's notes and incidents) and nothing else.
//
// An hour is written when the report is opened and its entries have
// changed since it was last written. Its wording is checked against that
// hour's entries: wording that names a tag, number, date or time they don't
// have is replaced by the entries said plainly. An hour someone types over
// is theirs — never written over.

import type { TimeLogRow } from "@/lib/timeLog";

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

export type SlotKind = "meeting" | "permit" | "work";
export interface HourSlot { key: string; kind: SlotKind; start: number; end: number }

const HOUR = 3_600_000;

/** The shift by the hour: its meeting (the minutes before it starts, from
 *  the shift times), the first hour — start of shift, permitting — then
 *  each hour to its end. */
export function hourSlots(shift: { start: number; end: number }, meetingBeforeMin: number): HourSlot[] {
  const out: HourSlot[] = [{ key: "meeting", kind: "meeting", start: shift.start - Math.max(0, meetingBeforeMin) * 60_000, end: shift.start }];
  for (let t = shift.start; t < shift.end; t += HOUR) out.push({ key: String(t), kind: t === shift.start ? "permit" : "work", start: t, end: Math.min(t + HOUR, shift.end) });
  return out;
}

/** The hour a time is in: before the shift, its meeting; after, its last hour. */
export function slotOf(at: number, slots: HourSlot[]): HourSlot {
  const hours = slots.filter((x) => x.kind !== "meeting");
  if (!hours.length || at < hours[0].start) return slots[0];
  return hours.find((x) => at >= x.start && at < x.end) ?? hours[hours.length - 1];
}

/** The lines that stand: by the hour, or an earlier draft someone approved
 *  (kept as theirs). An earlier draft nobody approved is written again. */
export function liveLines(n?: HourlyNotes | null): HourlyLine[] {
  if (!n) return [];
  if (n.v === 2) return n.lines;
  return n.approved ? n.lines.map((l) => ({ ...l, hand: true })) : [];
}

/** Each hour's lines, by its key. */
export function linesBySlot(n: HourlyNotes | null | undefined, slots: HourSlot[]): Map<string, HourlyLine[]> {
  const out = new Map<string, HourlyLine[]>();
  for (const l of [...liveLines(n)].sort((a, b) => a.at - b.at)) {
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

/** What an hour's entries are: a line written from them stands while this matches. */
export function hourSource(rows: TimeLogRow[], tz: string): string {
  const s = rows.map((r) => factLine(r, tz)).sort().join("\n");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${rows.length}.${(h >>> 0).toString(36)}`;
}

/** What to write: hours with entries whose line wasn't written from them
 *  (or was said plainly, when `retryPlain`), and hours whose entries are
 *  gone. An hour someone typed over is left alone. */
export function hoursToWrite(slots: HourSlot[], rows: Map<string, TimeLogRow[]>, lines: Map<string, HourlyLine[]>, tz: string, retryPlain: boolean): { write: Array<{ slot: HourSlot; rows: TimeLogRow[]; src: string }>; clear: string[] } {
  const write: Array<{ slot: HourSlot; rows: TimeLogRow[]; src: string }> = [], clear: string[] = [];
  for (const slot of slots) {
    if (slot.kind === "meeting") continue;
    const ls = lines.get(slot.key) ?? [];
    if (ls.some((l) => l.hand)) continue;
    const rs = rows.get(slot.key) ?? [];
    if (!rs.length) { if (ls.length) clear.push(slot.key); continue; }
    const src = hourSource(rs, tz);
    if (ls.length === 1 && ls[0].src === src && !(retryPlain && ls[0].plain)) continue;
    write.push({ slot, rows: rs, src });
  }
  return { write, clear };
}

/** An hour's entries said plainly — when the wording isn't to be had, or
 *  said something the entries don't: by crew, each step and what happened
 *  to it, with its comment. "Ancon: V-7 Hydroblast Piping done. Schultz:
 *  V-7 Inspect for Cleanliness started." */
export function plainHour(rows: TimeLogRow[]): string {
  const said = (r: TimeLogRow) => r.comment.replace(/\s+/g, " ").trim();
  // A discovery's own line says it; the comment it left on the step doesn't again.
  const shown = [...rows].sort((a, b) => a.at - b.at).filter((r) => !(r.what === "Comment" && /^(Discovery|Added scope):/.test(said(r))));
  const crews: string[] = [];
  const by = new Map<string, string[]>();
  const out: string[] = [];
  for (const r of shown) {
    // The shift's own notes and incidents: as said.
    if (!r.step) { out.push(`${r.what}: ${said(r)}`); continue; }
    const where = [shortTask(r.task), r.step].filter(Boolean).join(" ");
    const w = r.what;
    const what = /^Discovery found|^Added scope raised/.test(w) ? `${w.split(" ")[0] === "Added" ? "added scope" : "discovery"} — ${said(r).split(" — ")[0]}`
      : w === "Progress" ? `to ${r.pct.split("→").pop()?.trim() ?? r.pct}`
        : w.startsWith("Off ") ? "back in progress"
          : w === "Comment" || w === "Why it's behind" ? ""
            : w.toLowerCase();
    const note = /^Discovery found|^Added scope raised/.test(w) || !said(r) ? "" : `${what ? " — " : ": "}${said(r)}`;
    const k = r.crew || "";
    if (!by.has(k)) { by.set(k, []); crews.push(k); }
    by.get(k)!.push(`${where}${what ? ` ${what}` : ""}${note}`);
  }
  return [...crews.map((k) => `${k ? `${k}: ` : ""}${by.get(k)!.join("; ")}`), ...out].map((x) => (/[.!?]$/.test(x) ? x : `${x}.`)).join(" ");
}

/** The notes as the report and email give them: each hour up to `upTo`
 *  (the meeting always), its lines, "" when nothing was logged. */
export function hourlyRows(n: HourlyNotes | null | undefined, slots: HourSlot[], upTo: number): Array<{ slot: HourSlot; lines: HourlyLine[]; text: string }> {
  const by = linesBySlot(n, slots);
  return slots.filter((x) => x.kind === "meeting" || x.start <= upTo).map((slot) => {
    const lines = by.get(slot.key) ?? [];
    return { slot, lines, text: lines.map((l) => l.text).join(" ") };
  });
}

/** What each kind of hour is called. */
export const SLOT_LABEL: Record<SlotKind, string> = { meeting: "Shift meeting", permit: "Start of shift — permitting", work: "" };

/** "08:00" in plant time — the form times go to and come back from the model in. */
export function clock24(at: number, tz: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

/** "14:30" → "2:30 PM" — how the notes say a time to a person. */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "8:00 AM" on the first line and wherever AM/PM changes, "8:30" between
 *  — the way a shift writes its notes. */
export function hourlyClocks(ats: number[], tz: string): string[] {
  let prev = "";
  return ats.map((at) => {
    const s = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
    const [t, ap] = s.split(" ");
    const out = ap !== prev ? `${t} ${ap}` : t;
    prev = ap;
    return out;
  });
}

/** One entry, one line, for the model: time | what | step | task (WO) | crew | comment. */
export function factLine(r: TimeLogRow, tz: string): string {
  const what = r.what === "Progress" || (r.pct.includes("→") && r.what !== "Done") ? `${r.what} ${r.pct}` : r.what;
  const where = [r.step, r.task ? `${r.task}${r.wo ? ` (WO ${r.wo})` : ""}` : ""].filter(Boolean).join(" | ");
  return [clock24(r.at, tz), what, where, r.crew ? `crew ${r.crew}` : "", r.comment ? `comment: "${r.comment.replace(/\s+/g, " ").trim()}"` : ""]
    .filter(Boolean).join(" | ");
}

export const HOURLY_SYSTEM =
  "You write the hour-by-hour shift notes for a refinery turnaround shift report, the way a field " +
  "supervisor writes them for management: one short, plain line for each hour.\n\n" +
  "Example of the style:\n" +
  "07:00 – SS X-12 failed hydro, will stab X-11 takeout bundle.\n" +
  "09:00 – X-01 TS hydro sold, moving to X-14 TS and X-7.\n" +
  "14:00 – X-3 head hung, hanging X-4.\n\n" +
  "Rules:\n" +
  "- Write one line for each HOUR given, and no other hours. Return the hour exactly as given (HH:MM).\n" +
  "- Use ONLY that hour's entries. Never add a fact, cause, quantity, time, name, forecast or reason " +
  "that is not in them. If an entry says a thing is expected (\"expected back in 72 hrs\"), keep it " +
  "as expected.\n" +
  "- Cover every entry in the hour on its line. Don't put a clock time in the text unless an entry's " +
  "comment has it.\n" +
  "- Say who and what: the crew (\"Schultz\", \"Maintenance\"), the work in plain words (\"setting " +
  "blinds\", \"pulling the bundle\", \"done removing components\") and the equipment tag as the entry " +
  "has it (E-12, V-7, PSV-021, LV-009B). Name several of the same work together (\"blinds done on " +
  "E-12 and E-20\").\n" +
  "- Started → what they're doing now (\"Schultz removing components on E-20\"); Done → finished " +
  "(\"E-20 components removed\"); Progress → where it got, using the comment when there is one " +
  "(\"2 of 5 bundles out\"); a hold or block → held, with its reason.\n" +
  "- Keep each comment's facts; fix spelling and grammar only.\n" +
  "- No work order numbers and no percentages unless a comment is only a percentage.\n" +
  "- A shift note or a safety incident is its own fact on its hour's line, worded as given.\n" +
  "- Write it as the supervisor's own notes: never mention entries, instructions, a system or an assistant.\n\n" +
  'Return STRICT JSON only: {"hours":[{"hour":"07:00","text":"…"}]}';

/** The prompt's user turn: each hour to write, with its entries. */
export function hourlyPrompt(hours: Array<{ slot: HourSlot; rows: TimeLogRow[] }>, o: { tz: string; shiftTitle: string; window: string }): string {
  return [
    `SHIFT: ${o.shiftTitle} (${o.window})`,
    ...[...hours].sort((a, b) => a.slot.start - b.slot.start).flatMap(({ slot, rows }) => [
      "",
      `HOUR ${clock24(slot.start, o.tz)}${slot.kind === "permit" ? " — start of shift, permitting" : ""} (${clock24(slot.start, o.tz)}–${clock24(slot.end, o.tz)}), ${rows.length} entr${rows.length === 1 ? "y" : "ies"}, time | what | step | task (WO) | crew | comment:`,
      ...[...rows].sort((a, b) => a.at - b.at).map((r) => factLine(r, o.tz)),
    ]),
  ].join("\n");
}

/** The model's lines, read tolerantly: the JSON it was asked for, else
 *  "08:00 – text" lines. */
export function parseHourly(text: string): Array<{ time: string; text: string }> {
  const norm = (t: string) => {
    const m = /^\s*(\d{1,2}):(\d{2})/.exec(t);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  };
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as { lines?: Array<{ time?: unknown; hour?: unknown; text?: unknown }>; hours?: Array<{ time?: unknown; hour?: unknown; text?: unknown }> };
      const lines = (j.hours ?? j.lines ?? [])
        .map((l) => ({ time: norm(String(l.hour ?? l.time ?? "")), text: String(l.text ?? "").replace(/\s+/g, " ").trim() }))
        .filter((l) => l.time && l.text);
      if (lines.length) return lines;
    } catch { /* fall through to plain lines */ }
  }
  return text.split("\n").map((l) => {
    const m = /^\s*(\d{1,2}:\d{2})\s*(?:[AP]M)?\s*[–—-]\s*(.+)$/i.exec(l);
    return m ? { time: norm(m[1]), text: m[2].trim() } : null;
  }).filter((l): l is { time: string; text: string } => !!l);
}

// Tags (E-12, PSV-021, LV-009B, 14TS), numbers and dates, compared without
// dashes, spaces or case: "E12" is "E-12".
const squash = (s: string) => s.toUpperCase().replace(/[\s\-_.]/g, "");
const TAG = /\b[A-Za-z]{0,5}-?\d{1,5}[A-Za-z]{0,3}\b/g;
const DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const CLOCK = /\b\d{1,2}:\d{2}\b/g;

/** What a line says that its entries don't: a tag, date, clock time or
 *  number not in them. Empty when every one of them is. */
export function flagsFor(text: string, rows: TimeLogRow[]): string[] {
  const facts = rows.map((r) => `${r.task} ${r.step} ${r.crew} ${r.pct} ${r.comment} ${r.what}`).join(" \n ");
  const factsSq = squash(facts);
  const factNums = new Set((facts.match(/\d+/g) ?? []).map((n) => String(Number(n))));
  const flags: string[] = [];
  const unknownTags = [...new Set((text.replace(CLOCK, " ").match(TAG) ?? []).filter((t) => /[A-Za-z]/.test(t) && !factsSq.includes(squash(t))))];
  if (unknownTags.length) flags.push(`not in the entries: ${unknownTags.join(", ")}`);
  const unknownDates = [...new Set((text.match(DATE) ?? []).filter((d) => !d.split("/").every((n) => factNums.has(String(Number(n))))))];
  if (unknownDates.length) flags.push(`date not in the entries: ${unknownDates.join(", ")}`);
  // A time said in the text ("in orientation 6:00–7:15"): its hour must be
  // in the entries ("6am-7:15am"); ":00" needs nothing more.
  const clocks = [...new Set((text.match(CLOCK) ?? []).filter((c) => {
    const [h, m] = c.split(":").map(Number);
    return !(factNums.has(String(h)) && (m === 0 || factNums.has(String(m))));
  }))];
  if (clocks.length) flags.push(`time not in the entries: ${clocks.join(", ")}`);
  const bare = text.replace(CLOCK, " ").replace(TAG, (t) => (/[A-Za-z]/.test(t) ? " " : t)).replace(DATE, " ");
  const unknownNums = [...new Set((bare.match(/\d+/g) ?? []).map((n) => String(Number(n))).filter((n) => !factNums.has(n)))];
  if (unknownNums.length) flags.push(`number not in the entries: ${unknownNums.join(", ")}`);
  return flags;
}

/** The wording for each hour asked for, checked against that hour's
 *  entries — an hour missing from the answer, or whose wording says what
 *  its entries don't, is said plainly instead. */
export function wordHours(answer: Array<{ time: string; text: string }>, hours: Array<{ slot: HourSlot; rows: TimeLogRow[] }>, tz: string): Map<string, { text: string; plain: boolean }> {
  const out = new Map<string, { text: string; plain: boolean }>();
  for (const { slot, rows } of hours) {
    const said = answer.filter((a) => a.time === clock24(slot.start, tz)).map((a) => a.text).join(" ").trim();
    out.set(slot.key, said && flagsFor(said, rows).length === 0 ? { text: said, plain: false } : { text: plainHour(rows), plain: true });
  }
  return out;
}

/** "E-20 - Transmix Charge Exchanger" → "E-20". */
export const shortTask = (t: string) => t.replace(/\s+[-–—]\s+.*$/, "").trim();
