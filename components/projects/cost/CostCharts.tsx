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
import { BIDDER_TERM, CONTRACTOR_TERM, NOT_SELECTED_TERM, VOID_TERM, type VocabularyTerm } from "@/lib/projectVocabulary";

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

/** A budget line's currency, read as the cost rollup reads it
 *  (computeCostRollup's `currencies` in lib/costs): a legacy line with no
 *  currency is USD — never the project's first currency. One rule for the
 *  burn list, the accounts table and the account detail, so a line prints in
 *  the currency the mixed-currency banner counts it in. */
export function accountCurrency(account: { currency: string | null }): string {
  return (account.currency ?? "USD").toUpperCase();
}

/** One budget line as the burn list reads it. `exposure` is the rollup's
 *  spent + open commitments, the figure `overBudget` trips on. */
interface BurnLine { label: string; spent: number; committed: number; exposure: number; budget: number; overBudget: boolean }

/** REL-11: the burn list's tiers. The alarms come first, so the list never
 *  cuts one off to show a line that is merely further along:
 *  0 — over budget on exposure (DEC-50 rule 1's alarm, which an
 *      over-committed line trips before a dollar is invoiced);
 *  1 — money on a line with no budget to hold it (infinitely through a
 *      budget of nothing);
 *  2 — every other line with a budget;
 *  3 — no budget and no money: nothing to measure. */
function burnTier(line: BurnLine): 0 | 1 | 2 | 3 {
  if (line.overBudget) return 0;
  if (line.budget > 0) return 2;
  return line.spent > 0 || line.committed > 0 ? 1 : 3;
}

/** An alarm line: over budget, or money with no budget. */
function isBurnAlarm(line: BurnLine): boolean {
  return burnTier(line) <= 1;
}

/** REL-11: the burn order — the tiers above; within a tier with budgets, the
 *  line furthest through its own budget on exposure first (then on spent).
 *  A share of the line's own budget compares across currencies; a raw amount
 *  would not, so lines without a budget keep the accounts table's order. */
function byBurn(a: BurnLine, b: BurnLine): number {
  const ta = burnTier(a), tb = burnTier(b);
  if (ta !== tb) return ta - tb;
  if (!(a.budget > 0 && b.budget > 0)) return 0;
  return Math.max(b.spent, b.exposure) / b.budget - Math.max(a.spent, a.exposure) / a.budget
    || b.spent / b.budget - a.spent / a.budget;
}

/** REL-11: one row of the burn list — the line's spent against its OWN
 *  budget (the account bars' scale in the table below), what is committed as
 *  the paler bar behind it, and every figure in the line's own currency
 *  (`f`). Over budget on exposure, the bar takes the alarm colour and the
 *  flag the accounts table prints for the same line ("over budget"). */
