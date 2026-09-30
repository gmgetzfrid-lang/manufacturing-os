// lib/costSeries.ts — time-phased cost curves, pure.
//
// The Cost Command Center's S-curve: planned spend (budget spread across the
// schedule span), committed, and actual — cumulative over time. Also the
// planned average crew from an awarded quote's labor hours over the
// schedule. All date math is day-granular and deterministic; the UI only
// draws what this returns.

export interface DatedAmount { date: string; amount: number }   // ISO date (YYYY-MM-DD)

export interface CostSeriesInput {
  budget: number;
  /** Schedule span. Missing dates degrade honestly: no span → planned curve
   *  is omitted (never invented). */
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  commitments: DatedAmount[];
  actuals: DatedAmount[];
  /** Sampling density. ~40 points draws smoothly at any width. */
  points?: number;
}

export interface CostSeriesPoint {
  date: string;
  planned: number | null;   // cumulative planned spend (linear over span)
  committed: number;        // cumulative commitments to date
  actual: number;           // cumulative actual + adjustments to date
}

const DAY = 86_400_000;
const toMs = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : NaN;
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A milestone row as the schedule stores it: `planned_at` is the FINISH,
 *  `planned_start_at` the start (NULL for a zero-duration milestone). */
export interface MilestoneSpanRow {
  planned_at: string | null;
  planned_start_at?: string | null;
}

/**
 * MON-2: the schedule span every cost picture shares — the S-curve's planned
 * line, the crew figure and the run-rate forecast — from the EARLIEST task
 * START (`planned_start_at`, or the finish for a row with no start) to the
 * LATEST finish. The span used to start at the earliest FINISH, so a first
 * task running 1–12 June drew the planned line from 12 June: eleven days
 * late and steeper than the plan. A single dated row still spans when it has
 * a start before its finish; otherwise two dated rows are needed, as before.
 */
export function scheduleSpanFromMilestones(rows: MilestoneSpanRow[]): { start: string | null; end: string | null } {
  let lo = Infinity;
  let hi = -Infinity;
  let dated = 0;
  for (const r of rows) {
    const finish = r.planned_at ? toMs(r.planned_at) : NaN;
    const begin = r.planned_start_at ? toMs(r.planned_start_at) : NaN;
    const s = Number.isFinite(begin) ? begin : finish;
    const e = Number.isFinite(finish) ? finish : begin;
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    dated++;
    lo = Math.min(lo, s, e);
    hi = Math.max(hi, s, e);
  }
  if (dated === 0 || (dated < 2 && !(hi > lo))) return { start: null, end: null };
  return { start: iso(lo), end: iso(hi) };
}

/** PERF-10: every entry date is parsed ONCE, here — the sampling loop then
 *  walks the sorted arrays with a cursor instead of re-parsing every entry
 *  at every sample (40 samples × 450 entries was ~36,000 Date.parse calls).
 *  An unparseable date is dropped, as the old scan effectively did. */
