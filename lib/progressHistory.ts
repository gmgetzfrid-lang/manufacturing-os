// lib/progressHistory.ts — the schedule as it stood at a moment.
//
// Each task keeps only its current % and status; the progress log
// (migration 20261028) keeps every change, before and after. From the two,
// a past shift's report shows the job as it stood at the end of that shift
// instead of today's progress. Pure apart from the loader.

import type { Milestone, MilestoneStatus } from "@/types/schema";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";

export interface ProgressLogRow {
  /** The line's id — to correct its time. */
  id?: number;
  milestone_id: string;
  at: string;
  old_status: MilestoneStatus | null;
  old_percent: number | null;
  new_status: MilestoneStatus;
  new_percent: number | null;
  /** When it was really typed in, when it was filed at the time the work
   *  was done (20261105). */
  entered_at?: string | null;
}

/** Every logged change on a project, oldest first. Null when the log isn't
 *  there (migration not run) — the caller then says progress is current. */
export async function loadProgressLog(projectId: string): Promise<ProgressLogRow[] | null> {
  const read = (cols: string) => fetchAllRows<ProgressLogRow>((from, to) => supabase
    .from("milestone_progress_log")
    .select(cols)
    .eq("project_id", projectId)
    .order("at", { ascending: true }).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>);
  let { rows, error } = await read("id, milestone_id, at, old_status, old_percent, new_status, new_percent, entered_at");
  // Before the database update there's no entered_at: the log as it was.
  if (error && /entered_at/.test(error)) ({ rows, error } = await read("id, milestone_id, at, old_status, old_percent, new_status, new_percent"));
  if (error) return null;
  return rows;
}

const ms = (v: unknown): number =>
  v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));

/** Each task's status and % as they stood at `at`.
 *  - The last logged change at or before `at` gives its state then.
 *  - Failing that, the first change after `at` gives the state it changed
 *    FROM (a task created after `at` didn't exist yet: planned, 0%).
 *  - A task never logged hasn't changed since the log began: as it is now.
 *  - A completion back-dated to before `at` counts as done then, even if it
 *    was entered later — that's what back-dating is for.
 *  `complete` is false when `at` is before the log began, so some changes
 *  before it can't be known. */
export function scheduleAt(milestones: Milestone[], log: ProgressLogRow[], at: number): { milestones: Milestone[]; complete: boolean } {
  const byTask = new Map<string, ProgressLogRow[]>();
  for (const r of log) byTask.set(r.milestone_id, [...(byTask.get(r.milestone_id) ?? []), r]);
  const firstLogged = log.length ? ms(log[0].at) : NaN;
  const out = milestones.map((m) => {
    if (!m.id) return m;
    const rows = byTask.get(m.id) ?? [];
    let status: MilestoneStatus = m.status;
    let pct: number = m.percentComplete ?? 0;
    let before: ProgressLogRow | undefined, after: ProgressLogRow | undefined;
    for (const r of rows) {
      if (ms(r.at) <= at) before = r;
      else { after = r; break; }
    }
    if (before) { status = before.new_status; pct = Number(before.new_percent ?? 0); }
    else if (after) { status = after.old_status ?? "planned"; pct = Number(after.old_percent ?? 0); }
    const done = ms(m.actualAt);
    if (m.status === "completed" && Number.isFinite(done) && done <= at) { status = "completed"; pct = 100; }
    if (status === m.status && pct === (m.percentComplete ?? 0)) return m;
    return {
      ...m, status, percentComplete: pct,
      // Not finished then: no completion stamp then either.
      ...(status !== "completed" ? { actualAt: undefined } : {}),
    } as Milestone;
  });
  return { milestones: out, complete: Number.isFinite(firstLogged) && firstLogged <= at };
}
