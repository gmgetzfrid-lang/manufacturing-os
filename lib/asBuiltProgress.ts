// asBuiltProgress - how far a step was at any moment, as built: from the
// times recorded on it, not from when someone got round to typing them in.
//
//   - Before it started: 0.
//   - Each % entered along the way, at the time it was filed for.
//   - Done: 100 at the time it was done.
//   - In between two of those: spread evenly over the time between them
//     (a step started at 10 PM and done at 3 AM was 2 of its 5 hours in at
//     midnight). After the last thing recorded on an open step: as recorded,
//     never guessed forward.
//   - A % later corrected down: the lower one counts back to when it was
//     filed (it was never really further along than that).
//
// Its start: the start recorded on it; done with none recorded, its planned
// start when that came first (the as-built calendar's rule, lib/asBuilt);
// open with none recorded, the first time the log has it going.
//
// What can't be placed is said, not guessed: a step marked done with no
// time it was done, or with a % but no time at all, counts only from now.
//
// Pure.

import type { Milestone } from "@/types/schema";
import type { ProgressLogRow } from "@/lib/progressHistory";
import { builtSpan } from "@/lib/asBuilt";

const toMs = (v: unknown): number => (v == null || v === "" ? NaN : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)));
const clampPct = (p: number) => Math.max(0, Math.min(100, p));

export interface BuiltCurve {
  /** [time, %] in time order; % never falls. Empty: nothing to place in time. */
  points: Array<[number, number]>;
  /** Where it is now, when no time can be put to it (done with no finish
   *  time, a % with no start or log): counted from now only. */
  untimed: number;
}

const isDone = (m: Milestone) => m.status === "completed" || Number(m.percentComplete ?? 0) >= 100;

/** One step's progress over time. `log`: its own log rows. */
export function builtCurve(m: Milestone, log: ProgressLogRow[], now: number): BuiltCurve {
  const rows = [...log].sort((a, b) => toMs(a.at) - toMs(b.at));
  const done = isDone(m);
  const af = done ? toMs(m.actualAt) : NaN;
  const cur = done ? 100 : clampPct(Number(m.percentComplete ?? 0));

  let start: number;
  if (done) {
    if (!Number.isFinite(af)) return { points: [], untimed: 100 };
    start = builtSpan(m).start;
  } else {
    const as = toMs(m.actualStartAt);
    const firstGoing = rows.find((r) => r.new_status === "in_progress" || r.new_status === "completed" || Number(r.new_percent ?? 0) > 0);
    start = Number.isFinite(as) ? as : firstGoing ? toMs(firstGoing.at) : NaN;
    if (!Number.isFinite(start)) return cur > 0 ? { points: [], untimed: cur } : { points: [], untimed: 0 };
  }
  const end = done ? af : now;
  const pts: Array<[number, number]> = [[start, 0]];
  for (const r of rows) {
    const t = toMs(r.at), p = Number(r.new_percent ?? 0);
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    if (r.new_status === "completed" || p <= 0 || p >= 100) continue;
    pts.push([t, clampPct(p)]);
  }
  if (done) pts.push([af, 100]);
  else if (now > start) pts.push([now, cur]);
  // Never further along than anything recorded after it.
  for (let i = pts.length - 2; i >= 0; i--) pts[i][1] = Math.min(pts[i][1], pts[i + 1][1]);
  return { points: pts, untimed: 0 };
}

/** The % at time t (0 before it started; flat after the last point). */
export function pctAt(c: BuiltCurve, t: number): number {
  const p = c.points;
  if (!p.length || t <= p[0][0]) return 0;
  for (let i = 1; i < p.length; i++) {
    const [t1, v1] = p[i];
    if (t <= t1) {
      const [t0, v0] = p[i - 1];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return p[p.length - 1][1];
}

/** Every step's curve, the log read once. */
export function builtCurves(steps: Milestone[], log: ProgressLogRow[] | null, now: number): Map<string, BuiltCurve> {
  const byStep = new Map<string, ProgressLogRow[]>();
  for (const r of log ?? []) { const a = byStep.get(r.milestone_id); if (a) a.push(r); else byStep.set(r.milestone_id, [r]); }
  const out = new Map<string, BuiltCurve>();
  for (const m of steps) if (m.id) out.set(m.id, builtCurve(m, byStep.get(m.id) ?? [], now));
  return out;
}
