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

import React, { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, Crosshair, Layers, Info, GripVertical, CheckSquare, X as XIcon } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";

// A small palette so each top-level group gets its own consistent
// accent stripe across the calendar — this is what lets you tell at a
// glance which group a chip belongs to.
const GROUP_COLORS = [
  { bar: "bg-indigo-500",  soft: "bg-indigo-50 border-indigo-200",  text: "text-indigo-700",  dot: "bg-indigo-500" },
  { bar: "bg-teal-500",    soft: "bg-teal-50 border-teal-200",      text: "text-teal-700",    dot: "bg-teal-500" },
  { bar: "bg-orange-500",  soft: "bg-orange-50 border-orange-200",  text: "text-orange-700",  dot: "bg-orange-500" },
  { bar: "bg-fuchsia-500", soft: "bg-fuchsia-50 border-fuchsia-200",text: "text-fuchsia-700", dot: "bg-fuchsia-500" },
  { bar: "bg-sky-500",     soft: "bg-sky-50 border-sky-200",        text: "text-sky-700",     dot: "bg-sky-500" },
  { bar: "bg-lime-600",    soft: "bg-lime-50 border-lime-200",      text: "text-lime-700",    dot: "bg-lime-600" },
  { bar: "bg-rose-500",    soft: "bg-rose-50 border-rose-200",      text: "text-rose-700",    dot: "bg-rose-500" },
  { bar: "bg-violet-500",  soft: "bg-violet-50 border-violet-200",  text: "text-violet-700",  dot: "bg-violet-500" },
];

