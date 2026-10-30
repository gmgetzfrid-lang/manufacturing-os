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
import { Flag, Plus, Loader2, AlertTriangle, Check, X, Calendar, ChevronDown, Upload, ArrowRight, Eye, EyeOff, Layers, Clock, Trash2, RotateCcw } from "lucide-react";
import {
  listMilestones, createMilestone, setMilestoneStatus, setMilestoneProgress, restoreMilestoneStates, deleteMilestone, clearProjectSchedule, resetProjectProgress,
  applyMilestoneMoves, computeScheduleMetrics, setBaseline, addMilestoneNote, creditProgressTo,
} from "@/lib/milestones";
import MarkSheet from "@/components/projects/MarkSheet";
import type { ShiftCredit } from "@/lib/shiftReport";
import { supabase } from "@/lib/supabase";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { appConfirm } from "@/components/providers/DialogProvider";
import Spinner from "@/components/ui/Spinner";
import HelpTooltip from "@/components/ui/HelpTooltip";
import FirstRunHint from "@/components/ui/FirstRunHint";
import ScheduleProgress from "@/components/projects/ScheduleProgress";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";
import ScheduleEmptyState from "@/components/projects/ScheduleEmptyState";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";
import { buildProgressIndex, type ProgressInfo } from "@/lib/scheduleProgress";
import RebaseScheduleModal from "@/components/projects/RebaseScheduleModal";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { DEFAULT_SCHEDULE_TZ, fmtInTz, fromDateTimeInput, tzLabel } from "@/lib/scheduleTz";
import { ClipboardList, PlayCircle } from "lucide-react";
import ExecutionView from "@/components/projects/ExecutionView";
import { CancelledJobsBar } from "@/components/projects/CancelledJobs";
import { ScheduleSetup, ScheduleSetupButton } from "@/components/projects/ScheduleSetup";
import { splitCancelled } from "@/lib/cancelledJobs";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { useShiftTimes } from "@/lib/shiftTimesStore";

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
  /** The project's own time zone (null = never set) — for Schedule setup. */
  timezone?: string | null;
  /** Owner / admin: may change project settings in Schedule setup. */
  canManage?: boolean;
  /** Re-read the project after a setting on it changed (time zone). */
  onProjectChanged?: () => void;
}

