// shiftHourly — the hour-by-hour shift notes for the report and email:
// "8:00 – Schultz setting blinds on E-12, E-17 and E-20…", written from the
// shift's own entries (lib/timeLog: starts, progress, holds, done, comments,
// the shift's notes and incidents) and nothing else.
//
// The model only words it. Every line it returns is checked against the
// entries: its time must be one the entries have, and every tag, number and
// date in it must appear in them — anything else is flagged on the line for
// the person to look at before the notes are approved. Entry times the
// notes leave out are listed too. Nothing reaches the email until someone
// approves it.

import type { TimeLogRow } from "@/lib/timeLog";

export interface HourlyLine {
  id: string;
  /** When (plant time on the shift). */
  at: number;
  text: string;
  /** What the check found on a drafted line; cleared when someone edits it. */
  flags?: string[];
}

export interface HourlyNotes {
  lines: HourlyLine[];
  /** Entry times the draft left out ("13:30 FV-008B, TV-006"). */
  missing?: string[];
  /** Model that drafted it, and when / by whom. */
  model?: string;
  madeAt?: number;
  madeBy?: string | null;
  /** Approved for the report and email. Null = still a draft. */
  approved?: { at: number; by?: string | null } | null;
}

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
  "supervisor writes them for management: one line per time, short and plain.\n\n" +
  "Example of the style:\n" +
  "07:00 – SS X-12 failed hydro, will stab X-11 takeout bundle.\n" +
  "09:00 – X-01 TS hydro sold, moving to X-14 TS and X-7.\n" +
  "14:00 – X-3 head hung, hanging X-4.\n\n" +
  "Rules:\n" +
  "- Use ONLY the entries given. Never add a fact, cause, quantity, time, name, forecast or reason " +
  "that is not in them. If an entry says a thing is expected (\"expected back in 72 hrs\"), keep it " +
  "as expected.\n" +
  "- Every entry must be covered. Put entries that share a time on that time's line.\n" +
  "- One line per time that has entries, in time order. The time is the entry's time, exactly as " +
  "given (24-hour HH:MM). Never invent or round a time.\n" +
  "- Say who and what: the crew (\"Schultz\", \"Maintenance\"), the work in plain words (\"setting " +
  "blinds\", \"pulling the bundle\", \"done removing components\") and the equipment tag as the entry " +
  "has it (E-12, V-7, PSV-021, LV-009B). Name several of the same work together (\"blinds done on " +
  "E-12 and E-20\").\n" +
  "- Started → what they're doing now (\"Schultz removing components on E-20\"); Done → finished " +
  "(\"E-20 components removed\"); Progress → where it got, using the comment when there is one " +
  "(\"2 of 5 bundles out\"); a hold or block → held, with its reason.\n" +
  "- Keep each comment's facts; fix spelling and grammar only.\n" +
  "- No work order numbers and no percentages unless a comment is only a percentage.\n" +
  "- A shift note or a safety incident is its own fact on its time's line, worded as given.\n\n" +
  'Return STRICT JSON only: {"lines":[{"time":"08:00","text":"…"}]}';

/** The prompt's user turn. */
export function hourlyPrompt(rows: TimeLogRow[], o: { tz: string; shiftTitle: string; window: string }): string {
  return [
    `SHIFT: ${o.shiftTitle} (${o.window})`,
    `ENTRIES (${rows.length}), time | what | step | task (WO) | crew | comment:`,
    ...[...rows].sort((a, b) => a.at - b.at).map((r) => factLine(r, o.tz)),
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
      const j = JSON.parse(text.slice(start, end + 1)) as { lines?: Array<{ time?: unknown; text?: unknown }> };
      const lines = (j.lines ?? [])
        .map((l) => ({ time: norm(String(l.time ?? "")), text: String(l.text ?? "").replace(/\s+/g, " ").trim() }))
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

/** Check drafted lines against the entries they came from. */
export function checkHourly(
  lines: Array<{ time: string; text: string }>,
  rows: TimeLogRow[],
  tz: string,
): { lines: Array<{ time: string; text: string; at: number | null; flags: string[] }>; missing: string[] } {
  const atOf = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => a.at - b.at)) { const c = clock24(r.at, tz); if (!atOf.has(c)) atOf.set(c, r.at); }
  const facts = rows.map((r) => `${r.task} ${r.step} ${r.crew} ${r.pct} ${r.comment} ${r.what}`).join(" \n ");
  const factsSq = squash(facts);
  const factNums = new Set((facts.match(/\d+/g) ?? []).map((n) => String(Number(n))));
  const out = lines.map((l) => {
    const flags: string[] = [];
    const at = atOf.get(l.time) ?? null;
    if (at == null) flags.push(`${clock12(l.time)} isn't a time in the entries`);
    const unknownTags = [...new Set((l.text.replace(CLOCK, " ").match(TAG) ?? []).filter((t) => /[A-Za-z]/.test(t) && !factsSq.includes(squash(t))))];
    if (unknownTags.length) flags.push(`not in the entries: ${unknownTags.join(", ")}`);
    const unknownDates = [...new Set((l.text.match(DATE) ?? []).filter((d) => !d.split("/").every((n) => factNums.has(String(Number(n))))))];
    if (unknownDates.length) flags.push(`date not in the entries: ${unknownDates.join(", ")}`);
    // A time said in the text ("in orientation 6:00–7:15"): its hour must be
    // in the entries ("6am-7:15am"); ":00" needs nothing more.
    const clocks = [...new Set((l.text.match(CLOCK) ?? []).filter((c) => {
      const [h, m] = c.split(":").map(Number);
      return !(factNums.has(String(h)) && (m === 0 || factNums.has(String(m))));
    }))];
    if (clocks.length) flags.push(`time not in the entries: ${clocks.join(", ")}`);
    const bare = l.text.replace(CLOCK, " ").replace(TAG, (t) => (/[A-Za-z]/.test(t) ? " " : t)).replace(DATE, " ");
    const unknownNums = [...new Set((bare.match(/\d+/g) ?? []).map((n) => String(Number(n))).filter((n) => !factNums.has(n)))];
    if (unknownNums.length) flags.push(`number not in the entries: ${unknownNums.join(", ")}`);
    return { ...l, at, flags };
  });
  const said = new Set(lines.map((l) => l.time));
  const missing: string[] = [];
  for (const c of atOf.keys()) {
    if (said.has(c)) continue;
    const at = rows.filter((r) => clock24(r.at, tz) === c);
    const names = [...new Set(at.map((r) => shortTask(r.task) || r.step))].slice(0, 4);
    missing.push(`${clock12(c)} ${names.join(", ")}`);
  }
  return { lines: out, missing };
}

/** "E-20 - Transmix Charge Exchanger" → "E-20". */
export const shortTask = (t: string) => t.replace(/\s+[-–—]\s+.*$/, "").trim();

/** The approved lines, for the email and print; none while it's a draft. */
export function approvedLines(n: HourlyNotes | undefined): HourlyLine[] {
  return n?.approved ? [...n.lines].sort((a, b) => a.at - b.at) : [];
}