interface Props {
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  canEdit: boolean;
  /** Reschedule a node (and, via the reflow engine, its subtree +
   *  ancestors) by a day delta. */
  onMoveDays?: (id: string, deltaDays: number) => void;
  /** One-click status change straight from a chip. */
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => Promise<boolean>;
  /** Bulk status across a selection (routes through undo in the parent). */
  onBulkStatus?: (ids: string[], status: MilestoneStatus) => void;
  /** Bulk move across a selection (routes through the confirmation). */
  onBulkMove?: (ids: string[], deltaDays: number) => void;
  onOpenDetail: (m: Milestone) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduleCalendarTileView({ milestones, childrenByParent, canEdit, onMoveDays, onSetStatus, onBulkStatus, onBulkMove, onOpenDetail }: Props) {
  // Multi-select for bulk actions on the calendar (mirrors the timeline).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = useCallback((id: string) => {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  // Tasks vs subtasks: a global toggle that breaks EVERY task into its
  // sub-items across the grid (a deliberate, understood mode). For
  // looking at ONE task's steps, the chevron opens a small popover
  // right at the chip instead — no scatter, nothing disappears.
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [subPopover, setSubPopover] = useState<{ ms: Milestone; top: number; left: number } | null>(null);
  const today = useMemo(() => startOfDayUTC(new Date()), []);

  const byId = useMemo(() => {
    const m = new Map<string, Milestone>();
    for (const x of milestones) if (x.id) m.set(x.id, x);
    return m;
  }, [milestones]);

  // Ancestry chain for a task, nearest parent first: e.g.
  // ["Shut Down Transmix 1", "Transmix 1", "DEC OUTAGE 10.25"].
  const ancestorsOf = useCallback((m: Milestone): Milestone[] => {
    if (!m.id) return [];
    const chain: Milestone[] = [];
    const guard = new Set<string>();
    let cur = m.parentId ? byId.get(m.parentId) : undefined;
    while (cur && cur.id && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }, [byId]);

  // The top-level group a task rolls up to (the outermost ancestor, or
  // the task itself if it's already top level). Drives the per-group
  // color so a day's chips can be grouped by their top-level group.
  const topGroupOf = useCallback((m: Milestone): Milestone => {
    const chain = ancestorsOf(m);
    return chain.length > 0 ? chain[chain.length - 1] : m;
  }, [ancestorsOf]);

  // Stable color index per top-level group.
  const groupColorIndex = useMemo(() => {
    const tops = milestones
      .filter((m) => !m.parentId || !byId.has(m.parentId))
      .sort((a, b) => startMs(a) - startMs(b));
    const idx = new Map<string, number>();
    tops.forEach((t, i) => { if (t.id) idx.set(t.id, i % GROUP_COLORS.length); });
    return idx;
  }, [milestones, byId]);

  const isLeaf = useCallback((m: Milestone) => {
    const kids = m.id ? (childrenByParent.get(m.id) ?? []) : [];
    return kids.length === 0;
  }, [childrenByParent]);

  const leafDescendants = useCallback((m: Milestone): Milestone[] => {
    const out: Milestone[] = [];
    const stack = [...(m.id ? childrenByParent.get(m.id) ?? [] : [])];
    while (stack.length) {
      const cur = stack.pop()!;
      const kids = cur.id ? childrenByParent.get(cur.id) ?? [] : [];
      if (kids.length === 0) out.push(cur); else stack.push(...kids);
    }
    return out;
  }, [childrenByParent]);

  // Which rows actually get placed on the grid. A "main" is a leaf, or
  // a task with at least one leaf child (its bar). But when a main is
  // expanded (or global subtask mode is on), we place its individual
  // leaf children instead — so a single sub-item can be dragged on its
  // own day while its siblings stay put.
  const mains = useMemo(() => {
    const out: Milestone[] = [];
    for (const m of milestones) {
      if (!m.plannedAt) continue;
      const kids = m.id ? (childrenByParent.get(m.id) ?? []) : [];
      const isMain = kids.length === 0 || kids.some((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
      if (!isMain) continue;
      const exploded = kids.length > 0 && showSubtasks;
      if (exploded) {
        for (const leaf of leafDescendants(m)) if (leaf.plannedAt) out.push(leaf);
      } else {
        out.push(m);
      }
    }
    return out;
  }, [milestones, childrenByParent, showSubtasks, leafDescendants]);

  // Distinct top-level groups that actually have rendered tasks beneath
  // them, in calendar order — used for the group color legend.
  const units = useMemo(() => {
    const seen = new Map<string, Milestone>();
    for (const m of mains) {
      const u = topGroupOf(m);
      const key = u.id ?? u.name;
      if (!seen.has(key)) seen.set(key, u);
    }
    return Array.from(seen.values()).sort((a, b) => startMs(a) - startMs(b));
  }, [mains, topGroupOf]);

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

  const onDropDay = (targetKey: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragId(null);
    if (!canEdit || !onMoveDays) return;
    const payload = e.dataTransfer.getData("text/plain"); // "<id>|<chipYmd>"
    const [id, chipYmd] = payload.split("|");
    if (!id || !chipYmd) return;
    const delta = dayDiff(ymdToDate(chipYmd), ymdToDate(targetKey));
    if (delta === 0) return;
    // The reflow engine (in the parent) moves this node + its subtree
    // and bleeds ancestors. Dragging a single subtask therefore moves
    // ONLY it; siblings stay; the parent span follows.
    onMoveDays(id, delta);
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
      {/* Bulk action bar — appears when chips are selected. */}
      {canEdit && selected.size > 0 && (
        <div className="px-3 py-2 border-b border-indigo-200 bg-indigo-50/70 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-indigo-900">{selected.size} selected</span>
          <div className="inline-flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Mark</span>
            {([["completed", "Done", "bg-emerald-600"], ["in_progress", "Doing", "bg-blue-600"], ["on_hold", "Hold", "bg-amber-600"], ["blocked", "Block", "bg-rose-600"]] as const).map(([s, label, bg]) => (
              <button key={s} onClick={() => { onBulkStatus?.(Array.from(selected), s); clearSelection(); }} className={`px-2 py-1 rounded-md text-white text-[11px] font-bold ${bg} hover:brightness-110`}>{label}</button>
            ))}
          </div>
          <span className="w-px h-4 bg-indigo-200" />
          <div className="inline-flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Move</span>
            <button onClick={() => onBulkMove?.(Array.from(selected), -1)} className="px-1.5 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 text-[11px] font-bold">−1d</button>
            <button onClick={() => onBulkMove?.(Array.from(selected), 1)} className="px-1.5 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 text-[11px] font-bold">+1d</button>
          </div>
          <button onClick={clearSelection} className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        </div>
      )}
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
        <div className="ml-auto inline-flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Show</span>
          <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
            {([["tasks", "Tasks"], ["subtasks", "Sub-tasks"]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setShowSubtasks(id === "subtasks")}
                className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${(id === "subtasks") === showSubtasks ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                title={id === "subtasks" ? "Break every task into its sub-items so you can drag each one onto its own day" : "Show parent tasks; click a task's ▸ arrow to reach its sub-items"}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Group legend — decodes the color stripe so you can scan a day
          and instantly see which top-level group each chip rolls up to.
          "Group" is whatever the schedule's top-level WBS is — a unit,
          area, zone, phase, sub-project, etc. */}
      {units.length > 1 && (
        <div className="px-3 py-1.5 border-b border-slate-100 bg-white flex items-center gap-3 flex-wrap text-[10px]">
          <span className="font-black uppercase tracking-widest text-slate-400">Groups</span>
          {units.map((u) => {
            const color = GROUP_COLORS[(u.id ? groupColorIndex.get(u.id) : undefined) ?? 0];
            return (
              <span key={u.id ?? u.name} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${color.bar}`} />
                <span className="font-semibold text-slate-600">{u.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* How-to strip — explicit, state-aware instructions so moving
          sub-items is never a mystery. */}
      <div className="px-3 py-2 border-b border-slate-100 bg-indigo-50/40 flex items-center gap-2 flex-wrap text-[11px] text-slate-600">
        <Info className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        {showSubtasks ? (
          <span><b className="text-slate-800">Sub-item mode:</b> each step is its own chip. Drag its <GripVertical className="inline w-3 h-3 align-middle text-slate-500" /> handle to another day to move just that step — the rest stay put and the parent stretches to follow.</span>
        ) : (
          <span><b className="text-slate-800">To move one sub-item:</b> click a task&apos;s <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-indigo-600 text-white align-middle"><ChevronRight className="w-3 h-3" /></span> to pop open its steps, then use each step&apos;s ◀ ▶ buttons. Or flip <b>Show → Sub-items</b> to spread every step across the grid as draggable chips.</span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-slate-400">
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-400 border border-black/10" /> dot = status</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><GripVertical className="w-3 h-3" /> handle = drag</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><CheckSquare className="w-3 h-3" /> select for bulk</span>
        </span>
      </div>

      {/* Marks legend */}
      <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50/40 flex items-center gap-3 flex-wrap text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-indigo-600 text-white"><ChevronRight className="w-3 h-3" /></span> expand a task to its steps</span>
        <span className="inline-flex items-center gap-1"><GripVertical className="w-3 h-3" /> drag handle (move to another day)</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-400 border border-black/10" /> status dot (click to change)</span>
        <span className="inline-flex items-center gap-1"><span className="text-[8.5px] font-bold px-1 rounded bg-black/10">2/3</span> day 2 of a 3-day task</span>
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
                  {shown.map((p) => {
                    const unit = topGroupOf(p.ms);
                    const color = GROUP_COLORS[(unit.id ? groupColorIndex.get(unit.id) : undefined) ?? 0];
                    const chain = ancestorsOf(p.ms);
                    // Offer expand on any day the parent bar shows, so
                    // the arrow is reachable wherever you're looking.
                    const canExpand = !isLeaf(p.ms) && !showSubtasks;
                    return (
                      <Chip
                        key={`${p.ms.id}-${p.dayIndex}`}
                        ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
                        childrenByParent={childrenByParent}
                        ancestors={chain} color={color}
                        canEdit={canEdit}
                        draggable={canEdit && !!p.ms.id}
                        onDragStart={(e) => { setDragId(p.ms.id ?? null); e.dataTransfer.setData("text/plain", `${p.ms.id}|${key}`); }}
                        onClick={() => { if (selected.size > 0 && p.ms.id) toggleSelected(p.ms.id); else onOpenDetail(p.ms); }}
                        onSetStatus={onSetStatus}
                        canExpand={canExpand}
                        isExpanded={subPopover?.ms.id === p.ms.id}
                        onToggleExpand={canExpand && p.ms.id ? (e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setSubPopover((cur) => cur?.ms.id === p.ms.id ? null : { ms: p.ms, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 320) });
                        } : undefined}
                        selectable={canEdit && p.dayIndex === 0}
                        selected={!!p.ms.id && selected.has(p.ms.id)}
                        onToggleSelect={() => p.ms.id && toggleSelected(p.ms.id)}
                        dimmed={!!dragId && dragId === p.ms.id}
                      />
                    );
                  })}
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
            <div className="max-h-[60vh] overflow-y-auto p-2 space-y-3">
              {groupByTop(byDay.get(overflowDay) ?? [], topGroupOf).map((grp) => {
                const color = GROUP_COLORS[(grp.unit.id ? groupColorIndex.get(grp.unit.id) : undefined) ?? 0];
                return (
                  <div key={grp.unit.id ?? grp.unit.name}>
                    <div className="flex items-center gap-1.5 px-1 mb-1">
                      <span className={`w-2 h-2 rounded-sm ${color.dot}`} />
                      <span className={`text-[11px] font-black uppercase tracking-wider ${color.text}`}>{grp.unit.name}</span>
                    </div>
                    <div className="space-y-1 pl-1">
                      {grp.items.map((p) => (
                        <Chip
                          key={`${p.ms.id}-${p.dayIndex}`}
                          ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
                          childrenByParent={childrenByParent}
                          ancestors={ancestorsOf(p.ms)} color={color}
                          canEdit={canEdit}
                          draggable={false}
                          onClick={() => { setOverflowDay(null); onOpenDetail(p.ms); }}
                          onSetStatus={onSetStatus}
                          full
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Sub-items popover — opens at the chip's chevron. Lists this
          task's steps with date, status, and move buttons. Nothing
          leaves the grid; this is the Outlook 'click → small window'. */}
      {subPopover && (
        <div className="fixed inset-0 z-[160]" onClick={() => setSubPopover(null)}>
          <div
            className="absolute w-[300px] max-h-[60vh] overflow-y-auto bg-white rounded-xl shadow-2xl ring-1 ring-slate-900/10 border border-slate-200"
            style={{ top: subPopover.top, left: subPopover.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-slate-200 bg-slate-50/60 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
              <span className="text-[12px] font-bold text-slate-900 truncate flex-1">{subPopover.ms.name}</span>
              <button onClick={() => { onOpenDetail(subPopover.ms); setSubPopover(null); }} className="text-[10px] font-bold text-indigo-700 hover:underline shrink-0">Open</button>
            </div>
            <ul className="divide-y divide-slate-100">
              {leafDescendants(subPopover.ms).map((leaf) => (
                <li key={leaf.id} className="px-3 py-2 flex items-center gap-2">
                  <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
                    <StatusControl
                      status={leaf.status} size="sm" variant="dot" disabled={!canEdit || !onSetStatus || !leaf.id}
                      onPick={(st, reason) => { if (leaf.id && onSetStatus) void onSetStatus(leaf.id, st, reason); }}
                    />
                  </span>
                  <button onClick={() => { onOpenDetail(leaf); setSubPopover(null); }} className="flex-1 min-w-0 text-left">
                    <span className={`block text-[12px] truncate ${leaf.status === "completed" ? "line-through text-slate-400" : "text-slate-700"}`}>{leaf.name}</span>
                    <span className="block text-[9px] text-slate-400 font-mono">{new Date(leaf.plannedAt as string).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</span>
                  </button>
                  {canEdit && onMoveDays && leaf.id && (
                    <span className="shrink-0 flex items-center gap-0.5">
                      <button onClick={() => onMoveDays(leaf.id!, -1)} title="1 day earlier" className="w-5 h-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-indigo-700 hover:bg-indigo-50"><ChevronLeft className="w-3.5 h-3.5" /></button>
                      <button onClick={() => onMoveDays(leaf.id!, 1)} title="1 day later" className="w-5 h-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-indigo-700 hover:bg-indigo-50"><ChevronRight className="w-3.5 h-3.5" /></button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="px-3 py-2 border-t border-slate-100 text-[10px] text-slate-400">
              Dot = set status · ◀ ▶ = move this step a day (others stay put; the parent span follows).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({
  ms, dayIndex, spanDays, childrenByParent, ancestors, color, canEdit, draggable, onDragStart, onClick,
  onSetStatus, canExpand, isExpanded, onToggleExpand, selectable, selected, onToggleSelect, dimmed, full,
}: {
  ms: Milestone; dayIndex: number; spanDays: number;
  childrenByParent: Map<string, Milestone[]>;
  ancestors?: Milestone[];
  color?: { bar: string; soft: string; text: string; dot: string };
  canEdit?: boolean;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onClick: () => void;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => Promise<boolean>;
  canExpand?: boolean; isExpanded?: boolean; onToggleExpand?: (e: React.MouseEvent) => void;
  selectable?: boolean; selected?: boolean; onToggleSelect?: () => void;
  dimmed?: boolean; full?: boolean;
}) {
  const tone = chipTone(ms.status);
  const kids = ms.id ? (childrenByParent.get(ms.id) ?? []) : [];
  const leafKids = kids.filter((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
  const done = leafKids.filter((k) => k.status === "completed").length;
  const hasSubs = leafKids.length > 0;
  const pct = hasSubs ? Math.round((done / leafKids.length) * 100) : 0;
  const time = timeLabel(ms);

  // The immediate parent (e.g. "Shut Down Transmix 1") and the full
  // path up to the unit, so the chip is never context-free.
  const parentLabel = ancestors && ancestors.length > 0 ? ancestors[0].name : null;
  const breadcrumb = ancestors && ancestors.length > 0
    ? ancestors.slice().reverse().map((a) => a.name).join(" › ")
    : null;

  // Plain-English tooltip so nothing on the chip is cryptic.
  const tip = [
    breadcrumb ? `${breadcrumb} ›` : null,
    ms.name,
    `Status: ${statusLabel(ms.status)}`,
    spanDays > 1 ? `Day ${dayIndex + 1} of ${spanDays} (multi-day task)` : null,
    hasSubs ? `${done} of ${leafKids.length} subtasks done` : null,
    time ? `Time: ${time}` : null,
    ms.workOrderRef ? `WO ${ms.workOrderRef}` : null,
    ms.location ? `Location: ${ms.location}` : null,
    "— Click to open · drag to another day to reschedule",
  ].filter(Boolean).join("\n");

  return (
    <div
      onClick={onClick}
      title={tip}
      className={`group/chip relative w-full text-left rounded-md border pl-2 pr-1 py-1 overflow-hidden cursor-pointer ${tone} ${dimmed ? "opacity-40" : ""} ${selected ? "ring-2 ring-indigo-500 ring-offset-1" : ""}`}
    >
      {/* Unit accent stripe — same color for every task in a unit. */}
      {color && <span className={`absolute left-0 top-0 bottom-0 w-1 ${color.bar}`} aria-hidden />}

      {/* Select toggle — shows on hover (or always when selected) so the
          whole-chip click can open OR add to a multi-select. */}
      {selectable && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
          title={selected ? "Deselect" : "Select for bulk actions"}
          className={`absolute top-0.5 right-0.5 z-10 w-4 h-4 rounded border flex items-center justify-center transition-opacity ${selected ? "bg-indigo-600 border-indigo-600 text-white opacity-100" : "bg-white border-slate-300 text-transparent opacity-0 group-hover/chip:opacity-100"}`}
        >
          <CheckSquare className="w-3 h-3" />
        </button>
      )}

      {/* Parent / unit label so you always know what this belongs to. */}
      {parentLabel && (
        <div className={`flex items-center gap-1 ${color?.text ?? "text-slate-500"} ${full ? "" : "truncate"}`}>
          <Layers className="w-2.5 h-2.5 shrink-0 opacity-80" />
          <span className="text-[8.5px] font-bold uppercase tracking-wide truncate">{parentLabel}</span>
        </div>
      )}

      <div className="flex items-center gap-1">
        {/* Status dot — same picker as everywhere; click for the full
            list (doing / done / on-hold / blocked), not just done. */}
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <StatusControl
            status={ms.status}
            size="sm"
            variant="dot"
            disabled={!canEdit || !onSetStatus || !ms.id}
            onPick={(st, reason) => { if (ms.id && onSetStatus) void onSetStatus(ms.id, st, reason); }}
          />
        </span>
        {canExpand && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand?.(e); }}
            title={isExpanded ? "Hide sub-items" : "Show this task's sub-items"}
            className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${isExpanded ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-300 text-slate-600 hover:border-indigo-400 hover:text-indigo-600"}`}
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} strokeWidth={2.5} />
          </button>
        )}
        {hasSubs && !canExpand && <Layers className="w-2.5 h-2.5 shrink-0 opacity-70" />}
        <span className={`text-[10.5px] font-semibold leading-tight ${full ? "" : "truncate"} ${ms.status === "completed" ? "line-through opacity-70" : ""}`}>{ms.name}</span>
        {spanDays > 1 && (
          <span className="ml-auto shrink-0 text-[8.5px] font-bold px-1 rounded bg-black/10" title={`Day ${dayIndex + 1} of ${spanDays}`}>
            {dayIndex + 1}/{spanDays}
          </span>
        )}
        {/* The ONLY draggable part — a clear grip. Clicking elsewhere on
            the chip opens it; only this handle starts a drag, so the
            status dot and expand arrow stay clickable. */}
        {draggable && (
          <span
            draggable
            onDragStart={onDragStart}
            onClick={(e) => e.stopPropagation()}
            title="Drag this handle to move to another day"
            className={`${spanDays > 1 ? "" : "ml-auto"} shrink-0 inline-flex items-center justify-center w-4 h-5 rounded text-slate-400 hover:text-slate-700 hover:bg-black/10 cursor-grab active:cursor-grabbing`}
          >
            <GripVertical className="w-3 h-3" />
          </span>
        )}
      </div>
      {hasSubs && (
        <div className="mt-1 pl-2.5 flex items-center gap-1">
          <span className="h-1 flex-1 rounded-full bg-black/10 overflow-hidden">
            <span className="block h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[8.5px] font-mono opacity-70">{done}/{leafKids.length}</span>
        </div>
      )}
      {full && (time || ms.workOrderRef) && (
        <div className="pl-2.5 mt-0.5 text-[9px] font-mono opacity-70">
          {[time, ms.workOrderRef ? `WO ${ms.workOrderRef}` : null].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

// Group a day's placements by their top-level unit, preserving unit
// order by earliest start, and tasks within a unit by start time.
function groupByTop(
  items: Array<{ ms: Milestone; dayIndex: number; spanDays: number }>,
  topGroupOf: (m: Milestone) => Milestone,
): Array<{ unit: Milestone; items: typeof items }> {
  const groups = new Map<string, { unit: Milestone; items: typeof items }>();
  for (const it of items) {
    const unit = topGroupOf(it.ms);
    const key = unit.id ?? unit.name;
    if (!groups.has(key)) groups.set(key, { unit, items: [] });
    groups.get(key)!.items.push(it);
  }
  const out = Array.from(groups.values());
  out.sort((a, b) => startMs(a.unit) - startMs(b.unit));
  for (const g of out) g.items.sort((a, b) => startMs(a.ms) - startMs(b.ms));
  return out;
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

function statusLabel(s: MilestoneStatus): string {
  return s === "in_progress" ? "In progress" : s === "on_hold" ? "On hold" : s.charAt(0).toUpperCase() + s.slice(1);
}

// A "6am–2pm" style label when the task carries times-of-day, else "".
function timeLabel(m: Milestone): string {
  const startIso = m.plannedStartAt as string | undefined;
  const finishIso = m.plannedAt as string;
  const s = startIso ? new Date(startIso) : null;
  const f = new Date(finishIso);
  const hasS = s && (s.getUTCHours() !== 0 || s.getUTCMinutes() !== 0);
  const hasF = f.getUTCHours() !== 0 || f.getUTCMinutes() !== 0;
  const t = (d: Date) => `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (hasS && hasF && s) return `${t(s)}–${t(f)}`;
  if (hasF) return `ends ${t(f)}`;
  if (hasS && s) return `starts ${t(s)}`;
  return "";
}
