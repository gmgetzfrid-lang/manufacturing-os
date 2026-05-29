"use client";

// ExecutionView — execution-focused schedule UI for project managers
// and field supervisors.
//
// Design principles after multiple revisions:
//
//   1. PROFESSIONAL DENSITY. Linear/Vercel aesthetic — white cards
//      with subtle shadow + ring depth, sharp typography, single
//      indigo accent. Not cartoonish (no rainbow shift pills), not
//      flat (real depth, not bg-white-everywhere).
//
//   2. THE TASK IS THE UNIT. A task can span multiple days. Sub-
//      tasks are a shared checklist — checking off a sub-task on
//      Tuesday is reflected on Wednesday's view of the same task.
//
//   3. THIS DAY, EVERY TASK. The day view shows every task whose
//      planned span covers this day. Each task renders as a row
//      with a small "Day 2 of 5" continuation indicator if it's
//      mid-span.
//
//   4. FIX DATA IN-APP. When the imported MPP doesn't carry
//      hierarchy or duration (current state for many turnaround
//      schedules), the user can:
//        * Multi-select rows → "Group under new parent" creates
//          the WBS in-app.
//        * Single-task action → "Set duration" expands a 1-day
//          task into a multi-day span without touching the .mpp.
//
//   5. CONSISTENT, NO HORIZONTAL OVERFLOW. Everything wraps. Long
//      names break across lines instead of clipping. Meta strips
//      use flex-wrap so they reflow at narrow widths.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightIcon,
  CalendarDays, AlertTriangle, CircleCheck, Loader2, Clock, Layers,
  Filter, Info, FolderPlus, CalendarRange, X as XIcon, CheckSquare, Square,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { groupTasksUnderParent, setTaskDuration } from "@/lib/milestones";

interface Props {
  milestones: Milestone[];
  canEdit: boolean;
  orgId: string;
  projectId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  onRefresh: () => void;
  onMove?: (id: string, newPlannedStart: string, newPlannedFinish: string) => Promise<boolean>;
  onSetStatus?: (id: string, status: MilestoneStatus) => Promise<boolean>;
}

type ViewMode = "day" | "week";