function burnItem(line: BurnLine, f: (n: number) => string, example = false): BarItem {
  const tag = example ? " (example)" : "";
  return {
    label: line.label,
    value: line.spent, valueLabel: f(line.spent), slot: 0,
    of: line.budget, ghost: { value: line.committed, slot: 1 }, alarm: line.overBudget,
    sublabel: line.budget > 0
      ? `${f(line.committed)} committed · of ${f(line.budget)} budget${tag}`
      : `${f(line.committed)} committed · no budget set${tag}`,
    flag: line.overBudget ? "over budget" : undefined,
  };
}

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
          burn={ex.accounts
            .map((a): BurnLine => {
              // The rollup's exposure for a line with one party: spent plus
              // the commitment not yet invoiced.
              const exposure = Math.max(a.spent, a.committed);
              return {
                label: `${a.code} ${a.name}`, spent: a.spent, committed: a.committed, exposure, budget: a.budget,
                overBudget: a.budget > 0 && exposure > a.budget,
              };
            })
            .sort(byBurn).map((l) => burnItem(l, fmt, true))}
          burnTotal={ex.accounts.length} />
      </ExampleFrame>
    );
  }

  // REL-11: the planned line is missing whenever there is no budget OR no
  // schedule span — the hint says which, every time the line is absent.
  const noBudget = !(rollup.revisedBudget > 0);
  const noSchedule = !scheduleStart || !scheduleEnd;
  // Draw only what the data holds (the cost charts' decision in DECISIONS.md):
  // a schedule with no budget and no money posted draws flat lines on a zero
  // axis — nothing to read. Say so instead of drawing it.
  const noMoney = noBudget && series.every((p) => p.planned == null && p.committed === 0 && p.actual === 0);
  const plannedHint = !noMoney && series.length >= 2 && !series.some((p) => p.planned != null)
    ? noBudget && noSchedule
      ? "No budget and no schedule dates yet, so there's no planned-pace line — set a budget and add dated tasks and it appears."
      : noBudget
        ? "No budget on any line yet, so there's no planned-pace line — set a budget and it appears."
        : "No schedule dates yet, so there's no planned-pace line — import a schedule or add dated tasks and it appears."
    : null;

  // REL-11: burn by budget line, for real — each line against its own
  // (revised) budget and in its own currency, as the accounts table below
  // formats it; the alarms first, then the lines furthest through their
  // budgets. Any alarm the cut still leaves out is counted under the list.
  const burnLines = rollup.accounts
    .map((r) => ({
      label: [r.account.code, r.account.name].filter(Boolean).join(" "),
      spent: r.spent, committed: r.committed, exposure: r.exposure, budget: r.revisedBudget, overBudget: r.overBudget,
      currency: accountCurrency(r.account),
    }))
    .sort(byBurn);
  const burn: BarItem[] = burnLines.slice(0, BURN_LINES_SHOWN)
    .map((l) => burnItem(l, (n) => fmtMoney(n, l.currency)));
  const burnAlarmsHidden = burnLines.slice(BURN_LINES_SHOWN).filter(isBurnAlarm).length;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
      <CostPictures series={noMoney ? [] : series} emptyReason={series.length >= 2 ? "no-money" : "no-dates"}
        fmt={fmt} tickFmt={tickFmt} todayIso={todayIso}
        budget={rollup.revisedBudget} budgetLabel={rollup.approvedChanges !== 0 ? "Revised budget" : "Budget"}
        plannedHint={plannedHint} forecast={forecast} crew={crew} burn={burn} burnTotal={burnLines.length}
        burnAlarmsHidden={burnAlarmsHidden} mixedCurrency={rollup.currencies.length > 1} />
    </div>
  );
}

