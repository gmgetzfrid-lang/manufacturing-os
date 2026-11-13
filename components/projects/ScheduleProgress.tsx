"use client";

// ScheduleProgress — earned-value-style metrics dashboard for the
// schedule tab. Shows the things a project manager actually needs
// at a glance:
//
//   * Overall completion % (earned weight / total weight)
//   * SPI — Schedule Performance Index. <1 means behind.
//   * Forecast end date if behind.
//   * Counts per status with a stacked progress bar.
//   * Upcoming milestones in the next 14 days, oldest first, so
//     the user sees what they need to act on next.
//   * What needs you: overdue and held work, a tap to show it (the board
//     filters to it). One card: the job's numbers aren't said twice.
//
// The verdict is the job's work-hours behind the plan (standingByHours),
// and the forecast is the schedule's own, from its links (lib/cpm), to the
// hour: the same verdict and forecast the shift report gives.
//
// A project split in phases with all of them picked has no one percent or
// verdict: each phase is on its own plan, in its own week (PhaseLines).
// Finished work says when it finished and how late, not a forecast. A net
// "ahead" or "behind" shows its two parts, so early work can't hide late.
//
// Pure render — no fetches. Drives off the metrics already computed
// by lib/milestones.ts:computeScheduleMetrics().

import React, { useMemo, useState } from "react";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { dayDiff as dayDiffTz, fmtInTz } from "@/lib/scheduleTz";
import { isOverdue } from "@/lib/shiftReport";
import { computeExecutionReport } from "@/lib/executionReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { useCriticalMode } from "@/lib/criticalModeStore";
import { resolveCriticalPath } from "@/lib/criticalPath";
import { clockLabel } from "@/lib/scheduleTz";
import { lateWords, verdictParts } from "@/lib/phaseStanding";
import PhaseLines, { usePhaseStandings } from "@/components/projects/PhaseLines";
import {
  TrendingUp, TrendingDown, Flag, AlertTriangle, CalendarClock,
  CheckCircle2, Circle, PauseCircle, MinusCircle, XCircle,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ScheduleMetrics } from "@/lib/milestones";

interface Props {
  milestones: Milestone[];
  metrics: ScheduleMetrics;
  /** For the project's shift-change times (plan by now runs on them). */
  projectId?: string;
  /** Show the overdue work / the held work on the board (Work tab). */
  onShowOverdue?: () => void;
  onShowBlocked?: () => void;
}

const STATUS_META: Record<MilestoneStatus, { label: string; tone: string; bar: string; Icon: React.ComponentType<{ className?: string }> }> = {
  // The same colours as the timeline and calendar dots.
  planned:     { label: "Planned",     tone: "text-slate-600 dark:text-slate-300",  bar: "bg-slate-400",   Icon: Circle },
  in_progress: { label: "In progress", tone: "text-blue-700 dark:text-blue-300",    bar: "bg-blue-500",    Icon: PauseCircle },
  completed:   { label: "Completed",   tone: "text-emerald-700 dark:text-emerald-300", bar: "bg-emerald-500", Icon: CheckCircle2 },
  missed:      { label: "Missed",      tone: "text-rose-700 dark:text-rose-300",    bar: "bg-rose-600",    Icon: XCircle },
  blocked:     { label: "Blocked",     tone: "text-rose-700 dark:text-rose-300",    bar: "bg-rose-500",    Icon: MinusCircle },
  on_hold:     { label: "On hold",     tone: "text-amber-700 dark:text-amber-300",   bar: "bg-amber-500",   Icon: PauseCircle },
};

