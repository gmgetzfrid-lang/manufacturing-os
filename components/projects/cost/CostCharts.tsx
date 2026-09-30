"use client";

// CostCharts — the Cost Command Center's picture layer: the S-curve
// (planned vs committed vs spent over time, with the budget and today), the
// forecast sentence in plain English, the planned average crew from the
// awarded bid, the burn by budget line, and the EXAMPLE preview that shows
// all of it before the project has a single account or entry.
//
// Everything drawn here comes from the pure engines (lib/costSeries,
// lib/exampleProject) through ONE layout (CostPictures) — example mode is the
// real UI with stand-in data, every figure marked, never a mock screenshot,
// and it shows nothing the real interface cannot draw (REL-11).

import React, { useMemo } from "react";
import { LineChart as LineChartIcon, Users, BarChart3 } from "lucide-react";
import { SCurveChart, ExampleFrame, BarList, type BarItem, type SCurvePoint } from "@/components/ui/ChartKit";
import {
  buildCostSeries, computeForecast, plannedCrewAverage,
  type DatedAmount, type Forecast, type PlannedCrew,
} from "@/lib/costSeries";
import { buildExampleCostData } from "@/lib/exampleProject";
import { computeBidEconomics } from "@/lib/bidTab";
import { fmtMoney, type CostEntry, type ProjectCostRollup } from "@/lib/costs";

// Axis labels: compact money ("$150K"), one formatter per currency.
const compactFmts = new Map<string, Intl.NumberFormat>();
export function compactMoney(n: number, currency: string): string {
  let f = compactFmts.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
    } catch {
      return fmtMoney(n, currency);
    }
    compactFmts.set(currency, f);
  }
  return f.format(n);
}

export function entriesToDated(entries: CostEntry[]): { commitments: DatedAmount[]; actuals: DatedAmount[] } {
  const commitments: DatedAmount[] = [];
  const actuals: DatedAmount[] = [];
  for (const e of entries) {
    if (e.status === "void" || !e.entryDate) continue;
    if (e.entryType === "commitment") commitments.push({ date: e.entryDate, amount: e.amount });
    else actuals.push({ date: e.entryDate, amount: e.amount }); // actual + adjustment = money really consumed
  }
  return { commitments, actuals };
}

/** REL-11: how many budget lines the burn list draws before it points at
 *  the accounts table below. */
export const BURN_LINES_SHOWN = 8;

