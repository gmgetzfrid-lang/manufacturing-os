"use client";

// CostCharts — the Cost Command Center's picture layer: the S-curve
// (planned vs committed vs spent over time), the forecast sentence in plain
// English, the crew-size curve from the awarded bid, and the EXAMPLE
// preview that shows all of it before the project has a single real number.
//
// Everything drawn here comes from the pure engines (lib/costSeries,
// lib/exampleProject) through the same components — example mode is the
// real UI with stand-in data, watermarked, never a mock screenshot.

import React, { useMemo } from "react";
import { LineChart as LineChartIcon, Users } from "lucide-react";
import { SCurveChart, ExampleFrame, BarList } from "@/components/ui/ChartKit";
import { MiniBars } from "@/components/dashboard/viz";
import { buildCostSeries, computeForecast, plannedManpowerSeries, type DatedAmount } from "@/lib/costSeries";
import { buildExampleCostData } from "@/lib/exampleProject";
import { computeBidEconomics } from "@/lib/bidTab";
import { fmtMoney, type CostEntry, type ProjectCostRollup } from "@/lib/costs";

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

export default function CostCharts({ rollup, entries, scheduleStart, scheduleEnd, awardedLaborHours }: {
  rollup: ProjectCostRollup;
  entries: CostEntry[];
  /** Schedule span from the project's milestones (min/max planned dates). */
  scheduleStart: string | null;
  scheduleEnd: string | null;
  /** Labor hours from the awarded quote, when one exists — draws the crew curve. */
  awardedLaborHours: number | null;
}) {
  const cur = rollup.currencies[0] ?? "USD";
  const fmt = useMemo(() => (n: number) => fmtMoney(n, cur), [cur]);
  const todayIso = new Date().toISOString().slice(0, 10);

  const hasRealData = rollup.budget > 0 || entries.some((e) => e.status !== "void");

  const { series, forecast, manpower } = useMemo(() => {
    if (!hasRealData) return { series: [], forecast: null, manpower: [] };
    const { commitments, actuals } = entriesToDated(entries);
    const series = buildCostSeries({
      budget: rollup.budget, scheduleStart, scheduleEnd, commitments, actuals,
    });
    const forecast = computeForecast({
      budget: rollup.budget, spent: rollup.spent, cpi: rollup.cpi,
      scheduleStart, scheduleEnd, today: todayIso, fmt,
    });
    const manpower = awardedLaborHours && scheduleStart && scheduleEnd
      ? plannedManpowerSeries({ laborHours: awardedLaborHours, scheduleStart, scheduleEnd })
      : [];
    return { series, forecast, manpower };
  }, [hasRealData, entries, rollup.budget, rollup.spent, rollup.cpi, scheduleStart, scheduleEnd, awardedLaborHours, todayIso, fmt]);

  // ── Example preview: the same components, stand-in data, watermarked ──
  if (!hasRealData) {
    const ex = buildExampleCostData();
    const exSeries = buildCostSeries({
      budget: ex.budget, scheduleStart: ex.scheduleStart, scheduleEnd: ex.scheduleEnd,
      commitments: ex.commitments, actuals: ex.actuals,
    });
    const exForecast = computeForecast({
      budget: ex.budget, spent: ex.actuals.reduce((s, a) => s + a.amount, 0), cpi: ex.cpi,
      today: ex.today, fmt: (n) => fmtMoney(n, "USD"),
    });
    const exEcon = computeBidEconomics(ex.quotes);
    const exAward = exEcon.find((e) => e.vendorName === "Gulf Mechanical");
    const exManpower = exAward?.laborHours
      ? plannedManpowerSeries({ laborHours: exAward.laborHours, scheduleStart: ex.scheduleStart, scheduleEnd: ex.scheduleEnd })
      : [];
    return (
      <ExampleFrame note="No budget or entries yet — this is the picture a running job draws. Set a budget line below and it goes live.">
        <div className="space-y-4">
          <div>
            <SectionLabel icon={<LineChartIcon className="w-3.5 h-3.5" />} text="Spend curve — planned pace vs promised vs spent" />
            <SCurveChart points={exSeries} fmt={(n) => fmtMoney(n, "USD")} todayIso={ex.today} />
          </div>
          {exForecast?.sentence && <ForecastSentence sentence={exForecast.sentence} basis={exForecast.basis} />}
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <SectionLabel icon={<Users className="w-3.5 h-3.5" />} text="Planned crew size by week (from the awarded bid's hours)" />
              <MiniBars values={exManpower.map((w) => w.headcount)}
                labels={exManpower.map((w) => `${w.weekOf} · ${w.headcount} people`)} height={44} />
            </div>
            <div>
              <SectionLabel text="Burn by budget line" />
              <BarList fmt={(n) => fmtMoney(n, "USD")} items={ex.accounts.map((a) => ({
                label: `${a.code} ${a.name}`, value: a.spent,
                sublabel: `of ${fmtMoney(a.budget, "USD")} budget`,
                flag: a.spent > a.budget ? "over budget" : undefined,
              }))} />
            </div>
          </div>
        </div>
      </ExampleFrame>
    );
  }

  if (series.length < 2 && !forecast?.sentence) return null;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm space-y-3">
      {series.length >= 2 && (
        <div>
          <SectionLabel icon={<LineChartIcon className="w-3.5 h-3.5" />} text="Spend curve — planned pace vs promised vs spent" />
          <SCurveChart points={series} fmt={fmt} todayIso={todayIso} />
          {!scheduleStart && (
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              No schedule dates yet, so there&apos;s no planned-pace line — import or add milestones and it appears.
            </div>
          )}
        </div>
      )}
      {forecast?.sentence && <ForecastSentence sentence={forecast.sentence} basis={forecast.basis} />}
      {manpower.length > 0 && (
        <div>
          <SectionLabel icon={<Users className="w-3.5 h-3.5" />} text="Planned crew size by week (from the awarded bid's hours)" />
          <MiniBars values={manpower.map((w) => w.headcount)}
            labels={manpower.map((w) => `${w.weekOf} · ${w.headcount} people`)} height={44} />
        </div>
      )}
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

function ForecastSentence({ sentence, basis }: { sentence: string; basis: "cpi" | "run_rate" | "none" }) {
  const over = /over budget/.test(sentence);
  return (
    <div className={`rounded-xl border px-3 py-2.5 text-sm font-bold ${
      over ? "border-rose-500/40 bg-rose-500/[0.06] text-rose-800 dark:text-rose-300"
        : "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-800 dark:text-emerald-300"}`}>
      {sentence}
      <span className="ml-2 text-[10px] font-bold text-[var(--color-text-muted)]">
        {basis === "cpi" ? "Based on cost performance so far (CPI)." : "Based on the spending pace against the schedule."}
      </span>
    </div>
  );
}

// ── The glossary — jargon kept, but explained where everyone can see it ──

const TERMS: Array<{ term: string; plain: string }> = [
  { term: "Budget", plain: "What you plan to spend, split into budget lines (cost accounts)." },
  { term: "Commitment", plain: "Money you've promised — a signed PO or an awarded contract. Not spent yet, but spoken for." },
  { term: "Actual", plain: "Money that really left — an invoice or timesheet posted against a budget line." },
  { term: "Adjustment", plain: "A signed correction. Negative adjustments credit money back." },
  { term: "Earned value (EV)", plain: "Work done, priced at budget: a line pinned to a schedule task earns its budget × that task's % complete." },
  { term: "CPI", plain: "Cost Performance Index = earned value ÷ actual cost. 1.0 is on budget; 1.06 means you get $1.06 of work per $1 spent; below 1.0 you're over-running." },
  { term: "SPI", plain: "Schedule Performance Index — same idea for time. Below 1.0 means behind schedule." },
  { term: "S-curve", plain: "The spend-over-time chart. Planned pace (dashed), committed, and spent — healthy jobs track near the planned line." },
  { term: "EAC / forecast", plain: "Estimate At Completion — where the total lands if current performance continues (budget ÷ CPI)." },
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
          {TERMS.map((t) => (
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
