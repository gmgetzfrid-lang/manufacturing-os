// A step's comment goes with the change it was typed with, or a later one.
// One said with an earlier update ("53 of 57 downcomers" at 73%) isn't
// shown beside a later change it doesn't describe (the step's Done).

/** Typed with the change it went in with: within a couple of minutes. */
export const COMMENT_SLACK_MS = 2 * 60_000;

/** Whether a comment said at `commentAt` still goes with the step, whose
 *  last change (status or %) was at `lastChangeAt`. */
export function saidWithLatest(commentAt: number, lastChangeAt: number | null | undefined): boolean {
  return !(lastChangeAt != null && Number.isFinite(lastChangeAt) && Number.isFinite(commentAt) && commentAt < lastChangeAt - COMMENT_SLACK_MS);
}

/** When each step last changed, from the progress log (the time it
 *  happened), up to `until`. The line from when a step was made isn't a change. */
export function lastChanges(log: Array<{ milestone_id: string; at: string; old_status: string | null }>, until = Infinity): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of log) {
    const t = Date.parse(r.at);
    if (r.old_status == null || !(t <= until)) continue;
    if (!(t <= (out.get(r.milestone_id) ?? -Infinity))) out.set(r.milestone_id, t);
  }
  return out;
}
