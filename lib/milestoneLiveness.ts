// lib/milestoneLiveness.ts — ONE rule for which milestone rows count.
//
// Before this module, the health snapshot and the printed report filtered
// milestones to `source == null || "manual" || "app"`. The column is NOT
// NULL with a CHECK over manual / p6 / msproject / csv / mpxj, so the
// `== null` clause never matched, the `"app"` branch was dead, and the
// filter collapsed to manual-only: a project scheduled entirely from a P6
// import scored "No schedule yet", was nagged to add one, and printed
// "No schedule loaded" — while the Schedule tab and the Costs tab read
// every row. The Schedule tab's stated position wins: imported ("ghost")
// rows ARE commitments. They are read-only in the UI, but they count for
// health, the coach, the report and the earned-value rollup exactly as
// typed rows do (projects-tab MON-6 / projects-and-cost PM-3).
//
// Overdue lives here too, so the snapshot and the report cannot disagree
// with each other (the convergence point for projects-tab SCH-5). Planned
// dates are stored wall-clock-as-UTC (`2026-08-21T00:00:00Z` means "due
// 21 Aug"), so a task is overdue only once the UTC day AFTER its planned
// day has begun — never from 00:01 on its own due date, and never earlier
// for a viewer west of Greenwich.

export interface MilestoneLivenessRow {
  source?: string | null;
}

export interface MilestoneOverdueRow {
  planned_at?: string | null;
  status?: string | null;
}

/** Imported (ghost) rows come from a scheduling tool and are read-only in
 *  the UI. They are still commitments — see isLiveMilestone. */
export function isImportedMilestone(m: MilestoneLivenessRow): boolean {
  return m.source != null && m.source !== "manual";
}

/** Does this stored row count toward schedule metrics (health, coach,
 *  report, EV rollup)? Every stored row does: manual and imported alike.
 *  The predicate exists so the answer is written once. */
export function isLiveMilestone(_m: MilestoneLivenessRow): boolean {
  return true;
}

export function liveMilestones<T extends MilestoneLivenessRow>(rows: T[]): T[] {
  return rows.filter(isLiveMilestone);
}

/** Start of the UTC day containing `ms`. */
export function startOfDayUTCms(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Overdue = not completed AND its planned day (UTC) is before today's
 *  (UTC) day. Due today is not overdue, in any timezone. */
export function isOverdueMilestone(m: MilestoneOverdueRow, nowMs: number = Date.now()): boolean {
  if (String(m.status ?? "planned") === "completed") return false;
  const planned = m.planned_at ? Date.parse(String(m.planned_at)) : NaN;
  if (!Number.isFinite(planned)) return false;
  return startOfDayUTCms(planned) < startOfDayUTCms(nowMs);
}

/**
 * How many milestone rows a project-level reader in this module's
 * consumers takes, ordered by `planned_at`: the health snapshot and the
 * printed report read the SAME first rows, which is also what the Costs
 * and Schedule tabs get from their unbounded `order("planned_at")` read
 * under the API's default 1,000-row response cap. So every surface
 * computes earned value, CPI and overdue over the same rows; the report
 * counts the total and says "first N of M" when a schedule is larger.
 */
export const PROJECT_MILESTONE_READ_LIMIT = 1000;
