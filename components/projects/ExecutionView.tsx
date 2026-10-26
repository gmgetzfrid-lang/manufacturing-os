"use client";

// ExecutionView — execution-focused schedule board for turnaround /
// outage / capital-project managers and field supervisors.
//
// This is a ground-up rewrite. The previous day/week list buried the
// schedule's shape: you couldn't see sequence, overlap, or duration,
// tasks rendered out of order, and the hierarchy filter double-counted
// rows. The model here is a proper interactive timeline:
//
//   LEFT  — the WBS exactly as imported, as a collapsible outline in
//           true execution order. Each row shows status, rolled-up
//           progress, and its date range. Frozen while you scroll the
//           timeline horizontally.
//
//   RIGHT — a horizontal time axis with one bar per row. Bars sit on
//           their real planned span, colored by status, filled by
//           progress. A live TODAY line. Drag a leaf bar to
//           reschedule; the change writes start + finish and rolls up.
//
// Marking work off is a single click on the status pill (Plan → Doing
// → Done). Parent progress derives from leaf descendants, so checking
// a sub-task updates every ancestor. Reality-on-the-ground edits —
// drag to move, "Set duration" to stretch, "Group" to build missing
// WBS — all write through to the same audited mutations.

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight as ChevronRightIcon, ChevronLeft,
  CalendarDays, CircleCheck, Loader2,
  FolderPlus, CalendarRange, X as XIcon, CheckSquare, Square,
  ZoomIn, ZoomOut, ListTree, Crosshair, Info, Zap, Eye, ListOrdered, Link2, Replace,
  Trash2,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import type { CancelledJob } from "@/lib/cancelledJobs";
import { groupTasksUnderParent, setTaskDuration, addMilestoneNote, stateOf, deleteMilestones, restoreDeletedMilestones, applyBulkFieldChange, type MilestoneState } from "@/lib/milestones";
import { computeTreeMove, computeEdgeResize, computeSummaryResize, sequenceSiblings, cascadeDependents, type ReflowNode, type DateChange } from "@/lib/scheduleReflow";
import { resolveCriticalPath, CRITICAL_MODES, type CriticalMode, type CriticalOverride } from "@/lib/criticalPath";
import { useCriticalMode, saveCriticalMode } from "@/lib/criticalModeStore";
import { resolveVisibleDepIndex } from "@/lib/scheduleDeps";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import { computeExecutionReport } from "@/lib/executionReport";
import { assignGroupColors, type GroupColor } from "@/lib/scheduleColors";
import SchedulePulse from "@/components/projects/SchedulePulse";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import ScheduleCalendarTileView from "@/components/projects/ScheduleCalendarTileView";
import ShiftReportView from "@/components/projects/ShiftReportView";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { addDays as addDaysTz, dayDiff as dayDiffTz, dayKey, dayOfWeek, fmtInTz, hasTimeOfDay, startOfDay as startOfDayTz, wallClock } from "@/lib/scheduleTz";
import { needsFutureConfirm } from "@/lib/scheduleRules";
import { startMsOf as plannedStartMsOf } from "@/lib/calendarPlacement";
import { effectiveSpans, byStart, spanLabel, barGeometry, xAt, hourStep, startOf as timedStart, finishOf as timedFinish } from "@/lib/scheduleTime";
import { expectedByParent, isOverdue, standingOf, workShiftOf, type ShiftTimes, type WorkShift } from "@/lib/shiftReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { linkOf } from "@/lib/scheduleLinks";
import ShiftMark from "@/components/projects/ShiftMark";
import BulkEditModal from "@/components/projects/BulkEditModal";
import { appConfirm } from "@/components/providers/DialogProvider";
import StatusControl from "@/components/projects/StatusControl";
import ProgressControl from "@/components/projects/ProgressControl";
import ExecutionGuide from "@/components/projects/ExecutionGuide";
import ExecutionReportView from "@/components/projects/ExecutionReportView";
import MovePreviewSheet from "@/components/projects/MovePreviewSheet";
import UndoToastHost from "@/components/projects/UndoToastHost";
import { useUndoableActions } from "@/components/projects/useUndoableActions";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { Select } from "@/components/ui/Field";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";

interface Props {
  milestones: Milestone[];
  /** Jobs taken off this schedule — listed on the close-out report. */
  cancelled?: CancelledJob[];
  canEdit: boolean;
  orgId: string;
  projectId: string;
  /** Printed on the shift report header. */
  projectName?: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  onRefresh: () => void;
  /** Persist a batch of reflowed date changes (one drag can shift a
   *  subtree + bleed its ancestors). */
  onMoveMany?: (changes: DateChange[]) => Promise<boolean>;
  /** `percent` rides with "in progress" so starting a held task is one write. */
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number) => Promise<boolean>;
  /** Persist a leaf task's physical % complete (derives status server-side). */
  onSetProgress?: (id: string, percent: number) => Promise<boolean>;
  /** Undo: put tasks back exactly as they were — status, %, hold reason,
   *  actual times — in one write each. */
  onRestore?: (states: MilestoneState[]) => Promise<boolean>;
}

// Day-width bounds (px). Auto-fit fills the available width; we never
// shrink a day below MIN_PX_PER_DAY (so labels stay legible — scroll
// horizontally instead) nor grow past MAX_PX_PER_DAY.
const MIN_PX_PER_DAY = 30;
const MAX_PX_PER_DAY = 1440; // 60 px an hour — a turnaround is planned in hours
const ZOOM_STEP = 1.35;
const ROW_H = 40;     // height of each timeline row, px
const AXIS_H = 58;    // height of the date axis header (days / shifts / hours), px
const LEFT_W = 320;   // width of the frozen outline column, px
const MIN_LEFT_W = 220, MAX_LEFT_W = 640;
const PAD_DAYS = 2;   // padding on each side of the schedule span

interface TreeNode { ms: Milestone; children: TreeNode[]; depth: number }
interface FlatRow {
  ms: Milestone; depth: number; hasChildren: boolean;
  done: number; total: number;
  /** Effective % complete: a leaf's own, a summary's weighted roll-up. */
  pct: number;
  /** Effective status: a leaf's own, a summary's derived roll-up. */
  derivedStatus: MilestoneStatus;
}