export default function CostCharts({ rollup, entries, scheduleStart, scheduleEnd, awardedLaborHours }: {
  rollup: ProjectCostRollup;
  entries: CostEntry[];
  /** Schedule span from the project's milestones — earliest task start to
   *  latest finish (lib/costSeries scheduleSpanFromMilestones, MON-2). */
  scheduleStart: string | null;
  scheduleEnd: string | null;
  /** Labor hours from the awarded quote, when one exists — the planned average crew. */
  awardedLaborHours: number | null;
}) {
  const cur = rollup.currencies[0] ?? "USD";
  const fmt = useMemo(() => (n: number) => fmtMoney(n, cur), [cur]);
  const tickFmt = useMemo(() => (n: number) => compactMoney(n, cur), [cur]);
  const todayIso = new Date().toISOString().slice(0, 10);

  // REL-10: the example renders ONLY for a project with no accounts AND no
  // entries. A chart of accounts whose budgets are still blank (the natural
  // order of setup), or a ledger whose entries were all voided, is a real
  // project — it gets its own (sparse) picture, never stand-in numbers.
  const hasRealData = rollup.accounts.length > 0 || entries.length > 0;

  const { series, forecast, crew } = useMemo(() => {
    if (!hasRealData) return { series: [] as SCurvePoint[], forecast: null, crew: null };
    const { commitments, actuals } = entriesToDated(entries);
    // The planned line and the forecast plan against the same (revised) budget.
    const series = buildCostSeries({
      budget: rollup.revisedBudget, scheduleStart, scheduleEnd, commitments, actuals,
    });
    const forecast = computeForecast({
      budget: rollup.revisedBudget, spent: rollup.spent, cpi: rollup.cpi,
      pinnedBudget: rollup.pinnedBudget, pinnedSpent: rollup.pinnedSpent,
      scheduleStart, scheduleEnd, today: todayIso, fmt,
    });
    const crew = awardedLaborHours && scheduleStart && scheduleEnd
      ? plannedCrewAverage({ laborHours: awardedLaborHours, scheduleStart, scheduleEnd })
      : null;
    return { series, forecast, crew };
  }, [hasRealData, entries, rollup.revisedBudget, rollup.spent, rollup.cpi, rollup.pinnedBudget, rollup.pinnedSpent, scheduleStart, scheduleEnd, awardedLaborHours, todayIso, fmt]);

  // ── Example preview: the same layout, stand-in data, every figure marked ──
  if (!hasRealData) {
    const ex = buildExampleCostData();
    const exSeries = buildCostSeries({
      budget: ex.budget, scheduleStart: ex.scheduleStart, scheduleEnd: ex.scheduleEnd,
      commitments: ex.commitments, actuals: ex.actuals,
    });
    const exForecast = computeForecast({
      budget: ex.budget, spent: ex.actuals.reduce((s, a) => s + a.amount, 0), cpi: ex.cpi,
      today: ex.today, fmt,
    });
    const exEcon = computeBidEconomics(ex.quotes);
    const exAward = exEcon.find((e) => e.vendorName === "Gulf Mechanical");
    const exCrew = exAward?.laborHours
      ? plannedCrewAverage({ laborHours: exAward.laborHours, scheduleStart: ex.scheduleStart, scheduleEnd: ex.scheduleEnd })
      : null;
    return (
      <ExampleFrame note="No budget lines or entries yet — this is the picture a running job draws. Add a budget line below and it goes live.">
        <CostPictures example series={exSeries} fmt={fmt} tickFmt={tickFmt} todayIso={ex.today}
          budget={ex.budget} budgetLabel="Budget" plannedHint={null}
          forecast={exForecast} crew={exCrew}
          burn={ex.accounts.map((a) => ({
            label: `${a.code} ${a.name}`, value: a.spent, slot: 0,
            sublabel: `${fmt(a.committed)} committed · of ${fmt(a.budget)} budget (example)`,
            flag: a.spent > a.budget ? "over budget" : undefined,
          }))}
          burnTotal={ex.accounts.length} />
      </ExampleFrame>
    );
  }

  // REL-11: the planned line is missing whenever there is no budget OR no
  // schedule span — the hint says which, every time the line is absent.
  const noBudget = !(rollup.revisedBudget > 0);
  const noSchedule = !scheduleStart || !scheduleEnd;
  // DEC-52: a schedule with no budget and no money posted draws flat lines on
  // a zero axis — nothing to read. Say so instead of drawing it.
  const noMoney = noBudget && series.every((p) => p.planned == null && p.committed === 0 && p.actual === 0);
  const plannedHint = !noMoney && series.length >= 2 && !series.some((p) => p.planned != null)
    ? noBudget && noSchedule
      ? "No budget and no schedule dates yet, so there's no planned-pace line — set a budget and add milestones and it appears."
      : noBudget
        ? "No budget on any line yet, so there's no planned-pace line — set a budget and it appears."
        : "No schedule dates yet, so there's no planned-pace line — import or add milestones and it appears."
    : null;

  // REL-11: burn by budget line, for real — the lines that have spent most first.
  const burnLines = [...rollup.accounts].sort((a, b) => b.spent - a.spent || b.revisedBudget - a.revisedBudget);
  const burn: BarItem[] = burnLines.slice(0, BURN_LINES_SHOWN).map((r) => ({
    label: [r.account.code, r.account.name].filter(Boolean).join(" "),
    value: r.spent, slot: 0,
    sublabel: `${fmt(r.committed)} committed · of ${fmt(r.revisedBudget)} budget`,
    flag: r.revisedBudget > 0 && r.spent > r.revisedBudget ? "over budget" : r.overBudget ? "over-committed" : undefined,
  }));

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
      <CostPictures series={noMoney ? [] : series} emptyReason={series.length >= 2 ? "no-money" : "no-dates"}
        fmt={fmt} tickFmt={tickFmt} todayIso={todayIso}
        budget={rollup.revisedBudget} budgetLabel={rollup.approvedChanges !== 0 ? "Revised budget" : "Budget"}
        plannedHint={plannedHint} forecast={forecast} crew={crew} burn={burn} burnTotal={burnLines.length} />
    </div>
  );
}

