// cancelledJobs — jobs taken off this schedule that still get done
// somewhere else. They leave every view and progress number (with their
// steps), and the close-out report lists them with the note and where
// they went, so nothing is forgotten.

import type { Milestone } from "@/types/schema";
import { startOf } from "@/lib/scheduleTime";

export interface CancelledJob {
  /** The job that was cancelled (its steps went with it). */
  m: Milestone;
  /** Its parents, top first — "Transmix-1 › E-17". */
  crumbs: string[];
  /** Steps that came off with it (1 for a single step). */
  steps: number;
  /** When it came off. */
  at: number | null;
}

/** The schedule as it stands, and what was taken off it. A task whose
 *  every step was cancelled goes too — an empty heading isn't work. */
export function splitCancelled(all: Milestone[]): { active: Milestone[]; cancelled: CancelledJob[] } {
  if (!all.some((m) => m.cancelledAt)) return { active: all, cancelled: [] };
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, Milestone[]>();
  for (const m of all) if (m.id) byId.set(m.id, m);
  for (const m of all) if (m.parentId && byId.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m]);

  const offMemo = new Map<string, boolean>();
  // Cancelled itself or under a cancelled parent.
  const off = (m: Milestone, guard = 0): boolean => {
    if (!m.id) return !!m.cancelledAt;
    const hit = offMemo.get(m.id);
    if (hit != null) return hit;
    const p = m.parentId ? byId.get(m.parentId) : undefined;
    const v = !!m.cancelledAt || (!!p && guard < 50 && off(p, guard + 1));
    offMemo.set(m.id, v);
    return v;
  };
  const keepMemo = new Map<string, boolean>();
  const keep = (m: Milestone, guard = 0): boolean => {
    if (off(m)) return false;
    if (!m.id) return true;
    const hit = keepMemo.get(m.id);
    if (hit != null) return hit;
    const ch = kids.get(m.id) ?? [];
    const v = ch.length === 0 || guard > 50 || ch.some((c) => keep(c, guard + 1));
    keepMemo.set(m.id, v);
    return v;
  };
  // A step cancelled on its own (its own time, note and destination) is
  // listed on its own, not counted in a job cancelled later around it.
  const ownCancel = (c: Milestone, job: Milestone) => !!c.cancelledAt && c.cancelledAt !== job.cancelledAt;
  const leaves = (m: Milestone, job: Milestone, guard = 0): number => {
    const ch = (m.id ? kids.get(m.id) ?? [] : []).filter((c) => !ownCancel(c, job));
    if ((m.id ? kids.get(m.id) ?? [] : []).length === 0 || guard > 50) return 1;
    return ch.reduce((n, c) => n + leaves(c, job, guard + 1), 0);
  };
  // The nearest cancelled job above a row, if any.
  const cancelledAbove = (m: Milestone): Milestone | undefined => {
    const seen = new Set<string>();
    for (let p = m.parentId ? byId.get(m.parentId) : undefined; p && p.id && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      if (p.cancelledAt) return p;
    }
    return undefined;
  };
  const crumbsOf = (m: Milestone) => {
    const out: string[] = [];
    const seen = new Set<string>();
    let p = m.parentId ? byId.get(m.parentId) : undefined;
    while (p && p.id && !seen.has(p.id)) { seen.add(p.id); out.unshift(p.name); p = p.parentId ? byId.get(p.parentId) : undefined; }
    return out;
  };

  const active = all.filter((m) => keep(m));
  const cancelled = all
    .filter((m) => { if (!m.cancelledAt) return false; const above = cancelledAbove(m); return !above || ownCancel(m, above); })
    .map((m) => ({ m, crumbs: crumbsOf(m), steps: leaves(m, m), at: m.cancelledAt ? Date.parse(m.cancelledAt) : null }))
    .sort((a, b) => (startOf(a.m) - startOf(b.m)) || a.m.name.localeCompare(b.m.name));
  return { active, cancelled };
}
