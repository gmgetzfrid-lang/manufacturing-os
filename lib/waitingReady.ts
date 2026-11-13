// waitingReady - the lists a shift's control meeting works from: jobs
// that had started and went this whole shift with nothing logged (and why,
// as their comments have it), and jobs that were ready before the shift
// began and still didn't start. Equipment out for repair or calibration is
// a planned step: it is listed apart, not as waiting.
//
// The same rules as the post-event review (lib/postEventReview), read for
// one shift as it stood at its end: a night shift counts only for work that
// ran on nights (its crew worked that work order on two or more nights).
//
// Pure: no database here.

import type { Milestone, MilestoneNote } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { shiftAt, type ShiftTimes, type ShiftWindow } from "@/lib/shiftReport";
import { commentsByStep, reasonBy, type CauseId } from "@/lib/postEventReview";

export interface WaitingJob {
  id: string; name: string; order: string; crew: string;
  /** Shifts in a row it has sat, this one included. */
  shifts: number;
  cause: CauseId; said: string | null;
  /** What its crew moved this shift instead (work orders). */
  crewOn: string[];
}
export interface ReadyJob { id: string; name: string; order: string; crew: string; shifts: number; readyAt: number; crewOn: string[] }
export interface WaitingReady {
  waiting: WaitingJob[]; ready: ReadyJob[];
  /** Out for repair or calibration, as its comment has it: a planned step. */
  service: WaitingJob[];
}

