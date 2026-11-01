// hourlyLog - the shift's notes, hour by hour, as a log to keep: one shift
// or every shift of the job, for the PDF, Word and Excel exports. The same
// hours the report shows (lib/shiftHourly): the meeting (who attended from
// each crew, head counts, the safety topic), start of shift (permitting),
// each hour, its breaks, and the meeting that starts the next shift. Each
// hour says its own entries (or what someone typed over it), never
// anything made up.

import {
  hourSlots, hourlyRows, breaksOn, breakLabel, workOrderClosers, SLOT_LABEL, type SlotKind,
} from "@/lib/shiftHourly";
import { meetingLeadMin, nextShift, previousShift, shiftWindow, shiftWindowsBetween, workShiftOf, type ShiftTimes, type ShiftWindow, type WorkShift } from "@/lib/shiftReport";
import { meetingLines, meetingParts, meetingRows, meetingTitle, meetingRecord, type MeetingParts } from "@/lib/shiftMeeting";
import { overtimeOf, overtimeEnd, overtimeLine, sentHomeLine, shiftEntries } from "@/lib/holdOver";
import { noEmDash } from "@/lib/noEmDash";
import type { ShiftRecord } from "@/lib/shiftRecord";
import { stepLabels, type TimeLogRow } from "@/lib/timeLog";
import type { Milestone } from "@/types/schema";

