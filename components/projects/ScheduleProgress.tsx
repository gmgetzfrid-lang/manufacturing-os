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
import { Card } from "@/components/ui/PageHero";
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
  /** A row on top of the first card (the Plan tab's toolbar). */
  head?: React.ReactNode;
  /** Inside another card: plain sections, not cards of their own. */
  bare?: boolean;
}

const LABEL = "text-body font-medium text-[var(--color-text-muted)] mb-2";

const STATUS_META: Record<MilestoneStatus, { label: string; tone: string; bar: string; Icon: React.ComponentType<{ className?: string }> }> = {
  // The same colours as the timeline and calendar dots.
  planned:     { label: "Planned",     tone: "text-slate-600 dark:text-slate-300",  bar: "bg-[var(--color-border-strong)]",   Icon: Circle },
  in_progress: { label: "In progress", tone: "text-[var(--color-text)] dark:text-[var(--color-text)]",    bar: "bg-[var(--color-main)]/55",    Icon: PauseCircle },
  completed:   { label: "Completed",   tone: "text-[var(--state-released-text)]", bar: "bg-[var(--color-main)]", Icon: CheckCircle2 },
  missed:      { label: "Missed",      tone: "text-[var(--state-overdue-text)]",    bar: "bg-[var(--state-overdue)]",    Icon: XCircle },
  blocked:     { label: "Blocked",     tone: "text-[var(--state-overdue-text)]",    bar: "bg-[var(--state-overdue)]",    Icon: MinusCircle },
  on_hold:     { label: "On hold",     tone: "text-[var(--state-held-text)]",   bar: "bg-[var(--state-held)]",   Icon: PauseCircle },
};

