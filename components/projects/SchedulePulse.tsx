"use client";

// SchedulePulse — the at-a-glance "what needs you right now" strip at
// the top of the Execution board. This is the autonomy layer: instead
// of making the user hunt, the tool proactively surfaces the few facts
// that should change a decision today — overdue work, active blockers,
// falling behind pace, and drift from the approved plan — each as a
// one-tap action that filters/opens the relevant work.
//
// It stays quiet when there's nothing urgent (a single calm "on track"
// line), so it informs without nagging.

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, PauseCircle, TrendingDown, CalendarClock, CheckCircle2, ArrowRight } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { computeExecutionReport } from "@/lib/executionReport";
import { standingOf, type ShiftTimes } from "@/lib/shiftReport";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";

interface Props {
  milestones: Milestone[];
  /** Jump to a filtered view (the board applies it). */
  onShowOverdue: () => void;
  onShowBlocked: () => void;
  /** Shift-change times — "expected by now" runs on each step's own shift. */
  shiftTimes?: ShiftTimes;
}

export default function SchedulePulse({ milestones, onShowOverdue, onShowBlocked, shiftTimes }: Props) {
  const tz = useScheduleTz();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const r = useMemo(() => computeExecutionReport(milestones, { tz, shiftTimes, now: new Date(now) }), [milestones, tz, shiftTimes, now]);
  if (r.totalLeaves === 0) return null;

  const items: React.ReactNode[] = [];

  if (r.overdue > 0) {
    items.push(
      <Nudge key="overdue" tone="rose" icon={<AlertTriangle className="w-4 h-4" />} onClick={onShowOverdue}
        text={<><b>{r.overdue}</b> overdue {r.overdue === 1 ? "task" : "tasks"}</>} cta="Show" />,
    );
  }
  if (r.blocked + r.onHold > 0) {
    items.push(
      <Nudge key="blocked" tone="amber" icon={<PauseCircle className="w-4 h-4" />} onClick={onShowBlocked}
        text={<><b>{r.blocked + r.onHold}</b> stuck - {r.blocked} blocked, {r.onHold} on hold</>} cta="Review" />,
    );
  }
  if (standingOf(r.pctComplete, r.expectedPct) === "behind") {
    items.push(
      <Nudge key="pace" tone="rose" icon={<TrendingDown className="w-4 h-4" />}
        text={<><b>{Math.abs(r.paceDelta)} pts</b> behind pace ({r.pctComplete}% done, expected {r.expectedPct}%)</>} />,
    );
  }
  if (r.baseline && r.baseline.finishDriftDays > 0) {
    items.push(
      <Nudge key="drift" tone="amber" icon={<CalendarClock className="w-4 h-4" />}
        text={<>Finish has slipped <b>{r.baseline.finishDriftDays}d</b> from the approved plan</>} />,
    );
  }

  const calm = items.length === 0;

  return (
    <div className={`rounded-2xl border shadow-sm px-4 py-2.5 flex items-center gap-3 flex-wrap ${calm ? "border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30" : "border-[var(--color-border)] bg-[var(--color-surface)] ring-1 ring-slate-900/[0.03]"}`}>
      {calm ? (
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="w-4 h-4" /> On track - nothing needs attention right now.
        </span>
      ) : (
        <>
          <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] shrink-0">Needs you</span>
          {items}
        </>
      )}
    </div>
  );
}

function Nudge({ tone, icon, text, cta, onClick }: {
  tone: "rose" | "amber"; icon: React.ReactNode; text: React.ReactNode; cta?: string; onClick?: () => void;
}) {
  const c = tone === "rose" ? "text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800" : "text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800";
  const content = (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] ${c}`}>
      {icon}{text}
      {cta && onClick && <span className="inline-flex items-center gap-0.5 font-bold ml-1">{cta} <ArrowRight className="w-3 h-3" /></span>}
    </span>
  );
  return onClick ? <button onClick={onClick} className="hover:brightness-95 transition">{content}</button> : content;
}
