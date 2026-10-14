"use client";

// ScheduleCalendarTileView — the Outlook-style month grid for the
// Execution tab. Days and clocks are the PLANT's (project timezone). Each task lands on the day tiles its planned span
// covers (multi-day tasks repeat across tiles with a Day x/n badge),
// colored by status. Drag a chip to another tile to reschedule the
// whole task by that delta; click it to open the full detail panel.
//
// Every task that covers a day is on that day's tile — the schedule
// keeps its integrity. The WORK (leaf tasks, or bottom-level groups in
// Tasks mode) renders as chips in time-of-day order. The GROUPS above
// it (the project root, phases, units) render as thin bands at the top
// of the tile with a Day x/n badge: solid when work under them is
// placed that day, muted when they merely carry over. The rules live in
// lib/calendarPlacement.ts so they're unit-tested. The detail panel
// surfaces a group chip's subtask accordion.

import React, { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CalendarDays, Crosshair, Layers, Info, GripVertical, CheckSquare, X as XIcon, Moon, Sunset } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";
import ProgressControl from "@/components/projects/ProgressControl";
import { GROUP_PALETTE } from "@/lib/scheduleColors";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { splitPlacements, compareDayPlacements, compareBandPlacements, activeWindowOnDay, startMsOf, finishMsOf, type BandPlacement, type DayPlacement } from "@/lib/calendarPlacement";
import { addDays as addDaysTz, addMonths as addMonthsTz, clockLabel, dayDiff as dayDiffTz, dayKey, dayKeyToMs, dayOfWeek, fmtInTz, hasTimeOfDay, tzAbbrev, startOfDay as startOfDayTz, startOfMonth as startOfMonthTz, wallClock } from "@/lib/scheduleTz";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import DayAgendaPanel from "@/components/projects/DayAgendaPanel";
import { overdueOpenWork } from "@/lib/openWork";

// Use the shared palette so a group is the SAME hue here and on the
// timeline. `.rail` is the solid accent (was `.bar` locally).
const GROUP_COLORS = GROUP_PALETTE.map((c) => ({ bar: c.rail, soft: c.soft, text: c.text, dot: c.dot }));

