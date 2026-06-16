"use client";

// ProjectControlsTab — the ISO 21502 / ASME project-controls cockpit.
//
// This is where the schedule, the cost model and the baseline come together
// into the numbers a controls manager reports up: a real-time variance engine
// (CPI/SPI computed live off the schedule, alerting the instant either drops
// below 1.0), integrated baseline drift, the critical-path drivers, and an
// auto-generated weekly KPI health report — "brutal, honest", hard KPIs, not
// subjective updates.
//
// The cost dimension comes from a small editable cost model (blended labor rate
// → BAC/PV/EV, plus actual-cost-to-date → CPI). Persisted on the project via
// lib/projectControls.ts, with a graceful local-only fallback pre-migration.
//
// Heavy lifting is delegated to the pure, tested libs:
//   lib/evm.ts              — the earned-value math + schedule derivation
//   lib/executionReport.ts  — baseline drift, pace, blockers
//   lib/criticalPath.ts     — the finish-driving chain

import React, { useCallback, useEffect, useState } from "react";
import {
  Gauge, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown, DollarSign,
  Flag, Loader2, Save, Activity, ClipboardCheck, Copy, Check,
  CalendarClock, Zap, Info,
} from "lucide-react";
import { listMilestones } from "@/lib/milestones";
import { computeExecutionReport } from "@/lib/executionReport";
import { computeCriticalPathLite } from "@/lib/criticalPath";
import {
  deriveEvmFromSchedule, formatMoney, formatMoneyFull, healthOfIndex, parseAmount,
  type CostModel, type EvmHealth,
} from "@/lib/evm";
import { loadControlsConfig, saveControlsConfig } from "@/lib/projectControls";
import type { Milestone, Project, ProjectControlsConfig } from "@/types/schema";
import { Field, Input, Select } from "@/components/ui/Field";
import EvmCalculator from "@/components/projects/EvmCalculator";
import Spinner from "@/components/ui/Spinner";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { appAlert } from "@/components/providers/DialogProvider";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);

