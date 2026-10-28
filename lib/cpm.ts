// cpm — the critical path from the schedule's own links, recalculated as
// the work moves.
//
// A forward pass from where each step really is (done work fixed at its
// actual times, work under way finishing its remaining share from now,
// work not started no earlier than planned or than its links allow), then
// a backward pass from the forecast finish. A step's FLOAT is how long it
// can slip before the turnaround's finish moves:
//   critical       no float — it sets the finish
//   near critical  a shift or less — one bad shift and it's critical
// Links are finish-to-start, start-to-start, finish-to-finish or
// start-to-finish, with lag (lib/scheduleLinks). A link to a whole task is
// a link to each of its steps; a task's link applies to its steps. Pure.

import type { Milestone } from "@/types/schema";
import { linkOf, type LinkSpec } from "@/lib/scheduleLinks";
import { workSpan } from "@/lib/shiftReport";

export interface CpmStep {
  id: string;
  /** Forecast start / finish. */
  es: number; ef: number;
  /** The latest it can finish without moving the forecast finish. */
  lf: number;
  /** Hours it can slip before the finish moves (0 for done work). */
  floatH: number;
  done: boolean;
  critical: boolean;
  near: boolean;
  /** The steps whose links set its start (not started yet). */
  drivenBy: string[];
}

export interface Cpm {
  steps: Map<string, CpmStep>;
  /** The latest planned finish of any step. */
  plannedFinish: number;
  /** Where the work as it stands now lands the finish. */
  forecastFinish: number;
  /** Forecast less planned, hours (+ late, − early). */
  slipH: number;
  criticalIds: Set<string>;
  nearIds: Set<string>;
  /** Share of steps with a link in or out — the result is only as good as them. */
  linkedShare: number;
  at: number;
}

/** Within a shift of critical. */
export const NEAR_CRITICAL_H = 12;
const TOL = 15 * 60_000;
const H = 3_600_000;

const ms = (v: unknown): number => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));

