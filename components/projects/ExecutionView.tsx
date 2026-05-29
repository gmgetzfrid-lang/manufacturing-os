"use client";

// ExecutionView — execution-focused schedule UI for field supervisors
// and project managers.
//
// Design principles (rewritten after user feedback that the previous
// pass was "cartoonish, hard to read, names truncated, overflow"):
//
//   1. DAY VIEW IS PRIMARY. Field supervisors run by the day. The
//      default tab is a single-day vertical task list — readable,
//      dense, scannable. Week view is the overview.
//
//   2. TASKS, NOT TILES. Each task is a wide row, not a small
//      pill. Full task names. Time, progress, status, sub-task
//      count visible without zooming. No horizontal overflow.
//
//   3. PARENT > CHILDREN. When the source data has a WBS, only
//      parent tasks render in the list; their children expand
//      inline on click. When the data is flat (current state for
//      this user — Render converter not redeployed), every row is
//      its own "main task" with no expansion — and a banner
//      explains why.
//
//   4. PROFESSIONAL TONE. Slate gray base, one indigo accent for
//      "this is today / selected", emerald for done, rose for
//      overdue. No rainbow.
//
//   5. EVERY INTERACTION IS ONE CLICK. Checkbox toggles complete.
//      Header arrow opens sub-tasks. Time labels are honest about
//      times being missing (the MPP didn't carry planned_start_at
//      for this user's data).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightIcon,
  CalendarDays, Calendar as CalendarIcon, AlertTriangle,
  CircleCheck, Loader2, Clock, Layers, Filter, Info,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  canEdit: boolean;
  onMove?: (id: string, newPlannedStart: string, newPlannedFinish: string) => Promise<boolean>;
  onSetStatus?: (id: string, status: MilestoneStatus) => Promise<boolean>;
}

type ViewMode = "day" | "week";

