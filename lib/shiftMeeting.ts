// shiftMeeting - the meeting that starts each shift (5:30 AM for days,
// 5:30 PM for nights on a 6-to-6 job): who attended from each crew, each
// crew's head count on site, the safety topic talked through, and anything
// else said there. One meeting, one record: it's kept on the record of the
// shift it starts, so the day shift's 5:30 PM meeting and the night shift's
// 5:30 PM meeting are the same one, entered once. Who attends and the head
// counts carry from the last same shift (day to day, night to night) until
// they're changed for a shift; the change is that shift's own.

import type { CrewCount, ShiftRecord } from "@/lib/shiftRecord";
import { typedLines } from "@/lib/shiftHourly";
import { noEmDash } from "@/lib/noEmDash";

/** The meeting's own record (beside its crews' attendance). */
export interface ShiftMeeting {
  /** Wasn't held: off the log (it can be put back). */
  off?: boolean;
  /** The safety topic talked through. */
  safety?: string;
  /** Anything else from the meeting, as typed (one line each). */
  note?: string;
  /** Its crews are its own (changed or checked for this shift), not
   *  carried from the last same shift. */
  ownCrews?: boolean;
}

/** Who attended from a crew: the names entered (earlier: its supervisor). */
export const crewNames = (c?: CrewCount): string[] =>
  c?.names ?? (c?.supervisor?.trim() ? [c.supervisor.trim()] : []);

/** A name as it's kept: one space between words, no em dash. */
export const cleanName = (s: string) => noEmDash(s).replace(/\s+/g, " ").trim();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The names with one more (the same name twice is kept once). */
export function withName(names: string[], name: string): string[] {
  const n = cleanName(name);
  return !n || names.some((x) => same(x, n)) ? names : [...names, n];
}
/** The names with one changed in place (to a name already there: dropped). */
export function renamed(names: string[], from: string, to: string): string[] {
  const n = cleanName(to);
  if (!n) return names.filter((x) => x !== from);
  if (names.some((x) => x !== from && same(x, n))) return names.filter((x) => x !== from);
  return names.map((x) => (x === from ? n : x));
}
export const withoutName = (names: string[], name: string) => names.filter((x) => x !== name);

/** A crew's record with its names changed (its old supervisor field folded in). */
export function setNames(c: CrewCount | undefined, change: (names: string[]) => string[]): CrewCount {
  const { supervisor: _old, ...rest } = c ?? {};
  void _old;
  return { ...rest, names: change(crewNames(c)) };
}

export interface MeetingCrew { crew: string; names: string[]; headcount: number | null }

/** The crews at the meeting with anyone named or counted, in `order` first
 *  (the crews on the plan), then the rest as added. */
export function meetingCrews(rec: ShiftRecord | undefined, order: string[] = []): MeetingCrew[] {
  const crews = rec?.crews ?? {};
  const keys = [...order.filter((k) => k in crews), ...Object.keys(crews).filter((k) => !order.includes(k))];
  return keys.map((crew) => ({ crew, names: crewNames(crews[crew]), headcount: crews[crew]?.headcount ?? null }))
    .filter((x) => x.names.length || x.headcount != null);
}

/** Everyone on site: each crew's head count added up (none entered: null). */
export function totalOnSite(crews: Array<{ headcount: number | null | undefined }>): number | null {
  const n = crews.filter((x) => x.headcount != null);
  return n.length ? n.reduce((a, x) => a + (x.headcount ?? 0), 0) : null;
}

/** What was typed at the meeting before it had its own record: the lines
 *  on the shift's notes before the shift starts. */
export function earlierMeetingLines(rec: ShiftRecord | undefined, shiftStart: number): string[] {
  return typedLines(rec?.hourly).filter((l) => l.at < shiftStart).flatMap((l) => l.text.split("\n")).map((x) => noEmDash(x).trim()).filter(Boolean);
}

/** The meeting as a table: each resource, its supervisor at the meeting,
 *  its employees on site; the total; then the safety topic and notes. */