export default function ExecutionView({
  milestones, cancelled, canEdit, orgId, projectId, projectName, userId, userName, userEmail, userRole,
  onRefresh, onMoveMany, onSetStatus, onSetProgress, onRestore,
}: Props) {
  const tz = useScheduleTz();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [optimistic, setOptimistic] = useState<Map<string, MilestoneStatus>>(new Map());
  // Optimistic % overlay so dragging a progress slider feels instant (paired
  // with an optimistic status above so the bar + dot move together).
  const [optimisticPct, setOptimisticPct] = useState<Map<string, number>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Bulk change: replace a name everywhere, or set a value on the selection.
  const [bulkMode, setBulkMode] = useState<"replace" | "set" | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [durationFor, setDurationFor] = useState<Milestone | null>(null);
  // zoomFactor: null = auto-fit to the available width. A number is a
  // manual multiplier on the fitted width (1 = fit, >1 = zoomed in).
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: string; deltaDays: number } | null>(null);
  const [layout, setLayout] = useState<"timeline" | "calendar" | "report" | "shift">("timeline");
  const [detailId, setDetailId] = useState<string | null>(null);
  // Keyboard navigation: the currently keyboard-focused timeline row.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Critical-path-lite highlight toggle.
  const [showCritical, setShowCritical] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The timeline mounts later than this view when another tab opens first
  // (calendar, report), so it's measured whenever its box appears.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const bindScroll = useCallback((el: HTMLDivElement | null) => { scrollRef.current = el; setScrollEl(el); }, []);
  const didCenter = useRef(false);

  // Undo/feedback — the safety net so a new user can act fearlessly.
  const { toasts, announce, notify, dismiss, runUndo } = useUndoableActions();

  // Measure the timeline viewport so the day width can fill it edge to
  // edge instead of a hardcoded guess. Re-measures on resize.
  const [viewportW, setViewportW] = useState(0);
  // The frozen task column gives way on a phone so the chart stays usable.
  const compact = viewportW > 0 && viewportW < 640;
  // The task column's width: dragged wider or narrower, remembered here.
  const [userLeftW, setUserLeftW] = useState(LEFT_W);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("timeline:leftW"));
      if (v >= MIN_LEFT_W && v <= MAX_LEFT_W) setUserLeftW(v);
    } catch { /* private mode */ }
  }, []);
  const leftW = compact ? 168 : userLeftW;
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = userLeftW;
    let w = w0;
    const move = (ev: PointerEvent) => { w = Math.max(MIN_LEFT_W, Math.min(MAX_LEFT_W, w0 + ev.clientX - x0)); setUserLeftW(w); };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      try { localStorage.setItem("timeline:leftW", String(Math.round(w))); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const [showCards, setShowCards] = useState(false);
  useEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollEl]);

  // Overlay optimistic status + percent onto the raw list.
  const items = useMemo(() => {
    if (optimistic.size === 0 && optimisticPct.size === 0) return milestones;
    return milestones.map((m) => {
      if (!m.id) return m;
      const st = optimistic.get(m.id);
      const pc = optimisticPct.get(m.id);
      if (st === undefined && pc === undefined) return m;
      return {
        ...m,
        ...(st !== undefined ? { status: st } : {}),
        ...(pc !== undefined ? { percentComplete: pc } : {}),
      };
    });
  }, [milestones, optimistic, optimisticPct]);

  // Drop optimistic entries once the server agrees.
  useEffect(() => {
    if (optimistic.size === 0 && optimisticPct.size === 0) return;
    setOptimistic((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const m of milestones) if (m.id && next.get(m.id) === m.status) next.delete(m.id);
      return next;
    });
    setOptimisticPct((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const m of milestones) {
        if (!m.id || !next.has(m.id)) continue;
        const serverPct = m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0);
        if (serverPct === next.get(m.id)) next.delete(m.id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestones]);

  const byId = useMemo(() => {
    const m = new Map<string, Milestone>();
    for (const x of items) if (x.id) m.set(x.id, x);
    return m;
  }, [items]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, Milestone[]>();
    for (const x of items) {
      const pid = x.parentId && byId.has(x.parentId) ? x.parentId : null;
      if (!pid) continue;
      const arr = m.get(pid) ?? [];
      arr.push(x);
      m.set(pid, arr);
    }
    return m;
  }, [items, byId]);

  // Siblings in the order the work happens: a parent by the earliest step
  // under it (its stored date can disagree), then WBS, then name.
  const effSpan = useMemo(() => effectiveSpans(items), [items]);
  const effStart = useMemo(() => new Map([...effSpan].map(([k, v]) => [k, v.start])), [effSpan]);
  const cmp = useMemo(() => byStart(effStart, wbsCompare), [effStart]);
  const spanOf = useCallback((m: Milestone) => (m.id ? effSpan.get(m.id) : undefined) ?? { start: startMs(m), finish: finishMs(m) }, [effSpan]);

  // The project's shift-change times (set on the shift report, the same on
  // every device) — the timeline marks day and night shifts with them.
  const shiftTimes = useShiftTimes(projectId);

  // ── Search / filter ──────────────────────────────────────────
  const [filter, setFilter] = useState<ScheduleFilter>(EMPTY_FILTER);
  // Typing stays instant on a 600-task board: the rows follow a moment later.
  const appliedFilter = useDeferredValue(filter);
  const filterOn = isFilterActive(appliedFilter);
  const visibleIds = useMemo(
    () => filterMilestones(items, appliedFilter, {
      // Night = the ☾ work, overdue = the same rule as every count.
      shiftOf: (m) => workShiftOf(m, tz, shiftTimes),
      isOverdue: (m, now) => isOverdue(m, now, tz),
    }),
    [items, appliedFilter, tz, shiftTimes],
  );
  // The milestones each sub-view should render (full list when the
  // filter is off, so nothing changes for the common case).
  const visibleItems = useMemo(
    () => (filterOn ? items.filter((m) => m.id && visibleIds.has(m.id)) : items),
    [items, filterOn, visibleIds],
  );
  // Top-level groups for the filter bar chips.
  const topGroups = useMemo(() => {
    const seen = new Map<string, Milestone>();
    for (const m of items) {
      if (m.parentId && byId.has(m.parentId)) continue; // not top-level
      if (m.id) seen.set(m.id, m);
    }
    return Array.from(seen.values()).sort(cmp);
  }, [items, byId, cmp]);
  // Match count = leaf tasks that survive the filter.
  const matchStats = useMemo(() => {
    const isLeaf = (m: Milestone) => !m.id || (childrenOf.get(m.id) ?? []).length === 0;
    const leaves = items.filter(isLeaf);
    const shown = leaves.filter((m) => m.id && visibleIds.has(m.id)).length;
    return { shown, total: leaves.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, visibleIds]);

  // The critical path as the project has it: its source (the file's flags,
  // the app's estimate, or none) with every hand mark on top.
  const criticalMode = useCriticalMode(projectId);
  const critical = useMemo(() => resolveCriticalPath(items, criticalMode), [items, criticalMode]);
  // A task with any critical step under it reads as critical too.
  const criticalAny = useMemo(() => {
    const out = new Set<string>();
    for (const id of critical.ids) {
      for (let t = byId.get(id); t?.id && !out.has(t.id); t = t.parentId ? byId.get(t.parentId) : undefined) out.add(t.id);
    }
    return out;
  }, [critical, byId]);
  const criticalSourceLabel = CRITICAL_MODES.find((x) => x.value === critical.mode)?.label ?? "";
  // Mark a task critical or not — an overall task takes every step under it
  // along (their own marks are cleared). Undo puts every mark back.
  const markCritical = useCallback(async (ms: Milestone, v: CriticalOverride | null) => {
    if (!canEdit || !ms.id) return;
    const below: Milestone[] = [];
    const walk = (id: string) => { for (const c of childrenOf.get(id) ?? []) { below.push(c); if (c.id) walk(c.id); } };
    walk(ms.id);
    const touched = [ms, ...below.filter((t) => t.criticalOverride)];
    const changes = touched.map((t) => ({ id: t.id!, after: t.id === ms.id ? v : null }));
    try {
      await applyBulkFieldChange({ orgId, projectId, field: "criticalOverride", changes, summary: { mode: "set", to: v }, actorUserId: userId, actorUserEmail: userEmail });
      onRefresh();
      announce(`“${truncate(ms.name)}” → ${v === "yes" ? "critical" : v === "no" ? "not critical" : "critical: auto"}${below.length ? " (and everything under it)" : ""}`, async () => {
        await applyBulkFieldChange({ orgId, projectId, field: "criticalOverride", changes: touched.map((t) => ({ id: t.id!, after: t.criticalOverride ?? null })), summary: { mode: "set", to: "undo" }, actorUserId: userId, actorUserEmail: userEmail });
        onRefresh();
      }, "default");
    } catch (e) {
      notify(/critical_override/.test((e as Error).message) ? "Run migration 20261101_critical_path_control.sql first." : `Not saved: ${(e as Error).message}`, "warning");
    }
  }, [canEdit, childrenOf, orgId, projectId, userId, userEmail, onRefresh, announce, notify]);
  const handMarked = useMemo(() => items.filter((t) => t.criticalOverride), [items]);
  const clearMarks = useCallback(async () => {
    if (!handMarked.length) return;
    const before = handMarked.map((t) => ({ id: t.id!, after: t.criticalOverride ?? null }));
    try {
      await applyBulkFieldChange({ orgId, projectId, field: "criticalOverride", changes: before.map((c) => ({ id: c.id, after: null })), summary: { mode: "set", to: null }, actorUserId: userId, actorUserEmail: userEmail });
      onRefresh();
      announce(`Cleared ${before.length} critical-path mark${before.length === 1 ? "" : "s"}`, async () => {
        await applyBulkFieldChange({ orgId, projectId, field: "criticalOverride", changes: before, summary: { mode: "set", to: "undo" }, actorUserId: userId, actorUserEmail: userEmail });
        onRefresh();
      }, "default");
    } catch (e) { notify(`Not saved: ${(e as Error).message}`, "warning"); }
  }, [handMarked, orgId, projectId, userId, userEmail, onRefresh, announce, notify]);
  const setCriticalSource = useCallback(async (mode: CriticalMode) => {
    try { await saveCriticalMode(projectId, mode); } catch (e) { notify((e as Error).message, "warning"); }
  }, [projectId, notify]);

  // Group color assignment — a phase + all its children share one hue.
  const colors = useMemo(() => assignGroupColors(items), [items]);

  // Shown when a non-member taps a disabled status dot.
  const notifyViewOnly = useCallback(() => {
    notify("You're not a member of this project — ask the project owner to add you to update status or reschedule.", "warning");
  }, [notify]);

  // Build the forest. Roots = rows whose parent is missing/absent.
  // Siblings sort by execution time (start), then WBS, then name.
  // Search and filters narrow the timeline too (a match keeps its parents,
  // so it stays in context).
  const roots = useMemo(() => {
    const shown = (m: Milestone) => !filterOn || (!!m.id && visibleIds.has(m.id));
    const build = (ms: Milestone, depth: number): TreeNode => {
      const kids = (childrenOf.get(ms.id!) ?? []).filter(shown).sort(cmp);
      return { ms, depth, children: kids.map((k) => build(k, depth + 1)) };
    };
    const top = items.filter((x) => (!x.parentId || !byId.has(x.parentId)) && shown(x)).sort(cmp);
    return top.map((m) => build(m, 0));
  }, [items, childrenOf, byId, cmp, filterOn, visibleIds]);

  // One pass over the whole tree: each task's effective % + status. Leaves
  // report their own (status-reconciled) percent; summaries roll their leaf
  // descendants up, duration-weighted (see lib/scheduleProgress.ts).
  const progressIndex = useMemo(() => buildProgressIndex(items, tz), [items, tz]);

  // Only the rows near the screen are drawn on a big schedule (600 tasks
  // drawn in full was ~30,000 page elements and a 2-second stall per key).
  const [view, setView] = useState({ top: 0, height: 900 });
  const onScrollWindow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop, height = el.clientHeight || 900;
    setView((v) => (Math.abs(v.top - top) < ROW_H * 5 && v.height === height ? v : { top, height }));
  }, []);

  // Flatten to the rows actually visible given collapse state.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const hasChildren = n.children.length > 0;
        const info = n.ms.id ? progressIndex.get(n.ms.id) : undefined;
        out.push({
          ms: n.ms,
          depth: n.depth,
          hasChildren,
          done: info?.leafDone ?? (n.ms.status === "completed" ? 1 : 0),
          total: info?.leafTotal ?? 1,
          pct: info?.percent ?? 0,
          derivedStatus: info?.status ?? n.ms.status,
        });
        // While searching, matches show even under a collapsed phase.
        if (hasChildren && n.ms.id && (filterOn || !collapsed.has(n.ms.id))) walk(n.children);
      }
    };
    walk(roots);
    return out;
  }, [roots, collapsed, progressIndex, filterOn]);
  // Small schedules draw every row (printing, find-in-page); big ones a
  // window around the screen, with room above and below for fast scrolling.
  const win = useMemo(() => {
    if (rows.length <= 150) return { first: 0, last: rows.length };
    const first = Math.max(0, Math.floor((view.top - AXIS_H) / ROW_H) - 30);
    const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_H) + 30);
    return { first, last };
  }, [rows.length, view]);

  // Date domain across the whole schedule.
  const domain = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const m of items) {
      const s = startMs(m), f = finishMs(m);
      if (Number.isFinite(s)) min = Math.min(min, s);
      if (Number.isFinite(f)) max = Math.max(max, f);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const start = addDaysUTC(startOfDayUTC(new Date(min), tz), -PAD_DAYS, tz);
    const end = addDaysUTC(startOfDayUTC(new Date(max), tz), PAD_DAYS, tz);
    const totalDays = Math.max(1, dayDiff(start, end, tz) + 1);
    return { start, end, totalDays };
  }, [items, tz]);

  // The px/day that exactly fills the available timeline width with the
  // whole schedule (clamped so days never get unreadably narrow). This
  // is the "fit to screen" baseline.
  const fitPxPerDay = useMemo(() => {
    if (!domain) return MIN_PX_PER_DAY;
    const avail = Math.max(320, viewportW - leftW);
    return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, avail / domain.totalDays));
  }, [domain, viewportW, leftW]);

  // Final day width: auto-fit by default, or the user's manual zoom
  // factor applied on top of the fitted baseline.
  const pxPerDay = useMemo(() => {
    const base = zoomFactor == null ? fitPxPerDay : fitPxPerDay * zoomFactor;
    return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, base));
  }, [zoomFactor, fitPxPerDay]);

  const timelineW = domain ? domain.totalDays * pxPerDay : 0;
  // The clock, ticking each minute: the now-line moves and "today" rolls
  // over at midnight for a night crew with the board open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const todayKey = dayKey(nowMs, tz);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- "today" changes when the plant day does, not every minute
  const today = useMemo(() => startOfDayUTC(new Date(nowMs), tz), [tz, todayKey]);
  const nowDate = useMemo(() => new Date(nowMs), [nowMs]);
  // Each task's planned % by now over the whole schedule (not a filtered view).
  const planNowAll = useMemo(() => expectedByParent(items, nowMs, tz, shiftTimes), [items, nowMs, tz, shiftTimes]);
  // The red line is NOW, at its clock time — not the middle of today.
  const todayX = domain ? xAt(nowMs, domain.start.getTime(), pxPerDay, tz) : -1;

  // Center the viewport on "today" (or schedule start) on first paint.
  useEffect(() => {
    if (didCenter.current || !scrollRef.current || !domain) return;
    const el = scrollRef.current;
    const inSpan = today >= domain.start && today <= domain.end;
    const target = inSpan ? todayX : 0;
    el.scrollLeft = Math.max(0, target - (el.clientWidth - leftW) / 2);
    didCenter.current = true;
  }, [domain, today, todayX, leftW]);

  // ── Mutations ────────────────────────────────────────────────
  // One cheap guard against the wrong-day mis-click: recording progress on
  // a step planned more than a day out asks first. The system never moves
  // the step — if the crew really pulled it forward, it lands as "started
  // early" on today and keeps its planned slot.
  // Before the schedule's first step starts, every click is a rehearsal
  // (nothing can be "early" yet), so the guard stays quiet until go-live.
  const scheduleStartMs = useMemo(() => {
    let min = Infinity;
    for (const m of items) { const s = plannedStartMsOf(m); if (Number.isFinite(s)) min = Math.min(min, s); }
    return min;
  }, [items]);
  const confirmFuture = useCallback(async (prev: Milestone | undefined, nextStatus: MilestoneStatus | null, nextPct: number | null) => {
    if (!prev) return true;
    const ps = plannedStartMsOf(prev);
    if (Date.now() < scheduleStartMs) return true;
    if (!needsFutureConfirm(ps, Date.now(), nextStatus, nextPct)) return true;
    const days = Math.max(1, dayDiffTz(Date.now(), ps, tz));
    const what = nextStatus === "completed" || nextPct === 100 ? "done" : nextStatus === "in_progress" || (nextPct != null && nextPct > 0) ? "started" : "changed";
    return appConfirm({
      title: `Record it ${what} ${days} day${days === 1 ? "" : "s"} early?`,
      message: `“${prev.name}” is planned for ${fmtInTz(ps, tz, { weekday: "short", month: "short", day: "numeric" })}. It will stay on that day in the plan and show on today as ahead of plan. If you clicked the wrong row, cancel.`,
      confirmLabel: `Yes, it is ${what}`,
    });
  }, [tz, scheduleStartMs]);

  // Undo puts a task back exactly as it was: status, %, hold reason and
  // actual times — "40% → done → undo" is 40% again, a hold stays a hold.
  const restore = useCallback(async (states: MilestoneState[]) => {
    if (!onRestore || states.length === 0) return;
    setOptimistic((m) => { const n = new Map(m); for (const st of states) n.set(st.id, st.status); return n; });
    setOptimisticPct((m) => { const n = new Map(m); for (const st of states) n.set(st.id, Math.round(st.percentComplete)); return n; });
    const ok = await onRestore(states);
    if (!ok) {
      setOptimistic((m) => { const n = new Map(m); for (const st of states) n.delete(st.id); return n; });
      setOptimisticPct((m) => { const n = new Map(m); for (const st of states) n.delete(st.id); return n; });
    }
  }, [onRestore]);

  const setStatus = useCallback(async (id: string, next: MilestoneStatus, reason?: string, percent?: number): Promise<boolean> => {
    if (!canEdit || !onSetStatus) return false;
    const prev = byId.get(id);                       // snapshot for undo
    const before = prev?.id ? stateOf(prev) : null;
    const name = prev?.name ?? "Task";
    if (!(await confirmFuture(prev, next, percent ?? null))) return false;
    setOptimistic((m) => new Map(m).set(id, next));
    const nextPct = next === "completed" ? 100 : next === "planned" ? 0 : percent;
    if (nextPct != null) setOptimisticPct((m) => new Map(m).set(id, Math.round(nextPct)));
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetStatus(id, next, reason, percent);
      if (!ok) {
        setOptimistic((m) => { const n = new Map(m); n.delete(id); return n; });
        setOptimisticPct((m) => { const n = new Map(m); n.delete(id); return n; });
        return false;
      }
      if (before && (before.status !== next || (percent != null && Math.round(before.percentComplete) !== Math.round(percent)))) {
        announce(
          `“${truncate(name)}” → ${statusWord(next)}${next === "in_progress" && percent != null ? ` ${Math.round(percent)}%` : ""}`,
          () => restore([before]),
          next === "completed" ? "success" : "default",
        );
      }
      return true;
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus, byId, announce, confirmFuture, restore]);

  // Set a leaf task's physical % complete. Optimistically updates BOTH the
  // percent and the derived status (so the fill bar and the status dot move
  // together), then persists. Summary rows never call this — their % rolls up.
  const setProgress = useCallback(async (id: string, pct: number): Promise<boolean> => {
    if (!canEdit || !onSetProgress) return false;
    const prev = byId.get(id);
    const before = prev?.id ? stateOf(prev) : null;
    const prevStatus = prev?.status;
    const prevPct = prev?.percentComplete != null ? Math.round(prev.percentComplete) : (prevStatus === "completed" ? 100 : 0);
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const isException = prevStatus === "blocked" || prevStatus === "on_hold" || prevStatus === "missed";
    const nextStatus: MilestoneStatus = clamped >= 100
      ? "completed"
      : clamped <= 0
        ? (isException ? prevStatus! : "planned")
        : (isException ? prevStatus! : "in_progress");
    if (clamped > prevPct && !(await confirmFuture(prev, null, clamped))) return false;
    setOptimisticPct((m) => new Map(m).set(id, clamped));
    setOptimistic((m) => new Map(m).set(id, nextStatus));
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetProgress(id, clamped);
      if (!ok) {
        setOptimisticPct((m) => { const n = new Map(m); n.delete(id); return n; });
        setOptimistic((m) => { const n = new Map(m); n.delete(id); return n; });
        return false;
      }
      if (prevPct !== clamped && before) {
        announce(`“${truncate(prev?.name ?? "Task")}” → ${clamped}%`, () => restore([before]), clamped >= 100 ? "success" : "default");
      }
      return true;
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetProgress, byId, announce, confirmFuture, restore]);

  // Progress always comes with what got done (the line the next crew and
  // the shift report read): the % (or "started") saves first, then the
  // comment — nothing is written if the % was cancelled.
  const addNote = useCallback(async (id: string, body: string) => {
    const m = byId.get(id);
    await addMilestoneNote({ orgId, milestoneId: id, kind: "note", statusAt: m?.status ?? null, body, createdBy: userId, createdByName: userName });
  }, [byId, orgId, userId, userName]);
  const progressWithNote = useCallback(async (id: string, pct: number, note: string): Promise<boolean> => {
    const ok = await setProgress(id, pct);
    if (ok && note) await addNote(id, note);
    return ok;
  }, [setProgress, addNote]);
  const startWithNote = useCallback(async (id: string, pct: number, note: string): Promise<boolean> => {
    const ok = pct >= 100 ? await setStatus(id, "completed") : await setStatus(id, "in_progress", undefined, pct);
    if (ok && note) await addNote(id, note);
    return ok;
  }, [setStatus, addNote]);

  // Delete the selection — with everything under a selected phase when the
  // person says so — and offer Undo, which brings back the tasks, their
  // comments and their place in the outline.
  const bulkDelete = useCallback(async () => {
    if (!canEdit || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const withKids = ids.some((id) => (childrenOf.get(id) ?? []).length > 0);
    const n = ids.length;
    const ok = await appConfirm({
      title: `Delete ${n} task${n === 1 ? "" : "s"}?`,
      message: withKids
        ? "Some of these have steps under them — those are deleted too, with their comments. Undo right after brings everything back."
        : "Their comments go with them. Undo right after brings them back.",
      tone: "danger", confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      const removed = await deleteMilestones({ orgId, projectId, ids, withChildren: true, actorUserId: userId, actorUserEmail: userEmail });
      setSelectedIds(new Set());
      onRefresh();
      if (removed.notDeleted) notify(`${removed.notDeleted} task${removed.notDeleted === 1 ? " wasn't" : "s weren't"} deleted — you may not have permission for ${removed.notDeleted === 1 ? "it" : "them"}.`, "warning");
      announce(`Deleted ${removed.rows.length} task${removed.rows.length === 1 ? "" : "s"}`, async () => {
        try { await restoreDeletedMilestones(removed); } catch (e) { notify(`Undo failed: ${(e as Error).message}`, "warning"); }
        onRefresh();
      });
    } catch (e) { notify((e as Error).message, "warning"); onRefresh(); }
  }, [canEdit, selectedIds, childrenOf, orgId, projectId, userId, userEmail, onRefresh, announce, notify]);

  // Bulk status across the selection (with one undo that restores each
  // task's prior status).
  // Bulk status for an explicit id set (used by both the timeline
  // selection and the calendar selection), with one undo.
  const bulkStatusIds = useCallback(async (ids: string[], next: MilestoneStatus) => {
    if (!canEdit || !onSetStatus || ids.length === 0) return;
    const prev = new Map<string, MilestoneStatus>();
    const before = new Map<string, MilestoneState>();
    for (const id of ids) { const m = byId.get(id); if (m) { prev.set(id, m.status); before.set(id, stateOf(m)); } }
    setOptimistic((m) => { const n = new Map(m); for (const id of ids) n.set(id, next); return n; });
    setBusy((s) => { const n = new Set(s); for (const id of ids) n.add(id); return n; });
    try {
      // Await each result individually so a partial failure can't masquerade
      // as success (the old Promise.all announced "Undo N" even if some writes
      // failed, and never rolled back the optimistic state for the failures).
      const results = await Promise.all(ids.map(async (id) => {
        try { return { id, ok: await onSetStatus(id, next) }; }
        catch { return { id, ok: false }; }
      }));
      const succeeded = results.filter((r) => r.ok).map((r) => r.id);
      const failed = results.filter((r) => !r.ok).map((r) => r.id);

      if (failed.length > 0) {
        // Roll back the optimistic state for tasks that did NOT persist.
        setOptimistic((m) => {
          const n = new Map(m);
          for (const id of failed) { const st = prev.get(id); if (st) n.set(id, st); else n.delete(id); }
          return n;
        });
        notify(`${failed.length} of ${ids.length} task${ids.length === 1 ? "" : "s"} couldn't be updated.`, "warning");
      }

      if (succeeded.length > 0) {
        // Only offer to undo what actually changed.
        announce(`${succeeded.length} task${succeeded.length === 1 ? "" : "s"} → ${statusWord(next)}`,
          () => restore(succeeded.map((id) => before.get(id)).filter((x): x is MilestoneState => !!x)),
          next === "completed" ? "success" : "default");
      }
      setSelectedIds(new Set());
    } finally {
      setBusy((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus, byId, announce, notify, restore]);

  // Bulk move for an explicit id set → open the confirmation sheet.
  const bulkMoveIds = useCallback((ids: string[], deltaDays: number) => {
    if (ids.length === 0 || deltaDays === 0) return;
    setPendingMove({ ids, deltaDays });
  }, []);

  // Timeline-selection convenience wrappers.
  const bulkStatus = useCallback((next: MilestoneStatus) => bulkStatusIds(Array.from(selectedIds), next), [bulkStatusIds, selectedIds]);
  const bulkMove = useCallback((deltaDays: number) => bulkMoveIds(Array.from(selectedIds), deltaDays), [bulkMoveIds, selectedIds]);

  // Flat node list the reflow engine operates on.
  const reflowNodes = useMemo<ReflowNode[]>(() => items.map((m) => ({
    id: m.id!,
    parentId: m.parentId ?? null,
    plannedStartAt: (m.plannedStartAt as string | undefined) ?? null,
    plannedAt: m.plannedAt as string,
    status: m.status,
    dependsOn: m.dependsOn ?? null,
    links: m.linkTypes ?? null,
  })), [items]);

  // After any edit, push dependents forward (finish-to-start) so the schedule
  // honors explicit task dependencies. Merges the cascade into the primary
  // changes (cascade wins on overlap) so it persists + undoes as one set.
  const withCascade = useCallback((primary: DateChange[]): DateChange[] => {
    if (primary.length === 0) return primary;
    const map = new Map(primary.map((c) => [c.id, c]));
    const updated: ReflowNode[] = reflowNodes.map((n) => {
      const c = map.get(n.id);
      return c ? { ...n, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : n;
    });
    const cascade = cascadeDependents(updated, primary.map((c) => c.id), tz);
    if (cascade.length === 0) return primary;
    const merged = new Map(primary.map((c) => [c.id, c]));
    for (const c of cascade) merged.set(c.id, c);
    return Array.from(merged.values());
  }, [reflowNodes, tz]);

  // A move requested by the UI, awaiting confirmation. Carries the
  // target ids (one, or the multi-selection) and the day delta.
  const [pendingMove, setPendingMove] = useState<{ ids: string[]; deltaDays: number } | null>(null);

  // Open the confirmation instead of applying immediately. If a
  // multi-selection is active and the moved task is part of it, the
  // move applies to the whole selection.
  const requestMove = useCallback((id: string, deltaDays: number) => {
    if (!canEdit || !onMoveMany || deltaDays === 0 || !id) return;
    const ids = selectedIds.has(id) && selectedIds.size > 1 ? Array.from(selectedIds) : [id];
    setPendingMove({ ids, deltaDays });
  }, [canEdit, onMoveMany, selectedIds]);

  // Apply a confirmed move (mode chosen in the sheet) to every target.
  const commitMove = useCallback(async (mode: "defer" | "extend") => {
    const pm = pendingMove;
    setPendingMove(null);
    if (!pm || !onMoveMany) return;
    const primary: DateChange[] = [];
    const seen = new Set<string>();
    for (const id of pm.ids) {
      for (const c of computeTreeMove(reflowNodes, id, pm.deltaDays, mode, tz)) {
        if (seen.has(c.id)) continue; // later writers win on overlap; first is fine
        seen.add(c.id);
        primary.push(c);
      }
    }
    const all = withCascade(primary); // push dependents to honor FS links
    if (all.length === 0) return;
    // Snapshot each affected row's current dates so Undo can restore.
    const before: DateChange[] = [];
    for (const c of all) {
      const m = byId.get(c.id);
      if (!m) continue;
      before.push({
        id: c.id,
        plannedStartAt: (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string),
        plannedAt: m.plannedAt as string,
      });
    }
    setBusy((s) => { const n = new Set(s); for (const c of all) n.add(c.id); return n; });
    try {
      const ok = await onMoveMany(all);
      if (ok) {
        const n = pm.ids.length;
        const word = mode === "extend" ? "Extended" : "Moved";
        const what = n > 1 ? `${n} tasks` : `“${truncate(byId.get(pm.ids[0])?.name ?? "task")}”`;
        announce(`${word} ${what}`, async () => { await onMoveMany(before); }, "default");
      }
    }
    finally { setBusy((s) => { const n = new Set(s); for (const c of all) n.delete(c.id); return n; }); }
  }, [pendingMove, onMoveMany, reflowNodes, byId, announce, withCascade, tz]);

  // Move a node by N days. The engine shifts the node + its descendants
  // and bleeds every ancestor's span to envelope its children; we
  // persist the whole batch in one shot.
  // All move requests funnel through the confirmation sheet.
  const moveByDays = useCallback((ms: Milestone, deltaDays: number) => {
    if (ms.id) requestMove(ms.id, deltaDays);
  }, [requestMove]);

  // Edge-resize commits directly (it's an unambiguous duration change),
  // with an undo that restores the affected rows' prior dates.
  const resizeEdge = useCallback(async (id: string, edge: "start" | "finish", deltaDays: number) => {
    if (!canEdit || !onMoveMany || deltaDays === 0) return;
    const changes = withCascade(computeEdgeResize(reflowNodes, id, edge, deltaDays, tz));
    if (changes.length === 0) return;
    const before: DateChange[] = [];
    for (const c of changes) {
      const m = byId.get(c.id); if (!m) continue;
      before.push({ id: c.id, plannedStartAt: (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string), plannedAt: m.plannedAt as string });
    }
    setBusy((s) => { const n = new Set(s); for (const c of changes) n.add(c.id); return n; });
    try {
      const ok = await onMoveMany(changes);
      if (ok) announce(`Resized “${truncate(byId.get(id)?.name ?? "task")}”`, async () => { await onMoveMany(before); }, "default");
    } finally {
      setBusy((s) => { const n = new Set(s); for (const c of changes) n.delete(c.id); return n; });
    }
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, withCascade, tz]);

  // Resize a SUMMARY/parent edge → proportionally stretch its subtree
  // ("extend the overall project"). Same commit+undo shape as resizeEdge.
  const resizeSummaryEdge = useCallback(async (id: string, edge: "start" | "finish", deltaDays: number) => {
    if (!canEdit || !onMoveMany || deltaDays === 0) return;
    const changes = withCascade(computeSummaryResize(reflowNodes, id, edge, deltaDays, tz));
    if (changes.length === 0) return;
    const before: DateChange[] = [];
    for (const c of changes) {
      const m = byId.get(c.id); if (!m) continue;
      before.push({ id: c.id, plannedStartAt: (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string), plannedAt: m.plannedAt as string });
    }
    setBusy((s) => { const n = new Set(s); for (const c of changes) n.add(c.id); return n; });
    try {
      const ok = await onMoveMany(changes);
      if (ok) announce(`Stretched “${truncate(byId.get(id)?.name ?? "phase")}” · ${changes.length} task${changes.length === 1 ? "" : "s"} rescaled`, async () => { await onMoveMany(before); }, "default");
    } finally {
      setBusy((s) => { const n = new Set(s); for (const c of changes) n.delete(c.id); return n; });
    }
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, withCascade, tz]);

  // Chain a phase's direct children finish-to-start (sequential steps), with
  // one undo. The pure layout is in sequenceSiblings.
  const sequencePhase = useCallback(async (parentId: string) => {
    if (!canEdit || !onMoveMany) return;
    const changes = withCascade(sequenceSiblings(reflowNodes, parentId, tz));
    if (changes.length === 0) { notify("These tasks are already in sequence.", "default"); return; }
    const before: DateChange[] = [];
    for (const c of changes) {
      const m = byId.get(c.id); if (!m) continue;
      before.push({ id: c.id, plannedStartAt: (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string), plannedAt: m.plannedAt as string });
    }
    setBusy((s) => { const n = new Set(s); for (const c of changes) n.add(c.id); return n; });
    try {
      const ok = await onMoveMany(changes);
      if (ok) announce(`Sequenced “${truncate(byId.get(parentId)?.name ?? "phase")}” end-to-end`, async () => { await onMoveMany(before); }, "default");
    } finally {
      setBusy((s) => { const n = new Set(s); for (const c of changes) n.delete(c.id); return n; });
    }
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, notify, withCascade, tz]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const collapseAll = useCallback(() => {
    setCollapsed(new Set(items.filter((m) => (childrenOf.get(m.id!) ?? []).length > 0).map((m) => m.id!)));
  }, [items, childrenOf]);
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  // ── Keyboard navigation (power-user speed) ───────────────────
  // ↑/↓ move focus · ←/→ nudge the focused task a day · Enter/Space
  // open detail · X select/deselect · [ ] collapse/expand a parent.
  const onTimelineKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (rows.length === 0) return;
    const idx = Math.max(0, rows.findIndex((r) => r.ms.id === focusedId));
    const cur = rows[idx]?.ms;
    const move = (delta: number) => {
      const next = rows[Math.min(rows.length - 1, Math.max(0, idx + delta))];
      if (next?.ms.id) {
        setFocusedId(next.ms.id);
        const el = document.getElementById(`exec-row-${next.ms.id}`);
        if (el) el.scrollIntoView({ block: "nearest" });
        else if (scrollRef.current) scrollRef.current.scrollTop = AXIS_H + rows.indexOf(next) * ROW_H - scrollRef.current.clientHeight / 2;
      }
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(focusedId == null ? 0 : 1); break;
      case "ArrowUp": e.preventDefault(); move(-1); break;
      case "ArrowRight": if (cur && !cur.isSummary) { e.preventDefault(); requestMove(cur.id!, 1); } break;
      case "ArrowLeft": if (cur && !cur.isSummary) { e.preventDefault(); requestMove(cur.id!, -1); } break;
      case "Enter": case " ": if (cur?.id) { e.preventDefault(); setDetailId(cur.id); } break;
      case "x": case "X": if (cur?.id && canEdit) { e.preventDefault(); toggleSelected(cur.id); } break;
      case "[": if (cur?.id) { e.preventDefault(); setCollapsed((s) => new Set(s).add(cur.id!)); } break;
      case "]": if (cur?.id) { e.preventDefault(); setCollapsed((s) => { const n = new Set(s); n.delete(cur.id!); return n; }); } break;
      case "Escape": setFocusedId(null); break;
    }
  }, [rows, focusedId, requestMove, canEdit, toggleSelected]);

  // ── Drag a bar to reschedule ─────────────────────────────────
  const dragState = useRef<{ id: string; ms: Milestone; startX: number } | null>(null);
  const onBarPointerDown = useCallback((e: React.PointerEvent, ms: Milestone) => {
    // Completed work is an actual — it doesn't move. Reopen it to reschedule.
    if (!canEdit || !onMoveMany || !ms.id || ms.isSummary || ms.status === "completed") return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { id: ms.id, ms, startX: e.clientX };
    setDrag({ id: ms.id, deltaDays: 0 });
  }, [canEdit, onMoveMany]);
  const onBarPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragState.current;
    if (!d) return;
    const deltaDays = Math.round((e.clientX - d.startX) / pxPerDay);
    setDrag((prev) => (prev && prev.deltaDays === deltaDays ? prev : { id: d.id, deltaDays }));
  }, [pxPerDay]);
  const onBarPointerUp = useCallback((e: React.PointerEvent) => {
    const d = dragState.current;
    dragState.current = null;
    if (!d) return;
    const deltaDays = Math.round((e.clientX - d.startX) / pxPerDay);
    setDrag(null);
    if (deltaDays !== 0) void moveByDays(d.ms, deltaDays);
    else if (d.ms.id) setDetailId(d.ms.id); // a click (no drag) opens detail
  }, [pxPerDay, moveByDays]);

  // Esc abandons an in-flight drag without committing anything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragState.current) {
        dragState.current = null;
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const summaries = useMemo(() => items.filter((m) => m.isSummary && (childrenOf.get(m.id!) ?? []).length > 0), [items, childrenOf]);

  // Ancestry chain for the detail panel breadcrumb (nearest parent first).
  const ancestorsOf = useCallback((m: Milestone): Milestone[] => {
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

  if (!domain) {
    return (
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-12 text-center">
        <CalendarDays className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <div className="text-sm font-semibold text-[var(--color-text)]">No dated tasks yet</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-1">Import a schedule or add a milestone to populate the execution board.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ExecutionGuide />

      {/* Non-member feedback: the status dots and bars still render (they
          signal state), but edits are disabled — say why so it doesn't feel
          broken. */}
      {!canEdit && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
          <Eye className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            <b>View only.</b> You&apos;re not a member of this project, so status and dates are read-only.
            Ask the project owner to add you as a member to make changes.
          </span>
        </div>
      )}

      {/* On a phone the summary folds to one line so the board is on screen. */}
      {compact && !showCards ? (
        <CompactSummary items={items} now={nowDate} shiftTimes={shiftTimes} onOpen={() => setShowCards(true)} />
      ) : (
        <>
          <SchedulePulse
            milestones={items}
            shiftTimes={shiftTimes}
            onShowOverdue={() => { setLayout("timeline"); setFilter((f) => ({ ...EMPTY_FILTER, overdueOnly: true, query: f.query })); }}
            onShowBlocked={() => { setLayout("timeline"); setFilter((f) => ({ ...EMPTY_FILTER, blockedOnly: true, query: f.query })); }}
          />

          <div className="flex items-center gap-2">
            <SummaryStrip items={items} now={nowDate} shiftTimes={shiftTimes} />
          </div>
          {compact && <button onClick={() => setShowCards(false)} className="text-[11px] font-bold text-[var(--color-text-muted)]">Fold the summary</button>}
        </>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-lg p-0.5 gap-0.5">
          {([["timeline", "Timeline"], ["calendar", "Calendar"], ["shift", "Shift report"], ["report", "Report"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setLayout(id)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${layout === id ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {layout === "timeline" && (
          <button
            onClick={() => setShowCritical((v) => !v)}
            aria-pressed={showCritical}
            title="Show the critical path — and mark tasks on or off it"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${showCritical ? "bg-rose-600 text-white border-rose-600" : "bg-[var(--color-surface)] text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 hover:border-rose-400"}`}
          >
            <Zap className="w-3.5 h-3.5" /> Critical path <span className="font-mono opacity-80">{critical.ids.size}</span>
          </button>
        )}
        {layout === "timeline" && showCritical && (
          <div className="inline-flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
            <label className="inline-flex items-center gap-1">
              From
              <select value={critical.mode} disabled={!canEdit} onChange={(e) => void setCriticalSource(e.target.value as CriticalMode)}
                title={CRITICAL_MODES.find((x) => x.value === critical.mode)?.hint}
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 py-1 text-[11px] font-semibold text-[var(--color-text)]">
                {CRITICAL_MODES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </label>
            {canEdit && <span>Tap <Zap className="inline w-3 h-3 text-rose-600" /> on a row to mark it on or off</span>}
            {canEdit && handMarked.length > 0 && (
              <button onClick={() => void clearMarks()} className="font-bold text-[var(--color-accent)] hover:underline">
                Clear {handMarked.length} hand mark{handMarked.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
        )}
        {canEdit && (
          <button onClick={() => setBulkMode("replace")}
            title="Swap a contractor, crew, company or location on every task at once"
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <Replace className="w-3.5 h-3.5" /> Change on many
          </button>
        )}
      </div>

      {/* Find anything — applies to Timeline & Calendar. */}
      {layout !== "report" && (
        <ScheduleFilterBar
          filter={filter}
          onChange={setFilter}
          groups={topGroups}
          matchCount={matchStats.shown}
          totalCount={matchStats.total}
        />
      )}

      {/* Group color key — decodes the phase hues. Uses the color anchors
          (which, under a single overarching project, are its first-level
          phases) so the key shows even for a one-root schedule. */}
      {layout !== "report" && colors.groups.length > 1 && (
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-1 text-[11px]">
          <span className="font-black uppercase tracking-widest text-[var(--color-text-faint)]">Phases</span>
          {colors.groups.map((g) => {
            const c = colors.colorOf(g);
            return (
              <span key={g.id} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${c.rail}`} />
                <span className="font-medium text-[var(--color-text-muted)] truncate max-w-[160px]">{g.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {layout === "report" ? (
        <ExecutionReportView milestones={items} shiftTimes={shiftTimes} critical={critical} criticalSource={criticalSourceLabel} />
      ) : layout === "shift" ? (
        <ShiftReportView milestones={items} cancelled={cancelled} userId={userId} userName={userName ?? userEmail} canEdit={canEdit} progress={progressIndex} criticalIds={critical.ids} projectId={projectId} projectName={projectName} />
      ) : layout === "calendar" ? (
        <ScheduleCalendarTileView
          planNow={planNowAll}
          userId={userId}
          milestones={visibleItems}
          childrenByParent={childrenOf}
          canEdit={canEdit}
          onMoveDays={(id, days) => {
            const target = byId.get(id);
            if (target) void moveByDays(target, days);
          }}
          onSetStatus={(id, s, reason, p) => setStatus(id, s, reason, p)}
          onSetProgress={(id, p) => setProgress(id, p)}
          progress={progressIndex}
          onBulkStatus={(ids, s) => void bulkStatusIds(ids, s)}
          onBulkMove={(ids, d) => bulkMoveIds(ids, d)}
          onOpenDetail={(m) => m.id && setDetailId(m.id)}
          detailOpen={detailId != null}
          shiftTimes={shiftTimes}
          onAddNote={addNote}
          onSetProgressNote={progressWithNote}
          onStartNote={startWithNote}
        />
      ) : (
      <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
        <Toolbar
          canEdit={canEdit}
          isAutoFit={zoomFactor == null}
          canZoomIn={pxPerDay < MAX_PX_PER_DAY - 0.5}
          canZoomOut={pxPerDay > MIN_PX_PER_DAY + 0.5}
          onZoomIn={() => setZoomFactor((z) => Math.min(MAX_PX_PER_DAY / fitPxPerDay, (z ?? 1) * ZOOM_STEP))}
          onZoomOut={() => setZoomFactor((z) => (z ?? 1) / ZOOM_STEP)}
          onFit={() => setZoomFactor(null)}
          onToday={() => {
            const el = scrollRef.current; if (!el) return;
            el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - leftW) / 2), behavior: "smooth" });
          }}
          onCollapseAll={collapseAll} onExpandAll={expandAll}
          selectedCount={selectedIds.size}
          onClearSelection={() => setSelectedIds(new Set())}
          onGroup={() => setGroupOpen(true)}
          onBulkSet={() => setBulkMode("set")}
          onBulkStatus={(s) => void bulkStatus(s)}
          onBulkMove={(d) => bulkMove(d)}
          onBulkDelete={() => void bulkDelete()}
        />

        <div
          ref={bindScroll}
          tabIndex={0}
          onKeyDown={onTimelineKeyDown}
          onScroll={onScrollWindow}
          className="overflow-auto relative outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-ring)]/40 rounded-b-2xl"
          style={{ maxHeight: "70vh" }}
        >
          <div className="flex" style={{ width: leftW + timelineW }}>
            {/* ── Frozen outline column ── */}
            <div className="sticky left-0 z-20 bg-[var(--color-surface)] border-r border-[var(--color-border)] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]" style={{ width: leftW }}>
              {/* Drag to widen or narrow the task column (double-click resets). */}
              {!compact && (
                <div role="separator" aria-orientation="vertical" aria-label="Resize the task column" title="Drag to resize · double-click to reset"
                  onPointerDown={startResize}
                  onDoubleClick={() => { setUserLeftW(LEFT_W); try { localStorage.removeItem("timeline:leftW"); } catch { /* private mode */ } }}
                  className="absolute top-0 -right-1 z-30 h-full w-2 cursor-col-resize hover:bg-[var(--color-accent)]/30 active:bg-[var(--color-accent)]/50" />
              )}
              <div className="sticky top-0 z-10 bg-slate-50/95 dark:bg-[var(--color-surface-2)]/95 backdrop-blur border-b border-[var(--color-border)] flex items-center px-3 text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]" style={{ height: AXIS_H }}>
                <ListTree className="w-3.5 h-3.5 mr-1.5 text-[var(--color-accent)]" /> Work breakdown
              </div>
              {win.first > 0 && <div style={{ height: win.first * ROW_H }} aria-hidden />}
              {rows.slice(win.first, win.last).map((r) => (
                <OutlineRow
                  key={r.ms.id}
                  row={r}
                  span={spanOf(r.ms)}
                  work={r.hasChildren ? null : workShiftOf(r.ms, tz, shiftTimes)}
                  color={colors.colorOf(r.ms)}
                  collapsed={!!r.ms.id && collapsed.has(r.ms.id)}
                  selected={!!r.ms.id && selectedIds.has(r.ms.id)}
                  focused={!!r.ms.id && focusedId === r.ms.id}
                  canEdit={canEdit}
                  busy={!!r.ms.id && busy.has(r.ms.id)}
                  onToggleCollapse={() => r.ms.id && toggleCollapse(r.ms.id)}
                  onToggleSelected={() => r.ms.id && toggleSelected(r.ms.id)}
                  onSetStatus={(s, reason, p) => { if (r.ms.id) void setStatus(r.ms.id, s, reason, p); }}
                  onSetProgress={(p) => { if (r.ms.id) void setProgress(r.ms.id, p); }}
                  onSetProgressNote={(p, n) => (r.ms.id ? progressWithNote(r.ms.id, p, n) : false)}
                  onStartNote={(p, n) => (r.ms.id ? startWithNote(r.ms.id, p, n) : false)}
                  onSetDuration={() => setDurationFor(r.ms)}
                  onOpenDetail={() => r.ms.id && setDetailId(r.ms.id)}
                  onViewOnly={notifyViewOnly}
                  onSequence={() => r.ms.id && void sequencePhase(r.ms.id)}
                  criticalMark={showCritical && canEdit ? {
                    on: !!r.ms.id && criticalAny.has(r.ms.id),
                    own: r.ms.criticalOverride ?? null,
                    onToggle: () => void markCritical(r.ms, r.ms.id && criticalAny.has(r.ms.id) ? "no" : "yes"),
                  } : null}
                />
              ))}
              {win.last < rows.length && <div style={{ height: (rows.length - win.last) * ROW_H }} aria-hidden />}
            </div>

            {/* ── Timeline column ── */}
            <div className="relative" style={{ width: timelineW, height: AXIS_H + rows.length * ROW_H }}>
              <Axis domain={domain} pxPerDay={pxPerDay} shiftTimes={shiftTimes} />
              <Gridlines domain={domain} pxPerDay={pxPerDay} rowCount={rows.length} shiftTimes={shiftTimes} />
              <DependencyArrows rows={rows} byId={byId} domain={domain} pxPerDay={pxPerDay} spanOf={spanOf} />
              {todayX >= 0 && todayX <= timelineW && (
                <div className="absolute z-10 pointer-events-none" style={{ left: todayX, top: AXIS_H, bottom: 0, width: 0 }}>
                  <div className="absolute top-0 bottom-0 w-px bg-rose-500/80" />
                  <div className="absolute -top-0 -left-[3px] w-[7px] h-[7px] rounded-full bg-rose-500 shadow" />
                </div>
              )}
              {rows.slice(win.first, win.last).map((r, j) => (
                <Bar
                  key={r.ms.id}
                  row={r}
                  span={spanOf(r.ms)}
                  top={AXIS_H + (win.first + j) * ROW_H}
                  domain={domain}
                  pxPerDay={pxPerDay}
                  canEdit={canEdit}
                  dragDelta={drag && drag.id === r.ms.id ? drag.deltaDays : 0}
                  onPointerDown={(e) => onBarPointerDown(e, r.ms)}
                  onPointerMove={onBarPointerMove}
                  onPointerUp={onBarPointerUp}
                  onNudge={(d) => moveByDays(r.ms, d)}
                  onResize={(edge, d) => {
                    if (!r.ms.id) return;
                    if (r.ms.isSummary || r.hasChildren) void resizeSummaryEdge(r.ms.id, edge, d);
                    else void resizeEdge(r.ms.id, edge, d);
                  }}
                  onOpenDetail={() => r.ms.id && setDetailId(r.ms.id)}
                  critical={showCritical ? (r.ms.id ? criticalAny.has(r.ms.id) : false) : null}
                  color={colors.colorOf(r.ms)}
                />
              ))}
            </div>
          </div>
        </div>

        <Legend />
      </div>
      )}

      {pendingMove && pendingMove.ids.length > 0 && (
        <MovePreviewSheet
          targets={pendingMove.ids.map((id) => byId.get(id)).filter((m): m is Milestone => !!m)}
          allTasks={items}
          deltaDays={pendingMove.deltaDays}
          onCancel={() => setPendingMove(null)}
          onConfirm={(mode) => void commitMove(mode)}
          pushedBy={(mode) => {
            const primary: DateChange[] = [];
            const seen = new Set<string>();
            for (const id of pendingMove.ids) {
              for (const c of computeTreeMove(reflowNodes, id, pendingMove.deltaDays, mode, tz)) {
                if (!seen.has(c.id)) { seen.add(c.id); primary.push(c); }
              }
            }
            // Linked steps pushed along — not the moved tasks, their steps or their phases.
            return withCascade(primary)
              .filter((c) => !seen.has(c.id) && !(childrenOf.get(c.id)?.length))
              .map((c) => byId.get(c.id)?.name ?? "").filter(Boolean);
          }}
        />
      )}

      {detailId && byId.get(detailId) && (
        <TaskDetailPanel
          milestone={byId.get(detailId)!}
          subtasks={(childrenOf.get(detailId) ?? []).slice().sort(cmp)}
          allTasks={items}
          childCount={(id) => (childrenOf.get(id) ?? []).length}
          ancestors={ancestorsOf(byId.get(detailId)!)}
          canEdit={canEdit}
          userId={userId} userName={userName} userEmail={userEmail} userRole={userRole}
          onClose={() => setDetailId(null)}
          onChanged={onRefresh}
          onSelectSubtask={(m) => m.id && setDetailId(m.id)}
          onSelectMilestone={(m) => m.id && setDetailId(m.id)}
          onMoveDays={(id, days) => { const t = byId.get(id); if (t) void moveByDays(t, days); }}
          critical={{ ids: critical.ids, sourceLabel: criticalSourceLabel }}
        />
      )}

      {bulkMode && (
        <BulkEditModal
          milestones={items} selectedIds={selectedIds} startMode={bulkMode}
          orgId={orgId} projectId={projectId} userId={userId} userEmail={userEmail}
          onClose={() => setBulkMode(null)}
          onDone={(n, undo) => {
            setBulkMode(null); onRefresh();
            announce(`Changed on ${n} task${n === 1 ? "" : "s"}`, async () => { await undo(); onRefresh(); }, "success");
          }}
        />
      )}

      {groupOpen && selectedIds.size > 0 && (
        <GroupTasksModal
          orgId={orgId} projectId={projectId}
          actorUserId={userId} actorUserName={userName} actorUserEmail={userEmail} actorUserRole={userRole}
          childIds={Array.from(selectedIds)}
          childNames={Array.from(selectedIds).map((id) => byId.get(id)?.name).filter((s): s is string => !!s)}
          existingParents={summaries}
          onClose={() => setGroupOpen(false)}
          onDone={() => { setGroupOpen(false); setSelectedIds(new Set()); onRefresh(); }}
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

      <UndoToastHost toasts={toasts} onUndo={(t) => void runUndo(t)} onDismiss={dismiss} />
    </div>
  );
}

// Trim a task name for toast messages.
function truncate(s: string, n = 28): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function statusWord(s: MilestoneStatus): string {
  return s === "in_progress" ? "In progress" : s === "on_hold" ? "On hold" : s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Summary strip ─────────────────────────────────────────────

/** The summary in one line, for a phone: tap for the full cards. */
function CompactSummary({ items, now, shiftTimes, onOpen }: { items: Milestone[]; now: Date; shiftTimes: ShiftTimes; onOpen: () => void }) {
  const tz = useScheduleTz();
  const r = useMemo(() => computeExecutionReport(items, { tz, now, shiftTimes }), [items, tz, now, shiftTimes]);
  const standing = standingOf(r.pctComplete, r.expectedPct);
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-2 flex-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-left">
      <b className="text-[var(--color-text)]">{r.pctComplete}%</b>
      <span className={standing === "behind" ? "font-bold text-rose-700 dark:text-rose-300" : standing === "ahead" ? "font-bold text-emerald-700 dark:text-emerald-300" : "text-[var(--color-text-muted)]"}>
        {standing === "on track" ? "on track" : standing} · plan {r.expectedPct}%
      </span>
      {r.overdue > 0 && <span className="font-bold text-rose-700 dark:text-rose-300">{r.overdue} overdue</span>}
      {r.blocked + r.onHold > 0 && <span className="font-bold text-amber-700 dark:text-amber-300">{r.blocked + r.onHold} stuck</span>}
      <span className="ml-auto text-[11px] text-[var(--color-text-faint)]">Details</span>
    </button>
  );
}

function SummaryStrip({ items, now, shiftTimes }: {
  items: Milestone[]; now: Date; shiftTimes: ShiftTimes;
}) {
  const tz = useScheduleTz();
  // The same counts as the execution report and the shift report: one
  // definition of done, in progress, overdue and % complete.
  const r = useMemo(() => computeExecutionReport(items, { tz, now, shiftTimes }), [items, tz, now, shiftTimes]);
  const total = r.totalLeaves, done = r.done, inProg = r.inProgress, overdue = r.overdue, pct = r.pctComplete;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm ring-1 ring-slate-900/[0.03] px-4 py-3 flex items-center gap-5 flex-wrap">
      <div className="flex items-center gap-3 min-w-[200px]">
        <div className={`text-3xl font-black tracking-tighter ${pct === 100 ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--color-text)]"}`}>{pct}<span className="text-base text-[var(--color-text-faint)] font-bold">%</span></div>
        <div className="flex-1">
          <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden w-40">
            <div className={`h-full transition-all duration-500 ${pct === 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-1">{done} / {total} tasks complete</div>
        </div>
      </div>
      <Stat label="In progress" value={inProg} tone="blue" />
      <Stat label="Overdue" value={overdue} tone={overdue > 0 ? "rose" : "slate"} />
      {/* The job's own days (not the chart's padded range) — same as the reports. */}
      <Stat label="Schedule day" value={`${r.elapsedDays} / ${r.totalDays}`} tone="slate" />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: "blue" | "rose" | "slate" }) {
  const c = tone === "blue" ? "text-blue-600 dark:text-blue-400" : tone === "rose" ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text)]";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">{label}</span>
      <span className={`text-lg font-black tabular-nums ${c}`}>{value}</span>
    </div>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────

function Toolbar({
  canEdit, isAutoFit, canZoomIn, canZoomOut, onZoomIn, onZoomOut, onFit,
  onToday, onCollapseAll, onExpandAll,
  selectedCount, onClearSelection, onGroup, onBulkSet, onBulkStatus, onBulkMove, onBulkDelete,
}: {
  canEdit: boolean;
  isAutoFit: boolean; canZoomIn: boolean; canZoomOut: boolean;
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
  onToday: () => void;
  onCollapseAll: () => void; onExpandAll: () => void;
  selectedCount: number; onClearSelection: () => void; onGroup: () => void; onBulkSet: () => void;
  onBulkStatus: (s: MilestoneStatus) => void; onBulkMove: (deltaDays: number) => void;
  onBulkDelete: () => void;
}) {
  return (
    <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-gradient-to-b from-white dark:from-[var(--color-surface)] to-slate-50/40 dark:to-[var(--color-surface)]">
      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 flex-1 flex-wrap">
          <span className="text-xs font-bold text-[var(--color-accent)]">{selectedCount} selected</span>
          {canEdit && (
            <>
              {/* Bulk status */}
              <div className="inline-flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Mark</span>
                {([["completed", "Done", "bg-emerald-600"], ["in_progress", "Doing", "bg-blue-600"], ["on_hold", "Hold", "bg-amber-600"], ["blocked", "Block", "bg-rose-600"]] as const).map(([s, label, bg]) => (
                  <button key={s} onClick={() => onBulkStatus(s)} className={`px-2 py-1 rounded-md text-white text-[11px] font-bold ${bg} hover:brightness-110`}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="w-px h-4 bg-slate-200" />
              {/* Bulk move */}
              <div className="inline-flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Move</span>
                <button onClick={() => onBulkMove(-1)} className="px-1.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] text-[11px] font-bold">−1d</button>
                <button onClick={() => onBulkMove(1)} className="px-1.5 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] text-[11px] font-bold">+1d</button>
              </div>
              <span className="w-px h-4 bg-slate-200" />
              <button onClick={onBulkSet} title="Set the contractor, crew, company, location… on all the selected tasks"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] text-[11px] font-bold transition-colors">
                <Replace className="w-3 h-3" /> Set…
              </button>
              <button onClick={onGroup} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-[11px] font-bold transition-colors">
                <FolderPlus className="w-3 h-3" /> Group
              </button>
              <button onClick={onBulkDelete} title="Delete the selected tasks (Undo brings them back)"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-300 text-rose-700 dark:text-rose-300 dark:border-rose-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-[11px] font-bold transition-colors">
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            </>
          )}
          <button onClick={onClearSelection} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] text-[11px] font-bold ml-auto">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        </div>
      ) : (
        <>
          <button onClick={onToday} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)] border border-[var(--color-border)]">
            <Crosshair className="w-3.5 h-3.5 text-rose-500" /> Today
          </button>
          <div className="w-px h-5 bg-slate-200" />
          <button onClick={onExpandAll} className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)]">Expand all</button>
          <button onClick={onCollapseAll} className="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 rounded-md hover:bg-[var(--color-surface-2)]">Collapse all</button>
          <div className="ml-auto inline-flex items-center gap-1">
            <button
              onClick={onZoomOut}
              disabled={!canZoomOut}
              className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] disabled:opacity-30"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={onFit}
              className={`text-[10px] font-bold px-2 py-1 rounded-md border transition-colors ${isAutoFit ? "bg-[var(--color-accent-soft)] border-[var(--color-accent-ring)]/40 text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}
              title="Fit the whole schedule to the screen width"
            >
              Fit
            </button>
            <button
              onClick={onZoomIn}
              disabled={!canZoomIn}
              className="p-1.5 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] disabled:opacity-30"
              title="Zoom in"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Outline row (left, frozen) ────────────────────────────────

function OutlineRow({
  row, span, work, color, collapsed, selected, focused, canEdit, busy,
  onToggleCollapse, onToggleSelected, onSetStatus, onSetProgress, onSetProgressNote, onStartNote, onSetDuration, onOpenDetail, onViewOnly, onSequence, criticalMark,
}: {
  row: FlatRow; span: { start: number; finish: number }; work: WorkShift | null; color: GroupColor; collapsed: boolean; selected: boolean; focused?: boolean; canEdit: boolean; busy: boolean;
  onToggleCollapse: () => void; onToggleSelected: () => void;
  onSetStatus: (s: MilestoneStatus, reason?: string, percent?: number) => void; onSetProgress: (percent: number) => void;
  onSetProgressNote: (percent: number, note: string) => Promise<boolean> | boolean;
  onStartNote: (percent: number, note: string) => Promise<boolean> | boolean;
  onSetDuration: () => void; onOpenDetail: () => void;
  onViewOnly?: () => void; onSequence?: () => void;
  /** Critical-path editing: on the path or not, its own mark, and the
   *  toggle (null = not editing the critical path). */
  criticalMark?: { on: boolean; own: CriticalOverride | null; onToggle: () => void } | null;
}) {
  const tz = useScheduleTz();
  const { ms, depth, hasChildren, done, total, pct, derivedStatus } = row;
  // A summary's status/percent are DERIVED from its children — shown, never set
  // here. A leaf carries its own.
  const effStatus = hasChildren ? derivedStatus : ms.status;
  const checked = effStatus === "completed";
  const indent = 8 + depth * 16;

  return (
    <div
      id={ms.id ? `exec-row-${ms.id}` : undefined}
      // overflow-hidden keeps every row exactly ROW_H tall and stops a long
      // name / date range from bleeding over the row below — the rows must stay
      // pixel-aligned with the absolutely-positioned timeline bars on the right.
      // (The status picker is portaled, so it isn't clipped by this.)
      className={`group relative flex items-center gap-1.5 border-b border-[var(--color-border)] pr-2 overflow-hidden transition-colors ${focused ? "ring-2 ring-inset ring-[var(--color-accent-ring)] bg-[var(--color-accent-soft)]/40" : selected ? "bg-[var(--color-accent-soft)]/70" : checked ? "bg-emerald-50/30 dark:bg-emerald-950/20" : depth === 0 ? color.tint : "hover:bg-[var(--color-surface-2)]"}`}
      style={{ height: ROW_H, paddingLeft: indent }}
    >
      {/* Group color rail — same hue for a phase and all its children,
          so identity reads instantly down the column. */}
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${color.rail} ${depth === 0 ? "" : "opacity-60"}`} aria-hidden />
      {/* Depth guide lines — faint verticals mark each nesting level. */}
      {Array.from({ length: depth }).map((_, i) => (
        <span key={i} className="absolute top-0 bottom-0 w-px bg-slate-200/70" style={{ left: 12 + i * 16 }} aria-hidden />
      ))}
      {canEdit && (
        <button onClick={onToggleSelected} className="shrink-0 text-slate-300 hover:text-[var(--color-accent)] transition-colors" title={selected ? "Deselect" : "Select"}>
          {selected ? <CheckSquare className="w-4 h-4 text-[var(--color-accent)]" /> : <Square className="w-4 h-4" />}
        </button>
      )}
      {criticalMark && (
        <button onClick={criticalMark.onToggle} aria-pressed={criticalMark.on}
          title={`${criticalMark.on ? "On the critical path — tap to take it off" : "Not critical — tap to mark it critical"}${hasChildren ? " (with everything under it)" : ""}${criticalMark.own ? " · marked by hand" : ""}`}
          className={`shrink-0 w-5 h-5 inline-flex items-center justify-center rounded ${criticalMark.on ? "bg-rose-600 text-white" : "text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"} ${criticalMark.own ? "ring-1 ring-offset-1 ring-rose-400 dark:ring-offset-slate-900" : ""}`}>
          <Zap className="w-3 h-3" />
        </button>
      )}
      {hasChildren ? (
        <button onClick={onToggleCollapse} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-slate-200" title={collapsed ? "Expand" : "Collapse"}>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} strokeWidth={2.5} />
        </button>
      ) : (
        <span className="shrink-0 w-5 inline-flex justify-center"><span className="w-1.5 h-1.5 rounded-full bg-slate-300" /></span>
      )}

      {hasChildren ? (
        <StatusControl status={derivedStatus} variant="dot" size="md" readOnly title="Phase status — rolls up from sub-tasks" onPick={() => {}} />
      ) : (
        <StatusControl status={ms.status} busy={busy} disabled={!canEdit} onDisabledClick={onViewOnly} variant="dot" size="md" onPick={onSetStatus} percent={pct} onSetProgress={onSetProgress} onStartWithNote={onStartNote} />
      )}

      <button
        onClick={onOpenDetail}
        className="flex-1 min-w-0 text-left"
        title={`${ms.name} — open details`}
      >
        <div className={`truncate text-[13px] leading-tight ${checked ? "line-through text-[var(--color-text-faint)]" : ms.isSummary ? "font-bold text-[var(--color-text)]" : "font-medium text-[var(--color-text)]"}`}>
          {ms.name}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-faint)] font-mono leading-tight min-w-0">
          {work && <ShiftMark work={work} />}
          {ms.wbs && <span className="text-[var(--color-text-faint)] shrink-0">{ms.wbs}</span>}
          <span className="truncate" title={spanLabel(span.start, span.finish, tz)}>{spanLabel(span.start, span.finish, tz)}</span>
          {(ms.dependsOn?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[var(--color-accent)] font-bold shrink-0" title={`Depends on ${ms.dependsOn!.length} task${ms.dependsOn!.length === 1 ? "" : "s"} — can't start until they finish`}>
              <Link2 className="w-2.5 h-2.5" />{ms.dependsOn!.length}
            </span>
          )}
          {hasChildren && <span className={`${color.text} font-bold shrink-0`}>{done}/{total}</span>}
        </div>
      </button>

      {hasChildren ? (
        // Summary: read-only rolled-up progress bar.
        <div className="shrink-0 flex items-center gap-1" title={`${pct}% complete (rolled up from ${done}/${total} sub-tasks)`}>
          <div className="w-9 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className={`h-full ${pct === 100 ? "bg-emerald-500" : color.rail}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[9px] font-bold tabular-nums text-[var(--color-text-faint)] w-7 text-right">{pct}%</span>
        </div>
      ) : (
        // Leaf: editable % complete.
        <ProgressControl percent={pct} onPick={onSetProgress} onSaveWithNote={onSetProgressNote} disabled={!canEdit} onDisabledClick={onViewOnly} busy={busy} size="sm" />
      )}
      {canEdit && !ms.isSummary && (
        <button onClick={onSetDuration} title="Set duration" className="shrink-0 p-1 rounded text-slate-300 hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] opacity-60 sm:opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity">
          <CalendarRange className="w-3.5 h-3.5" />
        </button>
      )}
      {canEdit && hasChildren && onSequence && (
        <button onClick={onSequence} title="Sequence sub-tasks end-to-end (each starts when the prior finishes)" className="shrink-0 p-1 rounded text-slate-300 hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] opacity-60 sm:opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity">
          <ListOrdered className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Timeline bar (right) ──────────────────────────────────────

function Bar({
  span,
  row, top, domain, pxPerDay, canEdit, dragDelta,
  onPointerDown, onPointerMove, onPointerUp, onNudge, onResize, onOpenDetail, critical, color,
}: {
  row: FlatRow; top: number;
  /** When it really runs — a parent from its first step to its last. */
  span: { start: number; finish: number };
  domain: { start: Date; end: Date; totalDays: number };
  pxPerDay: number; canEdit: boolean; dragDelta: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onNudge: (deltaDays: number) => void;
  onResize: (edge: "start" | "finish", deltaDays: number) => void;
  onOpenDetail: () => void;
  /** null = critical-path mode off; true = on the driving chain; false = off it. */
  critical?: boolean | null;
  color: GroupColor;
}) {
  const tz = useScheduleTz();
  const { ms, hasChildren } = row;
  const dimmed = critical === false;
  const onPath = critical === true;
  // Live edge-resize preview (days the dragged edge has moved).
  const [resize, setResize] = React.useState<{ edge: "start" | "finish"; days: number } | null>(null);
  const resizeRef = React.useRef<{ edge: "start" | "finish"; startX: number } | null>(null);
  const onEdgeDown = (edge: "start" | "finish") => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeRef.current = { edge, startX: e.clientX };
    setResize({ edge, days: 0 });
  };
  const onEdgeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current; if (!r) return;
    const days = Math.round((e.clientX - r.startX) / pxPerDay);
    setResize((p) => (p && p.days === days ? p : { edge: r.edge, days }));
  };
  const onEdgeUp = (e: React.PointerEvent) => {
    const r = resizeRef.current; resizeRef.current = null;
    if (!r) return;
    const days = Math.round((e.clientX - r.startX) / pxPerDay);
    setResize(null);
    if (days !== 0) onResize(r.edge, days);
  };

  const start = new Date(span.start);
  const finish = new Date(span.finish);
  const spanDays = Math.max(1, dayDiff(start, finish, tz) + 1);
  // At its clock times (6:00–10:00 and 18:00–22:00 no longer look alike);
  // a date-only task fills its days. Live resize/drag previews shift by days.
  const geo = barGeometry(start.getTime(), finish.getTime(), domain.start.getTime(), pxPerDay, tz);
  const previewStartShift = resize?.edge === "start" ? resize.days : 0;
  const previewSpanShift = resize?.edge === "finish" ? resize.days : (resize?.edge === "start" ? -resize.days : 0);
  const left = geo.left + previewStartShift * pxPerDay + dragDelta * pxPerDay;
  const width = Math.max(4, geo.width + previewSpanShift * pxPerDay);
  // Leaf = its own % complete; summary = weighted roll-up of its children.
  const pct = row.pct;
  const tone = statusTone(ms.status);
  // Completed leaves are locked (actuals) — no drag, nudge, or resize handles.
  const draggable = canEdit && !ms.isSummary && ms.status !== "completed";
  // MS Project milestones (zero-duration markers) render as a diamond, not a bar.
  const isMilestonePoint = (ms.attributes as Record<string, unknown> | null | undefined)?.milestone === "1";
  // If the bar is too narrow to hold its name (~6.2px per char + icon
  // padding), render the label OUTSIDE the bar to the right so the text
  // is never clipped. There's always horizontal room — the row scrolls.
  const labelFits = width >= ms.name.length * 6.2 + 22;

  // Summary tasks render as a slim bracket; leaves as a solid bar with
  // a progress fill. Milestones (zero-width spans) get a diamond.
  if (ms.isSummary || hasChildren) {
    const summaryResizable = canEdit;
    return (
      <div
        className={`absolute group/bar flex items-center transition-opacity ${dimmed ? "opacity-25" : ""} ${resize ? "z-20" : ""}`}
        style={{ top, left, width, height: ROW_H }}
        title={summaryResizable ? `${ms.name} — drag an end to extend/shorten the whole phase` : `${ms.name} — open details`}
      >
        <div className="relative w-full h-2 self-center mt-0 cursor-pointer" onClick={onOpenDetail}>
          {/* Phase bracket in the GROUP hue (caps mark its span). */}
          <div className={`absolute inset-0 rounded-full ${color.rail} opacity-70`} />
          <div className={`absolute -left-px -top-1 w-[3px] h-4 rounded-sm ${color.rail}`} />
          <div className={`absolute -right-px -top-1 w-[3px] h-4 rounded-sm ${color.rail}`} />
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/80" style={{ width: `${pct}%` }} />
        </div>
        {/* Edge handles — drag to proportionally stretch the whole subtree. */}
        {summaryResizable && (
          <>
            <span
              onPointerDown={onEdgeDown("start")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to start the phase earlier / later"
              className="absolute -left-1.5 top-0 bottom-0 w-3.5 pointer-coarse:w-6 pointer-coarse:-left-3 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 flex items-center justify-center"
            >
              <span className={`w-1.5 h-4 rounded ${color.rail} brightness-75 hover:brightness-50`} />
            </span>
            <span
              onPointerDown={onEdgeDown("finish")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to extend / shorten the phase finish"
              className="absolute -right-1.5 top-0 bottom-0 w-3.5 pointer-coarse:w-6 pointer-coarse:-right-3 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 flex items-center justify-center"
            >
              <span className={`w-1.5 h-4 rounded ${color.rail} brightness-75 hover:brightness-50`} />
            </span>
          </>
        )}
        {resize && (
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-bold bg-slate-900 text-white px-1.5 py-0.5 rounded whitespace-nowrap shadow">
            {resize.days > 0 ? "+" : ""}{resize.days}d
          </span>
        )}
      </div>
    );
  }

  // Milestone marker — a diamond at the point date, with the label beside it.
  if (isMilestonePoint) {
    return (
      <div className={`absolute group/bar flex items-center gap-1.5 transition-opacity ${dimmed ? "opacity-25" : ""} ${onPath ? "z-10" : ""}`} style={{ top, left: left - 6, height: ROW_H }} title={`${ms.name} — milestone · ${fmtDateUTC(finish, tz)}`}>
        <button onClick={onOpenDetail} className="relative shrink-0" aria-label={`Milestone ${ms.name}`}>
          <span className={`block w-3 h-3 rotate-45 border-2 border-white shadow ${ms.status === "completed" ? "bg-emerald-500" : onPath ? "bg-rose-500" : "bg-slate-700"}`} />
        </button>
        <span className="whitespace-nowrap text-[10px] font-bold text-[var(--color-text)] max-w-[200px] truncate bg-white/80 rounded px-1">{ms.name}</span>
      </div>
    );
  }

  return (
    <div className={`absolute group/bar flex items-center transition-opacity ${dimmed ? "opacity-25" : ""} ${onPath ? "z-10" : ""}`} style={{ top: top + 6, left, width, height: ROW_H - 12 }}>
      {draggable && (
        <button onClick={() => onNudge(-1)} className="absolute -left-5 pointer-coarse:-left-7 pointer-coarse:p-1.5 opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-opacity" title="Move back 1 day">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={draggable ? { touchAction: "none" } : undefined}
        className={`relative w-full h-full rounded-md border ${tone.border} ${tone.bar} shadow-sm overflow-hidden ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragDelta !== 0 || resize ? "ring-2 ring-[var(--color-accent-ring)] z-20" : onPath ? "ring-2 ring-rose-500 ring-offset-1" : ""}`}
        title={`${ms.name}\n${fmtDateUTC(start, tz)} → ${fmtDateUTC(finish, tz)}${dragDelta ? `\nmove ${dragDelta > 0 ? "+" : ""}${dragDelta}d` : ""}${resize ? `\nresize ${resize.days > 0 ? "+" : ""}${resize.days}d` : ""}`}
      >
        {/* Group-hue cap on the left edge — a quiet identity marker that
            ties the leaf to its phase without overriding the status fill. */}
        <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${color.rail} brightness-90`} aria-hidden />
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${pct}%` }} />
        <div className="relative h-full flex items-center pl-2.5 pr-1.5 gap-1">
          {ms.status === "completed" && <CircleCheck className="w-3 h-3 text-white shrink-0" />}
          {labelFits && <span className="truncate text-[10px] font-semibold text-white drop-shadow-sm">{ms.name}{resize ? ` (${spanDays + previewSpanShift}d)` : ""}</span>}
        </div>
        {/* Edge resize handles — only on leaves the user can edit. */}
        {draggable && (
          <>
            <span
              onPointerDown={onEdgeDown("start")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to change the start (duration)"
              className="absolute left-0 top-0 bottom-0 w-2 pointer-coarse:w-4 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 bg-white/40 hover:bg-white/70 border-r border-white/50"
            />
            <span
              onPointerDown={onEdgeDown("finish")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to change the finish (duration)"
              className="absolute right-0 top-0 bottom-0 w-2 pointer-coarse:w-4 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 bg-white/40 hover:bg-white/70 border-l border-white/50"
            />
          </>
        )}
      </div>
      {/* Narrow bar: label spills to the right. Constrained + backed by a
          translucent pill so long names can't sprawl across the canvas or
          visually merge with neighbouring rows' labels. */}
      {!labelFits && (
        <span
          className="absolute left-full ml-1.5 whitespace-nowrap text-[10px] font-semibold text-[var(--color-text)] pointer-events-none max-w-[220px] truncate bg-white/80 rounded px-1 shadow-sm"
          style={{ top: "50%", transform: "translateY(-50%)" }}
        >
          {ms.name}
        </span>
      )}
      {draggable && (
        <button onClick={() => onNudge(1)} className="absolute -right-5 pointer-coarse:-right-7 pointer-coarse:p-1.5 opacity-0 group-hover/bar:opacity-100 pointer-coarse:opacity-100 p-0.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-opacity" title="Move forward 1 day">
          <ChevronRightIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Axis + gridlines ──────────────────────────────────────────

const DAY_ROW = 22, SHIFT_ROW = 16;

/** Three rows: the days on top; under them the shifts (Day ☀ / Night ☾ at
 *  the project's shift-change times) and, zoomed in, the hours. */
function Axis({ domain, pxPerDay, shiftTimes }: { domain: { start: Date; totalDays: number }; pxPerDay: number; shiftTimes: ShiftTimes }) {
  const tz = useScheduleTz();
  // Day labels: every day when there's room, else every N days plus the
  // anchors the eye looks for (first, last, 1st of the month).
  const step = pxPerDay >= 60 ? 1 : pxPerDay >= 34 ? 2 : pxPerDay >= 16 ? 7 : pxPerDay >= 8 ? 14 : 30;
  const firstDay = PAD_DAYS, lastDay = Math.max(firstDay, domain.totalDays - 1 - PAD_DAYS);
  const anchors = new Set<number>([firstDay, lastDay]);
  for (let d = 0; d < domain.totalDays; d++) {
    if (wallClock(addDaysUTC(domain.start, d, tz).getTime(), tz).day === 1) anchors.add(d);
  }
  const minGapDays = Math.max(1, Math.ceil(30 / pxPerDay));
  const days = new Set<number>(anchors);
  for (let d = 0; d < domain.totalDays; d += step) {
    if ([...anchors].some((a) => Math.abs(a - d) < minGapDays)) continue;
    days.add(d);
  }
  const fmt: Intl.DateTimeFormatOptions = pxPerDay >= 110 ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" };
  const ticks = [...days].sort((a, b) => a - b).map((d) => {
    const date = addDaysUTC(domain.start, d, tz);
    const monthStart = wallClock(date.getTime(), tz).day === 1;
    return { d, x: d * pxPerDay, anchor: anchors.has(d), label: step >= 28 && monthStart ? fmtInTz(date, tz, { month: "short", year: "2-digit" }) : fmtInTz(date, tz, fmt) };
  });
  // Shift bands and hours, once a day is wide enough to read them.
  const showShifts = pxPerDay >= 48;
  const hStep = hourStep(pxPerDay);
  const bands: Array<{ x: number; w: number; night: boolean; label: string }> = [];
  const hours: Array<{ x: number; label: string }> = [];
  if (showShifts) {
    const [dh, dm] = shiftTimes.dayStart.split(":").map(Number);
    const [nh, nm] = shiftTimes.nightStart.split(":").map(Number);
    const dayAt = ((dh || 0) * 60 + (dm || 0)) / 1440, nightAt = ((nh || 0) * 60 + (nm || 0)) / 1440;
    for (let d = -1; d < domain.totalDays; d++) {
      const dayX = (d + dayAt) * pxPerDay, nightX = (d + nightAt) * pxPerDay;
      bands.push({ x: dayX, w: nightX - dayX, night: false, label: shiftTimes.dayStart });
      bands.push({ x: nightX, w: (d + 1 + dayAt) * pxPerDay - nightX, night: true, label: shiftTimes.nightStart });
    }
    if (hStep) {
      for (let d = 0; d < domain.totalDays; d++) {
        for (let h = hStep; h < 24; h += hStep) {
          const x = (d + h / 24) * pxPerDay;
          hours.push({ x, label: `${h}:00` });
        }
      }
    }
  }
  return (
    <div className="sticky top-0 z-10 bg-slate-50/95 dark:bg-[var(--color-surface-2)]/95 backdrop-blur border-b border-[var(--color-border)] overflow-hidden" style={{ height: AXIS_H }}>
      {/* Days */}
      <div className="absolute inset-x-0 top-0" style={{ height: showShifts ? DAY_ROW : AXIS_H }}>
        {ticks.map((t) => (
          <div key={t.d} className="absolute top-0 bottom-0 flex items-center" style={{ left: t.x, width: step === 1 ? pxPerDay : undefined }}>
            <div className="absolute top-0 bottom-0 left-0 w-px bg-slate-300 dark:bg-slate-600" />
            <span className={`pl-1.5 text-[10px] whitespace-nowrap ${t.anchor || step === 1 ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{t.label}</span>
          </div>
        ))}
      </div>
      {/* Shifts + hours */}
      {showShifts && (
        <div className="absolute inset-x-0 bottom-0 border-t border-slate-200 dark:border-slate-700" style={{ height: AXIS_H - DAY_ROW }}>
          {bands.map((b, i) => (
            <div key={i} className={`absolute top-0 flex items-center gap-1 overflow-hidden border-b border-slate-200 dark:border-slate-700 ${b.night ? "bg-indigo-100/80 dark:bg-indigo-950/60 text-indigo-800 dark:text-indigo-300" : "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"}`}
              style={{ left: b.x, width: b.w, height: SHIFT_ROW }} title={`${b.night ? "Night" : "Day"} shift from ${b.label}`}>
              <div className="absolute top-0 bottom-0 left-0 w-px bg-slate-300 dark:bg-slate-600" />
              <span className="pl-1 text-[9px] font-black whitespace-nowrap">{b.night ? "☾" : "☀"}{pxPerDay >= 110 ? ` ${b.night ? "Night" : "Day"} ${b.label}` : ""}</span>
            </div>
          ))}
          {hours.map((h, i) => (
            <div key={`h${i}`} className="absolute bottom-0" style={{ left: h.x }}>
              <div className="absolute bottom-0 w-px h-1.5 bg-slate-400 dark:bg-slate-500" />
              <span className="absolute bottom-1.5 -translate-x-1/2 text-[8.5px] font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">{h.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Day lines, night shifts shaded, and hour lines when zoomed in. */
function Gridlines({ domain, pxPerDay, rowCount, shiftTimes }: { domain: { start: Date; totalDays: number }; pxPerDay: number; rowCount: number; shiftTimes: ShiftTimes }) {
  const tz = useScheduleTz();
  const step = pxPerDay >= 60 ? 1 : pxPerDay >= 34 ? 2 : pxPerDay >= 16 ? 7 : pxPerDay >= 8 ? 14 : 30;
  const lines: React.ReactNode[] = [];
  const showShifts = pxPerDay >= 48;
  if (showShifts) {
    const [dh, dm] = shiftTimes.dayStart.split(":").map(Number);
    const [nh, nm] = shiftTimes.nightStart.split(":").map(Number);
    const dayAt = ((dh || 0) * 60 + (dm || 0)) / 1440, nightAt = ((nh || 0) * 60 + (nm || 0)) / 1440;
    for (let d = -1; d < domain.totalDays; d++) {
      const nx = (d + nightAt) * pxPerDay;
      lines.push(<div key={`n${d}`} className="absolute top-0 bottom-0 bg-indigo-50/70 dark:bg-indigo-950/25" style={{ left: nx, width: (d + 1 + dayAt) * pxPerDay - nx }} />);
    }
    const hStep = hourStep(pxPerDay);
    if (hStep && hStep <= 3) {
      for (let d = 0; d < domain.totalDays; d++) for (let h = hStep; h < 24; h += hStep) {
        lines.push(<div key={`h${d}-${h}`} className="absolute top-0 bottom-0 w-px bg-slate-100 dark:bg-slate-800" style={{ left: (d + h / 24) * pxPerDay }} />);
      }
    }
  }
  for (let d = 0; d < domain.totalDays; d += step) {
    const date = addDaysUTC(domain.start, d, tz);
    const weekend = !showShifts && pxPerDay >= 12 && [0, 6].includes(dayOfWeek(date.getTime(), tz));
    lines.push(
      <div key={d} className={`absolute top-0 bottom-0 ${weekend ? "bg-[var(--color-surface-2)]" : ""}`} style={{ left: d * pxPerDay, width: step * pxPerDay }}>
        <div className={`absolute top-0 bottom-0 left-0 w-px ${showShifts ? "bg-slate-300 dark:bg-slate-700" : "bg-[var(--color-surface-2)]"}`} />
      </div>,
    );
  }
  return <div className="absolute pointer-events-none overflow-hidden" style={{ top: AXIS_H, left: 0, right: 0, height: rowCount * ROW_H }}>{lines}</div>;
}

// ─── Dependency arrows (finish-to-start connectors) ─────────────

function DependencyArrows({ rows, byId, domain, pxPerDay, spanOf }: {
  rows: FlatRow[];
  byId: Map<string, Milestone>;
  domain: { start: Date; end: Date; totalDays: number };
  pxPerDay: number;
  spanOf: (m: Milestone) => { start: number; finish: number };
}) {
  const tz = useScheduleTz();
  const indexById = new Map<string, number>();
  rows.forEach((r, i) => { if (r.ms.id) indexById.set(r.ms.id, i); });
  const parentOf = (id: string) => byId.get(id)?.parentId ?? null;

  const geom = (i: number) => {
    const ms = rows[i].ms;
    const sp = spanOf(ms);
    const g = barGeometry(sp.start, sp.finish, domain.start.getTime(), pxPerDay, tz);
    return {
      leftX: g.left,
      rightX: g.left + g.width,
      midY: AXIS_H + i * ROW_H + ROW_H / 2,
    };
  };

  // Walk EVERY milestone's links (not just the visible rows) and snap each
  // endpoint to its nearest on-screen row. That keeps a dependency drawn even
  // when the predecessor or successor is hidden inside a collapsed phase — the
  // arrow just connects the phase bars instead of vanishing. Dedupe so several
  // leaves collapsing onto the same pair of phases don't stack identical arrows.
  const drawn = new Set<string>();
  const paths: React.ReactNode[] = [];
  for (const succMs of byId.values()) {
    if (!succMs.id) continue;
    const si = resolveVisibleDepIndex(succMs.id, indexById, parentOf);
    if (si === undefined) continue;
    for (const predId of succMs.dependsOn ?? []) {
      const pi = resolveVisibleDepIndex(predId, indexById, parentOf);
      if (pi === undefined || pi === si) continue; // off-screen, or both collapsed into one row
      const key = `${pi}->${si}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const pred = geom(pi);
      const succ = geom(si);
      // Elbow connector from the end the link ties: finish-to-start leaves
      // the predecessor's finish into the successor's start; start-to-start
      // leaves its start; finish-to-finish ends at the successor's finish.
      const type = linkOf(succMs.linkTypes, predId).type;
      const fromStart = type === "SS" || type === "SF", toFinish = type === "FF" || type === "SF";
      const x1 = fromStart ? pred.leftX : pred.rightX, y1 = pred.midY;
      const x2 = toFinish ? succ.rightX : succ.leftX, y2 = succ.midY;
      const outX = fromStart ? x1 - 7 : x1 + 7;
      const d = `M ${x1} ${y1} L ${outX} ${y1} L ${outX} ${y2} L ${x2} ${y2}`;
      paths.push(
        <path
          key={key}
          d={d}
          fill="none"
          stroke="#6366f1"
          strokeWidth={1.5}
          strokeOpacity={0.55}
          markerEnd="url(#dep-arrowhead)"
        />,
      );
    }
  }

  if (paths.length === 0) return null;
  return (
    <svg
      className="absolute pointer-events-none z-0"
      style={{ top: 0, left: 0, width: "100%", height: AXIS_H + rows.length * ROW_H, overflow: "visible" }}
      aria-hidden
    >
      <defs>
        <marker id="dep-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#6366f1" fillOpacity="0.7" />
        </marker>
      </defs>
      {paths}
    </svg>
  );
}

// ─── Status affordances ────────────────────────────────────────

function Legend() {
  const entries: Array<[MilestoneStatus, string]> = [
    ["planned", "Planned"], ["in_progress", "In progress"], ["completed", "Done"], ["on_hold", "On hold"], ["blocked", "Blocked"], ["missed", "Missed"],
  ];
  return (
    <div className="px-3 py-2 border-t border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] space-y-1.5">
      {/* Status colours */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">Status</span>
        {entries.map(([s, label]) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
            <span className={`w-2.5 h-2.5 rounded-sm ${statusTone(s).bar}`} /> {label}
          </span>
        ))}
      </div>
      {/* Symbol key — what the shapes mean (MS-Project-style vocabulary). */}
      <div className="flex items-center gap-3.5 flex-wrap">
        <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">Symbols</span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]" title="A task; the lighter fill shows % complete">
          <span className="relative w-7 h-2.5 rounded bg-blue-500 overflow-hidden"><span className="absolute inset-y-0 left-0 bg-white/40" style={{ width: "55%" }} /></span> Task (fill = % done)
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]" title="A summary / phase that rolls up its children">
          <span className="relative w-7 flex items-center"><span className="h-1 w-full rounded-full bg-slate-400" /><span className="absolute -left-px w-[3px] h-3 rounded-sm bg-slate-400" /><span className="absolute -right-px w-[3px] h-3 rounded-sm bg-slate-400" /></span> Phase / summary
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]" title="A milestone — a zero-duration marker">
          <span className="w-2.5 h-2.5 rotate-45 bg-slate-700 border border-white" /> Milestone
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]" title="On the critical path — drives the finish date">
          <span className="w-3 h-2.5 rounded-sm bg-slate-300 ring-2 ring-rose-500 ring-offset-1" /> Critical path
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]" title="Finish-to-start dependency between linked tasks">
          <svg width="22" height="10" className="overflow-visible"><path d="M1 2 L11 2 L11 8 L20 8" fill="none" stroke="#6366f1" strokeWidth="1.5" /><path d="M16 5 L20 8 L16 11" fill="none" stroke="#6366f1" strokeWidth="1.5" /></svg> Dependency
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-faint)]">
        <Info className="w-3 h-3" /> Drag a bar or ◀ ▶ to reschedule · click the dot for status ·
        <kbd className="px-1 rounded bg-[var(--color-surface)] border border-[var(--color-border-strong)] font-mono">↑↓</kbd> navigate
        <kbd className="px-1 rounded bg-[var(--color-surface)] border border-[var(--color-border-strong)] font-mono">←→</kbd> move
        <kbd className="px-1 rounded bg-[var(--color-surface)] border border-[var(--color-border-strong)] font-mono">↵</kbd> open
      </div>
    </div>
  );
}

// ─── Group modal ───────────────────────────────────────────────

function GroupTasksModal({
  orgId, projectId, actorUserId, actorUserName, actorUserEmail, actorUserRole,
  childIds, childNames, existingParents, onClose, onDone,
}: {
  orgId: string; projectId: string;
  actorUserId: string; actorUserName?: string; actorUserEmail?: string; actorUserRole?: string;
  childIds: string[]; childNames: string[]; existingParents: Milestone[];
  onClose: () => void; onDone: () => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [existingId, setExistingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = mode === "new" ? !!name.trim() : !!existingId;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await groupTasksUnderParent({
        orgId, projectId,
        parentName: mode === "new" ? name.trim() : undefined,
        parentId: mode === "existing" ? existingId : undefined,
        childIds, actorUserId, actorUserName, actorUserEmail, actorUserRole,
      });
      if (res.errors.length > 0) setError(res.errors.join(" · "));
      else onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)] flex items-center justify-center"><FolderPlus className="w-4 h-4" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Group under a parent</h2>
            <div className="text-[11px] text-[var(--color-text-muted)]">{childIds.length} task{childIds.length === 1 ? "" : "s"} selected</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="inline-flex items-center bg-[var(--color-surface-2)] rounded-md p-0.5 gap-0.5">
            {(["new", "existing"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${mode === m ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                {m === "new" ? "Create new" : "Use existing"}
              </button>
            ))}
          </div>
          {mode === "new" ? (
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Phase 2 — Tear Down"' autoFocus className="w-full px-3 py-2 text-sm border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/30 focus:border-[var(--color-accent-ring)]" />
          ) : existingParents.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)] italic">No existing parents — create a new one.</div>
          ) : (
            <Select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
              <option value="">— pick a parent —</option>
              {existingParents.map((p) => <option key={p.id} value={p.id ?? ""}>{p.name}</option>)}
            </Select>
          )}
          <div className="rounded-md border border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] p-2.5 max-h-32 overflow-y-auto">
            <ul className="space-y-0.5">
              {childNames.slice(0, 12).map((n, i) => <li key={i} className="text-[11px] text-[var(--color-text)] truncate">{n}</li>)}
              {childNames.length > 12 && <li className="text-[10px] text-[var(--color-text-muted)] italic">+{childNames.length - 12} more</li>}
            </ul>
          </div>
          {error && <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-md p-2">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5 transition-colors">Cancel</button>
          <button onClick={submit} disabled={!canSubmit || busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-md disabled:opacity-40 transition-colors">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />} Group
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Duration modal ────────────────────────────────────────────

function SetDurationModal({ task, actorUserId, onClose, onDone }: { task: Milestone; actorUserId: string; onClose: () => void; onDone: () => void }) {
  const tz = useScheduleTz();
  const finishAt = finishMs(task);
  const finish = new Date(finishAt);
  const startAt = task.plannedStartAt ? Date.parse(task.plannedStartAt as string) : finishAt;
  // Work planned by the clock is sized in hours; date-only work in days.
  const timed = hasTimeOfDay(startAt, tz) || hasTimeOfDay(finishAt, tz);
  const [unit, setUnit] = useState<"hours" | "days">(timed ? "hours" : "days");
  const current = unit === "hours"
    ? Math.max(0.25, Math.round(((finishAt - startAt) / 3_600_000) * 4) / 4)
    : Math.max(1, dayDiff(new Date(startAt), finish, tz) + 1);
  const [value, setValue] = useState<number>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const days = value;

  const submit = async () => {
    if (!task.id) return;
    setBusy(true); setError(null);
    try {
      const res = await setTaskDuration(unit === "hours"
        ? { id: task.id, hours: value, timeZone: tz, actorUserId }
        : { id: task.id, days: Math.round(value), timeZone: tz, actorUserId });
      if (!res.ok) setError(res.error ?? "Couldn't set duration");
      else onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-sm bg-[var(--color-surface)] rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)] flex items-center justify-center"><CalendarRange className="w-4 h-4" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--color-text)] truncate">Set duration</h2>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">{task.name}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">How long it runs</label>
            <div className="inline-flex rounded-md bg-[var(--color-surface-2)] p-0.5 text-[11px] font-bold">
              {(["hours", "days"] as const).map((u) => (
                <button key={u} onClick={() => { setUnit(u); setValue(u === "hours" ? Math.max(0.25, Math.round(((finishAt - startAt) / 3_600_000) * 4) / 4) : Math.max(1, dayDiff(new Date(startAt), finish, tz) + 1)); }}
                  className={`px-2 py-0.5 rounded ${unit === u ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{u}</button>
              ))}
            </div>
          </div>
          <input type="number" min={unit === "hours" ? 0.25 : 1} max={unit === "hours" ? 2000 : 365} step={unit === "hours" ? 0.25 : 1} value={value}
            onChange={(e) => { const v = Number(e.target.value); setValue(Number.isFinite(v) && v > 0 ? v : unit === "hours" ? 0.25 : 1); }}
            className="w-full px-3 py-2 text-sm border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]/30" />
          <div className="text-[11px] text-[var(--color-text-muted)]">
            Keeps its finish, <b>{fmtInTz(finishAt, tz, { weekday: "short", month: "short", day: "numeric", ...(timed ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}) })}</b>;
            {unit === "hours" ? ` starts ${value} h before it.` : days > 1 ? ` starts ${Math.round(days) - 1} day${Math.round(days) - 1 === 1 ? "" : "s"} earlier.` : " a single-day task."}
          </div>
          {error && <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-md p-2">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5 transition-colors">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-4 py-2 rounded-md disabled:opacity-40 transition-colors">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarRange className="w-4 h-4" />} Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function statusTone(status: MilestoneStatus): { bar: string; border: string; dotBg: string; dotBorder: string } {
  switch (status) {
    case "completed":   return { bar: "bg-emerald-500", border: "border-emerald-600", dotBg: "bg-emerald-500", dotBorder: "border-emerald-500" };
    case "in_progress": return { bar: "bg-blue-500",    border: "border-blue-600",    dotBg: "bg-blue-500",    dotBorder: "border-blue-500" };
    case "blocked":     return { bar: "bg-rose-500",    border: "border-rose-600",    dotBg: "bg-rose-500",    dotBorder: "border-rose-500" };
    case "on_hold":     return { bar: "bg-amber-500",   border: "border-amber-600",   dotBg: "bg-amber-500",   dotBorder: "border-amber-500" };
    case "missed":      return { bar: "bg-rose-600",    border: "border-rose-700",    dotBg: "bg-rose-600",    dotBorder: "border-rose-600" };
    default:            return { bar: "bg-slate-400",   border: "border-slate-500",   dotBg: "bg-[var(--color-surface)]",       dotBorder: "border-[var(--color-border-strong)]" };
  }
}

// All schedule math runs in the PLANT's zone (the project timezone, via
// useScheduleTz) so every viewer sees the same day boundaries on the axis.
function startOfDayUTC(d: Date, tz: string): Date { return new Date(startOfDayTz(d.getTime(), tz)); }
function addDaysUTC(d: Date, n: number, tz: string): Date { return new Date(addDaysTz(d.getTime(), n, tz)); }
function dayDiff(a: Date, b: Date, tz: string): number { return dayDiffTz(a.getTime(), b.getTime(), tz); }
// Dates arrive as strings, Dates or epoch numbers — read them all.
function startMs(m: Milestone): number { return timedStart(m); }
function finishMs(m: Milestone): number { return timedFinish(m); }

function wbsCompare(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i]), y = Number(pb[i]);
    const xn = Number.isFinite(x), yn = Number.isFinite(y);
    if (xn && yn) { if (x !== y) return x - y; }
    else { const c = (pa[i] ?? "").localeCompare(pb[i] ?? ""); if (c) return c; }
  }
  return 0;
}


// Human labels are formatted in the plant's zone, the same zone the
// timeline geometry runs in, so the date printed under a task matches the
// axis tick it sits on for every viewer.
function fmtDateUTC(d: Date, tz: string): string {
  return fmtInTz(d, tz, { year: "numeric", month: "numeric", day: "numeric" });
}
