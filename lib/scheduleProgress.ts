// lib/scheduleProgress.ts
//
// Pure progress math for the schedule. Two jobs:
//   1. A leaf task's own percent (reconciled with its status).
//   2. A summary/parent's DERIVED percent + status, rolled up (duration-
//      weighted) from its leaf descendants — never stored, always computed,
//      exactly like MS Project / Primavera summary rows.
//
// This centralises logic that was copy-pasted (and drifting) across
// ExecutionView, the calendar tiles, the detail panel, and the EV metrics —
// and upgrades it from a binary "done / total" count to a real percentage.
//
// No I/O — unit-testable and reused by both the UI and lib/milestones.ts.

import type { MilestoneStatus } from "@/types/schema";
import { dayDiff, hasTimeOfDay } from "@/lib/scheduleTz";

export interface ProgressNode {
  id?: string;
  parentId?: string | null;
  status: MilestoneStatus;
  percentComplete?: number | null;
  weight?: number | null;
  durationHours?: number | null;
  plannedStartAt?: unknown;
  plannedAt?: unknown;
}

/** Clamp to an integer 0..100. Work short of 100% never rounds up to
 *  100 — 99.6% (a P6 import, a rollup) is not complete. */
export function clampPercent(p: number | null | undefined): number {
  if (p == null || !Number.isFinite(p)) return 0;
  return roundPct(Math.max(0, Math.min(100, p)));
}

/** Round a percentage for display without ever calling unfinished work done. */
export function roundPct(p: number): number {
  const r = Math.round(p);
  return r >= 100 && p < 100 ? 99 : r;
}

/** A leaf's own percent, reconciled with its status so a stale stored value can
 *  never contradict the workflow state: completed ⇒ 100, planned ⇒ 0, otherwise
 *  the explicit percent (blocked/on_hold/missed keep their logged progress). */
export function leafPercent(m: { status: MilestoneStatus; percentComplete?: number | null }): number {
  if (m.status === "completed") return 100;
  if (m.status === "planned") return 0;
  return clampPercent(m.percentComplete);
}

/** Relative weight used to roll progress up, in work-hours where it can
 *  be: planned work hours, else a weight someone set, else the length of
 *  its planned window — so a 40h task pulls the rollup more than a 2h one
 *  even in a schedule imported without hours (counting every step as one
 *  made a 1 h slip read as "50% behind"). */
export function effectiveWeight(m: {
  weight?: number | null; durationHours?: number | null;
  plannedStartAt?: unknown; plannedAt?: unknown;
}, tz?: string): number {
  const d = m.durationHours;
  if (d != null && Number.isFinite(d) && d > 0) return d;
  const w = m.weight;
  if (w != null && Number.isFinite(w) && w > 0 && w !== 1) return w;
  const h = spanHours(m.plannedStartAt, m.plannedAt, tz);
  if (h > 0) return h;
  return w != null && Number.isFinite(w) && w > 0 ? w : 1;
}

const msOf = (v: unknown): number =>
  v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));

/** Hours in a planned window. A date-only task (plant midnight at both
 *  ends) covers its days inclusively — Oct 26 → Oct 28 is three days of 24
 *  h, across a clock change too. A timed task is its clock span; a timed
 *  point (start = finish) has none, and falls back to its weight. Without
 *  the plant zone, a whole number of days at the same clock time is read
 *  as date-only. */
function spanHours(start: unknown, finish: unknown, tz?: string): number {
  const f = msOf(finish), s0 = msOf(start);
  if (!Number.isFinite(f)) return 0;
  const s = Number.isFinite(s0) ? s0 : f;
  const ms = f - s;
  if (ms < 0) return 0;
  const DAY = 86_400_000;
  if (tz) {
    if (!hasTimeOfDay(s, tz) && !hasTimeOfDay(f, tz)) return (dayDiff(s, f, tz) + 1) * 24;
    return ms / 3_600_000;
  }
  if (ms === 0) return 0;
  if (ms % DAY === 0) return (ms / DAY + 1) * 24;
  return ms / 3_600_000;
}

/** Derive a summary's status from the leaf-descendant tallies. Mirrors how a
 *  PM reads a phase: all done = done; anything blocked/on-hold bubbles up so it
 *  can't hide; any work started = in progress; otherwise still planned. */