export default function ScheduleProgress({ milestones, metrics, projectId, onShowOverdue, onShowBlocked }: Props) {
  const tz = useScheduleTz();
  const total = milestones.length;
  const today = new Date(); today.setHours(0,0,0,0);
  const in14 = new Date(today.getTime() + 14 * 86400000);
  const upcoming = milestones
    .filter((m) => m.status !== "completed" && m.plannedAt)
    .map((m) => ({ m, due: new Date(m.plannedAt as string) }))
    .filter((x) => x.due >= today && x.due <= in14)
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .slice(0, 5);
  // Overdue by the one rule every view uses, counting steps (not phases).
  const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean));
  const [nowMs] = useState(() => Date.now());
  const overdue = milestones.filter((m) => !(m.id && parents.has(m.id)) && isOverdue(m, nowMs, tz));

  // The same % complete, plan by now and verdict as the reports and the
  // board (one weighting, one rule) — not a separate count.
  const shiftTimes = useShiftTimes(projectId);
  const r = computeExecutionReport(milestones, { tz, now: new Date(nowMs), shiftTimes });
  const earnedPct = r.pctComplete;
  const planPct = r.expectedPct;
  const spi = planPct > 0 ? earnedPct / planPct : 1;
  // The job's verdict from the work-hours behind, as the shift report has it.
  const verdict = r.standing;
  const gapH = Math.abs(r.gapHours);
  // The schedule's own forecast, to the hour (from its links), as the shift
  // report has it; without links, the finish at the pace so far.
  const criticalMode = useCriticalMode(projectId);
  const cpm = useMemo(() => resolveCriticalPath(milestones, criticalMode, { now: nowMs, tz }).cpm, [milestones, criticalMode, nowMs, tz]);
  const linked = !!cpm && Number.isFinite(cpm.forecastFinish);
  const forecastEndAt = linked ? new Date(cpm!.forecastFinish).toISOString() : r.forecastFinish;
  const plannedEndAt = r.finish;
  const slipH = linked ? cpm!.slipH : 0;
  const slipDays = !linked && forecastEndAt && plannedEndAt
    ? Math.max(0, dayDiffTz(Date.parse(plannedEndAt), Date.parse(forecastEndAt), tz))
    : 0;
  const late = linked ? slipH >= 0.5 : verdict === "behind" || slipDays > 0;
  // Held work, and the overdue among it, said once: "8 overdue, 1 on hold".
  // Every phase on its own line when the project is split and all are picked.
  const byPhase = usePhaseStandings(projectId, nowMs);
  // The work is finished: when, and how late against the plan. Never a
  // forecast, and never "on plan" beside a late finish.
  const finished = r.allDone;
  const finLate = finished ? (linked ? slipH : r.finishedAt && plannedEndAt ? (Date.parse(r.finishedAt) - Date.parse(plannedEndAt)) / 3_600_000 : null) : null;
  const finWords = lateWords(finLate == null ? null : Math.round(finLate * 10) / 10);
  const finIsLate = (finLate ?? 0) >= 0.5;
  const parts = finished ? null : verdictParts(r);
  const held = r.onHold + r.blocked;
  const heldWord = [r.onHold ? `${r.onHold} on hold` : null, r.blocked ? `${r.blocked} blocked` : null].filter(Boolean).join(", ");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Completion + SPI */}
      <div className="lg:col-span-2 bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
        {byPhase ? <div className="mb-3"><PhaseLines rows={byPhase} /></div> : (
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Completion</div>
            <div className="text-3xl font-black text-[var(--color-text)] leading-none mt-1">
              {earnedPct}<span className="text-base text-[var(--color-text-muted)] font-bold">%</span>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">{finished ? `Work done · ${r.done} of ${r.totalLeaves} steps` : `Work done · plan by now ${planPct}%`}</div>
          </div>
          {/* Finished: when and how late is on the card beside this, once. */}
          {finished ? null : (
          <div className="text-right">
            <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">SPI</div>
            <div className={`text-3xl font-black leading-none mt-1 ${verdict === "behind" ? "text-rose-600 dark:text-rose-400" : verdict === "ahead" ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>
              {spi.toFixed(2)}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1 inline-flex items-center gap-1 justify-end">
              {verdict === "behind" ? <TrendingDown className="w-3 h-3 text-rose-600 dark:text-rose-400" /> : <TrendingUp className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />}
              {verdict === "behind" ? `${fmtH(gapH)} behind plan` : verdict === "ahead" ? `${fmtH(gapH)} ahead of plan` : "on plan"}
            </div>
            {parts && <div className="text-[11px] text-[var(--color-text-muted)]" data-verdict-parts>{parts}</div>}
          </div>
          )}
        </div>
        )}

        {/* Stacked progress bar — leaves-only counts, matching the metrics. */}
        <StackedBar counts={metrics.byStatus} />

        {/* Status legend */}
        <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-1.5 text-[11px]">
          {(Object.keys(STATUS_META) as MilestoneStatus[]).map((s) => {
            const meta = STATUS_META[s];
            const Icon = meta.Icon;
            const n = metrics.byStatus[s] ?? 0;
            return (
              <div key={s} className={`rounded-md border border-[var(--color-border)] px-1.5 py-1 ${n > 0 ? "" : "opacity-50"}`}>
                <div className={`inline-flex items-center gap-1 font-bold ${meta.tone}`}>
                  <Icon className="w-3 h-3" /> {n}
                </div>
                <div className="text-[12px] text-[var(--color-text-muted)]">{meta.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right column: forecast + upcoming */}
      <div className="space-y-3">
        {/* Forecast / slip card. All phases: each phase's line has its own. */}
        <div className={`rounded-2xl p-4 border ${
          byPhase ? "bg-[var(--color-surface)] border-[var(--color-border)]"
          : (finished ? finIsLate : late)
            ? "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800"
            : forecastEndAt || finished
              ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800"
              : "bg-[var(--color-surface-2)] border-[var(--color-border)]"
        }`}>
          {byPhase ? (
            <>
              <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Needs you</div>
              {overdue.length === 0 && held === 0 && <div className="text-[13px] font-bold text-[var(--color-text)] mt-1">Nothing overdue or held</div>}
            </>
          ) : finished ? (
            <>
              <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Finished</div>
              <div className="text-lg font-black text-[var(--color-text)] mt-1">{r.finishedAt ? humanDateTime(r.finishedAt, tz) : "-"}</div>
              <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${finIsLate ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}`}>
                {finIsLate ? <AlertTriangle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                {[finWords, plannedEndAt ? `planned ${humanDateTime(plannedEndAt, tz)}` : null].filter(Boolean).join(" · ")}
              </div>
            </>
          ) : (
            <>
          <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Forecast end</div>
          <div className="text-lg font-black text-[var(--color-text)] mt-1">
            {forecastEndAt ? (linked ? humanDateTime(forecastEndAt, tz) : humanDate(forecastEndAt, tz)) : plannedEndAt ? humanDate(plannedEndAt, tz) : "-"}
          </div>
          <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${late ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}`}>
            {linked
              ? (slipH >= 0.5 ? <><AlertTriangle className="w-3 h-3" /> {fmtH(slipH)} late</> : slipH <= -0.5 ? <><CheckCircle2 className="w-3 h-3" /> {fmtH(-slipH)} early</> : <><CheckCircle2 className="w-3 h-3" /> On plan</>)
              : late
                ? <><AlertTriangle className="w-3 h-3" /> {!forecastEndAt ? "Behind - no work recorded yet to forecast from" : slipDays > 0 ? `${slipDays}d slip vs plan` : "Behind plan - under a day of slip so far"}</>
                : plannedEndAt ? <><CheckCircle2 className="w-3 h-3" /> On plan</> : "Plan not yet set"
            }
          </div>
            </>
          )}
          {(overdue.length > 0 || held > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-1 text-[11.5px] font-bold">
              <AlertTriangle className="w-3 h-3 text-rose-700 dark:text-rose-300" />
              {overdue.length > 0 && (onShowOverdue
                ? <button type="button" onClick={onShowOverdue} className="text-rose-700 dark:text-rose-300 underline decoration-dotted underline-offset-2 hover:decoration-solid" title="Show the overdue work">{overdue.length} overdue</button>
                : <span className="text-rose-700 dark:text-rose-300">{overdue.length} overdue</span>)}
              {overdue.length > 0 && held > 0 && <span className="text-[var(--color-text-muted)]">,</span>}
              {held > 0 && (onShowBlocked
                ? <button type="button" onClick={onShowBlocked} className="text-amber-700 dark:text-amber-300 underline decoration-dotted underline-offset-2 hover:decoration-solid" title="Review the held work">{heldWord}</button>
                : <span className="text-amber-700 dark:text-amber-300">{heldWord}</span>)}
            </div>
          )}
        </div>

        {/* Upcoming card */}
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[12px] font-semibold text-[var(--color-text-muted)]">Next 14 days</div>
            <div className="text-[10px] text-[var(--color-text-faint)]">{upcoming.length}</div>
          </div>
          {upcoming.length === 0 ? (
            <div className="text-[11px] text-[var(--color-text-faint)] italic">Nothing scheduled.</div>
          ) : (
            <ul className="space-y-1">
              {upcoming.map(({ m, due }) => (
                <li key={m.id} className="flex items-start gap-2 text-xs">
                  <Flag className={`w-3 h-3 mt-0.5 shrink-0 ${STATUS_META[m.status].tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-[var(--color-text)] truncate">{m.name}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)] inline-flex items-center gap-1">
                      <CalendarClock className="w-2.5 h-2.5" /> {humanRelative(due, tz)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-[10px] text-[var(--color-text-muted)] italic px-1">
          {total} milestone{total === 1 ? "" : "s"} total
        </div>
      </div>
    </div>
  );
}

function StackedBar({ counts }: { counts: Record<MilestoneStatus, number> }) {
  const total = (Object.values(counts).reduce((a, b) => a + b, 0)) || 1;
  const order: MilestoneStatus[] = ["completed", "in_progress", "planned", "on_hold", "blocked", "missed"];
  return (
    <div className="h-2 w-full rounded-full bg-[var(--color-surface-2)] overflow-hidden flex">
      {order.map((s) => {
        const pct = (counts[s] / total) * 100;
        if (pct === 0) return null;
        return <div key={s} style={{ width: `${pct}%` }} className={`${STATUS_META[s].bar} transition-all`} title={`${STATUS_META[s].label}: ${counts[s]}`} />;
      })}
    </div>
  );
}

// Planned/forecast dates are shown in the plant's zone so the day matches
// the schedule for every viewer.
function humanDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return fmtInTz(d, tz, { year: "numeric", month: "short", day: "numeric" });
}

function humanRelative(d: Date, tz: string): string {
  // Compare on plant day boundaries so "today"/"tomorrow" line up with the
  // dates rendered beside them.
  const diff = dayDiffTz(Date.now(), d.getTime(), tz);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return `in ${diff} days`;
  return fmtInTz(d, tz, { month: "short", day: "numeric" });
}

/** "19 h", "1.5 h". */
function fmtH(h: number): string { return `${Math.round(h * 10) / 10} h`; }

/** "Sun, Nov 1, 7:00 PM" in plant time. */
function humanDateTime(iso: string, tz: string): string {
  const t = Date.parse(iso);
  return `${fmtInTz(t, tz, { weekday: "short", month: "short", day: "numeric" })}, ${clockLabel(t, tz)}`;
}
