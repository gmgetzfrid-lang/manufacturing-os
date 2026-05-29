"use client";

// ExecutionView — the day-by-day operational schedule.
//
// Layout: left dashboard rail with rolled-up project metrics, right
// week-grid of calendar tiles (Outlook-style). Each tile is a
// scheduled task block stacked on the day it runs, sized roughly
// by duration, color-coded by shift, and expandable into its
// sub-tasks with click-to-complete checkboxes.
//
// Drag a tile to another day column to reschedule — start + finish
// shift by the date delta, time-of-day is preserved. Optimistic
// updates write through to the DB.
//
// This view assumes a real WBS: parent tasks roll up child status
// and progress is computed from leaf completion, not weight tricks.

import React, { useCallback, useMemo, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown, Sun, Moon,
  CalendarDays, AlertTriangle, CircleCheck, Circle, Loader2,
  Flag, TrendingDown, TrendingUp, Layers,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneShift } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  canEdit: boolean;
  /** Returns true if the move succeeded; caller writes to DB. */
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
  const [cursor, setCursor] = useState<Date>(() => startOfWeek(new Date()));
  const [mode, setMode] = useState<ViewMode>("week");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOverIso, setDragOverIso] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const today = useMemo(() => startOfDay(new Date()), []);

  // ── Index milestones by parent for fast subtask lookup ───────
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

  // Leaves = tasks with no children (the executable work units).
  const leafIds = useMemo(() => {
    const parents = new Set<string>();
    for (const ms of milestones) if (ms.parentId) parents.add(ms.parentId);
    return new Set(
      milestones
        .filter((ms) => ms.id && !parents.has(ms.id!))
        .map((ms) => ms.id!)
    );
  }, [milestones]);

  // Top-level rendered rows: tasks that have a planned date and
  // (a) no parent, OR (b) parent is summary — we visualize the
  // PARENT block on its date range; children only show when
  // expanded.
  const renderable = useMemo(() => {
    return milestones.filter((ms) => {
      if (!ms.plannedAt) return false;
      return !ms.parentId; // only top-level tiles on the canvas
    });
  }, [milestones]);

  // ── Bucket by day ────────────────────────────────────────────
  const byDate = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const ms of renderable) {
      // Anchor on plannedStartAt if available, else plannedAt (finish).
      const start = (ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string);
      const k = ymdLocal(new Date(start));
      const arr = m.get(k) ?? [];
      arr.push(ms);
      m.set(k, arr);
    }
    // Sort each day's tiles by start time.
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const ax = new Date((a.plannedStartAt as string) ?? (a.plannedAt as string)).getTime();
        const bx = new Date((b.plannedStartAt as string) ?? (b.plannedAt as string)).getTime();
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

  // ── Status rollup ────────────────────────────────────────────
  const rolledStatus = useCallback((ms: Milestone): MilestoneStatus => {
    if (!ms.isSummary) return ms.status;
    const kids = childrenByParent.get(ms.id ?? "") ?? [];
    if (kids.length === 0) return ms.status;
    const allDone = kids.every((k) => k.status === "completed");
    const someProg = kids.some((k) => k.status === "in_progress" || k.status === "completed");
    if (allDone) return "completed";
    if (someProg) return "in_progress";
    return "planned";
  }, [childrenByParent]);

  const subtaskProgress = useCallback((ms: Milestone): { done: number; total: number } => {
    const kids = collectLeafDescendants(ms, childrenByParent);
    const done = kids.filter((k) => k.status === "completed").length;
    return { done, total: kids.length };
  }, [childrenByParent]);

  // ── Drag-drop reschedule ─────────────────────────────────────
  const onDrop = useCallback(async (dateIso: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIso(null);
    if (!canEdit || !onMove) return;
    const id = e.dataTransfer.getData("text/milestone-id");
    if (!id) return;
    const ms = milestones.find((m) => m.id === id);
    if (!ms) return;
    const oldStart = new Date((ms.plannedStartAt as string) ?? (ms.plannedAt as string));
    const oldFinish = new Date(ms.plannedAt as string);
    const target = new Date(`${dateIso}T00:00:00`);
    const dayDelta = Math.round((target.getTime() - new Date(ymdLocal(oldStart) + "T00:00:00").getTime()) / 86400000);
    const newStart = new Date(oldStart); newStart.setDate(newStart.getDate() + dayDelta);
    const newFinish = new Date(oldFinish); newFinish.setDate(newFinish.getDate() + dayDelta);
    setBusy((s) => new Set(s).add(id));
    try {
      await onMove(id, newStart.toISOString(), newFinish.toISOString());
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onMove, milestones]);

  const onToggleSubtask = useCallback(async (subId: string, current: MilestoneStatus) => {
    if (!canEdit || !onSetStatus) return;
    const next: MilestoneStatus = current === "completed" ? "planned" : "completed";
    setBusy((s) => new Set(s).add(subId));
    try { await onSetStatus(subId, next); }
    finally { setBusy((s) => { const n = new Set(s); n.delete(subId); return n; }); }
  }, [canEdit, onSetStatus]);

  // ── Header navigation ────────────────────────────────────────
  const onPrev = () => {
    const d = new Date(cursor);
    d.setDate(d.getDate() - (mode === "week" ? 7 : 1));
    setCursor(d);
  };
  const onNext = () => {
    const d = new Date(cursor);
    d.setDate(d.getDate() + (mode === "week" ? 7 : 1));
    setCursor(d);
  };
  const onToday = () => setCursor(mode === "week" ? startOfWeek(new Date()) : startOfDay(new Date()));

  const headerLabel = mode === "week"
    ? `${days[0].toLocaleString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
    : days[0].toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-3">
      {/* Dashboard rail */}
      <ExecutionDashboard milestones={milestones} leafIds={leafIds} childrenByParent={childrenByParent} />

      {/* Calendar canvas */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2">
            <button onClick={onPrev} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Previous">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-sm font-black text-slate-900 min-w-[200px] text-center">{headerLabel}</div>
            <button onClick={onNext} className="p-1 rounded hover:bg-slate-200 text-slate-600" title="Next">
              <ChevronRight className="w-4 h-4" />
            </button>
            <button onClick={onToday} className="ml-2 inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-200">
              <CalendarDays className="w-3 h-3" /> Today
            </button>
          </div>
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
            return (
              <div key={iso} className={`px-3 py-2 border-r border-slate-200 last:border-r-0 ${isToday ? "bg-indigo-50/60" : ""}`}>
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  {d.toLocaleString(undefined, { weekday: "short" })}
                </div>
                <div className={`text-base font-black ${isToday ? "text-indigo-700" : "text-slate-900"}`}>
                  {d.getDate()}
                </div>
                <div className="text-[10px] text-slate-500">
                  {(byDate.get(iso)?.length ?? 0)} task{(byDate.get(iso)?.length ?? 0) === 1 ? "" : "s"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Day columns */}
        <div className={`grid ${mode === "week" ? "grid-cols-7" : "grid-cols-1"} min-h-[60vh]`}>
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
                className={`p-2 border-r border-slate-200 last:border-r-0 space-y-1.5 ${
                  isToday ? "bg-indigo-50/20" : ""
                } ${isOver ? "bg-indigo-100/40 ring-2 ring-indigo-400 ring-inset" : ""}`}
              >
                {items.length === 0 ? (
                  <div className="text-[10px] text-slate-300 italic text-center pt-4">—</div>
                ) : items.map((ms) => (
                  <ExecutionTile
                    key={ms.id}
                    ms={ms}
                    expanded={expanded.has(ms.id ?? "")}
                    onToggleExpand={() => {
                      const id = ms.id ?? "";
                      setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
                    }}
                    onToggleSubtask={onToggleSubtask}
                    children_={childrenByParent.get(ms.id ?? "") ?? []}
                    childrenByParent={childrenByParent}
                    rolledStatus={rolledStatus(ms)}
                    progress={subtaskProgress(ms)}
                    canEdit={canEdit}
                    busy={busy}
                  />
                ))}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-2 border-t border-slate-200 bg-slate-50/40 text-[10px] text-slate-500 flex items-center justify-between">
          <span>
            {canEdit
              ? "Drag tiles between days to reschedule · click to expand sub-tasks · check sub-tasks to mark complete"
              : "Read-only view"}
          </span>
          <span className="font-mono">{renderable.length} top-level task{renderable.length === 1 ? "" : "s"}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Single tile ────────────────────────────────────────────────

interface TileProps {
  ms: Milestone;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleSubtask: (id: string, current: MilestoneStatus) => void;
  children_: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  rolledStatus: MilestoneStatus;
  progress: { done: number; total: number };
  canEdit: boolean;
  busy: Set<string>;
}

function ExecutionTile({
  ms, expanded, onToggleExpand, onToggleSubtask, children_,
  childrenByParent, rolledStatus, progress, canEdit, busy,
}: TileProps) {
  const start = (ms.plannedStartAt as string | undefined) ?? (ms.plannedAt as string);
  const finish = ms.plannedAt as string;
  const shift = ms.shift ?? "day";
  const tone = SHIFT_TONE[shift];
  const ShiftIcon = shift === "night" ? Moon : Sun;
  const isBusy = ms.id ? busy.has(ms.id) : false;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      draggable={canEdit && !!ms.id}
      onDragStart={(e) => { if (ms.id) { e.dataTransfer.setData("text/milestone-id", ms.id); e.dataTransfer.effectAllowed = "move"; } }}
      className={`relative rounded-lg border border-slate-200 ${tone.bg} ring-1 ${tone.ring} shadow-sm hover:shadow-md transition-shadow ${isBusy ? "opacity-60" : ""}`}
    >
      {/* Shift accent bar */}
      <div className={`absolute left-0 top-1 bottom-1 w-0.5 rounded-r ${tone.bar}`} aria-hidden />

      <button
        onClick={onToggleExpand}
        className="w-full text-left p-2 pl-3"
      >
        <div className="flex items-center justify-between gap-1.5 text-[10px] text-slate-600">
          <span className="font-mono">{timeOnly(start)}–{timeOnly(finish)}</span>
          <span className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded ${tone.chip} text-[9px] font-black uppercase tracking-widest`}>
            <ShiftIcon className="w-2.5 h-2.5" /> {shift}
          </span>
        </div>
        <div className="mt-1 text-[12px] font-black text-slate-900 leading-snug line-clamp-2">{ms.name}</div>
        {(ms.wbs || progress.total > 0) && (
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600">
            {ms.wbs && <span className="font-mono text-slate-500">{ms.wbs}</span>}
            {progress.total > 0 && (
              <span className={`inline-flex items-center gap-0.5 font-bold ${pct === 100 ? "text-emerald-700" : "text-slate-700"}`}>
                <Layers className="w-2.5 h-2.5" /> {progress.done}/{progress.total}
              </span>
            )}
            <span className={`ml-auto text-[9px] font-black uppercase tracking-wider px-1 py-0.5 rounded ${STATUS_TONE[rolledStatus]}`}>
              {humanStatus(rolledStatus)}
            </span>
          </div>
        )}
        {progress.total > 0 && (
          <div className="mt-1 h-1 w-full rounded-full bg-white border border-slate-200 overflow-hidden">
            <div className={`h-full ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {children_.length > 0 && (
          <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-slate-500 font-bold">
            <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "" : "-rotate-90"}`} />
            {expanded ? "Hide" : "Show"} {children_.length} sub-task{children_.length === 1 ? "" : "s"}
          </div>
        )}
      </button>

      {expanded && children_.length > 0 && (
        <div className="border-t border-slate-200/80 px-2 pb-2 pt-1 space-y-0.5">
          {children_.map((c) => (
            <SubtaskRow
              key={c.id}
              ms={c}
              depth={1}
              canEdit={canEdit}
              busy={busy}
              onToggleSubtask={onToggleSubtask}
              childrenByParent={childrenByParent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Recursive sub-task row ────────────────────────────────────

function SubtaskRow({
  ms, depth, canEdit, busy, onToggleSubtask, childrenByParent,
}: {
  ms: Milestone;
  depth: number;
  canEdit: boolean;
  busy: Set<string>;
  onToggleSubtask: (id: string, current: MilestoneStatus) => void;
  childrenByParent: Map<string, Milestone[]>;
}) {
  const kids = ms.id ? (childrenByParent.get(ms.id) ?? []) : [];
  const isLeaf = kids.length === 0;
  const checked = ms.status === "completed";
  const isBusy = ms.id ? busy.has(ms.id) : false;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-0.5"
        style={{ paddingLeft: depth * 12 }}
      >
        {isLeaf ? (
          <button
            onClick={() => { if (ms.id) onToggleSubtask(ms.id, ms.status); }}
            disabled={!canEdit || isBusy}
            className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              checked ? "bg-emerald-500 border-emerald-600 text-white" : "bg-white border-slate-300 hover:border-emerald-400"
            } disabled:opacity-50`}
            title={checked ? "Mark planned" : "Mark complete"}
          >
            {isBusy ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : checked ? <CircleCheck className="w-3 h-3" /> : null}
          </button>
        ) : (
          <Circle className="w-3 h-3 text-slate-400 shrink-0" />
        )}
        <div className={`text-[11px] flex-1 min-w-0 truncate ${checked ? "line-through text-slate-400" : "text-slate-800"}`}>
          {ms.name}
        </div>
        {ms.wbs && <span className="font-mono text-[9px] text-slate-400 shrink-0">{ms.wbs}</span>}
      </div>
      {kids.length > 0 && (
        <div>
          {kids.map((k) => (
            <SubtaskRow
              key={k.id}
              ms={k}
              depth={depth + 1}
              canEdit={canEdit}
              busy={busy}
              onToggleSubtask={onToggleSubtask}
              childrenByParent={childrenByParent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Left dashboard rail ───────────────────────────────────────

function ExecutionDashboard({
  milestones, leafIds, childrenByParent,
}: {
  milestones: Milestone[];
  leafIds: Set<string>;
  childrenByParent: Map<string, Milestone[]>;
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

  // Today's tile
  const todayIso = ymdLocal(today);
  const todays = leaves.filter((m) => {
    const start = (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string | undefined);
    return start ? ymdLocal(new Date(start)) === todayIso : false;
  });

  // Shift breakdown.
  const shiftCounts: Record<MilestoneShift | "unset", number> = { day: 0, night: 0, swing: 0, unset: 0 };
  for (const m of leaves) {
    if (m.shift) shiftCounts[m.shift]++;
    else shiftCounts.unset++;
  }

  // Project span.
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

  // Critical path approximation: top tasks by slip = (today - planned) for incomplete.
  const slipping = leaves
    .filter((m) => m.status !== "completed" && m.plannedAt)
    .map((m) => ({ m, slip: today.getTime() - new Date(m.plannedAt as string).getTime() }))
    .filter((x) => x.slip > 0)
    .sort((a, b) => b.slip - a.slip)
    .slice(0, 5);

  // Critical-path TREND vs yesterday — naïve estimate based on how
  // many leaves slipped overnight. (Real CPM needs predecessors.)
  const trendDirection = slipping.length === 0 ? "none" : "up";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      {/* Project progress */}
      <div className="px-4 py-3 bg-gradient-to-br from-indigo-50 to-white border-b border-slate-200">
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

      {/* Today */}
      <div className="px-4 py-3 border-b border-slate-200">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">Today</div>
        <div className="space-y-0.5 text-[12px]">
          <Row icon={<Flag className="w-3 h-3 text-blue-500" />} value={todays.length} label="scheduled" />
          <Row icon={<AlertTriangle className="w-3 h-3 text-rose-500" />} value={overdue} label="overdue" rose={overdue > 0} />
          <Row icon={<Loader2 className="w-3 h-3 text-amber-500" />} value={inProgress} label="in progress" />
        </div>
      </div>

      {/* Critical-path-ish */}
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

      {/* Shift breakdown */}
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
  if (stack.length === 0) return [root]; // root is itself a leaf
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const kids = cur.id ? (byParent.get(cur.id) ?? []) : [];
    if (kids.length === 0) out.push(cur);
    else stack.push(...kids);
  }
  return out;
}