const toMs = (v: unknown): number | null => { const t = v == null || v === "" ? NaN : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
const keyOf = (w: Pick<ShiftWindow, "dayKey" | "kind">) => `${w.dayKey}:${w.kind}`;

export function waitingAndReady(input: { milestones: Milestone[]; log: ProgressLogRow[]; notes: MilestoneNote[]; tz: string; times: ShiftTimes; shift: ShiftWindow }): WaitingReady {
  const { tz, times, shift } = input;
  const live = input.milestones.filter((m) => m.id && !(m as { cancelledAt?: unknown }).cancelledAt);
  const byId = new Map(live.map((m) => [m.id!, m]));
  const parents = new Set(live.map((m) => m.parentId).filter(Boolean) as string[]);
  const leaves = live.filter((m) => !m.isSummary && !parents.has(m.id!));
  const leafIds = new Set(leaves.map((m) => m.id!));
  const orderOf = (m: Milestone) => (m.parentId ? byId.get(m.parentId)?.name ?? "" : "");
  const crewOf = (m: Milestone) => (m.actualParty || m.responsibleParty || "").trim() || "Not set";
  const pair = (m: Milestone) => `${m.parentId ?? m.id}|${crewOf(m)}`;
  const keyAt = (t: number) => keyOf(shiftAt(t, tz, times));
  const K = keyOf(shift);

  // Each step as it stood at the end of this shift.
  const touched = new Map<string, Set<string>>(), startedAt = new Map<string, number>(), doneAt = new Map<string, number>();
  for (const r of input.log) {
    const t = toMs(r.at);
    if (t == null || t > shift.end || !leafIds.has(r.milestone_id) || r.new_status === "planned") continue;
    if (!touched.has(r.milestone_id)) touched.set(r.milestone_id, new Set());
    touched.get(r.milestone_id)!.add(keyAt(t));
    if (!startedAt.has(r.milestone_id) || t < startedAt.get(r.milestone_id)!) startedAt.set(r.milestone_id, t);
    const done = r.new_status === "completed" || Number(r.new_percent ?? 0) >= 100;
    if (done && (!doneAt.has(r.milestone_id) || t < doneAt.get(r.milestone_id)!)) doneAt.set(r.milestone_id, t);
  }
  for (const m of leaves) {
    const s = toMs(m.actualStartAt), f = m.status === "completed" ? toMs(m.actualAt) : null;
    if (s != null && s <= shift.end) {
      if (!startedAt.has(m.id!) || s < startedAt.get(m.id!)!) startedAt.set(m.id!, s);
      if (!touched.has(m.id!)) touched.set(m.id!, new Set());
      touched.get(m.id!)!.add(keyAt(s));
    }
    if (f != null && f <= shift.end) {
      if (!doneAt.has(m.id!)) doneAt.set(m.id!, f);
      if (!touched.has(m.id!)) touched.set(m.id!, new Set());
      touched.get(m.id!)!.add(keyAt(f));
      if (!startedAt.has(m.id!)) startedAt.set(m.id!, f);
    }
  }

  // Work that ran on nights, and what each crew moved this shift.
  const nights = new Map<string, Set<string>>(), movedNow = new Map<string, Set<string>>();
  for (const m of leaves) {
    for (const k of touched.get(m.id!) ?? []) {
      if (k.endsWith(":night")) { if (!nights.has(pair(m))) nights.set(pair(m), new Set()); nights.get(pair(m))!.add(k); }
      if (k === K) { const c = crewOf(m); if (!movedNow.has(c)) movedNow.set(c, new Set()); movedNow.get(c)!.add(orderOf(m)); }
    }
  }
  const nightWork = (m: Milestone) => (nights.get(pair(m))?.size ?? 0) >= 2;
  const counts = (m: Milestone, kind: ShiftWindow["kind"]) => kind === "day" || nightWork(m);
  const elsewhere = (m: Milestone) => [...(movedNow.get(crewOf(m)) ?? [])].filter((n) => n && n !== orderOf(m));
  /** Shifts in a row, ending with this one, that count for it and stop at `until` (a shift it moved in, or became ready in). */
  const run = (m: Milestone, stop: (k: string, w: ShiftWindow) => boolean): number => {
    let n = 0, w = shift;
    for (let g = 0; g < 120; g++) {
      if (stop(keyOf(w), w)) break;
      if (counts(m, w.kind)) n++;
      w = shiftAt(w.start - 1, tz, times);
    }
    return n;
  };

  const said = commentsByStep(input.notes, (id) => leafIds.has(id));
  const waiting: WaitingJob[] = [], ready: ReadyJob[] = [], service: WaitingJob[] = [];
  for (const m of leaves) {
    const id = m.id!, started = startedAt.get(id), done = doneAt.get(id);
    if (!counts(m, shift.kind)) continue;
    if (started != null) {
      // Started before this shift, not finished by its end, nothing logged in it.
      if (started >= shift.start || (done != null && done <= shift.end) || touched.get(id)?.has(K)) continue;
      const by = reasonBy(said.get(id) ?? [], shift.end);
      const on = elsewhere(m);
      (by?.cause === "offsite" ? service : waiting).push({ id, name: m.name, order: orderOf(m), crew: crewOf(m), shifts: run(m, (k) => !!touched.get(id)?.has(k)), cause: by?.cause ?? (on.length ? "crew_elsewhere" : "none"), said: by?.said ?? null, crewOn: on });
      continue;
    }
    // Not started: everything before it done, and its planned start come, before this shift began.
    if (m.status === "blocked" || m.status === "on_hold") continue;
    const preds = (m.dependsOn ?? []).filter((p) => leafIds.has(p));
    if (!preds.length || preds.some((p) => doneAt.get(p) == null)) continue;
    const plan = toMs(m.baselineStartAt) ?? toMs(m.plannedStartAt);
    const readyAt = Math.max(...preds.map((p) => doneAt.get(p)!), plan ?? 0);
    if (readyAt >= shift.start) continue;
    const readyKey = keyAt(readyAt);
    ready.push({ id, name: m.name, order: orderOf(m), crew: crewOf(m), shifts: run(m, (k, w) => k === readyKey || w.end <= readyAt), readyAt, crewOn: elsewhere(m) });
  }
  waiting.sort((a, b) => b.shifts - a.shifts || a.order.localeCompare(b.order) || a.name.localeCompare(b.name));
  ready.sort((a, b) => b.shifts - a.shifts || a.order.localeCompare(b.order) || a.name.localeCompare(b.name));
  service.sort((a, b) => a.order.localeCompare(b.order) || a.name.localeCompare(b.name));
  return { waiting, ready, service };
}
