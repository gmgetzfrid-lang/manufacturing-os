// lib/cpm.ts
//
// Real Critical Path Method — the forward/backward pass that MS Project and
// Primavera P6 run. Given the leaf activities, their durations, and the typed
// dependency links between them (FS / SS / FF / SF + lag), it computes for
// every activity:
//
//   ES / EF  earliest start / finish   (forward pass)
//   LS / LF  latest start / finish     (backward pass)
//   total float = LS − ES              (how long it can slip without moving
//                                        the project finish)
//   critical = total float ≤ 0         (the chain that drives the end date)
//
// All math is in whole UTC day-indices relative to the project start, matching
// the rest of the schedule engine (a task finishing "on" a day occupies it, so
// an FS successor starts the NEXT day at lag 0). Summary/parent rows are
// rollups, not activities — CPM runs over the leaves. Links whose predecessor
// isn't itself a leaf in the set are skipped (a documented limitation; real
// links are leaf-to-leaf).
//
// Pure + cycle-safe (a dependency cycle degrades gracefully instead of
// hanging). The UI uses `hasLinks` to decide between this exact CPM and the
// time-based critical-path heuristic for schedules that carry no links.

import { normalizeLinks, type DependencyLink, type LinkType } from "@/lib/scheduleLinks";

export interface CpmNode {
  id: string;
  parentId?: string | null;
  plannedStartAt?: string | null;
  plannedAt: string;
  status?: string;
  dependsOn?: readonly string[] | null;
  dependencyLinks?: readonly DependencyLink[] | null;
}

export interface CpmActivity {
  id: string;
  /** Day indices relative to the project start (day 0). */
  es: number; ef: number; ls: number; lf: number;
  durationDays: number;
  /** Slack before the project finish moves. ≤ 0 ⇒ critical. */
  totalFloatDays: number;
  critical: boolean;
}

export interface CpmResult {
  projectStart: string | null;   // ISO (UTC midnight) of day 0
  projectFinish: string | null;  // ISO of the earliest project finish (forward pass)
  activities: Map<string, CpmActivity>;
  criticalIds: Set<string>;
  /** True when at least one real dependency link drove the network. When
   *  false, CPM has nothing to constrain on and the caller should fall back
   *  to the time-based heuristic. */
  hasLinks: boolean;
}

const DAY_MS = 86_400_000;
function dayIndex(iso: string, originMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
  return Math.round((d.getTime() - originMs) / DAY_MS);
}

/** Required earliest START day-index of a successor for one link, given the
 *  predecessor's ES/EF and the successor's own duration. */
function fwdRequiredStart(type: LinkType, lag: number, predES: number, predEF: number, succDur: number): number {
  switch (type) {
    case "SS": return predES + lag;
    case "FF": return predEF + lag - (succDur - 1);
    case "SF": return predES + lag - (succDur - 1);
    case "FS":
    default:   return predEF + 1 + lag;
  }
}

/** Latest FINISH day-index a predecessor may take for one link, given the
 *  successor's LS/LF and the predecessor's own duration. */
function bwdLatestFinish(type: LinkType, lag: number, succLS: number, succLF: number, predDur: number): number {
  switch (type) {
    case "SS": return (succLS - lag) + (predDur - 1);
    case "FF": return succLF - lag;
    case "SF": return (succLF - lag) + (predDur - 1);
    case "FS":
    default:   return succLS - 1 - lag;
  }
}

