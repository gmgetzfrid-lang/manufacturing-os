// holdOver - a crew kept on past the end of its shift (overtime): the day
// crew held over when there's no night shift to hand to. Its work stays on
// the shift that held it over (the hourly log, the report's progress), not
// on the next one, until it's sent home; the crew that takes over then
// carries on from there. Kept on the record of the shift that held it over.

import type { TimeLogRow } from "@/lib/timeLog";

export interface HoldOver {
  id: string;
  /** The crew held over, as on the schedule ("Schultz"). */
  crew: string;
  /** How many were kept on. */
  hands?: number | null;
  /** Who, or why ("Exchanger hands only"). */
  note?: string;
  /** Sent home (null: still on). */
  until?: number | null;
  /** The crew that takes over after ("Maintenance (KE)"). */
  takeover?: string | null;
  at: number;
  by?: string | null;
}

/** A crew's overtime on a shift: from the end of the shift to when it was
 *  sent home (still on: up to now, at most `cap`). */
export interface OvertimeWindow { crew: string; from: number; to: number; open: boolean; hands: number | null; note: string; takeover: string }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A shift's overtime, each crew held over. */
export function overtimeOf(list: HoldOver[] | undefined, shiftEnd: number, now: number, cap: number): OvertimeWindow[] {
  return (list ?? []).filter((h) => h.crew?.trim()).map((h) => {
    const open = h.until == null;
    const to = Math.min(cap, Math.max(shiftEnd, open ? now : h.until!));
    return { crew: h.crew.trim(), from: shiftEnd, to, open, hands: h.hands ?? null, note: h.note?.trim() ?? "", takeover: h.takeover?.trim() ?? "" };
  });
}

/** When the shift's day really ends: its last crew sent home (or now). */
export const overtimeEnd = (w: OvertimeWindow[], shiftEnd: number) => Math.max(shiftEnd, ...w.map((x) => x.to));

/** An entry on a held-over crew's work, in its overtime. */
export const inOvertime = (w: OvertimeWindow[], crew: string, at: number) =>
  // Logged as it was sent home: its last.
  w.some((x) => crew && same(x.crew, crew) && at >= x.from && (x.open ? at < x.to : at <= x.to));

/** The entries a shift's log says: its own hours, its held-over crews'
 *  work after them; not the work of the crews the shift before held over. */
export function shiftEntries(rows: TimeLogRow[], shift: { start: number; end: number }, own: OvertimeWindow[], before: OvertimeWindow[]): TimeLogRow[] {
  return rows.filter((r) => (r.at >= shift.start && r.at < shift.end && !inOvertime(before, r.crew, r.at)) || (r.at >= shift.end && inOvertime(own, r.crew, r.at)));
}

/** "Overtime: Schultz held over, 6 hands. Exchanger hands only." */
export function overtimeLine(w: OvertimeWindow[]): string {
  return `Overtime: ${w.map((x) => `${x.crew} held over${x.hands != null ? `, ${x.hands} hand${x.hands === 1 ? "" : "s"}` : ""}${x.note ? `. ${x.note.replace(/[.\s]+$/, "")}` : ""}`).join("; ")}.`;
}

/** "Schultz sent home. Maintenance (KE) takes over." */
export function sentHomeLine(w: OvertimeWindow[]): string {
  const crews = w.map((x) => x.crew);
  const takeover = [...new Set(w.map((x) => x.takeover).filter(Boolean))];
  return `${crews.join(", ")} sent home.${takeover.length ? ` ${takeover.join(", ")} take${takeover.length === 1 ? "s" : ""} over.` : ""}`;
}

/** "21:30" picked for a crew held over: that time after the shift's end
 *  (past midnight, the next day). */
export function timeAfter(shiftEnd: number, hm: string, tz: string, onDay: (day: string, hm: string, tz: string) => number | null, dayOf: (ms: number, tz: string) => string): number | null {
  const first = onDay(dayOf(shiftEnd, tz), hm, tz);
  if (first == null) return null;
  return first >= shiftEnd ? first : onDay(dayOf(shiftEnd + 24 * 3_600_000, tz), hm, tz);
}
