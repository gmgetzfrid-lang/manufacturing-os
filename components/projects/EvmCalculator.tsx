"use client";

// EvmCalculator — the interactive Earned Value Management calculator.
//
// "To see exactly how the core math of project controls functions, use the EVM
// calculator to measure schedule and cost health based on raw data inputs."
//
// Enter the four numbers every earned-value computation reduces to — BAC, PV,
// EV, AC — and every derived metric a controls manager reads falls out live:
// SV/CV, SPI/CPI, the three EAC methods, ETC, VAC and TCPI, each traffic-lit
// against the 1.0 line. A Change-Order Sandbox lets you model the impact of a
// proposed scope change BEFORE it touches the live baseline.
//
// Pure presentation over lib/evm.ts — no fetches, fully reusable. The project
// Controls dashboard seeds it from the live schedule; it also stands alone.

import React, { useState } from "react";
import {
  Calculator, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2,
  FlaskConical, ChevronDown, ChevronRight, Minus,
} from "lucide-react";
import {
  computeEvm, simulateChangeOrder, healthOfIndex, parseAmount,
  formatMoney, formatMoneyFull, type EvmInputs, type EvmHealth, type EvmResult,
} from "@/lib/evm";
import { Field, Input, Select } from "@/components/ui/Field";

interface Props {
  /** Seed values (e.g. from the live schedule). */
  initial?: Partial<EvmInputs>;
  currency?: string;
  /** Hide the outer card chrome when embedded in a larger dashboard. */
  embedded?: boolean;
}

