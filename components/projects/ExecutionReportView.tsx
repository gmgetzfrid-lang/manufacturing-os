"use client";

// ExecutionReportView — the "where do we actually stand" dashboard for
// the Execution board. Reads the pure computeExecutionReport() output
// and lays it out as scannable cards: headline progress + pace,
// schedule health, per-group rollups, the live blocker list (with
// reasons), and planned-vs-actual performer. Print-friendly so it
// doubles as an end-of-job report.

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { fmtInTz } from "@/lib/scheduleTz";
import {
  TrendingUp, TrendingDown, AlertTriangle, PauseCircle, Clock, CheckCircle2,
  CalendarDays, Users, Printer, Zap,
} from "lucide-react";
import type { Milestone } from "@/types/schema";
import { computeExecutionReport } from "@/lib/executionReport";
import { standingOf, type ShiftTimes } from "@/lib/shiftReport";
import { computeCriticalPathLite, type CriticalPathResult } from "@/lib/criticalPath";
import { HourlyLogExport } from "@/components/projects/HourlyLogExport";
import { useLetterhead } from "@/lib/letterheadStore";
import { exportedLabel, jobLogs } from "@/lib/hourlyLog";
import { pngInBrowser, saveHourlyLog, type LogFormat } from "@/lib/hourlyLogFiles";
import { loadProgressLog } from "@/lib/progressHistory";
import { loadShiftRecords } from "@/lib/shiftRecord";
import { notesFor } from "@/lib/milestones";
import { buildTimeLog } from "@/lib/timeLog";
import { withWorkOrderCrews } from "@/lib/workOrderCrew";
import { DEFAULT_SHIFT_TIMES } from "@/lib/shiftReport";

