// lib/scheduleFilter.ts
//
// Search + filter for the schedule board. A real turnaround is 500+
// tasks; a field user must be able to type "blocked" or "WO-44821" or
// "Unit 12" and have the board narrow instantly.
//
// Pure + tested. The key subtlety: when a task matches, we keep its
// ANCESTORS too (so it stays in context under its phase) and optionally
// its DESCENDANTS (so matching a phase shows its work). This keeps the
// hierarchy intact instead of orphaning matches.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import { discoveryText, discoveryOf, kindOf, type AddedKind } from "@/lib/discovery";

export interface ScheduleFilter {
  /** Free text — matches name, WBS, work order, responsible, location,
   *  and any attribute value. Case-insensitive, space = AND. */
  query: string;
  /** Restrict to these statuses (empty = all). */
  statuses: MilestoneStatus[];
  /** Restrict to these top-level group ids (empty = all). */
  groupIds: string[];
  /** Only tasks not complete whose finish is before now. */
  overdueOnly: boolean;
  /** Only tasks with an unmet blocker (on_hold | blocked). */
  blockedOnly: boolean;
  /** Restrict to these shifts (empty = all). */
  shifts: Array<"day" | "night" | "swing">;
  /** Only work added after the plan: discovery, added scope (empty / none = all work). */
  added?: AddedKind[];
  /** Only steps on the critical path (opts.isCritical). */
  criticalOnly?: boolean;
  /** Only steps behind plan by now (opts.isBehind). */
  behindOnly?: boolean;
  /** Only steps nobody has started. */
  notStartedOnly?: boolean;
}

export const EMPTY_FILTER: ScheduleFilter = {
  query: "", statuses: [], groupIds: [], overdueOnly: false, blockedOnly: false, shifts: [], added: [],
  criticalOnly: false, behindOnly: false, notStartedOnly: false,
};

/** Not started: planned (or missed), no start recorded, nothing done. */
export const notStarted = (m: Milestone): boolean =>
  (m.status === "planned" || m.status === "missed") && !m.actualStartAt && !((m.percentComplete ?? 0) > 0);

export function isFilterActive(f: ScheduleFilter): boolean {
  return f.query.trim().length > 0 || f.statuses.length > 0 || f.groupIds.length > 0 || f.overdueOnly || f.blockedOnly || f.shifts.length > 0 || (f.added?.length ?? 0) > 0
    || !!f.criticalOnly || !!f.behindOnly || !!f.notStartedOnly;
}

/** Haystack for free-text search over one milestone. */
function haystack(m: Milestone): string {
  const parts: string[] = [m.name];
  if (m.wbs) parts.push(m.wbs);
  if (m.workOrderRef) parts.push(m.workOrderRef);
  if (m.responsibleParty) parts.push(m.responsibleParty);
  if (m.responsibleOrg) parts.push(m.responsibleOrg);
  if (m.actualParty) parts.push(m.actualParty);
  if (m.location) parts.push(m.location);
  if (m.description) parts.push(m.description);
  // Added work: what was found, not the record it's kept in.
  if (m.attributes) for (const [k, v] of Object.entries(m.attributes)) if (v != null && k !== "discovery") parts.push(String(v));
  const found = discoveryText(m);
  if (found) parts.push(found);
  return parts.join(" ").toLowerCase();
}

/**
 * Apply the filter, returning the SET of milestone ids to show. A task
 * is included if it matches directly; we then add all its ancestors
 * (keep it in context) and all its descendants (so a phase match shows
 * its work). Returns every id when the filter is inactive.
 */
