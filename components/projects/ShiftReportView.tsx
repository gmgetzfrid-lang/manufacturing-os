"use client";

// ShiftReportView — the shift-change briefing, on screen and on paper.
//
// The supervisor's loop: 05:30 meeting with the day crew, 17:30 update
// progress and walk into the night meeting with overall status, what
// carried over, the goals for the night and what gets the job back on
// track. This view is that page. Pick the shift under review (defaults
// to the one ending now), read it, print it.
//
// Everything is computed in lib/shiftReport.ts from the live schedule;
// progress entered in the Day view or on the calendar shows up here as
// soon as it saves.

import React, { useEffect, useMemo, useState } from "react";
import { Printer, ChevronLeft, ChevronRight, Sun, Moon, AlertTriangle, CheckCircle2, CircleDashed, Flag, Clock } from "lucide-react";
import type { Milestone } from "@/types/schema";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { buildShiftReport, shiftAt, shiftWindow, nextShift, previousShift, shiftLabel, DEFAULT_SHIFT_TIMES, type ShiftTimes, type ShiftRow, type ShiftWindow } from "@/lib/shiftReport";
import { clockLabel, fmtInTz, tzLabel } from "@/lib/scheduleTz";

interface Props {
  milestones: Milestone[];
  progress?: Map<string, ProgressInfo>;
  criticalIds: Set<string>;
  projectId: string;
  projectName?: string;
}

function loadTimes(projectId: string): ShiftTimes {
  try {
    const raw = localStorage.getItem(`shiftTimes:${projectId}`);
    if (raw) { const p = JSON.parse(raw) as Partial<ShiftTimes>; return { ...DEFAULT_SHIFT_TIMES, ...p }; }
  } catch { /* private mode etc. */ }
  return DEFAULT_SHIFT_TIMES;
}