export default function ExecutionReportView({ milestones, shiftTimes, critical: given, criticalSource, projectId, projectName }: {
  milestones: Milestone[]; shiftTimes?: ShiftTimes;
  /** For the hourly shift log export (every shift of the job). */
  projectId?: string; projectName?: string;
  /** The project's critical path (its source plus hand marks). */
  critical?: CriticalPathResult;
  /** Where it comes from, for the note on the card. */
  criticalSource?: string;
}) {
  const tz = useScheduleTz();
  // "Expected by now" moves with the clock, not only when the data changes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const r = useMemo(() => computeExecutionReport(milestones, { tz, shiftTimes, now: new Date(now) }), [milestones, tz, shiftTimes, now]);
  const critical = useMemo(() => given ?? computeCriticalPathLite(milestones), [given, milestones]);
  const { lh } = useLetterhead(projectId);
  // Every shift's hourly log, first to last, as one file.
  const exportLogs = async (format: LogFormat) => {
    if (!projectId) throw new Error("No project.");
    const times = shiftTimes ?? DEFAULT_SHIFT_TIMES;
    const live = withWorkOrderCrews(milestones);
    const parents = new Set(live.map((m) => m.parentId).filter(Boolean));
    const [log, records, notes] = await Promise.all([loadProgressLog(projectId), loadShiftRecords(projectId),
      notesFor(live.filter((m) => m.id && !parents.has(m.id)).map((m) => m.id!))]);
    const at = Date.now();
    const timeLog = buildTimeLog({ milestones: live, log: log ?? [], notes, records, tz, times });
    const logs = jobLogs({ milestones: live, timeLog, records, log: log ?? [], tz, times, now: at });
    const name = (projectName ?? "Schedule").trim() || "Schedule";
    await saveHourlyLog(logs, format, { project: name, lh, exported: exportedLabel(at, tz), toPng: pngInBrowser, fileName: `${name} - hourly log, whole job` });
    return `${logs.length} shift${logs.length === 1 ? "" : "s"} saved.`;
  };
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

  // The same verdict as the shift report and the banner.
  const standing = standingOf(r.pctComplete, r.expectedPct);
  const ahead = r.paceDelta >= 0;
  return (
    <>
      <style>{PRINT_CSS}</style>
      {body(false)}
      <PrintCopy>{body(true)}</PrintCopy>
    </>
  );

  function body(print: boolean) {
  return (
    <div className="space-y-3">
      {print && (
        <div className="pb-1 mb-1 border-b-2 border-slate-900 flex items-baseline justify-between gap-3">
          <span className="text-[13pt] font-black">Schedule report</span>
          <span className="text-[9pt] text-slate-600">Printed {fmtInTz(new Date().toISOString(), tz, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </div>
      )}
      {/* Headline */}
      <div className={`grid gap-3 ${print ? "grid-cols-4" : "grid-cols-2 lg:grid-cols-4"}`}>
        <Card>
          <Label>Complete</Label>
          <div className="flex items-baseline gap-1">
            <span className={`text-3xl font-black tracking-tighter ${r.pctComplete === 100 ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>{r.pctComplete}</span>
            <span className="text-base text-[var(--color-text-faint)] font-bold">%</span>
          </div>
          <Bar pct={r.pctComplete} done={r.pctComplete === 100} />
          <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-1">{r.done} / {r.totalLeaves} tasks</div>
        </Card>

        <Card>
          <Label>Pace</Label>
          <div className={`flex items-center gap-1.5 text-2xl font-black tracking-tight ${standing === "behind" ? "text-rose-600 dark:text-rose-400" : standing === "ahead" ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>
            {ahead ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            {ahead ? "+" : ""}{r.paceDelta}<span className="text-base text-[var(--color-text-faint)] font-bold">pts</span>
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-1">{standing === "on track" ? "on track" : standing === "ahead" ? "ahead of schedule" : "behind schedule"} · expected {r.expectedPct}% by now</div>
        </Card>

        <Card>
          <Label>Work hours</Label>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-black tracking-tight text-[var(--color-text)]">{r.pctHours}</span>
            <span className="text-base text-[var(--color-text-faint)] font-bold">%</span>
          </div>
          <Bar pct={r.pctHours} />
          <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-1">{Math.round(r.earnedHours)} / {Math.round(r.plannedHours)} h</div>
        </Card>

        <Card>
          <Label>Forecast finish</Label>
          <div className={`text-lg font-black tracking-tight ${r.forecastFinish && r.finish && Date.parse(r.forecastFinish) > Date.parse(r.finish) + 30 * 60_000 ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text)]"}`}>{r.forecastFinish ? fmtDate(r.forecastFinish, tz) : "No work yet to forecast from"}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
            planned {fmtDate(r.finish, tz)} · day {r.elapsedDays} of {r.totalDays}
          </div>
        </Card>
      </div>

      {/* Critical path — what's driving the finish */}
      {critical.ids.size > 0 && (
        <div className="rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50/40 shadow-sm px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Zap className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Driving the finish</span>
            <span className="text-sm font-bold text-[var(--color-text)]">{critical.ids.size} task{critical.ids.size === 1 ? "" : "s"} on the critical path</span>
            {critical.remainingHours > 0 && <span className="text-[11px] text-[var(--color-text-muted)]">· {Math.round(critical.remainingHours)}h remaining on the chain</span>}
            <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">{criticalSource ? `${criticalSource} · change it on the Timeline` : "estimate - based on schedule shape, not dependency links"}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {criticalNames.slice(0, 10).map((n, i) => (
              <span key={i} className="inline-flex items-center text-[11px] bg-[var(--color-surface)] border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 rounded-full px-2 py-0.5">{n}</span>
            ))}
            {criticalNames.length > 10 && <span className="text-[11px] text-[var(--color-text-faint)] italic">+{criticalNames.length - 10} more</span>}
          </div>
        </div>
      )}

      {/* Baseline drift — planned vs now */}
      {r.baseline && (
        <div className={`rounded-2xl border shadow-sm px-4 py-3 ${r.baseline.finishDriftDays > 0 ? "border-rose-200 dark:border-rose-800 bg-rose-50/40" : r.baseline.finishDriftDays < 0 ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/40" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Vs. approved plan</span>
            <span className={`text-lg font-black ${r.baseline.finishDriftDays > 0 ? "text-rose-600 dark:text-rose-400" : r.baseline.finishDriftDays < 0 ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>
              {r.baseline.finishDriftDays === 0 ? "On plan" : r.baseline.finishDriftDays > 0 ? `${r.baseline.finishDriftDays}d behind plan` : `${Math.abs(r.baseline.finishDriftDays)}d ahead of plan`}
            </span>
            <span className="text-[11px] text-[var(--color-text-muted)]">planned finish {fmtDate(r.baseline.baselineFinish, tz)} → now {fmtDate(r.baseline.currentFinish, tz)}</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">
              <b className="text-rose-600 dark:text-rose-400">{r.baseline.slipped}</b> slipped · <b className="text-emerald-600 dark:text-emerald-400">{r.baseline.pulledIn}</b> pulled in
            </span>
          </div>
          {r.baseline.worstSlips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.baseline.worstSlips.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 text-[11px] bg-[var(--color-surface)] border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 rounded-full px-2 py-0.5">
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
        <span className="ml-auto inline-flex items-center gap-2 print:hidden">
          {!print && projectId && (
            <HourlyLogExport formats={["pdf", "docx", "xlsx"]} what="Hourly shift log, every shift of the job" letterhead={!!lh} onExport={exportLogs} label="Export shift logs" />
          )}
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] px-2.5 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)]">
            <Printer className="w-3.5 h-3.5" /> Print / export
          </button>
        </span>
      </div>

      {/* Blockers — what's stopping work, with reasons */}
      {r.blockers.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-rose-200 dark:border-rose-800 shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-rose-100 bg-rose-50/60 dark:bg-rose-950/30 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            <span className="font-bold text-[var(--color-text)] text-sm">Needs attention</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">{r.blockers.length} on-hold / blocked</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {r.blockers.map((b) => (
              <li key={b.id} className="px-4 py-2.5 flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${b.status === "blocked" ? "bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800" : "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 border-amber-200 dark:border-amber-800"}`}>
                  {b.status === "blocked" ? "Blocked" : "On hold"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-[var(--color-text)]">{b.name}{b.group && <span className="text-[var(--color-text-faint)] font-normal"> · {b.group}</span>}</div>
                  <div className="text-[12px] text-[var(--color-text-muted)]">{b.reason ? b.reason : <span className="italic text-[var(--color-text-faint)]">no reason given</span>}</div>
                </div>
                <div className="text-[11px] text-[var(--color-text-faint)] font-mono shrink-0">{fmtDate(b.plannedAt, tz)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-group rollups */}
      {r.groups.length > 1 && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] font-bold text-[var(--color-text)] text-sm">By group</div>
          <div className="divide-y divide-[var(--color-border)]">
            {r.groups.map((g) => (
              <div key={g.id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="w-40 shrink-0 min-w-0">
                  <div className="text-[13px] font-bold text-[var(--color-text)] truncate">{g.name}</div>
                  <div className="text-[10px] text-[var(--color-text-faint)] font-mono">{fmtDate(g.start, tz)} – {fmtDate(g.finish, tz)}</div>
                </div>
                <div className="flex-1">
                  <Bar pct={g.pctComplete} done={g.pctComplete === 100} />
                </div>
                <div className="w-12 text-right text-[13px] font-black tabular-nums text-[var(--color-text)]">{g.pctComplete}%</div>
                <div className="w-28 shrink-0 flex items-center justify-end gap-2 text-[11px]">
                  {g.blocked > 0 && <span className="text-rose-600 dark:text-rose-400 font-bold">{g.blocked} blkd</span>}
                  {g.onHold > 0 && <span className="text-amber-600 dark:text-amber-400 font-bold">{g.onHold} hold</span>}
                  {g.overdue > 0 && <span className="text-rose-600 dark:text-rose-400 font-bold">{g.overdue} late</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Planned vs actual performer */}
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] flex items-center gap-2">
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
            <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-2.5">
              <div className="text-[11px] font-bold text-amber-900 dark:text-amber-200 mb-1">{r.performers.deviations.length} task{r.performers.deviations.length === 1 ? "" : "s"} done by someone other than planned</div>
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
}

/** Printing prints only the report — not the app around it — in a compact
 *  layout: the same content rendered into a portal at the document root,
 *  with screen padding, shadows and big type tightened for paper. */
const PRINT_CSS = `
  [data-exec-print-root] { display: none; }
  @media print {
    @page { size: auto; margin: 10mm; }
    body > *:not([data-exec-print-root]) { display: none !important; }
    [data-exec-print-root] { display: block !important; font-size: 9pt; line-height: 1.3; color: #0f172a; background: #fff; }
    [data-exec-print-root] * { box-shadow: none !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    [data-exec-print-root] .space-y-3 > * + * { margin-top: 6px !important; }
    [data-exec-print-root] .rounded-2xl { border-radius: 6px !important; }
    [data-exec-print-root] .px-4 { padding-left: 8px !important; padding-right: 8px !important; }
    [data-exec-print-root] .py-3, [data-exec-print-root] .py-2\.5 { padding-top: 4px !important; padding-bottom: 4px !important; }
    [data-exec-print-root] .text-3xl { font-size: 18pt !important; }
    [data-exec-print-root] .text-2xl { font-size: 15pt !important; }
    [data-exec-print-root] li, [data-exec-print-root] .divide-y > div { break-inside: avoid; }
  }
`;

const noSubscribe = () => () => undefined;

function PrintCopy({ children }: { children: React.ReactNode }) {
  // True only in the browser (the portal needs document.body).
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false);
  return mounted ? createPortal(<div data-exec-print-root>{children}</div>, document.body) : null;
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
  const c = tone === "emerald" ? "text-emerald-600 dark:text-emerald-400" : tone === "blue" ? "text-blue-600 dark:text-blue-400" : tone === "amber" ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={c}>{icon}</span>
      <span className="text-lg font-black tabular-nums text-[var(--color-text)]">{value}</span>
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
    </span>
  );
}

function fmtDate(iso: string | null | undefined, tz: string): string {
  if (!iso) return "-";
  return fmtInTz(iso, tz, { month: "short", day: "numeric", year: "numeric" }) || "-";
}
