"use client";

// ExecutionReportView — the "where do we actually stand" dashboard for
// the Execution board. Reads the pure computeExecutionReport() output
// and lays it out as scannable cards: headline progress + pace,
// schedule health, per-group rollups, the live blocker list (with
// reasons), and planned-vs-actual performer. Print-friendly so it
// doubles as an end-of-job report.

import React, { useEffect, useMemo, useState } from "react";
import {
  TrendingUp, TrendingDown, AlertTriangle, PauseCircle, Clock, CheckCircle2,
  CalendarDays, Users, Printer, Zap,
} from "lucide-react";
import type { Milestone } from "@/types/schema";
import { computeExecutionReport, FORECAST_MIN_DONE_FRACTION } from "@/lib/executionReport";
import { computeCriticalPath, pathCalendarLabel } from "@/lib/criticalPath";
import { weightBasisLabel } from "@/lib/scheduleProgress";
import { listBaselineCaptures, currentBaselineSummary, type BaselineCapture } from "@/lib/milestones";

export default function ExecutionReportView({ milestones, orgId, projectId, nowMs }: {
  milestones: Milestone[]; orgId?: string; projectId?: string;
  /** The board's one "now" (epoch ms), so the Report's overdue and pace agree
   *  with the pulse and the summary strip (PT SCH-5). Omitted: the time of
   *  the computation. */
  nowMs?: number;
}) {
  // Every approved-plan capture the project has had (PT SAF-7): the live one
  // and each one a re-baseline or a clear replaced. Drift is measured against
  // the newest by default; an older one can be picked.
  const [history, setHistory] = useState<BaselineCapture[]>([]);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState<string>("current");
  // The live capture comes from the rows on screen; the history is read once
  // per project and again only when the live baseline itself changes.
  const live = useMemo(() => currentBaselineSummary(milestones), [milestones]);
  const liveKey = live ? `${live.setAt ?? ""}:${live.rowCount}` : "none";
  useEffect(() => {
    if (!orgId || !projectId) return;
    let alive = true;
    void listBaselineCaptures({ orgId, projectId, milestones: [] }).then((res) => {
      if (!alive) return;
      setHistory(res.captures);
      setCaptureNote(res.error ? `Earlier baselines could not be read: ${res.error}` : res.historyUnavailable ? "Earlier baselines are kept once the baseline-history migration (20261099) is applied." : null);
    });
    return () => { alive = false; };
  }, [orgId, projectId, liveKey]);
  const captures = useMemo<BaselineCapture[]>(() => {
    if (!live) return history;
    const finishById = new Map<string, string>();
    for (const m of milestones) if (m.id && m.baselineFinishAt) finishById.set(m.id, m.baselineFinishAt as string);
    return [{ id: "current", setAt: live.setAt, retiredAt: null, retiredBy: null, rowCount: live.rowCount, finishById }, ...history];
  }, [live, history, milestones]);
  const chosen = captures.find((c) => c.id === captureId) ?? null;
  const r = useMemo(
    () => computeExecutionReport(milestones, {
      ...(chosen && chosen.id !== "current" ? { baselineFinishById: chosen.finishById } : {}),
      ...(nowMs != null ? { now: new Date(nowMs) } : {}),
    }),
    [milestones, chosen, nowMs],
  );
  const critical = useMemo(() => computeCriticalPath(milestones), [milestones]);
  const criticalNames = useMemo(
    () => milestones.filter((m) => m.id && critical.ids.has(m.id)).map((m) => m.name),
    [milestones, critical],
  );

  if (r.totalLeaves === 0) {
    return (
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-12 text-center">
        <CalendarDays className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <div className="text-sm font-semibold text-[var(--color-text)]">Nothing to report yet</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-1">Import or add tasks to see progress, pace, and diagnostics.</div>
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
            <span className={`text-3xl font-black tracking-tighter ${r.pctComplete === 100 ? "text-emerald-600" : "text-[var(--color-text)]"}`}>{r.pctComplete}</span>
            <span className="text-base text-[var(--color-text-faint)] font-bold">%</span>
          </div>
          <Bar pct={r.pctComplete} done={r.pctComplete === 100} />
          <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-1">{r.done} / {r.totalLeaves} tasks</div>
          {/* The weighting basis, named (PC SCHED-14). */}
          <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">{weightBasisLabel(r.weightBasis)}</div>
        </Card>

        <Card>
          <Label>Pace</Label>
          <div className={`flex items-center gap-1.5 text-2xl font-black tracking-tight ${ahead ? "text-emerald-600" : "text-rose-600"}`}>
            {ahead ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            {ahead ? "+" : ""}{r.paceDelta}<span className="text-base text-[var(--color-text-faint)] font-bold">pts</span>
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-1">{ahead ? "ahead of" : "behind"} schedule · expected {r.expectedPct}% by now</div>
        </Card>

        <Card>
          <Label>Work hours</Label>
          {r.pctHours === null ? (
            // No leaf carries planned hours: say so — never "0 / 0 h" over a
            // percentage that is really the task-weighted figure (PC SCHED-14 / SCHED-2).
            <>
              <div className="text-sm font-bold text-[var(--color-text-muted)]">Not supplied</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1">No task in this schedule carries planned work hours.</div>
            </>
          ) : (
            <>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-black tracking-tight text-[var(--color-text)]">{r.pctHours}</span>
                <span className="text-base text-[var(--color-text-faint)] font-bold">%</span>
              </div>
              <Bar pct={r.pctHours} />
              <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-1">{Math.round(r.earnedHours)} / {Math.round(r.plannedHours)} h</div>
              {r.leavesWithHours < r.totalLeaves && (
                <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">hours on {r.leavesWithHours} of {r.totalLeaves} tasks</div>
              )}
            </>
          )}
        </Card>

        <Card>
          <Label>Forecast finish</Label>
          {/* An estimate, named as one (PC SCHED-12): the completion rate so
              far carried forward — withheld until enough is done to mean anything. */}
          <div className="text-lg font-black tracking-tight text-[var(--color-text)]">{r.forecastBasis === "too-early" ? "—" : fmtDate(r.forecastFinish)}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
            {r.forecastBasis === "rate" && r.forecastRatePerDay !== null
              ? <>estimate at the current rate of {fmtRate(r.forecastRatePerDay)} tasks/day (task count, not effort or links) · </>
              : r.forecastBasis === "too-early"
                ? <>shown once {Math.round(FORECAST_MIN_DONE_FRACTION * 100)}% of tasks are done · </>
                : <>all tasks done · </>}
            planned {fmtDate(r.finish)} · day {r.elapsedDays} of {r.totalDays}
          </div>
        </Card>
      </div>

      {/* Critical path — what's driving the finish */}
      {critical.ids.size > 0 && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50/40 shadow-sm px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Zap className="w-4 h-4 text-rose-600" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Driving the finish</span>
            <span className="text-sm font-bold text-[var(--color-text)]">{critical.ids.size} task{critical.ids.size === 1 ? "" : "s"} on the critical path</span>
            {critical.remainingHours > 0 && <span className="text-[11px] text-[var(--color-text-muted)]">· {Math.round(critical.remainingHours)}h still to do on the chain</span>}
            <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">
              {critical.linked
                ? `from the finish-to-start links · ${pathCalendarLabel(critical.calendar, critical.workedWeekendDays.length)}, no holidays${critical.unlinked > 0 ? ` · ${critical.unlinked} task${critical.unlinked === 1 ? " has" : "s have"} no links` : ""}`
                : "no dependency links yet — only the tasks that end at the finish are shown"}
              {critical.cycle ? ` · ${critical.cycle.length} task${critical.cycle.length === 1 ? "" : "s"} in a loop of links left out` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {criticalNames.slice(0, 10).map((n, i) => (
              <span key={i} className="inline-flex items-center text-[11px] bg-[var(--color-surface)] border border-rose-200 text-rose-800 rounded-full px-2 py-0.5">{n}</span>
            ))}
            {criticalNames.length > 10 && <span className="text-[11px] text-[var(--color-text-faint)] italic">+{criticalNames.length - 10} more</span>}
          </div>
        </div>
      )}

      {/* Which approved plan drift is measured against (PT SAF-7). */}
      {captures.length > 1 && (
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] print:hidden">
          <label htmlFor="baseline-capture" className="font-bold uppercase tracking-widest text-[10px] text-[var(--color-text-faint)]">Compare with</label>
          <select id="baseline-capture" value={captureId} onChange={(e) => setCaptureId(e.target.value)}
            className="text-[12px] border border-[var(--color-border-strong)] rounded-md px-2 py-1 bg-[var(--color-surface)] text-[var(--color-text)]">
            {captures.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === "current" ? "Current baseline" : "Earlier baseline"}{c.setAt ? ` · set ${fmtDate(c.setAt)}` : ""}{c.retiredAt ? ` · ${c.retiredBy === "clear" ? "cleared" : "replaced"} ${fmtDate(c.retiredAt)}` : ""} · {c.rowCount} tasks
              </option>
            ))}
          </select>
        </div>
      )}
      {captureNote && <div className="text-[10px] text-[var(--color-text-faint)] print:hidden">{captureNote}</div>}

      {/* Baseline drift — planned vs now */}
      {r.baseline && (
        <div className={`rounded-2xl border shadow-sm px-4 py-3 ${r.baseline.finishDriftDays > 0 ? "border-rose-200 bg-rose-50/40" : r.baseline.finishDriftDays < 0 ? "border-emerald-200 bg-emerald-50/40" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">{chosen && chosen.id !== "current" ? `Vs. the baseline set ${fmtDate(chosen.setAt)}` : "Vs. approved plan"}</span>
            <span className={`text-lg font-black ${r.baseline.finishDriftDays > 0 ? "text-rose-600" : r.baseline.finishDriftDays < 0 ? "text-emerald-600" : "text-[var(--color-text)]"}`}>
              {r.baseline.finishDriftDays === 0 ? "On plan" : r.baseline.finishDriftDays > 0 ? `${r.baseline.finishDriftDays}d behind plan` : `${Math.abs(r.baseline.finishDriftDays)}d ahead of plan`}
            </span>
            <span className="text-[11px] text-[var(--color-text-muted)]">planned finish {fmtDate(r.baseline.baselineFinish)} → now {fmtDate(r.baseline.currentFinish)}</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">
              <b className="text-rose-600">{r.baseline.slipped}</b> slipped · <b className="text-emerald-600">{r.baseline.pulledIn}</b> pulled in
            </span>
          </div>
          {r.baseline.worstSlips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.baseline.worstSlips.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 text-[11px] bg-[var(--color-surface)] border border-rose-200 text-rose-800 rounded-full px-2 py-0.5">
                  {s.name} <b>+{s.days}d</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Health chips */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm px-4 py-3 flex items-center gap-4 flex-wrap">
        <Health icon={<CheckCircle2 className="w-4 h-4" />} tone="emerald" label="Done" value={r.done} />
        <Health icon={<Clock className="w-4 h-4" />} tone="blue" label="In progress" value={r.inProgress} />
        <Health icon={<PauseCircle className="w-4 h-4" />} tone="amber" label="On hold" value={r.onHold} />
        <Health icon={<AlertTriangle className="w-4 h-4" />} tone="rose" label="Blocked" value={r.blocked} />
        <Health icon={<AlertTriangle className="w-4 h-4" />} tone="rose" label="Overdue" value={r.overdue} />
        <button onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] px-2.5 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] print:hidden">
          <Printer className="w-3.5 h-3.5" /> Print / export
        </button>
      </div>

      {/* Blockers — what's stopping work, with reasons */}
      {r.blockers.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-rose-200 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-rose-100 bg-rose-50/60 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            <span className="font-bold text-[var(--color-text)] text-sm">Needs attention</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">{r.blockers.length} on-hold / blocked</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {r.blockers.map((b) => (
              <li key={b.id} className="px-4 py-2.5 flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${b.status === "blocked" ? "bg-rose-100 text-rose-800 border-rose-200" : "bg-amber-100 text-amber-900 border-amber-200"}`}>
                  {b.status === "blocked" ? "Blocked" : "On hold"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--color-text)]">{b.name}{b.group && <span className="text-[var(--color-text-faint)] font-normal"> · {b.group}</span>}</div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">{b.reason ? b.reason : <span className="italic text-[var(--color-text-faint)]">no reason given</span>}</div>
                </div>
                <div className="text-[11px] text-[var(--color-text-faint)] font-mono shrink-0">{fmtDate(b.plannedAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-group rollups */}
      {r.groups.length > 1 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50/60 font-bold text-[var(--color-text)] text-sm">By group</div>
          <div className="divide-y divide-[var(--color-border)]">
            {r.groups.map((g) => (
              <div key={g.id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="w-40 shrink-0 min-w-0">
                  <div className="text-[13px] font-bold text-[var(--color-text)] truncate">{g.name}</div>
                  <div className="text-[10px] text-[var(--color-text-faint)] font-mono">{fmtDate(g.start)} – {fmtDate(g.finish)}</div>
                </div>
                <div className="flex-1">
                  <Bar pct={g.pctComplete} done={g.pctComplete === 100} />
                </div>
                <div className="w-12 text-right text-[13px] font-black tabular-nums text-[var(--color-text)]">{g.pctComplete}%</div>
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
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="font-bold text-[var(--color-text)] text-sm">Who did the work</span>
        </div>
        <div className="px-4 py-3">
          {Object.keys(r.performers.byActualKind).length === 0 ? (
            <div className="text-xs text-[var(--color-text-faint)] italic">No completed work yet, or performer not recorded.</div>
          ) : (
            <div className="flex items-center gap-4 flex-wrap text-sm">
              {Object.entries(r.performers.byActualKind).map(([kind, n]) => (
                <span key={kind} className="inline-flex items-center gap-1.5">
                  <span className="font-black text-[var(--color-text)] tabular-nums">{n}</span>
                  <span className="text-[var(--color-text-muted)] capitalize">{kind === "unspecified" ? "unspecified" : kind} completed</span>
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
  return <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] px-4 py-3">{children}</div>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-1">{children}</div>;
}
function Bar({ pct, done }: { pct: number; done?: boolean }) {
  return (
    <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
      <div className={`h-full transition-all ${done ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}
function Health({ icon, tone, label, value }: { icon: React.ReactNode; tone: "emerald" | "blue" | "amber" | "rose"; label: string; value: number }) {
  const c = tone === "emerald" ? "text-emerald-600" : tone === "blue" ? "text-blue-600" : tone === "amber" ? "text-amber-600" : "text-rose-600";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={c}>{icon}</span>
      <span className="text-lg font-black tabular-nums text-[var(--color-text)]">{value}</span>
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

function fmtRate(n: number): string {
  return n >= 10 ? String(Math.round(n)) : n >= 1 ? n.toFixed(1) : n.toFixed(2);
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }
  catch { return "—"; }
}