const HEALTH_STYLES: Record<EvmHealth, { text: string; bg: string; border: string; label: string }> = {
  ahead:     { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", label: "Ahead" },
  on_track:  { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", label: "On track" },
  watch:     { text: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-200",   label: "Watch" },
  critical:  { text: "text-rose-700",    bg: "bg-rose-50",    border: "border-rose-200",    label: "Critical" },
  unknown:   { text: "text-[var(--color-text-muted)]", bg: "bg-[var(--color-surface-2)]", border: "border-[var(--color-border)]", label: "—" },
};

// Single shared money parser (preserves a legitimate 0) — see lib/evm.ts.
const num = parseAmount;

export default function EvmCalculator({ initial, currency = "USD", embedded }: Props) {
  const [bac, setBac] = useState<string>(initial?.bac != null ? String(Math.round(initial.bac)) : "");
  const [pv, setPv] = useState<string>(initial?.pv != null ? String(Math.round(initial.pv)) : "");
  const [ev, setEv] = useState<string>(initial?.ev != null ? String(Math.round(initial.ev)) : "");
  const [ac, setAc] = useState<string>(initial?.ac != null ? String(Math.round(initial.ac)) : "");
  const [cur, setCur] = useState<string>(currency);

  const inputs: EvmInputs = {
    bac: num(bac) ?? 0,
    pv: num(pv) ?? 0,
    ev: num(ev) ?? 0,
    ac: num(ac),
  };
  // No manual memo — the React Compiler memoizes this pure call on the inputs.
  const r = computeEvm(inputs);

  const eacHeadline = r.eacCpi ?? r.eacBudgetRate;
  const ready = inputs.bac > 0 && (inputs.pv > 0 || inputs.ev > 0);

  return (
    <div className={embedded ? "" : "bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden"}>
      {!embedded && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2">
          <Calculator className="w-4 h-4 text-[var(--color-accent)]" />
          <div className="font-bold text-sm text-[var(--color-text)]">Earned Value (EVM) Calculator</div>
          <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">raw inputs → schedule &amp; cost health</span>
        </div>
      )}

      <div className="p-4 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* ── Inputs ── */}
        <div className="space-y-3">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Raw inputs</div>
          <Field label="BAC — Budget at Completion" hint="Total approved budget.">
            <Input inputMode="decimal" value={bac} onChange={(e) => setBac(e.target.value)} placeholder="e.g. 100000" className="font-mono" />
          </Field>
          <Field label="PV — Planned Value (BCWS)" hint="Budgeted cost of work scheduled by now.">
            <Input inputMode="decimal" value={pv} onChange={(e) => setPv(e.target.value)} placeholder="e.g. 40000" className="font-mono" />
          </Field>
          <Field label="EV — Earned Value (BCWP)" hint="Budgeted cost of work actually performed.">
            <Input inputMode="decimal" value={ev} onChange={(e) => setEv(e.target.value)} placeholder="e.g. 30000" className="font-mono" />
          </Field>
          <Field label="AC — Actual Cost (ACWP)" hint="What that performed work actually cost. Leave blank if not yet known — cost indices stay undefined rather than faked.">
            <Input inputMode="decimal" value={ac} onChange={(e) => setAc(e.target.value)} placeholder="e.g. 35000" className="font-mono" />
          </Field>
          <Field label="Currency">
            <Select value={cur} onChange={(e) => setCur(e.target.value)}>
              {["USD", "CAD", "EUR", "GBP", "AUD", "MXN", "INR", "JPY"].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>

        {/* ── Results ── */}
        <div className="space-y-3">
          {!ready ? (
            <div className="h-full min-h-40 rounded-xl border border-dashed border-[var(--color-border-strong)] flex items-center justify-center text-center p-6">
              <div className="text-sm text-[var(--color-text-muted)]">
                Enter a budget (BAC) and at least one of PV / EV to compute the earned-value picture.
              </div>
            </div>
          ) : (
            <>
              {/* Alert banner — the "tell management instantly" trigger. */}
              {r.alert ? (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="text-xs font-bold">
                    Performance below target.
                    <span className="font-medium">
                      {" "}
                      {r.spi != null && r.spi < 1 && `Schedule (SPI ${r.spi.toFixed(2)}) is behind plan. `}
                      {r.cpi != null && r.cpi < 1 && `Cost (CPI ${r.cpi.toFixed(2)}) is over budget. `}
                      {eacHeadline != null
                        ? `Forecast finish cost ${formatMoneyFull(eacHeadline, cur)} vs ${formatMoneyFull(r.bac, cur)} budget.`
                        : `Enter an actual cost (AC) to forecast cost at completion.`}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <div className="text-xs font-bold">On or ahead of plan on every computed index.</div>
                </div>
              )}

              {/* Headline indices */}
              <div className="grid grid-cols-2 gap-2">
                <IndexGauge label="SPI" sub="Schedule" value={r.spi} />
                <IndexGauge label="CPI" sub="Cost" value={r.cpi} />
              </div>

              {/* Variances */}
              <div className="grid grid-cols-2 gap-2">
                <MoneyTile label="SV — Schedule Variance" value={r.sv} currency={cur} good={(r.sv) >= 0} hint="EV − PV" />
                <MoneyTile label="CV — Cost Variance" value={r.cv} currency={cur} good={(r.cv ?? 0) >= 0} hint="EV − AC" />
              </div>

              {/* Forecast at completion */}
              <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                <div className="px-3 py-1.5 bg-[var(--color-surface-2)] text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">
                  Forecast at completion
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-[var(--color-border)]">
                  <Stat label="EAC" value={formatMoney(eacHeadline, cur)} title="Estimate at Completion (CPI method)" />
                  <Stat label="ETC" value={formatMoney(r.etc, cur)} title="Estimate to Complete = EAC − AC" />
                  <Stat label="VAC" value={formatMoney(r.vac, cur)} title="Variance at Completion = BAC − EAC" tone={r.vac == null ? undefined : r.vac >= 0 ? "good" : "bad"} />
                  <Stat label="BAC" value={formatMoney(r.bac, cur)} title="Budget at Completion" />
                </div>
              </div>

              {/* EAC methods + TCPI — the breakdown that shows the math */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="rounded-xl border border-[var(--color-border)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">EAC methods</div>
                  <Row k="BAC ÷ CPI (efficiency holds)" v={formatMoney(r.eacCpi, cur)} />
                  <Row k="AC + (BAC − EV) (one-off overrun)" v={formatMoney(r.eacBudgetRate, cur)} />
                  <Row k="AC + (BAC − EV)/(CPI×SPI) (both drag)" v={formatMoney(r.eacComposite, cur)} />
                </div>
                <div className="rounded-xl border border-[var(--color-border)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">To-Complete Performance Index</div>
                  <Row k="TCPI to hit BAC" v={r.tcpiBac != null ? r.tcpiBac.toFixed(2) : "—"} warn={r.tcpiBac != null && r.tcpiBac > 1.0} />
                  <Row k="TCPI to hit EAC" v={r.tcpiEac != null ? r.tcpiEac.toFixed(2) : "—"} warn={r.tcpiEac != null && r.tcpiEac > 1.0} />
                  <div className="text-[10px] text-[var(--color-text-faint)] mt-1.5 leading-snug">
                    &gt; 1.00 means you must outperform from here on to make the number — the higher above 1.0, the less realistic.
                  </div>
                </div>
              </div>

              {/* Progress bars: complete vs scheduled vs spent */}
              <ProgressTriplet result={r} />
            </>
          )}
        </div>
      </div>

      {ready && <ChangeOrderSandbox base={inputs} currency={cur} />}
    </div>
  );
}

// ─── Change-Order Sandbox ────────────────────────────────────────

function ChangeOrderSandbox({ base, currency }: { base: EvmInputs; currency: string }) {
  const [open, setOpen] = useState(false);
  const [addedBudget, setAddedBudget] = useState("");
  const [addedActual, setAddedActual] = useState("");
  const [days, setDays] = useState("");

  const impact = simulateChangeOrder(base, {
    addedBudget: num(addedBudget) ?? 0,
    addedActualCost: num(addedActual) ?? 0,
    scheduleDays: num(days) ?? 0,
  });
  const hasChange = (num(addedBudget) ?? 0) !== 0 || (num(addedActual) ?? 0) !== 0 || (num(days) ?? 0) !== 0;

  return (
    <div className="border-t border-[var(--color-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <FlaskConical className="w-3.5 h-3.5 text-[var(--color-accent)]" />
        Change-Order Sandbox
        <span className="font-normal text-[var(--color-text-muted)]">— model a scope change before it hits the baseline</span>
      </button>

      {open && (
        <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
          <div className="space-y-3">
            <Field label="Added budget (ΔBAC)" hint="Cost of the new scope. Negative = de-scope / credit.">
              <Input inputMode="decimal" value={addedBudget} onChange={(e) => setAddedBudget(e.target.value)} placeholder="e.g. 20000" className="font-mono" />
            </Field>
            <Field label="Added actual cost already spent" hint="Usually 0 for a brand-new change order.">
              <Input inputMode="decimal" value={addedActual} onChange={(e) => setAddedActual(e.target.value)} placeholder="0" className="font-mono" />
            </Field>
            <Field label="Schedule impact (days)" hint="Days the change pushes the finish. Negative pulls it in.">
              <Input inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 14" className="font-mono" />
            </Field>
          </div>

          <div className="space-y-2">
            {!hasChange ? (
              <div className="h-full min-h-32 rounded-xl border border-dashed border-[var(--color-border-strong)] flex items-center justify-center text-center p-4 text-sm text-[var(--color-text-muted)]">
                Enter a proposed change to see its impact on budget, forecast and finish.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <BeforeAfter label="BAC" before={formatMoney(impact.before.bac, currency)} after={formatMoney(impact.after.bac, currency)} />
                  <BeforeAfter label="EAC" before={formatMoney(impact.before.eacCpi ?? impact.before.eacBudgetRate, currency)} after={formatMoney(impact.after.eacCpi ?? impact.after.eacBudgetRate, currency)} />
                  <BeforeAfter label="CPI" before={impact.before.cpi?.toFixed(2) ?? "—"} after={impact.after.cpi?.toFixed(2) ?? "—"} />
                </div>
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-text)] flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-bold">Impact:</span>
                  <span className={impact.deltaBac >= 0 ? "text-rose-700" : "text-emerald-700"}>
                    {impact.deltaBac >= 0 ? "+" : ""}{formatMoneyFull(impact.deltaBac, currency)} budget
                  </span>
                  {impact.deltaEac != null && (
                    <span className={impact.deltaEac >= 0 ? "text-rose-700" : "text-emerald-700"}>
                      {impact.deltaEac >= 0 ? "+" : ""}{formatMoneyFull(impact.deltaEac, currency)} forecast cost
                    </span>
                  )}
                  {impact.scheduleDays !== 0 && (
                    <span className={impact.scheduleDays > 0 ? "text-rose-700" : "text-emerald-700"}>
                      {impact.scheduleDays > 0 ? "+" : ""}{impact.scheduleDays}d finish
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[var(--color-text-faint)] italic">
                  Simulation only — nothing here changes the live schedule or baseline.
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small presentation pieces ───────────────────────────────────

function IndexGauge({ label, sub, value }: { label: string; sub: string; value: number | null }) {
  const h = healthOfIndex(value);
  const s = HEALTH_STYLES[h];
  return (
    <div className={`rounded-xl border ${s.border} ${s.bg} p-3`}>
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
        <div className="text-[10px] font-bold text-[var(--color-text-muted)]">{sub}</div>
      </div>
      <div className={`text-3xl font-black leading-none mt-1 ${s.text}`}>
        {value != null ? value.toFixed(2) : "—"}
      </div>
      <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${s.text}`}>
        {value == null ? <><Minus className="w-3 h-3" /> needs actuals</>
          : value >= 1 ? <><TrendingUp className="w-3 h-3" /> {s.label}</>
          : <><TrendingDown className="w-3 h-3" /> {s.label}</>}
      </div>
    </div>
  );
}

function MoneyTile({ label, value, currency, good, hint }: { label: string; value: number | null; currency: string; good: boolean; hint: string }) {
  const tone = value == null ? "text-[var(--color-text-muted)]" : good ? "text-emerald-700" : "text-rose-700";
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]" title={hint}>{label}</div>
      <div className={`text-xl font-black mt-1 ${tone}`}>
        {value == null ? "—" : `${value >= 0 ? "+" : ""}${formatMoneyFull(value, currency)}`}
      </div>
    </div>
  );
}

function Stat({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: "good" | "bad" }) {
  const t = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-[var(--color-text)]";
  return (
    <div className="px-3 py-2" title={title}>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className={`text-sm font-black mt-0.5 ${t}`}>{value}</div>
    </div>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-[11px] text-[var(--color-text-muted)] truncate">{k}</span>
      <span className={`text-xs font-black font-mono tabular-nums ${warn ? "text-amber-700" : "text-[var(--color-text)]"}`}>{v}</span>
    </div>
  );
}

function BeforeAfter({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-2.5 text-center">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 flex items-center justify-center gap-1 text-xs">
        <span className="text-[var(--color-text-muted)] line-through decoration-[var(--color-text-faint)]">{before}</span>
        <ChevronRight className="w-3 h-3 text-[var(--color-text-faint)]" />
        <span className="font-black text-[var(--color-text)]">{after}</span>
      </div>
    </div>
  );
}

function ProgressTriplet({ result }: { result: EvmResult }) {
  const rows: Array<{ label: string; pct: number | null; bar: string }> = [
    { label: "% complete (EV/BAC)", pct: result.percentComplete, bar: "bg-emerald-500" },
    { label: "% scheduled (PV/BAC)", pct: result.percentScheduled, bar: "bg-blue-400" },
    { label: "% spent (AC/BAC)", pct: result.percentSpent, bar: "bg-amber-500" },
  ];
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-2">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-baseline justify-between text-[11px] mb-1">
            <span className="text-[var(--color-text-muted)]">{row.label}</span>
            <span className="font-black tabular-nums text-[var(--color-text)]">{row.pct == null ? "—" : `${Math.round(row.pct * 100)}%`}</span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className={`h-full ${row.bar} transition-all`} style={{ width: `${Math.min(100, Math.max(0, (row.pct ?? 0) * 100))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
