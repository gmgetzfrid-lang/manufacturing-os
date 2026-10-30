// lib/criticalPath.ts
//
// Critical-path-LITE. A real CPM needs dependency links most field
// schedules don't carry. Instead we surface what's *actually* driving
// the finish date from the schedule's shape alone:
//
//   The "drivers" are the leaf tasks that END at (or near) the project
//   finish AND aren't yet complete — i.e. the work standing between you
//   and done. We then walk backward in time picking the chain of
//   overlapping/contiguous unfinished work that leads up to that finish,
//   so a supervisor sees "these are the tasks that, if they slip, slip
//   the whole job."
//
// This is intentionally a heuristic, labelled as such in the UI. It is
// pure + tested.

import type { Milestone } from "@/types/schema";
import { computeCpm, isLinked, type Cpm } from "@/lib/cpm";
import { DEFAULT_SCHEDULE_TZ } from "@/lib/scheduleTz";

export interface CriticalPathResult {
  /** Leaf milestone ids on the driving chain (what gates the finish). */
  ids: Set<string>;
  /** The project finish (ISO) the chain leads to. */
  finish: string | null;
  /** Total remaining work-hours on the chain, when hours are present. */
  remainingHours: number;
}

const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string));
const finishMs = (m: Milestone) => Date.parse(m.plannedAt as string);

/**
 * Identify the finish-driving chain. `slackDays` lets a task that ends
 * within N days of the latest finish still count as "driving" (real
 * schedules rarely line up to the minute).
 */
export function computeCriticalPathLite(
  milestones: Milestone[],
  opts?: { slackDays?: number },
): CriticalPathResult {
  const slack = (opts?.slackDays ?? 1) * 86400000;
  const byId = new Map<string, Milestone>();
  for (const m of milestones) if (m.id) byId.set(m.id, m);
  const isLeaf = (m: Milestone) => !milestones.some((c) => c.parentId === m.id);

  const leaves = milestones.filter((m) => m.plannedAt && isLeaf(m));
  if (leaves.length === 0) return { ids: new Set(), finish: null, remainingHours: 0 };

  // Project finish = latest leaf finish.
  const projFinish = Math.max(...leaves.map(finishMs));
  if (!Number.isFinite(projFinish)) return { ids: new Set(), finish: null, remainingHours: 0 };

  const incomplete = (m: Milestone) => m.status !== "completed";

  // Seed: unfinished leaves ending at/near the project finish.
  const chain = new Set<string>();
  let frontier = leaves.filter((m) => incomplete(m) && finishMs(m) >= projFinish - slack);
  for (const m of frontier) if (m.id) chain.add(m.id);

  // Walk backward: from each chain task's start, pull in the unfinished
  // leaf(s) that end just before it (contiguous predecessors by time),
  // forming the path that feeds the finish. Bounded iteration.
  let guard = 0;
  while (frontier.length > 0 && guard++ < 1000) {
    const earliestStart = Math.min(...frontier.map(startMs));
    const preds = leaves.filter((m) =>
      m.id && !chain.has(m.id) && incomplete(m) &&
      // A real predecessor STARTS before this seam and ENDS at/around it
      // — not a task running in parallel that merely starts together.
      startMs(m) < earliestStart &&
      finishMs(m) <= earliestStart + slack && finishMs(m) >= earliestStart - 14 * 86400000,
    );
    // Of the candidates, keep only the ones ending closest to the seam
    // (the true hand-off), not everything in the 2-week window.
    if (preds.length === 0) break;
    const latestPredFinish = Math.max(...preds.map(finishMs));
    const next = preds.filter((m) => finishMs(m) >= latestPredFinish - slack);
    for (const m of next) if (m.id) chain.add(m.id);
    frontier = next;
  }

  let remainingHours = 0;
  for (const id of chain) {
    const m = byId.get(id);
    if (m && typeof m.durationHours === "number") remainingHours += m.durationHours;
  }

  return { ids: chain, finish: new Date(projFinish).toISOString(), remainingHours };
}

// ─── Which steps are critical, under the project's control ───────────

/** Where the critical path comes from: calculated from the schedule's own
 *  links (lib/cpm — float, recalculated as work moves), the schedule file's
 *  flags (MS Project's Critical, as of the import), the app's estimate
 *  above, or nothing but what people mark by hand. */
export type CriticalMode = "links" | "file" | "estimate" | "none";
export type CriticalOverride = "yes" | "no";

export const CRITICAL_MODES: Array<{ value: CriticalMode; label: string; hint: string }> = [
  { value: "links", label: "Calculated from the links", hint: "The chain of linked work that sets the finish - recalculated as work moves, plus your changes" },
  { value: "file", label: "From the schedule file", hint: "What MS Project marked critical, plus your changes" },
  { value: "estimate", label: "App's estimate", hint: "The unfinished work ending nearest the finish date, plus your changes" },
  { value: "none", label: "Only what I mark", hint: "Nothing is critical unless you mark it" },
];