export default function ScheduleTab({ orgId, projectId, projectName, projectStatus, userId, userName, userEmail, userRole, isProjectOwner, timezone, canManage, onProjectChanged }: ScheduleTabProps) {
  const tz = useScheduleTz();
  const canEdit = !!isProjectOwner || (!!userRole && ADMIN_ROLES.has(userRole));

  const [allMilestones, setMilestones] = useState<Milestone[]>([]);
  // Jobs taken off this schedule leave every view (their steps with them);
  // the close-out report and the Cancelled list keep them in sight.
  const { active, cancelled } = useMemo(() => splitCancelled(allMilestones), [allMilestones]);
  // Jobs with no night crew are day work, whatever hours the file gave
  // them (Schedule setup → Night crews). A view-only mark, never saved.
  const shiftTimes = useShiftTimes(projectId);
  const milestones = useMemo(() => applyNightStaffing(active, shiftTimes.nightJobs), [active, shiftTimes.nightJobs]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      const list = await listMilestones({ orgId, projectId, includeGhost: true });
      setMilestones(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live multi-user sync: another planner's edits stream in (debounced) so
  // two people can work the same schedule without silently overwriting each
  // other's view. Previously the board only updated after YOUR own mutation.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`milestones-${projectId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "milestones", filter: `project_id=eq.${projectId}` },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { void refresh(); }, 600);
        })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [projectId, refresh]);

  // Filtered view (toggle for ghost rows). Metrics still computed
  // over ALL milestones — ghost rows ARE commitments from the
  // imported schedule, so they count.
  const ghostFiltered = useMemo(() => showGhost ? milestones : milestones.filter((m) => m.source === "manual"), [milestones, showGhost]);

  // Search / filter for the Planning list (reuses the Execution engine).
  const [planFilter, setPlanFilter] = useState<ScheduleFilter>(EMPTY_FILTER);
  const planFilterOn = isFilterActive(planFilter);
  const visible = useMemo(() => {
    if (!planFilterOn) return ghostFiltered;
    const keep = filterMilestones(ghostFiltered, planFilter);
    return ghostFiltered.filter((m) => m.id && keep.has(m.id));
  }, [ghostFiltered, planFilter, planFilterOn]);
  const planGroups = useMemo(() => {
    const byId = new Set(ghostFiltered.map((m) => m.id));
    return ghostFiltered.filter((m) => !m.parentId || !byId.has(m.parentId));
  }, [ghostFiltered]);
  const planLeafStats = useMemo(() => {
    const isLeaf = (m: Milestone) => !ghostFiltered.some((c) => c.parentId === m.id);
    const total = ghostFiltered.filter(isLeaf).length;
    const shown = visible.filter(isLeaf).length;
    return { shown, total };
  }, [ghostFiltered, visible]);

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

  const metrics = useMemo(() => computeScheduleMetrics(milestones), [milestones]);
  // Per-task effective progress + derived status for the Planning list, so a
  // phase shows a rolled-up status/% and can't be marked done directly.
  const planProgress = useMemo(() => buildProgressIndex(ghostFiltered, tz), [ghostFiltered, tz]);

  // A status from the list asks what it does on the board — when it
  // happened and a comment — so it lands on the right shift's report.
  const [marking, setMarking] = useState<{ id: string; status: MilestoneStatus } | null>(null);
  const onSetStatus = (id: string, status: MilestoneStatus) => setMarking({ id, status });
  const saveMark = async (id: string, status: MilestoneStatus, when: ShiftCredit, note: string): Promise<boolean> => {
    setBusy(true);
    try {
      await setMilestoneStatus({
        id, status, at: new Date(when.at).toISOString(),
        ...(status === "on_hold" || status === "blocked" ? { statusReason: note } : {}),
        actorUserId: userId,
        actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      if (Math.abs(when.at - Date.now()) > 120_000) await creditProgressTo(id, when.at);
      await addMilestoneNote({ orgId, milestoneId: id, kind: "note", statusAt: status, body: note, createdBy: userId, createdByName: userName, happenedAt: new Date(when.at).toISOString() });
      await refresh();
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  };

  // Wipe the whole schedule so it can be rebuilt from a fresh import.
  const [clearing, setClearing] = useState(false);
  const onClearSchedule = async () => {
    const n = allMilestones.length;
    const ok = await appConfirm({
      message: `Delete all ${n} task${n === 1 ? "" : "s"} on this project's schedule? Notes on them go too. This can't be undone - import the schedule file again afterwards to rebuild it. This action is audited.`,
      tone: "danger",
    });
    if (!ok) return;
    setClearing(true); setError(null);
    try {
      await clearProjectSchedule({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setClearing(false); }
  };

  // Start the real run clean after a rehearsal: every task back to 0 % /
  // planned with its actual stamps cleared. Dates and notes stay.
  const [resetting, setResetting] = useState(false);
  const onResetProgress = async () => {
    const n = allMilestones.length;
    const ok = await appConfirm({
      message: `Reset progress on all ${n} task${n === 1 ? "" : "s"}? Every task goes back to 0% and "planned", and its actual start / completion stamps are cleared, so the real outage starts clean after testing. Planned dates, the baseline, dependencies and notes stay (status-change notes from the rehearsal are removed). This action is audited.`,
      tone: "danger",
    });
    if (!ok) return;
    setResetting(true); setError(null);
    try {
      await resetProjectProgress({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setResetting(false); }
  };

  const onDelete = async (id: string) => {
    if (!(await appConfirm({ message: "Delete this milestone? This action is audited.", tone: "danger" }))) return;
    setBusy(true);
    try { await deleteMilestone(id, userId); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const hasBaseline = useMemo(() => milestones.some((m) => m.baselineFinishAt), [milestones]);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const onSetBaseline = async () => {
    const msg = hasBaseline
      ? "Re-capture the current plan as the new baseline? Drift will be measured from now on against this snapshot."
      : "Snapshot the current plan as the baseline? Every view will then show how far the schedule drifts from it.";
    if (!(await appConfirm(msg))) return;
    setBaselineBusy(true);
    try {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      if (!res.ok) setError(res.error ?? "Couldn't set baseline.");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBaselineBusy(false); }
  };

  // Schedule setup: everything the reports hang on, in one wizard.
  const setupProps = {
    projectId, timezone, milestones, hasBaseline, canManage: !!canManage, canEdit, userId,
    onProjectChanged: () => onProjectChanged?.(),
    onSetBaseline: async () => {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      if (!res.ok) throw new Error(res.error ?? "Couldn't set the baseline.");
      await refresh();
    },
  };

  return (
    <div className="space-y-4">
      <ScheduleSetup {...setupProps} />
      {error && (
        // Above every panel and day list, so a failed save is never hidden
        // behind the thing you were working in.
        <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[400] max-w-[92vw] flex items-center gap-2 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 shadow-lg">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 font-bold underline">Dismiss</button>
        </div>
      )}

      <FirstRunHint storageKey="schedule.intro.v2" tone="info">
        Drop an exported schedule file and we&apos;ll parse it - from MS Project (.xml / .csv) or Primavera P6,
        the scheduling tool big projects use (.xml / .xer export). No file? Type a few milestones by hand - that&apos;s
        enough to unlock the board. Drag milestones in the calendar to reschedule; click a pill to advance its status.
      </FirstRunHint>

      {/* Progress dashboard — always on top, summarizes everything */}
      <ScheduleProgress milestones={milestones} metrics={metrics} projectId={projectId} />

      {/* Which clock the schedule runs on. Every date and time below is the
          plant's; a project without a zone still reads as UTC, so say so. */}
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <Clock className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
        {tz === DEFAULT_SCHEDULE_TZ ? (
          <span>Schedule times are shown in <b className="text-[var(--color-text)]">UTC</b>. Set the plant&apos;s timezone under <b className="text-[var(--color-text)]">Edit project</b> so days and shifts line up for everyone.</span>
        ) : (
          <span>Schedule times are shown in plant time: <b className="text-[var(--color-text)]">{tzLabel(tz)}</b>.</span>
        )}
      </div>

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
              ? "Hide the read-only rows imported from your scheduling tool (they still count in the metrics)"
              : "Show the read-only rows imported from your scheduling tool"}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] transition-colors"
          >
            {showGhost ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} Imported rows
          </button>
          <ScheduleSetupButton {...setupProps} />
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
                  onClick={() => void onResetProgress()}
                  disabled={busy || resetting}
                  title="Start the real run clean: every task back to 0% / planned, actual start and completion stamps cleared. Dates and notes stay."
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 dark:text-amber-300 hover:text-amber-900 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 border border-amber-200 dark:border-amber-800 px-2.5 py-1.5 rounded-lg shadow-sm transition-colors disabled:opacity-50"
                >
                  {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reset progress
                </button>
              )}
              {milestones.length > 0 && (
                <button
                  onClick={() => void onClearSchedule()}
                  disabled={busy || clearing}
                  title="Delete every task on this schedule so you can import the file again from scratch"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:text-rose-800 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 border border-rose-200 dark:border-rose-800 px-2.5 py-1.5 rounded-lg shadow-sm transition-colors disabled:opacity-50"
                >
                  {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Clear schedule
                </button>
              )}
              {milestones.length > 0 && (
                <button
                  onClick={() => setRebaseOpen(true)}
                  title="Shift every task by a date delta - reuse an old schedule with a new start date"
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
                    ? "Re-capture the approved plan as the new baseline to measure drift against"
                    : "Snapshot the current plan as the baseline - every view then shows how far you've drifted from it"}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1.5 rounded-lg shadow-sm disabled:opacity-40 transition-colors"
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

      {/* Jobs taken off this schedule — still to be done elsewhere. */}
      {!loading && cancelled.length > 0 && (
        <CancelledJobsBar jobs={cancelled} canEdit={canEdit} userId={userId} userEmail={userEmail} onChanged={refresh} />
      )}

      {/* Active view */}
      {!loading && milestones.length > 0 && view === "execution" && (
        <ExecutionView
          // The whole schedule, always: the Planning filter and the
          // imported-rows toggle are for that list. Execution has its own
          // search, and moves, the shift report and bulk changes must see
          // every task.
          milestones={milestones}
          cancelled={cancelled}
          canEdit={canEdit}
          orgId={orgId}
          projectId={projectId}
          projectName={projectName}
          userId={userId}
          userName={userName}
          userEmail={userEmail}
          userRole={userRole}
          onRefresh={refresh}
          onMoveMany={async (changes) => {
            if (changes.length === 0) return true;
            // Optimistic: apply every reflowed date locally so the drag
            // feels instant, then persist each row.
            const byId = new Map(changes.map((c) => [c.id, c]));
            setMilestones((arr) => arr.map((m) => {
              const c = m.id ? byId.get(m.id) : undefined;
              return c ? { ...m, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : m;
            }));
            try {
              await applyMilestoneMoves({
                orgId, projectId,
                moves: changes.map((c) => ({ id: c.id, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt })),
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
              });
              return true;
            } catch (e) {
              setError((e as Error).message);
              void refresh();
              return false;
            }
          }}
          onSetStatus={async (id, status, reason, percent, at, ahead) => {
            try {
              const saved = await setMilestoneStatus({
                id, status, statusReason: reason, percentComplete: percent, at, ahead,
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
              });
              // Swap in the saved row instead of re-reading the whole schedule
              // (live updates still bring other people's changes).
              setMilestones((arr) => arr.map((m) => (m.id === saved.id ? saved : m)));
              return true;
            } catch (e) {
              setError((e as Error).message);
              return false;
            }
          }}
          onRestore={async (states) => {
            const { failed } = await restoreMilestoneStates(states, userId);
            await refresh();
            if (failed.length) { setError(`Undo couldn't restore ${failed.length} task${failed.length === 1 ? "" : "s"}.`); return false; }
            return true;
          }}
          onSetProgress={async (id, percent, at, ahead) => {
            try {
              const saved = await setMilestoneProgress({
                id, percentComplete: percent, at, ahead,
                actorUserId: userId, actorUserName: userName,
                actorUserEmail: userEmail, actorUserRole: userRole,
              });
              setMilestones((arr) => arr.map((m) => (m.id === saved.id ? saved : m)));
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
          <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between gap-3 bg-slate-50/60 dark:bg-[var(--color-surface-2)]">
            <div className="flex items-center gap-2">
              <Flag className="w-4 h-4 text-[var(--color-accent)]" />
              <div className="font-bold text-[var(--color-text)] text-sm">Milestones</div>
              <span className="text-[10px] text-[var(--color-text-muted)] font-mono">{visible.length}</span>
            </div>
            <HelpTooltip>
              <b>Imported rows</b> are read-only milestones from your scheduling tool (P6 / MS Project). They still count toward the earned-value rollup. Toggle &ldquo;Imported rows&rdquo; up top to hide them from this list while keeping them in metrics.
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
              milestones={milestones}
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
              {marking && (
                <MarkSheet names={[allMilestones.find((x) => x.id === marking.id)?.name ?? "Step"]} status={marking.status} tz={tz} times={shiftTimes}
                  onSave={(when, note) => saveMark(marking.id, marking.status, when, note)} onClose={() => setMarking(null)} />
              )}
              {planningRows.map(({ m, depth }) => (
                <MilestoneRow
                  key={m.id}
                  m={m}
                  depth={depth}
                  info={m.id ? planProgress.get(m.id) : undefined}
                  canEdit={canEdit}
                  busy={busy}
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
            milestones={milestones}
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
          userEmail={userEmail}
          userRole={userRole}
          existingCount={allMilestones.length}
          existing={allMilestones}
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); void refresh(); }}
        />
      )}

      {rebaseOpen && (() => {
        // Anchor = current earliest planned date in the schedule
        // (planned_start_at, fallback planned_at).
        // Every row, cancelled ones too — the same set the rebase shifts
        // from, so the preview matches what happens.
        let earliestMs = Infinity;
        for (const m of allMilestones) {
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
            totalTaskCount={allMilestones.length}
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


function MilestoneRow({ m, depth = 0, info, canEdit, busy, onSetStatus, onDelete }: {
  m: Milestone; depth?: number; info?: ProgressInfo; canEdit: boolean; busy: boolean;
  onSetStatus: (id: string, s: MilestoneStatus) => void;
  onDelete: (id: string) => void;
}) {
  const tz = useScheduleTz();
  // Capture "now" once per mount — render stays pure (React 19 strict).
  const [nowMs] = useState<number>(() => Date.now());
  // A phase/summary's status + % are DERIVED from its children — shown, not
  // set directly (so you can't mark a phase done while work under it is open).
  const isParent = info ? !info.isLeaf : !!m.isSummary;
  const effStatus: MilestoneStatus = isParent && info ? info.status : m.status;
  const effPct = info ? info.percent : (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));
  const start = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const planned = new Date(m.plannedAt as string);
  const actual = m.actualAt ? new Date(m.actualAt as string) : null;
  const overdue = !actual && planned.getTime() < nowMs && effStatus !== "completed";
  const slipDays = actual ? Math.round((actual.getTime() - planned.getTime()) / 86400_000) : 0;
  const blFinish = m.baselineFinishAt ? new Date(m.baselineFinishAt as string) : null;
  const driftDays = blFinish ? Math.round((planned.getTime() - blFinish.getTime()) / 86400_000) : 0;
  // Planned/baseline dates are wall-clock-as-UTC → render in UTC so the day
  // matches the schedule. (The actual-completion date below is a real instant,
  // so it stays in the viewer's local time.)
  const fmt = (d: Date) => fmtInTz(d, tz, { month: "short", day: "numeric" });

  const tone =
    effStatus === "completed" ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/30" :
    effStatus === "missed"    ? "border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-950/30" :
    effStatus === "blocked"   ? "border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/30" :
    effStatus === "on_hold"   ? "border-amber-300 dark:border-amber-700 bg-amber-50/40" :
    overdue                   ? "border-red-300 dark:border-red-700 bg-red-50/40" :
                                "border-[var(--color-border)] bg-[var(--color-surface)]";

  const ghost = m.source !== "manual";

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
          <span className="text-[10px] font-black tabular-nums text-[var(--color-text-muted)]" title={isParent ? "Rolled up from sub-tasks" : "% complete"}>{effPct}%</span>
          {driftDays !== 0 && blFinish && (
            <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${driftDays > 0 ? "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800" : "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"}`} title="Drift vs approved plan">
              {driftDays > 0 ? `+${driftDays}d` : `${driftDays}d`} vs plan
            </span>
          )}
          {ghost && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] px-1 py-0.5 rounded" title={`Imported from ${m.source}`}>
              {m.source}
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {start && start.getTime() !== planned.getTime() ? `${fmt(start)} – ${fmt(planned)}` : fmt(planned)}
          </span>
          {typeof m.durationHours === "number" && m.durationHours > 0 && (
            <span className="font-mono text-[var(--color-text-muted)]">· {m.durationHours}h</span>
          )}
          {m.workOrderRef && <span className="font-mono text-[var(--color-text-muted)]">· WO {m.workOrderRef}</span>}
          {(m.responsibleParty || m.responsibleOrg) && (
            <span className="text-[var(--color-text-muted)]">· {[m.responsibleParty, m.responsibleOrg].filter(Boolean).join(" / ")}</span>
          )}
          {m.location && <span className="text-[var(--color-text-muted)]">· {m.location}</span>}
          {actual && (
            <>
              <ArrowRight className="w-3 h-3 text-slate-300" />
              <span className={slipDays > 0 ? "text-red-700 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}>
                actual {actual.toLocaleDateString()}{slipDays !== 0 && ` (${slipDays > 0 ? "+" : ""}${slipDays}d)`}
              </span>
            </>
          )}
          {overdue && !actual && <span className="text-red-700 dark:text-red-300 font-bold">overdue</span>}
          {m.linkedRevisionLabel && (
            <span className="text-[var(--color-text-muted)] font-mono">· {m.linkedRevisionLabel}</span>
          )}
        </div>
        {m.description && <div className="mt-1 text-[11px] text-[var(--color-text)] whitespace-pre-wrap line-clamp-2">{m.description}</div>}
      </div>

      {canEdit && (
        <div className="shrink-0 flex items-center gap-1">
          {/* A phase rolls up — its status isn't set directly; only leaves are. */}
          {isParent ? (
            <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-faint)] px-1.5" title="Status rolls up from sub-tasks">rolls up</span>
          ) : (
            <>
              {effStatus !== "completed" && (
                <button
                  onClick={() => onSetStatus(m.id!, "completed")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 border border-emerald-200 dark:border-emerald-800 px-1.5 py-1 rounded disabled:opacity-40 transition-colors"
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
            className="p-1 rounded text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 transition-colors"
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
    status === "completed"   ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" :
    status === "in_progress" ? "bg-blue-100 dark:bg-blue-900/40    text-blue-800 dark:text-blue-300    border-blue-200 dark:border-blue-800" :
    status === "missed"      ? "bg-red-100 dark:bg-red-900/40     text-red-800 dark:text-red-300     border-red-200 dark:border-red-800" :
    status === "blocked"     ? "bg-amber-100 dark:bg-amber-900/40   text-amber-800 dark:text-amber-300   border-amber-200 dark:border-amber-800" :
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
  orgId, projectId, userId, userName, userEmail, userRole, milestones, onCancel, onCreated,
}: {
  orgId: string; projectId: string; userId: string;
  userName?: string; userEmail?: string; userRole?: string;
  /** Current schedule, for the "under" (equipment / group) picker. */
  milestones?: Milestone[];
  onCancel: () => void; onCreated: () => void;
}) {
  const tz = useScheduleTz();
  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState("");   // plant-time "YYYY-MM-DDTHH:MM"
  const [finishAt, setFinishAt] = useState("");
  const [hours, setHours] = useState("");
  const [parentId, setParentId] = useState("");
  const [weight, setWeight] = useState("1");
  const [linkedRev, setLinkedRev] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Groups you can file the step under: anything that already has
  // children, or is flagged a summary — the equipment / phase rows.
  const parentOptions = useMemo(() => {
    const all = milestones ?? [];
    const hasKids = new Set<string>();
    for (const m of all) if (m.parentId) hasKids.add(m.parentId);
    return all
      .filter((m) => m.id && (hasKids.has(m.id) || m.isSummary))
      .sort((a, b) => (a.wbs ?? "").localeCompare(b.wbs ?? "", undefined, { numeric: true }) || a.name.localeCompare(b.name));
  }, [milestones]);

  // Finish defaults to start + hours when the user hasn't typed one.
  const finishFromHours = useMemo(() => {
    if (!startAt || finishAt) return null;
    const h = Number(hours);
    const sMs = Date.parse(fromDateTimeInput(startAt, tz) ?? "");
    if (!Number.isFinite(sMs) || !Number.isFinite(h) || h <= 0) return null;
    return new Date(sMs + h * 3600_000).toISOString();
  }, [startAt, finishAt, hours, tz]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !startAt) { setError("Name and start are required."); return; }
    const startIso = fromDateTimeInput(startAt, tz);
    const finishIso = finishAt ? fromDateTimeInput(finishAt, tz) : finishFromHours ?? startIso;
    if (!startIso || !finishIso) { setError("Enter a valid start (and finish)."); return; }
    if (Date.parse(finishIso) < Date.parse(startIso)) { setError("Finish must be on or after the start."); return; }
    const h = hours.trim() ? Number(hours) : null;
    if (h != null && (!Number.isFinite(h) || h <= 0)) { setError("Hours must be a positive number."); return; }
    setBusy(true); setError(null);
    try {
      await createMilestone({
        orgId, projectId,
        name, description,
        weight: Number(weight) || 1,
        plannedAt: finishIso,
        plannedStartAt: startIso,
        durationHours: h,
        parentId: parentId || null,
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

  const inp = "text-xs border border-[var(--color-border-strong)] rounded px-2 py-1.5 bg-[var(--color-surface)]";
  const lbl = "block text-[9.5px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-0.5";

  return (
    <form onSubmit={submit} className="px-4 py-3 bg-[var(--color-accent-soft)]/60 border-b border-[var(--color-border)] space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <label className="col-span-2">
          <span className={lbl}>Step</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What gets done (required)" className={`${inp} w-full`} autoFocus />
        </label>
        <label className="col-span-2">
          <span className={lbl}>Under (equipment / group)</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={`${inp} w-full`}>
            <option value="">- top level -</option>
            {parentOptions.map((p) => <option key={p.id} value={p.id!}>{p.wbs ? `${p.wbs} ` : ""}{p.name}</option>)}
          </select>
        </label>
        <label>
          <span className={lbl}>Start ({tzLabel(tz)})</span>
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={`${inp} w-full`} required />
        </label>
        <label>
          <span className={lbl}>Finish</span>
          <input type="datetime-local" value={finishAt} min={startAt || undefined} onChange={(e) => setFinishAt(e.target.value)} className={`${inp} w-full`}
            placeholder="start + hours" title={finishFromHours ? `Blank = start + hours → ${fmtInTz(finishFromHours, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Blank = same time as start (a point-in-time step), or start + hours when hours are given"} />
        </label>
        <label>
          <span className={lbl}>Hours of work</span>
          <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" placeholder="e.g. 6"
            title="Real hours this step takes - what the shift report weighs it by. Leave blank if unknown."
            className={`${inp} w-full font-mono`} />
        </label>
        <label>
          <span className={lbl}>Weight</span>
          <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="1"
            title="How much this step counts in the % complete when it has no hours - a big scope worth 3× a small one gets weight 3. Leave 1 when unsure."
            className={`${inp} w-full font-mono`} />
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <input value={linkedRev} onChange={(e) => setLinkedRev(e.target.value)} placeholder='Linked ref (e.g. "WO 48812")' className={inp} />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes" rows={1} className={`${inp} md:col-span-3 resize-y`} />
      </div>
      {finishFromHours && !finishAt && (
        <div className="text-[10.5px] text-[var(--color-text-muted)]">Finish will be set to <b>{fmtInTz(finishFromHours, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</b> (start + {hours} h).</div>
      )}
      {error && (
        <div className="text-[11px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded px-2 py-1">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 transition-colors">Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !startAt} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-2.5 py-1 rounded disabled:opacity-40 transition-colors">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Add to schedule
        </button>
      </div>
    </form>
  );
}

