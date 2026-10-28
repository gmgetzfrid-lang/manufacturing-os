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

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Crosshair, Info, GripVertical, CheckSquare, X as XIcon, ListChecks, Moon, Sun } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import StatusControl from "@/components/projects/StatusControl";
import { assignGroupColors } from "@/lib/scheduleColors";
import type { ProgressInfo } from "@/lib/scheduleProgress";
import { splitPlacements, compareDayPlacements, wbsCompare, crewOf, startMsOf, finishMsOf, type DayPlacement, type DayCrew } from "@/lib/calendarPlacement";
import { addDays as addDaysTz, addMonths as addMonthsTz, clockLabel, dayDiff as dayDiffTz, dayKey, dayKeyToMs, dayOfWeek, fmtInTz, hasTimeOfDay, tzAbbrev, startOfDay as startOfDayTz, startOfMonth as startOfMonthTz, wallClock } from "@/lib/scheduleTz";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { DEFAULT_SHIFT_TIMES, crewWindows, workShiftOf, workSpan, shiftWindow, shiftAt, type ShiftTimes, type ShiftCredit } from "@/lib/shiftReport";
import { bandIndex, stepBandDays, type Band } from "@/lib/shiftBands";
import ShiftMark from "@/components/projects/ShiftMark";
import DayAgendaPanel from "@/components/projects/DayAgendaPanel";
import CalendarQuickView, { type StepUpdate } from "@/components/projects/CalendarQuickView";
import { OPEN_SETUP_EVENT } from "@/lib/scheduleSetup";
import { overdueOpenWork } from "@/lib/openWork";

// Use the shared palette so a group is the SAME hue here and on the
// timeline. `.rail` is the solid accent (was `.bar` locally).

interface Props {
  milestones: Milestone[];
  childrenByParent: Map<string, Milestone[]>;
  canEdit: boolean;
  /** Reschedule a node (and, via the reflow engine, its subtree +
   *  ancestors) by a day delta. */
  onMoveDays?: (id: string, deltaDays: number) => void;
  /** One-click status change straight from a chip. */
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number, forShift?: ShiftCredit) => unknown;
  /** Planned % by now per task, over the whole schedule (for the day list). */
  planNow?: Map<string, number>;
  /** Who is signed in (edits their own comments in the day list). */
  userId?: string;
  /** Set a leaf's physical % complete (derives status). */
  onSetProgress?: (id: string, percent: number) => unknown;
  /** Per-task effective progress + derived status (leaves: own; summaries:
   *  rolled up), computed once by the parent so chips match the timeline. */
  progress?: Map<string, ProgressInfo>;
  /** Bulk status across a selection (routes through undo in the parent). */
  onBulkStatus?: (ids: string[], status: MilestoneStatus) => void;
  /** Bulk move across a selection (routes through the confirmation). */
  onBulkMove?: (ids: string[], deltaDays: number) => void;
  onOpenDetail: (m: Milestone) => void;
  /** The task detail panel is open. The day list steps aside while it is
   *  and comes back when it closes, so you keep your place. */
  detailOpen?: boolean;
  /** Add a note to a step's log (what got done, what's turned over). */
  onAddNote?: (id: string, body: string) => Promise<void> | void;
  /** Set a step's % with what got done (required for work in progress). */
  onSetProgressNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
  /** Start a step ("in progress") with what got done. */
  onStartNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
  /** The project's shift-change times — which crew does each step. */
  shiftTimes?: ShiftTimes;
  /** Update a step from the quick view: status, %, the time it happened,
   *  the comment, why it's behind. */
  onUpdateStep?: (id: string, u: StepUpdate) => Promise<boolean>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A card in one shift of one day: the day shift, or that evening's night
 *  shift running into the next morning. */
type Placed = DayPlacement<Milestone> & { band: Band; bandStart: number; bandEnd: number };

