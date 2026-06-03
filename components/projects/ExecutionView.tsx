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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight as ChevronRightIcon, ChevronLeft,
  CalendarDays, CircleCheck, Loader2,
  FolderPlus, CalendarRange, X as XIcon, CheckSquare, Square,
  ZoomIn, ZoomOut, ListTree, Crosshair, Info, Zap, Eye, ListOrdered, Link2,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { groupTasksUnderParent, setTaskDuration } from "@/lib/milestones";
import { computeTreeMove, computeEdgeResize, computeSummaryResize, sequenceSiblings, cascadeDependents, type ReflowNode, type DateChange } from "@/lib/scheduleReflow";
import { computeCriticalPathLite } from "@/lib/criticalPath";
import { assignGroupColors, type GroupColor } from "@/lib/scheduleColors";
import SchedulePulse from "@/components/projects/SchedulePulse";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import ScheduleCalendarTileView from "@/components/projects/ScheduleCalendarTileView";
import StatusControl from "@/components/projects/StatusControl";
import ExecutionGuide from "@/components/projects/ExecutionGuide";
import ExecutionReportView from "@/components/projects/ExecutionReportView";
import MovePreviewSheet from "@/components/projects/MovePreviewSheet";
import UndoToastHost from "@/components/projects/UndoToastHost";
import { useUndoableActions } from "@/components/projects/useUndoableActions";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";

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
  /** Persist a batch of reflowed date changes (one drag can shift a
   *  subtree + bleed its ancestors). */
  onMoveMany?: (changes: DateChange[]) => Promise<boolean>;
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string) => Promise<boolean>;
}

// Day-width bounds (px). Auto-fit fills the available width; we never
// shrink a day below MIN_PX_PER_DAY (so labels stay legible — scroll
// horizontally instead) nor grow past MAX_PX_PER_DAY.
const MIN_PX_PER_DAY = 30;
const MAX_PX_PER_DAY = 240;
const ZOOM_STEP = 1.35;
const ROW_H = 40;     // height of each timeline row, px
const AXIS_H = 46;    // height of the date axis header, px
const LEFT_W = 320;   // width of the frozen outline column, px
const PAD_DAYS = 2;   // padding on each side of the schedule span

interface TreeNode { ms: Milestone; children: TreeNode[]; depth: number }
interface FlatRow { ms: Milestone; depth: number; hasChildren: boolean; done: number; total: number }

