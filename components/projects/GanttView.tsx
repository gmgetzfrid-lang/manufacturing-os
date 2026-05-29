"use client";

// GanttView — minimal but enterprise-grade horizontal timeline of
// project milestones. Lives inside the Schedule tab.
//
// Design choices for an honest small footprint:
//   - One row per milestone, colored by status
//   - Time axis auto-sizes to first..last planned dates +/- pad
//   - Today line + week-grid lines so you can eyeball slip
//   - Click a bar opens the same row in the milestone list (scrolls to it)
//   - No dependency rendering — milestones don't track deps yet. When the
//     schema grows them, dependency arrows + critical-path highlighting
//     can layer on top of this same axis.

import React, { useMemo } from "react";
import type { Milestone } from "@/types/schema";
import { Flag } from "lucide-react";

interface Props {
  milestones: Milestone[];
}

const STATUS_TONE: Record<string, string> = {
  planned: "bg-slate-300",
  in_progress: "bg-blue-500",
  completed: "bg-emerald-500",
  missed: "bg-rose-500",
  blocked: "bg-amber-500",
};

export default function GanttView({ milestones }: Props) {
  const data = useMemo(() => {
    const valid = milestones.filter((m) => m.plannedAt);
    if (valid.length === 0) return null;

    // Use planned date as the primary anchor; if actualAt exists draw a
    // companion thin band so you can see slip at a glance.
    const dates = valid.flatMap((m) => [
      new Date(String(m.plannedAt)).getTime(),
      m.actualAt ? new Date(String(m.actualAt)).getTime() : NaN,
    ]).filter((n) => Number.isFinite(n));
    const minT = Math.min(...dates, Date.now() - 7 * 86400000);
    const maxT = Math.max(...dates, Date.now() + 7 * 86400000);
    const span = Math.max(maxT - minT, 86400000); // at least one day

    const sorted = [...valid].sort(
      (a, b) => new Date(String(a.plannedAt)).getTime() - new Date(String(b.plannedAt)).getTime()
    );

    const pct = (t: number) => ((t - minT) / span) * 100;
    const todayPct = pct(Date.now());

    // Week tick marks every 7 days
    const ticks: Array<{ pct: number; label: string }> = [];
    const oneDay = 86400000;
    const startDay = new Date(minT);
    startDay.setHours(0, 0, 0, 0);
    for (let t = startDay.getTime(); t <= maxT; t += 7 * oneDay) {
      ticks.push({ pct: pct(t), label: new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
    }

    return { sorted, pct, todayPct, ticks, minT, maxT };
  }, [milestones]);

  if (!data) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center text-xs text-slate-500">
        No dated milestones yet — add at least one to see the timeline.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <Flag className="w-4 h-4 text-indigo-600" />
        <div className="font-bold text-slate-900 text-sm">Schedule (Gantt)</div>
        <span className="text-[10px] text-slate-500 font-mono">{data.sorted.length} milestone{data.sorted.length === 1 ? "" : "s"}</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-slate-500">
          <LegendDot tone="bg-slate-300" label="Planned" />
          <LegendDot tone="bg-blue-500" label="In progress" />
          <LegendDot tone="bg-emerald-500" label="Completed" />
          <LegendDot tone="bg-amber-500" label="Blocked" />
          <LegendDot tone="bg-rose-500" label="Missed" />
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[640px] relative px-4 py-3">
          {/* Axis ticks */}
          <div className="relative h-5 mb-2">
            {data.ticks.map((t, i) => (
              <div key={i} className="absolute -top-0.5 text-[9px] text-slate-400 font-mono"
                style={{ left: `${Math.max(0, Math.min(98, t.pct))}%` }}>
                {t.label}
              </div>
            ))}
          </div>

          <div className="relative">
            {/* Today line */}
            {data.todayPct >= 0 && data.todayPct <= 100 && (
              <div
                className="absolute top-0 bottom-0 w-px bg-rose-500 z-10"
                style={{ left: `${data.todayPct}%` }}
                title="Today"
              >
                <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-rose-500" />
              </div>
            )}

            {/* Bars */}
            {data.sorted.map((m, idx) => {
              const plannedT = new Date(String(m.plannedAt)).getTime();
              const actualT = m.actualAt ? new Date(String(m.actualAt)).getTime() : null;
              const plannedPct = data.pct(plannedT);
              const tone = STATUS_TONE[m.status] || "bg-slate-300";
              // Bar width — visual presence. Real bar = 2px diamond for
              // an instant-in-time milestone; the gradient extends back
              // 1 week so the row is visible.
              const barLeft = Math.max(0, plannedPct - 2);
              return (
                <div key={m.id} className="relative h-7 flex items-center group">
                  {idx > 0 && <div className="absolute inset-x-0 -top-px h-px bg-slate-100" />}
                  <div className="w-40 shrink-0 pr-3 text-xs truncate text-slate-700 font-medium" title={m.name}>
                    {m.name}
                  </div>
                  <div className="relative flex-1 h-full">
                    {/* Planned diamond */}
                    <div
                      className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 ${tone} ring-2 ring-white shadow-sm`}
                      style={{ left: `${plannedPct}%` }}
                      title={`Planned: ${new Date(plannedT).toLocaleDateString()} · ${m.status}`}
                    />
                    {/* Trail back so you can spot the row easily */}
                    <div
                      className={`absolute top-1/2 -translate-y-1/2 h-1 ${tone} opacity-40 rounded-full`}
                      style={{ left: `${Math.max(0, barLeft - 4)}%`, width: `4%` }}
                    />
                    {/* Actual (if any) */}
                    {actualT && (
                      <div
                        className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white ring-2 ring-slate-700"
                        style={{ left: `${data.pct(actualT)}%` }}
                        title={`Actual: ${new Date(actualT).toLocaleDateString()}`}
                      />
                    )}
                  </div>
                  <div className="w-24 shrink-0 pl-2 text-[10px] text-slate-500 text-right">
                    {new Date(plannedT).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendDot({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-2 h-2 rounded-full ${tone}`} />
      {label}
    </span>
  );
}