export function filterMilestones(
  milestones: Milestone[],
  f: ScheduleFilter,
  opts?: {
    now?: number; topGroupOf?: (m: Milestone) => Milestone;
    /** Which crew works a task — the same reading the ☀/☾ marks use
     *  (lib/shiftReport workShiftOf), so filtering on Night shows the ☾ work. */
    shiftOf?: (m: Milestone) => "day" | "night" | "both";
    /** Past due and not done — the same rule as everywhere else
     *  (lib/shiftReport isOverdue). */
    isOverdue?: (m: Milestone, now: number) => boolean;
    /** On the critical path - the project's answer (lib/criticalPath). */
    isCritical?: (m: Milestone) => boolean;
    /** Behind plan by now - the same rule as the work orders' Behind. */
    isBehind?: (m: Milestone, now: number) => boolean;
  },
): Set<string> {
  const all = new Set<string>();
  for (const m of milestones) if (m.id) all.add(m.id);
  if (!isFilterActive(f)) return all;

  const now = opts?.now ?? Date.now();
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const childrenByParent = new Map<string, Milestone[]>();
  for (const m of milestones) {
    const pid = m.parentId && byId.has(m.parentId) ? m.parentId : null;
    if (!pid) continue;
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(m);
    childrenByParent.set(pid, arr);
  }

  const terms = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const statusSet = new Set(f.statuses);
  const groupSet = new Set(f.groupIds);

  const topGroupOf = opts?.topGroupOf ?? ((m: Milestone): Milestone => {
    let cur = m;
    const guard = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      cur = byId.get(cur.parentId)!;
    }
    return cur;
  });

  const directMatch = (m: Milestone): boolean => {
    if (terms.length > 0) {
      const hay = haystack(m);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (statusSet.size > 0 && !statusSet.has(m.status)) return false;
    if (f.overdueOnly) {
      if (opts?.isOverdue) { if (!opts.isOverdue(m, now)) return false; }
      else {
        if (m.status === "completed") return false;
        if (Date.parse(m.plannedAt as string) >= now) return false;
      }
    }
    if (f.blockedOnly && m.status !== "blocked" && m.status !== "on_hold") return false;
    // Critical, behind, not started: said of steps; a task shows for its steps.
    if (f.criticalOnly || f.behindOnly || f.notStartedOnly) {
      if (m.id && childrenByParent.has(m.id)) return false;
      if (f.criticalOnly && !opts?.isCritical?.(m)) return false;
      if (f.behindOnly && !opts?.isBehind?.(m, now)) return false;
      if (f.notStartedOnly && !notStarted(m)) return false;
    }
    if (f.added?.length) {
      const d = discoveryOf(m);
      if (!d || !f.added.includes(kindOf(d))) return false;
    }
    if (f.shifts.length > 0) {
      // "swing" in the filter = round the clock ("both").
      const w = opts?.shiftOf ? opts.shiftOf(m) : (m.shift === "swing" ? "both" : m.shift);
      if (!w || !f.shifts.some((x) => (x === "swing" ? "both" : x) === w)) return false;
    }
    if (groupSet.size > 0) {
      const g = topGroupOf(m);
      if (!g.id || !groupSet.has(g.id)) return false;
    }
    return true;
  };

  const show = new Set<string>();
  const addDescendants = (id: string) => {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const k of childrenByParent.get(cur) ?? []) {
        if (k.id && !show.has(k.id)) { show.add(k.id); stack.push(k.id); }
      }
    }
  };
  const addAncestors = (m: Milestone) => {
    let cur = m.parentId ? byId.get(m.parentId) : undefined;
    const guard = new Set<string>();
    while (cur && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      show.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  };

  // Pull in descendants only for a text query (browsing "show me this
  // phase's work"). For status/overdue/blocked/group filters we show
  // the matching rows + their ancestors for context, but NOT every
  // child of a matching summary — otherwise filtering "overdue" would
  // drag in a whole phase because the summary row is itself past due.
  const pullDescendants = terms.length > 0;
  for (const m of milestones) {
    if (!m.id || !directMatch(m)) continue;
    show.add(m.id);
    addAncestors(m);
    if (pullDescendants) addDescendants(m.id);
  }
  return show;
}
