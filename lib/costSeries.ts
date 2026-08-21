// lib/costSeries.ts — time-phased cost curves, pure.
//
// The Cost Command Center's S-curve: planned spend (budget spread across the
// schedule span), committed, and actual — cumulative over time. Also the
// planned-manpower curve from an awarded quote's labor hours spread over the
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

function cumulativeAt(sorted: DatedAmount[], atMs: number): number {
  let sum = 0;
  for (const e of sorted) {
    if (toMs(e.date) <= atMs) sum += e.amount;
    else break;
  }
  return sum;
}

/** The S-curve series. Span = schedule dates when present, else the entry
 *  date range; a single-day span still renders (two points). */
export function buildCostSeries(input: CostSeriesInput): CostSeriesPoint[] {
  const points = Math.max(2, input.points ?? 40);
  const entries = [...input.commitments, ...input.actuals]
    .map((e) => toMs(e.date))
    .filter(Number.isFinite);
  const startMs = input.scheduleStart && Number.isFinite(toMs(input.scheduleStart))
    ? toMs(input.scheduleStart)
    : entries.length ? Math.min(...entries) : NaN;
  const endMs = input.scheduleEnd && Number.isFinite(toMs(input.scheduleEnd))
    ? toMs(input.scheduleEnd)
    : entries.length ? Math.max(...entries) : NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const span = Math.max(endMs - startMs, DAY);

  const hasPlan = input.budget > 0
    && !!input.scheduleStart && Number.isFinite(toMs(input.scheduleStart))
    && !!input.scheduleEnd && Number.isFinite(toMs(input.scheduleEnd));
  const commitments = [...input.commitments].sort((a, b) => toMs(a.date) - toMs(b.date));
  const actuals = [...input.actuals].sort((a, b) => toMs(a.date) - toMs(b.date));

  const out: CostSeriesPoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = startMs + (span * i) / (points - 1);
    out.push({
      date: iso(t),
      planned: hasPlan ? (input.budget * Math.min(Math.max((t - startMs) / span, 0), 1)) : null,
      committed: cumulativeAt(commitments, t),
      actual: cumulativeAt(actuals, t),
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
}

/**
 * Forecast in words. Preferred basis: CPI (budget / CPI — the AACE-standard
 * EAC when performance continues). Fallback: straight run-rate against the
 * schedule span. No data → honest null, never a fabricated number.
 */
export function computeForecast(input: {
  budget: number;
  spent: number;
  cpi: number | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  today: string;
  fmt: (n: number) => string;
}): Forecast {
  const { budget, spent, cpi, fmt } = input;
  if (budget <= 0 || spent <= 0) {
    return { eac: null, varianceAtCompletion: null, basis: "none", sentence: null };
  }
  if (cpi != null && cpi > 0) {
    const eac = budget / cpi;
    const vac = eac - budget;
    return {
      eac, varianceAtCompletion: vac, basis: "cpi",
      sentence: vac > 0
        ? `At this performance you'll finish around ${fmt(eac)} — ${fmt(vac)} over budget.`
        : `At this performance you'll finish around ${fmt(eac)} — ${fmt(Math.abs(vac))} under budget.`,
    };
  }
  const s = input.scheduleStart ? toMs(input.scheduleStart) : NaN;
  const e = input.scheduleEnd ? toMs(input.scheduleEnd) : NaN;
  const now = toMs(input.today);
  if (Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(now) && now > s && e > s) {
    const elapsed = Math.min((now - s) / (e - s), 1);
    if (elapsed >= 0.05) {
      const eac = spent / elapsed;
      const vac = eac - budget;
      return {
        eac, varianceAtCompletion: vac, basis: "run_rate",
        sentence: vac > 0
          ? `At the current spend pace you'll finish around ${fmt(eac)} — ${fmt(vac)} over budget.`
          : `At the current spend pace you'll finish around ${fmt(eac)} — on track against budget.`,
      };
    }
  }
  return { eac: null, varianceAtCompletion: null, basis: "none", sentence: null };
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
