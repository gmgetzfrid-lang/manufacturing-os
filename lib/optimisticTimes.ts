// optimisticTimes — what a status or % change will do to a step's actual
// start and finish, worked out the way the save does it (lib/milestones:
// setMilestoneStatus, setMilestoneProgress), so the screen can show the
// step where it belongs the moment it's saved instead of where it was
// planned (then jumping once the database answers). Pure.

import type { Milestone, MilestoneStatus } from "@/types/schema";

export interface ActualTimes { actualStartAt?: string | null; actualAt?: string | null }

const toMs = (v: unknown) => (v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
/** The time it happened, never after now. */
const past = (at: string | undefined, now: string) => { const t = at ? Date.parse(at) : NaN; return Number.isFinite(t) && t < Date.parse(now) ? new Date(t).toISOString() : now; };

/** A status change (setMilestoneStatus). */
export function timesAfterStatus(m: Milestone, next: MilestoneStatus, at: string | undefined, now: string): ActualTimes {
  const start = toMs(m.actualStartAt);
  if (next === "completed") {
    // Done again with no time: it keeps when it was done.
    if (m.status === "completed" && !at) return {};
    const done = past(at, now);
    return { actualAt: done, ...(!Number.isFinite(start) || start > Date.parse(done) ? { actualStartAt: done } : {}) };
  }
  if (next === "in_progress") return { actualAt: null, ...(!Number.isFinite(start) ? { actualStartAt: past(at, now) } : {}) };
  return { actualAt: null };
}

/** A % change (setMilestoneProgress): 100 is done, 0 not started. */
export function timesAfterProgress(m: Milestone, pct: number, at: string | undefined, now: string): ActualTimes {
  const start = toMs(m.actualStartAt);
  if (pct >= 100) {
    if (m.status === "completed" && !at) return {};
    const done = past(at, now);
    return { actualAt: done, ...(!Number.isFinite(start) || start > Date.parse(done) ? { actualStartAt: done } : {}) };
  }
  return { actualAt: null, ...(pct > 0 && !Number.isFinite(start) ? { actualStartAt: past(at, now) } : {}) };
}