export function deriveSummaryStatus(t: {
  total: number; done: number; blocked: number; onHold: number; started: number;
}): MilestoneStatus {
  if (t.total === 0) return "planned";
  if (t.done === t.total) return "completed";
  if (t.blocked > 0) return "blocked";
  if (t.onHold > 0) return "on_hold";
  if (t.started > 0) return "in_progress";
  return "planned";
}

export interface ProgressInfo {
  /** 0..100. Leaf = own (status-reconciled) percent; parent = weighted rollup. */
  percent: number;
  /** Leaf = own status; parent = derived from descendants. */
  status: MilestoneStatus;
  isLeaf: boolean;
  /** Completed / total leaf descendants — handy for "3 / 8" labels. */
  leafDone: number;
  leafTotal: number;
}

interface Agg {
  wsum: number; wpct: number;
  total: number; done: number; blocked: number; onHold: number; started: number;
}

/**
 * Build a per-task progress index for an entire milestone list in one pass.
 * Every node (leaf or summary) maps to its effective percent + status. Summary
 * values are duration-weighted rollups of their leaf descendants; leaves report
 * their own status-reconciled percent. Cycle-safe.
 */
export function buildProgressIndex(milestones: ProgressNode[], tz?: string): Map<string, ProgressInfo> {
  const byId = new Map<string, ProgressNode>();
  const kids = new Map<string, ProgressNode[]>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) {
    const pid = m.parentId && byId.has(m.parentId) ? m.parentId : null;
    if (!pid) continue;
    const arr = kids.get(pid) ?? []; arr.push(m); kids.set(pid, arr);
  }
  const hasChildren = (id: string) => (kids.get(id)?.length ?? 0) > 0;

  const memo = new Map<string, Agg>();
  const aggregate = (id: string, guard: Set<string>): Agg => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (guard.has(id)) return { wsum: 0, wpct: 0, total: 0, done: 0, blocked: 0, onHold: 0, started: 0 };
    guard.add(id);
    const node = byId.get(id)!;
    const children = kids.get(id) ?? [];
    let res: Agg;
    if (children.length === 0) {
      const w = effectiveWeight(node, tz);
      const p = leafPercent(node);
      res = {
        wsum: w, wpct: w * p,
        total: 1,
        done: p >= 100 ? 1 : 0,
        blocked: node.status === "blocked" ? 1 : 0,
        onHold: node.status === "on_hold" ? 1 : 0,
        started: p > 0 ? 1 : 0,
      };
    } else {
      res = { wsum: 0, wpct: 0, total: 0, done: 0, blocked: 0, onHold: 0, started: 0 };
      for (const c of children) {
        if (!c.id) continue;
        const r = aggregate(c.id, guard);
        res.wsum += r.wsum; res.wpct += r.wpct; res.total += r.total;
        res.done += r.done; res.blocked += r.blocked; res.onHold += r.onHold; res.started += r.started;
      }
    }
    memo.set(id, res);
    return res;
  };

  const out = new Map<string, ProgressInfo>();
  for (const m of milestones) {
    if (!m.id) continue;
    if (!hasChildren(m.id)) {
      const p = leafPercent(m);
      out.set(m.id, { percent: p, status: m.status, isLeaf: true, leafDone: p >= 100 ? 1 : 0, leafTotal: 1 });
    } else {
      const a = aggregate(m.id, new Set());
      out.set(m.id, {
        percent: a.wsum > 0 ? roundPct(a.wpct / a.wsum) : 0,
        status: deriveSummaryStatus(a),
        isLeaf: false,
        leafDone: a.done,
        leafTotal: a.total,
      });
    }
  }
  return out;
}

/** Headline completion % for a whole list: duration-weighted over LEAF tasks
 *  only (summaries are envelopes — counting them would double-count). */
export function overallPercent(milestones: ProgressNode[], tz?: string): number {
  const parents = new Set<string>();
  const byId = new Map<string, ProgressNode>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) { const pid = m.parentId; if (pid && byId.has(pid)) parents.add(pid); }
  let wsum = 0, wpct = 0;
  for (const m of milestones) {
    if (!m.id || parents.has(m.id)) continue; // leaves only
    const w = effectiveWeight(m, tz);
    wsum += w; wpct += w * leafPercent(m);
  }
  return wsum > 0 ? roundPct(wpct / wsum) : 0;
}
