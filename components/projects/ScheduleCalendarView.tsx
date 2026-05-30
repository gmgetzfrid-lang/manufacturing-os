"use client";

// ScheduleCalendarView — month-grid view of project milestones,
// Outlook/Google-style. Each milestone renders as a colored pill
// on its planned date.
//
// Interactions:
//   * Drag a milestone to another day → updates plannedAt
//   * Click the pill → cycles status (planned → in_progress →
//     completed → planned)
//   * Hover → tooltip with full details
//   * Month navigation up top
//   * "Today" jump button
//
// Read-only for non-editors (drag handlers disabled).

import React, { useCallback, useMemo, useState } from "react";
import {
  ChevronLeft, ChevronRight, CalendarDays,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  canEdit: boolean;
  /** Returns true if the move succeeded (so the optimistic UI can
   *  hold). Caller is responsible for the database write. */
  onMove?: (id: string, newPlannedAt: string) => Promise<boolean>;
  onCycleStatus?: (id: string, current: MilestoneStatus) => void;
}

const STATUS_TONE: Record<MilestoneStatus, string> = {
  planned:     "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-200",
  in_progress: "bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200",
  completed:   "bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-200 line-through opacity-80",
  missed:      "bg-rose-100 text-rose-800 border-rose-300 hover:bg-rose-200",
  blocked:     "bg-purple-100 text-purple-800 border-purple-300 hover:bg-purple-200",
  on_hold:     "bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200",
};

export default function ScheduleCalendarView({
  milestones, canEdit, onMove, onCycleStatus,
}: Props) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));
  const [dragOverIso, setDragOverIso] = useState<string | null>(null);

  const grid = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const byDate = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of milestones) {
      if (!ms.plannedAt) continue;
      const k = (ms.plannedAt as string).slice(0, 10);
      const arr = m.get(k) ?? [];
      arr.push(ms);
      m.set(k, arr);
    }
    return m;
  }, [milestones]);

  const monthLabel = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });

  const onDrop = useCallback(async (dateIso: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIso(null);
    if (!canEdit || !onMove) return;
    const id = e.dataTransfer.getData("text/milestone-id");
    if (!id) return;
    const newPlannedAt = `${dateIso}T00:00:00Z`;
    await onMove(id, newPlannedAt);
  }, [canEdit, onMove]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
        <div className="flex items-center gap-2">
          <button onClick={() => setCursor(addMonths(cursor, -1))} className="p-1 rounded hover:bg-slate-200 text-slate-600">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-sm font-black text-slate-900 min-w-[140px] text-center">{monthLabel}</div>
          <button onClick={() => setCursor(addMonths(cursor, 1))} className="p-1 rounded hover:bg-slate-200 text-slate-600">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <button
          onClick={() => setCursor(startOfMonth(new Date()))}
          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200"
        >
          <CalendarDays className="w-3 h-3" /> Today
        </button>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/40">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => (
          <div key={d} className="px-2 py-1.5 text-[10px] font-black text-slate-500 uppercase tracking-widest">{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7 grid-rows-6 gap-px bg-slate-200">
        {grid.map((day, i) => {
          const iso = ymdLocal(day.date);
          const items = byDate.get(iso) ?? [];
          const isToday = sameDay(day.date, today);
          const isOver = dragOverIso === iso;
          return (
            <div
              key={i}
              onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragOverIso(iso); } }}
              onDragLeave={() => setDragOverIso((cur) => (cur === iso ? null : cur))}
              onDrop={(e) => onDrop(iso, e)}
              className={`min-h-[80px] bg-white p-1 transition-colors ${
                day.outOfMonth ? "bg-slate-50/40" : ""
              } ${isOver ? "bg-indigo-50 ring-2 ring-indigo-400 ring-inset" : ""}`}
            >
              <div className={`flex items-center justify-end mb-1 ${
                isToday
                  ? "text-white"
                  : day.outOfMonth ? "text-slate-300" : "text-slate-500"
              }`}>
                <span className={`text-[11px] font-bold tabular-nums ${isToday ? "bg-indigo-600 rounded-full w-5 h-5 inline-flex items-center justify-center" : ""}`}>
                  {day.date.getDate()}
                </span>
              </div>
              <div className="space-y-0.5">
                {items.slice(0, 3).map((m) => {
                  const id = m.id ?? "";
                  return (
                    <button
                      key={id}
                      draggable={canEdit && !!onMove && !!id}
                      onDragStart={(e) => { if (!id) return; e.dataTransfer.setData("text/milestone-id", id); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={(e) => { e.stopPropagation(); if (canEdit && onCycleStatus && id) onCycleStatus(id, m.status); }}
                      title={`${m.name} — ${m.status}${m.description ? `\n\n${m.description}` : ""}`}
                      className={`w-full text-left truncate text-[10px] font-bold border rounded px-1.5 py-0.5 transition-colors cursor-pointer ${STATUS_TONE[m.status]}`}
                    >
                      {m.name}
                    </button>
                  );
                })}
                {items.length > 3 && (
                  <div className="text-[9px] text-slate-500 italic px-1">+{items.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 py-2 border-t border-slate-200 bg-slate-50/40 text-[10px] text-slate-500 flex items-center justify-between">
        <span>{canEdit ? "Drag pills between days to reschedule · click to advance status" : "Read-only view"}</span>
        <span className="font-mono">{milestones.length} milestone{milestones.length === 1 ? "" : "s"} total</span>
      </div>
    </div>
  );
}

// ─── Calendar math ──────────────────────────────────────────────

interface GridDay { date: Date; outOfMonth: boolean }

function startOfDay(d: Date): Date {
  const c = new Date(d); c.setHours(0,0,0,0); return c;
}
function startOfMonth(d: Date): Date {
  const c = new Date(d.getFullYear(), d.getMonth(), 1); return c;
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function ymdLocal(d: Date): string {
  // Use local time so a "due 2026-06-15" milestone lands on the 15th
  // in the user's timezone, not the 14th because of UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function buildMonthGrid(monthStart: Date): GridDay[] {
  // 6 rows × 7 cols = 42 cells, starting from the Sunday before
  // the 1st of the month.
  const first = new Date(monthStart);
  const dow = first.getDay();
  const start = new Date(first); start.setDate(first.getDate() - dow);
  const cells: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    cells.push({ date: d, outOfMonth: d.getMonth() !== monthStart.getMonth() });
  }
  return cells;
}