export function computeCpm(milestones: Milestone[], o: { now: number; tz: string; nearH?: number }): Cpm {
  const { now, tz } = o;
  const nearMs = (o.nearH ?? NEAR_CRITICAL_H) * H;
  const byId = new Map<string, Milestone>();
  const kids = new Map<string, string[]>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  for (const m of milestones) if (m.id && m.parentId && byId.has(m.parentId)) kids.set(m.parentId, [...(kids.get(m.parentId) ?? []), m.id]);
  const leafIds = (id: string): string[] => {
    const out: string[] = [], stack = [id], seen = new Set<string>();
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const k = kids.get(c);
      if (k?.length) stack.push(...k); else out.push(c);
    }
    return out;
  };
  const leaves = milestones.filter((m) => m.id && !kids.get(m.id)?.length && m.plannedAt);
  const isLeaf = new Set(leaves.map((m) => m.id!));

  // Each step's predecessors with their links: its own and its tasks'.
  const preds = new Map<string, Array<{ id: string; link: LinkSpec }>>();
  const succs = new Map<string, Array<{ id: string; link: LinkSpec }>>();
  for (const m of leaves) {
    const list: Array<{ id: string; link: LinkSpec }> = [];
    const seen = new Set<string>();
    for (let t: Milestone | undefined = m, g = 0; t && g < 50; t = t.parentId ? byId.get(t.parentId) : undefined, g++) {
      for (const p of t.dependsOn ?? []) {
        const link = linkOf(t.linkTypes, p);
        for (const l of byId.has(p) ? leafIds(p) : []) {
          if (l === m.id || !isLeaf.has(l) || seen.has(l)) continue;
          seen.add(l);
          list.push({ id: l, link });
        }
      }
    }
    preds.set(m.id!, list);
    for (const p of list) succs.set(p.id, [...(succs.get(p.id) ?? []), { id: m.id!, link: p.link }]);
  }

  // Order: predecessors first (a loop in the links is left as it lies).
  const indeg = new Map(leaves.map((m) => [m.id!, preds.get(m.id!)!.length]));
  const order: string[] = [];
  const queue = leaves.filter((m) => indeg.get(m.id!) === 0).map((m) => m.id!);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of succs.get(id) ?? []) { const d = indeg.get(s.id)! - 1; indeg.set(s.id, d); if (d === 0) queue.push(s.id); }
  }
  const placed = new Set(order);
  for (const m of leaves) if (!placed.has(m.id!)) order.push(m.id!);

  const steps = new Map<string, CpmStep>();
  // How long each still needs from its start (for the backward pass).
  const need = new Map<string, number>();
  const started = new Set<string>();
  let plannedFinish = -Infinity;
  for (const id of order) {
    const m = byId.get(id)!;
    const sp = workSpan(m, tz);
    const ps = sp.start, pf = sp.finish;
    if (Number.isFinite(pf)) plannedFinish = Math.max(plannedFinish, pf);
    const dur = Number.isFinite(ps) && Number.isFinite(pf) ? Math.max(0, pf - ps) : 0;
    const pct = m.status === "completed" ? 100 : Math.max(0, Math.min(100, Number(m.percentComplete ?? 0)));
    const as = ms(m.actualStartAt), af = ms(m.actualAt);
    if (m.status === "completed") {
      const ef = Number.isFinite(af) ? af : pf;
      const es = Number.isFinite(as) ? Math.min(as, ef) : Math.min(ps, ef);
      steps.set(id, { id, es, ef, lf: ef, floatH: 0, done: true, critical: false, near: false, drivenBy: [] });
      need.set(id, 0);
      continue;
    }
    const isStarted = Number.isFinite(as) || (pct > 0 && m.status !== "planned");
    const rem = dur * (1 - pct / 100);
    let es: number, startReq = -Infinity, finishReq = -Infinity;
    const driven: Array<{ id: string; at: number }> = [];
    for (const p of preds.get(id) ?? []) {
      const P = steps.get(p.id);
      if (!P) continue;
      const lag = p.link.lagHours * H;
      if (p.link.type === "FS") { startReq = Math.max(startReq, P.ef + lag); driven.push({ id: p.id, at: P.ef + lag }); }
      else if (p.link.type === "SS") { startReq = Math.max(startReq, P.es + lag); driven.push({ id: p.id, at: P.es + lag }); }
      else if (p.link.type === "FF") finishReq = Math.max(finishReq, P.ef + lag);
      else finishReq = Math.max(finishReq, P.es + lag);
    }
    let ef: number;
    if (isStarted) {
      started.add(id);
      es = Number.isFinite(as) ? as : Number.isFinite(ps) ? Math.min(ps, now) : now;
      ef = Math.max(Math.max(now, es) + rem, finishReq);
      need.set(id, ef - Math.max(now, es));
    } else {
      es = Math.max(Number.isFinite(ps) ? ps : now, now, startReq);
      ef = Math.max(es + dur, finishReq);
      need.set(id, ef - es);
    }
    const drivenBy = !isStarted && startReq > Math.max(ps, now) ? driven.filter((d) => d.at === startReq).map((d) => d.id) : [];
    steps.set(id, { id, es, ef, lf: ef, floatH: 0, done: false, critical: false, near: false, drivenBy });
  }
  let forecastFinish = -Infinity;
  for (const s of steps.values()) forecastFinish = Math.max(forecastFinish, s.ef);
  if (!Number.isFinite(plannedFinish)) plannedFinish = forecastFinish;

  // Backward from the forecast finish.
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const S = steps.get(id)!;
    if (S.done) continue;
    let lf = forecastFinish;
    const myNeed = need.get(id) ?? 0;
    for (const s of succs.get(id) ?? []) {
      const T = steps.get(s.id);
      if (!T || T.done) continue;
      const lag = s.link.lagHours * H, tNeed = need.get(s.id) ?? 0;
      const tls = T.lf - tNeed;
      // A start-to-start (or -finish) link is met once this one has started.
      if (s.link.type === "FS") lf = Math.min(lf, tls - lag);
      else if (s.link.type === "FF") lf = Math.min(lf, T.lf - lag);
      else if (!started.has(id)) lf = Math.min(lf, (s.link.type === "SS" ? tls : T.lf) - lag + myNeed);
    }
    S.lf = lf;
    S.floatH = Math.max(0, Math.round(((lf - S.ef) / H) * 10) / 10);
    S.critical = lf - S.ef <= TOL;
    S.near = !S.critical && lf - S.ef <= nearMs;
  }
  const criticalIds = new Set<string>(), nearIds = new Set<string>();
  for (const s of steps.values()) { if (s.critical) criticalIds.add(s.id); if (s.near) nearIds.add(s.id); }
  const linked = leaves.filter((m) => (preds.get(m.id!)?.length ?? 0) > 0 || (succs.get(m.id!)?.length ?? 0) > 0).length;
  return {
    steps, plannedFinish, forecastFinish,
    slipH: Number.isFinite(forecastFinish) && Number.isFinite(plannedFinish) ? Math.round(((forecastFinish - plannedFinish) / H) * 10) / 10 : 0,
    criticalIds, nearIds,
    linkedShare: leaves.length ? linked / leaves.length : 0,
    at: now,
  };
}

/** Enough of the schedule is linked to calculate a path worth trusting. */
export const isLinked = (milestones: Milestone[]): boolean => {
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
  const leaves = milestones.filter((m) => m.id && !parents.has(m.id) && m.plannedAt);
  if (leaves.length < 2) return false;
  const withLinks = new Set<string>();
  for (const m of milestones) for (const p of m.dependsOn ?? []) { if (m.id) withLinks.add(m.id); withLinks.add(p); }
  return leaves.filter((m) => withLinks.has(m.id!)).length / leaves.length >= 0.5;
};
