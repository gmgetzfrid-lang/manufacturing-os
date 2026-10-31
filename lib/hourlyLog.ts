// hourlyLog — the shift's notes, hour by hour, as a log to keep: one shift
// or every shift of the job, for the PDF, Word and Excel exports. The same
// hours the report shows (lib/shiftHourly): the meeting (who attended),
// start of shift (permitting), each hour, its breaks, and what each crew
// kept working on, and where each stood. Each hour says its own entries
// (or what someone typed over it), never anything made up.

import {
  hourSlots, hourlyRows, breaksOn, breakLabel, SLOT_LABEL, type SlotKind,
} from "@/lib/shiftHourly";
import { meetingLeadMin, shiftWindow, shiftWindowsBetween, workShiftOf, type ShiftTimes, type ShiftWindow, type WorkShift } from "@/lib/shiftReport";
import { crewLine } from "@/lib/managementUpdate";
import { noEmDash } from "@/lib/noEmDash";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { stepLabels, type TimeLogRow } from "@/lib/timeLog";
import type { Milestone } from "@/types/schema";

export interface LogEntry {
  /** "5:30 AM" */
  clock: string;
  kind: SlotKind;
  /** "Shift meeting", "Start of shift - permitting", "Lunch, 30 min". */
  title?: string;
  /** One item each: a crew's work, a note, an incident, a crew at the meeting. */
  lines: string[];
  /** Still under way from before, nothing new entered: "Schultz - V-7 Clean Tower". */
  continuing: string[];
}

export interface ShiftLog {
  /** "2026-10-29:day" (the shift's record key). */
  key: string;
  kind: "day" | "night";
  /** "Day shift" */
  title: string;
  /** "Thu, Oct 29, 2026" */
  date: string;
  /** "6:00 AM to 6:00 PM" */
  window: string;
  /** Still going when exported: up to when it's logged ("2:15 PM"). */
  through?: string;
  entries: LogEntry[];
}

/** A step as the log needs it: who works it, and on which shift. */
export interface LogStep { id: string; name: string; task: string; crew: string; work: WorkShift }

export type LogProgress = { milestone_id: string; at: string; new_status: string; new_percent?: number | null };

/** "5:30 AM", "12:00 AM": plant time, always with AM / PM. */
export function clockAt(at: number, tz: string): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).replace(/[  ]/g, " ");
}
const dateAt = (at: number, tz: string) => new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: tz });

/** "Exported Oct 30, 2026 7:10 AM" */
export const exportedLabel = (now: number, tz: string) =>
  `Exported ${new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz })} ${clockAt(now, tz)}`;

/** The schedule's steps (not the tasks above them), for what kept going. */
export function logSteps(milestones: Milestone[], tz: string, times: ShiftTimes): LogStep[] {
  const parents = new Set(milestones.map((m) => m.parentId).filter((x): x is string => !!x));
  const name = new Map(milestones.map((m) => [m.id, m.name]));
  const label = stepLabels(milestones);
  return milestones.filter((m) => m.id && !parents.has(m.id)).map((m) => ({
    id: m.id!, name: label.get(m.id!) ?? m.name, task: (m.parentId ? name.get(m.parentId) : "") ?? "", crew: m.responsibleParty?.trim() ?? "", work: workShiftOf(m, tz, times),
  }));
}

/** Who was at the meeting: the crews entered there, then the crews that
 *  worked the shift (no attendance entered: "-"). */
function meetingCrews(rec: ShiftRecord | undefined, rows: TimeLogRow[]): string[] {
  const out: string[] = [];
  const add = (c: string) => { const k = c.trim(); if (k && k !== "No crew named" && !out.includes(k)) out.push(k); };
  Object.keys(rec?.crews ?? {}).forEach(add);
  rows.forEach((r) => add(r.crew));
  return out.map((c) => `${c}: ${crewLine(rec?.crews?.[c])}`);
}

/** One shift's log, up to `now` while it's still going. `rows`: its
 *  entries (the time log for the shift); `log`: the job's progress log. */
export function shiftLog(o: {
  shift: ShiftWindow; tz: string; times: ShiftTimes;
  record?: ShiftRecord; rows: TimeLogRow[]; steps: LogStep[]; log: LogProgress[]; now: number;
}): ShiftLog {
  const { shift, tz } = o;
  const upTo = Math.min(o.now, shift.end);
  const slots = hourSlots(shift, meetingLeadMin(o.times), breaksOn(shift, o.times.breaks, tz));
  const rows = o.rows.filter((r) => r.at >= shift.start && r.at < shift.end);
  // The same hours, and the same lines, as the report shows.
  const entries = hourlyRows(o.record?.hourly, slots, upTo, rows, tz).map(({ slot, lines, progress }): LogEntry => {
    const clock = clockAt(slot.start, tz);
    if (slot.kind === "meeting") {
      return { clock, kind: "meeting", title: SLOT_LABEL.meeting, lines: [...meetingCrews(o.record, rows), ...lines], continuing: [] };
    }
    if (slot.kind === "break") return { clock, kind: "break", title: breakLabel(slot), lines: [], continuing: [] };
    return { clock, kind: slot.kind, ...(slot.kind === "permit" || slot.kind === "handover" ? { title: SLOT_LABEL[slot.kind] } : {}), lines, continuing: progress.map(noEmDash) };
  });
  return {
    key: `${shift.dayKey}:${shift.kind}`, kind: shift.kind,
    title: shift.kind === "day" ? "Day shift" : "Night shift",
    date: dateAt(shift.start, tz),
    window: `${clockAt(shift.start, tz)} to ${clockAt(shift.end, tz)}`,
    ...(o.now < shift.end ? { through: clockAt(o.now, tz) } : {}),
    entries,
  };
}

/** Anything in it: an hour that says something, or attendance entered. */
export function logHasWork(l: ShiftLog): boolean {
  return l.entries.some((e) => (e.kind !== "meeting" && e.kind !== "break" && (e.lines.length > 0 || e.continuing.length > 0))
    || (e.kind === "meeting" && e.lines.some((x) => !x.endsWith(": -"))));
}

/** Every shift of the job with something in it, first to last (up to now). */
export function jobLogs(o: {
  milestones: Milestone[]; timeLog: TimeLogRow[]; records: Map<string, ShiftRecord>; log: LogProgress[];
  tz: string; times: ShiftTimes; now: number;
}): ShiftLog[] {
  const { tz, times } = o;
  const steps = logSteps(o.milestones, tz, times);
  // From the first thing that happened (the progress log's own lines for
  // a step being made aren't).
  const starts = [
    ...o.timeLog.map((r) => r.at),
    ...[...o.records.keys()].map((k) => /^(\d{4}-\d{2}-\d{2}):(day|night)$/.exec(k)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => shiftWindow(m[1], m[2] as "day" | "night", tz, times).start),
  ].filter((t) => Number.isFinite(t) && t <= o.now);
  if (!starts.length) return [];
  const from = Math.min(...starts);
  return shiftWindowsBetween(from, o.now + 1, tz, times)
    .map((shift) => shiftLog({ shift, tz, times, record: o.records.get(`${shift.dayKey}:${shift.kind}`), rows: o.timeLog, steps, log: o.log, now: o.now }))
    .filter(logHasWork);
}
