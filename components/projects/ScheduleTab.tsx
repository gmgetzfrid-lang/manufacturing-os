"use client";

// ScheduleTab — Phase 7 milestones UI on the project page.
//
// Self-contained: does its own milestone fetch + mutations so the
// parent page (already large) doesn't need to thread milestone state
// through. Three sections, top to bottom:
//
//   1. Earned-value widget   — planned vs earned weight, SPI,
//                              forecast end-date if behind.
//   2. Milestone list        — chronological by planned_at.
//                              Inline status chip + "Mark done"
//                              affordance; ghost rows visually
//                              distinguished.
//   3. Add + Import controls — Add: inline form, single click for
//                              the common case. Import: CSV-paste
//                              modal for P6/MSProject ghost rows.
//
// All mutations route through lib/milestones.ts → audit_logs →
// Phase 3 timeline. We don't reach into supabase directly here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, Plus, Loader2, AlertTriangle, Check, X, Calendar, ChevronDown, Upload, ArrowRight, Eye, EyeOff, Layers } from "lucide-react";
import {
  listMilestones, createMilestone, setMilestoneStatus, setMilestoneProgress, deleteMilestone,
  applyMilestoneMoves, computeScheduleMetrics, setBaseline, planMilestoneDelete, currentBaselineSummary, baselineHistoryAvailable,
} from "@/lib/milestones";
import { isImportedMilestone, isOverdueMilestone } from "@/lib/milestoneLiveness";
import { supabase } from "@/lib/supabase";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { appConfirm } from "@/components/providers/DialogProvider";
import Spinner from "@/components/ui/Spinner";
import HelpTooltip from "@/components/ui/HelpTooltip";
import FirstRunHint from "@/components/ui/FirstRunHint";
import ScheduleProgress from "@/components/projects/ScheduleProgress";
import { useScheduleNow } from "@/components/projects/useScheduleNow";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";
import ScheduleEmptyState from "@/components/projects/ScheduleEmptyState";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";
import { buildProgressIndex, type ProgressInfo } from "@/lib/scheduleProgress";
import RebaseScheduleModal from "@/components/projects/RebaseScheduleModal";
import { ClipboardList, PlayCircle } from "lucide-react";
import ExecutionView, { type MoveOutcome } from "@/components/projects/ExecutionView";

// Two modes only: Planning (build & manage the schedule as a list) and
// Execution (run it — the timeline/calendar board). The old Gantt and
// standalone Calendar views were removed: Gantt added no value over the
// timeline, and the calendar now lives inside Execution.
type ScheduleView = "planning" | "execution";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);
const STATUS_OPTIONS: MilestoneStatus[] = ["planned", "in_progress", "completed", "on_hold", "blocked", "missed"];

interface ScheduleTabProps {
  orgId: string;
  projectId: string;
  /** Surfaced in the import modal header so users can't be confused
   *  about which project the schedule is being written into. */
  projectName?: string;
  projectStatus?: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  /** The project's owner can always edit their own schedule, whatever
   *  their org role — ownership was previously ignored here, so an
   *  Engineer who owned the project could delete it but not plan it. */
  isProjectOwner?: boolean;
}