export default function ScheduleCalendarTileView({ planNow, userId, milestones, childrenByParent, canEdit, onMoveDays, onSetStatus, onSetProgress, progress, onBulkStatus, onBulkMove, onOpenDetail, detailOpen, onAddNote, onSetProgressNote, onStartNote, shiftTimes = DEFAULT_SHIFT_TIMES, onUpdateStep }: Props) {
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
  const [subPopover, setSubPopover] = useState<{ ms: Milestone; top: number; left: number; dayKey: string; band?: Band; anchorTop?: number } | null>(null);
  // Near the bottom of the screen the steps popover opens upward, and never
  // runs past the window edge (measured after it renders).
  const subRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!subPopover || !el) return;
    const h = el.offsetHeight, vh = window.innerHeight;
    let top = subPopover.top;
    if (top + h > vh - 8) top = subPopover.anchorTop != null && subPopover.anchorTop - h - 4 >= 8 ? subPopover.anchorTop - h - 4 : Math.max(8, vh - h - 8);
    el.style.top = `${top}px`;
  });

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

  // The timeline's colours, by the timeline's rule (under a single root,
  // each phase gets its own hue) — a phase is the same colour in both views.
  const palette = useMemo(() => assignGroupColors(milestones), [milestones]);
  const colorFor = useCallback((m: Milestone) => {
    const c = palette.colorOf(m);
    return { bar: c.rail, soft: c.soft, text: c.text, dot: c.dot };
  }, [palette]);

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

  // Chips = the work (leaves, plus bottom-level groups in Tasks mode); the
  // groups above them name each card's place instead. In Sub-tasks mode every leaf is a chip
  // exactly once so a single sub-item can be dragged on its own day
  // while its siblings stay put. See lib/calendarPlacement.ts.
  const split = useMemo(
    () => splitPlacements(milestones, childrenByParent, showSubtasks),
    [milestones, childrenByParent, showSubtasks],
  );
  const mains = split.chips;

  // Distinct top-level groups that actually have rendered tasks beneath
  // them, in calendar order — used for the group color legend.
  // The legend lists the colour groups (the phases under a single root).
  const units = useMemo(() => {
    const anchor = new Map<string, Milestone>();
    for (const g of palette.groups) if (g.id) anchor.set(g.id, g);
    const seen = new Map<string, Milestone>();
    for (const m of mains) {
      let cur: Milestone | undefined = m;
      const guard = new Set<string>();
      while (cur && cur.id && !anchor.has(cur.id) && !guard.has(cur.id)) { guard.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
      const u = cur && cur.id && anchor.has(cur.id) ? cur : topGroupOf(m);
      const key = u.id ?? u.name;
      if (!seen.has(key)) seen.set(key, u);
    }
    return Array.from(seen.values()).sort((a, b) => startMs(a) - startMs(b) || finishMs(a) - finishMs(b) || wbsCompare(a.wbs, b.wbs));
  }, [mains, topGroupOf, palette, byId]);

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
  // Month, one week (tall days), or one day (its full step list).
  type Mode = "month" | "week" | "day";
  // The week is where the work is read and updated; the month is an overview.
  const [mode, setModeState] = useState<Mode>("week");
  const [focusDay, setFocusDay] = useState<Date>(() => startOfDayUTC(new Date(), tz));
  React.useEffect(() => {
    try {
      const v = localStorage.getItem("calendar:mode");
      if (v === "week" || v === "day") setModeState(v);
    } catch { /* private mode */ }
  }, []);
  const setMode = (m: Mode) => {
    if (m === mode) return;
    if (mode === "month") {
      const now = new Date();
      setFocusDay(startOfDayUTC(sameMonth(now, cursor, tz) ? now : cursor, tz));
    } else if (m === "month") setCursor(firstOfMonthUTC(focusDay, tz));
    setModeState(m);
    try { localStorage.setItem("calendar:mode", m); } catch { /* private mode */ }
  };
  const step = (dir: 1 | -1) => {
    if (mode === "month") setCursor(addMonthsUTC(cursor, dir, tz));
    else setFocusDay(addDaysUTC(focusDay, mode === "week" ? 7 * dir : dir, tz));
  };
  const goToday = () => { const now = new Date(); setCursor(firstOfMonthUTC(now, tz)); setFocusDay(startOfDayUTC(now, tz)); };
  // Snap to the schedule's first month if today isn't within the span.
  const didSnap = React.useRef(false);
  React.useEffect(() => {
    if (didSnap.current || !span) return;
    const now = new Date();
    const inSpan = now >= span.earliest && now <= span.latest;
    setCursor(firstOfMonthUTC(inSpan ? now : span.earliest, tz));
    setFocusDay(startOfDayUTC(inSpan ? now : span.earliest, tz));
    didSnap.current = true;
  }, [span, tz]);

  // Day work, night work, or both — the crew switch in the toolbar.
  const [crewFilter, setCrewFilterState] = useState<"all" | "day" | "night">("all");
  React.useEffect(() => {
    try {
      const v = localStorage.getItem("calendar:crew");
      if (v === "day" || v === "night") setCrewFilterState(v);
    } catch { /* private mode */ }
  }, []);
  const setCrewFilter = (v: "all" | "day" | "night") => {
    setCrewFilterState(v);
    try { localStorage.setItem("calendar:crew", v); } catch { /* private mode */ }
  };

  // Each step's shifts by date: the day shift, or that evening's night
  // shift running into the next morning (lib/shiftBands).
  const leafBands = useMemo(() => bandIndex(milestones.filter((m) => isLeaf(m)), tz, shiftTimes), [milestones, isLeaf, tz, shiftTimes]);
  const bandsOf = useCallback((m: Milestone) => (m.id ? leafBands.get(m.id) : undefined) ?? stepBandDays(m, tz, shiftTimes), [leafBands, tz, shiftTimes]);

  // Every task onto the shifts it's worked: each date's day shift and its
  // night shift (into the next morning). A work order sits in each shift
  // its steps are worked; a gap day inside its span, quietly under Day.
  const byDay = useMemo(() => {
    const m = new Map<string, { day: Placed[]; night: Placed[] }>();
    const slot = (k: string) => { let v = m.get(k); if (!v) { v = { day: [], night: [] }; m.set(k, v); } return v; };
    for (const ms of mains) {
      const steps = ms.id ? leafDescendants(ms) : [];
      const units = steps.length ? steps : [ms];
      const s0 = startMs(ms), f0 = finishMs(ms);
      if (!Number.isFinite(s0) || !Number.isFinite(f0)) continue;
      const start = startOfDayUTC(new Date(s0), tz);
      const total = Math.max(1, dayDiff(start, startOfDayUTC(new Date(f0), tz), tz) + 1);
      const span = new Set(Array.from({ length: total }, (_, i) => ymd(addDaysUTC(start, i, tz), tz)));
      const keys = new Set(span);
      for (const st of units) { const b = bandsOf(st); b.day.forEach((k) => keys.add(k)); b.night.forEach((k) => keys.add(k)); }
      for (const key of keys) {
        const dayIndex = Math.max(0, dayDiff(start, ymdToDate(key, tz), tz));
        const put = (band: Band, idle = false) => {
          const w = shiftWindow(key, band, tz, shiftTimes);
          const win = idle ? { start: w.start, end: w.end } : windowIn(units.filter((st) => bandsOf(st)[band].has(key)), w.start, w.end, tz, shiftTimes);
          slot(key)[band].push({ ms, dayIndex, spanDays: total, todayStart: win.start, todayEnd: win.end, idleToday: idle, crew: band, band, bandStart: w.start, bandEnd: w.end });
        };
        const d = units.some((st) => bandsOf(st).day.has(key)), n = units.some((st) => bandsOf(st).night.has(key));
        if (d && crewFilter !== "night") put("day");
        if (n && crewFilter !== "day") put("night");
        if (!d && !n && span.has(key) && crewFilter !== "night") put("day", true);
      }
    }
    for (const v of m.values()) { v.day.sort(compareDayPlacements); v.night.sort(compareDayPlacements); }
    return m;
  }, [mains, tz, leafDescendants, shiftTimes, crewFilter, bandsOf]);
  const isDonePl = (p: Placed) => (p.ms.id ? progress?.get(p.ms.id)?.percent : undefined) === 100 || p.ms.status === "completed";
  const doneLast = (arr: Placed[]) => [...arr.filter((p) => !isDonePl(p)), ...arr.filter(isDonePl)];
  // A day's cards once each (a work order worked day and night counts once).
  const uniqueOf = (key: string) => {
    const b = byDay.get(key);
    if (!b) return [] as Placed[];
    const seen = new Set<string>();
    return [...b.day, ...b.night].filter((p) => { const k = p.ms.id ?? p.ms.name; if (seen.has(k)) return false; seen.add(k); return true; });
  };
  // The shift on now, and the one just ended — the one being written up.
  const [clock, setClock] = useState(() => Date.now());
  React.useEffect(() => { const t = setInterval(() => setClock(Date.now()), 5 * 60_000); return () => clearInterval(t); }, []);
  const shiftTags = useMemo(() => {
    const now = shiftAt(clock, tz, shiftTimes);
    const last = now.kind === "night" ? { kind: "day", dayKey: now.dayKey } : { kind: "night", dayKey: dayKey(addDaysTz(dayKeyToMs(now.dayKey, tz), -1, tz), tz) };
    return { now: `${now.kind}:${now.dayKey}`, last: `${last.kind}:${last.dayKey}` };
  }, [clock, tz, shiftTimes]);
  const tagOf = (key: string, band: Band) => {
    const k = `${band}:${key}`;
    if (k === shiftTags.now) return <span className="shrink-0 rounded px-1 py-px text-[8.5px] font-black uppercase tracking-wider bg-rose-600 text-white">Now</span>;
    if (k === shiftTags.last) return <span title="The shift that just ended — the one to write up" className="shrink-0 rounded px-1 py-px text-[8.5px] font-black uppercase tracking-wider bg-amber-500 text-white">Last shift</span>;
    return null;
  };
  // Which shift the day list opens on (from a shift's heading).
  const [agendaFocus, setAgendaFocus] = useState<Band | null>(null);
  const openShift = (key: string, band: Band) => { setAgendaFocus(band); setAgendaDay(key); };
  const partsOf = (key: string) => {
    const all = byDay.get(key) ?? { day: [], night: [] };
    return { idle: all.day.filter((p) => p.idleToday), day: all.day.filter((p) => !p.idleToday), night: all.night };
  };
  const bandHead = (key: string, band: Band, n: number, big = false, short = false) => {
    const w = shiftWindow(key, band, tz, shiftTimes);
    return (
      <button type="button" onClick={() => openShift(key, band)}
        title={`${band === "day" ? "Day" : "Night"} shift ${clockLabel(w.start, tz)}–${clockLabel(w.end, tz)}${band === "night" ? ` (into ${fmtInTz(w.end, tz, { weekday: "short" })} morning)` : ""} — open its list to enter progress`}
        className={`shrink-0 flex items-center gap-1 px-1 min-w-0 ${big ? "text-[10.5px]" : "text-[9px]"} font-black uppercase tracking-wider hover:underline ${band === "day" ? "text-sky-800 dark:text-sky-300" : "text-violet-800 dark:text-violet-200"}`}>
        {band === "day" ? <Sun className="w-2.5 h-2.5 shrink-0" aria-hidden /> : <Moon className="w-2.5 h-2.5 shrink-0" aria-hidden />}
        {band === "day" ? "Day" : "Night"}
        <span className="font-semibold normal-case tracking-normal opacity-80 truncate">{clockLabel(w.start, tz)}–{band === "night" && !short ? `${fmtInTz(w.end, tz, { weekday: "short" })} ` : ""}{clockLabel(w.end, tz)}</span>
        {tagOf(key, band)}
        <span className="ml-auto tabular-nums">{n}</span>
      </button>
    );
  };
  // Work orders open across a day with no step on it: folded into one line.
  const [idleOpen, setIdleOpen] = useState<Set<string>>(new Set());
  const idleLine = (key: string, idle: Placed[], big = false) => {
    if (!idle.length) return null;
    const open = idleOpen.has(key);
    return (
      <div key="idle" className="shrink-0 flex flex-col gap-1">
        <button type="button" onClick={() => setIdleOpen((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
          title={idle.map((p) => p.ms.name).join("\n")}
          className={`flex items-center gap-1 px-1 text-left ${big ? "text-[10.5px]" : "text-[9.5px]"} font-semibold text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)]`}>
          <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
          {idle.length} open, no work this day
        </button>
        {open && <div className="flex flex-col gap-1 opacity-70">{idle.map((p) => chipFor(p, key))}</div>}
      </div>
    );
  };
  // Day shift in blue, night shift in purple — the night box runs to the next morning.
  const renderBands = (key: string, big = false) => {
    const b = partsOf(key);
    const out = (["day", "night"] as const).filter((band) => b[band].length > 0).map((band) => (
      <div key={band} className={`shrink-0 rounded-md p-0.5 flex flex-col gap-1 ${band === "day" ? "bg-sky-50 dark:bg-sky-950/30" : "bg-violet-100 dark:bg-violet-950/50"}`}>
        {bandHead(key, band, b[band].length, big)}
        {doneLast(b[band]).map((p) => chipFor(p, key))}
      </div>
    ));
    const idle = idleLine(key, b.idle, big);
    return idle ? [...out, idle] : out;
  };

  // 6-week grid starting on the Sunday on/before the 1st.
  const weeks = useMemo(() => {
    const first = cursor;
    const gridStart = addDaysUTC(first, -dayOfWeek(first.getTime(), tz), tz);
    return Array.from({ length: 6 }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => addDaysUTC(gridStart, w * 7 + d, tz)),
    );
  }, [cursor, tz]);

  const monthIdx = wallClock(cursor.getTime(), tz).month;
  // The week holding the focused day (week view).
  const weekDays = useMemo(() => {
    const start = addDaysUTC(focusDay, -dayOfWeek(focusDay.getTime(), tz), tz);
    return Array.from({ length: 7 }, (_, d) => addDaysUTC(start, d, tz));
  }, [focusDay, tz]);
  const gridWeeks = mode === "week" ? [weekDays] : weeks;
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

  // The calendar's own width: under ~760 px (a phone) the month is a
  // compact grid of counts and the week stacks its days.
  const rootRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const compact = boxW > 0 && boxW < 760;

  // One card per task, the same in every layout.
  const chipFor = (p: Placed, key: string) => {
    const color = colorFor(p.ms);
    const chain = ancestorsOf(p.ms);
    // Offer expand on any day the parent bar shows, so
    // the arrow is reachable wherever you're looking.
    const canExpand = !isLeaf(p.ms) && !showSubtasks;
    const openQuick = (e: React.MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setSubPopover((cur) => cur && cur.ms.id === p.ms.id && cur.dayKey === key && cur.band === p.band ? null : { ms: p.ms, top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 428)), dayKey: key, band: p.band, anchorTop: r.top });
    };
    return (
      <Chip
        key={`${p.ms.id}-${p.dayIndex}`}
        ms={p.ms} dayIndex={p.dayIndex} spanDays={p.spanDays}
        todayStart={p.todayStart} todayEnd={p.todayEnd} idleToday={p.idleToday} crewToday={p.crew} bandStart={p.bandStart} bandEnd={p.bandEnd}
        childrenByParent={childrenByParent}
        ancestors={chain} color={color}
        draggable={canEdit && !!p.ms.id && p.ms.status !== "completed"}
        onDragStart={(e) => { setDragId(p.ms.id ?? null); e.dataTransfer.setData("text/plain", `${p.ms.id}|${key}`); }}
        onTouchDragStart={p.ms.id ? (e) => startTouchDrag(p.ms.id!, key, p.ms.name, e) : undefined}
        // The card opens its quick view — everything to update it, no sidebar.
        onClick={(e) => { if (selected.size > 0 && p.ms.id) toggleSelected(p.ms.id); else if (p.ms.id && e) openQuick(e); else onOpenDetail(p.ms); }}
        progress={progress}
        canExpand={canExpand}
        isExpanded={!!subPopover && subPopover.ms.id === p.ms.id && subPopover.dayKey === key && subPopover.band === p.band}
        onToggleExpand={p.ms.id ? openQuick : undefined}
        selectable={canEdit && p.dayIndex === 0}
        selected={!!p.ms.id && selected.has(p.ms.id)}
        onToggleSelect={() => p.ms.id && toggleSelected(p.ms.id)}
        dimmed={!!dragId && dragId === p.ms.id}
        shiftTimes={shiftTimes}
      />
    );
  };

  return (
    <div ref={rootRef} className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
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
      <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white dark:from-[var(--color-surface)] to-slate-50/40 dark:to-[var(--color-surface)]">
        <button onClick={() => step(-1)} title={`Previous ${mode}`} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><ChevronLeft className="w-4 h-4" /></button>
        <div className="text-sm font-bold text-[var(--color-text)] min-w-[150px] text-center">
          {mode === "month" ? fmtInTz(cursor, tz, { month: "long", year: "numeric" })
            : mode === "week" ? `${fmtInTz(weekDays[0], tz, { month: "short", day: "numeric" })} – ${fmtInTz(weekDays[6], tz, { month: "short", day: "numeric", year: "numeric" })}`
              : fmtInTz(focusDay, tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
        </div>
        <button onClick={() => step(1)} title={`Next ${mode}`} className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors"><ChevronRight className="w-4 h-4" /></button>
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5" role="group" aria-label="Calendar view">
          {(["month", "week", "day"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
              className={`px-2.5 py-1 rounded text-[11px] font-bold capitalize transition-colors ${mode === m ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {m}
            </button>
          ))}
        </div>
        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]" title={`Days and times are shown in the plant's zone: ${tz}`}>{tzAbbrev(tz, cursor.getTime())}</span>
        <button onClick={goToday} className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] transition-colors">
          <Crosshair className="w-3.5 h-3.5 text-rose-500" /> Today
        </button>
        <button onClick={() => setAgendaDay(ymd(new Date(), tz))}
          title="Every step for today in one list — enter % done, status, what's blocking it and notes, one after another"
          className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1 rounded-md shadow-sm transition-colors">
          <ListChecks className="w-3.5 h-3.5" /> Update progress
        </button>
        {span && (
          <button onClick={() => { setCursor(firstOfMonthUTC(span.earliest, tz)); setFocusDay(startOfDayUTC(span.earliest, tz)); }} className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] transition-colors">
            ⏮ Schedule start
          </button>
        )}
        <div className="ml-auto inline-flex items-center gap-1.5 flex-wrap">
          {mode !== "day" && <>
            <span className="text-[10px] font-semibold text-[var(--color-text-faint)] uppercase tracking-wide">Crew</span>
            <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5" role="group" aria-label="Crew">
              {([["all", "All"], ["day", "Day"], ["night", "Night"]] as const).map(([id, label]) => (
                <button key={id} onClick={() => setCrewFilter(id)} aria-pressed={crewFilter === id}
                  title={id === "all" ? "Day and night work" : id === "day" ? "Only work the day crew does" : "Only work the night crew does"}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold transition-colors ${crewFilter === id ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                  {id === "day" && <Sun className="w-3 h-3" />}{id === "night" && <Moon className="w-3 h-3" />}{label}
                </button>
              ))}
            </div>
            {/* Who works nights, and on what — changed as the job goes. */}
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT, { detail: "night" }))}
              title="Who works nights, and on what — see each night's work before you save"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-violet-300 dark:border-violet-800 text-[11px] font-bold text-violet-800 dark:text-violet-200 hover:bg-violet-50 dark:hover:bg-violet-950/40">
              <Moon className="w-3 h-3" /> Night crews
            </button>
          </>}
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
            const color = colorFor(u);
            return (
              <span key={u.id ?? u.name} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${color.bar}`} />
                <span className="font-semibold text-[var(--color-text-muted)]">{u.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* One quiet line of how-to — what each mark on a card does. */}
      <div className={`px-3 py-1.5 border-b border-[var(--color-border)] bg-slate-50/40 dark:bg-[var(--color-surface-2)]/40 flex items-center gap-x-3 gap-y-1 flex-wrap text-[10.5px] text-[var(--color-text-muted)] ${mode === "day" ? "hidden" : ""}`}>
        <Info className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
        {showSubtasks
          ? <span><b className="text-[var(--color-text)]">Sub-items:</b> each step is its own card — drag one to move just that step.</span>
          : <span><b className="text-[var(--color-text)]">{compact ? "Tap a day" : "Click a day\u2019s number"}</b> for its full list with progress entry.</span>}
        {/* What the marks on a card do — not on a phone, where a day opens its list. */}
        {!compact && <>
          <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-slate-400 border border-black/10" /> status</span>
          <span className="inline-flex items-center gap-1"><span className="text-[9px] font-bold px-1 rounded border border-[var(--color-border-strong)]">40%</span> set progress</span>
          {!showSubtasks && <span className="inline-flex items-center gap-1"><ChevronRight className="w-3 h-3" /> its steps that day</span>}
          <span className="inline-flex items-center gap-1"><GripVertical className="w-3 h-3" /> drag by the colored edge</span>
          <span className="inline-flex items-center gap-1"><CheckSquare className="w-3 h-3" /> select (on hover)</span>
        </>}
      </div>

      {mode === "day" ? (
        <DayAgendaPanel
          inline
          planNow={planNow}
          userId={userId}
          day={ymd(focusDay, tz)}
          tz={tz}
          milestones={milestones}
          childrenByParent={childrenByParent}
          ancestorsOf={ancestorsOf}
          progress={progress}
          canEdit={canEdit}
          onSetStatus={onSetStatus}
          onSetProgress={onSetProgress}
          onAddNote={onAddNote}
          onSetProgressNote={onSetProgressNote}
          onUpdateStep={onUpdateStep}
          onStartNote={onStartNote}
          shiftTimes={shiftTimes}
          onOpenDetail={(m) => { onOpenDetail(m); }}
          onChangeDay={(k) => setFocusDay(ymdToDate(k, tz))}
          onClose={() => setMode("month")}
          colorOf={(top) => colorFor(top)}
        />
      ) : (<>
      {compact && mode === "week" ? (
        // Phone week: the days stacked, each with its cards full width.
        <div className="divide-y divide-[var(--color-border)]">
          {weekDays.map((day) => {
            const key = ymd(day, tz);
            // Work that day (work orders with nothing on it don't count).
            const items = uniqueOf(key).filter((p) => !p.idleToday);
            const nightN = (byDay.get(key)?.night ?? []).length;
            const isToday = sameDayUTC(day, today, tz);
            const isDone = isDonePl;
            return (
              <section key={key} data-daykey={key} className="px-2 py-2">
                <button type="button" onClick={() => setAgendaDay(key)} className="w-full flex items-center justify-between gap-2 mb-1.5 text-left">
                  <span className={`text-[12px] font-black ${isToday ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text)]"}`}>
                    {fmtInTz(day, tz, { weekday: "long", month: "short", day: "numeric" })}
                  </span>
                  <span className="text-[10.5px] font-semibold text-[var(--color-text-faint)]">
                    {items.length ? `${items.length} task${items.length === 1 ? "" : "s"}${nightN ? ` · ${nightN} night` : ""}${items.filter(isDone).length ? ` · ${items.filter(isDone).length} done` : ""} ›` : "Nothing scheduled"}
                  </span>
                </button>
                {uniqueOf(key).length > 0 && <div className="flex flex-col gap-1.5">{renderBands(key, true)}</div>}
              </section>
            );
          })}
        </div>
      ) : mode === "week" ? (() => {
        // Two lanes: the day shifts under their dates, and the nights between
        // them — each night card sits from its evening into the next morning.
        const cols = { gridTemplateColumns: "repeat(15, minmax(0, 1fr))" };
        const prevKey = ymd(addDaysUTC(weekDays[0], -1, tz), tz);
        const nextDay = addDaysUTC(weekDays[6], 1, tz);
        const prevNight = partsOf(prevKey).night;
        // Each lane as tall as its busiest shift (cards don't shrink; a very
        // busy shift scrolls inside its box).
        const tall = (band: Band) => Math.max(...weekDays.map((d) => {
          const k = ymd(d, tz), b = partsOf(k);
          return 26 + b[band].length * 53 + (band === "day" && b.idle.length ? 22 : 0) + (band === "day" && sameDayUTC(d, today, tz) && overdueToday.length ? 42 : 0);
        }));
        const laneH = (band: Band) => `min(${Math.max(band === "day" ? 140 : 110, tall(band))}px, ${band === "day" ? 56 : 42}vh)`;
        return (
          <div>
            <div className="grid border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)]" style={cols}>
              {weekDays.map((day, i) => {
                const key = ymd(day, tz);
                const isToday = sameDayUTC(day, today, tz);
                return (
                  <button key={key} type="button" onClick={() => { setAgendaFocus(null); setAgendaDay(key); }} style={{ gridColumn: `${2 * i + 1} / span 2` }}
                    title="Open this day's list — every step, with progress entry"
                    className={`px-2 py-1.5 text-center text-[11px] font-black uppercase tracking-wider border-r border-[var(--color-border)] hover:text-[var(--color-accent)] ${isToday ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text-muted)]"}`}>
                    {fmtInTz(day, tz, { weekday: "short" })} {wallClock(day.getTime(), tz).day}
                    {(() => { const n = uniqueOf(key).filter((p) => !p.idleToday).length; return n > 0 ? <span className="ml-1 font-semibold normal-case tracking-normal text-[var(--color-text-faint)]">· {n}</span> : null; })()}
                  </button>
                );
              })}
              <div style={{ gridColumn: "15 / span 1" }} className="px-1 py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">
                {fmtInTz(nextDay, tz, { weekday: "short" })} am
              </div>
            </div>
            {crewFilter !== "night" && (
              <div className="grid border-b-2 border-violet-200 dark:border-violet-900" style={{ ...cols, height: laneH("day") }}>
                {weekDays.map((day, i) => {
                  const key = ymd(day, tz);
                  const b = partsOf(key);
                  const isToday = sameDayUTC(day, today, tz);
                  const live = shiftTags.now === `day:${key}`;
                  return (
                    <div key={key} data-daykey={key} style={{ gridColumn: `${2 * i + 1} / span 2` }}
                      onDragOver={(e) => { if (canEdit) e.preventDefault(); }} onDrop={(e) => void onDropDay(key, e)}
                      className={`min-h-0 min-w-0 border-r border-sky-100 dark:border-sky-950 p-1 flex flex-col gap-1 bg-sky-50/70 dark:bg-sky-950/20 ${live ? "ring-2 ring-inset ring-rose-300 dark:ring-rose-800" : ""}`}>
                      {bandHead(key, "day", b.day.length, false, true)}
                      {isToday && overdueToday.length > 0 && (
                        <button type="button" onClick={() => openShift(key, "day")}
                          title={overdueToday.slice(0, 6).map((w) => `• ${w.leaf.name}`).join("\n") + (overdueToday.length > 6 ? `\n…and ${overdueToday.length - 6} more` : "")}
                          className="shrink-0 w-full text-left rounded px-1.5 py-1 bg-rose-600 text-white text-[10px] font-black uppercase tracking-wide hover:bg-rose-700">
                          ⚠ {overdueToday.length} carried over — not done
                        </button>
                      )}
                      <DayScroller fade="from-sky-50 dark:from-sky-950">
                        {doneLast(b.day).map((p) => chipFor(p, key))}
                        {idleLine(key, b.idle)}
                      </DayScroller>
                    </div>
                  );
                })}
                <div style={{ gridColumn: "15 / span 1" }} className="bg-slate-50/40 dark:bg-transparent" aria-hidden />
              </div>
            )}
            {crewFilter !== "day" && (
              <div className="grid" style={{ ...cols, height: laneH("night") }}>
                {/* The night before the week: half a box, its count. */}
                <button type="button" onClick={() => openShift(prevKey, "night")} style={{ gridColumn: "1 / span 1" }}
                  title={`${fmtInTz(addDaysUTC(weekDays[0], -1, tz), tz, { weekday: "long" })} night — open its list`}
                  className="min-w-0 border-r border-violet-200 dark:border-violet-900 bg-violet-100/60 dark:bg-violet-950/30 flex flex-col items-center justify-center gap-1 text-violet-800 dark:text-violet-200 hover:bg-violet-100">
                  <Moon className="w-3.5 h-3.5" aria-hidden />
                  <span className="text-[9px] font-black uppercase tracking-wider">{fmtInTz(addDaysUTC(weekDays[0], -1, tz), tz, { weekday: "short" })}</span>
                  {prevNight.length > 0 && <span className="text-[10px] font-bold tabular-nums">{prevNight.length}</span>}
                </button>
                {weekDays.map((day, i) => {
                  const key = ymd(day, tz);
                  const b = partsOf(key);
                  const live = shiftTags.now === `night:${key}`;
                  return (
                    <div key={key} data-daykey={key} style={{ gridColumn: `${2 * i + 2} / span 2` }}
                      onDragOver={(e) => { if (canEdit) e.preventDefault(); }} onDrop={(e) => void onDropDay(key, e)}
                      className={`relative min-h-0 min-w-0 border-r border-violet-200 dark:border-violet-900 p-1 flex flex-col gap-1 bg-violet-100/70 dark:bg-violet-950/40 ${live ? "ring-2 ring-inset ring-rose-300 dark:ring-rose-800" : ""}`}>
                      {/* Midnight: where the night crosses into the next date. */}
                      <span aria-hidden className="pointer-events-none absolute top-0 bottom-0 left-1/2 border-l border-dashed border-violet-300/70 dark:border-violet-800/70" />
                      {bandHead(key, "night", b.night.length, false, true)}
                      <DayScroller fade="from-violet-100 dark:from-violet-950">
                        {doneLast(b.night).map((p) => chipFor(p, key))}
                      </DayScroller>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })() : (<>
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] text-center">{d}</div>
        ))}
      </div>

      {/* Weeks */}
      <div className="flex-1">
        {gridWeeks.map((week, wi) => (
          // A day box has one fixed, comfortable size; a busy day scrolls
          // inside it (cards never shrink).
          // A week with nothing in it stays short, so the busy weeks get the room.
          <div key={wi} className="grid grid-cols-7 border-b border-[var(--color-border)] last:border-b-0"
            style={{ height: week.some((d) => uniqueOf(ymd(d, tz)).length > 0) ? (compact ? 64 : 212) : (compact ? 40 : 56) }}>
            {week.map((day) => {
              const key = ymd(day, tz);
              const items = uniqueOf(key);
              const nightN = (byDay.get(key)?.night ?? []).length;
              const inMonth = wallClock(day.getTime(), tz).month === monthIdx;
              const isToday = sameDayUTC(day, today, tz);
              // Every task shows, in its shift; a busy day scrolls inside
              // its box. Open work first (in time order), finished below.
              const doneHere = items.filter(isDonePl).length;
              if (compact && mode === "month") {
                // Phone month: the day, how many tasks, how far along —
                // tap for the day's full list.
                const avg = items.length ? Math.round(items.reduce((a, p) => a + ((p.ms.id ? progress?.get(p.ms.id)?.percent : undefined) ?? 0), 0) / items.length) : 0;
                return (
                  <button key={key} type="button" data-daykey={key} onClick={() => items.length && setAgendaDay(key)}
                    className={`min-w-0 border-r border-[var(--color-border)] last:border-r-0 p-1 flex flex-col items-start gap-0.5 text-left ${inMonth ? "bg-[var(--color-surface)]" : "bg-slate-50/40 dark:bg-transparent"} ${isToday ? "ring-1 ring-inset ring-rose-300" : ""}`}>
                    <span className={`text-[11px] font-bold ${isToday ? "text-rose-600 dark:text-rose-400" : inMonth ? "text-[var(--color-text)]" : "text-slate-300 dark:text-slate-600"}`}>{wallClock(day.getTime(), tz).day}</span>
                    {items.length > 0 && <>
                      <span className="text-[10px] font-black tabular-nums px-1.5 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{items.length}</span>
                      <span className="mt-auto w-full h-1 rounded-full bg-black/10 overflow-hidden"><span className={`block h-full ${avg >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${avg}%` }} /></span>
                    </>}
                  </button>
                );
              }
              return (
                <div
                  key={key}
                  data-daykey={key}
                  onDragOver={(e) => { if (canEdit) { e.preventDefault(); } }}
                  onDrop={(e) => void onDropDay(key, e)}
                  className={`group/tile min-h-0 min-w-0 border-r border-[var(--color-border)] last:border-r-0 p-1 flex flex-col gap-1 ${inMonth ? "bg-[var(--color-surface)]" : "bg-slate-50/40"} ${isToday ? "ring-1 ring-inset ring-rose-300" : ""}`}
                >
                  <div className="shrink-0 flex items-center justify-between gap-1 px-0.5">
                    <button
                      type="button"
                      onClick={() => setAgendaDay(key)}
                      title={`Open ${fmtInTz(day, tz, { weekday: "long", month: "long", day: "numeric" })} — every step due that day, with progress entry`}
                      className={`inline-flex items-center gap-1 text-[11px] font-bold rounded px-1 -ml-1 hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] transition-colors ${isToday ? "text-rose-600 dark:text-rose-400" : inMonth ? "text-[var(--color-text)]" : "text-slate-300"}`}
                    >
                      {wallClock(day.getTime(), tz).day}
                      {items.length > 0 && <span className="text-[8px] font-black uppercase tracking-wider opacity-0 group-hover/tile:opacity-70">Open day</span>}
                    </button>
                    {items.length > 0 && (
                      <span className={`min-w-0 truncate whitespace-nowrap text-[9.5px] font-semibold tabular-nums ${inMonth ? "text-[var(--color-text-faint)]" : "text-slate-300"}`}>
                        {items.length} task{items.length === 1 ? "" : "s"}{nightN > 0 && <span className="text-violet-700 dark:text-violet-300"> · {nightN} night</span>}{doneHere ? ` · ${doneHere} done` : ""}
                      </span>
                    )}
                  </div>
                  {isToday && overdueToday.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAgendaDay(key)}
                      title={overdueToday.slice(0, 6).map((w) => `• ${w.leaf.name}`).join("\n") + (overdueToday.length > 6 ? `\n…and ${overdueToday.length - 6} more` : "") + "\nOpen the day view to work them"}
                      className="shrink-0 w-full text-left rounded px-1.5 py-1 bg-rose-600 text-white text-[10px] font-black uppercase tracking-wide hover:bg-rose-700"
                    >
                      ⚠ {overdueToday.length} carried over — not done
                    </button>
                  )}
                  <DayScroller fade={inMonth ? "from-[var(--color-surface)]" : "from-slate-50"}>
                  {renderBands(key)}
                  </DayScroller>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      </>)}

      </>)}

      {/* Sub-items popover — opens at the chip's chevron on a specific day
          tile. Shows the steps scheduled on THAT day (status dot, time,
          progress entry) and keeps the other days' steps behind a toggle,
          so the tile answers "what is expected today" without the rest
          of the task's history crowding in. Nothing leaves the grid. */}
      {subPopover && (() => {
        const dayKey = subPopover.dayKey;
        // By start, then the one that finishes first, then the file's order.
        // A card that is a single step is its own list.
        const kids = leafDescendants(subPopover.ms);
        const all = (kids.length ? kids : [subPopover.ms]).slice().sort((a, b) => startMs(a) - startMs(b) || finishMs(a) - finishMs(b) || wbsCompare(a.wbs, b.wbs));
        const band = subPopover.band;
        // Opened from a shift: that shift's steps; the rest behind a toggle.
        const coversDay = (l: Milestone) => {
          if (band) return bandsOf(l)[band].has(dayKey);
          const s0 = startMs(l), f0 = finishMs(l);
          if (!Number.isFinite(s0) || !Number.isFinite(f0)) return false;
          return ymd(new Date(s0), tz) <= dayKey && dayKey <= ymd(new Date(f0), tz);
        };
        const onDay = all.filter(coversDay);
        const others = all.filter((l) => !coversDay(l));
        const dayLabel = `${band === "day" ? "Day shift " : band === "night" ? "Night shift " : ""}${fmtInTz(ymdToDate(dayKey, tz), tz, { weekday: "short", month: "short", day: "numeric" })}`;
        return (
          <div className="fixed inset-0 z-[160]" onClick={() => setSubPopover(null)}>
            <div
              ref={subRef}
              className="absolute w-[420px] max-w-[94vw] max-h-[80dvh] overflow-y-auto bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg animate-in fade-in zoom-in-95 duration-150 max-sm:!left-0 max-sm:!right-0 max-sm:!top-auto max-sm:bottom-0 max-sm:!w-full max-sm:!max-w-none max-sm:rounded-b-none max-sm:max-h-[88dvh]"
              style={{ top: subPopover.top, left: subPopover.left }}
              onClick={(e) => e.stopPropagation()}
            >
              <CalendarQuickView
                key={`${subPopover.ms.id}:${dayKey}:${band ?? ""}`}
                task={subPopover.ms} onDay={onDay} others={others} dayKey={dayKey} band={band ?? null} dayLabel={dayLabel}
                tz={tz} times={shiftTimes} progress={progress} planNow={planNow} canEdit={canEdit}
                onUpdate={onUpdateStep}
                onOpenDetail={(m) => { onOpenDetail(m); setSubPopover(null); }}
                onMoveDays={canEdit ? onMoveDays : undefined}
              />
            </div>
          </div>
        );
      })()}

      {/* Day agenda — the work list for one day. */}
      {/* Stays mounted (hidden) while a task's details are open, so its
          search and open row are still there on the way back. */}
      {agendaDay && (
        <DayAgendaPanel
          focus={agendaFocus}
          hidden={!!detailOpen}
          planNow={planNow}
          userId={userId}
          day={agendaDay}
          tz={tz}
          milestones={milestones}
          childrenByParent={childrenByParent}
          ancestorsOf={ancestorsOf}
          progress={progress}
          canEdit={canEdit}
          onSetStatus={onSetStatus}
          onSetProgress={onSetProgress}
          onAddNote={onAddNote}
          onSetProgressNote={onSetProgressNote}
          onUpdateStep={onUpdateStep}
          onStartNote={onStartNote}
          shiftTimes={shiftTimes}
          onOpenDetail={(m) => { onOpenDetail(m); }}
          onChangeDay={(k) => { setAgendaFocus(null); setAgendaDay(k); }}
          onClose={() => { setAgendaDay(null); setAgendaFocus(null); }}
          colorOf={(top) => colorFor(top)}
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

/** A day box's list: fills the space under the day number and scrolls
 *  quietly when it's longer — no bar until the pointer is over it; a soft
 *  fade and a small "↓ 3 more" say there's more below. */
function DayScroller({ children, fade }: { children: React.ReactNode; fade: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight;
    let n = 0;
    // Cards (inside their shift boxes) that run past the bottom.
    for (const c of Array.from(el.querySelectorAll("[data-chip]")) as HTMLElement[]) if (c.offsetTop + c.offsetHeight > bottom + 4) n++;
    setBelow(n);
  }, []);
  // After every render (cards added, expanded, resized) and on scroll.
  React.useEffect(() => { const id = requestAnimationFrame(measure); return () => cancelAnimationFrame(id); });
  return (
    <div className="relative flex-1 min-h-0">
      <div ref={ref} onScroll={measure} className="scroll-quiet relative h-full overflow-y-auto flex flex-col gap-1 pb-1">
        {children}
      </div>
      {below > 0 && (
        <>
          <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t ${fade} to-transparent`} aria-hidden />
          <button type="button"
            onClick={(e) => { e.stopPropagation(); ref.current?.scrollBy({ top: (ref.current?.clientHeight ?? 120) * 0.8, behavior: "smooth" }); }}
            title="Scroll for the rest of this day's tasks"
            className="absolute bottom-0.5 left-1/2 -translate-x-1/2 inline-flex items-center gap-0.5 whitespace-nowrap rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm px-2 py-[1px] text-[9.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent-ring)]">
            <ChevronDown className="w-3 h-3" /> {below} more
          </button>
        </>
      )}
    </div>
  );
}

function Chip({
  ms, dayIndex, spanDays, todayStart, todayEnd, idleToday, crewToday, bandStart, bandEnd, childrenByParent, ancestors, color, draggable, onDragStart, onTouchDragStart, onClick,
  progress, canExpand, isExpanded, onToggleExpand, selectable, selected, onToggleSelect, dimmed, shiftTimes,
}: {
  ms: Milestone; dayIndex: number; spanDays: number;
  /** This day's active window (see DayPlacement). */
  todayStart?: number; todayEnd?: number; idleToday?: boolean;
  /** Which crew does its work on this day (see DayPlacement.crew). */
  crewToday?: DayCrew;
  /** The shift it's shown in (its clock reads against it). */
  bandStart?: number; bandEnd?: number;
  childrenByParent: Map<string, Milestone[]>;
  ancestors?: Milestone[];
  color?: { bar: string; soft: string; text: string; dot: string };
  canEdit?: boolean;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onTouchDragStart?: (e: React.PointerEvent) => void;
  onClick: (e?: React.MouseEvent) => void;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number, forShift?: ShiftCredit) => unknown;
  onSetProgress?: (id: string, percent: number) => unknown;
  onSetProgressNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
  onStartNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
  progress?: Map<string, ProgressInfo>;
  shiftTimes?: ShiftTimes;
  canExpand?: boolean; isExpanded?: boolean; onToggleExpand?: (e: React.MouseEvent) => void;
  selectable?: boolean; selected?: boolean; onToggleSelect?: () => void;
  dimmed?: boolean;
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
  // A finished step just says done — when it was marked done isn't when it
  // finished, so no early / late is claimed.
  const clock = (() => {
    if (ms.status === "completed") return "✓ done";
    if (idleToday) return "no work today";
    if (todayStart == null || todayEnd == null) return dayIndex > 0 ? "cont." : startClock(ms, tz);
    if (bandStart != null && bandEnd != null) {
      // Against its shift: "18:00–3:00", "→14:00", "all shift".
      const s = clockLabel(todayStart, tz) || "0:00", e = clockLabel(todayEnd, tz) || "0:00";
      const sIn = todayStart > bandStart + 60_000, eIn = todayEnd < bandEnd - 60_000 || todayStart >= bandEnd;
      return sIn && eIn ? `${s}–${e}` : sIn ? `${s}→` : eIn ? `→${e}` : "all shift";
    }
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

  const crew: DayCrew = crewToday ?? (() => {
    const t = shiftTimes ?? DEFAULT_SHIFT_TIMES;
    if (!hasSubs) return workShiftOf(ms, tz, t);
    return crewOf(leafKids.map((k) => workShiftOf(k, tz, t)));
  })();
  // Night work reads as night at a glance: an indigo card (when it isn't
  // already colored by its status) and a NIGHT tag.
  const night = crew === "night";
  const toneClass = night && effStatus === "planned"
    ? "bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800 text-[var(--color-text)]"
    : tone;
  // The quiet second line: where it belongs, when today, which day of a
  // multi-day job.
  // The time first, so a box reads in order at a glance.
  const meta = [clock, parentLabel, spanDays > 1 ? `day ${dayIndex + 1}/${spanDays}` : null].filter(Boolean).join(" · ");

  // One card: name and % on top; where / when below; a hairline of
  // progress along the bottom. Drag by the colored edge; select and drag
  // grips appear on hover (always on touch).
  return (
    <div
      data-chip
      onClick={onClick}
      title={tip}
      className={`group/chip relative shrink-0 w-full text-left rounded-md border pl-2.5 pr-1 pt-1 pb-1.5 overflow-hidden cursor-pointer transition-colors ${toneClass} ${dimmed ? "opacity-40" : ""} ${selected ? "ring-2 ring-[var(--color-accent-ring)] ring-offset-1" : ""}`}
    >
      {/* Unit accent stripe — same color for every task in a unit; it's the
          drag handle too. */}
      {color && <span className={`absolute left-0 top-0 bottom-0 w-1 ${color.bar}`} aria-hidden />}
      {draggable && (
        <span
          draggable
          onDragStart={onDragStart}
          onPointerDown={onTouchDragStart}
          onClick={(e) => e.stopPropagation()}
          title="Drag to move to another day"
          style={{ touchAction: "none" }}
          className="absolute left-0 top-0 bottom-0 w-2.5 z-10 flex items-center justify-center cursor-grab active:cursor-grabbing text-[var(--color-text-faint)] opacity-0 group-hover/chip:opacity-100 pointer-coarse:opacity-100 hover:bg-black/10"
        >
          <GripVertical className="w-2.5 h-3" />
        </span>
      )}

      {selectable && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(); }}
          title={selected ? "Deselect" : "Select for bulk actions"}
          className={`absolute top-0.5 right-0.5 z-10 w-4 h-4 pointer-coarse:w-6 pointer-coarse:h-6 rounded border flex items-center justify-center transition-opacity ${selected ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--color-accent-fg)] opacity-100" : "bg-[var(--color-surface)] border-[var(--color-border-strong)] text-transparent opacity-0 group-hover/chip:opacity-100"}`}
        >
          <CheckSquare className="w-3 h-3" />
        </button>
      )}

      <div className="flex items-start gap-1.5">
        {/* Status dot: opens the quick view — status, %, time and comment
            for each step on this shift, in one place. */}
        <span className="shrink-0 mt-[3px]" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={(e) => { e.stopPropagation(); if (onToggleExpand) onToggleExpand(e); else onClick(e); }}
            title={isLeaf ? "Update this step" : "Update its steps for this shift"} className="relative inline-flex after:absolute after:-inset-1.5 pointer-coarse:after:-inset-3 after:content-['']">
            <StatusControl status={effStatus} size="sm" variant="dot" readOnly title={isLeaf ? "Update this step" : "Update its steps for this shift"} onPick={() => {}} />
          </button>
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] font-semibold leading-snug line-clamp-2 break-words ${effStatus === "completed" ? "line-through opacity-70" : ""}`}>{ms.name}</div>
          {/* Second line: where / when on the left, % and its steps on the
              right — the name keeps the whole first line. */}
          <div className="mt-0.5 flex items-center gap-1 min-w-0">
            <span className="flex items-center gap-1 min-w-0 flex-1 text-[9.5px] leading-tight opacity-70">
              {/* Night work is tagged; round the clock and day-and-night
                  mixes are marked; day work — most of it — is left quiet. */}
              {night && bandStart == null && (
                <span title="Night-shift work" className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[8.5px] font-black leading-[14px] bg-indigo-900 text-white dark:bg-indigo-300 dark:text-indigo-950">
                  <Moon className="w-2.5 h-2.5" />NIGHT
                </span>
              )}
              {crew === "both" && <ShiftMark work="both" />}
              {crew === "mixed" && (
                <span title="Day and night work today" className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[8.5px] font-black leading-[14px] bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200">
                  <Sun className="w-2.5 h-2.5" />+<Moon className="w-2.5 h-2.5" />
                </span>
              )}
              <span className="truncate">{meta}</span>
            </span>
            <span className="shrink-0 flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {(
                <button type="button" onClick={(e) => { e.stopPropagation(); if (onToggleExpand) onToggleExpand(e); else onClick(e); }}
                  title={isLeaf ? `${pct}% complete — tap to update` : `${pct}% complete · ${done}/${leafTotal} steps done — tap to update its steps`}
                  className={`relative inline-flex items-center justify-center rounded-md border px-1 py-0 text-[9px] font-bold tabular-nums after:absolute after:-inset-1 pointer-coarse:after:-inset-2.5 after:content-[''] hover:brightness-95 ${pct >= 100 ? "text-emerald-700 bg-emerald-50 border-emerald-200" : pct > 0 ? "text-blue-700 bg-blue-50 border-blue-200" : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]"}`}>
                  {pct}%
                </button>
              )}
              {canExpand && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleExpand?.(e); }}
                  title={isExpanded ? "Hide its steps" : "Show its steps for this day"}
                  className={`inline-flex items-center justify-center w-4 h-4 pointer-coarse:w-6 pointer-coarse:h-6 rounded transition-colors ${isExpanded ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:bg-black/10 hover:text-[var(--color-accent)]"}`}
                >
                  <ChevronRight className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} strokeWidth={2.5} />
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
      {/* Progress as a hairline along the bottom edge. */}
      <span className="absolute left-1 right-0 bottom-0 h-[2px] bg-black/5" aria-hidden>
        <span className={`block h-full ${pct >= 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

function chipTone(s: MilestoneStatus): string {
  switch (s) {
    case "completed":   return "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200";
    case "in_progress": return "bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-200";
    case "on_hold":     return "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200";
    case "blocked":     return "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-200";
    case "missed":      return "bg-rose-100 dark:bg-rose-900/40 border-rose-300 dark:border-rose-700 text-rose-900 dark:text-rose-200";
    default:            return "bg-[var(--color-surface-2)] border-[var(--color-border)] text-[var(--color-text)]";
  }
}

/** When the work under a card runs in a shift: its steps' crew hours inside
 *  the shift (date-only steps as the whole shift). */
function windowIn(steps: Milestone[], from: number, to: number, tz: string, times: ShiftTimes): { start: number; end: number } {
  let s = Infinity, e = -Infinity;
  // Its crew's hours (day work the file put overnight: the crew's next shift).
  const spans = steps.flatMap((st) => {
    const cw = crewWindows(st, tz, times).windows;
    return cw.length ? cw.map(([a, b]) => ({ start: a, finish: b })) : [workSpan(st, tz)];
  }).filter((x) => Number.isFinite(x.start) && Number.isFinite(x.finish));
  for (const x of spans) {
    const a = Math.max(x.start, from), b = Math.min(x.finish, to);
    if (b > a || (x.start === x.finish && x.start >= from && x.start < to)) { s = Math.min(s, a); e = Math.max(e, b, a); }
  }
  if (Number.isFinite(s)) return { start: s, end: e };
  for (const x of spans) { s = Math.min(s, x.start); e = Math.max(e, x.finish); }
  return Number.isFinite(s) && Number.isFinite(e) ? { start: s, end: e } : { start: from, end: to };
}

// ── Date helpers in the PLANT's zone (tz), shared with the timeline view ──
function startOfDayUTC(d: Date, tz: string): Date { return new Date(startOfDayTz(d.getTime(), tz)); }
function firstOfMonthUTC(d: Date, tz: string): Date { return new Date(startOfMonthTz(d.getTime(), tz)); }
function addMonthsUTC(d: Date, n: number, tz: string): Date { return new Date(addMonthsTz(d.getTime(), n, tz)); }
function addDaysUTC(d: Date, n: number, tz: string): Date { return new Date(addDaysTz(d.getTime(), n, tz)); }
function dayDiff(a: Date, b: Date, tz: string): number { return dayDiffTz(a.getTime(), b.getTime(), tz); }
function sameMonth(a: Date, b: Date, tz: string): boolean { const x = wallClock(a.getTime(), tz), y = wallClock(b.getTime(), tz); return x.year === y.year && x.month === y.month; }
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