export interface LogEntry {
  /** "5:30 AM" */
  clock: string;
  kind: SlotKind;
  /** "Day shift meeting", "Start of shift - permitting", "Lunch, 30 min". */
  title?: string;
  /** One item each: a crew's work, a note, an incident, a crew at the meeting. */
  lines: string[];
  /** What moved its % that hour (in the progress color). */
  continuing: string[];
  /** Its lines that finished a whole work order (in green). */
  closed?: string[];
  /** A meeting with nothing entered for this shift: its crews carried
   *  from the last same shift (not counted as something in the log). */
  carried?: boolean;
  /** A meeting as a table: resource, supervisor, employees on site; the
   *  total; the safety topic; notes (`lines` says the same as text). */
  meeting?: MeetingParts;
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

/** One shift's log, up to `now` while it's still going. `rows`: its
 *  entries (the time log for the shift); `log`: the job's progress log;
 *  `next`: the next shift's record (the meeting that starts it ends this
 *  shift's log). `carried`: whose meeting crews came from the last same
 *  shift (lib/shiftMeeting meetingRecord). */
export function shiftLog(o: {
  shift: ShiftWindow; tz: string; times: ShiftTimes;
  record?: ShiftRecord; next?: ShiftRecord; rows: TimeLogRow[]; steps: LogStep[]; log: LogProgress[]; now: number;
  carried?: { start?: boolean; end?: boolean };
  /** The entries that finish a whole work order (lib/shiftHourly workOrderClosers). */
  closes?: (r: TimeLogRow) => boolean;
  /** The shift before's record (its crews held over into this one). */
  prev?: ShiftRecord;
}): ShiftLog {
  const { shift, tz } = o;
  // Crews held over past its end (overtime) and the ones the shift before
  // held over into it: their work is the shift's that held them.
  const own = overtimeOf(o.record?.holdOver, shift.end, o.now, shift.end + (shift.end - shift.start));
  const before = overtimeOf(o.prev?.holdOver, shift.start, o.now, shift.end);
  const otTo = overtimeEnd(own, shift.end);
  const upTo = Math.min(o.now, otTo);
  const slots = hourSlots(shift, meetingLeadMin(o.times), breaksOn(shift, o.times.breaks, tz),
    own.length ? { to: otTo, open: own.some((x) => x.open), label: overtimeLine(own), endLabel: sentHomeLine(own) } : undefined);
  const rows = shiftEntries(o.rows, shift, own, before);
  const other = shift.kind === "day" ? "night" : "day";
  // The same hours, and the same lines, as the report shows.
  // The end meeting shows before its time only for what was entered for it.
  const mr = meetingRows(o.record, o.carried?.end ? { ...(o.next ?? {}), crews: {} } : o.next, shift.end, { startOff: before.length > 0, endOff: own.length > 0 });
  const entries = hourlyRows(o.record?.hourly, slots, upTo, rows, tz, { ...mr, closes: o.closes }).map(({ slot, lines, progress, closed }): LogEntry => {
    const clock = clockAt(slot.start, tz);
    // The meetings: who attended, head counts, the safety topic, as entered.
    // Carried crews alone aren't something entered on the shift.
    const meet = (rec: ShiftRecord | undefined, start: number, carried?: boolean) => {
      const lines = meetingLines(rec, start);
      return { lines, continuing: [], meeting: meetingParts(rec, start), ...(carried && !meetingLines({ ...(rec ?? {}), crews: {} }, start).length ? { carried: true } : {}) };
    };
    if (slot.kind === "meeting") return { clock, kind: "meeting", title: meetingTitle(shift.kind), ...meet(o.record, shift.start, o.carried?.start) };
    if (slot.kind === "handover") return { clock, kind: "handover", title: meetingTitle(other), ...meet(o.next, shift.end, o.carried?.end) };
    if (slot.kind === "break") return { clock, kind: "break", title: breakLabel(slot), lines: [], continuing: [] };
    if (slot.kind === "overtime") return { clock, kind: "overtime", title: slot.label ?? SLOT_LABEL.overtime, lines: [], continuing: [] };
    return { clock, kind: slot.kind, ...(slot.kind === "permit" ? { title: SLOT_LABEL.permit } : {}), lines, continuing: progress.map(noEmDash), ...(closed.length ? { closed } : {}) };
  });
  return {
    key: `${shift.dayKey}:${shift.kind}`, kind: shift.kind,
    title: shift.kind === "day" ? "Day shift" : "Night shift",
    date: dateAt(shift.start, tz),
    window: `${clockAt(shift.start, tz)} to ${clockAt(shift.end, tz)}${otTo > shift.end ? `, overtime to ${clockAt(otTo, tz)}` : ""}`,
    ...(o.now < otTo ? { through: clockAt(o.now, tz) } : {}),
    entries,
  };
}

/** Anything in it: an hour that says something, or a meeting entered on
 *  the shift (not only carried from the last one). */
export function logHasWork(l: ShiftLog): boolean {
  return l.entries.some((e) => e.kind !== "break" && !e.carried && (e.lines.length > 0 || e.continuing.length > 0));
}

/** Every shift of the job with something in it, first to last (up to now). */
export function jobLogs(o: {
  milestones: Milestone[]; timeLog: TimeLogRow[]; records: Map<string, ShiftRecord>; log: LogProgress[];
  tz: string; times: ShiftTimes; now: number;
}): ShiftLog[] {
  const { tz, times } = o;
  const steps = logSteps(o.milestones, tz, times);
  const closes = workOrderClosers(o.milestones);
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
    .map((shift) => logOfShift(o, shift, steps, closes))
    .filter(logHasWork);
}

/** One shift's log, as the job's logs have it (empty or not). */
export function oneShiftLog(o: {
  milestones: Milestone[]; timeLog: TimeLogRow[]; records: Map<string, ShiftRecord>; log: LogProgress[];
  tz: string; times: ShiftTimes; now: number;
}, shift: ShiftWindow): ShiftLog {
  return logOfShift(o, shift, logSteps(o.milestones, o.tz, o.times), workOrderClosers(o.milestones));
}

function logOfShift(o: { timeLog: TimeLogRow[]; records: Map<string, ShiftRecord>; log: LogProgress[]; tz: string; times: ShiftTimes; now: number },
  shift: ShiftWindow, steps: ReturnType<typeof logSteps>, closes: ReturnType<typeof workOrderClosers>): ShiftLog {
  const { tz, times } = o;
  const nx = nextShift(shift, tz, times), pv = previousShift(shift, tz, times);
  // Each meeting's crews: its own, or carried from the last same shift.
  const a = meetingRecord(o.records, `${shift.dayKey}:${shift.kind}`), b = meetingRecord(o.records, `${nx.dayKey}:${nx.kind}`);
  return shiftLog({ shift, tz, times, record: a.record, next: b.record, carried: { start: !!a.from, end: !!b.from }, rows: o.timeLog, steps, log: o.log, now: o.now, closes, prev: o.records.get(`${pv.dayKey}:${pv.kind}`) });
}