export default function ExecutionView({
  milestones, canEdit, orgId, projectId, userId, userName, userEmail, userRole,
  onRefresh, onMoveMany, onSetStatus,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [optimistic, setOptimistic] = useState<Map<string, MilestoneStatus>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const [durationFor, setDurationFor] = useState<Milestone | null>(null);
  // zoomFactor: null = auto-fit to the available width. A number is a
  // manual multiplier on the fitted width (1 = fit, >1 = zoomed in).
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ id: string; deltaDays: number } | null>(null);
  const [layout, setLayout] = useState<"timeline" | "calendar" | "report">("timeline");
  const [detailId, setDetailId] = useState<string | null>(null);
  // Keyboard navigation: the currently keyboard-focused timeline row.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Critical-path-lite highlight toggle.
  const [showCritical, setShowCritical] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const didCenter = useRef(false);

  // Undo/feedback — the safety net so a new user can act fearlessly.
  const { toasts, announce, notify, dismiss, runUndo } = useUndoableActions();

  // Measure the timeline viewport so the day width can fill it edge to
  // edge instead of a hardcoded guess. Re-measures on resize.
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Overlay optimistic status onto the raw list.
  const items = useMemo(() => {
    if (optimistic.size === 0) return milestones;
    return milestones.map((m) => (m.id && optimistic.has(m.id) ? { ...m, status: optimistic.get(m.id)! } : m));
  }, [milestones, optimistic]);

  // Drop optimistic entries once the server agrees.
  useEffect(() => {
    if (optimistic.size === 0) return;
    setOptimistic((prev) => {
      const next = new Map(prev);
      for (const m of milestones) if (m.id && next.get(m.id) === m.status) next.delete(m.id);
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

  // ── Search / filter ──────────────────────────────────────────
  const [filter, setFilter] = useState<ScheduleFilter>(EMPTY_FILTER);
  const filterOn = isFilterActive(filter);
  const visibleIds = useMemo(
    () => filterMilestones(items, filter),
    [items, filter],
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
    return Array.from(seen.values()).sort(cmpMilestone);
  }, [items, byId]);
  // Match count = leaf tasks that survive the filter.
  const matchStats = useMemo(() => {
    const isLeaf = (m: Milestone) => !m.id || (childrenOf.get(m.id) ?? []).length === 0;
    const leaves = items.filter(isLeaf);
    const shown = leaves.filter((m) => m.id && visibleIds.has(m.id)).length;
    return { shown, total: leaves.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, visibleIds]);

  // Critical-path-lite: the unfinished chain driving the finish date.
  const critical = useMemo(() => computeCriticalPathLite(items), [items]);

  // Group color assignment — a phase + all its children share one hue.
  const colors = useMemo(() => assignGroupColors(items), [items]);

  // Shown when a non-member taps a disabled status dot.
  const notifyViewOnly = useCallback(() => {
    notify("You're not a member of this project — ask the project owner to add you to update status or reschedule.", "warning");
  }, [notify]);

  // Build the forest. Roots = rows whose parent is missing/absent.
  // Siblings sort by execution time (start), then WBS, then name.
  const roots = useMemo(() => {
    const build = (ms: Milestone, depth: number): TreeNode => {
      const kids = (childrenOf.get(ms.id!) ?? []).slice().sort(cmpMilestone);
      return { ms, depth, children: kids.map((k) => build(k, depth + 1)) };
    };
    const top = items.filter((x) => !x.parentId || !byId.has(x.parentId)).sort(cmpMilestone);
    return top.map((m) => build(m, 0));
  }, [items, childrenOf, byId]);

  // Leaf-descendant progress for any node (a leaf counts as itself).
  const progressOf = useCallback((ms: Milestone): { done: number; total: number } => {
    const leaves: Milestone[] = [];
    const stack = [...(childrenOf.get(ms.id!) ?? [])];
    if (stack.length === 0) return { done: ms.status === "completed" ? 1 : 0, total: 1 };
    while (stack.length) {
      const cur = stack.pop()!;
      const kids = childrenOf.get(cur.id!) ?? [];
      if (kids.length === 0) leaves.push(cur);
      else stack.push(...kids);
    }
    return { done: leaves.filter((l) => l.status === "completed").length, total: leaves.length || 1 };
  }, [childrenOf]);

  // Flatten to the rows actually visible given collapse state.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const hasChildren = n.children.length > 0;
        const { done, total } = progressOf(n.ms);
        out.push({ ms: n.ms, depth: n.depth, hasChildren, done, total });
        if (hasChildren && n.ms.id && !collapsed.has(n.ms.id)) walk(n.children);
      }
    };
    walk(roots);
    return out;
  }, [roots, collapsed, progressOf]);

  // Date domain across the whole schedule.
  const domain = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const m of items) {
      const s = startMs(m), f = finishMs(m);
      if (Number.isFinite(s)) min = Math.min(min, s);
      if (Number.isFinite(f)) max = Math.max(max, f);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    const start = addDaysUTC(startOfDayUTC(new Date(min)), -PAD_DAYS);
    const end = addDaysUTC(startOfDayUTC(new Date(max)), PAD_DAYS);
    const totalDays = Math.max(1, dayDiff(start, end) + 1);
    return { start, end, totalDays };
  }, [items]);

  // The px/day that exactly fills the available timeline width with the
  // whole schedule (clamped so days never get unreadably narrow). This
  // is the "fit to screen" baseline.
  const fitPxPerDay = useMemo(() => {
    if (!domain) return MIN_PX_PER_DAY;
    const avail = Math.max(320, viewportW - LEFT_W);
    return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, avail / domain.totalDays));
  }, [domain, viewportW]);

  // Final day width: auto-fit by default, or the user's manual zoom
  // factor applied on top of the fitted baseline.
  const pxPerDay = useMemo(() => {
    const base = zoomFactor == null ? fitPxPerDay : fitPxPerDay * zoomFactor;
    return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, base));
  }, [zoomFactor, fitPxPerDay]);

  const timelineW = domain ? domain.totalDays * pxPerDay : 0;
  const today = useMemo(() => startOfDayUTC(new Date()), []);
  const todayX = domain ? (dayDiff(domain.start, today) + 0.5) * pxPerDay : -1;

  // Center the viewport on "today" (or schedule start) on first paint.
  useEffect(() => {
    if (didCenter.current || !scrollRef.current || !domain) return;
    const el = scrollRef.current;
    const inSpan = today >= domain.start && today <= domain.end;
    const target = inSpan ? todayX : 0;
    el.scrollLeft = Math.max(0, target - (el.clientWidth - LEFT_W) / 2);
    didCenter.current = true;
  }, [domain, today, todayX]);

  // ── Mutations ────────────────────────────────────────────────
  const setStatus = useCallback(async (id: string, next: MilestoneStatus, reason?: string) => {
    if (!canEdit || !onSetStatus) return;
    const prev = byId.get(id);                       // snapshot for undo
    const prevStatus = prev?.status;
    const name = prev?.name ?? "Task";
    setOptimistic((m) => new Map(m).set(id, next));
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetStatus(id, next, reason);
      if (!ok) { setOptimistic((m) => { const n = new Map(m); n.delete(id); return n; }); return; }
      if (prevStatus && prevStatus !== next) {
        announce(
          `“${truncate(name)}” → ${statusWord(next)}`,
          async () => {
            setOptimistic((m) => new Map(m).set(id, prevStatus));
            await onSetStatus(id, prevStatus);
          },
          next === "completed" ? "success" : "default",
        );
      }
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus, byId, announce]);

  // Bulk status across the selection (with one undo that restores each
  // task's prior status).
  // Bulk status for an explicit id set (used by both the timeline
  // selection and the calendar selection), with one undo.
  const bulkStatusIds = useCallback(async (ids: string[], next: MilestoneStatus) => {
    if (!canEdit || !onSetStatus || ids.length === 0) return;
    const prev = new Map<string, MilestoneStatus>();
    for (const id of ids) { const m = byId.get(id); if (m) prev.set(id, m.status); }
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
        announce(`${succeeded.length} task${succeeded.length === 1 ? "" : "s"} → ${statusWord(next)}`, async () => {
          setOptimistic((m) => { const n = new Map(m); for (const id of succeeded) { const st = prev.get(id); if (st) n.set(id, st); } return n; });
          await Promise.all(succeeded.map((id) => { const st = prev.get(id); return st ? onSetStatus(id, st) : Promise.resolve(true); }));
        }, next === "completed" ? "success" : "default");
      }
      setSelectedIds(new Set());
    } finally {
      setBusy((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus, byId, announce, notify]);

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
    const cascade = cascadeDependents(updated, primary.map((c) => c.id));
    if (cascade.length === 0) return primary;
    const merged = new Map(primary.map((c) => [c.id, c]));
    for (const c of cascade) merged.set(c.id, c);
    return Array.from(merged.values());
  }, [reflowNodes]);

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
      for (const c of computeTreeMove(reflowNodes, id, pm.deltaDays, mode)) {
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
  }, [pendingMove, onMoveMany, reflowNodes, byId, announce, withCascade]);

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
    const changes = withCascade(computeEdgeResize(reflowNodes, id, edge, deltaDays));
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
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, withCascade]);

  // Resize a SUMMARY/parent edge → proportionally stretch its subtree
  // ("extend the overall project"). Same commit+undo shape as resizeEdge.
  const resizeSummaryEdge = useCallback(async (id: string, edge: "start" | "finish", deltaDays: number) => {
    if (!canEdit || !onMoveMany || deltaDays === 0) return;
    const changes = withCascade(computeSummaryResize(reflowNodes, id, edge, deltaDays));
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
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, withCascade]);

  // Chain a phase's direct children finish-to-start (sequential steps), with
  // one undo. The pure layout is in sequenceSiblings.
  const sequencePhase = useCallback(async (parentId: string) => {
    if (!canEdit || !onMoveMany) return;
    const changes = withCascade(sequenceSiblings(reflowNodes, parentId));
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
  }, [canEdit, onMoveMany, reflowNodes, byId, announce, notify, withCascade]);

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
      if (next?.ms.id) { setFocusedId(next.ms.id); document.getElementById(`exec-row-${next.ms.id}`)?.scrollIntoView({ block: "nearest" }); }
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
    if (!canEdit || !onMoveMany || !ms.id || ms.isSummary) return;
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
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 text-center">
        <CalendarDays className="w-10 h-10 text-slate-300 mx-auto mb-3" />
        <div className="text-sm font-semibold text-slate-700">No dated tasks yet</div>
        <div className="text-xs text-slate-500 mt-1">Import a schedule or add a milestone to populate the execution board.</div>
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
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <Eye className="w-4 h-4 shrink-0 text-amber-600" />
          <span>
            <b>View only.</b> You&apos;re not a member of this project, so status and dates are read-only.
            Ask the project owner to add you as a member to make changes.
          </span>
        </div>
      )}

      <SchedulePulse
        milestones={items}
        onShowOverdue={() => { setLayout("timeline"); setFilter((f) => ({ ...EMPTY_FILTER, overdueOnly: true, query: f.query })); }}
        onShowBlocked={() => { setLayout("timeline"); setFilter((f) => ({ ...EMPTY_FILTER, blockedOnly: true, query: f.query })); }}
      />

      <div className="flex items-center gap-2">
        <SummaryStrip items={items} today={today} domain={domain} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
          {([["timeline", "Timeline"], ["calendar", "Calendar"], ["report", "Report"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setLayout(id)}
              className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${layout === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {layout === "timeline" && critical.ids.size > 0 && (
          <button
            onClick={() => setShowCritical((v) => !v)}
            title="Highlight the unfinished tasks driving the finish date"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold border transition-colors ${showCritical ? "bg-rose-600 text-white border-rose-600" : "bg-white text-rose-700 border-rose-200 hover:border-rose-400"}`}
          >
            <Zap className="w-3.5 h-3.5" /> Critical path
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
          <span className="font-black uppercase tracking-widest text-slate-400">Phases</span>
          {colors.groups.map((g) => {
            const c = colors.colorOf(g);
            return (
              <span key={g.id} className="inline-flex items-center gap-1.5">
                <span className={`w-2.5 h-2.5 rounded-sm ${c.rail}`} />
                <span className="font-medium text-slate-600 truncate max-w-[160px]">{g.name}</span>
              </span>
            );
          })}
        </div>
      )}

      {layout === "report" ? (
        <ExecutionReportView milestones={items} />
      ) : layout === "calendar" ? (
        <ScheduleCalendarTileView
          milestones={visibleItems}
          childrenByParent={childrenOf}
          canEdit={canEdit}
          onMoveDays={(id, days) => {
            const target = byId.get(id);
            if (target) void moveByDays(target, days);
          }}
          onSetStatus={onSetStatus}
          onBulkStatus={(ids, s) => void bulkStatusIds(ids, s)}
          onBulkMove={(ids, d) => bulkMoveIds(ids, d)}
          onOpenDetail={(m) => m.id && setDetailId(m.id)}
        />
      ) : (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
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
            el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - LEFT_W) / 2), behavior: "smooth" });
          }}
          onCollapseAll={collapseAll} onExpandAll={expandAll}
          selectedCount={selectedIds.size}
          onClearSelection={() => setSelectedIds(new Set())}
          onGroup={() => setGroupOpen(true)}
          onBulkStatus={(s) => void bulkStatus(s)}
          onBulkMove={(d) => bulkMove(d)}
        />

        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onTimelineKeyDown}
          className="overflow-auto relative outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/40 rounded-b-2xl"
          style={{ maxHeight: "70vh" }}
        >
          <div className="flex" style={{ width: LEFT_W + timelineW }}>
            {/* ── Frozen outline column ── */}
            <div className="sticky left-0 z-20 bg-white border-r border-slate-200 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]" style={{ width: LEFT_W }}>
              <div className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur border-b border-slate-200 flex items-center px-3 text-[10px] font-black uppercase tracking-widest text-slate-500" style={{ height: AXIS_H }}>
                <ListTree className="w-3.5 h-3.5 mr-1.5 text-indigo-500" /> Work breakdown
              </div>
              {rows.map((r) => (
                <OutlineRow
                  key={r.ms.id}
                  row={r}
                  color={colors.colorOf(r.ms)}
                  collapsed={!!r.ms.id && collapsed.has(r.ms.id)}
                  selected={!!r.ms.id && selectedIds.has(r.ms.id)}
                  focused={!!r.ms.id && focusedId === r.ms.id}
                  canEdit={canEdit}
                  busy={!!r.ms.id && busy.has(r.ms.id)}
                  onToggleCollapse={() => r.ms.id && toggleCollapse(r.ms.id)}
                  onToggleSelected={() => r.ms.id && toggleSelected(r.ms.id)}
                  onSetStatus={(s, reason) => { if (r.ms.id) void setStatus(r.ms.id, s, reason); }}
                  onSetDuration={() => setDurationFor(r.ms)}
                  onOpenDetail={() => r.ms.id && setDetailId(r.ms.id)}
                  onViewOnly={notifyViewOnly}
                  onSequence={() => r.ms.id && void sequencePhase(r.ms.id)}
                />
              ))}
            </div>

            {/* ── Timeline column ── */}
            <div className="relative" style={{ width: timelineW, height: AXIS_H + rows.length * ROW_H }}>
              <Axis domain={domain} pxPerDay={pxPerDay} />
              <Gridlines domain={domain} pxPerDay={pxPerDay} rowCount={rows.length} />
              <DependencyArrows rows={rows} domain={domain} pxPerDay={pxPerDay} />
              {todayX >= 0 && todayX <= timelineW && (
                <div className="absolute z-10 pointer-events-none" style={{ left: todayX, top: AXIS_H, bottom: 0, width: 0 }}>
                  <div className="absolute top-0 bottom-0 w-px bg-rose-500/80" />
                  <div className="absolute -top-0 -left-[3px] w-[7px] h-[7px] rounded-full bg-rose-500 shadow" />
                </div>
              )}
              {rows.map((r, i) => (
                <Bar
                  key={r.ms.id}
                  row={r}
                  top={AXIS_H + i * ROW_H}
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
                  critical={showCritical ? (r.ms.id ? critical.ids.has(r.ms.id) : false) : null}
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
          deltaDays={pendingMove.deltaDays}
          onCancel={() => setPendingMove(null)}
          onConfirm={(mode) => void commitMove(mode)}
        />
      )}

      {detailId && byId.get(detailId) && (
        <TaskDetailPanel
          milestone={byId.get(detailId)!}
          subtasks={(childrenOf.get(detailId) ?? []).slice().sort(cmpMilestone)}
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

function SummaryStrip({ items, today, domain }: {
  items: Milestone[]; today: Date;
  domain: { start: Date; end: Date; totalDays: number };
}) {
  const leaves = items.filter((m) => !items.some((c) => c.parentId === m.id));
  const total = leaves.length;
  const done = leaves.filter((m) => m.status === "completed").length;
  const inProg = leaves.filter((m) => m.status === "in_progress").length;
  const overdue = leaves.filter((m) => m.status !== "completed" && finishMs(m) < today.getTime()).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const elapsed = Math.max(0, Math.min(domain.totalDays, dayDiff(domain.start, today)));

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] px-4 py-3 flex items-center gap-5 flex-wrap">
      <div className="flex items-center gap-3 min-w-[200px]">
        <div className={`text-3xl font-black tracking-tighter ${pct === 100 ? "text-emerald-600" : "text-slate-900"}`}>{pct}<span className="text-base text-slate-400 font-bold">%</span></div>
        <div className="flex-1">
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden w-40">
            <div className={`h-full transition-all duration-500 ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-1">{done} / {total} tasks complete</div>
        </div>
      </div>
      <Stat label="In progress" value={inProg} tone="blue" />
      <Stat label="Overdue" value={overdue} tone={overdue > 0 ? "rose" : "slate"} />
      <Stat label="Schedule day" value={`${elapsed} / ${domain.totalDays}`} tone="slate" />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: "blue" | "rose" | "slate" }) {
  const c = tone === "blue" ? "text-blue-600" : tone === "rose" ? "text-rose-600" : "text-slate-700";
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</span>
      <span className={`text-lg font-black tabular-nums ${c}`}>{value}</span>
    </div>
  );
}

// ─── Toolbar ───────────────────────────────────────────────────

function Toolbar({
  canEdit, isAutoFit, canZoomIn, canZoomOut, onZoomIn, onZoomOut, onFit,
  onToday, onCollapseAll, onExpandAll,
  selectedCount, onClearSelection, onGroup, onBulkStatus, onBulkMove,
}: {
  canEdit: boolean;
  isAutoFit: boolean; canZoomIn: boolean; canZoomOut: boolean;
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
  onToday: () => void;
  onCollapseAll: () => void; onExpandAll: () => void;
  selectedCount: number; onClearSelection: () => void; onGroup: () => void;
  onBulkStatus: (s: MilestoneStatus) => void; onBulkMove: (deltaDays: number) => void;
}) {
  return (
    <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 flex-1 flex-wrap">
          <span className="text-xs font-bold text-indigo-900">{selectedCount} selected</span>
          {canEdit && (
            <>
              {/* Bulk status */}
              <div className="inline-flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Mark</span>
                {([["completed", "Done", "bg-emerald-600"], ["in_progress", "Doing", "bg-blue-600"], ["on_hold", "Hold", "bg-amber-600"], ["blocked", "Block", "bg-rose-600"]] as const).map(([s, label, bg]) => (
                  <button key={s} onClick={() => onBulkStatus(s)} className={`px-2 py-1 rounded-md text-white text-[11px] font-bold ${bg} hover:brightness-110`}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="w-px h-4 bg-slate-200" />
              {/* Bulk move */}
              <div className="inline-flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Move</span>
                <button onClick={() => onBulkMove(-1)} className="px-1.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 text-[11px] font-bold">−1d</button>
                <button onClick={() => onBulkMove(1)} className="px-1.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100 text-[11px] font-bold">+1d</button>
              </div>
              <span className="w-px h-4 bg-slate-200" />
              <button onClick={onGroup} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold">
                <FolderPlus className="w-3 h-3" /> Group
              </button>
            </>
          )}
          <button onClick={onClearSelection} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-slate-100 text-slate-600 text-[11px] font-bold ml-auto">
            <XIcon className="w-3 h-3" /> Clear
          </button>
        </div>
      ) : (
        <>
          <button onClick={onToday} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-700 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100 border border-slate-200">
            <Crosshair className="w-3.5 h-3.5 text-rose-500" /> Today
          </button>
          <div className="w-px h-5 bg-slate-200" />
          <button onClick={onExpandAll} className="text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100">Expand all</button>
          <button onClick={onCollapseAll} className="text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded-md hover:bg-slate-100">Collapse all</button>
          <div className="ml-auto inline-flex items-center gap-1">
            <button
              onClick={onZoomOut}
              disabled={!canZoomOut}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600 disabled:opacity-30"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={onFit}
              className={`text-[10px] font-bold px-2 py-1 rounded-md border ${isAutoFit ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "border-slate-200 text-slate-500 hover:bg-slate-100"}`}
              title="Fit the whole schedule to the screen width"
            >
              Fit
            </button>
            <button
              onClick={onZoomIn}
              disabled={!canZoomIn}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600 disabled:opacity-30"
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
  row, color, collapsed, selected, focused, canEdit, busy,
  onToggleCollapse, onToggleSelected, onSetStatus, onSetDuration, onOpenDetail, onViewOnly, onSequence,
}: {
  row: FlatRow; color: GroupColor; collapsed: boolean; selected: boolean; focused?: boolean; canEdit: boolean; busy: boolean;
  onToggleCollapse: () => void; onToggleSelected: () => void;
  onSetStatus: (s: MilestoneStatus, reason?: string) => void; onSetDuration: () => void; onOpenDetail: () => void;
  onViewOnly?: () => void; onSequence?: () => void;
}) {
  const { ms, depth, hasChildren, done, total } = row;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const checked = ms.status === "completed";
  const indent = 8 + depth * 16;

  return (
    <div
      id={ms.id ? `exec-row-${ms.id}` : undefined}
      className={`group relative flex items-center gap-1.5 border-b border-slate-100 pr-2 ${focused ? "ring-2 ring-inset ring-indigo-400 bg-indigo-50/40" : selected ? "bg-indigo-50/70" : checked ? "bg-emerald-50/30" : depth === 0 ? color.tint : "hover:bg-slate-50"}`}
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
        <button onClick={onToggleSelected} className="shrink-0 text-slate-300 hover:text-indigo-600" title={selected ? "Deselect" : "Select"}>
          {selected ? <CheckSquare className="w-4 h-4 text-indigo-600" /> : <Square className="w-4 h-4" />}
        </button>
      )}
      {hasChildren ? (
        <button onClick={onToggleCollapse} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-200" title={collapsed ? "Expand" : "Collapse"}>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} strokeWidth={2.5} />
        </button>
      ) : (
        <span className="shrink-0 w-5 inline-flex justify-center"><span className="w-1.5 h-1.5 rounded-full bg-slate-300" /></span>
      )}

      <StatusControl status={ms.status} busy={busy} disabled={!canEdit} onDisabledClick={onViewOnly} variant="dot" size="md" onPick={onSetStatus} />

      <button
        onClick={onOpenDetail}
        className="flex-1 min-w-0 text-left"
        title={`${ms.name} — open details`}
      >
        <div className={`truncate text-[13px] leading-tight ${checked ? "line-through text-slate-400" : ms.isSummary ? "font-bold text-slate-900" : "font-medium text-slate-700"}`}>
          {ms.name}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono leading-tight">
          {ms.wbs && <span className="text-slate-400">{ms.wbs}</span>}
          <span>{rangeLabel(ms)}</span>
          {(ms.dependsOn?.length ?? 0) > 0 && (
            <span className="inline-flex items-center gap-0.5 text-indigo-500 font-bold" title={`Depends on ${ms.dependsOn!.length} task${ms.dependsOn!.length === 1 ? "" : "s"} — can't start until they finish`}>
              <Link2 className="w-2.5 h-2.5" />{ms.dependsOn!.length}
            </span>
          )}
          {hasChildren && <span className={`${color.text} font-bold`}>{done}/{total}</span>}
        </div>
      </button>

      {hasChildren && (
        <div className="shrink-0 w-9 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${pct === 100 ? "bg-emerald-500" : color.rail}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {canEdit && !ms.isSummary && (
        <button onClick={onSetDuration} title="Set duration" className="shrink-0 p-1 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
          <CalendarRange className="w-3.5 h-3.5" />
        </button>
      )}
      {canEdit && hasChildren && onSequence && (
        <button onClick={onSequence} title="Sequence sub-tasks end-to-end (each starts when the prior finishes)" className="shrink-0 p-1 rounded text-slate-300 hover:text-indigo-700 hover:bg-indigo-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <ListOrdered className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Timeline bar (right) ──────────────────────────────────────

function Bar({
  row, top, domain, pxPerDay, canEdit, dragDelta,
  onPointerDown, onPointerMove, onPointerUp, onNudge, onResize, onOpenDetail, critical, color,
}: {
  row: FlatRow; top: number;
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
  const { ms, hasChildren, done, total } = row;
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

  const start = new Date(startMs(ms));
  const finish = new Date(finishMs(ms));
  const startIdx = dayDiff(domain.start, start);
  const spanDays = Math.max(1, dayDiff(start, finish) + 1);
  // Apply live resize preview to the rendered geometry.
  const previewStartShift = resize?.edge === "start" ? resize.days : 0;
  const previewSpanShift = resize?.edge === "finish" ? resize.days : (resize?.edge === "start" ? -resize.days : 0);
  const left = (startIdx + previewStartShift) * pxPerDay + dragDelta * pxPerDay;
  const width = Math.max(pxPerDay * 0.7, (spanDays + previewSpanShift) * pxPerDay - 2);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tone = statusTone(ms.status);
  const draggable = canEdit && !ms.isSummary;
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
              className="absolute -left-1.5 top-0 bottom-0 w-3.5 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 flex items-center justify-center"
            >
              <span className={`w-1.5 h-4 rounded ${color.rail} brightness-75 hover:brightness-50`} />
            </span>
            <span
              onPointerDown={onEdgeDown("finish")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to extend / shorten the phase finish"
              className="absolute -right-1.5 top-0 bottom-0 w-3.5 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 flex items-center justify-center"
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

  return (
    <div className={`absolute group/bar flex items-center transition-opacity ${dimmed ? "opacity-25" : ""} ${onPath ? "z-10" : ""}`} style={{ top: top + 6, left, width, height: ROW_H - 12 }}>
      {draggable && (
        <button onClick={() => onNudge(-1)} className="absolute -left-5 opacity-0 group-hover/bar:opacity-100 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-opacity" title="Move back 1 day">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`relative w-full h-full rounded-md border ${tone.border} ${tone.bar} shadow-sm overflow-hidden ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragDelta !== 0 || resize ? "ring-2 ring-indigo-400 z-20" : onPath ? "ring-2 ring-rose-500 ring-offset-1" : ""}`}
        title={`${ms.name}\n${start.toLocaleDateString()} → ${finish.toLocaleDateString()}${dragDelta ? `\nmove ${dragDelta > 0 ? "+" : ""}${dragDelta}d` : ""}${resize ? `\nresize ${resize.days > 0 ? "+" : ""}${resize.days}d` : ""}`}
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
              className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 bg-white/40 hover:bg-white/70 border-r border-white/50"
            />
            <span
              onPointerDown={onEdgeDown("finish")} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}
              title="Drag to change the finish (duration)"
              className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 bg-white/40 hover:bg-white/70 border-l border-white/50"
            />
          </>
        )}
      </div>
      {/* Narrow bar: label spills to the right, outside the clip region. */}
      {!labelFits && (
        <span
          className="absolute left-full ml-1.5 whitespace-nowrap text-[10px] font-semibold text-slate-700 pointer-events-none"
          style={{ top: "50%", transform: "translateY(-50%)" }}
        >
          {ms.name}
        </span>
      )}
      {draggable && (
        <button onClick={() => onNudge(1)} className="absolute -right-5 opacity-0 group-hover/bar:opacity-100 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-opacity" title="Move forward 1 day">
          <ChevronRightIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Axis + gridlines ──────────────────────────────────────────

function Axis({ domain, pxPerDay }: { domain: { start: Date; totalDays: number }; pxPerDay: number }) {
  // Choose a tick step that keeps labels legible at the current zoom.
  const step = pxPerDay >= 60 ? 1 : pxPerDay >= 34 ? 2 : pxPerDay >= 16 ? 7 : pxPerDay >= 8 ? 14 : 30;
  const ticks: Array<{ x: number; label: string }> = [];
  for (let d = 0; d < domain.totalDays; d += step) {
    const date = addDaysUTC(domain.start, d);
    ticks.push({
      x: d * pxPerDay,
      label: step >= 28
        ? date.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    });
  }
  return (
    <div className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur border-b border-slate-200" style={{ height: AXIS_H }}>
      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 bottom-0 flex flex-col justify-center" style={{ left: t.x }}>
          <div className="absolute top-0 bottom-0 w-px bg-slate-200" />
          <span className="pl-1 text-[9px] font-mono text-slate-500 whitespace-nowrap">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

function Gridlines({ domain, pxPerDay, rowCount }: { domain: { start: Date; totalDays: number }; pxPerDay: number; rowCount: number }) {
  const step = pxPerDay >= 60 ? 1 : pxPerDay >= 34 ? 2 : pxPerDay >= 16 ? 7 : pxPerDay >= 8 ? 14 : 30;
  const lines: React.ReactNode[] = [];
  for (let d = 0; d < domain.totalDays; d += step) {
    const date = addDaysUTC(domain.start, d);
    const weekend = pxPerDay >= 12 && (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    lines.push(
      <div key={d} className={`absolute top-0 bottom-0 ${weekend ? "bg-slate-50" : ""}`} style={{ left: d * pxPerDay, width: step * pxPerDay }}>
        <div className="absolute top-0 bottom-0 left-0 w-px bg-slate-100" />
      </div>,
    );
  }
  return <div className="absolute pointer-events-none" style={{ top: AXIS_H, left: 0, right: 0, height: rowCount * ROW_H }}>{lines}</div>;
}

// ─── Dependency arrows (finish-to-start connectors) ─────────────

function DependencyArrows({ rows, domain, pxPerDay }: {
  rows: FlatRow[];
  domain: { start: Date; end: Date; totalDays: number };
  pxPerDay: number;
}) {
  const indexById = new Map<string, number>();
  rows.forEach((r, i) => { if (r.ms.id) indexById.set(r.ms.id, i); });

  const geom = (r: FlatRow, i: number) => {
    const s = new Date(startMs(r.ms));
    const f = new Date(finishMs(r.ms));
    const startIdx = dayDiff(domain.start, s);
    const span = Math.max(1, dayDiff(s, f) + 1);
    return {
      leftX: startIdx * pxPerDay,
      rightX: (startIdx + span) * pxPerDay - 2,
      midY: AXIS_H + i * ROW_H + ROW_H / 2,
    };
  };

  const paths: React.ReactNode[] = [];
  rows.forEach((r, i) => {
    for (const predId of r.ms.dependsOn ?? []) {
      const pi = indexById.get(predId);
      if (pi === undefined) continue;          // predecessor not visible (collapsed/filtered)
      const pred = geom(rows[pi], pi);
      const succ = geom(r, i);
      // Elbow connector: out of the predecessor's finish, down/up to the
      // successor's row, into its start edge (arrowhead).
      const x1 = pred.rightX, y1 = pred.midY;
      const x2 = succ.leftX, y2 = succ.midY;
      const outX = x1 + 7;
      const d = `M ${x1} ${y1} L ${outX} ${y1} L ${outX} ${y2} L ${x2} ${y2}`;
      paths.push(
        <path
          key={`${predId}->${r.ms.id ?? i}`}
          d={d}
          fill="none"
          stroke="#6366f1"
          strokeWidth={1.5}
          strokeOpacity={0.55}
          markerEnd="url(#dep-arrowhead)"
        />,
      );
    }
  });

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

function Legend() {  const entries: Array<[MilestoneStatus, string]> = [
    ["planned", "Planned"], ["in_progress", "In progress"], ["completed", "Done"], ["on_hold", "On hold"], ["blocked", "Blocked"], ["missed", "Missed"],
  ];
  return (
    <div className="px-3 py-2 border-t border-slate-200 bg-slate-50/60 flex items-center gap-3 flex-wrap">
      {entries.map(([s, label]) => (
        <span key={s} className="inline-flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className={`w-2.5 h-2.5 rounded-sm ${statusTone(s).bar}`} /> {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-500 ml-auto">
        <Info className="w-3 h-3" /> Drag a bar or ◀ ▶ to reschedule · click the dot for status ·
        <kbd className="px-1 rounded bg-white border border-slate-300 font-mono">↑↓</kbd> navigate
        <kbd className="px-1 rounded bg-white border border-slate-300 font-mono">←→</kbd> move
        <kbd className="px-1 rounded bg-white border border-slate-300 font-mono">↵</kbd> open
      </span>
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
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center"><FolderPlus className="w-4 h-4" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Group under a parent</h2>
            <div className="text-[11px] text-slate-600">{childIds.length} task{childIds.length === 1 ? "" : "s"} selected</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
            {(["new", "existing"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                {m === "new" ? "Create new" : "Use existing"}
              </button>
            ))}
          </div>
          {mode === "new" ? (
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "Phase 2 — Tear Down"' autoFocus className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400" />
          ) : existingParents.length === 0 ? (
            <div className="text-xs text-slate-500 italic">No existing parents — create a new one.</div>
          ) : (
            <select value={existingId} onChange={(e) => setExistingId(e.target.value)} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30">
              <option value="">— pick a parent —</option>
              {existingParents.map((p) => <option key={p.id} value={p.id ?? ""}>{p.name}</option>)}
            </select>
          )}
          <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 max-h-32 overflow-y-auto">
            <ul className="space-y-0.5">
              {childNames.slice(0, 12).map((n, i) => <li key={i} className="text-[11px] text-slate-700 truncate">{n}</li>)}
              {childNames.length > 12 && <li className="text-[10px] text-slate-500 italic">+{childNames.length - 12} more</li>}
            </ul>
          </div>
          {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button onClick={submit} disabled={!canSubmit || busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md disabled:opacity-40">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />} Group
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Duration modal ────────────────────────────────────────────

function SetDurationModal({ task, actorUserId, onClose, onDone }: { task: Milestone; actorUserId: string; onClose: () => void; onDone: () => void }) {
  const finish = new Date(finishMs(task));
  const startStored = task.plannedStartAt ? new Date(task.plannedStartAt as string) : null;
  const current = startStored ? Math.max(1, dayDiff(startStored, finish) + 1) : 1;
  const [days, setDays] = useState(current);
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
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl ring-1 ring-slate-900/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center"><CalendarRange className="w-4 h-4" /></div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 truncate">Set duration</h2>
            <div className="text-[11px] text-slate-600 truncate">{task.name}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500"><XIcon className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Days the task runs</label>
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30" />
          <div className="text-[11px] text-slate-500">Ends on <b>{finish.toLocaleDateString()}</b>. {days > 1 ? `Starts ${days - 1} day${days - 1 === 1 ? "" : "s"} earlier.` : "Single-day task."}</div>
          {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50/60 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md disabled:opacity-40">
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
    default:            return { bar: "bg-slate-400",   border: "border-slate-500",   dotBg: "bg-white",       dotBorder: "border-slate-300" };
  }
}

// All schedule math runs in UTC so the ISO string in the database is
// exactly what lands on the axis, regardless of the viewer's timezone.
function startOfDayUTC(d: Date): Date { const c = new Date(d); c.setUTCHours(0, 0, 0, 0); return c; }
function addDaysUTC(d: Date, n: number): Date { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }
function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDayUTC(b).getTime() - startOfDayUTC(a).getTime()) / 86400000);
}
function startMs(m: Milestone): number {
  const s = (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string);
  return Date.parse(s);
}
function finishMs(m: Milestone): number { return Date.parse(m.plannedAt as string); }

function cmpMilestone(a: Milestone, b: Milestone): number {
  const d = startMs(a) - startMs(b);
  if (d) return d;
  const w = wbsCompare(a.wbs, b.wbs);
  if (w) return w;
  return (a.name || "").localeCompare(b.name || "");
}

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

function rangeLabel(m: Milestone): string {
  const s = new Date(startMs(m)), f = new Date(finishMs(m));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const span = dayDiff(s, f) + 1;
  if (span <= 1) return fmt(f);
  return `${fmt(s)} – ${fmt(f)} · ${span}d`;
}
