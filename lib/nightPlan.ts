// nightPlan - the next shift's work, picked by hand. The schedule's own
// list for a shift often isn't what the field will do (work is swapped,
// pulled in, put off), so the supervisor ticks the steps the shift is given.
// Saved on that shift's record (ShiftRecord.plan), it becomes the list on
// the turnover, the meeting, the email and the shift sheet; the schedule's
// dates don't move. The morning after, the report reads the shift against
// it: done, moved, not started, and what it did that wasn't on it.

import type { ShiftPlan, ShiftReport, ShiftRow, LookAheadItem } from "@/lib/shiftReport";

export interface PlanChoiceGroup {
  id: "late" | "scheduled" | "other" | "early";
  title: string;
  rows: ShiftRow[];
}

const held = (r: ShiftRow) => r.status === "blocked" || r.status === "on_hold";

/** What to pick from, read off the report as the schedule has it (no plan):
 *  late work, the shift's own scheduled work, work set to the other crew
 *  that's under way or due, and work ready to start early. Each step once;
 *  blocked and on-hold steps left out. */
export function planChoices(base: ShiftReport): PlanChoiceGroup[] {
  const { goals, next } = base;
  const other = next.kind === "day" ? "night" : "day";
  const seen = new Set<string>();
  const take = (rs: ShiftRow[]) => rs.filter((r) => {
    const id = r.leaf.id;
    if (!id || seen.has(id) || held(r)) return false;
    seen.add(id);
    return true;
  });
  const groups: PlanChoiceGroup[] = [
    { id: "late", title: "Late - still to finish", rows: take([...goals.all.filter((r) => r.carryOver), ...goals.otherShift]) },
    { id: "scheduled", title: `On the schedule for the ${next.kind} shift`, rows: take(goals.all.filter((r) => !r.carryOver)) },
    { id: "other", title: `Set to the ${other} crew - under way or due then`, rows: take([...goals.movedOff, ...goals.paused]) },
    { id: "early", title: "Ready to start early", rows: take(goals.stretch) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** Every open step a search can find: the choices, then the rest of the
 *  job (look-ahead), then blocked ones (shown, not pickable). */
export function planSearchPool(base: ShiftReport, groups: PlanChoiceGroup[]): Array<{ row: ShiftRow; held: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ row: ShiftRow; held: boolean }> = [];
  const add = (r: ShiftRow) => {
    const id = r.leaf.id;
    if (!id || seen.has(id) || r.status === "completed" || r.percent >= 100) return;
    seen.add(id);
    out.push({ row: r, held: held(r) });
  };
  for (const g of groups) g.rows.forEach(add);
  base.goals.lookAhead.forEach((x: LookAheadItem) => add(x.row));
  base.blocked.forEach(add);
  return out;
}

/** Search text for a step: its name, the tasks above it, WO (its own, or
 *  its work order's), crew. */
export function planSearchText(r: ShiftRow, wo?: string | null): string {
  return [r.leaf.name, ...r.path, r.leaf.workOrderRef ?? "", wo ?? "", r.leaf.responsibleParty ?? ""].join(" ").toLowerCase();
}

/** Every word must match: "v-01 tower", "304528". */
export function searchPlanPool<T extends { row: ShiftRow }>(pool: T[], query: string, woOf?: (id: string) => string | null | undefined): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return pool.filter((x) => { const t = planSearchText(x.row, x.row.leaf.id ? woOf?.(x.row.leaf.id) : null); return words.every((w) => t.includes(w)); });
}

/** A % typed for "by the end of the shift": a whole number 0 to 100, or
 *  nothing (blank: the plan's own goal). */
export function expectOf(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t.replace(/%$/, ""));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : undefined;
}

/** The plan as saved: the ids in the order picked, and each typed % (only
 *  for steps on it). */
export function planToSave(ids: string[], expect: Record<string, string>, by: string | null, at: number): ShiftPlan {
  const keep: Record<string, number> = {};
  for (const id of ids) { const n = expectOf(expect[id] ?? ""); if (n != null) keep[id] = n; }
  return { ids: [...new Set(ids)], ...(Object.keys(keep).length ? { expect: keep } : {}), setAt: at, by };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const names = (rows: ShiftRow[], max = 3) => rows.slice(0, max).map((r) => r.leaf.name).join(", ") + (rows.length > max ? ` + ${rows.length - max} more` : "");

/** "Plan set by Gary, Tue Nov 3 4:10 PM." */
export function planSetText(plan: ShiftPlan | undefined, f: { D: (ms: number) => string; T: (ms: number) => string }): string | null {
  if (!plan) return null;
  const who = plan.by?.trim();
  const when = plan.setAt ? `${f.D(plan.setAt)} ${f.T(plan.setAt)}` : "";
  return `Plan set${who ? ` by ${who}` : ""}${when ? `, ${when}` : ""}.`;
}

/** With a plan: what the schedule had for the shift that isn't on it - put
 *  off on purpose, not the shift's to do. */
export function offPlanText(report: ShiftReport): string | null {
  const off = report.goals.byPlan ? report.goals.offPlan : [];
  if (!off.length) return null;
  return `Not on the plan, put off: ${plural(off.length, "step")} the schedule had for the ${report.next.kind} shift (${names(off)}).`;
}

/** The shift under review against the plan it was given:
 *  "Night plan: 8 steps. 5 done, 2 moved forward, 1 not started (Blind V-01). Also worked 2 not on it." */
export function planCheckText(report: ShiftReport): string | null {
  const p = report.review.plan;
  if (!p) return null;
  const kind = report.shift.kind === "day" ? "Day" : "Night";
  if (p.planned === 0) return `${kind} plan: no steps on it.${p.extra.length ? ` Worked ${plural(p.extra.length, "step")}.` : ""}`;
  const parts = [
    `${p.done.length} done`,
    p.moved.length ? `${p.moved.length} moved forward` : null,
    p.untouched.length ? `${p.untouched.length} not started (${names(p.untouched)})` : null,
  ].filter(Boolean).join(", ");
  return `${kind} plan: ${plural(p.planned, "step")}. ${parts}.${p.extra.length ? ` Also worked ${p.extra.length} not on it (${names(p.extra)}).` : ""}`;
}