export default function ScheduleTab({ orgId, projectId, projectName, projectStatus, userId, userName, userEmail, userRole, isProjectOwner }: ScheduleTabProps) {
  const canEdit = !!isProjectOwner || (!!userRole && ADMIN_ROLES.has(userRole));

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  // ONE "now" for the progress card, every row's overdue flag and the
  // overdue filter, moved to a new UTC day at midnight, when the page is
  // shown or focused again, and when a reload lands on a later day (PT SCH-5).
  const nowMs = useScheduleNow(milestones);
  // What the last ACTION said (a refused move, a failed delete …). A reload
  // never clears it — every handler follows its message with a reload, and a
  // realtime event reloads at any moment (PT SCH-7 / SCH-17 review): only the
  // next action, or Dismiss, does. A failed LOAD is its own message, cleared
  // by the next load that works.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ScheduleView>("execution");

  // Background-safe refresh. Crucially it does NOT flip `loading` on its own:
  // the render gate for ExecutionView is `!loading`, so toggling loading here
  // would unmount ExecutionView mid-session and reset its internal view state —
  // that's exactly what kicked the user out of the Calendar layout back to
  // Timeline whenever they changed a task's status. We only show the full
  // loading state on the very first load (initialized true), then keep the view
  // mounted and let the data update in place.
  const refresh = useCallback(async () => {
    try {
      const list = await listMilestones({ orgId, projectId, includeGhost: true });
      setMilestones(list);
      setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The rows as last loaded — each batch move sends their updated_at as its
  // optimistic lock, so a row someone else changed since this view loaded is
  // rejected instead of silently overwritten (PT SCH-7).
  const milestonesRef = useRef<Milestone[]>(milestones);
  useEffect(() => { milestonesRef.current = milestones; }, [milestones]);

  // Live multi-user sync: another planner's edits stream in (debounced).
  // Needs `milestones` in the supabase_realtime publication (migration
  // 20261106 — until it is applied no event arrives and the lock above is
  // what stops a silent overwrite). INSERT / UPDATE carry project_id, so they
  // are filtered server-side, and Realtime checks RLS on them. DELETE is NOT
  // subscribed: Supabase does not apply RLS to DELETE events, so a DELETE
  // listener would receive the id of every milestone deleted in every
  // workspace. A colleague's delete shows on the next reload — at once when
  // the deleted row had sub-tasks or dependents, because deleteMilestone
  // updates those rows (an UPDATE event in this project).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 600);
    };
    const channel = supabase
      .channel(`milestones-${projectId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "milestones", filter: `project_id=eq.${projectId}` },
        later)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "milestones", filter: `project_id=eq.${projectId}` },
        later)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [projectId, refresh]);

  // Filtered view (toggle for ghost rows) — a DISPLAY filter only (PT SCH-6):
  // every metric, rollup and leaf-ness is computed over ALL milestones —
  // ghost rows ARE commitments from the imported schedule (lib/
  // milestoneLiveness is the one place that says so, and the health snapshot
  // and the printed report read the same rule). The Execution board gets the
  // full list and hides the rows itself.
  const ghostFiltered = useMemo(() => showGhost ? milestones : milestones.filter((m) => !isImportedMilestone(m)), [milestones, showGhost]);

  // Search / filter for the Planning list (reuses the Execution engine).
  const [planFilter, setPlanFilter] = useState<ScheduleFilter>(EMPTY_FILTER);
  const planFilterOn = isFilterActive(planFilter);
  const visible = useMemo(() => {
    if (!planFilterOn) return ghostFiltered;
    const keep = filterMilestones(ghostFiltered, planFilter, { now: nowMs });
    return ghostFiltered.filter((m) => m.id && keep.has(m.id));
  }, [ghostFiltered, planFilter, planFilterOn, nowMs]);
  const planGroups = useMemo(() => {
    const byId = new Set(ghostFiltered.map((m) => m.id));
    return ghostFiltered.filter((m) => !m.parentId || !byId.has(m.parentId));
  }, [ghostFiltered]);
  const planLeafStats = useMemo(() => {
    // Leaf-ness from the FULL list (PT SCH-6), one pass (PT PERF-5: this was
    // an O(n²) `some` scan, run twice).
    const parents = new Set<string>();
    for (const m of milestones) if (m.parentId) parents.add(m.parentId);
    const isLeaf = (m: Milestone) => !(m.id && parents.has(m.id));
    const total = ghostFiltered.filter(isLeaf).length;
    const shown = visible.filter(isLeaf).length;
    return { shown, total };
  }, [milestones, ghostFiltered, visible]);

  // Flatten the visible milestones into WBS-tree order with a depth, so
  // the Planning list reads as the hierarchy (phases → tasks → steps)
  // instead of a flat dump. Siblings sort by start/finish then name.
  const planningRows = useMemo(() => {
    const byId = new Map<string, Milestone>();
    for (const m of visible) if (m.id) byId.set(m.id, m);
    const kids = new Map<string, Milestone[]>();
    for (const m of visible) {
      const pid = m.parentId && byId.has(m.parentId) ? m.parentId : null;
      if (!pid) continue;
      const arr = kids.get(pid) ?? []; arr.push(m); kids.set(pid, arr);
    }
    const cmp = (a: Milestone, b: Milestone) => {
      const as = Date.parse((a.plannedStartAt as string | undefined) ?? (a.plannedAt as string));
      const bs = Date.parse((b.plannedStartAt as string | undefined) ?? (b.plannedAt as string));
      if (as !== bs) return as - bs;
      return (a.name || "").localeCompare(b.name || "");
    };
    const out: Array<{ m: Milestone; depth: number }> = [];
    const walk = (list: Milestone[], depth: number) => {
      for (const m of list.slice().sort(cmp)) {
        out.push({ m, depth });
        if (m.id && kids.has(m.id)) walk(kids.get(m.id)!, depth + 1);
      }
    };
    walk(visible.filter((m) => !m.parentId || !byId.has(m.parentId)), 0);
    return out;
  }, [visible]);

  const metrics = useMemo(() => computeScheduleMetrics(milestones, { now: new Date(nowMs) }), [milestones, nowMs]);
  // Per-task effective progress + derived status for the Planning list, so a
  // phase shows a rolled-up status/% and can't be marked done directly. Over
  // the FULL list (PT SCH-6): hiding imported children must never turn their
  // manual parent into a "leaf" with a Done button.
  const planProgress = useMemo(() => buildProgressIndex(milestones), [milestones]);

  const onSetStatus = async (id: string, status: MilestoneStatus) => {
    setBusy(true); setError(null);
    try {
      await setMilestoneStatus({
        id, status,
        actorUserId: userId,
        actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onDelete = async (id: string) => {
    // Say what happens to the rest of the schedule (PT SCH-17).
    const target = milestones.find((m) => m.id === id);
    const plan = planMilestoneDelete(milestones, id);
    const parentName = plan.newParentId ? milestones.find((m) => m.id === plan.newParentId)?.name ?? "its parent" : null;
    const parts = [`Delete “${target?.name ?? "this milestone"}”? This action is audited.`];
    if (plan.children.length > 0) parts.push(`Its ${plan.children.length} sub-task${plan.children.length === 1 ? "" : "s"}${plan.descendants > plan.children.length ? ` (${plan.descendants} tasks in all)` : ""} will move up to ${parentName ? `“${parentName}”` : "the top level"} — none is deleted.`);
    if (plan.dependents.length > 0) parts.push(`${plan.dependents.length} task${plan.dependents.length === 1 ? "" : "s"} that depend${plan.dependents.length === 1 ? "s" : ""} on it will lose that link.`);
    if (target && isImportedMilestone(target)) parts.push(`It came from ${target.source}: the next import of a file that still contains it adds it back.`);
    if (!(await appConfirm({ message: parts.join(" "), tone: "danger" }))) return;
    setBusy(true); setError(null);
    try { await deleteMilestone(id, userId); await refresh(); }
    catch (e) { setError((e as Error).message); void refresh(); }
    finally { setBusy(false); }
  };

  const baselineNow = useMemo(() => currentBaselineSummary(milestones), [milestones]);
  const hasBaseline = !!baselineNow;
  const [baselineBusy, setBaselineBusy] = useState(false);
  const onSetBaseline = async () => {
    // Name the baseline being replaced, and say whether it is kept (PT SAF-7):
    // the RPC writes it to milestone_baseline_history before overwriting —
    // but only once 20261099 is applied; before that setBaseline's legacy
    // path overwrites it with no history, so the confirm asks the database
    // first and never promises "kept" when it is not.
    const setOn = baselineNow?.setAt
      ? new Date(baselineNow.setAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
      : null;
    const kept = baselineNow ? await baselineHistoryAvailable({ orgId, projectId }) : null;
    const keptLine = kept === true
      ? "The one you replace is kept — the Report can still measure drift against it — but from now on"
      : kept === false
        ? "This database does not keep replaced baselines yet (the baseline-history migration is not applied): the one you replace is overwritten and cannot be recovered. From now on"
        : "Whether the one you replace is kept could not be checked — if the baseline-history migration is not applied it is overwritten and cannot be recovered. From now on";
    const msg = baselineNow
      ? `Replace the baseline ${setOn ? `set on ${setOn} ` : ""}(${baselineNow.rowCount} task${baselineNow.rowCount === 1 ? "" : "s"}) with the current plan? ${keptLine} every "vs plan" figure is measured against the new snapshot.`
      : "Snapshot the current plan as the baseline? Every view will then show how far the schedule drifts from it.";
    if (!(await appConfirm(kept === true || !baselineNow ? msg : { message: msg, tone: "danger" }))) return;
    setBaselineBusy(true); setError(null);
    try {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      if (!res.ok) setError(res.error ?? "Couldn't set baseline.");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBaselineBusy(false); }
  };


  return (
    <div className="space-y-4">
      {(error || loadError) && (
        <div role="alert" className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-0">{[error, loadError].filter(Boolean).join(" · ")}</span>
          {error && (
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss this message" className="shrink-0 p-0.5 rounded hover:bg-red-100">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <FirstRunHint storageKey="schedule.intro.v2" tone="info">
        Drop an exported schedule file and we&apos;ll parse it — from MS Project (.xml / .csv) or Primavera P6,
        the scheduling tool big projects use (.xml / .xer export). No file? Type a few milestones by hand — that&apos;s
        enough to unlock the board. Drag milestones in the calendar to reschedule; click a pill to advance its status.
      </FirstRunHint>

      {/* Progress dashboard — always on top, summarizes everything */}
      <ScheduleProgress milestones={milestones} metrics={metrics} nowMs={nowMs} />

      {/* View tabs */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-sm p-1 gap-0.5">
          {([
            { id: "planning",  label: "Planning",  Icon: ClipboardList },
            { id: "execution", label: "Execution", Icon: PlayCircle },
          ] as Array<{ id: ScheduleView; label: string; Icon: typeof PlayCircle }>).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                view === id
                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] shadow-sm"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-2">
          <button
            onClick={() => setShowGhost((v) => !v)}
            title={showGhost
              ? "Hide the rows imported from your scheduling tool from the list and the board. Every number, rollup, the critical path and the cycle check still count them."
              : "Show the rows imported from your scheduling tool (they are counted in every number either way)"}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] transition-colors"
          >
            {showGhost ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} Imported rows
          </button>
          {canEdit && (
            <>
              <button
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text)] hover:text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] border border-[var(--color-border)] px-2.5 py-1.5 rounded-lg shadow-sm transition-colors"
              >
                <Upload className="w-3.5 h-3.5" /> Import schedule
              </button>
              {milestones.length > 0 && (
                <button
                  onClick={() => setRebaseOpen(true)}
                  title="Shift every task by a date delta — reuse an old schedule with a new start date"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] bg-[var(--color-accent-soft)] border border-[var(--color-accent-ring)]/40 px-2.5 py-1.5 rounded-lg shadow-sm transition-colors"
                >
                  <Calendar className="w-3.5 h-3.5" /> Rebase
                </button>
              )}
              {milestones.length > 0 && (
                <button
                  onClick={onSetBaseline}
                  disabled={baselineBusy}
                  title={hasBaseline
                    ? "Capture the current plan as the new baseline — once the baseline-history migration is applied the one it replaces is kept for the Report to compare against (the confirm says whether this database keeps it)"
                    : "Snapshot the current plan as the baseline — every view then shows how far you've drifted from it"}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-lg shadow-sm disabled:opacity-40 transition-colors"
                >
                  <Flag className="w-3.5 h-3.5" /> {hasBaseline ? "Re-baseline" : "Set baseline"}
                </button>
              )}
              <button
                onClick={() => setAdding((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1.5 rounded-lg shadow-sm transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add milestone
              </button>
            </>
          )}
        </div>
      </div>

      {/* Zero-state onboarding — the front door for a new user. */}
      {!loading && milestones.length === 0 && (
        <ScheduleEmptyState
          canEdit={canEdit}
          onImport={() => setImportOpen(true)}
          onAdd={() => setAdding(true)}
        />
      )}

      {/* Active view */}
      {!loading && milestones.length > 0 && view === "execution" && (
        <ExecutionView
          milestones={milestones}
          hideImported={!showGhost}
          canEdit={canEdit}
          orgId={orgId}
          projectId={projectId}
          userId={userId}
          userName={userName}
          userEmail={userEmail}
          userRole={userRole}
          onRefresh={refresh}
          onMoveMany={async (changes, opts): Promise<MoveOutcome> => {
            if (changes.length === 0) return { ok: true };
            setError(null);
            // The lock: each row's updated_at as this view loaded it (an Undo
            // passes the value its move reported) — PT SCH-7 / SCH-18.
            const loaded = new Map(milestonesRef.current.map((m) => [m.id, m.updatedAt ?? null]));
            // A row loaded without an updated_at sends none (undefined, not
            // null — null would switch the lock off): applyMilestoneMoves then
            // locks on the row as it reads it just before the write.
            const moves = changes.map((c) => ({
              id: c.id, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt,
              expectedUpdatedAt: opts?.expectedUpdatedAt?.[c.id] ?? (loaded.get(c.id) as string | null | undefined) ?? undefined,
            }));
            // Optimistic: apply every reflowed date locally so the drag
            // feels instant, then persist the batch.
            const byId = new Map(changes.map((c) => [c.id, c]));
            setMilestones((arr) => arr.map((m) => {
              const c = m.id ? byId.get(m.id) : undefined;
              return c ? { ...m, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : m;
            }));
            try {
              const res = await applyMilestoneMoves({
                orgId, projectId, moves,
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
                onUnmatched: "return",
              });
              if (res.unmatched.length > 0) {
                // Rejected by the lock: name them, and reload so the board
                // shows what is really saved. A stale view is refused whole
                // (nothing moved); rows that did move in a race are handed
                // back with their new locks so the board can offer an Undo.
                const names = res.unmatched.map((id) => milestonesRef.current.find((m) => m.id === id)?.name ?? id.slice(0, 8));
                const who = `${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;
                const reason = res.matched.length > 0
                  ? `${who} ${names.length === 1 ? "was" : "were"} changed by someone else and not moved (the other ${res.matched.length} moved)`
                  : `${who} ${names.length === 1 ? "was" : "were"} changed by someone else — nothing was moved`;
                setError(`${names.length} task${names.length === 1 ? " was" : "s were"} changed by someone else and ${names.length === 1 ? "was" : "were"} not moved: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}${res.matched.length > 0 ? ` (the other ${res.matched.length} moved — Undo puts them back)` : " — nothing was moved"}. The schedule has been reloaded — check those dates and try again.`);
                void refresh();
                return { ok: false, matched: res.matched, updatedAt: res.updatedAt, error: reason };
              }
              if (res.auditError) setError(`Moved, but ${res.auditError}.`);
              // Our own write bumped updated_at: take the new values, or
              // reload when they could not be read back.
              if (res.updatedAt) {
                const stamps = res.updatedAt;
                setMilestones((arr) => arr.map((m) => (m.id && stamps[m.id] ? { ...m, updatedAt: stamps[m.id] } : m)));
              } else void refresh();
              return { ok: true, updatedAt: res.updatedAt };
            } catch (e) {
              setError((e as Error).message);
              void refresh();
              return { ok: false, error: (e as Error).message };
            }
          }}
          onSetStatus={async (id, status) => {
            setError(null);
            try {
              await setMilestoneStatus({
                id, status,
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
              });
              await refresh();
              return true;
            } catch (e) {
              setError((e as Error).message);
              return false;
            }
          }}
          onSetProgress={async (id, percent) => {
            setError(null);
            try {
              await setMilestoneProgress({
                id, percentComplete: percent,
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
              });
              await refresh();
              return true;
            } catch (e) {
              setError((e as Error).message);
              return false;
            }
          }}
        />
      )}
      {/* Planning view — the schedule as an editable list */}
      {!loading && milestones.length > 0 && view === "planning" && (
        <div className="space-y-3">
        <ScheduleFilterBar
          filter={planFilter}
          onChange={setPlanFilter}
          groups={planGroups}
          matchCount={planLeafStats.shown}
          totalCount={planLeafStats.total}
        />
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between gap-3 bg-slate-50/60">
            <div className="flex items-center gap-2">
              <Flag className="w-4 h-4 text-[var(--color-accent)]" />
              <div className="font-bold text-[var(--color-text)] text-sm">Milestones</div>
              <span className="text-[10px] text-[var(--color-text-muted)] font-mono">{visible.length}</span>
            </div>
            <HelpTooltip>
              <b>Imported rows</b> come from your scheduling tool (P6 / MS Project). Their dates, place in the outline, links and planned fields are set there and the next import writes them back, so they are locked here — change them in the tool and re-import. Their status, % complete and who did the work are recorded here and survive a re-import. Deleting one removes it until an import of a file that still contains it adds it back; Rebase shifts the whole schedule, imported rows included, until the next import. They count toward every metric either way; &ldquo;Imported rows&rdquo; up top only hides them from the list and the board.
            </HelpTooltip>
          </div>

          {adding && (
            <AddMilestoneForm
              orgId={orgId}
              projectId={projectId}
              userId={userId}
              userName={userName}
              userEmail={userEmail}
              userRole={userRole}
              onCancel={() => setAdding(false)}
              onCreated={() => { setAdding(false); void refresh(); }}
            />
          )}

          {loading ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)] flex items-center justify-center gap-2">
              <Spinner size="xs" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
              {planFilterOn ? "No tasks match the current search/filter." : <>No milestones yet.{canEdit && " Click Add milestone above to create the first one."}</>}
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {planningRows.map(({ m, depth }) => (
                <MilestoneRow
                  key={m.id}
                  m={m}
                  depth={depth}
                  info={m.id ? planProgress.get(m.id) : undefined}
                  canEdit={canEdit}
                  busy={busy}
                  nowMs={nowMs}
                  onSetStatus={onSetStatus}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
        </div>
      )}

      {/* Inline add form shown on the Execution view too when triggered */}
      {adding && view !== "planning" && (
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-sm">
          <AddMilestoneForm
            orgId={orgId}
            projectId={projectId}
            userId={userId}
            userName={userName}
            userEmail={userEmail}
            userRole={userRole}
            onCancel={() => setAdding(false)}
            onCreated={() => { setAdding(false); void refresh(); }}
          />
        </div>
      )}

      {importOpen && (
        <ScheduleImportModal
          orgId={orgId}
          projectId={projectId}
          projectName={projectName}
          projectStatus={projectStatus}
          userId={userId}
          userName={userName}
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); void refresh(); }}
        />
      )}

      {rebaseOpen && (() => {
        // Anchor = current earliest planned date in the schedule
        // (planned_start_at, fallback planned_at).
        let earliestMs = Infinity;
        for (const m of milestones) {
          const candidate = (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string | undefined);
          if (!candidate) continue;
          const t = new Date(candidate).getTime();
          if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
        }
        const currentAnchor = Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : null;
        return (
          <RebaseScheduleModal
            orgId={orgId}
            projectId={projectId}
            projectName={projectName}
            currentAnchorIso={currentAnchor}
            totalTaskCount={milestones.length}
            actorUserId={userId}
            actorUserName={userName}
            actorUserEmail={userEmail}
            actorUserRole={userRole}
            onClose={() => setRebaseOpen(false)}
            onDone={() => { setRebaseOpen(false); void refresh(); }}
          />
        );
      })()}
    </div>
  );
}