export default function ShiftReportView({ milestones, progress, criticalIds, projectId, projectName }: Props) {
  const tz = useScheduleTz();
  const [times, setTimes] = useState<ShiftTimes>(DEFAULT_SHIFT_TIMES);
  useEffect(() => { setTimes(loadTimes(projectId)); }, [projectId]);
  const saveTimes = (t: ShiftTimes) => {
    setTimes(t);
    try { localStorage.setItem(`shiftTimes:${projectId}`, JSON.stringify(t)); } catch { /* ignore */ }
  };

  // The shift under review: by default the one that contains "an hour ago",
  // so from 17:30 to 18:30 you are still looking at the day shift you just
  // finished updating, and from 05:30 to 06:30 at the night shift.
  const [now] = useState(() => Date.now());
  const [sel, setSel] = useState<{ dayKey: string; kind: "day" | "night" } | null>(null);
  const shift: ShiftWindow = useMemo(() => {
    if (sel) return shiftWindow(sel.dayKey, sel.kind, tz, times);
    return shiftAt(now - 3600_000, tz, times);
  }, [sel, now, tz, times]);
  const pick = (w: ShiftWindow) => setSel({ dayKey: w.dayKey, kind: w.kind });

  const report = useMemo(
    () => buildShiftReport({ milestones, progress, criticalIds, tz, times, shift, now: Math.min(now, shift.end) }),
    [milestones, progress, criticalIds, tz, times, shift, now],
  );
  const { overall, review, goals, blocked, next } = report;

  const rowTime = (r: ShiftRow, win: ShiftWindow) => {
    const s = r.start >= win.start && r.start < win.end ? (clockLabel(r.start, tz) || "0:00") : "…";
    const f = r.finish > win.start && r.finish <= win.end ? (clockLabel(r.finish, tz) || "24:00") : "…";
    if (s === "…" && f === "…") return "all shift";
    return `${s}–${f}`;
  };
  const due = (r: ShiftRow) => fmtInTz(r.finish, tz, { month: "short", day: "numeric" }) + " " + (clockLabel(r.finish, tz) || "");

  const standingTone = overall.standing === "ahead" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
    : overall.standing === "behind" ? "text-rose-700 bg-rose-50 border-rose-200"
    : "text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]";

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden">
      {/* Print: show only the report. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        .shift-report-print, .shift-report-print * { visibility: visible !important; }
        .shift-report-print { position: absolute !important; left: 0; top: 0; width: 100% !important; padding: 0 !important; }
        .shift-report-print .no-print { display: none !important; }
        .shift-report-print section { break-inside: avoid; }
      }`}</style>

      {/* Toolbar */}
      <div className="no-print px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
        <button onClick={() => pick(previousShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Previous shift"><ChevronLeft className="w-4 h-4" /></button>
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
          {(["day", "night"] as const).map((k) => (
            <button key={k} onClick={() => setSel({ dayKey: shift.dayKey, kind: k })} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${shift.kind === k ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {k === "day" ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />} {k === "day" ? "Day" : "Night"}
            </button>
          ))}
        </div>
        <input
          type="date" value={shift.dayKey}
          onChange={(e) => { if (e.target.value) setSel({ dayKey: e.target.value, kind: shift.kind }); }}
          className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-2 bg-[var(--color-surface)]"
          title="Which day's shift to review"
        />
        <button onClick={() => pick(nextShift(shift, tz, times))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title="Next shift"><ChevronRight className="w-4 h-4" /></button>
        <button onClick={() => setSel(null)} className="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)]">Current shift</button>
        <span className="mx-1 w-px h-4 bg-[var(--color-border)]" />
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Sun className="w-3 h-3" /> starts
          <input type="time" value={times.dayStart} onChange={(e) => saveTimes({ ...times, dayStart: e.target.value || DEFAULT_SHIFT_TIMES.dayStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><Moon className="w-3 h-3" /> starts
          <input type="time" value={times.nightStart} onChange={(e) => saveTimes({ ...times, nightStart: e.target.value || DEFAULT_SHIFT_TIMES.nightStart })} className="h-7 text-[11px] border border-[var(--color-border-strong)] rounded px-1 bg-[var(--color-surface)]" />
        </label>
        <button onClick={() => window.print()} className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm">
          <Printer className="w-3.5 h-3.5" /> Print for the meeting
        </button>
      </div>

      {/* The report */}
      <div className="shift-report-print p-5 space-y-5 text-[12px] text-[var(--color-text)]">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Shift change report</div>
            <h2 className="text-lg font-black leading-tight">{projectName ?? "Schedule"}</h2>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Reviewing <b className="text-[var(--color-text)]">{shiftLabel(shift, tz)}</b> · planning <b className="text-[var(--color-text)]">{shiftLabel(next, tz)}</b>
            </div>
            <div className="text-[10px] text-[var(--color-text-faint)]">Plant time {tzLabel(tz)} · generated {fmtInTz(now, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
          </div>
          <div className={`rounded-xl border px-4 py-2 text-right ${standingTone}`}>
            <div className="text-[10px] font-black uppercase tracking-widest">Overall</div>
            <div className="text-2xl font-black leading-none">{overall.standing.toUpperCase()}</div>
            <div className="text-[11px] font-bold">{overall.variancePct > 0 ? "+" : ""}{overall.variancePct} pts vs plan</div>
          </div>
        </header>

        {/* Overall numbers */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Actual complete" value={`${overall.actualPct}%`} />
          <Stat label="Plan said by now" value={`${overall.plannedPct}%`} />
          <Stat label="Steps done" value={`${overall.stepsDone} / ${overall.stepsTotal}`} />
          <Stat label="Schedule day" value={overall.daysTotal ? `${overall.daysElapsed} / ${overall.daysTotal}` : "—"} sub={overall.plannedFinish ? `finish ${fmtInTz(overall.plannedFinish, tz, { month: "short", day: "numeric" })} ${clockLabel(overall.plannedFinish, tz)}` : undefined} />
        </section>

        {/* Shift review */}
        <section>
          <SectionTitle icon={<Clock className="w-3.5 h-3.5" />} title={`${shift.kind === "day" ? "Day" : "Night"} shift review`} sub={`${review.scheduled.length} step${review.scheduled.length === 1 ? "" : "s"} scheduled · ${review.done.length} done · ${review.inProgress.length} in progress · ${review.notStarted.length} not started`} />
          {review.scheduled.length === 0 ? <Empty>Nothing was scheduled on this shift.</Empty> : (
            <table className="w-full text-[11px]">
              <thead><tr className="text-[9px] uppercase tracking-wider text-[var(--color-text-faint)] text-left"><th className="py-1 pr-2 w-20">Window</th><th className="py-1 pr-2">Step</th><th className="py-1 pr-2">Equipment</th><th className="py-1 pr-2 w-16 text-right">%</th><th className="py-1 w-24">Result</th></tr></thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {review.scheduled.map((r) => (
                  <tr key={r.leaf.id} className={r.carryOver ? "bg-rose-50/60" : ""}>
                    <td className="py-1 pr-2 font-mono text-[var(--color-text-muted)]">{rowTime(r, shift)}</td>
                    <td className="py-1 pr-2 font-semibold">{r.leaf.name}{r.critical && <Flag className="inline w-3 h-3 ml-1 text-rose-600" aria-label="critical path" />}</td>
                    <td className="py-1 pr-2 text-[var(--color-text-muted)] truncate max-w-[220px]">{r.path.join(" › ")}</td>
                    <td className="py-1 pr-2 text-right font-mono">{r.percent}%</td>
                    <td className="py-1"><Result r={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Carry-over */}
        <section>
          <SectionTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-rose-600" />} title="Carry-over — due by now, not done" sub={review.carryOver.length === 0 ? "Nothing carried over." : `${review.carryOver.length} step${review.carryOver.length === 1 ? "" : "s"} roll into the next shift`} />
          {review.carryOver.length > 0 && (
            <ul className="divide-y divide-[var(--color-border)]">
              {review.carryOver.map((r) => (
                <li key={r.leaf.id} className="py-1.5 flex items-center gap-2 text-[11px]">
                  {r.critical ? <Flag className="w-3.5 h-3.5 text-rose-600 shrink-0" /> : <CircleDashed className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
                  <span className="font-semibold">{r.leaf.name}</span>
                  <span className="text-[var(--color-text-muted)] truncate">{r.path.join(" › ")}</span>
                  <span className="ml-auto font-mono text-[var(--color-text-muted)] shrink-0">{r.percent}% · due {due(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Next shift goals */}
        <section>
          <SectionTitle icon={<Flag className="w-3.5 h-3.5" />} title={`Goals for the ${next.kind} shift`} sub={`${goals.all.length} step${goals.all.length === 1 ? "" : "s"} · ${goals.carryOver.length} carried over · ${goals.critical.length} on the critical path`} />
          {goals.all.length === 0 ? <Empty>Nothing is scheduled for the next shift.</Empty> : (
            <table className="w-full text-[11px]">
              <thead><tr className="text-[9px] uppercase tracking-wider text-[var(--color-text-faint)] text-left"><th className="py-1 pr-2 w-6" /><th className="py-1 pr-2 w-20">Window</th><th className="py-1 pr-2">Step</th><th className="py-1 pr-2">Equipment</th><th className="py-1 pr-2 w-28">Crew / WO</th><th className="py-1 w-14 text-right">Now</th></tr></thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {goals.all.map((r) => (
                  <tr key={r.leaf.id} className={r.critical ? "bg-rose-50/60" : r.carryOver ? "bg-amber-50/60" : ""}>
                    <td className="py-1 pr-2">{r.critical ? <Flag className="w-3.5 h-3.5 text-rose-600" aria-label="critical path" /> : r.carryOver ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600" aria-label="carry-over" /> : null}</td>
                    <td className="py-1 pr-2 font-mono text-[var(--color-text-muted)]">{r.carryOver ? "overdue" : rowTime(r, next)}</td>
                    <td className="py-1 pr-2 font-semibold">{r.leaf.name}</td>
                    <td className="py-1 pr-2 text-[var(--color-text-muted)] truncate max-w-[220px]">{r.path.join(" › ")}</td>
                    <td className="py-1 pr-2 text-[var(--color-text-muted)] truncate max-w-[140px]">{[r.leaf.responsibleParty, r.leaf.workOrderRef ? `WO ${r.leaf.workOrderRef}` : null].filter(Boolean).join(" · ")}</td>
                    <td className="py-1 text-right font-mono">{r.percent}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-1 text-[10px] text-[var(--color-text-faint)]">Red = on the chain that drives the finish date. Amber = carried over. Clear these first to get back on track.</div>
        </section>

        {/* Blocked */}
        {blocked.length > 0 && (
          <section>
            <SectionTitle icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-600" />} title="Blocked / on hold" sub={`${blocked.length} step${blocked.length === 1 ? "" : "s"} need a decision`} />
            <ul className="divide-y divide-[var(--color-border)]">
              {blocked.map((r) => (
                <li key={r.leaf.id} className="py-1.5 text-[11px]">
                  <span className="font-semibold">{r.leaf.name}</span> <span className="text-[var(--color-text-muted)]">{r.path.join(" › ")}</span>
                  <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-amber-700">{r.status === "blocked" ? "Blocked" : "On hold"}</span>
                  {r.reason && <div className="text-[var(--color-text-muted)]">Reason: {r.reason}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)] flex justify-between">
          <span>Plan % = work the schedule expected complete by {fmtInTz(Math.min(now, shift.end), tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}, duration-weighted. Actual % = entered progress, duration-weighted.</span>
          <span>Printed {fmtInTz(now, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2">
      <div className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">{label}</div>
      <div className="text-lg font-black leading-tight">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

function SectionTitle({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5 border-b border-[var(--color-border)] pb-1">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-black uppercase tracking-wide">{icon} {title}</span>
      {sub && <span className="text-[10px] text-[var(--color-text-muted)]">{sub}</span>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-[11px] text-[var(--color-text-faint)]">{children}</div>;
}

function Result({ r }: { r: ShiftRow }) {
  if (r.status === "completed" || r.percent >= 100) return <span className="inline-flex items-center gap-1 text-emerald-700 font-bold"><CheckCircle2 className="w-3.5 h-3.5" /> Done</span>;
  if (r.status === "blocked") return <span className="text-rose-700 font-bold">Blocked</span>;
  if (r.status === "on_hold") return <span className="text-amber-700 font-bold">On hold</span>;
  if (r.carryOver) return <span className="text-rose-700 font-bold">Carry-over</span>;
  if (r.status === "in_progress" || r.percent > 0) return <span className="text-blue-700 font-bold">In progress</span>;
  return <span className="text-[var(--color-text-muted)]">Not started</span>;
}

