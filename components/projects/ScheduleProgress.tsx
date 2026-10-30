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
//
// Pure render — no fetches. Drives off the metrics already computed
// by lib/milestones.ts:computeScheduleMetrics().

import React, { useState } from "react";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { dayDiff as dayDiffTz, fmtInTz } from "@/lib/scheduleTz";
import { isOverdue, standingOf } from "@/lib/shiftReport";
import { computeExecutionReport } from "@/lib/executionReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
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

export default function ScheduleProgress({ milestones, metrics, projectId }: Props) {
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
  const verdict = standingOf(earnedPct, planPct);
  // Forecast from the same report as the verdict above: the finish at the
  // pace so far, against the planned finish (whole plant days).
  const forecastEndAt = r.forecastFinish;
  const plannedEndAt = r.finish;
  const slipDays = forecastEndAt && plannedEndAt
    ? Math.max(0, dayDiffTz(Date.parse(plannedEndAt), Date.parse(forecastEndAt), tz))
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Completion + SPI */}
      <div className="lg:col-span-2 bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Completion</div>
            <div className="text-3xl font-black text-[var(--color-text)] leading-none mt-1">
              {earnedPct}<span className="text-base text-[var(--color-text-muted)] font-bold">%</span>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">Work done · plan by now {planPct}%</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">SPI</div>
            <div className={`text-3xl font-black leading-none mt-1 ${verdict === "behind" ? "text-rose-600 dark:text-rose-400" : verdict === "ahead" ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>
              {spi.toFixed(2)}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1 inline-flex items-center gap-1 justify-end">
              {verdict === "behind" ? <TrendingDown className="w-3 h-3 text-rose-600 dark:text-rose-400" /> : <TrendingUp className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />}
              {verdict === "behind" ? "behind plan" : verdict === "ahead" ? "ahead of plan" : "on plan"}
            </div>
          </div>
        </div>

        {/* Stacked progress bar — leaves-only counts, matching the metrics. */}
        <StackedBar counts={metrics.byStatus} />

        {/* Status legend */}
        <div className="mt-3 grid grid-cols-5 gap-1.5 text-[11px]">
          {(Object.keys(STATUS_META) as MilestoneStatus[]).map((s) => {
            const meta = STATUS_META[s];
            const Icon = meta.Icon;
            const n = metrics.byStatus[s] ?? 0;
            return (
              <div key={s} className={`rounded-md border border-[var(--color-border)] px-1.5 py-1 ${n > 0 ? "" : "opacity-50"}`}>
                <div className={`inline-flex items-center gap-1 font-bold ${meta.tone}`}>
                  <Icon className="w-3 h-3" /> {n}
                </div>
                <div className="text-[9px] text-[var(--color-text-muted)] uppercase tracking-wider">{meta.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right column: forecast + upcoming */}
      <div className="space-y-3">
        {/* Forecast / slip card */}
        <div className={`rounded-2xl p-4 border ${
          verdict === "behind" || slipDays > 0
            ? "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800"
            : forecastEndAt
              ? "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800"
              : "bg-[var(--color-surface-2)] border-[var(--color-border)]"
        }`}>
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Forecast end</div>
          <div className="text-lg font-black text-[var(--color-text)] mt-1">
            {forecastEndAt ? humanDate(forecastEndAt, tz) : plannedEndAt ? humanDate(plannedEndAt, tz) : "-"}
          </div>
          {/* Follows the verdict on the left — never "on track" while behind. */}
          <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${verdict === "behind" || slipDays > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}`}>
            {verdict === "behind" || slipDays > 0
              ? <><AlertTriangle className="w-3 h-3" /> {!forecastEndAt ? "Behind - no work recorded yet to forecast from" : slipDays > 0 ? `${slipDays}d slip vs plan` : "Behind plan - under a day of slip so far"}</>
              : plannedEndAt ? <><CheckCircle2 className="w-3 h-3" /> On track</> : "Plan not yet set"
            }
          </div>
          {overdue.length > 0 && (
            <div className="mt-2 text-[11px] font-bold text-rose-700 dark:text-rose-300 inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {overdue.length} overdue
            </div>
          )}
        </div>

        {/* Upcoming card */}
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">Next 14 days</div>
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