/** The one layout both the real picture and the example draw through. */
function CostPictures({ series, emptyReason = "no-dates", fmt, tickFmt, todayIso, budget, budgetLabel, plannedHint, forecast, crew, burn, burnTotal, example = false }: {
  series: SCurvePoint[];
  /** Why `series` is empty: no dates to draw across, or dates but no money
   *  (no budget, nothing posted). */
  emptyReason?: "no-dates" | "no-money";
  fmt: (n: number) => string;
  tickFmt: (n: number) => string;
  todayIso: string;
  budget: number;
  budgetLabel: string;
  plannedHint: string | null;
  forecast: Forecast | null;
  crew: PlannedCrew | null;
  burn: BarItem[];
  burnTotal: number;
  example?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <SectionLabel icon={<LineChartIcon className="w-3.5 h-3.5" />} text="Spend curve — planned pace vs promised vs spent" />
        {series.length >= 2 ? (
          <>
            <SCurveChart points={series} fmt={fmt} tickFmt={tickFmt} todayIso={todayIso}
              budget={budget} budgetLabel={budgetLabel} example={example} />
            {plannedHint && (
              <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{plannedHint}</div>
            )}
          </>
        ) : emptyReason === "no-money" ? (
          // A schedule but no budget and nothing posted (right after an
          // import): no flat line on a zero axis — say what would draw it.
          <div data-empty="spend-curve" data-reason="no-money" className="rounded-xl border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">
            <b className="text-[var(--color-text)]">No spend curve yet — there&apos;s no money to plot.</b>{" "}
            Set a budget on a budget line to draw the planned pace across the schedule, or post a commitment or an actual to start the spent line.
          </div>
        ) : (
          // REL-11: the budget-only state (the one right after onboarding)
          // explains itself instead of leaving a silent gap.
          <div data-empty="spend-curve" data-reason="no-dates" className="rounded-xl border border-dashed border-[var(--color-border-strong)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">
            <b className="text-[var(--color-text)]">No spend curve yet — it needs dates.</b>{" "}
            Add or import milestones to draw the planned pace against your budget, or post a commitment or an actual to start the spent line.
          </div>
        )}
      </div>
      {forecast?.sentence && (
        <ForecastSentence sentence={forecast.sentence} basis={forecast.basis} scopeNote={forecast.scopeNote} example={example} />
      )}
      {(crew || burn.length > 0) && (
        <div className="grid md:grid-cols-2 gap-4">
          {crew && <CrewStat crew={crew} example={example} />}
          {burn.length > 0 && (
            <div>
              <SectionLabel icon={<BarChart3 className="w-3.5 h-3.5" />} text="Burn by budget line" />
              <BarList fmt={fmt} items={burn} example={example} />
              {burnTotal > burn.length && (
                <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
                  The {burn.length} lines with the most spent, of {burnTotal} — every line is in the accounts table below.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** CHART-3 / A11Y-11: the planned crew is ONE number — said as text, with
 *  the inputs that produced it, instead of a row of identical bars. */
function CrewStat({ crew, example }: { crew: PlannedCrew; example: boolean }) {
  const people = crew.averageCrew < 0.05 ? "Under 0.1" : `≈ ${crew.averageCrew.toFixed(1)}`;
  return (
    <div data-stat="planned-crew">
      <SectionLabel icon={<Users className="w-3.5 h-3.5" />} text="Planned average crew (from the awarded bid's hours)" />
      <div className="text-xl font-black text-[var(--color-text)]">
        {people} people{example ? " (example)" : ""}
      </div>
      <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
        {Math.round(crew.laborHours).toLocaleString()} labor hours over {crew.days} days ({crew.weeks.toFixed(1)} weeks) ÷ 40 hours per person-week.
        The bid states hours, not when they are worked, so this is an average across the schedule — not a crew curve.
      </p>
    </div>
  );
}

function SectionLabel({ icon, text }: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
      {icon}{text}
    </div>
  );
}

function ForecastSentence({ sentence, basis, scopeNote, example = false }: {
  sentence: string; basis: "cpi" | "run_rate" | "none"; scopeNote?: string | null;
  /** REL-10: the most quotable line on the screen says "Example" in itself. */
  example?: boolean;
}) {
  const over = /over budget/.test(sentence);
  return (
    <div data-forecast className={`rounded-xl border px-3 py-2.5 text-sm font-bold ${
      over ? "border-rose-500/40 bg-rose-500/[0.06] text-rose-800 dark:text-rose-300"
        : "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-800 dark:text-emerald-300"}`}>
      {example ? `Example — ${sentence}` : sentence}
      <span className="ml-2 text-[10px] font-bold text-[var(--color-text-muted)]">
        {basis === "cpi" ? "Based on cost performance so far (CPI)." : "Based on the spending pace against the schedule."}
        {/* COST-1 dw2: which portion of the budget the CPI-based EAC covers. */}
        {scopeNote ? ` ${scopeNote}` : ""}
      </span>
    </div>
  );
}

// ── The glossary — jargon kept, but explained where everyone can see it ──

export const COST_GLOSSARY_TERMS: Array<{ term: string; plain: string }> = [
  { term: "Budget", plain: "What you plan to spend, split into budget lines (cost accounts)." },
  { term: "Commitment", plain: "Money you've promised — a signed PO or an awarded contract. Not spent yet, but spoken for." },
  { term: "Actual", plain: "Money that really left — an invoice or timesheet posted against a budget line." },
  { term: "Adjustment", plain: "A signed correction. Negative adjustments credit money back." },
  { term: "Available (uncommitted)", plain: "Budget minus what you've spent minus what you've promised (open commitments, net of the invoices already posted against them). The number you can still award." },
  { term: "Earned value (EV)", plain: "Work done, priced at budget: a line pinned to a schedule task earns its budget × that task's % complete." },
  { term: "CPI", plain: "Cost Performance Index = earned value ÷ actual cost. 1.0 is on budget; 1.06 means you get $1.06 of work per $1 spent; below 1.0 you're over-running." },
  { term: "SPI", plain: "Schedule Performance Index — same idea for time. Below 1.0 means behind schedule." },
  { term: "S-curve", plain: "The spend-over-time chart: planned pace (grey dashes), committed (dash-dot line) and spent (solid line, shaded), with the budget drawn across and a marker at today — healthy jobs track near the planned line." },
  { term: "EAC / forecast", plain: "Estimate At Completion — where the total lands if current performance continues: the part of the budget pinned to schedule tasks ÷ CPI, plus the rest at its budget (or at its spend pace, if that runs higher). The note beside the forecast says which applied." },
  { term: "Planned average crew", plain: "The awarded bid's labor hours ÷ the schedule's weeks ÷ 40 hours per person-week. An average, not a curve — a bid says how many hours, not which weeks they fall in." },
  { term: "RFQ group", plain: "One scope of work you asked several companies to price. Their quotes tabulate side by side under it." },
  { term: "Bid tabulation", plain: "The side-by-side of competing quotes: price, labor hours offered, $/hour, and what each bid EXCLUDED — which is usually why the low bid is low." },
  { term: "$/labor-hour", plain: "Total price ÷ labor hours offered. The manpower-for-the-money number — lower buys more hands." },
  { term: "Change order (CO)", plain: "A priced change to the contract, with a reason code. Approving one posts the money; nothing changes the budget silently." },
];

export function CostGlossary() {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-[var(--color-surface-2)]/40 transition-colors">
        <span className="text-sm font-bold text-[var(--color-text)]">What do these words mean?</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">Plain-language guide to every term on this page</span>
        <span className="ml-auto text-[10px] font-black text-[var(--color-accent)]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <dl className="px-4 pb-4 pt-1 grid md:grid-cols-2 gap-x-6 gap-y-2 border-t border-[var(--color-border)]">
          {COST_GLOSSARY_TERMS.map((t) => (
            <div key={t.term} className="text-xs">
              <dt className="font-black text-[var(--color-text)]">{t.term}</dt>
              <dd className="text-[var(--color-text-muted)] mt-0.5">{t.plain}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