function parsedSorted(xs: DatedAmount[]): Array<{ t: number; amount: number }> {
  const out: Array<{ t: number; amount: number }> = [];
  for (const e of xs) {
    const t = toMs(e.date);
    if (Number.isFinite(t)) out.push({ t, amount: e.amount });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The S-curve series. The GRID spans schedule dates extended to cover
 *  every entry (a late invoice or closeout CO must never vanish from the
 *  chart's terminal totals); the PLANNED line still climbs across the
 *  schedule span only, holding flat at budget beyond schedule end. A
 *  single-day span still renders (two points). */
export function buildCostSeries(input: CostSeriesInput): CostSeriesPoint[] {
  const points = Math.max(2, input.points ?? 40);
  const commitments = parsedSorted(input.commitments);
  const actuals = parsedSorted(input.actuals);
  const planStart = input.scheduleStart ? toMs(input.scheduleStart) : NaN;
  const planEnd = input.scheduleEnd ? toMs(input.scheduleEnd) : NaN;
  // The sorted arrays' ends are the entries' extremes — no second pass.
  const firstEntry = Math.min(commitments[0]?.t ?? Infinity, actuals[0]?.t ?? Infinity);
  const lastEntry = Math.max(commitments.at(-1)?.t ?? -Infinity, actuals.at(-1)?.t ?? -Infinity);
  const candidatesStart = [planStart, firstEntry].filter(Number.isFinite);
  const candidatesEnd = [planEnd, lastEntry].filter(Number.isFinite);
  if (candidatesStart.length === 0 || candidatesEnd.length === 0) return [];
  const startMs = Math.min(...candidatesStart);
  const endMs = Math.max(...candidatesEnd);
  const span = Math.max(endMs - startMs, DAY);

  const hasPlan = input.budget > 0 && Number.isFinite(planStart) && Number.isFinite(planEnd);
  const planSpan = hasPlan ? Math.max(planEnd - planStart, DAY) : DAY;

  const out: CostSeriesPoint[] = [];
  let ci = 0, ai = 0, committed = 0, actual = 0;
  for (let i = 0; i < points; i++) {
    const t = startMs + (span * i) / (points - 1);
    while (ci < commitments.length && commitments[ci].t <= t) committed += commitments[ci++].amount;
    while (ai < actuals.length && actuals[ai].t <= t) actual += actuals[ai++].amount;
    out.push({
      date: iso(t),
      planned: hasPlan ? (input.budget * Math.min(Math.max((t - planStart) / planSpan, 0), 1)) : null,
      committed,
      actual,
    });
  }
  return out;
}

export interface Forecast {
  /** Estimate At Completion. Null when there's nothing to project from. */
  eac: number | null;
  /** eac - budget; positive = over. */
  varianceAtCompletion: number | null;
  /** How the number was reached — shown to the user, never hidden. */
  basis: "cpi" | "run_rate" | "none";
  /** Plain-English one-liner ready to render. */
  sentence: string | null;
  /** COST-1: which portion of the budget the CPI covers, in words — the
   *  label the Costs tab and the report print beside a CPI-based EAC. Null
   *  when the basis is not CPI. */
  scopeNote: string | null;
}

/**
 * Forecast in words. Preferred basis: CPI (budget / CPI — the AACE-standard
 * EAC when performance continues). Fallback: straight run-rate against the
 * schedule span. No data → honest null, never a fabricated number.
 *
 * COST-1: CPI is measured over the milestone-PINNED accounts only, so the
 * CPI branch divides only the pinned budget by it. The unpinned remainder
 * has no earned-value evidence, so it is carried AT ITS BUDGET — a spend
 * pace (when the schedule gives one) may raise it above budget, never lower
 * it below: a barely-started line ($1 at 50% elapsed) projects a pace of
 * $2, and carrying that would drop the rest of its budget from the EAC and
 * print "under budget" in emerald. Every part is floored at what it has
 * already spent, so the EAC can never fall below money already spent. When
 * the caller does not say how much of the budget is pinned, CPI is applied
 * to the whole budget as before, floored at spent, and the note says so.
 */
export function computeForecast(input: {
  budget: number;
  spent: number;
  cpi: number | null;
  /** The pinned subset `cpi` was measured on (ProjectCostRollup.pinnedBudget / pinnedSpent). */
  pinnedBudget?: number | null;
  pinnedSpent?: number | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  today: string;
  fmt: (n: number) => string;
}): Forecast {
  const { budget, spent, cpi, fmt } = input;
  const none: Forecast = { eac: null, varianceAtCompletion: null, basis: "none", sentence: null, scopeNote: null };
  if (budget <= 0 || spent <= 0) return none;

  const s = input.scheduleStart ? toMs(input.scheduleStart) : NaN;
  const e = input.scheduleEnd ? toMs(input.scheduleEnd) : NaN;
  const now = toMs(input.today);
  const elapsed = Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(now) && now > s && e > s
    ? Math.min((now - s) / (e - s), 1) : NaN;
  const runRateUsable = Number.isFinite(elapsed) && elapsed >= 0.05;

  if (cpi != null && cpi > 0) {
    let eac: number;
    let scopeNote: string;
    if (input.pinnedBudget == null) {
      eac = Math.max(budget / cpi, spent);
      scopeNote = "CPI is measured on the schedule-pinned accounts and applied to the whole budget here.";
    } else {
      const pinnedBudget = Math.max(0, Math.min(input.pinnedBudget, budget));
      const pinnedSpent = Math.max(0, Math.min(input.pinnedSpent ?? 0, spent));
      const rest = budget - pinnedBudget;
      const restSpent = spent - pinnedSpent;
      const eacPinned = Math.max(pinnedBudget / cpi, pinnedSpent);
      const pace = runRateUsable && restSpent > 0 ? restSpent / elapsed : null;
      const restByPace = pace != null && pace > Math.max(rest, restSpent);
      const eacRest = rest <= 0
        ? Math.max(0, restSpent)
        : Math.max(rest, restSpent, pace ?? 0);
      eac = eacPinned + eacRest;
      const share = Math.round((pinnedBudget / budget) * 100);
      scopeNote = rest <= 0
        ? "CPI covers the whole budget — every account is pinned to a schedule task."
        : `CPI applies to the ${share}% of budget pinned to schedule tasks (${fmt(pinnedBudget)}); the other ${fmt(rest)} is carried ${restByPace ? "at the current spend pace, which runs above its budget" : restSpent <= 0 ? "at budget (nothing spent on it yet)" : restSpent > rest ? "at what it has already spent (above its budget)" : "at budget (no earned-value evidence to project it lower)"}.`;
    }
    const vac = eac - budget;
    return {
      eac, varianceAtCompletion: vac, basis: "cpi", scopeNote,
      sentence: vac > 0
        ? `At this performance you'll finish around ${fmt(eac)} — ${fmt(vac)} over budget.`
        : `At this performance you'll finish around ${fmt(eac)} — ${fmt(Math.abs(vac))} under budget.`,
    };
  }
  if (runRateUsable) {
    const eac = spent / elapsed;
    const vac = eac - budget;
    return {
      eac, varianceAtCompletion: vac, basis: "run_rate", scopeNote: null,
      sentence: vac > 0
        ? `At the current spend pace you'll finish around ${fmt(eac)} — ${fmt(vac)} over budget.`
        : `At the current spend pace you'll finish around ${fmt(eac)} — on track against budget.`,
    };
  }
  return none;
}

/** Planned manpower loading: the awarded quote's labor hours spread evenly
 *  over the schedule span, bucketed by week — the crew-size curve supers
 *  argue from. Headcount = hours/week ÷ 40. */
export function plannedManpowerSeries(input: {
  laborHours: number;
  scheduleStart: string;
  scheduleEnd: string;
}): Array<{ weekOf: string; headcount: number }> {
  const s = toMs(input.scheduleStart);
  const e = toMs(input.scheduleEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || input.laborHours <= 0) return [];
  const weeks = Math.max(1, Math.ceil((e - s) / (7 * DAY)));
  const perWeek = input.laborHours / weeks;
  const out: Array<{ weekOf: string; headcount: number }> = [];
  for (let w = 0; w < weeks; w++) {
    out.push({ weekOf: iso(s + w * 7 * DAY), headcount: Math.round((perWeek / 40) * 10) / 10 });
  }
  return out;
}