const HEALTH: Record<EvmHealth, { text: string; bg: string; border: string; dot: string; label: string }> = {
  ahead:    { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", dot: "bg-emerald-500", label: "Ahead" },
  on_track: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", dot: "bg-emerald-500", label: "On track" },
  watch:    { text: "text-amber-700",   bg: "bg-amber-50",   border: "border-amber-200",   dot: "bg-amber-500",   label: "Watch" },
  critical: { text: "text-rose-700",    bg: "bg-rose-50",    border: "border-rose-200",    dot: "bg-rose-500",    label: "Critical" },
  unknown:  { text: "text-[var(--color-text-muted)]", bg: "bg-[var(--color-surface-2)]", border: "border-[var(--color-border)]", dot: "bg-slate-400", label: "No data" },
};

interface Props {
  project: Project;
  userId: string;
  userEmail?: string;
  userRole?: string;
  /** Called after the cost model is persisted server-side so the parent can
   *  refresh its Project in place — keeps a tab remount from re-reading a
   *  one-edit-stale prop. */
  onConfigPersisted?: (cfg: ProjectControlsConfig) => void;
}

export default function ProjectControlsTab({ project, userId, userEmail, userRole, onConfigPersisted }: Props) {
  const canEdit = !!userRole && ADMIN_ROLES.has(userRole);

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The effective cost model + where it came from (server / local / none).
  // Lazy initializers so localStorage is read once, not every render.
  const [config, setConfig] = useState<ProjectControlsConfig>(() => loadControlsConfig(project).config);
  const [source, setSource] = useState<"server" | "local" | "none">(() => loadControlsConfig(project).source);

  const refresh = useCallback(async () => {
    try {
      const list = await listMilestones({ orgId: project.orgId, projectId: project.id!, includeGhost: true });
      setMilestones(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [project.orgId, project.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const currency = config.currency || "USD";
  const costModel: CostModel = {
    blendedRate: config.blendedRate ?? 0,
    budgetOverride: config.budgetOverride ?? null,
    actualCost: config.actualCost ?? null,
    currency,
  };

  // Pure derivations — the React Compiler memoizes these on their inputs, so
  // no manual useMemo (which the compiler's lint rejects when deps don't match).
  const evm = deriveEvmFromSchedule(milestones, costModel);
  const report = computeExecutionReport(milestones);
  const critical = computeCriticalPathLite(milestones);
  const ms = (m: Milestone) => Date.parse(m.plannedAt as string) || 0; // NaN-safe ordering
  const criticalLeaves = milestones
    .filter((m) => m.id && critical.ids.has(m.id))
    .sort((a, b) => ms(a) - ms(b));

  const r = evm.result;
  const hasSchedule = milestones.length > 0;
  const hasRate = (config.blendedRate ?? 0) > 0;
  const eacHeadline = r.eacCpi ?? r.eacBudgetRate;

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Spinner /></div>;
  }

  if (!hasSchedule) {
    return (
      <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-10 text-center">
        <Gauge className="w-10 h-10 mx-auto text-slate-300 mb-3" />
        <p className="text-sm font-bold text-[var(--color-text)]">No schedule to control yet</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
          Build or import the schedule on the <b>Schedule</b> tab first. Once tasks carry work-hours, this cockpit lights up
          the full earned-value picture — CPI, SPI, EAC and a weekly health report. Until then, the EVM calculator below works
          standalone.
        </p>
        <div className="mt-6 max-w-3xl mx-auto text-left">
          <EvmCalculator currency={currency} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {/* ── Real-time variance engine: the alert band ── */}
      {hasRate && r.alert && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-start gap-3">
          <div className="p-1.5 bg-rose-100 rounded-lg shrink-0"><AlertTriangle className="w-4 h-4 text-rose-700" /></div>
          <div className="text-sm text-rose-900">
            <span className="font-black">Variance alert.</span>{" "}
            {r.spi != null && r.spi < 1 && <>Schedule is behind (<b>SPI {r.spi.toFixed(2)}</b>). </>}
            {r.cpi != null && r.cpi < 1 && <>Cost is over budget (<b>CPI {r.cpi.toFixed(2)}</b>). </>}
            {evm.hasActualCost
              ? <>Forecast cost at completion <b>{formatMoneyFull(eacHeadline, currency)}</b> against a <b>{formatMoneyFull(r.bac, currency)}</b> budget
                  {r.vac != null && r.vac < 0 && <> — a projected <b>{formatMoneyFull(Math.abs(r.vac), currency)}</b> overrun</>}.</>
              : <>Log an actual-cost-to-date below to forecast the cost overrun.</>}
          </div>
        </div>
      )}

      {/* ── KPI band ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <IndexKpi label="SPI" caption="Schedule" value={r.spi} />
        <IndexKpi label="CPI" caption="Cost" value={evm.hasActualCost ? r.cpi : null} hint={evm.hasActualCost ? undefined : "Set actual cost"} />
        <Kpi label="% Complete" value={`${Math.round(r.percentComplete * 100)}%`} caption={`planned ${Math.round(r.percentScheduled * 100)}%`} tone={r.percentComplete >= r.percentScheduled ? "good" : "bad"} />
        <Kpi label="SV" value={formatMoney(r.sv, currency)} caption="schedule variance" tone={r.sv >= 0 ? "good" : "bad"} />
        <Kpi label="CV" value={formatMoney(r.cv, currency)} caption="cost variance" tone={r.cv == null ? "muted" : r.cv >= 0 ? "good" : "bad"} />
        <Kpi label="EAC" value={formatMoney(eacHeadline, currency)} caption={r.vac != null ? `VAC ${formatMoney(r.vac, currency)}` : "forecast cost"} tone={r.vac == null ? "muted" : r.vac >= 0 ? "good" : "bad"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Left: cost model + schedule health ── */}
        <div className="space-y-4">
          <CostModelCard
            project={project}
            config={config}
            source={source}
            canEdit={canEdit}
            derivedBac={evm.totalHours * (config.blendedRate ?? 0)}
            totalHours={evm.totalHours}
            costedLeaves={evm.costedLeaves}
            uncostedLeaves={evm.uncostedLeaves}
            currency={currency}
            onSaved={(cfg, src) => { setConfig(cfg); setSource(src); if (src === "server") onConfigPersisted?.(cfg); }}
            userId={userId} userEmail={userEmail} userRole={userRole}
          />

          {/* Baseline / drift — integrated baseline management */}
          <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3">
              <Flag className="w-4 h-4 text-[var(--color-accent)]" />
              <div className="font-bold text-sm text-[var(--color-text)]">Baseline &amp; drift</div>
              <HelpTooltip>The approved-plan snapshot. Set or re-capture it on the Schedule tab. Drift is the current finish vs that snapshot.</HelpTooltip>
            </div>
            {report.baseline ? (
              <div className="space-y-2">
                <BigDrift days={report.baseline.finishDriftDays} />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <MiniStat label="Tasks slipped" value={String(report.baseline.slipped)} tone={report.baseline.slipped > 0 ? "bad" : "good"} />
                  <MiniStat label="Pulled in" value={String(report.baseline.pulledIn)} tone="good" />
                  <MiniStat label="Baseline finish" value={fmtDate(report.baseline.baselineFinish)} />
                  <MiniStat label="Current finish" value={fmtDate(report.baseline.currentFinish)} />
                </div>
                {report.baseline.worstSlips.length > 0 && (
                  <div className="mt-1 pt-2 border-t border-[var(--color-border)]">
                    <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1">Worst slips</div>
                    {report.baseline.worstSlips.slice(0, 3).map((s) => (
                      <div key={s.id} className="flex items-baseline justify-between gap-2 py-0.5">
                        <span className="text-xs text-[var(--color-text)] truncate">{s.name}</span>
                        <span className="text-xs font-black text-rose-700 shrink-0">+{s.days}d</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">
                No baseline captured. Use <b>Set baseline</b> on the Schedule tab to lock the approved plan — then drift becomes measurable and this card lights up.
              </div>
            )}
          </div>
        </div>

        {/* ── Middle: critical path ── */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-amber-500" />
            <div className="font-bold text-sm text-[var(--color-text)]">Critical path drivers</div>
            <HelpTooltip>The unfinished tasks that gate the finish date. Slip one of these and the whole job slips. Heuristic from the schedule&rsquo;s shape (labelled as such).</HelpTooltip>
          </div>
          {criticalLeaves.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)]">
              Nothing is currently driving the finish — either everything&rsquo;s complete, or the schedule has no unfinished leaf tasks.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-2 text-xs">
                <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"><CalendarClock className="w-3.5 h-3.5" /> Finish {fmtDate(critical.finish)}</span>
                {critical.remainingHours > 0 && <span className="font-mono text-[var(--color-text-muted)]">{Math.round(critical.remainingHours)}h remaining on chain</span>}
              </div>
              <div className="space-y-1.5 max-h-80 overflow-auto pr-1">
                {criticalLeaves.map((m) => (
                  <div key={m.id} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-2.5 py-1.5">
                    <Flag className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-[var(--color-text)] truncate">{m.name}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-2">
                        <span>{fmtDate(m.plannedAt as string)}</span>
                        {typeof m.durationHours === "number" && m.durationHours > 0 && <span className="font-mono">· {m.durationHours}h</span>}
                        <span className="uppercase tracking-wider font-bold">{m.status.replace("_", " ")}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="mt-3 pt-3 border-t border-[var(--color-border)] grid grid-cols-3 gap-2">
            <MiniStat label="Pace" value={`${report.paceDelta >= 0 ? "+" : ""}${report.paceDelta}%`} tone={report.paceDelta >= 0 ? "good" : "bad"} />
            <MiniStat label="Overdue" value={String(report.overdue)} tone={report.overdue > 0 ? "bad" : "good"} />
            <MiniStat label="Blocked" value={String(report.blockers.length)} tone={report.blockers.length > 0 ? "bad" : "good"} />
          </div>
        </div>

        {/* ── Right: weekly health report ── */}
        <WeeklyReportCard
          project={project}
          evm={evm}
          report={report}
          critical={critical}
          currency={currency}
          hasRate={hasRate}
        />
      </div>

      {/* ── EVM calculator, seeded from the live numbers ── */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--color-accent)]" />
          <div className="font-bold text-sm text-[var(--color-text)]">Earned Value (EVM) calculator</div>
          <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">
            {hasRate ? "seeded from this project — adjust any input to model a scenario" : "set a blended rate to seed from the schedule"}
          </span>
        </div>
        <EvmCalculator
          embedded
          currency={currency}
          initial={hasRate ? { bac: r.bac, pv: r.pv, ev: r.ev, ac: r.ac } : undefined}
        />
      </div>
    </div>
  );
}

// ─── Cost model editor ───────────────────────────────────────────

function CostModelCard({
  project, config, source, canEdit, derivedBac, totalHours, costedLeaves, uncostedLeaves, currency, onSaved,
  userId, userEmail, userRole,
}: {
  project: Project;
  config: ProjectControlsConfig;
  source: "server" | "local" | "none";
  canEdit: boolean;
  derivedBac: number;
  totalHours: number;
  costedLeaves: number;
  uncostedLeaves: number;
  currency: string;
  onSaved: (cfg: ProjectControlsConfig, source: "server" | "local") => void;
  userId: string; userEmail?: string; userRole?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(config.blendedRate != null ? String(config.blendedRate) : "");
  const [budget, setBudget] = useState(config.budgetOverride != null ? String(config.budgetOverride) : "");
  const [actual, setActual] = useState(config.actualCost != null ? String(config.actualCost) : "");
  const [contingency, setContingency] = useState(config.contingency != null ? String(config.contingency) : "");
  const [cur, setCur] = useState(config.currency || "USD");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      // parseAmount preserves a legitimate 0 (e.g. AC = 0 = "nothing spent yet"),
      // unlike `Number(x) || null` which would drop it.
      const next: ProjectControlsConfig = {
        blendedRate: parseAmount(rate),
        budgetOverride: parseAmount(budget),
        actualCost: parseAmount(actual),
        contingency: parseAmount(contingency),
        currency: cur,
      };
      const res = await saveControlsConfig({
        projectId: project.id!, orgId: project.orgId, config: next,
        actorUserId: userId, actorEmail: userEmail, actorRole: userRole,
      });
      onSaved(res.config, res.persisted ? "server" : "local");
      setEditing(false);
    } catch (e) {
      await appAlert({ message: (e as Error).message, tone: "danger" });
    } finally { setBusy(false); }
  };

  const bac = config.budgetOverride ?? derivedBac;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="w-4 h-4 text-emerald-600" />
        <div className="font-bold text-sm text-[var(--color-text)]">Cost model</div>
        {source === "local" && (
          <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded" title="Saved to this browser only — the controls_config migration hasn't run on this environment yet.">
            local only
          </span>
        )}
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} className="ml-auto text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
            {source === "none" ? "Set up" : "Edit"}
          </button>
        )}
      </div>

      {!editing ? (
        <div className="space-y-2">
          {(config.blendedRate ?? 0) > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <MiniStat label="BAC" value={formatMoney(bac, currency)} big />
                <MiniStat label="Blended rate" value={`${formatMoneyFull(config.blendedRate ?? 0, currency)}/h`} big />
                <MiniStat label="Actual cost" value={config.actualCost != null ? formatMoney(config.actualCost, currency) : "—"} />
                <MiniStat label="Contingency" value={config.contingency != null ? formatMoney(config.contingency, currency) : "—"} />
              </div>
              <div className="text-[10px] text-[var(--color-text-faint)] leading-snug pt-1">
                BAC {config.budgetOverride != null ? "pinned manually" : `from ${Math.round(totalHours)}h × rate`}
                {uncostedLeaves > 0 && <> · {uncostedLeaves} task{uncostedLeaves === 1 ? "" : "s"} without hours excluded from cost ({costedLeaves} costed)</>}
              </div>
            </>
          ) : (
            <div className="text-xs text-[var(--color-text-muted)]">
              <Info className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
              Set a <b>blended labor rate</b> to turn the schedule&rsquo;s {Math.round(totalHours)} work-hours into a budget and unlock CPI/EAC.
              {!canEdit && " Ask a project manager to configure it."}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <Field label={`Blended rate (${cur}/hour)`} hint="All-in labor rate. Converts work-hours → cost.">
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 175" className="font-mono" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Budget override (BAC)" hint="Optional. Else hours×rate.">
              <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="auto" className="font-mono" />
            </Field>
            <Field label="Currency">
              <Select value={cur} onChange={(e) => setCur(e.target.value)}>
                {["USD", "CAD", "EUR", "GBP", "AUD", "MXN", "INR", "JPY"].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Actual cost to date (AC)" hint="Enables CPI / CV / EAC.">
              <Input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="ACWP" className="font-mono" />
            </Field>
            <Field label="Contingency reserve" hint="Held against the budget.">
              <Input inputMode="decimal" value={contingency} onChange={(e) => setContingency(e.target.value)} placeholder="optional" className="font-mono" />
            </Field>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={() => setEditing(false)} disabled={busy} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1">Cancel</button>
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Weekly health report ────────────────────────────────────────

function WeeklyReportCard({
  project, evm, report, critical, currency, hasRate,
}: {
  project: Project;
  evm: ReturnType<typeof deriveEvmFromSchedule>;
  report: ReturnType<typeof computeExecutionReport>;
  critical: ReturnType<typeof computeCriticalPathLite>;
  currency: string;
  hasRate: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const text = buildReportText(project, evm, report, critical, currency, hasRate);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the text is on screen to copy manually */ }
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <ClipboardCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="font-bold text-sm text-[var(--color-text)]">Weekly health report</div>
        <button onClick={copy} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
          {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </button>
      </div>
      <pre className="flex-1 text-[11px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap font-sans bg-[var(--color-surface-2)] rounded-xl p-3 overflow-auto max-h-[28rem]">
        {text}
      </pre>
      <div className="text-[10px] text-[var(--color-text-faint)] italic mt-2">Auto-generated from live schedule + cost data. Hard KPIs, not subjective status.</div>
    </div>
  );
}

/** Pure-ish string assembly of the "brutal, honest" report. Numbers all come
 *  from the tested libs; this just narrates them. */
function buildReportText(
  project: Project,
  evm: ReturnType<typeof deriveEvmFromSchedule>,
  report: ReturnType<typeof computeExecutionReport>,
  critical: ReturnType<typeof computeCriticalPathLite>,
  currency: string,
  hasRate: boolean,
): string {
  const r = evm.result;
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const pc = (n: number | null) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  const idx = (n: number | null) => (n == null ? "n/a" : n.toFixed(2));
  const m = (n: number | null) => formatMoneyFull(n, currency);

  const verdict =
    !hasRate ? "COST NOT MODELLED — set a blended rate to enable cost KPIs."
      : r.alert ? "OFF TARGET — corrective action required."
      : "ON TARGET.";

  const lines: string[] = [];
  lines.push(`PROJECT CONTROLS — WEEKLY HEALTH REPORT`);
  lines.push(`${project.name}`);
  lines.push(`As of ${today}`);
  lines.push(`Verdict: ${verdict}`);
  lines.push("");
  lines.push(`SCHEDULE`);
  lines.push(`  Physical % complete : ${Math.round(report.pctComplete)}%  (expected ${Math.round(report.expectedPct)}% by now)`);
  lines.push(`  Pace vs plan        : ${report.paceDelta >= 0 ? "+" : ""}${report.paceDelta}%  ${report.paceDelta >= 0 ? "(ahead)" : "(behind)"}`);
  lines.push(`  SPI                 : ${idx(r.spi)}  ${r.spi != null && r.spi < 1 ? "BEHIND" : "on/ahead"}`);
  lines.push(`  Overdue tasks       : ${report.overdue}`);
  lines.push(`  Blocked / on-hold   : ${report.blockers.length}`);
  if (report.finish) lines.push(`  Projected finish    : ${fmtDate(report.forecastFinish ?? report.finish)}`);
  if (report.baseline) {
    const d = report.baseline.finishDriftDays;
    lines.push(`  Baseline drift      : ${d > 0 ? "+" : ""}${d}d vs approved plan  (${report.baseline.slipped} slipped, ${report.baseline.pulledIn} pulled in)`);
  } else {
    lines.push(`  Baseline drift      : no baseline captured`);
  }
  lines.push("");
  lines.push(`COST`);
  if (hasRate) {
    lines.push(`  BAC                 : ${m(r.bac)}`);
    lines.push(`  Earned value (EV)   : ${m(r.ev)}   (${pc(r.percentComplete)} of BAC)`);
    lines.push(`  Planned value (PV)  : ${m(r.pv)}   (${pc(r.percentScheduled)} of BAC)`);
    lines.push(`  Actual cost (AC)    : ${evm.hasActualCost ? m(r.ac) : "not logged"}`);
    lines.push(`  Schedule variance   : ${m(r.sv)}`);
    lines.push(`  Cost variance       : ${r.cv == null ? "n/a (no AC)" : m(r.cv)}`);
    lines.push(`  CPI                 : ${idx(r.cpi)}  ${r.cpi != null && r.cpi < 1 ? "OVER BUDGET" : r.cpi == null ? "" : "on/under"}`);
    lines.push(`  Forecast EAC        : ${m(r.eacCpi ?? r.eacBudgetRate)}`);
    lines.push(`  Variance at compl.  : ${r.vac == null ? "n/a" : m(r.vac)}  ${r.vac != null && r.vac < 0 ? "(OVERRUN)" : ""}`);
    lines.push(`  To-complete (TCPI)  : ${idx(r.tcpiBac)} to still hit BAC`);
  } else {
    lines.push(`  No cost model — set a blended labor rate on the Controls tab.`);
  }
  lines.push("");
  lines.push(`CRITICAL PATH (heuristic)`);
  if (critical.ids.size === 0) {
    lines.push(`  No unfinished driver tasks.`);
  } else {
    lines.push(`  ${critical.ids.size} driver task(s), ${Math.round(critical.remainingHours)}h remaining, gating finish ${fmtDate(critical.finish)}.`);
  }
  if (report.blockers.length > 0) {
    lines.push("");
    lines.push(`OPEN BLOCKERS`);
    for (const b of report.blockers.slice(0, 8)) {
      lines.push(`  - [${b.status}] ${b.name}${b.reason ? ` — ${b.reason}` : ""}`);
    }
  }
  return lines.join("\n");
}

// ─── Small bits ──────────────────────────────────────────────────

function IndexKpi({ label, caption, value, hint }: { label: string; caption: string; value: number | null; hint?: string }) {
  const h = healthOfIndex(value);
  const s = HEALTH[h];
  return (
    <div className={`rounded-xl border ${s.border} ${s.bg} p-3`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
        <div className={`w-2 h-2 rounded-full ${s.dot}`} />
      </div>
      <div className={`text-2xl font-black leading-none mt-1 ${s.text}`}>{value != null ? value.toFixed(2) : "—"}</div>
      <div className={`text-[10px] mt-1 inline-flex items-center gap-1 ${value == null ? "text-[var(--color-text-muted)]" : s.text}`}>
        {value == null ? (hint ?? caption) : value >= 1 ? <><TrendingUp className="w-2.5 h-2.5" /> {caption}</> : <><TrendingDown className="w-2.5 h-2.5" /> {caption}</>}
      </div>
    </div>
  );
}

function Kpi({ label, value, caption, tone }: { label: string; value: string; caption: string; tone: "good" | "bad" | "muted" }) {
  const t = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-[var(--color-text)]";
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className={`text-2xl font-black leading-none mt-1 ${t}`}>{value}</div>
      <div className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate">{caption}</div>
    </div>
  );
}

function MiniStat({ label, value, tone, big }: { label: string; value: string; tone?: "good" | "bad"; big?: boolean }) {
  const t = tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg bg-[var(--color-surface-2)] px-2.5 py-1.5">
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{label}</div>
      <div className={`${big ? "text-base" : "text-sm"} font-black ${t} mt-0.5 truncate`}>{value}</div>
    </div>
  );
}

function BigDrift({ days }: { days: number }) {
  const over = days > 0;
  const on = days === 0;
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${on ? "border-emerald-200 bg-emerald-50" : over ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Finish drift vs baseline</div>
      <div className={`text-2xl font-black ${on ? "text-emerald-700" : over ? "text-rose-700" : "text-emerald-700"} flex items-center gap-1.5`}>
        {on ? <><CheckCircle2 className="w-5 h-5" /> On plan</> : <>{over ? "+" : ""}{days}d {over ? <TrendingDown className="w-4 h-4" /> : <TrendingUp className="w-4 h-4" />}</>}
      </div>
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
