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

export interface ProgressNode {
  id?: string;
  parentId?: string | null;
  status: MilestoneStatus;
  percentComplete?: number | null;
  weight?: number | null;
  durationHours?: number | null;
}

/** Clamp to an integer 0..100. */
export function clampPercent(p: number | null | undefined): number {
  if (p == null || !Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/** A leaf's own percent, reconciled with its status so a stale stored value can
 *  never contradict the workflow state: completed ⇒ 100, planned ⇒ 0, missed ⇒
 *  0 (a missed task did not happen, so it earns nothing — PT SAF-8: a task
 *  completed at 100% and later re-classified Missed used to keep its full
 *  earned value), otherwise the explicit percent (blocked / on_hold keep the
 *  progress genuinely logged). The stored percent is left alone, so un-missing
 *  a task gives its progress back; this rule holds for imported rows too. */
export function leafPercent(m: { status: MilestoneStatus; percentComplete?: number | null }): number {
  if (m.status === "completed") return 100;
  if (m.status === "planned" || m.status === "missed") return 0;
  return clampPercent(m.percentComplete);
}

/** Relative weight used to roll progress up. Prefer planned work hours (the
 *  truest measure of effort), else the explicit weight, else 1 — so a 40h task
 *  pulls the rollup more than a 2h one, the way a real schedule behaves.
 *  Per NODE, so a list mixing hours and unit weights mixes units — rollups use
 *  chooseWeightBasis + weightFor instead (PC SCHED-14). */
export function effectiveWeight(m: { weight?: number | null; durationHours?: number | null }): number {
  const d = m.durationHours;
  if (d != null && Number.isFinite(d) && d > 0) return d;
  const w = m.weight;
  if (w != null && Number.isFinite(w) && w > 0) return w;
  return 1;
}

/** What a list's rollups are weighted by. "hours" only when EVERY leaf carries
 *  planned work hours; otherwise "weight" (the explicit weight, else 1) for ALL
 *  of them — never hours for some and unit weights for others in the same
 *  denominator (PC SCHED-14: eight 40-hour tasks among 392 unit-weight rows
 *  used to hold 45% of the project). An empty list reads "weight". */
export type WeightBasis = "hours" | "weight";

const hasHours = (m: { durationHours?: number | null }) =>
  m.durationHours != null && Number.isFinite(m.durationHours) && m.durationHours > 0;

/** Choose the weighting basis ONCE for a list (leaves decided structurally:
 *  a row that is no row's parent). */
export function chooseWeightBasis(milestones: ProgressNode[]): WeightBasis {
  const byId = new Set<string>();
  for (const m of milestones) if (m.id) byId.add(m.id);
  const parents = new Set<string>();
  for (const m of milestones) if (m.parentId && byId.has(m.parentId)) parents.add(m.parentId);
  let leaves = 0;
  for (const m of milestones) {
    if (m.id && parents.has(m.id)) continue;
    leaves++;
    if (!hasHours(m)) return "weight";
  }
  return leaves > 0 ? "hours" : "weight";
}

/** A leaf's weight under the list's chosen basis. */
export function weightFor(m: { weight?: number | null; durationHours?: number | null }, basis: WeightBasis): number {
  if (basis === "hours" && hasHours(m)) return m.durationHours as number;
  const w = m.weight;
  if (w != null && Number.isFinite(w) && w > 0) return w;
  return 1;
}

/** How a basis reads on screen. */
export function weightBasisLabel(basis: WeightBasis): string {
  return basis === "hours" ? "weighted by planned work hours" : "weighted by task weight (not every task carries work hours)";
}

/** Derive a summary's status from the leaf-descendant tallies. Mirrors how a
 *  PM reads a phase: all done = done; anything blocked / missed / on-hold
 *  bubbles up so it can't hide (PC SCHED-7: an all-missed phase used to read
 *  "planned, 0%" — missed was the one exception state that never bubbled);
 *  any work started = in progress; otherwise still planned. Ranked blocked,
 *  then missed, then on hold. */
export function deriveSummaryStatus(t: {
  total: number; done: number; blocked: number; onHold: number; started: number; missed?: number;
}): MilestoneStatus {
  if (t.total === 0) return "planned";
  if (t.done === t.total) return "completed";
  if (t.blocked > 0) return "blocked";
  if ((t.missed ?? 0) > 0) return "missed";
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
  total: number; done: number; blocked: number; onHold: number; started: number; missed: number;
}

/**
 * Build a per-task progress index for an entire milestone list in one pass.
 * Every node (leaf or summary) maps to its effective percent + status. Summary
 * values are rollups of their leaf descendants, weighted on ONE basis chosen
 * for the whole list (chooseWeightBasis); leaves report their own
 * status-reconciled percent. Cycle-safe.
 */
export function buildProgressIndex(milestones: ProgressNode[]): Map<string, ProgressInfo> {
  const basis = chooseWeightBasis(milestones);
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
    if (guard.has(id)) return { wsum: 0, wpct: 0, total: 0, done: 0, blocked: 0, onHold: 0, started: 0, missed: 0 };
    guard.add(id);
    const node = byId.get(id)!;
    const children = kids.get(id) ?? [];
    let res: Agg;
    if (children.length === 0) {
      const w = weightFor(node, basis);
      const p = leafPercent(node);
      res = {
        wsum: w, wpct: w * p,
        total: 1,
        done: p >= 100 ? 1 : 0,
        blocked: node.status === "blocked" ? 1 : 0,
        onHold: node.status === "on_hold" ? 1 : 0,
        started: p > 0 ? 1 : 0,
        missed: node.status === "missed" ? 1 : 0,
      };
    } else {
      res = { wsum: 0, wpct: 0, total: 0, done: 0, blocked: 0, onHold: 0, started: 0, missed: 0 };
      for (const c of children) {
        if (!c.id) continue;
        const r = aggregate(c.id, guard);
        res.wsum += r.wsum; res.wpct += r.wpct; res.total += r.total;
        res.done += r.done; res.blocked += r.blocked; res.onHold += r.onHold; res.started += r.started;
        res.missed += r.missed;
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
        percent: a.wsum > 0 ? Math.round(a.wpct / a.wsum) : 0,
        status: deriveSummaryStatus(a),
        isLeaf: false,
        leafDone: a.done,
        leafTotal: a.total,
      });
    }
  }
  return out;
}

/** Headline completion % for a whole list: weighted (on the list's one basis,
 *  chooseWeightBasis) over LEAF tasks only (summaries are envelopes — counting
 *  them would double-count). */
export function overallPercent(milestones: ProgressNode[]): number {
  const parents = new Set<string>();
  const byId = new Map<string, ProgressNode>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) { const pid = m.parentId; if (pid && byId.has(pid)) parents.add(pid); }
  const basis = chooseWeightBasis(milestones);
  let wsum = 0, wpct = 0;
  for (const m of milestones) {
    if (!m.id || parents.has(m.id)) continue; // leaves only
    const w = weightFor(m, basis);
    wsum += w; wpct += w * leafPercent(m);
  }
  return wsum > 0 ? Math.round(wpct / wsum) : 0;
}