/** The one layout both the real picture and the example draw through. */
function CostPictures({ series, emptyReason = "no-dates", fmt, tickFmt, todayIso, budget, budgetLabel, plannedHint, forecast, crew, burn, burnTotal, burnAlarmsHidden = 0, mixedCurrency = false, example = false }: {
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
  /** Alarm lines (over budget, or money with no budget) past the cut. */
  burnAlarmsHidden?: number;
  /** The budget lines are in more than one currency: each burn row is in its own. */
  mixedCurrency?: boolean;
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
            Add dated tasks (or import a schedule) to draw the planned pace against your budget, or post a commitment or an actual to start the spent line.
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
              {/* The scale, said: each bar is a share of its own line's budget. */}
              <div data-burn-scale className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
                Each bar is the line&apos;s spent against its own budget; the paler bar behind it is what&apos;s committed.
                {mixedCurrency ? " Each line is in its own currency." : ""}
              </div>
              {burnTotal > burn.length && (
                <div data-burn-cut className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Showing {burn.length} of {burnTotal}: lines over budget first, then lines with money but no budget, then the lines furthest through their budgets.
                  {burnAlarmsHidden > 0
                    ? ` ${burnAlarmsHidden} more ${burnAlarmsHidden === 1 ? "line is" : "lines are"} over budget or unbudgeted and didn't fit.`
                    : ""}
                  {" "}Every line is in the accounts table below.
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

/** UX-15: every term the Costs tab shows, in the words it shows them — and
 *  nothing it does not (SPI is not on this tab; "S-curve" and "$/labor-hour"
 *  are on screen as "Spend curve" and "Price / hr"). The company and
 *  "no longer counts" words come from lib/projectVocabulary, the one list. */
export const COST_GLOSSARY_TERMS: VocabularyTerm[] = [
  { term: "Budget", plain: "What you plan to spend, split into budget lines (cost accounts)." },
  { term: "Revised budget", plain: "The budget plus the approved change orders. Burn, Available and the forecast measure against it." },
  { term: "Commitment", plain: "Money you've promised — a signed PO or an awarded contract. Not spent yet, but spoken for." },
  { term: "Actual", plain: "Money that really left — an invoice or timesheet posted against a budget line. Actuals add up to Spent." },
  { term: "Adjustment", plain: "A signed correction. Negative adjustments credit money back." },
  { term: "% burned", plain: "Spent ÷ the revised budget — how far through its money the job is." },
  { term: "Available (uncommitted)", plain: "Budget minus what you've spent minus what you've promised (open commitments, net of the invoices already posted against them). The number you can still award." },
  { term: "Unspent (actuals only)", plain: "The revised budget minus the actuals alone — it ignores what is promised but not yet invoiced, so it is never smaller than Available." },
  { term: "Exposure", plain: "What a budget line will cost at least: spent plus the open commitments not yet invoiced. The over-budget flag uses it." },
  { term: "Pinned (to a schedule task)", plain: "A budget line tied to one schedule task, so it earns value as that task progresses. An unpinned line earns nothing and is forecast at its budget (or its spend pace, if that runs higher)." },
  { term: "Earned value (EV)", plain: "Work done, priced at budget: a line pinned to a schedule task earns its budget × that task's % complete." },
  { term: "CPI", plain: "Cost Performance Index = earned value ÷ actual cost. 1.0 is on budget; 1.06 means you get $1.06 of work per $1 spent; below 1.0 you're over-running." },
  { term: "Spend curve", plain: "The spend-over-time chart (an S-curve): planned pace (grey dashes), committed (dash-dot line) and spent (solid line, shaded), with the budget drawn across and a marker at today — healthy jobs track near the planned line." },
  { term: "EAC / forecast", plain: "Estimate At Completion — where the total lands if current performance continues: the part of the budget pinned to schedule tasks ÷ CPI, plus the rest at its budget (or at its spend pace, if that runs higher). The note beside the forecast says which applied." },
  { term: "Planned average crew", plain: "The awarded bid's labor hours ÷ the schedule's weeks ÷ 40 hours per person-week. An average, not a curve — a bid says how many hours, not which weeks they fall in." },
  { term: "RFQ group", plain: "One scope of work you asked several companies to price (a Request For Quotation). Their quotes tabulate side by side under it." },
  BIDDER_TERM,
  { term: "Bid tabulation", plain: "The side-by-side of competing quotes: price, labor hours offered, price per hour, and what each bid EXCLUDED — which is usually why the low bid is low." },
  { term: "Price / hr", plain: "Total price ÷ labor hours offered. The manpower-for-the-money number — lower buys more hands." },
  { term: "Peak crew", plain: "The largest crew size the bid states." },
  { term: "Value score", plain: "How a bid ranks in its RFQ group: its price against the others, plus manpower-for-the-money once enough bids state believable hours. A ranking aid, not the winner — you decide." },
  { term: "Not stated", plain: "The bid gives no labor hours. Where the field scores manpower, it scores none; check the PDF." },
  { term: "excludes:", plain: "Scope a bid explicitly leaves out — declared, so it never lowers the score; it is scope you must buy elsewhere." },
  { term: "check:", plain: "A line another bidder priced that this bid's wording doesn't obviously cover — a silent gap to check in the PDF. A prompt, not a finding; it does not change the score." },
  NOT_SELECTED_TERM,
  { term: "Change order (CO)", plain: "A priced change to the contract, with a reason code. Approving one posts the money; nothing changes the budget silently." },
  { term: "Reason code", plain: "Why a change order happened. It decides whose record the money lands on: a contractor's scope gap counts against that contractor; a design error or an owner request counts against us." },
  CONTRACTOR_TERM,
  VOID_TERM,
];

/** Remembers (per browser) that the glossary has been seen once. */
const GLOSSARY_SEEN_KEY = "costGlossarySeen.v1";

export function CostGlossary() {
  // A11Y-12: open on a viewer's FIRST visit — the definitions are not an
  // Easter egg at the foot of the page — and collapsed after that. Storage
  // can be blocked; then it simply opens.
  const [open, setOpen] = React.useState(() => {
    try { return typeof window !== "undefined" && window.localStorage.getItem(GLOSSARY_SEEN_KEY) !== "1"; } catch { return true; }
  });
  React.useEffect(() => {
    try { window.localStorage.setItem(GLOSSARY_SEEN_KEY, "1"); } catch { /* storage blocked: it opens again next time */ }
  }, []);
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
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
