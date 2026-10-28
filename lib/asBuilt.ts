// asBuilt — where the work actually happened, for the calendar and the
// day list. The plan is never changed; this only decides where a step is
// SHOWN:
//   • DONE: when it was done — from the start recorded for it (or, marked
//     done straight off, its planned start when that came first) to the
//     time it was done. Done ahead of plan, it sits on the day it was done,
//     not the day it was planned.
//   • STARTED AHEAD of its planned start: from the start recorded to its
//     planned finish — it's on today's list, and still due when planned.
//   • Everything else: where it's planned.
// A task (a parent) spans its steps: first one worked to the last one
// due. So a job worked two days early sits on the day it was worked, and
// still shows on the day its last step is planned.

import type { Milestone } from "@/types/schema";
import { startMsOf, finishMsOf } from "@/lib/calendarPlacement";
import { shiftAt, type ShiftTimes } from "@/lib/shiftReport";
import { stepBandDays, type BandDays } from "@/lib/shiftBands";

export type BuiltKind = "planned" | "done" | "started";

export interface BuiltSpan {
  start: number;
  finish: number;
  kind: BuiltKind;
  /** Shown before its planned start: done or started ahead of plan. */
  ahead: boolean;
}

const toMs = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

/** Where one step is shown. */
export function builtSpan(m: Milestone): BuiltSpan {
  const ps = startMsOf(m), pf = finishMsOf(m);
  const as = toMs(m.actualStartAt), af = toMs(m.actualAt);
  if (m.status === "completed" && Number.isFinite(af)) {
    // A start recorded before it was done; marked done straight off, the
    // planned start when that came first (worked on plan or late); done
    // ahead of its plan, the moment it was done.
    const start = Number.isFinite(as) && as < af - 60_000 ? as : Number.isFinite(ps) && ps < af ? ps : af;
    return { start, finish: af, kind: "done", ahead: Number.isFinite(ps) && start < ps };
  }
  if (m.status !== "completed" && m.status !== "planned" && Number.isFinite(as) && Number.isFinite(ps) && as < ps) {
    return { start: as, finish: Number.isFinite(pf) ? Math.max(pf, as) : as, kind: "started", ahead: true };
  }
  return { start: ps, finish: pf, kind: "planned", ahead: false };
}

export interface AsBuilt {
  /** The row with its dates where it's shown (the same row when that's its plan). */
  row: (m: Milestone) => Milestone;
  span: (m: Milestone) => BuiltSpan | undefined;
  /** The shifts it's shown on. */
  bands: (m: Milestone) => BandDays;
}

const withSpan = (m: Milestone, s: number, f: number): Milestone =>
  ({ ...m, plannedStartAt: new Date(s).toISOString(), plannedAt: new Date(f).toISOString() } as Milestone);

/** Every row's as-built placement, worked out once. */
export function asBuilt(milestones: Milestone[], childrenByParent: Map<string, Milestone[]>, tz: string, times: ShiftTimes): AsBuilt {
  const spans = new Map<string, BuiltSpan>();
  const rows = new Map<string, Milestone>();
  const kidsOf = (id: string) => childrenByParent.get(id) ?? [];
  for (const m of milestones) {
    if (!m.id || kidsOf(m.id).length) continue;
    const b = builtSpan(m);
    spans.set(m.id, b);
    if (b.kind !== "planned" && Number.isFinite(b.start) && Number.isFinite(b.finish)) rows.set(m.id, withSpan(m, b.start, b.finish));
  }
  // A task: the envelope of its steps, when any of them moved.
  const leavesOf = (id: string): Milestone[] => {
    const out: Milestone[] = [], stack = [...kidsOf(id)], seen = new Set<string>();
    while (stack.length) {
      const c = stack.pop()!;
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      const k = kidsOf(c.id);
      if (k.length) stack.push(...k); else out.push(c);
    }
    return out;
  };
  for (const m of milestones) {
    if (!m.id || !kidsOf(m.id).length) continue;
    const leaves = leavesOf(m.id);
    if (!leaves.some((l) => l.id && rows.has(l.id))) continue;
    let s = Infinity, f = -Infinity;
    for (const l of leaves) {
      const b = l.id ? spans.get(l.id) : undefined;
      if (!b || !Number.isFinite(b.start) || !Number.isFinite(b.finish)) continue;
      s = Math.min(s, b.start); f = Math.max(f, b.finish);
    }
    if (Number.isFinite(s) && Number.isFinite(f)) {
      rows.set(m.id, withSpan(m, s, f));
      spans.set(m.id, { start: s, finish: f, kind: "started", ahead: s < startMsOf(m) });
    }
  }
  const bandMemo = new Map<string, BandDays>();
  const bands = (m: Milestone): BandDays => {
    const hit = m.id ? bandMemo.get(m.id) : undefined;
    if (hit) return hit;
    const b = m.id ? spans.get(m.id) : undefined;
    const r = m.id ? rows.get(m.id) : undefined;
    let out: BandDays;
    if (!b || !r || b.kind === "planned") out = stepBandDays(m, tz, times);
    else {
      // Done within one shift (or at a moment): that shift, whoever's crew —
      // it's when it happened. Longer: its crew's shifts across the span.
      const a = shiftAt(b.start, tz, times), z = shiftAt(Math.max(b.start, b.finish - 1), tz, times);
      out = b.kind === "done" && a.start === z.start
        ? { day: new Set(a.kind === "day" ? [a.dayKey] : []), night: new Set(a.kind === "night" ? [a.dayKey] : []) }
        : stepBandDays(r, tz, times);
    }
    if (m.id) bandMemo.set(m.id, out);
    return out;
  };
  return {
    row: (m) => (m.id ? rows.get(m.id) : undefined) ?? m,
    span: (m) => (m.id ? spans.get(m.id) : undefined),
    bands,
  };
}