export default function ExecutionView({
  milestones, canEdit, orgId, projectId, userId, userName, userEmail, userRole,
  onRefresh, onMove, onSetStatus,
}: Props) {
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [durationFor, setDurationFor] = useState<Milestone | null>(null);

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

  const overlaid = useMemo(() => {
    if (optimisticStatus.size === 0) return milestones;
    return milestones.map((m) => {
      if (!m.id) return m;
      const o = optimisticStatus.get(m.id);
      return o ? { ...m, status: o } : m;
    });
  }, [milestones, optimisticStatus]);

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

  const hasHierarchy = useMemo(() => milestones.some((m) => m.parentId), [milestones]);

  // Renderable mains = tasks that DO ACTUAL WORK. A "main task" is
  // a task whose direct children are leaves (real checklist items),
  // or a task with no children at all. Pure summary parents
  // (containers whose children are themselves summaries) are
  // demoted to GROUP filters in the sidebar — they don't take
  // calendar real estate.
  //
  // Without this filter, "Phase 1" (summary) AND "Task A" (its
  // child) AND "Subtask A.1" (Task A's leaf child) would all
  // render as rows. With it: only Task A renders, with A.1 / A.2 /
  // A.3 inside its accordion. Phase 1 lives in the group rail.
  const renderableMains = useMemo(() => {
    return overlaid.filter((m) => {
      if (!m.plannedAt) return false;
      if (!m.id) return true;
      const kids = childrenByParent.get(m.id) ?? [];
      if (kids.length === 0) {
        // Leaf: render IF its parent (if any) is not a real "main"
        // (i.e. parent is itself a summary container). Otherwise the
        // parent will render this leaf inside its accordion.
        if (m.parentId) {
          const p = milestonesById.get(m.parentId);
          if (p && !p.isSummary) return false; // parent is a main task, leaf goes in accordion
        }
        return true;
      }
      // Has children. Is THIS task a "main task" (i.e. has at least
      // one leaf direct child)?
      const hasLeafChild = kids.some((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
      if (!hasLeafChild) return false; // pure container — moves to group rail
      return true;
    });
  }, [overlaid, childrenByParent, milestonesById]);

  const subtasksFor = useCallback((mainId: string) => {
    return overlaid.filter((m) => m.parentId === mainId);
  }, [overlaid]);

  // Summaries for the dashboard filter rail.
  const summaries = useMemo(() => {
    return overlaid.filter((m) => m.isSummary)
      .sort((a, b) => {
        const ad = new Date((a.plannedStartAt as string | undefined) ?? (a.plannedAt as string)).getTime();
        const bd = new Date((b.plannedStartAt as string | undefined) ?? (b.plannedAt as string)).getTime();
        return ad - bd;
      });
  }, [overlaid]);

  const isUnderFilter = useCallback((ms: Milestone): boolean => {
    if (!activeFilter) return true;
    let cur: Milestone | undefined = ms;
    while (cur) {
      if (cur.id === activeFilter) return true;
      cur = cur.parentId ? milestonesById.get(cur.parentId) : undefined;
    }
    return false;
  }, [activeFilter, milestonesById]);

  // Bucket each task on EVERY day it covers.
  interface Placement { ms: Milestone; isStart: boolean; dayIndex: number; spanDays: number }
  const byDate = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const ms of renderableMains) {
      if (!isUnderFilter(ms)) continue;
      const start = new Date((ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string));
      const finish = new Date(ms.plannedAt as string);
      const startDay = startOfDay(start);
      const finishDay = startOfDay(finish);
      const total = Math.max(1, Math.round((finishDay.getTime() - startDay.getTime()) / 86400000) + 1);
      for (let i = 0; i < total; i++) {
        const d = new Date(startDay); d.setDate(startDay.getDate() + i);
        const iso = ymdLocal(d);
        const arr = m.get(iso) ?? [];
        arr.push({ ms, isStart: i === 0, dayIndex: i, spanDays: total });
        m.set(iso, arr);
      }
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ax = new Date((a.ms.plannedStartAt as string) ?? (a.ms.plannedAt as string)).getTime();
        const bx = new Date((b.ms.plannedStartAt as string) ?? (b.ms.plannedAt as string)).getTime();
        return ax - bx;
      });
    }
    return m;
  }, [renderableMains, isUnderFilter]);

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

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ── Navigation ───────────────────────────────────────────────
  const onPrev = () => {
    const d = new Date(cursor); d.setDate(d.getDate() - (mode === "week" ? 7 : 1)); setCursor(d);
  };
  const onNext = () => {
    const d = new Date(cursor); d.setDate(d.getDate() + (mode === "week" ? 7 : 1)); setCursor(d);
  };
  const onToday = () => setCursor(mode === "week" ? startOfWeek(new Date()) : startOfDay(new Date()));
  const onJumpStart = () => {
    if (!dateSpan) return;
    setCursor(mode === "week" ? startOfWeek(dateSpan.earliest) : startOfDay(dateSpan.earliest));
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      {!hasHierarchy && milestones.length > 0 && (
        <FlatDataNotice count={milestones.length} />
      )}

      <div className={`grid grid-cols-1 ${sidebarCollapsed ? "lg:grid-cols-[44px_minmax(0,1fr)]" : "lg:grid-cols-[260px_minmax(0,1fr)]"} gap-3 transition-[grid-template-columns] duration-200`}>
        {sidebarCollapsed ? (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="hidden lg:flex bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] items-start justify-center pt-4 hover:bg-slate-50 transition-colors h-fit"
            title="Show metrics rail"
          >
            <ChevronRightIcon className="w-4 h-4 text-slate-500" />
          </button>
        ) : (
          <ExecutionDashboard
            milestones={overlaid}
            summaries={summaries}
            childrenByParent={childrenByParent}
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        )}

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col min-w-0">
          <Toolbar
            mode={mode} setMode={setMode}
            cursor={cursor} onPrev={onPrev} onNext={onNext} onToday={onToday}
            onJumpStart={onJumpStart}
            dateSpan={dateSpan}
          />

          {activeFilter && (
            <div className="px-4 py-2 border-b border-slate-200 bg-indigo-50/50 flex items-center gap-2 text-xs">
              <Filter className="w-3 h-3 text-indigo-600" />
              <span className="text-slate-700">Filtered to <b>{milestonesById.get(activeFilter)?.name ?? "—"}</b></span>
              <button onClick={() => setActiveFilter(null)} className="ml-auto text-[11px] font-bold text-indigo-700 hover:text-indigo-900">Clear</button>
            </div>
          )}

          {selectedIds.size > 0 && (
            <SelectionBar
              count={selectedIds.size}
              onClear={clearSelection}
              onGroup={() => setGroupModalOpen(true)}
              canEdit={canEdit}
            />
          )}

          {mode === "day" ? (
            <DayView
              date={cursor}
              placements={byDate.get(ymdLocal(cursor)) ?? []}
              dateSpan={dateSpan}
              totalRenderable={renderableMains.length}
              onJumpStart={onJumpStart}
              openTaskIds={openTaskIds}
              toggleOpen={toggleOpen}
              subtasksFor={subtasksFor}
              childrenByParent={childrenByParent}
              canEdit={canEdit}
              busy={busy}
              onCheck={onCheck}
              onMoveTask={onMoveTask}
              selectedIds={selectedIds}
              toggleSelected={toggleSelected}
              onSetDuration={(m) => setDurationFor(m)}
            />
          ) : (
            <WeekView
              cursor={cursor}
              today={today}
              byDate={byDate}
              onJumpToDay={(d) => { setMode("day"); setCursor(d); }}
              canEdit={canEdit}
              busy={busy}
              onCheck={onCheck}
              childrenByParent={childrenByParent}
              openTaskIds={openTaskIds}
              toggleOpen={toggleOpen}
              subtasksFor={subtasksFor}
            />
          )}
        </div>
      </div>

      {groupModalOpen && selectedIds.size > 0 && (
        <GroupTasksModal
          orgId={orgId}
          projectId={projectId}
          actorUserId={userId}
          actorUserName={userName}
          actorUserEmail={userEmail}
          actorUserRole={userRole}
          childIds={Array.from(selectedIds)}
          childNames={Array.from(selectedIds).map((id) => milestonesById.get(id)?.name).filter((s): s is string => !!s)}
          existingParents={summaries}
          onClose={() => setGroupModalOpen(false)}
          onDone={() => { setGroupModalOpen(false); clearSelection(); onRefresh(); }}
        />
      )}

      {durationFor && (
        <SetDurationModal
          task={durationFor}
          actorUserId={userId}
          onClose={() => setDurationFor(null)}
          onDone={() => { setDurationFor(null); onRefresh(); }}
        />
      )}
    </div>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────

function Toolbar({
  mode, setMode, cursor, onPrev, onNext, onToday, onJumpStart, dateSpan,
}: {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  cursor: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onJumpStart: () => void;
  dateSpan: { earliest: Date; latest: Date } | null;
}) {
  return (
    <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
      <div className="flex items-center gap-1">
        <button onClick={onPrev} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-semibold text-slate-900 min-w-[220px] text-center tracking-tight">
          {mode === "day"
            ? cursor.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
            : `${startOfWeek(cursor).toLocaleString(undefined, { month: "short", day: "numeric" })} – ${endOfWeek(cursor).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
        </div>
        <button onClick={onNext} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600">
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-slate-200 mx-2" />
        <button onClick={onToday} className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100">
          <CalendarDays className="w-3 h-3" /> Today
        </button>
        {dateSpan && (
          <button onClick={onJumpStart} className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100" title={`Jump to ${dateSpan.earliest.toLocaleDateString()}`}>
            ⏮ Start
          </button>
        )}
      </div>

      <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
        {(["day", "week"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold capitalize transition-colors ${
              mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Selection action bar ──────────────────────────────────────

function SelectionBar({ count, onClear, onGroup, canEdit }: { count: number; onClear: () => void; onGroup: () => void; canEdit: boolean }) {
  return (
    <div className="px-4 py-2 border-b border-indigo-200 bg-indigo-50/70 flex items-center gap-3 text-xs">
      <span className="font-semibold text-indigo-900">{count} task{count === 1 ? "" : "s"} selected</span>
      <div className="ml-auto flex items-center gap-2">
        {canEdit && (
          <button onClick={onGroup} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold">
            <FolderPlus className="w-3 h-3" /> Group under parent
          </button>
        )}
        <button onClick={onClear} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold">
          <XIcon className="w-3 h-3" /> Clear
        </button>
      </div>
    </div>
  );
}

// ─── Day view ──────────────────────────────────────────────────

function DayView({
  date, placements, dateSpan, totalRenderable, onJumpStart,
  openTaskIds, toggleOpen, subtasksFor, childrenByParent,
  canEdit, busy, onCheck, onMoveTask,
  selectedIds, toggleSelected, onSetDuration,
}: {
  date: Date;
  placements: Array<{ ms: Milestone; isStart: boolean; dayIndex: number; spanDays: number }>;
  dateSpan: { earliest: Date; latest: Date } | null;
  totalRenderable: number;
  onJumpStart: () => void;
  openTaskIds: Set<string>;
  toggleOpen: (id: string) => void;
  subtasksFor: (id: string) => Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  onMoveTask: (id: string, dayDelta: number) => void;
  selectedIds: Set<string>;
  toggleSelected: (id: string) => void;
  onSetDuration: (m: Milestone) => void;
}) {
  const done = placements.filter((p) => p.ms.status === "completed").length;
  const pct = placements.length > 0 ? Math.round((done / placements.length) * 100) : 0;

  if (placements.length === 0 && totalRenderable > 0 && dateSpan) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="text-center max-w-md">
          <CalendarDays className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <div className="text-sm font-semibold text-slate-700">Nothing scheduled this day</div>
          <div className="text-xs text-slate-500 mt-1">
            The schedule has <b>{totalRenderable}</b> tasks between <b>{dateSpan.earliest.toLocaleDateString()}</b> and <b>{dateSpan.latest.toLocaleDateString()}</b>.
          </div>
          <button onClick={onJumpStart} className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold">
            Jump to schedule start <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  if (placements.length === 0) {
    return <div className="flex-1 flex items-center justify-center p-12 text-sm text-slate-400 italic">No tasks scheduled.</div>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-slate-200 bg-white/95 backdrop-blur-sm flex items-center gap-3">
        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Daily</div>
        <div className="text-sm font-semibold text-slate-900">{placements.length} task{placements.length === 1 ? "" : "s"}</div>
        <div className="h-1.5 flex-1 max-w-[200px] rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs font-mono text-slate-700">{done} / {placements.length}</div>
        <div className="text-xs text-slate-500 font-medium">{pct}%</div>
      </div>

      <div className="divide-y divide-slate-100">
        {placements.map((p) => (
          <TaskRow
            key={`${p.ms.id}-${p.dayIndex}`}
            placement={p}
            isOpen={!!p.ms.id && openTaskIds.has(p.ms.id)}
            onToggleOpen={() => p.ms.id && toggleOpen(p.ms.id)}
            subtasks={p.ms.id ? subtasksFor(p.ms.id) : []}
            childrenByParent={childrenByParent}
            openTaskIds={openTaskIds}
            toggleOpen={toggleOpen}
            canEdit={canEdit}
            busy={busy}
            onCheck={onCheck}
            onMoveTask={onMoveTask}
            selected={!!p.ms.id && selectedIds.has(p.ms.id)}
            onToggleSelected={() => p.ms.id && toggleSelected(p.ms.id)}
            onSetDuration={onSetDuration}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Task row — the heart of the day view ──────────────────────

function TaskRow({
  placement, isOpen, onToggleOpen, subtasks, childrenByParent,
  openTaskIds, toggleOpen,
  canEdit, busy, onCheck, onMoveTask,
  selected, onToggleSelected, onSetDuration,
}: {
  placement: { ms: Milestone; isStart: boolean; dayIndex: number; spanDays: number };
  isOpen: boolean;
  onToggleOpen: () => void;
  subtasks: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  openTaskIds: Set<string>;
  toggleOpen: (id: string) => void;
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  onMoveTask: (id: string, dayDelta: number) => void;
  selected: boolean;
  onToggleSelected: () => void;
  onSetDuration: (m: Milestone) => void;
}) {
  const { ms, dayIndex, spanDays } = placement;
  const isBusy = ms.id ? busy.has(ms.id) : false;
  const checked = ms.status === "completed";

  const finish = ms.plannedAt as string;
  const start = (ms.plannedStartAt as string | undefined) ?? null;
  const hasFinishTime = finish && new Date(finish).getUTCHours() !== 0;
  const hasStartTime = start && new Date(start).getUTCHours() !== 0;
  const timeLabel = (() => {
    if (hasStartTime && hasFinishTime) return `${timeOnly(start!)}–${timeOnly(finish)}`;
    if (hasFinishTime) return `Due ${timeOnly(finish)}`;
    if (hasStartTime) return `Starts ${timeOnly(start!)}`;
    return null;
  })();

  const subDone = subtasks.filter((s) => s.status === "completed").length;
  const subTotal = subtasks.length;
  const subPct = subTotal > 0 ? Math.round((subDone / subTotal) * 100) : 0;

  const accentClass =
    checked ? "before:bg-emerald-500" :
    spanDays > 1 ? "before:bg-indigo-500" :
    "before:bg-slate-200";

  return (
    <div
      className={`group relative ${selected ? "bg-indigo-50/50" : checked ? "bg-slate-50/40" : "hover:bg-slate-50/40"} ${isBusy ? "opacity-60" : ""} before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-0.5 before:rounded-r ${accentClass} transition-colors`}
    >
      <div className="flex items-start gap-3 px-4 py-3.5 pl-5">
        {/* Selection checkbox */}
        {canEdit && (
          <button
            onClick={onToggleSelected}
            className="mt-0.5 shrink-0 w-4 h-4 inline-flex items-center justify-center text-slate-400 hover:text-slate-700"
            title={selected ? "Deselect" : "Select"}
          >
            {selected ? <CheckSquare className="w-4 h-4 text-indigo-600" /> : <Square className="w-4 h-4" />}
          </button>
        )}

        {/* Status checkbox */}
        <button
          onClick={() => { if (ms.id) onCheck(ms.id, ms.status); }}
          disabled={!canEdit || isBusy}
          className={`mt-0.5 shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
            checked
              ? "bg-emerald-500 border-emerald-600 text-white shadow-sm"
              : "bg-white border-slate-300 hover:border-emerald-500 hover:shadow-sm"
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
              disabled={subTotal === 0}
              className="inline-flex items-baseline gap-1.5 group/btn min-w-0 max-w-full text-left disabled:cursor-default"
            >
              {subTotal > 0 ? (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform self-center ${isOpen ? "" : "-rotate-90"}`} />
              ) : (
                <span className="w-3.5 shrink-0" aria-hidden />
              )}
              <span className={`text-[14px] font-semibold tracking-tight ${checked ? "line-through text-slate-500" : "text-slate-900"} break-words`}>
                {ms.name}
              </span>
            </button>
            {ms.wbs && <span className="font-mono text-[10px] text-slate-400 shrink-0">{ms.wbs}</span>}
            {spanDays > 1 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-700 text-[10px] font-bold border border-indigo-200 shrink-0">
                Day {dayIndex + 1} of {spanDays}
              </span>
            )}
          </div>

          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-600 flex-wrap">
            {timeLabel && (
              <span className="inline-flex items-center gap-1 font-medium">
                <Clock className="w-3 h-3 text-slate-400" />
                <span className="font-mono">{timeLabel}</span>
              </span>
            )}
            {subTotal > 0 && (
              <span className="inline-flex items-center gap-1 font-medium">
                <Layers className="w-3 h-3 text-slate-400" />
                <span className="font-mono">{subDone} / {subTotal} sub-tasks</span>
              </span>
            )}
            <StatusChip status={ms.status} />
          </div>

          {subTotal > 0 && (
            <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden max-w-md">
              <div className={`h-full transition-all ${subPct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${subPct}%` }} />
            </div>
          )}

          {isOpen && subTotal > 0 && (
            <div className="mt-3 ml-1 border-l-2 border-indigo-100 pl-3">
              <SubTaskTree
                items={subtasks}
                childrenByParent={childrenByParent}
                openTaskIds={openTaskIds}
                toggleOpen={toggleOpen}
                canEdit={canEdit}
                busy={busy}
                onCheck={onCheck}
                depth={0}
              />
            </div>
          )}
        </div>

        {/* Row actions on hover */}
        {canEdit && (
          <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onSetDuration(ms)}
              title="Set duration in days"
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100"
            >
              <CalendarRange className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => ms.id && onMoveTask(ms.id, -1)}
              title="Move to previous day"
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => ms.id && onMoveTask(ms.id, 1)}
              title="Move to next day"
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100"
            >
              <ChevronRightIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Recursive sub-task tree ───────────────────────────────────
//
// Renders an arbitrarily-deep sub-task hierarchy as a nested
// accordion. Each row:
//   * Checkbox to toggle status (always present)
//   * If the row has its own children, a chevron to expand
//   * Indented based on depth so the hierarchy is visually clear
//
// This is what lets a user check off "Step A.1.b.iii" without
// flattening the structure into a giant linear list. Recursion
// means we handle sub-sub-sub-tasks (and deeper) without code
// changes per level.

function SubTaskTree({
  items, childrenByParent, openTaskIds, toggleOpen,
  canEdit, busy, onCheck, depth,
}: {
  items: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  openTaskIds: Set<string>;
  toggleOpen: (id: string) => void;
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  depth: number;
}) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const kids = item.id ? (childrenByParent.get(item.id) ?? []) : [];
        const hasKids = kids.length > 0;
        const isOpen = item.id ? openTaskIds.has(item.id) : false;
        const checked = item.status === "completed";
        const isBusy = item.id ? busy.has(item.id) : false;

        // Rolled progress for non-leaf nodes — how many of THEIR
        // leaf descendants are done.
        let nestedDone = 0, nestedTotal = 0;
        if (hasKids && item.id) {
          const flatLeaves = collectLeafDescendantsById(item.id, childrenByParent);
          nestedTotal = flatLeaves.length;
          nestedDone = flatLeaves.filter((l) => l.status === "completed").length;
        }
        const nestedPct = nestedTotal > 0 ? Math.round((nestedDone / nestedTotal) * 100) : 0;

        return (
          <li key={item.id ?? Math.random()}>
            <div className="flex items-start gap-2 py-0.5 group/st">
              {/* Chevron — placeholder when no kids so columns align */}
              {hasKids ? (
                <button
                  onClick={() => item.id && toggleOpen(item.id)}
                  className="shrink-0 w-4 h-4 mt-0.5 inline-flex items-center justify-center text-slate-400 hover:text-slate-900 rounded hover:bg-slate-100"
                  title={isOpen ? "Collapse" : "Expand"}
                >
                  <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                </button>
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}

              {/* Checkbox */}
              <button
                onClick={() => { if (item.id) onCheck(item.id, item.status); }}
                disabled={!canEdit || isBusy}
                className={`shrink-0 mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                  checked
                    ? "bg-emerald-500 border-emerald-600 text-white shadow-sm"
                    : "bg-white border-slate-300 hover:border-emerald-500 hover:shadow-sm"
                } disabled:opacity-50`}
                title={checked ? "Mark planned" : "Mark complete"}
              >
                {isBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : checked ? <CircleCheck className="w-3 h-3" /> : null}
              </button>

              {/* Name + meta */}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className={`text-[12.5px] flex-1 min-w-0 break-words leading-snug ${
                    checked ? "line-through text-slate-400" : (hasKids ? "text-slate-900 font-semibold" : "text-slate-700")
                  }`}>
                    {item.name}
                  </span>
                  {hasKids && (
                    <span className="text-[10px] font-mono text-slate-500 shrink-0">{nestedDone}/{nestedTotal}</span>
                  )}
                  {item.wbs && (
                    <span className="font-mono text-[9px] text-slate-400 shrink-0">{item.wbs}</span>
                  )}
                </div>
                {hasKids && (
                  <div className="mt-1 h-0.5 rounded-full bg-slate-100 overflow-hidden max-w-[200px]">
                    <div className={`h-full ${nestedPct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${nestedPct}%` }} />
                  </div>
                )}
              </div>
            </div>

            {/* Nested children */}
            {hasKids && isOpen && (
              <div className="ml-4 mt-1 border-l-2 border-slate-100 pl-3">
                <SubTaskTree
                  items={kids}
                  childrenByParent={childrenByParent}
                  openTaskIds={openTaskIds}
                  toggleOpen={toggleOpen}
                  canEdit={canEdit}
                  busy={busy}
                  onCheck={onCheck}
                  depth={depth + 1}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function collectLeafDescendantsById(id: string, byParent: Map<string, Milestone[]>): Milestone[] {
  const out: Milestone[] = [];
  const stack: Milestone[] = [...(byParent.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = cur.id ? (byParent.get(cur.id) ?? []) : [];
    if (kids.length === 0) out.push(cur);
    else stack.push(...kids);
  }
  return out;
}

// ─── Week view ─────────────────────────────────────────────────

function WeekView({
  cursor, today, byDate, onJumpToDay, canEdit, busy, onCheck,
  childrenByParent, openTaskIds, toggleOpen, subtasksFor,
}: {
  cursor: Date;
  today: Date;
  byDate: Map<string, Array<{ ms: Milestone; isStart: boolean; dayIndex: number; spanDays: number }>>;
  onJumpToDay: (d: Date) => void;
  canEdit: boolean;
  busy: Set<string>;
  onCheck: (id: string, current: MilestoneStatus) => void;
  childrenByParent: Map<string, Milestone[]>;
  openTaskIds: Set<string>;
  toggleOpen: (id: string) => void;
  subtasksFor: (id: string) => Milestone[];
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
        const placements = byDate.get(iso) ?? [];
        const isToday = sameDay(d, today);
        const done = placements.filter((p) => p.ms.status === "completed").length;
        return (
          <div key={iso} className={`flex flex-col min-w-0 ${isToday ? "bg-indigo-50/20" : "bg-white"}`}>
            {/* Only the date header navigates — task clicks below do NOT. */}
            <button
              onClick={() => onJumpToDay(d)}
              className={`px-3 py-2.5 text-left border-b border-slate-200 hover:bg-slate-100/60 transition-colors ${isToday ? "bg-indigo-100/50" : ""}`}
              title="Open this day in Day view"
            >
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {d.toLocaleString(undefined, { weekday: "short" })}
              </div>
              <div className={`text-lg font-bold tracking-tight ${isToday ? "text-indigo-700" : "text-slate-900"}`}>{d.getDate()}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{placements.length === 0 ? "—" : `${done}/${placements.length} done`}</div>
            </button>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {placements.length === 0 ? (
                <div className="text-[10px] text-slate-300 italic text-center pt-2">—</div>
              ) : placements.map((p) => {
                const t = p.ms;
                const checked = t.status === "completed";
                const isBusy = t.id ? busy.has(t.id) : false;
                const isOpen = t.id ? openTaskIds.has(t.id) : false;
                const kids = t.id ? subtasksFor(t.id) : [];
                const subDone = kids.filter((k) => k.status === "completed").length;
                const subTotal = kids.length;
                const subPct = subTotal > 0 ? Math.round((subDone / subTotal) * 100) : 0;

                return (
                  <div
                    key={`${t.id}-${p.dayIndex}`}
                    className={`rounded-lg border shadow-sm ring-1 ring-slate-900/[0.02] ${
                      checked ? "bg-emerald-50/60 border-emerald-200" : "bg-white border-slate-200"
                    } overflow-hidden`}
                  >
                    <div className="px-2 py-1.5">
                      <div className="flex items-start gap-1.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); if (t.id) onCheck(t.id, t.status); }}
                          disabled={!canEdit || isBusy}
                          className={`shrink-0 mt-0.5 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                            checked ? "bg-emerald-500 border-emerald-600 text-white" : "bg-white border-slate-300 hover:border-emerald-500"
                          } disabled:opacity-50`}
                          title={checked ? "Mark planned" : "Mark complete"}
                        >
                          {isBusy ? <Loader2 className="w-2 h-2 animate-spin" /> : checked ? <CircleCheck className="w-2.5 h-2.5" /> : null}
                        </button>
                        <button
                          onClick={() => { if (t.id && subTotal > 0) toggleOpen(t.id); }}
                          className="flex-1 min-w-0 text-left"
                          disabled={subTotal === 0}
                        >
                          <div className="flex items-baseline gap-1">
                            {subTotal > 0 && (
                              <ChevronDown className={`w-3 h-3 shrink-0 text-slate-400 transition-transform self-center ${isOpen ? "" : "-rotate-90"}`} />
                            )}
                            <span className={`text-[11px] flex-1 min-w-0 break-words leading-snug ${checked ? "line-through text-slate-400" : "text-slate-800 font-semibold"}`}>
                              {t.name}
                            </span>
                          </div>
                          {(subTotal > 0 || p.spanDays > 1) && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-[9px] font-mono text-slate-500">
                              {subTotal > 0 && <span>{subDone}/{subTotal}</span>}
                              {p.spanDays > 1 && <span className="text-indigo-700">D{p.dayIndex + 1}/{p.spanDays}</span>}
                            </div>
                          )}
                          {subTotal > 0 && (
                            <div className="mt-1 h-0.5 rounded-full bg-slate-100 overflow-hidden">
                              <div className={`h-full ${subPct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${subPct}%` }} />
                            </div>
                          )}
                        </button>
                      </div>

                      {isOpen && subTotal > 0 && (
                        <div className="mt-1.5 ml-1 border-l-2 border-indigo-100 pl-2">
                          <SubTaskTree
                            items={kids}
                            childrenByParent={childrenByParent}
                            openTaskIds={openTaskIds}
                            toggleOpen={toggleOpen}
                            canEdit={canEdit}
                            busy={busy}
                            onCheck={onCheck}
                            depth={0}
                          />
                        </div>
                      )}
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

// ─── Flat data notice ──────────────────────────────────────────

function FlatDataNotice({ count }: { count: number }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-900 flex items-start gap-2 shadow-sm">
      <Info className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
      <div className="flex-1">
        <b>This schedule is flat.</b> All {count} rows imported as top-level tasks because the MPP didn&apos;t carry outline structure (or the Render converter hasn&apos;t been redeployed with hierarchy support). Two ways to fix it:
        <ol className="list-decimal ml-5 mt-1 space-y-0.5">
          <li>Redeploy the Render converter, then re-import — MPXJ will preserve any outline that&apos;s in the .mpp itself.</li>
          <li>Use the <b>checkbox on the left of each row</b> to select tasks, then <b>Group under parent</b> to build the WBS in-app right now.</li>
        </ol>
      </div>
    </div>
  );
}

// ─── Group modal ───────────────────────────────────────────────

function GroupTasksModal({
  orgId, projectId, actorUserId, actorUserName, actorUserEmail, actorUserRole,
  childIds, childNames, existingParents, onClose, onDone,
}: {
  orgId: string;
  projectId: string;
  actorUserId: string;
  actorUserName?: string;
  actorUserEmail?: string;
  actorUserRole?: string;
  childIds: string[];
  childNames: string[];
  existingParents: Milestone[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [existingId, setExistingId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = mode === "new" ? !!name.trim() : !!existingId;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await groupTasksUnderParent({
        orgId, projectId,
        parentName: mode === "new" ? name.trim() : undefined,
        parentId: mode === "existing" ? existingId : undefined,
        childIds,
        actorUserId, actorUserName, actorUserEmail, actorUserRole,
      });
      if (res.errors.length > 0) {
        setError(res.errors.join(" · "));
      } else {
        onDone();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-b from-white to-slate-50/40">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
            <FolderPlus className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Group tasks under a parent</h2>
            <div className="text-[11px] text-slate-600">{childIds.length} task{childIds.length === 1 ? "" : "s"} selected</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
            {(["new", "existing"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1 rounded text-[11px] font-semibold capitalize transition-colors ${
                  mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {m === "new" ? "Create new parent" : "Use existing parent"}
              </button>
            ))}
          </div>

          {mode === "new" ? (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">New parent name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. "Phase 2 — Tear Down"'
                className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                autoFocus
              />
              <div className="text-[11px] text-slate-500 mt-1">
                The parent will be created as a summary task; its date range covers all selected children.
              </div>
            </div>
          ) : (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Existing parent</label>
              {existingParents.length === 0 ? (
                <div className="mt-1 text-xs text-slate-500 italic">No existing parents — create a new one instead.</div>
              ) : (
                <select
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                >
                  <option value="">— pick a parent —</option>
                  {existingParents.map((p) => (
                    <option key={p.id} value={p.id ?? ""}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 max-h-32 overflow-y-auto">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Selected tasks</div>
            <ul className="space-y-0.5">
              {childNames.slice(0, 12).map((n, i) => (
                <li key={i} className="text-[11px] text-slate-700 truncate">{n}</li>
              ))}
              {childNames.length > 12 && (
                <li className="text-[10px] text-slate-500 italic">+{childNames.length - 12} more</li>
              )}
            </ul>
          </div>

          {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button
            onClick={submit}
            disabled={!canSubmit || busy}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md shadow-sm disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
            Group {childIds.length} task{childIds.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Set duration modal ────────────────────────────────────────

function SetDurationModal({
  task, actorUserId, onClose, onDone,
}: {
  task: Milestone;
  actorUserId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const finish = new Date(task.plannedAt as string);
  const start = task.plannedStartAt ? new Date(task.plannedStartAt as string) : null;
  const currentDays = start ? Math.max(1, Math.round((finish.getTime() - start.getTime()) / 86400000) + 1) : 1;
  const [days, setDays] = useState<number>(currentDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!task.id) return;
    setBusy(true); setError(null);
    try {
      const res = await setTaskDuration({ id: task.id, days, actorUserId });
      if (!res.ok) setError(res.error ?? "Couldn't set duration");
      else onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3 bg-gradient-to-b from-white to-slate-50/40">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
            <CalendarRange className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 truncate">Set duration</h2>
            <div className="text-[11px] text-slate-600 truncate">{task.name}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Days the task runs</label>
          <input
            type="number" min={1} max={365}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
          />
          <div className="text-[11px] text-slate-500">
            Ends on <b>{finish.toLocaleDateString()}</b>. {days > 1 ? `Starts ${days - 1} days earlier — task appears on every day in that range with the same sub-task accordion.` : "Single-day task — appears only on its finish date."}
          </div>
          {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md shadow-sm disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarRange className="w-4 h-4" />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard rail ────────────────────────────────────────────

function ExecutionDashboard({
  milestones, summaries, childrenByParent, activeFilter, onFilterChange, onCollapse,
}: {
  milestones: Milestone[];
  summaries: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  activeFilter: string | null;
  onFilterChange: (id: string | null) => void;
  onCollapse?: () => void;
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
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-200 bg-gradient-to-b from-white to-slate-50/30">
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Progress</div>
          {onCollapse && (
            <button onClick={onCollapse} title="Collapse rail" className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-2xl font-bold tracking-tight text-slate-900">{pct}<span className="text-sm text-slate-500 font-semibold">%</span></div>
          <div className="text-[11px] text-slate-500 ml-auto font-mono">{done} / {total}</div>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
        </div>
        {totalDays > 0 && (
          <div className="mt-2 text-[10px] text-slate-500 font-medium">Day {elapsedDays} of {totalDays}</div>
        )}
        {overdue > 0 && (
          <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-rose-700">
            <AlertTriangle className="w-3 h-3" /> {overdue} overdue
          </div>
        )}
      </div>

      {summaries.length > 0 && (
        <div className="overflow-y-auto flex-1 min-h-0 p-3 space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-1 mb-1">Groups</div>
          {summaries.map((s) => {
            const prog = summaryProgress(s);
            const active = activeFilter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onFilterChange(active ? null : (s.id ?? null))}
                className={`w-full text-left rounded-md px-2.5 py-1.5 border transition-colors ${
                  active ? "bg-indigo-50 border-indigo-300" : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-900">
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
  if (status === "planned") return null;
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
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold border ${styles[status]}`}>
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
