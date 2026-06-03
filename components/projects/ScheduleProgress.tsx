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

import React from "react";
import {
  TrendingUp, TrendingDown, Flag, AlertTriangle, CalendarClock,
  CheckCircle2, Circle, PauseCircle, MinusCircle, XCircle,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { ScheduleMetrics } from "@/lib/milestones";

interface Props {
  milestones: Milestone[];
  metrics: ScheduleMetrics;
}

const STATUS_META: Record<MilestoneStatus, { label: string; tone: string; bar: string; Icon: React.ComponentType<{ className?: string }> }> = {
  planned:     { label: "Planned",     tone: "text-blue-700",    bar: "bg-blue-400",    Icon: Circle },
  in_progress: { label: "In progress", tone: "text-amber-700",   bar: "bg-amber-400",   Icon: PauseCircle },
  completed:   { label: "Completed",   tone: "text-emerald-700", bar: "bg-emerald-500", Icon: CheckCircle2 },
  missed:      { label: "Missed",      tone: "text-rose-700",    bar: "bg-rose-500",    Icon: XCircle },
  blocked:     { label: "Blocked",     tone: "text-purple-700",  bar: "bg-purple-500",  Icon: MinusCircle },
  on_hold:     { label: "On hold",     tone: "text-amber-700",   bar: "bg-amber-500",   Icon: PauseCircle },
};

export default function ScheduleProgress({ milestones, metrics }: Props) {
  const total = milestones.length;
  const today = new Date(); today.setHours(0,0,0,0);
  const in14 = new Date(today.getTime() + 14 * 86400000);
  const upcoming = milestones
    .filter((m) => m.status !== "completed" && m.plannedAt)
    .map((m) => ({ m, due: new Date(m.plannedAt as string) }))
    .filter((x) => x.due >= today && x.due <= in14)
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .slice(0, 5);
  const overdue = milestones.filter((m) => {
    if (m.status === "completed") return false;
    if (!m.plannedAt) return false;
    return new Date(m.plannedAt as string).getTime() < today.getTime();
  });

  const spiPercent = Math.round(metrics.spi * 100);
  const earnedPct = Math.round(metrics.percentEarned * 100);
  const planPct = Math.round(metrics.percentPlanned * 100);
  const slipDays = metrics.plannedEndAt && metrics.forecastEndAt
    ? Math.round((new Date(metrics.forecastEndAt).getTime() - new Date(metrics.plannedEndAt).getTime()) / 86400000)
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Completion + SPI */}
      <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Completion</div>
            <div className="text-3xl font-black text-slate-900 leading-none mt-1">
              {earnedPct}<span className="text-base text-slate-500 font-bold">%</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1">Earned weight · planned was {planPct}%</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">SPI</div>
            <div className={`text-3xl font-black leading-none mt-1 ${metrics.spi >= 1 ? "text-emerald-600" : metrics.spi >= 0.9 ? "text-amber-600" : "text-rose-600"}`}>
              {metrics.spi.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1 inline-flex items-center gap-1 justify-end">
              {metrics.spi >= 1 ? <TrendingUp className="w-3 h-3 text-emerald-600" /> : <TrendingDown className="w-3 h-3 text-rose-600" />}
              {metrics.spi >= 1 ? "on / ahead" : "behind plan"}
            </div>
          </div>
        </div>

        {/* Stacked progress bar */}
        <StackedBar milestones={milestones} />

        {/* Status legend */}
        <div className="mt-3 grid grid-cols-5 gap-1.5 text-[11px]">
          {(Object.keys(STATUS_META) as MilestoneStatus[]).map((s) => {
            const meta = STATUS_META[s];
            const Icon = meta.Icon;
            const n = metrics.byStatus[s] ?? 0;
            return (
              <div key={s} className={`rounded-md border border-slate-200 px-1.5 py-1 ${n > 0 ? "" : "opacity-50"}`}>
                <div className={`inline-flex items-center gap-1 font-bold ${meta.tone}`}>
                  <Icon className="w-3 h-3" /> {n}
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-wider">{meta.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right column: forecast + upcoming */}
      <div className="space-y-3">
        {/* Forecast / slip card */}
        <div className={`rounded-2xl p-4 border ${
          slipDays > 0
            ? "bg-rose-50 border-rose-200"
            : metrics.forecastEndAt
              ? "bg-emerald-50 border-emerald-200"
              : "bg-slate-50 border-slate-200"
        }`}>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-600">Forecast end</div>
          <div className="text-lg font-black text-slate-900 mt-1">
            {metrics.forecastEndAt ? humanDate(metrics.forecastEndAt) : metrics.plannedEndAt ? humanDate(metrics.plannedEndAt) : "—"}
          </div>
          <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${slipDays > 0 ? "text-rose-700" : "text-emerald-700"}`}>
            {slipDays > 0
              ? <><AlertTriangle className="w-3 h-3" /> {slipDays}d slip vs plan</>
              : metrics.forecastEndAt ? <><CheckCircle2 className="w-3 h-3" /> On track</> : "Plan not yet set"
            }
          </div>
          {overdue.length > 0 && (
            <div className="mt-2 text-[11px] font-bold text-rose-700 inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {overdue.length} overdue
            </div>
          )}
        </div>

        {/* Upcoming card */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-baseline justify-between mb-2">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Next 14 days</div>
            <div className="text-[10px] text-slate-400">{upcoming.length}</div>
          </div>
          {upcoming.length === 0 ? (
            <div className="text-[11px] text-slate-400 italic">Nothing scheduled.</div>
          ) : (
            <ul className="space-y-1">
              {upcoming.map(({ m, due }) => (
                <li key={m.id} className="flex items-start gap-2 text-xs">
                  <Flag className={`w-3 h-3 mt-0.5 shrink-0 ${STATUS_META[m.status].tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-slate-900 truncate">{m.name}</div>
                    <div className="text-[10px] text-slate-500 inline-flex items-center gap-1">
                      <CalendarClock className="w-2.5 h-2.5" /> {humanRelative(due)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-[10px] text-slate-500 italic px-1">
          {total} milestone{total === 1 ? "" : "s"} total
        </div>
      </div>
    </div>
  );
}

function StackedBar({ milestones }: { milestones: Milestone[] }) {
  const total = milestones.length || 1;
  const counts: Record<MilestoneStatus, number> = { planned: 0, in_progress: 0, completed: 0, missed: 0, blocked: 0, on_hold: 0 };
  for (const m of milestones) counts[m.status]++;
  const order: MilestoneStatus[] = ["completed", "in_progress", "planned", "on_hold", "blocked", "missed"];
  return (
    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden flex">
      {order.map((s) => {
        const pct = (counts[s] / total) * 100;
        if (pct === 0) return null;
        return <div key={s} style={{ width: `${pct}%` }} className={`${STATUS_META[s].bar} transition-all`} title={`${STATUS_META[s].label}: ${counts[s]}`} />;
      })}
    </div>
  );
}

function humanDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function humanRelative(d: Date): string {
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff < 7) return `in ${diff} days`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
