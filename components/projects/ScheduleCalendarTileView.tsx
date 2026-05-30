"use client";

// ScheduleCalendarTileView — the Outlook-style month grid for the
// Execution tab. Each task lands on the day tiles its planned span
// covers (multi-day tasks repeat across tiles with a Day x/n badge),
// colored by status. Drag a chip to another tile to reschedule the
// whole task by that delta; click it to open the full detail panel.
//
// We render "main" tasks — leaves and tasks that have leaf children —
// not the broad summary containers (a phase-of-phases would otherwise
// smear a bar across the whole month). The detail panel surfaces a
// main task's subtask accordion.

import React, { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, Crosshair } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  canEdit: boolean;
  onMove?: (id: string, newPlannedStart: string, newPlannedFinish: string) => Promise<boolean>;
  onOpenDetail: (m: Milestone) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduleCalendarTileView({ milestones, childrenByParent, canEdit, onMove, onOpenDetail }: Props) {
  const today = useMemo(() => startOfDayUTC(new Date()), []);

  // Which tasks belong on the grid: leaves + tasks with at least one
  // leaf child. Skip pure containers (all children are themselves
  // parents) — they'd span the whole month and add no actionable info.
  const mains = useMemo(() => {
    return milestones.filter((m) => {
      if (!m.plannedAt) return false;
      const kids = m.id ? (childrenByParent.get(m.id) ?? []) : [];
      if (kids.length === 0) return true;
      return kids.some((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
    });
  }, [milestones, childrenByParent]);

  const span = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const m of mains) {
      const s = startMs(m), f = finishMs(m);
      if (Number.isFinite(s)) min = Math.min(min, s);
      if (Number.isFinite(f)) max = Math.max(max, f);
    }
    return Number.isFinite(min) ? { earliest: new Date(min), latest: new Date(max) } : null;
  }, [mains]);

  const [cursor, setCursor] = useState<Date>(() => firstOfMonthUTC(new Date()));
  // Snap to the schedule's first month if today isn't within the span.
  const didSnap = React.useRef(false);
  React.useEffect(() => {
    if (didSnap.current || !span) return;
    const now = new Date();
    const inSpan = now >= span.earliest && now <= span.latest;
    setCursor(firstOfMonthUTC(inSpan ? now : span.earliest));
    didSnap.current = true;
  }, [span]);

  // Bucket every main task onto each UTC day it covers.
  const byDay = useMemo(() => {
    const m = new Map<string, Array<{ ms: Milestone; dayIndex: number; spanDays: number }>>();
    for (const ms of mains) {
      const start = startOfDayUTC(new Date(startMs(ms)));
      const finish = startOfDayUTC(new Date(finishMs(ms)));
      const total = Math.max(1, dayDiff(start, finish) + 1);
      for (let i = 0; i < total; i++) {
        const d = addDaysUTC(start, i);
        const key = ymd(d);
        const arr = m.get(key) ?? [];
        arr.push({ ms, dayIndex: i, spanDays: total });
        m.set(key, arr);
      }
    }
    for (const arr of m.values()) arr.sort((a, b) => startMs(a.ms) - startMs(b.ms));
    return m;
  }, [mains]);

  // 6-week grid starting on the Sunday on/before the 1st.
  const weeks = useMemo(() => {
    const first = cursor;
    const gridStart = addDaysUTC(first, -first.getUTCDay());
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDaysUTC(gridStart, w * 7 + d)),
    );
  }, [cursor]);

  const monthIdx = cursor.getUTCMonth();
  const [overflowDay, setOverflowDay] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const onDropDay = async (targetKey: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragId(null);
    if (!canEdit || !onMove) return;
    const payload = e.dataTransfer.getData("text/plain"); // "<id>|<chipYmd>"
    const [id, chipYmd] = payload.split("|");
    if (!id || !chipYmd) return;
    const delta = dayDiff(ymdToDate(chipYmd), ymdToDate(targetKey));
    if (delta === 0) return;
    const ms = mains.find((x) => x.id === id);
    if (!ms) return;
    const ns = addDaysUTC(new Date(startMs(ms)), delta);
    const nf = addDaysUTC(new Date(finishMs(ms)), delta);
    await onMove(id, ns.toISOString(), nf.toISOString());
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
        <button onClick={() => setCursor(addMonthsUTC(cursor, -1))} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"><ChevronLeft className="w-4 h-4" /></button>
        <div className="text-sm font-bold text-slate-900 min-w-[150px] text-center">
          {cursor.toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}
        </div>
        <button onClick={() => setCursor(addMonthsUTC(cursor, 1))} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"><ChevronRight className="w-4 h-4" /></button>
        <button onClick={() => setCursor(firstOfMonthUTC(new Date()))} className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100 border border-slate-200">
          <Crosshair className="w-3.5 h-3.5 text-rose-500" /> Today
        </button>
        {span && (
          <button onClick={() => setCursor(firstOfMonthUTC(span.earliest))} className="text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100">
            ⏮ Schedule start
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-400">{mains.length} tasks · drag a chip to reschedule</span>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50/60">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center">{d}</div>
        ))}
      </div>

      {/* Weeks */}
      <div className="flex-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-slate-100 last:border-b-0" style={{ minHeight: 116 }}>
            {week.map((day) => {
              const key = ymd(day);
              const items = byDay.get(key) ?? [];
              const inMonth = day.getUTCMonth() === monthIdx;
              const isToday = sameDayUTC(day, today);
              const shown = items.slice(0, 4);
              const extra = items.length - shown.length;
              return (
                <div
                  key={key}
                  onDragOver={(e) => { if (canEdit) { e.preventDefault(); } }}
                  onDrop={(e) => void onDropDay(key, e)}
                  className={`border-r border-slate-100 last:border-r-0 p-1 flex flex-col gap-1 ${inMonth ? "bg-white" : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-rose-300" : ""}`}
                >
                  <div className="flex items-center justify-between px-0.5">
                    <span className={`text-[11px] font-bold ${isToday ? "text-rose-600" : inMonth ? "text-slate-700" : "text-slate-300"}`}>
                      {day.getUTCDate()}
                    </span>
                  </div>
                  {shown.map((p) => (
                    <Chip
                      key={`${p.ms.id}-${p.dayIndex}`}
                      ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
                      childrenByParent={childrenByParent}
                      draggable={canEdit && !!p.ms.id}
                      onDragStart={(e) => { setDragId(p.ms.id ?? null); e.dataTransfer.setData("text/plain", `${p.ms.id}|${key}`); }}
                      onClick={() => onOpenDetail(p.ms)}
                      dimmed={!!dragId && dragId === p.ms.id}
                    />
                  ))}
                  {extra > 0 && (
                    <button onClick={() => setOverflowDay(key)} className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 px-1 text-left">+{extra} more</button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Overflow day popover */}
      {overflowDay && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-4" onClick={() => setOverflowDay(null)}>
          <div className="absolute inset-0 bg-slate-900/30" />
          <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-indigo-600" />
              <div className="font-bold text-slate-900 text-sm">{ymdToDate(overflowDay).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}</div>
              <span className="ml-auto text-[11px] text-slate-400">{(byDay.get(overflowDay) ?? []).length} tasks</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
              {(byDay.get(overflowDay) ?? []).map((p) => (
                <Chip
                  key={`${p.ms.id}-${p.dayIndex}`}
                  ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
                  childrenByParent={childrenByParent}
                  draggable={false}
                  onClick={() => { setOverflowDay(null); onOpenDetail(p.ms); }}
                  full
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  ms, dayIndex, spanDays, childrenByParent, draggable, onDragStart, onClick, dimmed, full,
}: {
  ms: Milestone; dayIndex: number; spanDays: number;
  childrenByParent: Map<string, Milestone[]>;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onClick: () => void;
  dimmed?: boolean; full?: boolean;
}) {
  const tone = chipTone(ms.status);
  const kids = ms.id ? (childrenByParent.get(ms.id) ?? []) : [];
  const leafKids = kids.filter((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
  const done = leafKids.filter((k) => k.status === "completed").length;
  const hasSubs = leafKids.length > 0;
  return (
    <button
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      title={ms.name}
      className={`w-full text-left rounded-md border px-1.5 py-1 ${tone} ${dimmed ? "opacity-40" : ""} ${draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${full ? "" : "truncate"}`}
    >
      <div className="flex items-center gap-1">
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotTone(ms.status)}`} />
        <span className={`text-[10.5px] font-semibold leading-tight ${full ? "" : "truncate"} ${ms.status === "completed" ? "line-through opacity-70" : ""}`}>{ms.name}</span>
      </div>
      <div className="flex items-center gap-1.5 pl-2.5 text-[9px] font-mono text-current opacity-70">
        {spanDays > 1 && <span>D{dayIndex + 1}/{spanDays}</span>}
        {hasSubs && <span>{done}/{leafKids.length}</span>}
        {ms.workOrderRef && full && <span className="truncate">WO {ms.workOrderRef}</span>}
      </div>
    </button>
  );
}

function chipTone(s: MilestoneStatus): string {
  switch (s) {
    case "completed":   return "bg-emerald-50 border-emerald-200 text-emerald-900";
    case "in_progress": return "bg-blue-50 border-blue-200 text-blue-900";
    case "on_hold":     return "bg-amber-50 border-amber-200 text-amber-900";
    case "blocked":     return "bg-rose-50 border-rose-200 text-rose-900";
    case "missed":      return "bg-rose-100 border-rose-300 text-rose-900";
    default:            return "bg-slate-50 border-slate-200 text-slate-800";
  }
}
function dotTone(s: MilestoneStatus): string {
  switch (s) {
    case "completed":   return "bg-emerald-500";
    case "in_progress": return "bg-blue-500";
    case "on_hold":     return "bg-amber-500";
    case "blocked":     return "bg-rose-500";
    case "missed":      return "bg-rose-600";
    default:            return "bg-slate-400";
  }
}

// ── UTC date helpers (kept consistent with the timeline view) ──
function startOfDayUTC(d: Date): Date { const c = new Date(d); c.setUTCHours(0, 0, 0, 0); return c; }
function firstOfMonthUTC(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function addMonthsUTC(d: Date, n: number): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); }
function addDaysUTC(d: Date, n: number): Date { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function dayDiff(a: Date, b: Date): number { return Math.round((startOfDayUTC(b).getTime() - startOfDayUTC(a).getTime()) / 86400000); }
function sameDayUTC(a: Date, b: Date): boolean { return ymd(a) === ymd(b); }
function ymd(d: Date): string { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
function ymdToDate(s: string): Date { return new Date(`${s}T00:00:00Z`); }
function startMs(m: Milestone): number { return Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string)); }
function finishMs(m: Milestone): number { return Date.parse(m.plannedAt as string); }