export interface MeetingParts {
  rows: Array<{ crew: string; supervisor: string; onSite: number | null }>;
  /** Everyone on site (two or more resources counted), else null. */
  total: number | null;
  safety: string;
  notes: string[];
}
export function meetingParts(rec: ShiftRecord | undefined, shiftStart: number, order: string[] = []): MeetingParts {
  const crews = meetingCrews(rec, order);
  const total = totalOnSite(crews);
  return {
    rows: crews.map((x) => ({ crew: noEmDash(x.crew), supervisor: noEmDash(x.names.join(", ")), onSite: x.headcount })),
    total: total != null && crews.filter((x) => x.headcount != null).length > 1 ? total : null,
    safety: noEmDash(rec?.meeting?.safety?.trim() ?? ""),
    notes: [...earlierMeetingLines(rec, shiftStart), ...(rec?.meeting?.note ?? "").split("\n").map((x) => noEmDash(x).trim()).filter(Boolean)],
  };
}
export const meetingEmpty = (m: MeetingParts) => !m.rows.length && !m.safety && !m.notes.length;
/** "12 employees on site", "1 employee on site". */
export const onSiteText = (n: number) => `${n} employee${n === 1 ? "" : "s"} on site`;

/** The meeting as plain text, one item a line (Excel, copied text):
 *  "Schultz: supervisor Mike Leonard, 12 employees on site",
 *  "Total on site: 16", "Safety topic: Working at heights", then notes. */
export function meetingLines(rec: ShiftRecord | undefined, shiftStart: number, order: string[] = []): string[] {
  const m = meetingParts(rec, shiftStart, order);
  return [
    ...m.rows.map((x) => `${x.crew}: ${[x.supervisor ? `supervisor ${x.supervisor}` : "", x.onSite != null ? onSiteText(x.onSite) : ""].filter(Boolean).join(", ")}`),
    ...(m.total != null ? [`Total on site: ${m.total}`] : []),
    ...(m.safety ? [`Safety topic: ${m.safety}`] : []),
    ...m.notes,
  ];
}

/** Anything entered for the meeting. */
export const meetingEntered = (rec: ShiftRecord | undefined, shiftStart: number) => meetingLines(rec, shiftStart).length > 0;

/** "Day shift meeting" / "Night shift meeting": whose meeting it is. */
export const meetingTitle = (kind: "day" | "night") => `${kind === "day" ? "Day" : "Night"} shift meeting`;

/** Which meeting rows of a shift's notes are off (not held), and which
 *  show before their time (entered already, from the next shift). */
export function meetingRows(start: ShiftRecord | undefined, end: ShiftRecord | undefined, nextStart: number): { off: string[]; show: string[] } {
  return {
    off: [start?.meeting?.off ? "meeting" : null, end?.meeting?.off ? "meeting:end" : null].filter((x): x is string => !!x),
    show: meetingEntered(end, nextStart) ? ["meeting:end"] : [],
  };
}

/** Every name entered at a meeting, by crew, A to Z (to pick from as you type). */
export function knownNames(records: Map<string, ShiftRecord>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of records.values()) {
    for (const [crew, c] of Object.entries(r.crews ?? {})) for (const n of crewNames(c)) out[crew] = withName(out[crew] ?? [], n);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.localeCompare(b));
  return out;
}

/** "2026-10-27:day" before "2026-10-27:night" before "2026-10-28:day". */
const compareKeys = (a: string, b: string) => {
  const [da, ka] = a.split(":"), [db, kb] = b.split(":");
  return da < db ? -1 : da > db ? 1 : ka === kb ? 0 : ka === "day" ? -1 : 1;
};

/** The crews were set for this shift (changed, or checked as they were). */
export const hasOwnRoster = (r?: ShiftRecord) => !!r?.meeting?.ownCrews || Object.keys(r?.crews ?? {}).length > 0;

/** Who attends a shift's meeting and its head counts: its own, or carried
 *  from the last same shift that set them (`from`: that shift's key). */
export function rosterFor(records: Map<string, ShiftRecord>, key: string): { crews: Record<string, CrewCount>; from: string | null } {
  const own = records.get(key);
  if (hasOwnRoster(own)) return { crews: own?.crews ?? {}, from: null };
  const kind = key.split(":")[1];
  const prev = [...records.keys()].filter((k) => k.split(":")[1] === kind && compareKeys(k, key) < 0 && hasOwnRoster(records.get(k))).sort(compareKeys).at(-1);
  return prev ? { crews: records.get(prev)?.crews ?? {}, from: prev } : { crews: {}, from: null };
}

/** A shift's record as its meeting reads: its own, with the crews carried
 *  in when it has none of its own. */
export function meetingRecord(records: Map<string, ShiftRecord>, key: string): { record: ShiftRecord | undefined; from: string | null } {
  const own = records.get(key);
  const r = rosterFor(records, key);
  if (!r.from) return { record: own, from: null };
  return { record: { ...(own ?? {}), crews: r.crews }, from: r.from };
}