interface Props {
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  canEdit: boolean;
  /** Reschedule a node (and, via the reflow engine, its subtree +
   *  ancestors) by a day delta. */
  onMoveDays?: (id: string, deltaDays: number) => void;
  /** One-click status change straight from a chip. */
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => void;
  /** Set a leaf's physical % complete (derives status). */
  onSetProgress?: (id: string, percent: number) => void;
  /** Per-task effective progress + derived status (leaves: own; summaries:
   *  rolled up), computed once by the parent so chips match the timeline. */
  progress?: Map<string, ProgressInfo>;
  /** Bulk status across a selection (routes through undo in the parent). */
  onBulkStatus?: (ids: string[], status: MilestoneStatus) => void;
  /** Bulk move across a selection (routes through the confirmation). */
  onBulkMove?: (ids: string[], deltaDays: number) => void;
  onOpenDetail: (m: Milestone) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduleCalendarTileView({ milestones, childrenByParent, canEdit, onMoveDays, onSetStatus, onSetProgress, progress, onBulkStatus, onBulkMove, onOpenDetail }: Props) {
  const tz = useScheduleTz();
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
  // The sub-items popover is DAY-SPECIFIC: opened from a chip on a tile, it
  // lists the steps scheduled on that day, with status and progress entry,
  // and tucks the other days' steps behind a toggle.
  const [subPopover, setSubPopover] = useState<{ ms: Milestone; top: number; left: number; dayKey: string } | null>(null);
  const [popoverShowOthers, setPopoverShowOthers] = useState(false);
  // The day agenda: click a day number to get that day's full work list
  // (every step due, grouped by equipment, with progress entry).
  const [agendaDay, setAgendaDay] = useState<string | null>(null);
  const today = useMemo(() => startOfDayUTC(new Date(), tz), [tz]);
  // Overdue open work as of today (plant time): it sits at the top of
  // today's tile in red until it is finished or re-planned.
  const overdueToday = useMemo(() => overdueOpenWork(milestones, today.getTime()), [milestones, today]);

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

  // Chips = the work (leaves, plus bottom-level groups in Tasks mode);
  // bands = every group above it. In Sub-tasks mode every leaf is a chip
  // exactly once so a single sub-item can be dragged on its own day
  // while its siblings stay put. See lib/calendarPlacement.ts.
  const split = useMemo(
    () => splitPlacements(milestones, childrenByParent, showSubtasks),
    [milestones, childrenByParent, showSubtasks],
  );
  const mains = split.chips;
  const bandTasks = split.bands;

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

  const [cursor, setCursor] = useState<Date>(() => firstOfMonthUTC(new Date(), tz));
  // Snap to the schedule's first month if today isn't within the span.
  const didSnap = React.useRef(false);
  React.useEffect(() => {
    if (didSnap.current || !span) return;
    const now = new Date();
    const inSpan = now >= span.earliest && now <= span.latest;
    setCursor(firstOfMonthUTC(inSpan ? now : span.earliest, tz));
    didSnap.current = true;
  }, [span, tz]);

  // Bucket every placed task onto each UTC day it covers, then order
  // each tile by time of day (carry-overs first, then start time).
  const byDay = useMemo(() => {
    const m = new Map<string, DayPlacement<Milestone>[]>();
    for (const ms of mains) {
      const start = startOfDayUTC(new Date(startMs(ms)), tz);
      const finish = startOfDayUTC(new Date(finishMs(ms)), tz);
      const total = Math.max(1, dayDiff(start, finish, tz) + 1);
      // A group chip stands in for its leaf steps: its clock and order on
      // each day come from the steps that actually fall on that day.
      const steps = ms.id ? leafDescendants(ms) : [];
      for (let i = 0; i < total; i++) {
        const d = addDaysUTC(start, i, tz);
        const key = ymd(d, tz);
        const dayStartMs = d.getTime();
        const dayEndMs = addDaysUTC(d, 1, tz).getTime();
        const w = activeWindowOnDay(ms, steps, dayStartMs, dayEndMs);
        const arr = m.get(key) ?? [];
        arr.push({ ms, dayIndex: i, spanDays: total, todayStart: w.start, todayEnd: w.end, idleToday: w.idle });
        m.set(key, arr);
      }
    }
    for (const arr of m.values()) arr.sort(compareDayPlacements);
    return m;
  }, [mains, tz, leafDescendants]);

  // Bucket every group (band) onto each day it covers, root-first, and
  // note whether any chip placed that day sits beneath it.
  const bandsByDay = useMemo(() => {
    const activeAncestors = new Map<string, Set<string>>();
    for (const [key, arr] of byDay) {
      const set = new Set<string>();
      for (const p of arr) for (const a of ancestorsOf(p.ms)) if (a.id) set.add(a.id);
      activeAncestors.set(key, set);
    }
    const m = new Map<string, BandPlacement<Milestone>[]>();
    for (const ms of bandTasks) {
      const s = startMs(ms), f = finishMs(ms);
      if (!Number.isFinite(s) || !Number.isFinite(f)) continue;
      const start = startOfDayUTC(new Date(s), tz);
      const finish = startOfDayUTC(new Date(f), tz);
      const total = Math.max(1, dayDiff(start, finish, tz) + 1);
      const depth = ancestorsOf(ms).length;
      for (let i = 0; i < total; i++) {
        const key = ymd(addDaysUTC(start, i, tz), tz);
        const arr = m.get(key) ?? [];
        arr.push({ ms, dayIndex: i, spanDays: total, depth, hasWorkToday: !!ms.id && (activeAncestors.get(key)?.has(ms.id) ?? false) });
        m.set(key, arr);
      }
    }
    for (const arr of m.values()) arr.sort(compareBandPlacements);
    return m;
  }, [bandTasks, byDay, ancestorsOf, tz]);

  // 6-week grid starting on the Sunday on/before the 1st.
  const weeks = useMemo(() => {
    const first = cursor;
    const gridStart = addDaysUTC(first, -dayOfWeek(first.getTime(), tz), tz);
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDaysUTC(gridStart, w * 7 + d, tz)),
    );
  }, [cursor, tz]);

  const monthIdx = wallClock(cursor.getTime(), tz).month;
  const [overflowDay, setOverflowDay] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Touch-drag state — HTML5 DnD doesn't fire on touch, so we run a parallel
  // pointer-based drag for phones/tablets. A floating ghost follows the finger;
  // on release we hit-test the day cell under the pointer.
  const [touchDrag, setTouchDrag] = useState<{ id: string; chipYmd: string; label: string; x: number; y: number } | null>(null);

  const applyMove = (id: string, chipYmd: string, targetKey: string) => {
    if (!canEdit || !onMoveDays || !id || !chipYmd) return;
    const delta = dayDiff(ymdToDate(chipYmd, tz), ymdToDate(targetKey, tz), tz);
    if (delta === 0) return;
    onMoveDays(id, delta);
  };

  const onDropDay = (targetKey: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragId(null);
    const payload = e.dataTransfer.getData("text/plain"); // "<id>|<chipYmd>"
    const [id, chipYmd] = payload.split("|");
    // The reflow engine (in the parent) moves this node + its subtree
    // and bleeds ancestors. Dragging a single subtask therefore moves
    // ONLY it; siblings stay; the parent span follows.
    applyMove(id, chipYmd, targetKey);
  };

  // Begin a touch drag from a chip grip. Tracks the finger and, on lift,
  // resolves the day cell under the pointer via [data-daykey].
  const startTouchDrag = (id: string, chipYmd: string, label: string, e: React.PointerEvent) => {
    if (!canEdit || e.pointerType === "mouse") return; // mouse keeps native HTML5 DnD
    e.preventDefault();
    e.stopPropagation();
    setDragId(id);
    setTouchDrag({ id, chipYmd, label, x: e.clientX, y: e.clientY });
    const move = (ev: PointerEvent) => setTouchDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cell = el?.closest("[data-daykey]") as HTMLElement | null;
      const targetKey = cell?.getAttribute("data-daykey");
      if (targetKey) applyMove(id, chipYmd, targetKey);
      setDragId(null);
      setTouchDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
      {/* Bulk action bar — appears when chips are selected. */}
      {canEdit && selected.size > 0 && (
        <div className="px-3 py-2 border-b border-[var(--color-accent-ring)]/40 bg-[var(--color-accent-soft)]/70 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-[var(--color-accent)]">{selected.size} selected</span>
          <div className="inline-flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Mark</span>
            {([["completed", "Done", "bg-emerald-600"], ["in_progress", "Doing", "bg-blue-600"], ["on_hold", "Hold", "bg-amber-600"], ["blocked", "Block", "bg-rose-600"]] as const).map(([s, label, bg]) => (
              <button key={s} onClick={() => { onBulkStatus?.(Array.from(selected), s); clearSelection(); }} className={`px-2 py-1 rounded-md text-white text-[11px] font-bold ${bg} hover:brightness-110`}>{label}</button>
            ))}
          </div>
          <span className="w-px h-4 bg-[var(--color-accent-ring)]/30" />
          <div className="inline-flex items-center gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Move</span>
            <button onClick={() => onBulkMove?.(Array.from(selected), -1)} className="px-1.5 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] text-[11px] font-bold">−1d</button>
            <button onClick={() => onBulkMove?.(Array.from(selected), 1)} className="px-1.5 py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] text-[11px] font-bold">+1d</button>
          </div>
          <button onClick={clearSelection} className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--color-accent-ring)]/20 text-[var(--color-accent)] text-[11px] font-bold transition-colors">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        </div>
      )}
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
        <button onClick={() => setCursor(addMonthsUTC(cursor, -1, tz))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><ChevronLeft className="w-4 h-4" /></button>
        <div className="text-sm font-bold text-[var(--color-text)] min-w-[150px] text-center">
          {fmtInTz(cursor, tz, { month: "long", year: "numeric" })}
        </div>
        <button onClick={() => setCursor(addMonthsUTC(cursor, 1, tz))} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><ChevronRight className="w-4 h-4" /></button>
        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title={`Days and times are shown in the plant's zone: ${tz}`}>{tzAbbrev(tz, cursor.getTime())}</span>
        <button onClick={() => setCursor(firstOfMonthUTC(new Date(), tz))} className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] transition-colors">
          <Crosshair className="w-3.5 h-3.5 text-rose-500" /> Today
        </button>
        {span && (
          <button onClick={() => setCursor(firstOfMonthUTC(span.earliest, tz))} className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] transition-colors">
            ⏮ Schedule start
          </button>
        )}
        <div className="ml-auto inline-flex items-center gap-1.5">
          <span className="text-[10px] font-semibold text-[var(--color-text-faint)] uppercase tracking-wide">Show</span>
          <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
            {([["tasks", "Tasks"], ["subtasks", "Sub-tasks"]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setShowSubtasks(id === "subtasks")}
                className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${(id === "subtasks") === showSubtasks ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
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
        <div className="px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center gap-3 flex-wrap text-[10px]">
          <span className="font-black uppercase tracking-widest text-[var(--color-text-faint)]">Groups</span>
          {units.map((u) => {
            const color = GROUP_COLORS[(u.id ? groupColorIndex.get(u.id) : undefined) ?? 0];
            return (
              <span key={u.id ?? u.name} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${color.bar}`} />
                <span className="font-semibold text-[var(--color-text-muted)]">{u.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* How-to strip — explicit, state-aware instructions so moving
          sub-items is never a mystery. */}
      <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/40 flex items-center gap-2 flex-wrap text-[11px] text-[var(--color-text-muted)]">
        <Info className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
        {showSubtasks ? (
          <span><b className="text-[var(--color-text)]">Sub-item mode:</b> each step is its own chip. Drag its <GripVertical className="inline w-3 h-3 align-middle text-[var(--color-text-muted)]" /> handle to another day to move just that step — the rest stay put and the parent stretches to follow.</span>
        ) : (
          <span><b className="text-[var(--color-text)]">Day view:</b> click a day&apos;s number for everything due that day with progress entry. <b className="text-[var(--color-text)]">To move one sub-item:</b> click a task&apos;s <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-[var(--color-accent)] text-[var(--color-accent-fg)] align-middle"><ChevronRight className="w-3 h-3" /></span> to pop open its steps, then use each step&apos;s ◀ ▶ buttons. Or flip <b>Show → Sub-items</b> to spread every step across the grid as draggable chips.</span>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-[var(--color-text-faint)]">
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-400 border border-black/10" /> dot = status</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><GripVertical className="w-3 h-3" /> handle = drag</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><CheckSquare className="w-3 h-3" /> select for bulk</span>
        </span>
      </div>

      {/* Marks legend */}
      <div className="px-3 py-1.5 border-b border-[var(--color-border)] bg-slate-50/40 flex items-center gap-3 flex-wrap text-[10px] text-[var(--color-text-muted)]">
        <span className="inline-flex items-center gap-1"><span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-[var(--color-accent)] text-[var(--color-accent-fg)]"><ChevronRight className="w-3 h-3" /></span> expand a task to its steps</span>
        <span className="inline-flex items-center gap-1"><GripVertical className="w-3 h-3" /> drag handle (move to another day)</span>
        <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-400 border border-black/10" /> status dot (click to change)</span>
        <span className="inline-flex items-center gap-1"><span className="text-[8.5px] font-bold px-1 rounded bg-black/10">2/3</span> day 2 of a 3-day task</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-6 h-2.5 rounded-sm bg-[var(--color-accent-soft)] border border-[var(--color-accent-ring)]/40" /> group covering the day (muted = nothing under it today)</span>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-[var(--color-border)] bg-slate-50/60">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] text-center">{d}</div>
        ))}
      </div>

      {/* Weeks */}
      <div className="flex-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b border-[var(--color-border)] last:border-b-0" style={{ minHeight: 116 }}>
            {week.map((day) => {
              const key = ymd(day, tz);
              const items = byDay.get(key) ?? [];
              const bands = bandsByDay.get(key) ?? [];
              const inMonth = wallClock(day.getTime(), tz).month === monthIdx;
              const isToday = sameDayUTC(day, today, tz);
              const shown = items.slice(0, 4);
              const extra = items.length - shown.length;
              const MAX_BANDS = 3;
              const shownBands = bands.slice(0, MAX_BANDS);
              const extraBands = bands.length - shownBands.length;
              return (
                <div
                  key={key}
                  data-daykey={key}
                  onDragOver={(e) => { if (canEdit) { e.preventDefault(); } }}
                  onDrop={(e) => void onDropDay(key, e)}
                  className={`group/tile border-r border-[var(--color-border)] last:border-r-0 p-1 flex flex-col gap-1 ${inMonth ? "bg-[var(--color-surface)]" : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-rose-300" : ""}`}
                >
                  <div className="flex items-center justify-between px-0.5">
                    <button
                      type="button"
                      onClick={() => setAgendaDay(key)}
                      title={`Open ${fmtInTz(day, tz, { weekday: "long", month: "long", day: "numeric" })} — every step due that day, with progress entry`}
                      className={`inline-flex items-center gap-1 text-[11px] font-bold rounded px-1 -ml-1 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] transition-colors ${isToday ? "text-rose-600" : inMonth ? "text-[var(--color-text)]" : "text-slate-300"}`}
                    >
                      {wallClock(day.getTime(), tz).day}
                      {(items.length > 0 || bands.length > 0) && <span className="text-[8px] font-black uppercase tracking-wider opacity-0 group-hover/tile:opacity-70">Day view</span>}
                    </button>
                  </div>
                  {isToday && overdueToday.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAgendaDay(key)}
                      title={overdueToday.slice(0, 6).map((w) => `• ${w.leaf.name}`).join("\n") + (overdueToday.length > 6 ? `\n…and ${overdueToday.length - 6} more` : "") + "\nOpen the day view to work them"}
                      className="w-full text-left rounded px-1.5 py-1 bg-rose-600 text-white text-[10px] font-black uppercase tracking-wide hover:bg-rose-700"
                    >
                      ⚠ {overdueToday.length} carried over — not done
                    </button>
                  )}
                  {/* Groups covering this day — root first. Solid = work
                      under it is scheduled today; muted = it only carries over. */}
                  {shownBands.map((b) => {
                    const unit = topGroupOf(b.ms);
                    const color = GROUP_COLORS[(unit.id ? groupColorIndex.get(unit.id) : undefined) ?? 0];
                    return <Band key={`band-${b.ms.id}-${b.dayIndex}`} band={b} color={color} onClick={() => onOpenDetail(b.ms)} />;
                  })}
                  {extraBands > 0 && (
                    <button onClick={() => setOverflowDay(key)} className="text-[9px] font-bold text-[var(--color-text-faint)] hover:text-[var(--color-accent)] px-1 text-left transition-colors">+{extraBands} more group{extraBands === 1 ? "" : "s"}</button>
                  )}
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
                        todayStart={p.todayStart} todayEnd={p.todayEnd} idleToday={p.idleToday}
                        childrenByParent={childrenByParent}
                        ancestors={chain} color={color}
                        canEdit={canEdit}
                        draggable={canEdit && !!p.ms.id && p.ms.status !== "completed"}
                        onDragStart={(e) => { setDragId(p.ms.id ?? null); e.dataTransfer.setData("text/plain", `${p.ms.id}|${key}`); }}
                        onTouchDragStart={p.ms.id ? (e) => startTouchDrag(p.ms.id!, key, p.ms.name, e) : undefined}
                        onClick={() => { if (selected.size > 0 && p.ms.id) toggleSelected(p.ms.id); else onOpenDetail(p.ms); }}
                        onSetStatus={onSetStatus}
                        onSetProgress={onSetProgress}
                        progress={progress}
                        canExpand={canExpand}
                        isExpanded={subPopover?.ms.id === p.ms.id}
                        onToggleExpand={canExpand && p.ms.id ? (e) => {
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setPopoverShowOthers(false);
                          setSubPopover((cur) => cur && cur.ms.id === p.ms.id && cur.dayKey === key ? null : { ms: p.ms, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 320), dayKey: key });
                        } : undefined}
                        selectable={canEdit && p.dayIndex === 0}
                        selected={!!p.ms.id && selected.has(p.ms.id)}
                        onToggleSelect={() => p.ms.id && toggleSelected(p.ms.id)}
                        dimmed={!!dragId && dragId === p.ms.id}
                      />
                    );
                  })}
                  {extra > 0 && (
                    <button onClick={() => setOverflowDay(key)} className="text-[10px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-1 text-left transition-colors">+{extra} more</button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Overflow day popover */}
      {overflowDay && (
        <div className="fixed inset-0 z-[160] flex items-start sm:items-center justify-center overflow-y-auto p-4" onClick={() => setOverflowDay(null)}>
          <div className="absolute inset-0 bg-slate-900/30" />
          <div className="relative w-full max-w-sm bg-[var(--color-surface)] rounded-2xl shadow-2xl ring-1 ring-slate-900/10 overflow-hidden animate-in fade-in zoom-in-95 duration-150" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-[var(--color-accent)]" />
              <div className="font-bold text-[var(--color-text)] text-sm">{fmtInTz(ymdToDate(overflowDay, tz), tz, { weekday: "long", month: "long", day: "numeric" })}</div>
              <span className="ml-auto text-[11px] text-[var(--color-text-faint)]">{(byDay.get(overflowDay) ?? []).length} tasks · {(bandsByDay.get(overflowDay) ?? []).length} groups</span>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
              {/* Groups covering the day, root first, then the work in the
                  same time-of-day order as the tile. */}
              {(bandsByDay.get(overflowDay) ?? []).map((b) => {
                const unit = topGroupOf(b.ms);
                const color = GROUP_COLORS[(unit.id ? groupColorIndex.get(unit.id) : undefined) ?? 0];
                return <Band key={`band-${b.ms.id}-${b.dayIndex}`} band={b} color={color} full onClick={() => { setOverflowDay(null); onOpenDetail(b.ms); }} />;
              })}
              {(byDay.get(overflowDay) ?? []).map((p) => {
                const unit = topGroupOf(p.ms);
                const color = GROUP_COLORS[(unit.id ? groupColorIndex.get(unit.id) : undefined) ?? 0];
                return (
                  <Chip
                    key={`${p.ms.id}-${p.dayIndex}`}
                    ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
                    todayStart={p.todayStart} todayEnd={p.todayEnd} idleToday={p.idleToday}
                    childrenByParent={childrenByParent}
                    ancestors={ancestorsOf(p.ms)} color={color}
                    canEdit={canEdit}
                    draggable={false}
                    onClick={() => { setOverflowDay(null); onOpenDetail(p.ms); }}
                    onSetStatus={onSetStatus}
                    onSetProgress={onSetProgress}
                    progress={progress}
                    full
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Sub-items popover — opens at the chip's chevron on a specific day
          tile. Shows the steps scheduled on THAT day (status dot, time,
          progress entry) and keeps the other days' steps behind a toggle,
          so the tile answers "what is expected today" without the rest
          of the task's history crowding in. Nothing leaves the grid. */}
      {subPopover && (() => {
        const dayKey = subPopover.dayKey;
        const all = leafDescendants(subPopover.ms).slice().sort((a, b) => startMs(a) - startMs(b));
        const coversDay = (l: Milestone) => {
          const s0 = startMs(l), f0 = finishMs(l);
          if (!Number.isFinite(s0) || !Number.isFinite(f0)) return false;
          return ymd(new Date(s0), tz) <= dayKey && dayKey <= ymd(new Date(f0), tz);
        };
        const onDay = all.filter(coversDay);
        const others = all.filter((l) => !coversDay(l));
        const dayLabel = fmtInTz(ymdToDate(dayKey, tz), tz, { weekday: "short", month: "short", day: "numeric" });
        const timeOf = (l: Milestone) => {
          const s0 = startMs(l), f0 = finishMs(l);
          const sameDayStart = ymd(new Date(s0), tz) === dayKey, sameDayEnd = ymd(new Date(f0), tz) === dayKey;
          const a = sameDayStart ? (clockLabel(s0, tz) || "0:00") : "…";
          const b = sameDayEnd ? (clockLabel(f0, tz) || "24:00") : "…";
          return a === "…" && b === "…" ? "all day" : `${a}–${b}`;
        };
        const pctOf = (l: Milestone) => (l.id ? progress?.get(l.id)?.percent : undefined) ?? (l.percentComplete != null ? Math.round(l.percentComplete) : (l.status === "completed" ? 100 : 0));
        const Row = ({ leaf, muted }: { leaf: Milestone; muted?: boolean }) => (
          <li className={`px-3 py-2 flex items-center gap-2 ${muted ? "opacity-60" : ""}`}>
            <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <StatusControl
                status={leaf.status} size="sm" variant="dot" disabled={!canEdit || !onSetStatus || !leaf.id}
                onPick={(st, reason) => { if (leaf.id && onSetStatus) void onSetStatus(leaf.id, st, reason); }}
                percent={pctOf(leaf)}
                onSetProgress={onSetProgress ? (v) => { if (leaf.id) onSetProgress(leaf.id, v); } : undefined}
              />
            </span>
            <button onClick={() => { onOpenDetail(leaf); setSubPopover(null); }} className="flex-1 min-w-0 text-left">
              <span className={`block text-[12px] truncate ${leaf.status === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{leaf.name}</span>
              <span className="block text-[9px] text-[var(--color-text-faint)] font-mono">
                {muted ? fmtInTz(startMs(leaf), tz, { month: "short", day: "numeric" }) : timeOf(leaf)}
              </span>
            </button>
            <span className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <ProgressControl
                percent={pctOf(leaf)}
                onPick={(v) => { if (leaf.id && onSetProgress) onSetProgress(leaf.id, v); }}
                disabled={!canEdit || !onSetProgress || !leaf.id}
                size="sm"
              />
              {canEdit && onMoveDays && leaf.id && (
                <>
                  <button onClick={() => onMoveDays(leaf.id!, -1)} title="1 day earlier" className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors"><ChevronLeft className="w-3.5 h-3.5" /></button>
                  <button onClick={() => onMoveDays(leaf.id!, 1)} title="1 day later" className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors"><ChevronRight className="w-3.5 h-3.5" /></button>
                </>
              )}
            </span>
          </li>
        );
        return (
          <div className="fixed inset-0 z-[160]" onClick={() => setSubPopover(null)}>
            <div
              className="absolute w-[340px] max-w-[92vw] max-h-[60dvh] overflow-y-auto bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg animate-in fade-in zoom-in-95 duration-150"
              style={{ top: subPopover.top, left: subPopover.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-2 border-b border-[var(--color-border)] bg-slate-50/60">
                <div className="flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                  <span className="text-[12px] font-bold text-[var(--color-text)] truncate flex-1">{subPopover.ms.name}</span>
                  <button onClick={() => { onOpenDetail(subPopover.ms); setSubPopover(null); }} className="text-[10px] font-bold text-[var(--color-accent)] hover:underline shrink-0">Open</button>
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                  <b className="text-[var(--color-text)]">{dayLabel}</b> · {onDay.length} of {all.length} step{all.length === 1 ? "" : "s"} scheduled this day
                </div>
              </div>
              {onDay.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-[var(--color-text-faint)]">Nothing under this task is scheduled on {dayLabel}.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {onDay.map((leaf) => <Row key={leaf.id} leaf={leaf} />)}
                </ul>
              )}
              {others.length > 0 && (
                <div className="border-t border-[var(--color-border)]">
                  <button
                    onClick={() => setPopoverShowOthers((v) => !v)}
                    className="w-full px-3 py-1.5 text-left text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] inline-flex items-center gap-1"
                  >
                    <ChevronRight className={`w-3 h-3 transition-transform ${popoverShowOthers ? "rotate-90" : ""}`} />
                    {others.length} step{others.length === 1 ? "" : "s"} on other days
                  </button>
                  {popoverShowOthers && (
                    <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
                      {others.map((leaf) => <Row key={leaf.id} leaf={leaf} muted />)}
                    </ul>
                  )}
                </div>
              )}
              <div className="px-3 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
                Dot = status · % = progress · ◀ ▶ = move this step a day (others stay put; the parent span follows).
              </div>
            </div>
          </div>
        );
      })()}

      {/* Day agenda — the work list for one day. */}
      {agendaDay && (
        <DayAgendaPanel
          day={agendaDay}
          tz={tz}
          milestones={milestones}
          childrenByParent={childrenByParent}
          ancestorsOf={ancestorsOf}
          progress={progress}
          canEdit={canEdit}
          onSetStatus={onSetStatus}
          onSetProgress={onSetProgress}
          onOpenDetail={(m) => { onOpenDetail(m); }}
          onChangeDay={setAgendaDay}
          onClose={() => setAgendaDay(null)}
          colorOf={(top) => GROUP_COLORS[(top.id ? groupColorIndex.get(top.id) : undefined) ?? 0]}
        />
      )}

      {/* Floating ghost that follows the finger during a touch drag. */}
      {touchDrag && (
        <div
          className="fixed z-[300] pointer-events-none px-2 py-1 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[11px] font-bold shadow-2xl -translate-x-1/2 -translate-y-1/2 max-w-[180px] truncate"
          style={{ left: touchDrag.x, top: touchDrag.y }}
        >
          {touchDrag.label}
        </div>
      )}
    </div>
  );
}

// A group (the root, a phase, a unit) covering this day: one thin strip,
// never a full chip, so the hierarchy is always visible without the
// root repeating down the month. Solid when work under it is scheduled
// today, muted when it only carries over.
function Band({ band, color, onClick, full }: {
  band: BandPlacement<Milestone>;
  color: { bar: string; soft: string; text: string; dot: string };
  onClick: () => void;
  full?: boolean;
}) {
  const { ms, dayIndex, spanDays, hasWorkToday, depth } = band;
  const tip = `${ms.name}\nGroup · day ${dayIndex + 1} of ${spanDays}${hasWorkToday ? "" : "\nCarries over — nothing scheduled under it today"}\n— Click to open`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      className={`w-full flex items-center gap-1 rounded px-1 ${full ? "py-1" : "h-[15px]"} text-[8.5px] font-bold uppercase tracking-wide text-left border transition-colors ${hasWorkToday
        ? `${color.soft} ${color.text} border-transparent hover:brightness-95`
        : "border-dashed border-[var(--color-border)] text-[var(--color-text-faint)] bg-transparent hover:bg-[var(--color-surface-2)]"}`}
      style={{ paddingLeft: 4 + Math.min(depth, 3) * 6 }}
    >
      <span className={`w-1.5 h-1.5 rounded-sm shrink-0 ${hasWorkToday ? color.dot : "bg-[var(--color-border-strong)]"}`} />
      <span className={`truncate ${full ? "" : "min-w-0"}`}>{ms.name}</span>
      <span className="ml-auto shrink-0 font-mono normal-case tracking-normal opacity-70">{dayIndex + 1}/{spanDays}</span>
    </button>
  );
}

function Chip({
  ms, dayIndex, spanDays, todayStart, todayEnd, idleToday, childrenByParent, ancestors, color, canEdit, draggable, onDragStart, onTouchDragStart, onClick,
  onSetStatus, onSetProgress, progress, canExpand, isExpanded, onToggleExpand, selectable, selected, onToggleSelect, dimmed, full,
}: {
  ms: Milestone; dayIndex: number; spanDays: number;
  /** This day's active window (see DayPlacement). */
  todayStart?: number; todayEnd?: number; idleToday?: boolean;
  childrenByParent: Map<string, Milestone[]>;
  ancestors?: Milestone[];
  color?: { bar: string; soft: string; text: string; dot: string };
  canEdit?: boolean;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onTouchDragStart?: (e: React.PointerEvent) => void;
  onClick: () => void;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => void;
  onSetProgress?: (id: string, percent: number) => void;
  progress?: Map<string, ProgressInfo>;
  canExpand?: boolean; isExpanded?: boolean; onToggleExpand?: (e: React.MouseEvent) => void;
  selectable?: boolean; selected?: boolean; onToggleSelect?: () => void;
  dimmed?: boolean; full?: boolean;
}) {
  const tz = useScheduleTz();
  const kids = ms.id ? (childrenByParent.get(ms.id) ?? []) : [];
  const leafKids = kids.filter((k) => !k.id || (childrenByParent.get(k.id) ?? []).length === 0);
  const hasSubs = leafKids.length > 0;
  // Effective progress + status: a leaf's own, or a summary's weighted roll-up
  // (computed by the parent). Fall back to a shallow count if not supplied.
  const info = ms.id ? progress?.get(ms.id) : undefined;
  const isLeaf = info ? info.isLeaf : !hasSubs;
  const done = info?.leafDone ?? leafKids.filter((k) => k.status === "completed").length;
  const leafTotal = info?.leafTotal ?? leafKids.length;
  const pct = info?.percent ?? (hasSubs ? Math.round((done / Math.max(1, leafKids.length)) * 100) : (ms.status === "completed" ? 100 : 0));
  const effStatus = !isLeaf && info ? info.status : ms.status;
  const tone = chipTone(effStatus);
  const time = timeLabel(ms, tz);
  // Short clock shown on the chip itself so the tile's time order is
  // visible at a glance: THIS DAY's work window — "6:00" when work under
  // the chip starts today, "→14:00" when it only wraps up today,
  // "all day" when it runs straight through, "no work today" on a gap
  // day inside a multi-day span.
  const clock = (() => {
    if (idleToday) return "no work today";
    if (todayStart == null || todayEnd == null) return dayIndex > 0 ? "cont." : startClock(ms, tz);
    const dayStartMs = startOfDayTz(todayStart, tz);
    const dayEndMs = addDaysTz(dayStartMs, 1, tz);
    const startsToday = todayStart > dayStartMs;
    const endsToday = todayEnd < dayEndMs;
    const s = clockLabel(todayStart, tz) || "0:00";
    const e = clockLabel(todayEnd, tz) || "24:00";
    if (startsToday && endsToday) return `${s}–${e}`;
    if (startsToday) return `${s}→`;
    if (endsToday) return `→${e}`;
    return "all day";
  })();

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
      className={`group/chip relative w-full text-left rounded-md border pl-2 pr-1 py-1 overflow-hidden cursor-pointer transition-colors ${tone} ${dimmed ? "opacity-40" : ""} ${selected ? "ring-2 ring-[var(--color-accent-ring)] ring-offset-1" : ""}`}
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
          className={`absolute top-0.5 right-0.5 z-10 w-4 h-4 rounded border flex items-center justify-center transition-opacity ${selected ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent-fg)] opacity-100" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-transparent opacity-0 group-hover/chip:opacity-100"}`}
        >
          <CheckSquare className="w-3 h-3" />
        </button>
      )}

      {/* Parent / unit label so you always know what this belongs to. */}
      {parentLabel && (
        <div className={`flex items-center gap-1 ${color?.text ?? "text-[var(--color-text-muted)]"} ${full ? "" : "truncate"}`}>
          <Layers className="w-2.5 h-2.5 shrink-0 opacity-80" />
          <span className="text-[8.5px] font-bold uppercase tracking-wide truncate">{parentLabel}</span>
        </div>
      )}

      <div className="flex items-center gap-1">
        {/* Status dot — same picker as everywhere; click for the full
            list (doing / done / on-hold / blocked), not just done. */}
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          {isLeaf ? (
            <StatusControl
              status={ms.status}
              size="sm"
              variant="dot"
              disabled={!canEdit || !onSetStatus || !ms.id}
              onPick={(st, reason) => { if (ms.id && onSetStatus) onSetStatus(ms.id, st, reason); }}
              percent={pct}
              onSetProgress={onSetProgress ? (p) => { if (ms.id) onSetProgress(ms.id, p); } : undefined}
            />
          ) : (
            <StatusControl status={effStatus} size="sm" variant="dot" readOnly title="Phase status — rolls up from sub-tasks" onPick={() => {}} />
          )}
        </span>
        {canExpand && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand?.(e); }}
            title={isExpanded ? "Hide sub-items" : "Show this task's sub-items"}
            className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border transition-colors ${isExpanded ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)] hover:text-[var(--color-accent)]"}`}
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} strokeWidth={2.5} />
          </button>
        )}
        {hasSubs && !canExpand && <Layers className="w-2.5 h-2.5 shrink-0 opacity-70" />}
        {ms.shift === "night" ? <Moon className="w-2.5 h-2.5 shrink-0 opacity-70" /> : ms.shift === "swing" ? <Sunset className="w-2.5 h-2.5 shrink-0 opacity-70" /> : null}
        {clock && <span className="shrink-0 text-[9px] font-mono opacity-70 tabular-nums">{clock}</span>}
        <span className={`text-[10.5px] font-semibold leading-tight ${full ? "" : "truncate"} ${effStatus === "completed" ? "line-through opacity-70" : ""}`}>{ms.name}</span>
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
            onPointerDown={onTouchDragStart}
            onClick={(e) => e.stopPropagation()}
            title="Drag this handle to move to another day"
            style={{ touchAction: "none" }}
            className={`${spanDays > 1 ? "" : "ml-auto"} shrink-0 inline-flex items-center justify-center w-4 h-5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-black/10 cursor-grab active:cursor-grabbing`}
          >
            <GripVertical className="w-3 h-3" />
          </span>
        )}
      </div>
      {!isLeaf ? (
        // Summary chip: rolled-up progress (read-only).
        <div className="mt-1 pl-2.5 flex items-center gap-1" title={`${pct}% complete · ${done}/${leafTotal} sub-tasks done`}>
          <span className="h-1 flex-1 rounded-full bg-black/10 overflow-hidden">
            <span className={`block h-full ${pct === 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[8.5px] font-mono opacity-70">{pct}%</span>
        </div>
      ) : (
        // Leaf chip: a thin fill + an editable % control.
        <div className="mt-1 pl-2.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <span className="h-1 flex-1 rounded-full bg-black/10 overflow-hidden">
            <span className={`block h-full ${pct === 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
          </span>
          <ProgressControl
            percent={pct}
            onPick={(p) => { if (ms.id && onSetProgress) onSetProgress(ms.id, p); }}
            disabled={!canEdit || !onSetProgress || !ms.id}
            size="sm"
          />
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

function chipTone(s: MilestoneStatus): string {
  switch (s) {
    case "completed":   return "bg-emerald-50 border-emerald-200 text-emerald-900";
    case "in_progress": return "bg-blue-50 border-blue-200 text-blue-900";
    case "on_hold":     return "bg-amber-50 border-amber-200 text-amber-900";
    case "blocked":     return "bg-rose-50 border-rose-200 text-rose-900";
    case "missed":      return "bg-rose-100 border-rose-300 text-rose-900";
    default:            return "bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)]";
  }
}

// ── Date helpers in the PLANT's zone (tz), shared with the timeline view ──
function startOfDayUTC(d: Date, tz: string): Date { return new Date(startOfDayTz(d.getTime(), tz)); }
function firstOfMonthUTC(d: Date, tz: string): Date { return new Date(startOfMonthTz(d.getTime(), tz)); }
function addMonthsUTC(d: Date, n: number, tz: string): Date { return new Date(addMonthsTz(d.getTime(), n, tz)); }
function addDaysUTC(d: Date, n: number, tz: string): Date { return new Date(addDaysTz(d.getTime(), n, tz)); }
function dayDiff(a: Date, b: Date, tz: string): number { return dayDiffTz(a.getTime(), b.getTime(), tz); }
function sameDayUTC(a: Date, b: Date, tz: string): boolean { return ymd(a, tz) === ymd(b, tz); }
function ymd(d: Date, tz: string): string { return dayKey(d.getTime(), tz); }
function ymdToDate(s: string, tz: string): Date { return new Date(dayKeyToMs(s, tz)); }
function startMs(m: Milestone): number { return startMsOf(m); }
function finishMs(m: Milestone): number { return finishMsOf(m); }

function statusLabel(s: MilestoneStatus): string {
  return s === "in_progress" ? "In progress" : s === "on_hold" ? "On hold" : s.charAt(0).toUpperCase() + s.slice(1);
}

// "6:00" (plant time) when the task carries a start time-of-day, else ""
// (a start at exactly midnight is treated as date-only, matching timeLabel).
function startClock(m: Milestone, tz: string): string {
  return clockLabel(startMs(m), tz);
}

// A "6:00–14:00" style label (plant time) when the task carries
// times-of-day, else "".
function timeLabel(m: Milestone, tz: string): string {
  const s = m.plannedStartAt ? startMs(m) : NaN;
  const f = finishMs(m);
  const hasS = Number.isFinite(s) && hasTimeOfDay(s, tz);
  const hasF = Number.isFinite(f) && hasTimeOfDay(f, tz);
  if (hasS && hasF) return `${clockLabel(s, tz)}–${clockLabel(f, tz)}`;
  if (hasF) return `ends ${clockLabel(f, tz)}`;
  if (hasS) return `starts ${clockLabel(s, tz)}`;
  return "";
}