export function computeCpm(nodes: readonly CpmNode[]): CpmResult {
  const empty: CpmResult = { projectStart: null, projectFinish: null, activities: new Map(), criticalIds: new Set(), hasLinks: false };

  const hasChild = new Set<string>();
  for (const n of nodes) {
    const pid = n.parentId ?? null;
    if (pid) hasChild.add(pid);
  }
  const leaves = nodes.filter((n) => n.id && !hasChild.has(n.id) && n.plannedAt);
  if (leaves.length === 0) return empty;
  const leafIds = new Set(leaves.map((l) => l.id));

  // Project origin = earliest leaf start.
  let originMs = Infinity;
  for (const l of leaves) {
    const s = (l.plannedStartAt as string | undefined) ?? l.plannedAt;
    const t = Date.parse(s);
    if (Number.isFinite(t)) { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); originMs = Math.min(originMs, d.getTime()); }
  }
  if (!Number.isFinite(originMs)) return empty;

  // Per-leaf planned window + duration, and its (leaf-only) links.
  const startIdx = new Map<string, number>();
  const durDays = new Map<string, number>();
  const linksOf = new Map<string, DependencyLink[]>();
  const succOf = new Map<string, string[]>(); // predId -> succIds
  let hasLinks = false;
  for (const l of leaves) {
    const sIso = (l.plannedStartAt as string | undefined) ?? l.plannedAt;
    const si = dayIndex(sIso, originMs);
    const fi = Math.max(si, dayIndex(l.plannedAt, originMs));
    startIdx.set(l.id, si);
    durDays.set(l.id, fi - si + 1);
    const links = normalizeLinks(l.dependsOn, l.dependencyLinks, l.id).filter((k) => leafIds.has(k.predId));
    linksOf.set(l.id, links);
    if (links.length > 0) hasLinks = true;
    for (const k of links) {
      const arr = succOf.get(k.predId) ?? [];
      if (!arr.includes(l.id)) arr.push(l.id);
      succOf.set(k.predId, arr);
    }
  }

  // Topological order (Kahn) over the leaf dependency DAG. Cycle survivors
  // are appended in planned-start order so the pass still completes.
  const indeg = new Map<string, number>();
  for (const l of leaves) indeg.set(l.id, (linksOf.get(l.id) ?? []).length);
  const queue: string[] = [];
  for (const l of leaves) if ((indeg.get(l.id) ?? 0) === 0) queue.push(l.id);
  queue.sort((a, b) => (startIdx.get(a)! - startIdx.get(b)!));
  const order: string[] = [];
  const ordered = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (ordered.has(id)) continue;
    ordered.add(id); order.push(id);
    for (const s of succOf.get(id) ?? []) {
      indeg.set(s, (indeg.get(s) ?? 1) - 1);
      if ((indeg.get(s) ?? 0) <= 0 && !ordered.has(s)) queue.push(s);
    }
  }
  for (const l of leaves) if (!ordered.has(l.id)) order.push(l.id); // cycle survivors

  // Forward pass — ES/EF. The planned start acts as a floor so unlinked tasks
  // keep the position the planner gave them.
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const d = durDays.get(id)!;
    let e = startIdx.get(id)!;
    for (const k of linksOf.get(id) ?? []) {
      if (!es.has(k.predId)) continue; // unresolved (cycle) — skip
      e = Math.max(e, fwdRequiredStart(k.type, k.lagDays, es.get(k.predId)!, ef.get(k.predId)!, d));
    }
    es.set(id, e);
    ef.set(id, e + d - 1);
  }

  let projFinishIdx = -Infinity;
  for (const id of order) projFinishIdx = Math.max(projFinishIdx, ef.get(id)!);
  if (!Number.isFinite(projFinishIdx)) return empty;

  // Backward pass — LS/LF over the reverse order.
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const d = durDays.get(id)!;
    let lateFinish = projFinishIdx;
    for (const s of succOf.get(id) ?? []) {
      if (!ls.has(s)) continue;
      // The relevant link is the one on the successor that points back to id.
      for (const k of linksOf.get(s) ?? []) {
        if (k.predId !== id) continue;
        lateFinish = Math.min(lateFinish, bwdLatestFinish(k.type, k.lagDays, ls.get(s)!, lf.get(s)!, d));
      }
    }
    lf.set(id, lateFinish);
    ls.set(id, lateFinish - d + 1);
  }

  const activities = new Map<string, CpmActivity>();
  const criticalIds = new Set<string>();
  for (const id of order) {
    const a: CpmActivity = {
      id,
      es: es.get(id)!, ef: ef.get(id)!, ls: ls.get(id)!, lf: lf.get(id)!,
      durationDays: durDays.get(id)!,
      totalFloatDays: ls.get(id)! - es.get(id)!,
      critical: ls.get(id)! - es.get(id)! <= 0,
    };
    activities.set(id, a);
    if (a.critical) criticalIds.add(id);
  }

  return {
    projectStart: new Date(originMs).toISOString(),
    projectFinish: new Date(originMs + projFinishIdx * DAY_MS).toISOString(),
    activities,
    criticalIds,
    hasLinks,
  };
}
