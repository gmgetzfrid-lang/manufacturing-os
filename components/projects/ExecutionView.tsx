"use client";

// ExecutionView — day-by-day operational schedule.
//
// Design rules:
//
//   * Each LEAF task is a calendar tile on its planned-start day.
//     Multi-day tasks render on every day they cover (Outlook-
//     style multi-day blocks) so the schedule looks like a real
//     schedule, not a calendar of summary headers.
//
//   * Summary parents (Phase 1, Phase 2, etc.) do NOT take up
//     calendar real estate. They're shown as group bands above
//     the calendar and as filter chips so the user can scope to
//     "show me only Phase 2" with one click.
//
//   * Every tile is individually interactive:
//       - checkbox in the upper-left to mark complete (or revert)
//       - whole tile is draggable to another day to reschedule
//       - status pill cycles on click
//
//   * Left rail dashboard rolls up project metrics across all
//     leaves, not just visible ones.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Sun, Moon, CalendarDays,
  AlertTriangle, CircleCheck, Circle, Loader2, Flag,
  TrendingDown, TrendingUp, Layers, GripVertical, Filter,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneShift } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  canEdit: boolean;
  onMove?: (id: string, newPlannedStart: string, newPlannedFinish: string) => Promise<boolean>;
  onSetStatus?: (id: string, status: MilestoneStatus) => Promise<boolean>;
}

type ViewMode = "week" | "day";

const SHIFT_TONE: Record<NonNullable<MilestoneShift>, { bar: string; bg: string; ring: string; chip: string }> = {
  day:   { bar: "bg-amber-400",  bg: "bg-amber-50",  ring: "ring-amber-300/70",  chip: "bg-amber-100 text-amber-800" },
  night: { bar: "bg-indigo-500", bg: "bg-indigo-50", ring: "ring-indigo-300/70", chip: "bg-indigo-100 text-indigo-800" },
  swing: { bar: "bg-violet-400", bg: "bg-violet-50", ring: "ring-violet-300/70", chip: "bg-violet-100 text-violet-800" },
};
const STATUS_TONE: Record<MilestoneStatus, string> = {
  planned:     "bg-slate-100 text-slate-700 border-slate-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  completed:   "bg-emerald-100 text-emerald-800 border-emerald-300",
  missed:      "bg-rose-100 text-rose-800 border-rose-300",
  blocked:     "bg-purple-100 text-purple-800 border-purple-300",
};