const fileFlag = (m: Milestone): string | undefined => {
  const v = (m.attributes as Record<string, unknown> | null | undefined)?.ms_critical;
  return v == null ? undefined : String(v);
};

/** The import carried the file's own critical flags. */
export function fileHasCritical(milestones: Milestone[]): boolean {
  return milestones.some((m) => fileFlag(m) !== undefined);
}

/** The mode in force: the project's choice, else calculated when the
 *  schedule is linked, else the file's flags when the import carried
 *  them, else the estimate. */
export function effectiveCriticalMode(milestones: Milestone[], mode: CriticalMode | null | undefined): CriticalMode {
  if (mode) return mode;
  return isLinked(milestones) ? "links" : fileHasCritical(milestones) ? "file" : "estimate";
}

/** A task's own mark, else the nearest one above it — marking E-17 marks
 *  every step under it, unless a step says otherwise. */
export function criticalOverrideOf(m: Milestone, byId: Map<string, Milestone>): CriticalOverride | null {
  const seen = new Set<string>();
  for (let t: Milestone | undefined = m; t && !seen.has(t.id ?? ""); t = t.parentId ? byId.get(t.parentId) : undefined) {
    if (t.id) seen.add(t.id);
    if (t.criticalOverride === "yes" || t.criticalOverride === "no") return t.criticalOverride;
  }
  return null;
}

/** The unfinished steps on the critical path, as the project has it: the
 *  mode's set, then every Yes / No mark applied on top. THE one answer —
 *  every screen and printout reads it from here. When the schedule is
 *  linked, `cpm` carries each step's float (whatever the mode), and
 *  `linksCount` how many the calculation alone finds. */
export function resolveCriticalPath(milestones: Milestone[], mode: CriticalMode | null | undefined, o: { now?: number; tz?: string } = {}): CriticalPathResult & { mode: CriticalMode; marked: number; cpm: Cpm | null; near: Set<string>; off: Set<string> } {
  const eff = effectiveCriticalMode(milestones, mode);
  const byId = new Map<string, Milestone>();
  const parents = new Set<string>();
  for (const m of milestones) { if (m.id) byId.set(m.id, m); if (m.parentId) parents.add(m.parentId); }
  const leaves = milestones.filter((m) => m.id && !parents.has(m.id));
  const cpm = isLinked(milestones) ? computeCpm(milestones, { now: o.now ?? Date.now(), tz: o.tz ?? DEFAULT_SCHEDULE_TZ }) : null;
  const base = eff === "links" ? new Set(cpm?.criticalIds ?? [])
    : eff === "estimate" ? computeCriticalPathLite(milestones).ids
    : eff === "file" ? new Set(leaves.filter((m) => fileFlag(m) === "1" || fileFlag(m) === "true").map((m) => m.id!))
      : new Set<string>();
  const ids = new Set<string>();
  // Marked Not critical by hand (or under a task that is): off the path,
  // and nothing said about its float either.
  const off = new Set<string>();
  let marked = 0;
  for (const m of leaves) {
    const o = criticalOverrideOf(m, byId);
    if (o) marked++;
    if (o === "no") off.add(m.id!);
    const on = o === "yes" ? true : o === "no" ? false : base.has(m.id!);
    if (on && m.status !== "completed") ids.add(m.id!);
  }
  let remainingHours = 0, finish = -Infinity;
  for (const id of ids) {
    const m = byId.get(id)!;
    if (typeof m.durationHours === "number") remainingHours += m.durationHours;
    const f = finishMs(m);
    if (Number.isFinite(f) && f > finish) finish = f;
  }
  // Near critical: within a shift of it by the links — not on the path,
  // and not marked off it by hand.
  const near = new Set<string>();
  for (const id of cpm?.nearIds ?? []) {
    const m = byId.get(id);
    if (m && !ids.has(id) && !off.has(id)) near.add(id);
  }
  return { ids, finish: Number.isFinite(finish) ? new Date(finish).toISOString() : null, remainingHours, mode: eff, marked, cpm, near, off };
}

/** Each unfinished step's float, hours (lib/cpm), for the report rows —
 *  but none for steps marked Not critical (`off`): no "near critical" or
 *  "trending to critical" on work taken off the path by hand. */
export function floatsOf(cpm: Cpm | null | undefined, off?: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of cpm?.steps.values() ?? []) if (!s.done && !off?.has(s.id)) out.set(s.id, s.floatH);
  return out;
}

/** What a screen needs to mark a step against the critical path — the
 *  calendar, its quick view and the day list take it from the one answer. */
export interface PathMarks { ids: Set<string>; near: Set<string>; floatH: Map<string, number> }
export function pathMarks(r: { ids: Set<string>; near: Set<string>; cpm: Cpm | null; off?: Set<string> }): PathMarks {
  return { ids: r.ids, near: r.near, floatH: floatsOf(r.cpm, r.off) };
}