export default function ExecutionView({ milestones, canEdit, onMove, onSetStatus }: Props) {
  const today = useMemo(() => startOfDay(new Date()), []);

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

  // Default to DAY view; week view is the secondary overview.
  const [mode, setMode] = useState<ViewMode>("day");
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const didSnapCursor = useRef(false);
  useEffect(() => {
    if (didSnapCursor.current || !dateSpan) return;
    const now = new Date();
    const inSpan = now >= dateSpan.earliest && now <= dateSpan.latest;
    setCursor(inSpan ? startOfDay(now) : startOfDay(dateSpan.earliest));
    didSnapCursor.current = true;
  }, [dateSpan]);

  const [openTaskIds, setOpenTaskIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [optimisticStatus, setOptimisticStatus] = useState<Map<string, MilestoneStatus>>(new Map());
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  // ── Hierarchy maps ───────────────────────────────────────────
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

  const milestonesById = useMemo(() => {
    const m = new Map<string, Milestone>();
    for (const ms of milestones) if (ms.id) m.set(ms.id, ms);
    return m;
  }, [milestones]);

  // Apply optimistic status overrides.
  const overlaid = useMemo(() => {
    if (optimisticStatus.size === 0) return milestones;
    return milestones.map((m) => {
      if (!m.id) return m;
      const o = optimisticStatus.get(m.id);
      return o ? { ...m, status: o } : m;
    });
  }, [milestones, optimisticStatus]);

  // Clear overrides when fresh data agrees.
  useEffect(() => {
    if (optimisticStatus.size === 0) return;
    setOptimisticStatus((m) => {
      const n = new Map(m);
      for (const ms of milestones) {
        if (ms.id && n.has(ms.id) && ms.status === n.get(ms.id)) n.delete(ms.id);
      }
      return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestones]);

  // hasHierarchy = any row has a parent_id. Drives the empty/flat banner.
  const hasHierarchy = useMemo(() => milestones.some((m) => m.parentId), [milestones]);

  // Renderable on the calendar: main tasks only.
  //   * With hierarchy: top-level OR direct-children-of-summaries that
  //     are not themselves summaries (i.e. real work items).
  //   * Without hierarchy: every row (the user's current flat state).
  const renderableMains = useMemo(() => {
    if (!hasHierarchy) {
      return overlaid.filter((m) => {
        if (!m.plannedAt) return false;
        if (activeFilter) {
          // Walk up; without hierarchy there IS no up, so filter no-op.
          return true;
        }
        return true;
      });
    }
    return overlaid.filter((m) => {
      if (!m.plannedAt) return false;
      if (m.isSummary) return false;          // hide pure summaries
      // If the parent is a summary, this is a "main task" candidate.
      const p = m.parentId ? milestonesById.get(m.parentId) : undefined;
      if (!m.parentId) return true;            // top-level standalone
      if (p && p.isSummary) return true;       // direct child of summary
      // Deeper: it's a sub-task, not a "main task".
      return false;
    });
  }, [overlaid, hasHierarchy, milestonesById, activeFilter]);

  const subtasksFor = useCallback((mainId: string) => {
    return overlaid.filter((m) => m.parentId === mainId);
  }, [overlaid]);

  // Group filter pool (summary parents) for the rail.
  const summaries = useMemo(() => {
    return overlaid.filter((m) => m.isSummary)
      .sort((a, b) => {
        const ad = new Date((a.plannedStartAt as string | undefined) ?? (a.plannedAt as string)).getTime();
        const bd = new Date((b.plannedStartAt as string | undefined) ?? (b.plannedAt as string)).getTime();
        return ad - bd;
      });
  }, [overlaid]);

  // ── Bucket by day ────────────────────────────────────────────
  const byDate = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of renderableMains) {
      const start = (ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string);
      const k = ymdLocal(new Date(start));
      const arr = m.get(k) ?? [];
      arr.push(ms);
      m.set(k, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ax = new Date((a.plannedStartAt as string) ?? (a.plannedAt as string)).getTime();
        const bx = new Date((b.plannedStartAt as string) ?? (b.plannedAt as string)).getTime();
        return ax - bx;
      });
    }
    return m;
  }, [renderableMains]);

  // ── Handlers ─────────────────────────────────────────────────
  const onCheck = useCallback(async (id: string, current: MilestoneStatus) => {
    if (!canEdit || !onSetStatus) return;
    const next: MilestoneStatus = current === "completed" ? "planned" : "completed";
    setOptimisticStatus((m) => { const n = new Map(m); n.set(id, next); return n; });
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetStatus(id, next);
      if (!ok) setOptimisticStatus((m) => { const n = new Map(m); n.delete(id); return n; });
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus]);

  const onMoveTask = useCallback(async (id: string, dayDelta: number) => {
    if (!canEdit || !onMove || dayDelta === 0) return;
    const ms = overlaid.find((m) => m.id === id);
    if (!ms) return;
    const oldStart = new Date((ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string));
    const oldFinish = new Date(ms.plannedAt as string);
    const newStart = new Date(oldStart); newStart.setDate(newStart.getDate() + dayDelta);
    const newFinish = new Date(oldFinish); newFinish.setDate(newFinish.getDate() + dayDelta);
    setBusy((s) => new Set(s).add(id));
    try { await onMove(id, newStart.toISOString(), newFinish.toISOString()); }
    finally { setBusy((s) => { const n = new Set(s); n.delete(id); return n; }); }
  }, [canEdit, onMove, overlaid]);

  const toggleOpen = useCallback((id: string) => {
    setOpenTaskIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  // ── Navigation ───────────────────────────────────────────────
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

  return (
    <div className="space-y-3">
      {!hasHierarchy && milestones.length > 0 && (
        <FlatDataNotice count={milestones.length} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-3">
        {/* Dashboard rail (compact) */}
        <ExecutionDashboard
          milestones={overlaid}
          summaries={summaries}
          childrenByParent={childrenByParent}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />

        {/* Right pane */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-w-0">
          {/* Header */}
          <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap bg-slate-50/40">
            <div className="flex items-center gap-1.5">
              <button onClick={onPrev} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Previous">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="text-sm font-bold text-slate-900 min-w-[200px] text-center">
                {mode === "day"
                  ? cursor.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
                  : `${startOfWeek(cursor).toLocaleString(undefined, { month: "short", day: "numeric" })} – ${endOfWeek(cursor).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
              </div>
              <button onClick={onNext} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Next">
                <ChevronRight className="w-4 h-4" />
              </button>
              <button onClick={onToday} className="ml-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200">
                <CalendarDays className="w-3 h-3" /> Today
              </button>
              {dateSpan && (
                <button
                  onClick={onJumpStart}
                  title={`Jump to ${dateSpan.earliest.toLocaleDateString()}`}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200"
                >
                  ⏮ Start
                </button>
              )}
            </div>

            <div className="inline-flex items-center bg-white border border-slate-200 rounded-md p-0.5 gap-0.5">
              {(["day", "week"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-2.5 py-1 rounded text-[11px] font-bold capitalize ${mode === m ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {activeFilter && (
            <div className="px-4 py-2 border-b border-slate-200 bg-indigo-50/40 flex items-center gap-2 text-xs">
              <Filter className="w-3 h-3 text-indigo-600" />
              <span className="font-bold text-indigo-900">Filtered to:</span>
              <span className="font-medium text-slate-700">{milestonesById.get(activeFilter)?.name ?? "—"}</span>
              <button onClick={() => setActiveFilter(null)} className="ml-auto text-[11px] font-bold text-indigo-700 hover:text-indigo-900">Clear</button>
            </div>
          )}

          {/* Body */}
          {mode === "day" ? (
            <DayView
              date={cursor}
              tasks={byDate.get(ymdLocal(cursor)) ?? []}
              dateSpan={dateSpan}
              totalRenderable={renderableMains.length}
              onJumpStart={onJumpStart}
              openTaskIds={openTaskIds}
              toggleOpen={toggleOpen}
              subtasksFor={subtasksFor}
              canEdit={canEdit}
              busy={busy}
              onCheck={onCheck}
              onMoveTask={onMoveTask}
            />
          ) : (
            <WeekView
              cursor={cursor}
              today={today}
              byDate={byDate}
              canEdit={canEdit}
              busy={busy}
              onCheck={onCheck}
              onJumpToDay={(d) => { setMode("day"); setCursor(d); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Day view — vertical task list ─────────────────────────────

function DayView({
  date, tasks, dateSpan, totalRenderable, onJumpStart,
  openTaskIds, toggleOpen, subtasksFor, canEdit, busy, onCheck, onMoveTask,
}: {
  date: Date;
  tasks: Milestone[];
  dateSpan: { earliest: Date; latest: Date } | null;
  totalRenderable: number;
  onJumpStart: () => void;
  openTaskIds: Set<string>;
  toggleOpen: (id: string) => void;
  subtasksFor: (id: string) => Milestone[];
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  onMoveTask: (id: string, dayDelta: number) => void;
}) {
  const done = tasks.filter((t) => t.status === "completed").length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  if (tasks.length === 0 && totalRenderable > 0 && dateSpan) {
    return (
      <div className="flex-1 flex items-center justify-center p-10">
        <div className="text-center max-w-md">
          <CalendarIcon className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <div className="text-sm font-bold text-slate-700">Nothing scheduled this day</div>
          <div className="text-xs text-slate-500 mt-1">
            The schedule has <b>{totalRenderable}</b> tasks between{" "}
            <b>{dateSpan.earliest.toLocaleDateString()}</b> and{" "}
            <b>{dateSpan.latest.toLocaleDateString()}</b>.
          </div>
          <button
            onClick={onJumpStart}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
          >
            Jump to schedule start <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-10">
        <div className="text-sm text-slate-400 italic">No tasks scheduled.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Daily summary bar */}
      <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-slate-200 bg-white flex items-center gap-3">
        <div className="text-xs text-slate-500 uppercase tracking-widest font-bold">Day total</div>
        <div className="text-sm font-bold text-slate-900">{tasks.length} task{tasks.length === 1 ? "" : "s"}</div>
        <div className="h-3 flex-1 max-w-[200px] rounded-full bg-slate-100 overflow-hidden">
          <div
            className={`h-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-xs font-mono font-bold text-slate-700">{done} / {tasks.length}</div>
        <div className="text-xs text-slate-500">{pct}% done</div>
      </div>

      <ul className="divide-y divide-slate-100">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            isOpen={!!task.id && openTaskIds.has(task.id)}
            onToggleOpen={() => task.id && toggleOpen(task.id)}
            subtasks={task.id ? subtasksFor(task.id) : []}
            canEdit={canEdit}
            busy={busy}
            onCheck={onCheck}
            onMoveTask={onMoveTask}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── One task row in day view ──────────────────────────────────

function TaskRow({
  task, isOpen, onToggleOpen, subtasks, canEdit, busy, onCheck, onMoveTask,
}: {
  task: Milestone;
  isOpen: boolean;
  onToggleOpen: () => void;
  subtasks: Milestone[];
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  onMoveTask: (id: string, dayDelta: number) => void;
}) {
  const start = (task.plannedStartAt as string | undefined) ?? null;
  const finish = task.plannedAt as string;
  const isBusy = task.id ? busy.has(task.id) : false;
  const checked = task.status === "completed";

  // Sub-task progress: only count direct sub-tasks for this row.
  const subDone = subtasks.filter((s) => s.status === "completed").length;
  const subTotal = subtasks.length;
  const subPct = subTotal > 0 ? Math.round((subDone / subTotal) * 100) : 0;

  // Time display: only show times we actually have. If neither
  // start nor finish carries a non-midnight time, just show "—".
  const hasFinishTime = finish && new Date(finish).getUTCHours() !== 0;
  const hasStartTime = start && new Date(start).getUTCHours() !== 0;
  const timeLabel = (() => {
    if (hasStartTime && hasFinishTime) return `${timeOnly(start!)} – ${timeOnly(finish)}`;
    if (hasFinishTime) return `Due ${timeOnly(finish)}`;
    if (hasStartTime) return `Starts ${timeOnly(start!)}`;
    return null;
  })();

  return (
    <li className={`${checked ? "bg-slate-50/60" : "bg-white"} ${isBusy ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/60 transition-colors">
        {/* Checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); if (task.id) onCheck(task.id, task.status); }}
          disabled={!canEdit || isBusy}
          className={`mt-0.5 shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
            checked
              ? "bg-emerald-500 border-emerald-600 text-white"
              : "bg-white border-slate-300 hover:border-emerald-400"
          } disabled:opacity-50`}
          title={checked ? "Mark planned" : "Mark complete"}
        >
          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : checked ? <CircleCheck className="w-3.5 h-3.5" /> : null}
        </button>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <button
              onClick={onToggleOpen}
              className="inline-flex items-baseline gap-1.5 group min-w-0 max-w-full text-left"
              disabled={subTotal === 0}
            >
              {subTotal > 0 && (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform self-center ${isOpen ? "" : "-rotate-90"}`} />
              )}
              {subTotal === 0 && <span className="w-3.5 shrink-0" aria-hidden />}
              <span className={`text-sm font-bold ${checked ? "line-through text-slate-500" : "text-slate-900"} break-words`}>
                {task.name}
              </span>
            </button>
            {task.wbs && (
              <span className="font-mono text-[10px] text-slate-400 shrink-0">{task.wbs}</span>
            )}
          </div>

          {/* Meta strip */}
          <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-600 flex-wrap">
            {timeLabel && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" />
                <span className="font-mono">{timeLabel}</span>
              </span>
            )}
            {subTotal > 0 && (
              <span className="inline-flex items-center gap-1">
                <Layers className="w-3 h-3 text-slate-400" />
                <span className="font-mono">{subDone} / {subTotal}</span>
              </span>
            )}
            <StatusChip status={task.status} />
          </div>

          {/* Mini progress bar — only when there are sub-tasks */}
          {subTotal > 0 && (
            <div className="mt-1.5 h-1 rounded-full bg-slate-100 overflow-hidden max-w-md">
              <div
                className={`h-full transition-all ${subPct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`}
                style={{ width: `${subPct}%` }}
              />
            </div>
          )}

          {/* Sub-task list when expanded */}
          {isOpen && subTotal > 0 && (
            <ul className="mt-3 space-y-1.5 border-l-2 border-slate-200 pl-3">
              {subtasks.map((sub) => {
                const subChecked = sub.status === "completed";
                const subBusy = sub.id ? busy.has(sub.id) : false;
                return (
                  <li key={sub.id} className="flex items-start gap-2">
                    <button
                      onClick={() => { if (sub.id) onCheck(sub.id, sub.status); }}
                      disabled={!canEdit || subBusy}
                      className={`shrink-0 mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                        subChecked ? "bg-emerald-500 border-emerald-600 text-white" : "bg-white border-slate-300 hover:border-emerald-400"
                      } disabled:opacity-50`}
                    >
                      {subBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : subChecked ? <CircleCheck className="w-3 h-3" /> : null}
                    </button>
                    <span className={`text-xs ${subChecked ? "line-through text-slate-400" : "text-slate-700"} break-words flex-1 min-w-0`}>
                      {sub.name}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Right-side reschedule arrows */}
        {canEdit && (
          <div className="shrink-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
            <button
              onClick={() => task.id && onMoveTask(task.id, -1)}
              title="Move to previous day"
              className="p-1 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-200"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <button
              onClick={() => task.id && onMoveTask(task.id, 1)}
              title="Move to next day"
              className="p-1 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-200"
            >
              <ChevronRightIcon className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Week view — compact overview ──────────────────────────────

function WeekView({
  cursor, today, byDate, canEdit, busy, onCheck, onJumpToDay,
}: {
  cursor: Date;
  today: Date;
  byDate: Map<string, Milestone[]>;
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  onJumpToDay: (d: Date) => void;
}) {
  const days = useMemo(() => {
    const start = startOfWeek(cursor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i); return d;
    });
  }, [cursor]);

  return (
    <div className="grid grid-cols-7 divide-x divide-slate-200 flex-1 min-h-[60vh]">
      {days.map((d) => {
        const iso = ymdLocal(d);
        const tasks = byDate.get(iso) ?? [];
        const isToday = sameDay(d, today);
        const done = tasks.filter((t) => t.status === "completed").length;
        return (
          <div key={iso} className={`flex flex-col min-w-0 ${isToday ? "bg-indigo-50/30" : "bg-white"}`}>
            <button
              onClick={() => onJumpToDay(d)}
              className={`px-2.5 py-2 text-left border-b border-slate-200 hover:bg-slate-50 ${isToday ? "bg-indigo-100/60" : ""}`}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {d.toLocaleString(undefined, { weekday: "short" })}
              </div>
              <div className={`text-lg font-bold ${isToday ? "text-indigo-700" : "text-slate-900"}`}>{d.getDate()}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{tasks.length === 0 ? "—" : `${done}/${tasks.length} done`}</div>
            </button>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {tasks.length === 0 ? (
                <div className="text-[10px] text-slate-300 italic text-center pt-2">—</div>
              ) : tasks.map((t) => {
                const checked = t.status === "completed";
                const isBusy = t.id ? busy.has(t.id) : false;
                return (
                  <div
                    key={t.id}
                    className={`rounded-md border border-slate-200 px-1.5 py-1 ${checked ? "bg-emerald-50" : "bg-white hover:bg-slate-50"} ${isBusy ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start gap-1.5">
                      <button
                        onClick={() => { if (t.id) onCheck(t.id, t.status); }}
                        disabled={!canEdit || isBusy}
                        className={`shrink-0 mt-0.5 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                          checked ? "bg-emerald-500 border-emerald-600 text-white" : "bg-white border-slate-300"
                        }`}
                      >
                        {checked ? <CircleCheck className="w-2.5 h-2.5" /> : null}
                      </button>
                      <button
                        onClick={() => onJumpToDay(d)}
                        className={`text-[11px] text-left flex-1 min-w-0 break-words ${checked ? "line-through text-slate-400" : "text-slate-800"}`}
                      >
                        {t.name}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Flat-data notice ──────────────────────────────────────────

function FlatDataNotice({ count }: { count: number }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-900 flex items-start gap-2">
      <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
      <div>
        <b>This schedule has no parent/child structure.</b> All {count} rows imported as flat top-level tasks because the MPP converter
        on Render hasn&apos;t been redeployed yet with the hierarchy-extracting Java code. Once you redeploy and re-import, tasks will group under their summary parents (Phase 1, Phase 2, etc.) and sub-tasks become expandable.
      </div>
    </div>
  );
}

// ─── Left dashboard rail ───────────────────────────────────────

function ExecutionDashboard({
  milestones, summaries, childrenByParent, activeFilter, onFilterChange,
}: {
  milestones: Milestone[];
  summaries: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  activeFilter: string | null;
  onFilterChange: (id: string | null) => void;
}) {
  const today = new Date(); today.setHours(0,0,0,0);
  const total = milestones.length;
  const done = milestones.filter((m) => m.status === "completed").length;
  const overdue = milestones.filter((m) => {
    if (m.status === "completed") return false;
    if (!m.plannedAt) return false;
    return new Date(m.plannedAt as string).getTime() < today.getTime();
  }).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const allEnds = milestones.map((m) => new Date(m.plannedAt as string).getTime()).filter(Number.isFinite);
  const allStarts = milestones.map((m) => new Date((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string)).getTime()).filter(Number.isFinite);
  const projStart = allStarts.length > 0 ? Math.min(...allStarts) : NaN;
  const projEnd = allEnds.length > 0 ? Math.max(...allEnds) : NaN;
  const totalDays = (Number.isFinite(projStart) && Number.isFinite(projEnd))
    ? Math.max(1, Math.round((projEnd - projStart) / 86400000))
    : 0;
  const elapsedDays = Number.isFinite(projStart)
    ? Math.max(0, Math.round((today.getTime() - projStart) / 86400000))
    : 0;

  const summaryProgress = (s: Milestone) => {
    const all = collectLeafDescendants(s, childrenByParent);
    const d = all.filter((x) => x.status === "completed").length;
    return { done: d, total: all.length, pct: all.length > 0 ? Math.round((d / all.length) * 100) : 0 };
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200">
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Progress</div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-2xl font-bold text-slate-900">{pct}<span className="text-sm text-slate-500">%</span></div>
          <div className="text-[11px] text-slate-500 ml-auto">{done} / {total}</div>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
        </div>
        {totalDays > 0 && (
          <div className="mt-2 text-[10px] text-slate-500">Day {elapsedDays} of {totalDays}</div>
        )}
        {overdue > 0 && (
          <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-rose-700">
            <AlertTriangle className="w-3 h-3" /> {overdue} overdue
          </div>
        )}
      </div>

      {summaries.length > 0 && (
        <div className="overflow-y-auto flex-1 min-h-0 p-3 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-1">Groups</div>
          {summaries.map((s) => {
            const prog = summaryProgress(s);
            const active = activeFilter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onFilterChange(active ? null : (s.id ?? null))}
                className={`w-full text-left rounded-md px-2 py-1.5 border ${
                  active ? "bg-indigo-50 border-indigo-300" : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-900">
                  <span className="truncate flex-1">{s.name}</span>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">{prog.pct}%</span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full ${prog.pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${prog.pct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: MilestoneStatus }) {
  if (status === "planned") return null; // suppress "planned" — it's the default
  const styles: Record<MilestoneStatus, string> = {
    planned:     "",
    in_progress: "bg-blue-50 text-blue-700 border-blue-200",
    completed:   "bg-emerald-50 text-emerald-700 border-emerald-200",
    missed:      "bg-rose-50 text-rose-700 border-rose-200",
    blocked:     "bg-purple-50 text-purple-700 border-purple-200",
  };
  const labels: Record<MilestoneStatus, string> = {
    planned: "Planned", in_progress: "In progress",
    completed: "Done", missed: "Missed", blocked: "Blocked",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold border ${styles[status]}`}>
      {labels[status]}
    </span>
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
function endOfWeek(d: Date): Date {
  const c = startOfWeek(d);
  c.setDate(c.getDate() + 6);
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