export default function ExecutionView({ milestones, canEdit, onMove, onSetStatus }: Props) {
  const today = useMemo(() => startOfDay(new Date()), []);

  // Compute the date span of the schedule once; reused for the
  // initial cursor and for the "jump to schedule start/end" buttons.
  const dateSpan = useMemo(() => {
    const starts = milestones
      .map((m) => new Date((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string)).getTime())
      .filter(Number.isFinite);
    const ends = milestones
      .map((m) => new Date(m.plannedAt as string).getTime())
      .filter(Number.isFinite);
    if (starts.length === 0 || ends.length === 0) return null;
    return { earliest: new Date(Math.min(...starts)), latest: new Date(Math.max(...ends)) };
  }, [milestones]);

  const [cursor, setCursor] = useState<Date>(() => startOfWeek(new Date()));
  // Once the schedule data loads, snap the cursor to the right week
  // — current week if today is in-span, otherwise the schedule's
  // earliest week. Only does this once (when span first becomes
  // available) so subsequent manual nav isn't trampled.
  const didSnapCursor = useRef(false);
  useEffect(() => {
    if (didSnapCursor.current) return;
    if (!dateSpan) return;
    const now = new Date();
    const target = (now >= dateSpan.earliest && now <= dateSpan.latest)
      ? startOfWeek(now)
      : startOfWeek(dateSpan.earliest);
    setCursor(target);
    didSnapCursor.current = true;
  }, [dateSpan]);
  const [mode, setMode] = useState<ViewMode>("week");
  const [dragOverIso, setDragOverIso] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState<string | null>(null); // parent id to filter by

  // ── Index by parent for fast lookups ─────────────────────────
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of milestones) {
      if (!ms.parentId) continue;
      const arr = m.get(ms.parentId) ?? [];
      arr.push(ms);
      m.set(ms.parentId, arr);
    }
    return m;
  }, [milestones]);

  // Leaves = tasks with no children. These are the executable
  // work units — what we show on the calendar.
  const leafIds = useMemo(() => {
    const parents = new Set<string>();
    for (const ms of milestones) if (ms.parentId) parents.add(ms.parentId);
    return new Set(
      milestones
        .filter((ms) => ms.id && !parents.has(ms.id!))
        .map((ms) => ms.id!),
    );
  }, [milestones]);

  // Summaries (parents) — used for the group filter rail.
  const summaries = useMemo(() => {
    return milestones.filter((ms) => ms.id && childrenByParent.has(ms.id))
      .sort((a, b) => {
        const ad = new Date((a.plannedStartAt as string | undefined) ?? (a.plannedAt as string)).getTime();
        const bd = new Date((b.plannedStartAt as string | undefined) ?? (b.plannedAt as string)).getTime();
        return ad - bd;
      });
  }, [milestones, childrenByParent]);

  const milestonesById = useMemo(() => {
    const m = new Map<string, Milestone>();
    for (const ms of milestones) if (ms.id) m.set(ms.id, ms);
    return m;
  }, [milestones]);

  // Resolve "Phase 1 ▸ Subphase A" path by walking parent chain.
  const parentPath = useCallback((ms: Milestone): string => {
    const parts: string[] = [];
    let cur: Milestone | undefined = ms.parentId ? milestonesById.get(ms.parentId) : undefined;
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? milestonesById.get(cur.parentId) : undefined;
      if (parts.length > 4) break; // sanity cap
    }
    return parts.join(" ▸ ");
  }, [milestonesById]);

  // Is this leaf descended from the active filter?
  const isUnderFilter = useCallback((ms: Milestone): boolean => {
    if (!activeFilter) return true;
    let cur: Milestone | undefined = ms;
    while (cur) {
      if (cur.id === activeFilter) return true;
      cur = cur.parentId ? milestonesById.get(cur.parentId) : undefined;
    }
    return false;
  }, [activeFilter, milestonesById]);

  // Optimistic status overrides — lets the checkbox flip visually
  // and update dashboard counts before the server roundtrip
  // resolves. Cleared when fresh data matches.
  const [optimisticStatus, setOptimisticStatus] = useState<Map<string, MilestoneStatus>>(new Map());
  const overlaid = useMemo(() => {
    if (optimisticStatus.size === 0) return milestones;
    return milestones.map((m) => {
      if (!m.id) return m;
      const o = optimisticStatus.get(m.id);
      return o ? { ...m, status: o } : m;
    });
  }, [milestones, optimisticStatus]);

  // ── Renderable = leaves with dates, optionally filtered ──────
  // Uses `overlaid` so the tile status reflects optimistic clicks
  // before the server roundtrip resolves.
  const renderable = useMemo(() => {
    return overlaid.filter((ms) => {
      if (!ms.id || !leafIds.has(ms.id)) return false;
      if (!ms.plannedAt) return false;
      if (!isUnderFilter(ms)) return false;
      return true;
    });
  }, [overlaid, leafIds, isUnderFilter]);

  // ── Bucket by day. A multi-day task appears on every day it
  // covers, with a flag indicating whether it's the start, the
  // middle, or the end — so the tile can render a connector look.
  interface Placement { ms: Milestone; isStart: boolean; isEnd: boolean; spanDays: number; dayIndex: number }
  const byDate = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const ms of renderable) {
      const start = new Date((ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string));
      const finish = new Date(ms.plannedAt as string);
      // Iterate every day from start to finish inclusive.
      const startDay = startOfDay(start);
      const finishDay = startOfDay(finish);
      const total = Math.max(1, Math.round((finishDay.getTime() - startDay.getTime()) / 86400000) + 1);
      for (let i = 0; i < total; i++) {
        const d = new Date(startDay); d.setDate(startDay.getDate() + i);
        const iso = ymdLocal(d);
        const arr = m.get(iso) ?? [];
        arr.push({ ms, isStart: i === 0, isEnd: i === total - 1, spanDays: total, dayIndex: i });
        m.set(iso, arr);
      }
    }
    // Sort each day's tiles by start time so the column reads in
    // chronological order.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ax = new Date((a.ms.plannedStartAt as string) ?? (a.ms.plannedAt as string)).getTime();
        const bx = new Date((b.ms.plannedStartAt as string) ?? (b.ms.plannedAt as string)).getTime();
        return ax - bx;
      });
    }
    return m;
  }, [renderable]);

  const days = useMemo(() => {
    if (mode === "day") return [cursor];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(cursor); d.setDate(cursor.getDate() + i); return d;
    });
  }, [cursor, mode]);

  // ── Drag-drop reschedule ─────────────────────────────────────
  const onDrop = useCallback(async (dateIso: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIso(null);
    if (!canEdit || !onMove) return;
    const id = e.dataTransfer.getData("text/milestone-id");
    if (!id) return;
    const ms = milestones.find((m) => m.id === id);
    if (!ms) return;
    const oldStart = new Date((ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string));
    const oldFinish = new Date(ms.plannedAt as string);
    const target = new Date(`${dateIso}T00:00:00`);
    const dayDelta = Math.round(
      (target.getTime() - new Date(ymdLocal(oldStart) + "T00:00:00").getTime()) / 86400000,
    );
    if (dayDelta === 0) return;
    const newStart = new Date(oldStart); newStart.setDate(newStart.getDate() + dayDelta);
    const newFinish = new Date(oldFinish); newFinish.setDate(newFinish.getDate() + dayDelta);
    setBusy((s) => new Set(s).add(id));
    try { await onMove(id, newStart.toISOString(), newFinish.toISOString()); }
    finally { setBusy((s) => { const n = new Set(s); n.delete(id); return n; }); }
  }, [canEdit, onMove, milestones]);

  // ── Toggle status on a leaf tile ─────────────────────────────
  const onCheckLeaf = useCallback(async (id: string, current: MilestoneStatus) => {
    if (!canEdit || !onSetStatus) return;
    const next: MilestoneStatus = current === "completed" ? "planned" : "completed";
    setOptimisticStatus((m) => { const n = new Map(m); n.set(id, next); return n; });
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetStatus(id, next);
      if (!ok) {
        setOptimisticStatus((m) => { const n = new Map(m); n.delete(id); return n; });
      }
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus]);

  // Clear the override map when fresh milestone data agrees with it
  // (the server-roundtrip has caught up). Reset whenever any row's
  // server-side status now matches its optimistic value.
  useEffect(() => {
    if (optimisticStatus.size === 0) return;
    setOptimisticStatus((m) => {
      const n = new Map(m);
      for (const ms of milestones) {
        if (ms.id && n.has(ms.id) && ms.status === n.get(ms.id)) {
          n.delete(ms.id);
        }
      }
      return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestones]);

  // ── Header navigation ────────────────────────────────────────
  const onPrev = () => {
    const d = new Date(cursor); d.setDate(d.getDate() - (mode === "week" ? 7 : 1));
    setCursor(d);
  };
  const onNext = () => {
    const d = new Date(cursor); d.setDate(d.getDate() + (mode === "week" ? 7 : 1));
    setCursor(d);
  };
  const onToday = () => setCursor(mode === "week" ? startOfWeek(new Date()) : startOfDay(new Date()));
  const onJumpStart = () => {
    if (!dateSpan) return;
    setCursor(mode === "week" ? startOfWeek(dateSpan.earliest) : startOfDay(dateSpan.earliest));
  };
  const totalRenderable = renderable.length;
  const visibleInCanvas = days.reduce((sum, d) => sum + (byDate.get(ymdLocal(d))?.length ?? 0), 0);
  const noTasksInView = visibleInCanvas === 0 && totalRenderable > 0 && dateSpan;

  const headerLabel = mode === "week"
    ? `${days[0].toLocaleString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : days[0].toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-3">
      {/* Dashboard rail — fed the overlaid milestones so optimistic
          status flips show up in the metrics immediately. */}
      <ExecutionDashboard
        milestones={overlaid}
        leafIds={leafIds}
        summaries={summaries}
        childrenByParent={childrenByParent}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />

      {/* Calendar canvas */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/60 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <button onClick={onPrev} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Previous">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-sm font-black text-slate-900 min-w-[220px] text-center">{headerLabel}</div>
            <button onClick={onNext} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Next">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button onClick={onToday} className="ml-2 inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200">
              <CalendarDays className="w-3 h-3" /> Today
            </button>
            {dateSpan && (
              <button
                onClick={onJumpStart}
                title={`Jump to ${dateSpan.earliest.toLocaleDateString()} (schedule start)`}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200"
              >
                ⏮ Schedule start
              </button>
            )}
          </div>

          {activeFilter && (
            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-[11px] font-bold text-indigo-700">
              <Filter className="w-3 h-3" />
              {milestonesById.get(activeFilter)?.name ?? "—"}
              <button onClick={() => setActiveFilter(null)} className="ml-1 hover:text-indigo-900">×</button>
            </div>
          )}

          <div className="inline-flex items-center bg-white border border-slate-200 rounded-lg p-0.5 gap-0.5">
            {(["week", "day"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-1 rounded text-[11px] font-bold ${mode === m ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {m === "week" ? "Week" : "Day"}
              </button>
            ))}
          </div>
        </div>

        {/* Weekday headers */}
        <div className={`grid ${mode === "week" ? "grid-cols-7" : "grid-cols-1"} border-b border-slate-200 bg-slate-50/30`}>
          {days.map((d) => {
            const iso = ymdLocal(d);
            const isToday = sameDay(d, today);
            const count = byDate.get(iso)?.length ?? 0;
            return (
              <div key={iso} className={`px-3 py-2 border-r border-slate-200 last:border-r-0 ${isToday ? "bg-indigo-50/60" : ""}`}>
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  {d.toLocaleString(undefined, { weekday: "short" })}
                </div>
                <div className={`text-base font-black ${isToday ? "text-indigo-700" : "text-slate-900"}`}>
                  {d.getDate()}
                </div>
                <div className="text-[10px] text-slate-500">
                  {count} task{count === 1 ? "" : "s"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Empty-view banner — when current week has no tasks but the
            schedule does, point the user at the start. */}
        {noTasksInView && (
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <div className="flex-1 min-w-0">
              <b>No tasks scheduled this {mode === "week" ? "week" : "day"}.</b>{" "}
              The schedule has <b>{totalRenderable}</b> task{totalRenderable === 1 ? "" : "s"} between{" "}
              <b>{dateSpan!.earliest.toLocaleDateString()}</b> and{" "}
              <b>{dateSpan!.latest.toLocaleDateString()}</b>.
            </div>
            <button onClick={onJumpStart} className="shrink-0 inline-flex items-center gap-1 text-[11px] font-black text-amber-900 bg-amber-200 hover:bg-amber-300 px-2 py-1 rounded">
              Jump to schedule start →
            </button>
          </div>
        )}

        {/* Day columns */}
        <div className={`grid ${mode === "week" ? "grid-cols-7" : "grid-cols-1"} min-h-[70vh]`}>
          {days.map((d) => {
            const iso = ymdLocal(d);
            const isToday = sameDay(d, today);
            const items = byDate.get(iso) ?? [];
            const isOver = dragOverIso === iso;
            return (
              <div
                key={iso}
                onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragOverIso(iso); } }}
                onDragLeave={() => setDragOverIso((cur) => (cur === iso ? null : cur))}
                onDrop={(e) => onDrop(iso, e)}
                className={`p-2 border-r border-slate-200 last:border-r-0 space-y-1 overflow-y-auto ${
                  isToday ? "bg-indigo-50/20" : ""
                } ${isOver ? "bg-indigo-100/40 ring-2 ring-indigo-400 ring-inset" : ""}`}
              >
                {items.length === 0 ? (
                  <div className="text-[10px] text-slate-300 italic text-center pt-4">—</div>
                ) : items.map((p) => (
                  <ExecutionTile
                    key={`${p.ms.id}-${p.dayIndex}`}
                    placement={p}
                    canEdit={canEdit}
                    busy={busy}
                    parentPath={parentPath(p.ms)}
                    onCheck={onCheckLeaf}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-2 border-t border-slate-200 bg-slate-50/40 text-[10px] text-slate-500 flex items-center justify-between">
          <span>
            {canEdit
              ? "Click the checkbox to mark complete · drag a tile to reschedule"
              : "Read-only view"}
          </span>
          <span className="font-mono">
            {renderable.length} task{renderable.length === 1 ? "" : "s"}{" "}
            {activeFilter ? "matching filter" : "total"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Single tile ────────────────────────────────────────────────

interface PlacementProps {
  placement: { ms: Milestone; isStart: boolean; isEnd: boolean; spanDays: number; dayIndex: number };
  canEdit: boolean;
  busy: Set<string>;
  parentPath: string;
  onCheck: (id: string, current: MilestoneStatus) => void;
}

function ExecutionTile({ placement, canEdit, busy, parentPath, onCheck }: PlacementProps) {
  const { ms, isStart, isEnd, spanDays } = placement;
  const start = (ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string);
  const finish = ms.plannedAt as string;
  const shift = ms.shift ?? "day";
  const tone = SHIFT_TONE[shift];
  const ShiftIcon = shift === "night" ? Moon : Sun;
  const isBusy = ms.id ? busy.has(ms.id) : false;
  const checked = ms.status === "completed";

  // Multi-day tiles get a connector look — flat-left on continuation
  // days, flat-right on non-end days. Outlook-style.
  const cornerClasses =
    spanDays === 1 ? "rounded-lg"
    : isStart ? "rounded-l-lg rounded-r-none"
    : isEnd   ? "rounded-r-lg rounded-l-none"
    :           "rounded-none";

  return (
    <div
      draggable={canEdit && !!ms.id && isStart}
      onDragStart={(e) => { if (ms.id) { e.dataTransfer.setData("text/milestone-id", ms.id); e.dataTransfer.effectAllowed = "move"; } }}
      className={`relative border border-slate-200 ${tone.bg} ring-1 ${tone.ring} shadow-sm hover:shadow-md transition-shadow ${cornerClasses} ${isBusy ? "opacity-60" : ""} ${checked ? "opacity-70" : ""}`}
      title={`${parentPath ? parentPath + " ▸ " : ""}${ms.name}\n${timeOnly(start)} – ${timeOnly(finish)}${spanDays > 1 ? ` · ${spanDays} days` : ""}`}
    >
      <div className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-r ${tone.bar}`} aria-hidden />

      <div className="p-2 pl-3 flex items-start gap-1.5">
        {/* Checkbox — leaves are directly completable */}
        <button
          onClick={(e) => { e.stopPropagation(); if (ms.id) onCheck(ms.id, ms.status); }}
          disabled={!canEdit || isBusy}
          className={`shrink-0 mt-0.5 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
            checked ? "bg-emerald-500 border-emerald-600 text-white" : "bg-white border-slate-300 hover:border-emerald-400"
          } disabled:opacity-50 cursor-pointer`}
          title={checked ? "Mark planned" : "Mark complete"}
        >
          {isBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : checked ? <CircleCheck className="w-3 h-3" /> : null}
        </button>

        <div className="flex-1 min-w-0">
          {parentPath && isStart && (
            <div className="text-[9px] uppercase tracking-widest text-slate-500 font-bold truncate">
              {parentPath}
            </div>
          )}
          <div className={`text-[12px] font-black leading-snug line-clamp-2 ${checked ? "line-through text-slate-500" : "text-slate-900"}`}>
            {ms.name}
          </div>
          {isStart && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-600 flex-wrap">
              <span className="font-mono">{timeOnly(start)}–{timeOnly(finish)}</span>
              {spanDays > 1 && (
                <span className="font-bold text-slate-500">· {spanDays}d</span>
              )}
              <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded ${tone.chip} text-[9px] font-black uppercase tracking-widest`}>
                <ShiftIcon className="w-2.5 h-2.5" /> {shift}
              </span>
              {ms.wbs && <span className="font-mono text-[9px] text-slate-400">{ms.wbs}</span>}
            </div>
          )}
          {isStart && (
            <div className="mt-1 inline-flex items-center gap-1">
              <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${STATUS_TONE[ms.status]}`}>
                {humanStatus(ms.status)}
              </span>
              {canEdit && (
                <GripVertical className="w-3 h-3 text-slate-300 ml-auto cursor-grab active:cursor-grabbing" />
              )}
            </div>
          )}
          {!isStart && (
            <div className="text-[9px] text-slate-400 italic">
              continued
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Left dashboard rail (with group filter chips) ─────────────

function ExecutionDashboard({
  milestones, leafIds, summaries, childrenByParent, activeFilter, onFilterChange,
}: {
  milestones: Milestone[];
  leafIds: Set<string>;
  summaries: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  activeFilter: string | null;
  onFilterChange: (id: string | null) => void;
}) {
  const today = new Date(); today.setHours(0,0,0,0);
  const leaves = milestones.filter((m) => m.id && leafIds.has(m.id));
  const total = leaves.length;
  const done = leaves.filter((m) => m.status === "completed").length;
  const inProgress = leaves.filter((m) => m.status === "in_progress").length;
  const overdue = leaves.filter((m) => {
    if (m.status === "completed") return false;
    if (!m.plannedAt) return false;
    return new Date(m.plannedAt as string).getTime() < today.getTime();
  }).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const todayIso = ymdLocal(today);
  const todays = leaves.filter((m) => {
    const start = (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string | undefined);
    return start ? ymdLocal(new Date(start)) === todayIso : false;
  });

  const shiftCounts: Record<MilestoneShift | "unset", number> = { day: 0, night: 0, swing: 0, unset: 0 };
  for (const m of leaves) {
    if (m.shift) shiftCounts[m.shift]++;
    else shiftCounts.unset++;
  }

  const allStarts = milestones.map((m) => new Date((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string)).getTime()).filter(Number.isFinite);
  const allEnds = milestones.map((m) => new Date(m.plannedAt as string).getTime()).filter(Number.isFinite);
  const projStart = allStarts.length > 0 ? Math.min(...allStarts) : NaN;
  const projEnd = allEnds.length > 0 ? Math.max(...allEnds) : NaN;
  const totalDays = (Number.isFinite(projStart) && Number.isFinite(projEnd))
    ? Math.max(1, Math.round((projEnd - projStart) / 86400000))
    : 0;
  const elapsedDays = (Number.isFinite(projStart))
    ? Math.max(0, Math.round((today.getTime() - projStart) / 86400000))
    : 0;

  const slipping = leaves
    .filter((m) => m.status !== "completed" && m.plannedAt)
    .map((m) => ({ m, slip: today.getTime() - new Date(m.plannedAt as string).getTime() }))
    .filter((x) => x.slip > 0)
    .sort((a, b) => b.slip - a.slip)
    .slice(0, 5);
  const trendDirection = slipping.length === 0 ? "none" : "up";

  // Roll-up per summary: how many of its leaf descendants are done.
  const summaryProgress = (s: Milestone) => {
    const all = collectLeafDescendants(s, childrenByParent);
    const d = all.filter((x) => x.status === "completed").length;
    return { done: d, total: all.length, pct: all.length > 0 ? Math.round((d / all.length) * 100) : 0 };
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col max-h-[calc(70vh+120px)]">
      {/* Project progress */}
      <div className="px-4 py-3 bg-gradient-to-br from-indigo-50 to-white border-b border-slate-200 shrink-0">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Project progress</div>
        <div className="mt-1 flex items-baseline gap-1">
          <div className="text-3xl font-black text-slate-900">{pct}<span className="text-base text-slate-500">%</span></div>
          <div className="ml-auto text-[10px] text-slate-500">{done} / {total} tasks</div>
        </div>
        <div className="mt-2 h-2 w-full rounded-full bg-slate-100 overflow-hidden flex">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          <div className="h-full bg-blue-400/70 transition-all" style={{ width: `${total > 0 ? (inProgress / total) * 100 : 0}%` }} />
        </div>
        {totalDays > 0 && (
          <div className="mt-2 text-[10px] text-slate-500">
            Day <b className="text-slate-700">{elapsedDays}</b> of <b className="text-slate-700">{totalDays}</b>
          </div>
        )}
      </div>

      {/* Today + slipping (scroll body) */}
      <div className="overflow-y-auto flex-1 min-h-0">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Today</div>
          <div className="space-y-0.5 text-[12px]">
            <Row icon={<Flag className="w-3 h-3 text-blue-500" />} value={todays.length} label="scheduled" />
            <Row icon={<AlertTriangle className="w-3 h-3 text-rose-500" />} value={overdue} label="overdue" rose={overdue > 0} />
            <Row icon={<Loader2 className="w-3 h-3 text-amber-500" />} value={inProgress} label="in progress" />
          </div>
        </div>

        <div className="px-4 py-3 border-b border-slate-200">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Slipping tasks</div>
            {trendDirection === "up" && (
              <span className="text-[10px] text-rose-700 inline-flex items-center gap-0.5"><TrendingUp className="w-2.5 h-2.5" /> falling</span>
            )}
            {trendDirection === "none" && (
              <span className="text-[10px] text-emerald-700 inline-flex items-center gap-0.5"><TrendingDown className="w-2.5 h-2.5" /> on track</span>
            )}
          </div>
          {slipping.length === 0 ? (
            <div className="text-[11px] text-slate-400 italic">Nothing past due.</div>
          ) : (
            <ul className="space-y-1">
              {slipping.map(({ m, slip }) => {
                const days = Math.round(slip / 86400000);
                return (
                  <li key={m.id} className="text-[11px]">
                    <div className="font-bold text-slate-900 truncate">{m.name}</div>
                    <div className="text-[10px] text-rose-600 font-bold">{days}d past plan</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {summaries.length > 0 && (
          <div className="px-4 py-3 border-b border-slate-200">
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Groups</div>
            <div className="space-y-1">
              {summaries.map((s) => {
                const prog = summaryProgress(s);
                const active = activeFilter === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => onFilterChange(active ? null : (s.id ?? null))}
                    className={`w-full text-left rounded-md px-2 py-1.5 border transition-colors ${
                      active
                        ? "bg-indigo-50 border-indigo-300 ring-1 ring-indigo-200"
                        : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-900 truncate">
                      <Layers className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="truncate flex-1">{s.name}</span>
                      <span className="text-[10px] font-mono text-slate-500 shrink-0">{prog.pct}%</span>
                    </div>
                    <div className="mt-1 h-1 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div className={`h-full ${prog.pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${prog.pct}%` }} />
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{prog.done}/{prog.total} tasks</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-4 py-3">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Shift breakdown</div>
          <ShiftBar label="Day"   count={shiftCounts.day}   total={total} icon={<Sun  className="w-3 h-3 text-amber-500" />}  tone="bg-amber-400" />
          <ShiftBar label="Night" count={shiftCounts.night} total={total} icon={<Moon className="w-3 h-3 text-indigo-500" />} tone="bg-indigo-500" />
          <ShiftBar label="Swing" count={shiftCounts.swing} total={total} icon={<Sun  className="w-3 h-3 text-violet-500" />} tone="bg-violet-500" />
          {shiftCounts.unset > 0 && (
            <ShiftBar label="Unassigned" count={shiftCounts.unset} total={total} icon={<Circle className="w-3 h-3 text-slate-400" />} tone="bg-slate-400" />
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ icon, value, label, rose }: { icon: React.ReactNode; value: number; label: string; rose?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className={`font-black tabular-nums ${rose ? "text-rose-700" : "text-slate-900"}`}>{value}</span>
      <span className="text-slate-600">{label}</span>
    </div>
  );
}

function ShiftBar({ label, count, total, icon, tone }: { label: string; count: number; total: number; icon: React.ReactNode; tone: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1 text-[10px] text-slate-600 font-bold">
        {icon} <span className="flex-1">{label}</span>
        <span className="font-mono">{count} · {Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function startOfDay(d: Date): Date { const c = new Date(d); c.setHours(0,0,0,0); return c; }
function startOfWeek(d: Date): Date {
  const c = startOfDay(d);
  const dow = c.getDay();
  c.setDate(c.getDate() - dow);
  return c;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function timeOnly(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch { return "—"; }
}
function humanStatus(s: MilestoneStatus): string {
  return s === "in_progress" ? "in progress" : s;
}
function collectLeafDescendants(root: Milestone, byParent: Map<string, Milestone[]>): Milestone[] {
  const out: Milestone[] = [];
  const stack: Milestone[] = root.id ? (byParent.get(root.id) ?? []) : [];
  if (stack.length === 0) return [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = cur.id ? (byParent.get(cur.id) ?? []) : [];
    if (kids.length === 0) out.push(cur);
    else stack.push(...kids);
  }
  return out;
}
