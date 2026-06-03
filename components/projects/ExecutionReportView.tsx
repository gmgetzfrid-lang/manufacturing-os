"use client";

// ExecutionReportView — the "where do we actually stand" dashboard for
// the Execution board. Reads the pure computeExecutionReport() output
// and lays it out as scannable cards: headline progress + pace,
// schedule health, per-group rollups, the live blocker list (with
// reasons), and planned-vs-actual performer. Print-friendly so it
// doubles as an end-of-job report.

import React, { useMemo } from "react";
import {
  TrendingUp, TrendingDown, AlertTriangle, PauseCircle, Clock, CheckCircle2,
  CalendarDays, Users, Printer, Zap,
} from "lucide-react";
import type { Milestone } from "@/types/schema";
import { computeExecutionReport } from "@/lib/executionReport";
import { computeCriticalPathLite } from "@/lib/criticalPath";

export default function ExecutionReportView({ milestones }: { milestones: Milestone[] }) {
  const r = useMemo(() => computeExecutionReport(milestones), [milestones]);
  const critical = useMemo(() => computeCriticalPathLite(milestones), [milestones]);
  const criticalNames = useMemo(
    () => milestones.filter((m) => m.id && critical.ids.has(m.id)).map((m) => m.name),
    [milestones, critical],
  );

  if (r.totalLeaves === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 text-center">
        <CalendarDays className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <div className="text-sm font-semibold text-slate-700">Nothing to report yet</div>
        <div className="text-xs text-slate-500 mt-1">Import or add tasks to see progress, pace, and diagnostics.</div>
      </div>
    );
  }

  const ahead = r.paceDelta >= 0;
  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <Label>Complete</Label>
          <div className="flex items-baseline gap-1">
            <span className={`text-3xl font-black tracking-tighter ${r.pctComplete === 100 ? "text-emerald-600" : "text-slate-900"}`}>{r.pctComplete}</span>
            <span className="text-base text-slate-400 font-bold">%</span>
          </div>
          <Bar pct={r.pctComplete} done={r.pctComplete === 100} />
          <div className="text-[11px] text-slate-500 font-mono mt-1">{r.done} / {r.totalLeaves} tasks</div>
        </Card>

        <Card>
          <Label>Pace</Label>
          <div className={`flex items-center gap-1.5 text-2xl font-black tracking-tight ${ahead ? "text-emerald-600" : "text-rose-600"}`}>
            {ahead ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            {ahead ? "+" : ""}{r.paceDelta}<span className="text-base text-slate-400 font-bold">pts</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">{ahead ? "ahead of" : "behind"} schedule · expected {r.expectedPct}% by now</div>
        </Card>

        <Card>
          <Label>Work hours</Label>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-black tracking-tight text-slate-900">{r.pctHours}</span>
            <span className="text-base text-slate-400 font-bold">%</span>
          </div>
          <Bar pct={r.pctHours} />
          <div className="text-[11px] text-slate-500 font-mono mt-1">{Math.round(r.earnedHours)} / {Math.round(r.plannedHours)} h</div>
        </Card>

        <Card>
          <Label>Forecast finish</Label>
          <div className="text-lg font-black tracking-tight text-slate-900">{fmtDate(r.forecastFinish)}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            planned {fmtDate(r.finish)} · day {r.elapsedDays} of {r.totalDays}
          </div>
        </Card>
      </div>

      {/* Critical path — what's driving the finish */}
      {critical.ids.size > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/40 shadow-sm px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Zap className="w-4 h-4 text-rose-600" />
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Driving the finish</span>
            <span className="text-sm font-bold text-slate-900">{critical.ids.size} task{critical.ids.size === 1 ? "" : "s"} on the critical path</span>
            {critical.remainingHours > 0 && <span className="text-[11px] text-slate-500">· {Math.round(critical.remainingHours)}h remaining on the chain</span>}
            <span className="ml-auto text-[10px] text-slate-400">heuristic — based on schedule shape, not dependency links</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {criticalNames.slice(0, 10).map((n, i) => (
              <span key={i} className="inline-flex items-center text-[11px] bg-white border border-rose-200 text-rose-800 rounded-full px-2 py-0.5">{n}</span>
            ))}
            {criticalNames.length > 10 && <span className="text-[11px] text-slate-400 italic">+{criticalNames.length - 10} more</span>}
          </div>
        </div>
      )}

      {/* Baseline drift — planned vs now */}
      {r.baseline && (
        <div className={`rounded-2xl border shadow-sm px-4 py-3 ${r.baseline.finishDriftDays > 0 ? "border-rose-200 bg-rose-50/40" : r.baseline.finishDriftDays < 0 ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Vs. approved plan</span>
            <span className={`text-lg font-black ${r.baseline.finishDriftDays > 0 ? "text-rose-600" : r.baseline.finishDriftDays < 0 ? "text-emerald-600" : "text-slate-700"}`}>
              {r.baseline.finishDriftDays === 0 ? "On plan" : r.baseline.finishDriftDays > 0 ? `${r.baseline.finishDriftDays}d behind plan` : `${Math.abs(r.baseline.finishDriftDays)}d ahead of plan`}
            </span>
            <span className="text-[11px] text-slate-500">planned finish {fmtDate(r.baseline.baselineFinish)} → now {fmtDate(r.baseline.currentFinish)}</span>
            <span className="ml-auto text-[11px] text-slate-500">
              <b className="text-rose-600">{r.baseline.slipped}</b> slipped · <b className="text-emerald-600">{r.baseline.pulledIn}</b> pulled in
            </span>
          </div>
          {r.baseline.worstSlips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.baseline.worstSlips.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 text-[11px] bg-white border border-rose-200 text-rose-800 rounded-full px-2 py-0.5">
                  {s.name} <b>+{s.days}d</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Health chips */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3 flex items-center gap-4 flex-wrap">
        <Health icon={<CheckCircle2 className="w-4 h-4" />} tone="emerald" label="Done" value={r.done} />
        <Health icon={<Clock className="w-4 h-4" />} tone="blue" label="In progress" value={r.inProgress} />
        <Health icon={<PauseCircle className="w-4 h-4" />} tone="amber" label="On hold" value={r.onHold} />
        <Health icon={<AlertTriangle className="w-4 h-4" />} tone="rose" label="Blocked" value={r.blocked} />
        <Health icon={<AlertTriangle className="w-4 h-4" />} tone="rose" label="Overdue" value={r.overdue} />
        <button onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-900 border border-slate-200 px-2.5 py-1.5 rounded-lg hover:bg-slate-50 print:hidden">
          <Printer className="w-3.5 h-3.5" /> Print / export
        </button>
      </div>

      {/* Blockers — what's stopping work, with reasons */}
      {r.blockers.length > 0 && (
        <div className="bg-white rounded-2xl border border-rose-200 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-rose-100 bg-rose-50/60 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            <span className="font-bold text-slate-900 text-sm">Needs attention</span>
            <span className="text-[11px] text-slate-500">{r.blockers.length} on-hold / blocked</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {r.blockers.map((b) => (
              <li key={b.id} className="px-4 py-2.5 flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${b.status === "blocked" ? "bg-rose-100 text-rose-800 border-rose-200" : "bg-amber-100 text-amber-900 border-amber-200"}`}>
                  {b.status === "blocked" ? "Blocked" : "On hold"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-slate-900">{b.name}{b.group && <span className="text-slate-400 font-normal"> · {b.group}</span>}</div>
                  <div className="text-[12px] text-slate-600">{b.reason ? b.reason : <span className="italic text-slate-400">no reason given</span>}</div>
                </div>
                <div className="text-[11px] text-slate-400 font-mono shrink-0">{fmtDate(b.plannedAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-group rollups */}
      {r.groups.length > 1 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50/60 font-bold text-slate-900 text-sm">By group</div>
          <div className="divide-y divide-slate-100">
            {r.groups.map((g) => (
              <div key={g.id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="w-40 shrink-0 min-w-0">
                  <div className="text-[13px] font-bold text-slate-900 truncate">{g.name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">{fmtDate(g.start)} – {fmtDate(g.finish)}</div>
                </div>
                <div className="flex-1">
                  <Bar pct={g.pctComplete} done={g.pctComplete === 100} />
                </div>
                <div className="w-12 text-right text-[13px] font-black tabular-nums text-slate-700">{g.pctComplete}%</div>
                <div className="w-28 shrink-0 flex items-center justify-end gap-2 text-[11px]">
                  {g.blocked > 0 && <span className="text-rose-600 font-bold">{g.blocked} blkd</span>}
                  {g.onHold > 0 && <span className="text-amber-600 font-bold">{g.onHold} hold</span>}
                  {g.overdue > 0 && <span className="text-rose-600 font-bold">{g.overdue} late</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Planned vs actual performer */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50/60 flex items-center gap-2">
          <Users className="w-4 h-4 text-indigo-600" />
          <span className="font-bold text-slate-900 text-sm">Who did the work</span>
        </div>
        <div className="px-4 py-3">
          {Object.keys(r.performers.byActualKind).length === 0 ? (
            <div className="text-xs text-slate-400 italic">No completed work yet, or performer not recorded.</div>
          ) : (
            <div className="flex items-center gap-4 flex-wrap text-sm">
              {Object.entries(r.performers.byActualKind).map(([kind, n]) => (
                <span key={kind} className="inline-flex items-center gap-1.5">
                  <span className="font-black text-slate-900 tabular-nums">{n}</span>
                  <span className="text-slate-500 capitalize">{kind === "unspecified" ? "unspecified" : kind} completed</span>
                </span>
              ))}
            </div>
          )}
          {r.performers.deviations.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-2.5">
              <div className="text-[11px] font-bold text-amber-900 mb-1">{r.performers.deviations.length} task{r.performers.deviations.length === 1 ? "" : "s"} done by someone other than planned</div>
              <ul className="space-y-0.5">
                {r.performers.deviations.slice(0, 8).map((d) => (
                  <li key={d.id} className="text-[12px] text-amber-900/90">
                    <b>{d.name}</b>: planned <i>{d.planned}</i> → actually <i>{d.actual}</i>
                  </li>
                ))}
                {r.performers.deviations.length > 8 && <li className="text-[11px] text-amber-800/70 italic">+{r.performers.deviations.length - 8} more</li>}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] px-4 py-3">{children}</div>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">{children}</div>;
}
function Bar({ pct, done }: { pct: number; done?: boolean }) {
  return (
    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div className={`h-full transition-all ${done ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}
function Health({ icon, tone, label, value }: { icon: React.ReactNode; tone: "emerald" | "blue" | "amber" | "rose"; label: string; value: number }) {
  const c = tone === "emerald" ? "text-emerald-600" : tone === "blue" ? "text-blue-600" : tone === "amber" ? "text-amber-600" : "text-rose-600";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={c}>{icon}</span>
      <span className="text-lg font-black tabular-nums text-slate-900">{value}</span>
      <span className="text-[11px] text-slate-500">{label}</span>
    </span>
  );
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }
  catch { return "—"; }
}
