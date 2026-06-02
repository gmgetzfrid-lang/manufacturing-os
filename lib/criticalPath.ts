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
