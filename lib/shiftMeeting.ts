// shiftMeeting - the meeting that starts each shift (5:30 AM for days,
// 5:30 PM for nights on a 6-to-6 job): who attended from each crew, each
// crew's head count on site, the safety topic talked through, and anything
// else said there. One meeting, one record: it's kept on the record of the
// shift it starts, so the day shift's 5:30 PM meeting and the night shift's
// 5:30 PM meeting are the same one, entered once.

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

/** The meeting as the log says it, one item a line:
 *  "Schultz, 12 on site: Mike Leonard, Joe Brown", "Total on site: 16",
 *  "Safety topic: Working at heights", then anything else typed. */
export function meetingLines(rec: ShiftRecord | undefined, shiftStart: number, order: string[] = []): string[] {
  const crews = meetingCrews(rec, order);
  const out = crews.map((x) => `${x.crew}${x.headcount != null ? `, ${x.headcount} on site` : ""}${x.names.length ? `: ${x.names.join(", ")}` : ""}`);
  const total = totalOnSite(crews);
  if (total != null && crews.filter((x) => x.headcount != null).length > 1) out.push(`Total on site: ${total}`);
  const topic = rec?.meeting?.safety?.trim();
  if (topic) out.push(`Safety topic: ${topic}`);
  out.push(...earlierMeetingLines(rec, shiftStart), ...(rec?.meeting?.note ?? "").split("\n").map((x) => x.trim()).filter(Boolean));
  return out.map(noEmDash);
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
