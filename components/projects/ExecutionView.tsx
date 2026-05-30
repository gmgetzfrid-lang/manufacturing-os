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
  CalendarDays, AlertTriangle, CircleCheck, Circle, Loader2,
  FolderPlus, CalendarRange, X as XIcon, CheckSquare, Square,
  ZoomIn, ZoomOut, ListTree, Crosshair, Info,
} from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { groupTasksUnderParent, setTaskDuration } from "@/lib/milestones";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import ScheduleCalendarTileView from "@/components/projects/ScheduleCalendarTileView";

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

// px-per-day zoom levels. Index into ZOOMS; default chosen from span.
const ZOOMS: number[] = [4, 8, 14, 26, 48];
const ROW_H = 40;     // height of each timeline row, px
const AXIS_H = 46;    // height of the date axis header, px
const LEFT_W = 320;   // width of the frozen outline column, px
const PAD_DAYS = 2;   // padding on each side of the schedule span

interface TreeNode { ms: Milestone; children: TreeNode[]; depth: number }
interface FlatRow { ms: Milestone; depth: number; hasChildren: boolean; done: number; total: number }

export default function ExecutionView({
  milestones, canEdit, orgId, projectId, userId, userName, userEmail, userRole,
  onRefresh, onMove, onSetStatus,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [optimistic, setOptimistic] = useState<Map<string, MilestoneStatus>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const [durationFor, setDurationFor] = useState<Milestone | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null = auto
  const [drag, setDrag] = useState<{ id: string; deltaDays: number } | null>(null);
  const [layout, setLayout] = useState<"timeline" | "calendar">("timeline");
  const [detailId, setDetailId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const didCenter = useRef(false);

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

  const pxPerDay = useMemo(() => {
    if (zoom != null) return ZOOMS[zoom];
    if (!domain) return 14;
    // Auto: aim for a ~1100px-wide timeline, clamped to the zoom set.
    const ideal = 1100 / domain.totalDays;
    let best = ZOOMS[0];
    for (const z of ZOOMS) if (z <= ideal) best = z;
    return best;
  }, [zoom, domain]);

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
  const cycleStatus = useCallback(async (id: string, current: MilestoneStatus) => {
    if (!canEdit || !onSetStatus) return;
    const next: MilestoneStatus =
      current === "planned" ? "in_progress" :
      current === "in_progress" ? "completed" :
      current === "completed" ? "planned" : "in_progress";
    setOptimistic((m) => new Map(m).set(id, next));
    setBusy((s) => new Set(s).add(id));
    try {
      const ok = await onSetStatus(id, next);
      if (!ok) setOptimistic((m) => { const n = new Map(m); n.delete(id); return n; });
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }, [canEdit, onSetStatus]);

  const moveByDays = useCallback(async (ms: Milestone, deltaDays: number) => {
    if (!canEdit || !onMove || deltaDays === 0 || !ms.id) return;
    const start = new Date(startMs(ms));
    const finish = new Date(finishMs(ms));
    const ns = addDaysUTC(start, deltaDays);
    const nf = addDaysUTC(finish, deltaDays);
    setBusy((s) => new Set(s).add(ms.id!));
    try { await onMove(ms.id, ns.toISOString(), nf.toISOString()); }
    finally { setBusy((s) => { const n = new Set(s); n.delete(ms.id!); return n; }); }
  }, [canEdit, onMove]);

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

  // ── Drag a bar to reschedule ─────────────────────────────────
  const dragState = useRef<{ id: string; ms: Milestone; startX: number } | null>(null);
  const onBarPointerDown = useCallback((e: React.PointerEvent, ms: Milestone) => {
    if (!canEdit || !onMove || !ms.id || ms.isSummary) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { id: ms.id, ms, startX: e.clientX };
    setDrag({ id: ms.id, deltaDays: 0 });
  }, [canEdit, onMove]);
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
      <div className="flex items-center gap-2">
        <SummaryStrip items={items} today={today} domain={domain} />
      </div>

      <div className="inline-flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5 self-start">
        {([["timeline", "Timeline"], ["calendar", "Calendar"]] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setLayout(id)}
            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${layout === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {layout === "calendar" ? (
        <ScheduleCalendarTileView
          milestones={items}
          childrenByParent={childrenOf}
          canEdit={canEdit}
          onMove={onMove}
          onOpenDetail={(m) => m.id && setDetailId(m.id)}
        />
      ) : (
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/[0.03] overflow-hidden flex flex-col">
        <Toolbar
          canEdit={canEdit}
          zoom={zoom} pxPerDay={pxPerDay} onZoom={setZoom}
          onToday={() => {
            const el = scrollRef.current; if (!el) return;
            el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - LEFT_W) / 2), behavior: "smooth" });
          }}
          onCollapseAll={collapseAll} onExpandAll={expandAll}
          selectedCount={selectedIds.size}
          onClearSelection={() => setSelectedIds(new Set())}
          onGroup={() => setGroupOpen(true)}
        />

        <div ref={scrollRef} className="overflow-auto relative" style={{ maxHeight: "70vh" }}>
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
                  collapsed={!!r.ms.id && collapsed.has(r.ms.id)}
                  selected={!!r.ms.id && selectedIds.has(r.ms.id)}
                  canEdit={canEdit}
                  busy={!!r.ms.id && busy.has(r.ms.id)}
                  onToggleCollapse={() => r.ms.id && toggleCollapse(r.ms.id)}
                  onToggleSelected={() => r.ms.id && toggleSelected(r.ms.id)}
                  onCycleStatus={() => r.ms.id && cycleStatus(r.ms.id, r.ms.status)}
                  onSetDuration={() => setDurationFor(r.ms)}
                  onOpenDetail={() => r.ms.id && setDetailId(r.ms.id)}
                />
              ))}
            </div>

            {/* ── Timeline column ── */}
            <div className="relative" style={{ width: timelineW, height: AXIS_H + rows.length * ROW_H }}>
              <Axis domain={domain} pxPerDay={pxPerDay} />
              <Gridlines domain={domain} pxPerDay={pxPerDay} rowCount={rows.length} />
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
                  onOpenDetail={() => r.ms.id && setDetailId(r.ms.id)}
                />
              ))}
            </div>
          </div>
        </div>

        <Legend />
      </div>
      )}

      {detailId && byId.get(detailId) && (
        <TaskDetailPanel
          milestone={byId.get(detailId)!}
          subtasks={(childrenOf.get(detailId) ?? []).slice().sort(cmpMilestone)}
          childCount={(id) => (childrenOf.get(id) ?? []).length}
          ancestors={ancestorsOf(byId.get(detailId)!)}
          canEdit={canEdit}
          userId={userId} userName={userName} userEmail={userEmail} userRole={userRole}
          onClose={() => setDetailId(null)}
          onChanged={onRefresh}
          onSelectSubtask={(m) => m.id && setDetailId(m.id)}
          onSelectMilestone={(m) => m.id && setDetailId(m.id)}
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
    </div>
  );
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
  canEdit, zoom, pxPerDay, onZoom, onToday, onCollapseAll, onExpandAll,
  selectedCount, onClearSelection, onGroup,
}: {
  canEdit: boolean;
  zoom: number | null; pxPerDay: number;
  onZoom: (z: number | null) => void;
  onToday: () => void;
  onCollapseAll: () => void; onExpandAll: () => void;
  selectedCount: number; onClearSelection: () => void; onGroup: () => void;
}) {
  const curIdx = zoom ?? ZOOMS.indexOf(pxPerDay);
  return (
    <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 flex-wrap bg-gradient-to-b from-white to-slate-50/40">
      {selectedCount > 0 ? (
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs font-bold text-indigo-900">{selectedCount} selected</span>
          {canEdit && (
            <button onClick={onGroup} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold">
              <FolderPlus className="w-3 h-3" /> Group under parent
            </button>
          )}
          <button onClick={onClearSelection} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-slate-100 text-slate-600 text-[11px] font-bold">
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
              onClick={() => onZoom(Math.max(0, curIdx - 1))}
              disabled={curIdx <= 0}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600 disabled:opacity-30"
              title="Zoom out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-[10px] font-mono text-slate-400 w-10 text-center">{pxPerDay}px/d</span>
            <button
              onClick={() => onZoom(Math.min(ZOOMS.length - 1, curIdx + 1))}
              disabled={curIdx >= ZOOMS.length - 1}
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
  row, collapsed, selected, canEdit, busy,
  onToggleCollapse, onToggleSelected, onCycleStatus, onSetDuration, onOpenDetail,
}: {
  row: FlatRow; collapsed: boolean; selected: boolean; canEdit: boolean; busy: boolean;
  onToggleCollapse: () => void; onToggleSelected: () => void;
  onCycleStatus: () => void; onSetDuration: () => void; onOpenDetail: () => void;
}) {
  const { ms, depth, hasChildren, done, total } = row;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const checked = ms.status === "completed";

  return (
    <div
      className={`group flex items-center gap-1.5 border-b border-slate-100 pr-2 ${selected ? "bg-indigo-50/70" : checked ? "bg-emerald-50/30" : "hover:bg-slate-50"}`}
      style={{ height: ROW_H, paddingLeft: 8 + depth * 14 }}
    >
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

      <StatusDot status={ms.status} busy={busy} disabled={!canEdit || ms.isSummary} onClick={onCycleStatus} />

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
          {hasChildren && <span className="text-indigo-500 font-bold">{done}/{total}</span>}
        </div>
      </button>

      {hasChildren && (
        <div className="shrink-0 w-9 h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {canEdit && !ms.isSummary && (
        <button onClick={onSetDuration} title="Set duration" className="shrink-0 p-1 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 opacity-0 group-hover:opacity-100 transition-opacity">
          <CalendarRange className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── Timeline bar (right) ──────────────────────────────────────

function Bar({
  row, top, domain, pxPerDay, canEdit, dragDelta,
  onPointerDown, onPointerMove, onPointerUp, onNudge, onOpenDetail,
}: {
  row: FlatRow; top: number;
  domain: { start: Date; end: Date; totalDays: number };
  pxPerDay: number; canEdit: boolean; dragDelta: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onNudge: (deltaDays: number) => void;
  onOpenDetail: () => void;
}) {
  const { ms, hasChildren, done, total } = row;
  const start = new Date(startMs(ms));
  const finish = new Date(finishMs(ms));
  const startIdx = dayDiff(domain.start, start);
  const spanDays = Math.max(1, dayDiff(start, finish) + 1);
  const left = startIdx * pxPerDay + dragDelta * pxPerDay;
  const width = Math.max(pxPerDay * 0.7, spanDays * pxPerDay - 2);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const tone = statusTone(ms.status);
  const draggable = canEdit && !ms.isSummary;

  // Summary tasks render as a slim bracket; leaves as a solid bar with
  // a progress fill. Milestones (zero-width spans) get a diamond.
  if (ms.isSummary || hasChildren) {
    return (
      <div className="absolute flex items-center cursor-pointer" style={{ top, left, width, height: ROW_H }} onClick={onOpenDetail} title={`${ms.name} — open details`}>
        <div className="relative w-full h-2 self-center mt-0">
          <div className={`absolute inset-0 rounded-full ${tone.bar} opacity-80`} />
          <div className="absolute -left-px -top-1 w-[3px] h-4 rounded-sm bg-slate-700/70" />
          <div className="absolute -right-px -top-1 w-[3px] h-4 rounded-sm bg-slate-700/70" />
          <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="absolute group/bar flex items-center" style={{ top: top + 6, left, width, height: ROW_H - 12 }}>
      {draggable && (
        <button onClick={() => onNudge(-1)} className="absolute -left-5 opacity-0 group-hover/bar:opacity-100 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-opacity" title="Move back 1 day">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`relative w-full h-full rounded-md border ${tone.border} ${tone.bar} shadow-sm overflow-hidden ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragDelta !== 0 ? "ring-2 ring-indigo-400 z-20" : ""}`}
        title={`${ms.name}\n${start.toLocaleDateString()} → ${finish.toLocaleDateString()}${dragDelta ? `\nmove ${dragDelta > 0 ? "+" : ""}${dragDelta}d` : ""}`}
      >
        <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${pct}%` }} />
        <div className="relative h-full flex items-center px-1.5 gap-1">
          {ms.status === "completed" && <CircleCheck className="w-3 h-3 text-white shrink-0" />}
          <span className="truncate text-[10px] font-semibold text-white drop-shadow-sm">{ms.name}</span>
        </div>
      </div>
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
  const step = pxPerDay >= 26 ? 1 : pxPerDay >= 12 ? 7 : pxPerDay >= 6 ? 14 : 30;
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
  const step = pxPerDay >= 26 ? 1 : pxPerDay >= 12 ? 7 : pxPerDay >= 6 ? 14 : 30;
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

// ─── Status affordances ────────────────────────────────────────

function StatusDot({ status, busy, disabled, onClick }: { status: MilestoneStatus; busy: boolean; disabled?: boolean; onClick: () => void }) {
  const t = statusTone(status);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      disabled={disabled}
      title={disabled ? STATUS_LABEL[status] : `${STATUS_LABEL[status]} — click to advance`}
      className={`shrink-0 w-5 h-5 rounded-full border-2 inline-flex items-center justify-center transition-all ${t.dotBorder} ${t.dotBg} ${disabled ? "opacity-70 cursor-default" : "hover:scale-110 active:scale-95"}`}
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin text-white" />
        : status === "completed" ? <CircleCheck className="w-3 h-3 text-white" />
        : status === "in_progress" ? <span className="w-1.5 h-1.5 rounded-full bg-white" />
        : (status === "missed" || status === "blocked") ? <AlertTriangle className="w-2.5 h-2.5 text-white" />
        : <Circle className="w-2 h-2 text-transparent" />}
    </button>
  );
}

function Legend() {
  const entries: Array<[MilestoneStatus, string]> = [
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
        <Info className="w-3 h-3" /> Drag a bar or use ◀ ▶ to reschedule · click the dot to advance status
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
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
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
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
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

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  planned: "Planned", in_progress: "In progress", completed: "Done", missed: "Missed", blocked: "Blocked", on_hold: "On hold",
};

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