export default function ScheduleProgress({ milestones, metrics, projectId, onShowOverdue, onShowBlocked, head, bare }: Props) {
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

  const verdictTone = verdict === "behind" ? "text-[var(--state-overdue-text)]" : verdict === "ahead" ? "text-[var(--state-released-text)]" : "text-[var(--color-text-muted)]";

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-3 ${bare ? "gap-x-6 gap-y-4" : "gap-4"}`}>
      {/* How far along: each phase on its own line, or the job's one sentence. */}
      <Box bare={bare} className="lg:col-span-2" label={head ? undefined : byPhase ? undefined : "Progress"}>
        {head && <div className="mb-4 pb-3 border-b border-[var(--color-border)]">{head}</div>}
        {byPhase ? <div className="mb-3"><PhaseLines rows={byPhase} /></div> : (
          <div className="mb-3">
            {head && <div className={LABEL}>Progress</div>}
            <p className="text-reading font-medium text-[var(--color-text)] tabular-nums">
              {earnedPct}% done
              <span className="font-medium text-[var(--color-text-muted)]">{finished ? ` · ${r.done} of ${r.totalLeaves} steps` : ` · plan by now ${planPct}%`}</span>
            </p>
            {/* Finished: when and how late is on the card beside this, once. */}
            {!finished && (
              <p className="mt-0.5 text-body text-[var(--color-text-muted)] inline-flex flex-wrap items-center gap-x-1.5">
                <span className={`inline-flex items-center gap-1 font-medium ${verdictTone}`}>
                  {verdict === "behind" ? <TrendingDown className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
                  {verdict === "behind" ? `${fmtH(gapH)} behind plan` : verdict === "ahead" ? `${fmtH(gapH)} ahead of plan` : "On plan"}
                </span>
                <span>· SPI <b className="text-[var(--color-text)] tabular-nums">{spi.toFixed(2)}</b></span>
                {parts && <span data-verdict-parts>· {parts}</span>}
              </p>
            )}
          </div>
        )}

        {/* Stacked progress bar — leaves-only counts, matching the metrics. */}
        <StackedBar counts={metrics.byStatus} />

        {/* The counts in one row: zero is faint, colour only where it's off. */}
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-caption" aria-label="Steps by status">
          {(Object.keys(STATUS_META) as MilestoneStatus[]).map((s) => {
            const meta = STATUS_META[s];
            const n = metrics.byStatus[s] ?? 0;
            return (
              <li key={s} className={`inline-flex items-center gap-1.5 ${n > 0 ? "" : "opacity-50"}`}>
                <span aria-hidden className={`w-2 h-2 rounded-full ${meta.bar}`} />
                <b className={`tabular-nums ${n > 0 && s !== "planned" && s !== "in_progress" ? meta.tone : "text-[var(--color-text)]"}`}>{n}</b>
                <span className="text-[var(--color-text-muted)]">{meta.label.toLowerCase()}</span>
              </li>
            );
          })}
        </ul>
      </Box>

      {/* What needs you, when it ends, and what's coming: one card. */}
      <Box bare={bare} label={byPhase ? "Needs you" : finished ? "Finished" : "Forecast end"}>
          {byPhase ? (
            overdue.length === 0 && held === 0 ? <div className="text-body font-medium text-[var(--color-text)]">Nothing overdue or held</div> : null
          ) : finished ? (
            <>
              <div className="text-body font-medium text-[var(--color-text)]">{r.finishedAt ? humanDateTime(r.finishedAt, tz) : "-"}</div>
              <div className={`text-caption mt-0.5 inline-flex items-center gap-1 ${finIsLate ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--state-released-text)]"}`}>
                {finIsLate ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {[finWords, plannedEndAt ? `planned ${humanDateTime(plannedEndAt, tz)}` : null].filter(Boolean).join(" · ")}
              </div>
            </>
          ) : (
            <>
          <div className="text-body font-medium text-[var(--color-text)]">
            {forecastEndAt ? (linked ? humanDateTime(forecastEndAt, tz) : humanDate(forecastEndAt, tz)) : plannedEndAt ? humanDate(plannedEndAt, tz) : "-"}
          </div>
          <div className={`text-caption mt-0.5 inline-flex items-center gap-1 ${late ? "text-[var(--state-overdue-text)] font-medium" : "text-[var(--state-released-text)]"}`}>
            {linked
              ? (slipH >= 0.5 ? <><AlertTriangle className="w-3.5 h-3.5" /> {fmtH(slipH)} late</> : slipH <= -0.5 ? <><CheckCircle2 className="w-3.5 h-3.5" /> {fmtH(-slipH)} early</> : <><CheckCircle2 className="w-3.5 h-3.5" /> On plan</>)
              : late
                ? <><AlertTriangle className="w-3.5 h-3.5" /> {!forecastEndAt ? "Behind: no work recorded yet to forecast from" : slipDays > 0 ? `${slipDays}d slip vs plan` : "Behind plan: under a day of slip so far"}</>
                : plannedEndAt ? <><CheckCircle2 className="w-3.5 h-3.5" /> On plan</> : "Plan not yet set"
            }
          </div>
            </>
          )}
          {(overdue.length > 0 || held > 0) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1 text-body font-medium">
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--state-overdue-text)]" />
              {overdue.length > 0 && (onShowOverdue
                ? <button type="button" onClick={onShowOverdue} className="text-[var(--state-overdue-text)] underline decoration-dotted underline-offset-2 hover:decoration-solid" title="Show the overdue work">{overdue.length} overdue</button>
                : <span className="text-[var(--state-overdue-text)]">{overdue.length} overdue</span>)}
              {overdue.length > 0 && held > 0 && <span className="text-[var(--color-text-muted)]">,</span>}
              {held > 0 && (onShowBlocked
                ? <button type="button" onClick={onShowBlocked} className="text-[var(--state-held-text)] underline decoration-dotted underline-offset-2 hover:decoration-solid" title="Review the held work">{heldWord}</button>
                : <span className="text-[var(--state-held-text)]">{heldWord}</span>)}
            </div>
          )}

        {/* What's coming up, under a hairline. */}
        <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
          <div className="flex items-baseline justify-between mb-1.5">
            <div className={LABEL.replace(" mb-2", "")}>Next 14 days</div>
            {upcoming.length > 0 && <div className="text-caption text-[var(--color-text-muted)] tabular-nums">{upcoming.length}</div>}
          </div>
          {upcoming.length === 0 ? (
            <div className="text-body text-[var(--color-text-muted)]">Nothing scheduled.</div>
          ) : (
            <ul className="space-y-1.5">
              {upcoming.map(({ m, due }) => (
                <li key={m.id} className="flex items-start gap-2 text-body">
                  <Flag className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${STATUS_META[m.status].tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[var(--color-text)] truncate">{m.name}</div>
                    <div className="text-caption text-[var(--color-text-muted)] inline-flex items-center gap-1">
                      <CalendarClock className="w-3 h-3" /> {humanRelative(due, tz)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!head && <div className="mt-2 text-caption text-[var(--color-text-muted)]">{total} task{total === 1 ? "" : "s"} on the schedule</div>}
        </div>
      </Box>
    </div>
  );
}

/** A card on the paper; inside another card (the Work tab's), a plain
 *  section: no boxes in boxes. */
function Box({ bare, label, className = "", children }: { bare?: boolean; label?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return bare
    ? <div className={className}>{label && <div className={LABEL}>{label}</div>}{children}</div>
    : <Card label={label} className={className}>{children}</Card>;
}

function StackedBar({ counts }: { counts: Record<MilestoneStatus, number> }) {
  const total = (Object.values(counts).reduce((a, b) => a + b, 0)) || 1;
  const order: MilestoneStatus[] = ["completed", "in_progress", "planned", "on_hold", "blocked", "missed"];
  return (
    <div className="h-2 w-full rounded-full bg-[var(--color-accent-soft)] overflow-hidden flex">
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