function MilestoneRow({ m, depth = 0, info, canEdit, busy, nowMs, onSetStatus, onDelete }: {
  m: Milestone; depth?: number; info?: ProgressInfo; canEdit: boolean; busy: boolean;
  /** The tab's one "now" (useScheduleNow) — every row, the progress card and
   *  the filter count overdue at the same instant (PT SCH-5). */
  nowMs: number;
  onSetStatus: (id: string, s: MilestoneStatus) => void;
  onDelete: (id: string) => void;
}) {
  // A phase/summary's status + % are DERIVED from its children — shown, not
  // set directly (so you can't mark a phase done while work under it is open).
  const isParent = info ? !info.isLeaf : !!m.isSummary;
  const effStatus: MilestoneStatus = isParent && info ? info.status : m.status;
  const effPct = info ? info.percent : (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));
  const start = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const planned = new Date(m.plannedAt as string);
  const actual = m.actualAt ? new Date(m.actualAt as string) : null;
  // The one overdue rule, by UTC day (PT SCH-5): due today is not overdue.
  const overdue = isOverdueMilestone({ planned_at: m.plannedAt as string, status: effStatus }, nowMs);
  const slipDays = actual ? Math.round((actual.getTime() - planned.getTime()) / 86400_000) : 0;
  const blFinish = m.baselineFinishAt ? new Date(m.baselineFinishAt as string) : null;
  const driftDays = blFinish ? Math.round((planned.getTime() - blFinish.getTime()) / 86400_000) : 0;
  // Planned/baseline dates are wall-clock-as-UTC → render in UTC so the day
  // matches the schedule. (The actual-completion date below is a real instant,
  // so it stays in the viewer's local time.)
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  // Low-alpha tints over the surface — the codebase's theme-safe recipe —
  // so the row's text keeps its contrast in dark mode (PT A11Y-3: the
  // light-mode -50 tints composited to a mid-grey slab under light text).
  const tone =
    effStatus === "completed" ? "border-emerald-500/50 bg-emerald-500/[0.08]" :
    effStatus === "missed"    ? "border-rose-500/50 bg-rose-500/[0.08]" :
    effStatus === "blocked"   ? "border-amber-500/50 bg-amber-500/[0.08]" :
    effStatus === "on_hold"   ? "border-amber-500/50 bg-amber-500/[0.06]" :
    overdue                   ? "border-rose-500/50 bg-rose-500/[0.06]" :
                                "border-[var(--color-border)] bg-[var(--color-surface)]";

  const ghost = m.source !== "manual";
  // Text that sits on the tint uses text-slate-600 (#475569; globals.css maps
  // it to #cbd5e1 under .dark), not --color-text-muted: the muted token
  // (#64748b) falls just under 4.5:1 on any light tint (PT A11Y-3).

  return (
    <div className={`py-3 pr-4 flex items-start gap-3 border-l-4 ${tone} ${ghost ? "opacity-90" : ""}`} style={{ paddingLeft: 16 + depth * 18 }}>
      {m.isSummary
        ? <Layers className="w-4 h-4 mt-0.5 text-[var(--color-accent)] shrink-0" />
        : <Flag className="w-4 h-4 mt-0.5 text-[var(--color-text-faint)] shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {m.wbs && <span className="font-mono text-[10px] text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded shrink-0">{m.wbs}</span>}
          <span className={`text-sm truncate ${m.isSummary ? "font-black text-[var(--color-text)]" : "font-bold text-[var(--color-text)]"}`}>{m.name}</span>
          <StatusChip status={effStatus} />
          <span className="text-[10px] font-black tabular-nums text-slate-600" title={isParent ? "Rolled up from sub-tasks" : "% complete"}>{effPct}%</span>
          {driftDays !== 0 && blFinish && (
            <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${driftDays > 0 ? "bg-rose-500/[0.08] text-rose-700 dark:text-rose-300 border-rose-500/50" : "bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border-emerald-500/50"}`} title="Drift vs approved plan">
              {driftDays > 0 ? `+${driftDays}d` : `${driftDays}d`} vs plan
            </span>
          )}
          {ghost && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1 py-0.5 rounded" title={`Imported from ${m.source}`}>
              {m.source}
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-slate-600 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {start && start.getTime() !== planned.getTime() ? `${fmt(start)} – ${fmt(planned)}` : fmt(planned)}
          </span>
          {typeof m.durationHours === "number" && m.durationHours > 0 && (
            <span className="font-mono text-slate-600">· {m.durationHours}h</span>
          )}
          {m.workOrderRef && <span className="font-mono text-slate-600">· WO {m.workOrderRef}</span>}
          {(m.responsibleParty || m.responsibleOrg) && (
            <span className="text-slate-600">· {[m.responsibleParty, m.responsibleOrg].filter(Boolean).join(" / ")}</span>
          )}
          {m.location && <span className="text-slate-600">· {m.location}</span>}
          {actual && (
            <>
              <ArrowRight className="w-3 h-3 text-slate-300" />
              <span className={slipDays > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}>
                actual {actual.toLocaleDateString()}{slipDays !== 0 && ` (${slipDays > 0 ? "+" : ""}${slipDays}d)`}
              </span>
            </>
          )}
          {overdue && !actual && <span className="text-rose-700 dark:text-rose-300 font-bold">overdue</span>}
          {m.linkedRevisionLabel && (
            <span className="text-slate-600 font-mono">· {m.linkedRevisionLabel}</span>
          )}
        </div>
        {m.description && <div className="mt-1 text-[11px] text-[var(--color-text)] whitespace-pre-wrap line-clamp-2">{m.description}</div>}
      </div>

      {canEdit && (
        <div className="shrink-0 flex items-center gap-1">
          {/* A phase rolls up — its status isn't set directly; only leaves are. */}
          {isParent ? (
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-600 px-1.5" title="Status rolls up from sub-tasks">rolls up</span>
          ) : (
            <>
              {effStatus !== "completed" && (
                <button
                  onClick={() => onSetStatus(m.id!, "completed")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.16] border border-emerald-500/50 px-1.5 py-1 rounded disabled:opacity-40 transition-colors"
                  title="Mark complete"
                >
                  <Check className="w-3 h-3" /> Done
                </button>
              )}
              <StatusMenu current={m.status} onPick={(s) => onSetStatus(m.id!, s)} disabled={busy} />
            </>
          )}
          <button
            onClick={() => onDelete(m.id!)}
            disabled={busy}
            className="p-1 rounded text-slate-600 hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/[0.08] transition-colors"
            title="Delete milestone"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: MilestoneStatus }) {
  const tone =
    status === "completed"   ? "bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-300 border-emerald-500/50" :
    status === "in_progress" ? "bg-blue-500/[0.12] text-blue-800 dark:text-blue-300 border-blue-500/50" :
    status === "missed"      ? "bg-rose-500/[0.12] text-rose-800 dark:text-rose-300 border-rose-500/50" :
    status === "blocked"     ? "bg-amber-500/[0.12] text-amber-800 dark:text-amber-300 border-amber-500/50" :
                               "bg-[var(--color-surface-2)]   text-[var(--color-text)]   border-[var(--color-border)]";
  return (
    <span className={`text-[9px] font-bold uppercase tracking-widest border px-1.5 py-0.5 rounded ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function StatusMenu({ current, onPick, disabled }: { current: MilestoneStatus; onPick: (s: MilestoneStatus) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Render the menu in a portal with fixed positioning so the Planning
  // card's overflow-hidden can't clip it (the old absolute menu got cut
  // off at the row edge).
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 144) }); // 144 = w-36
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={disabled}
        className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] px-1.5 py-1 rounded disabled:opacity-40 transition-colors"
        title="Change status"
      >
        Status <ChevronDown className="w-3 h-3" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setOpen(false)} />
          <div className="fixed z-[200] bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg py-1 w-36 animate-in fade-in zoom-in-95 duration-150" style={{ top: pos.top, left: pos.left }}>
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => { setOpen(false); onPick(s); }}
                className={`w-full text-left text-xs px-3 py-1.5 hover:bg-[var(--color-surface-2)] capitalize transition-colors ${s === current ? "font-bold text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}
              >
                {s.replace("_", " ")}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// ─── Add milestone form ────────────────────────────────────────

function AddMilestoneForm({
  orgId, projectId, userId, userName, userEmail, userRole, onCancel, onCreated,
}: {
  orgId: string; projectId: string; userId: string;
  userName?: string; userEmail?: string; userRole?: string;
  onCancel: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [plannedAt, setPlannedAt] = useState("");
  const [weight, setWeight] = useState("1");
  const [linkedRev, setLinkedRev] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !plannedAt) { setError("Name and planned date required."); return; }
    setBusy(true); setError(null);
    try {
      await createMilestone({
        orgId, projectId,
        name, description,
        weight: Number(weight) || 1,
        plannedAt: new Date(plannedAt).toISOString(),
        linkedRevisionLabel: linkedRev || undefined,
        createdBy: userId,
        createdByName: userName,
        createdByEmail: userEmail,
        createdByRole: userRole,
      });
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="px-4 py-3 bg-[var(--color-accent-soft)]/60 border-b border-[var(--color-border)] space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (required)" className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5" autoFocus />
        <input type="date" value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)} aria-label="Planned date" className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 bg-[var(--color-surface)] text-[var(--color-text)] [color-scheme:light] dark:[color-scheme:dark]" title="Planned date" />
        <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Weight (default 1)"
          title="How much this milestone counts in the % complete — a big scope worth 3× a small one gets weight 3. Leave 1 when unsure."
          className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 font-mono" />
        <input value={linkedRev} onChange={(e) => setLinkedRev(e.target.value)} placeholder='Linked ref (e.g. "Rev 3 release")' className="text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5" />
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" rows={2} className="w-full text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 resize-y" />
      {/* A11Y-12: what the weight means, in text — not only in a hover title. */}
      <p className="text-[10px] text-[var(--color-text-muted)]">
        <b>Weight</b> is how much this milestone counts in the % complete — a big scope worth 3× a small one gets weight 3. Leave 1 when unsure.
      </p>
      {error && (
        <div role="alert" className="text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/[0.08] border border-rose-500/40 rounded px-2 py-1">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 transition-colors">Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !plannedAt} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1 rounded disabled:opacity-40 transition-colors">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
        </button>
      </div>
    </form>
  );
}

