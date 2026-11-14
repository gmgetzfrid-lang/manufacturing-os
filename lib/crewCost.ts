// crewCost - a contractor shift by shift: the heads its staffing plan said,
// the heads counted at the shift meeting, what those heads cost at its rate
// sheet (straight time, overtime, double time, per diem), the overtime of
// a crew held over, and where its cost is heading.
//
//   - Counted heads are priced at the plan's craft mix for that shift; with
//     no plan for the shift, at the sheet's crafts, one each. It is an
//     estimate until the invoices are posted, and says so.
//   - A shift that has started with no count is "not counted": priced at
//     the plan in the forecast, never passed off as counted.
//   - A count carried from an earlier shift is kept apart from a checked one.
//
// Pure.

import type { StaffingPlan } from "@/lib/staffingPlan";
import { headCost, holdCost, mixCost, paidHoursOf, type RateSheet } from "@/lib/rateSheet";
import type { ShiftCount } from "@/lib/manpower";
import type { HoldOver } from "@/lib/holdOver";

export interface CrewShiftRow {
  key: string; kind: "day" | "night"; start: number; end: number;
  /** The plan's heads (null: the plan has nothing for the shift). */
  plan: { heads: number; direct: number; indirect: number } | null;
  /** Counted at the meeting (null: not counted). */
  counted: number | null;
  carried: boolean;
  started: boolean;
  /** Hands held past the shift and for how long, and what it cost. */
  hold: { hands: number; hours: number; open: boolean; cost: number | null } | null;
  /** What the plan's heads cost; what the counted heads cost (estimate), overtime in. Null: no rates. */
  planCost: number | null;
  paid: number | null;
}

export interface CrewSummary {
  shifts: number;
  /** Shifts with a count, and the plan's and counted heads on them. */
  counted: number; plannedOnCounted: number; countedHeads: number;
  short: number; over: number;
  /** Started shifts the plan has heads for, with no count yet. */
  uncounted: number;
  /** Est. cost of the counted shifts (overtime in), the plan's cost of those same shifts, and the overtime alone. */
  paidToDate: number | null; planOnCounted: number | null; overtime: number | null;
  /** The plan's cost over every shift in view. */
  planTotal: number | null;
  /** Paid to date, and the plan's cost for every shift not counted. */
  forecast: number | null;
  /** Crafts on the plan with no rate (left out of every cost). */
  unpriced: string[];
}

export interface CrewCostInput {
  company: string;
  plan: StaffingPlan | null;
  sheet: RateSheet | null;
  /** The shifts in view, in order: from shiftCounts (lib/manpower). */
  counts: ShiftCount[];
  /** Each shift's hold-overs, by shift key. */
  holds: Map<string, HoldOver[]>;
  /** The company a crew belongs to. */
  companyOf: (crew: string) => string;
  now: number;
}

const mixOf = (plan: StaffingPlan | null, key: string): Record<string, number> | null => {
  const m = plan?.byCraft?.[key];
  return m && Object.values(m).some((n) => n > 0) ? m : null;
};

export function crewShifts(x: CrewCostInput): CrewShiftRow[] {
  const sheet = x.sheet && Object.keys(x.sheet.crafts).length ? x.sheet : null;
  return x.counts.map((c) => {
    const ps = x.plan?.shifts[c.key];
    const plan = ps && ps.direct + ps.indirect > 0 ? { heads: ps.direct + ps.indirect, direct: ps.direct, indirect: ps.indirect } : null;
    const paidH = paidHoursOf(sheet, c.hours);
    const mix = mixOf(x.plan, c.key);
    const planCost = !sheet || !plan ? null : mix ? mixCost(sheet, mix, paidH).cost : null;
    // A shift not yet started has no count of its own (a count carried forward is not one).
    const started = c.start <= x.now;
    const co = started ? c.companies.find((y) => y.company === x.company) : undefined;
    const counted = co ? co.total : null;
    // A hold-over of this company's crews: its hands, and the hours past the shift (still on: to now).
    const holds = started ? (x.holds.get(c.key) ?? []).filter((h) => h.crew?.trim() && x.companyOf(h.crew) === x.company) : [];
    let hold: CrewShiftRow["hold"] = null;
    if (holds.length) {
      let hands = 0, hours = 0, open = false;
      for (const h of holds) {
        const to = h.until ?? Math.min(x.now, c.end + 12 * 3_600_000);
        const hh = Math.max(0, (to - c.end) / 3_600_000);
        hands += h.hands ?? 0; hours = Math.max(hours, hh); open ||= h.until == null;
      }
      const cost = !sheet ? null : holds.reduce<number | null>((a, h) => {
        const to = h.until ?? Math.min(x.now, c.end + 12 * 3_600_000);
        const v = holdCost(sheet, mix ?? {}, x.plan?.crafts, paidH, h.hands ?? 0, Math.max(0, (to - c.end) / 3_600_000));
        return a == null || v == null ? (a ?? v) : a + v;
      }, 0);
      hold = { hands, hours: Math.round(hours * 10) / 10, open, cost };
    }
    // Counted heads at the plan's mix for the shift; with no plan, at the sheet's crafts one each.
    let paid: number | null = null;
    if (sheet && counted != null) {
      if (plan && planCost != null && plan.heads > 0) paid = planCost * (counted / plan.heads);
      else {
        const per = Object.keys(sheet.crafts).map((cr) => headCost(sheet, cr, paidH)).filter((v): v is number => v != null);
        paid = per.length ? counted * (per.reduce((a, b) => a + b, 0) / per.length) : null;
      }
      if (paid != null && hold?.cost != null) paid += hold.cost;
    }
    return { key: c.key, kind: c.kind, start: c.start, end: c.end, plan, counted, carried: c.carried && counted != null, started, hold, planCost, paid };
  });
}

export function crewSummary(rows: CrewShiftRow[], x: Pick<CrewCostInput, "plan" | "sheet">): CrewSummary {
  const priced = !!x.sheet && Object.keys(x.sheet.crafts).length > 0;
  const crafts = new Set(Object.values(x.plan?.byCraft ?? {}).flatMap((m) => Object.keys(m)));
  const unpriced = [...crafts].filter((c) => !(x.sheet?.crafts[c]?.st && x.sheet.crafts[c].st > 0)).sort();
  let counted = 0, plannedOnCounted = 0, countedHeads = 0, short = 0, over = 0, uncounted = 0;
  let paid = 0, planOn = 0, ot = 0, total = 0, notCounted = 0;
  for (const r of rows) {
    total += r.planCost ?? 0;
    if (r.counted != null) {
      counted++; countedHeads += r.counted; plannedOnCounted += r.plan?.heads ?? 0;
      if (r.plan && !r.carried) { if (r.counted < r.plan.heads) short++; else if (r.counted > r.plan.heads) over++; }
      paid += r.paid ?? 0; planOn += r.planCost ?? 0; ot += r.hold?.cost ?? 0;
    } else {
      notCounted += r.planCost ?? 0;
      if (r.started && r.plan) uncounted++;
    }
  }
  return {
    shifts: rows.length, counted, plannedOnCounted, countedHeads, short, over, uncounted,
    paidToDate: priced ? Math.round(paid) : null, planOnCounted: priced ? Math.round(planOn) : null, overtime: priced ? Math.round(ot) : null,
    planTotal: priced ? Math.round(total) : null, forecast: priced ? Math.round(paid + notCounted) : null, unpriced,
  };
}
