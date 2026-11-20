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
import { Flag, Plus, Loader2, AlertTriangle, Check, Calendar, ChevronDown, Upload, ArrowRight, Eye, EyeOff, Layers, Clock, Trash2, RotateCcw } from "lucide-react";
import {
  listMilestones, createMilestone, setMilestoneStatus, setMilestoneProgress, restoreMilestoneStates, deleteMilestone, clearProjectSchedule, resetProjectProgress,
  applyMilestoneMoves, computeScheduleMetrics, setBaseline, addMilestoneNote, creditProgressTo,
  snapshotSchedule, restoreClearedSchedule, undoProgressReset, type ScheduleSnapshot,
} from "@/lib/milestones";
import MarkSheet from "@/components/projects/MarkSheet";
import type { ShiftCredit } from "@/lib/shiftReport";
import { supabase } from "@/lib/supabase";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import { appConfirm } from "@/components/providers/DialogProvider";
import { progressWarning } from "@/lib/closeoutStatus";
import HelpTooltip from "@/components/ui/HelpTooltip";
import ScheduleProgress from "@/components/projects/ScheduleProgress";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";
import ScheduleEmptyState from "@/components/projects/ScheduleEmptyState";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { useWoClasses, WoClassSelects } from "@/components/projects/WoClassFilter";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";
import { buildProgressIndex, type ProgressInfo } from "@/lib/scheduleProgress";
import RebaseScheduleModal from "@/components/projects/RebaseScheduleModal";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { DEFAULT_SCHEDULE_TZ, fmtInTz, fromDateTimeInput, toDateTimeInput, tzLabel, dayKey } from "@/lib/scheduleTz";
import MoreMenu, { type MoreItem } from "@/components/ui/MoreMenu";
import { useDraft } from "@/hooks/useDraft";
import { inPhase, phaseOnDay, setNewWorkPhase, type ProjectPhase } from "@/lib/projectPhases";
import { EquipmentScopeProvider } from "@/components/projects/EquipmentScope";
import { PhaseProvider } from "@/components/projects/PhaseContext";
import { ProjectTypeProvider } from "@/components/projects/ProjectTypeContext";
import ExecutionView from "@/components/projects/ExecutionView";
import { CancelledJobsBar } from "@/components/projects/CancelledJobs";
import { ScheduleSetup, ScheduleSetupButton, SetupNotice } from "@/components/projects/ScheduleSetup";
import type { SetupItem } from "@/lib/scheduleSetup";
import { Card, heroPrimary } from "@/components/ui/PageHero";
import { FindingHost, FindingsReviewHost, PastJobsPanel } from "@/components/projects/Findings";
import { splitCancelled } from "@/lib/cancelledJobs";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import QuickUpdate from "@/components/projects/QuickUpdate";

// The project's four schedule tabs: Plan (build the schedule as a list,
// import it, set it up), Today (the shift's screen), Work (the timeline,
// calendar and work orders) and Reports (every report).
export type ScheduleMode = "plan" | "today" | "work" | "reports";
const NO_PHASES: ProjectPhase[] = [];

// A quiet button on a white card; the one orange action is heroPrimary.
const QUIET = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[10px] bg-[var(--color-surface-2)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-border)] disabled:opacity-50 transition-colors";
// The Plan list: this many rows, then "Show N more".
const ROW_STEP = 60;

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
  /** May update the work (owner, co-owner, editor, or an org role that works
   *  schedules). Unset: the owner or such an org role. */
  canEditSchedule?: boolean;
  /** The project's own time zone (null = never set) — for Schedule setup. */
  timezone?: string | null;
  /** Owner / admin: may change project settings in Schedule setup. */
  canManage?: boolean;
  /** Re-read the project after a setting on it changed (time zone). */
  onProjectChanged?: () => void;
  /** Which tab is showing. */
  mode: ScheduleMode;
  /** Go to another of the tabs (a report opened from the Shift tab, import from an empty board). */
  onMode: (m: ScheduleMode) => void;
  /** The project's phases (lib/projectPhases), and the one picked: every
   *  view shows that phase's schedule; null is the whole project. */
  phases?: ProjectPhase[];
  phase?: string | null;
  /** Pick a phase from inside the schedule (a phase's line in All phases). */
  onPickPhase?: (id: string | null) => void;
  /** The band above shows the page's one orange action on this tab too:
   *  this tab's own main action is quiet then. Plan and Work are always
   *  quiet (the band carries their orange); Shift keeps Email / Print. */
  bandAction?: boolean;
}

export default function ScheduleTab({ orgId, projectId, projectName, projectStatus, userId, userName, userEmail, userRole, isProjectOwner, canEditSchedule, timezone, canManage, onProjectChanged, mode, onMode, phases = NO_PHASES, phase = null, onPickPhase, bandAction = false }: ScheduleTabProps) {
  const view = mode === "plan" ? "planning" : "execution";
  // One orange per screen: on Plan and Work it's the band's (the page's
  // next step), so the tab's own buttons (Add task, New work order, Update
  // progress) are quiet there. Shift keeps its own (Email / Print).
  const quietMain = bandAction || mode === "plan" || mode === "work";
  const tz = useScheduleTz();
  // The owner, a co-owner or editor on the project, or an org role that works
  // schedules (lib/projectAccess; the page works it out from the members).
  const canEdit = canEditSchedule ?? (!!isProjectOwner || (!!userRole && ADMIN_ROLES.has(userRole)));

  const [allMilestones, setMilestones] = useState<Milestone[]>([]);
  // The phase picked: its schedule only (every view, report and count);
  // all phases is the whole project.
  const phaseMilestones = useMemo(() => inPhase(allMilestones, phases, phase), [allMilestones, phases, phase]);
  // New work lands in the phase picked, else the one running today.
  useEffect(() => {
    setNewWorkPhase(projectId, phases.length ? (phase ?? phaseOnDay(dayKey(Date.now(), tz), phases)?.id ?? null) : null);
  }, [projectId, phases, phase, tz]);
  // Jobs taken off this schedule leave every view (their steps with them);
  // the close-out report and the Cancelled list keep them in sight.
  const { active, cancelled } = useMemo(() => splitCancelled(phaseMilestones), [phaseMilestones]);

  // Jobs with no night crew are day work, whatever hours the file gave
  // them (Schedule setup → Night shifts). A view-only mark, never saved.
  const shiftTimes = useShiftTimes(projectId);
  const milestones = useMemo(() => applyNightStaffing(active, shiftTimes.nightJobs), [active, shiftTimes.nightJobs]);
  // Every phase, for the phase report (the same work the views see: not
  // cancelled, nights as staffed).
  const phaseCtx = useMemo(() => ({ phases, phase, all: phases.length ? applyNightStaffing(splitCancelled(allMilestones).active, shiftTimes.nightJobs) : milestones, pick: onPickPhase }),
    [phases, phase, allMilestones, shiftTimes.nightJobs, milestones, onPickPhase]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Background-safe refresh. Crucially it does NOT flip `loading` on its own:
  // the render gate for ExecutionView is `!loading`, so toggling loading here
  // would unmount ExecutionView mid-session and reset its internal view state —
  // that's exactly what kicked the user out of the Calendar layout back to
  // Timeline whenever they changed a task's status. We only show the full
  // loading state on the very first load (initialized true), then keep the view
  // mounted and let the data update in place.
  // Who's working, for the equipment field on work orders and steps.
  const refreshRef = useRef<() => void>(() => undefined);
  const equipmentScope = useMemo(() => ({ orgId, projectId, projectName: projectName ?? "", canEdit, canManage: !!canManage, userId: userId ?? null, userName: userName ?? userEmail ?? null, onChanged: () => refreshRef.current() }),
    [orgId, projectId, projectName, canEdit, canManage, userId, userName, userEmail]);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await listMilestones({ orgId, projectId, includeGhost: true });
      setMilestones(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { refreshRef.current = () => { void refresh(); }; }, [refresh]);

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
  // Each work order's unit and equipment type (Setup › Units & equipment).
  const woClasses = useWoClasses(projectId, milestones);
  const visible = useMemo(() => {
    if (!planFilterOn) return ghostFiltered;
    const keep = filterMilestones(ghostFiltered, planFilter, { classOf: woClasses.classOf });
    return ghostFiltered.filter((m) => m.id && keep.has(m.id));
  }, [ghostFiltered, planFilter, planFilterOn, woClasses]);
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
  // The schedule's groups (phases, tasks with steps): what kind of project it is, until Setup says.
  const groupNames = useMemo(() => { const parents = new Set(milestones.map((m) => m.parentId).filter(Boolean)); return milestones.filter((m) => m.isSummary || (m.id && parents.has(m.id))).map((m) => m.name); }, [milestones]);
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

  // What Clear schedule or Reset progress just did, with the copy of the
  // schedule taken right before it, so it can be put back (Undo). Stays
  // until it's dismissed or undone.
  const [undoable, setUndoable] = useState<{ kind: "clear" | "reset"; snapshot: ScheduleSnapshot; count: number } | null>(null);
  const [undoing, setUndoing] = useState(false);

  // Wipe the whole schedule so it can be rebuilt from a fresh import.
  const [clearing, setClearing] = useState(false);
  const onClearSchedule = async () => {
    const n = allMilestones.length;
    const ok = await appConfirm({
      message: `Delete all ${n} task${n === 1 ? "" : "s"} on this project's schedule${phases.length ? `, every phase (${phases.map((p) => p.name).join(" and ")})` : ""}? Notes on them go too.${progressWarning(allMilestones) ? ` ${progressWarning(allMilestones)} To bring in a revised schedule and keep it, use Import and leave Replace unticked: it merges.` : ""} Undo is offered right after; once you leave the page, it can't be undone. This action is audited.`,
      tone: "danger",
    });
    if (!ok) return;
    setClearing(true); setError(null);
    try {
      const snapshot = await snapshotSchedule(orgId, projectId);
      const { deleted } = await clearProjectSchedule({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      setUndoable(deleted > 0 ? { kind: "clear", snapshot, count: deleted } : null);
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
      message: `Reset progress on all ${n} task${n === 1 ? "" : "s"}${phases.length ? `, every phase (${phases.map((p) => p.name).join(" and ")})` : ""}? Every task goes back to 0% and "planned", and its actual start / completion stamps are cleared, so the real outage starts clean after testing. Planned dates, the baseline, dependencies and notes stay (status-change notes from the rehearsal are removed). Undo is offered right after. This action is audited.`,
      tone: "danger",
    });
    if (!ok) return;
    setResetting(true); setError(null);
    try {
      const snapshot = await snapshotSchedule(orgId, projectId);
      const { reset } = await resetProjectProgress({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      setUndoable(reset > 0 ? { kind: "reset", snapshot, count: reset } : null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setResetting(false); }
  };

  const onUndo = async () => {
    if (!undoable) return;
    setUndoing(true); setError(null);
    try {
      if (undoable.kind === "clear") {
        await restoreClearedSchedule({ orgId, projectId, snapshot: undoable.snapshot, actorUserId: userId, actorUserEmail: userEmail });
      } else {
        const { failed } = await undoProgressReset({ orgId, projectId, snapshot: undoable.snapshot, actorUserId: userId, actorUserEmail: userEmail });
        if (failed > 0) setError(`Undo couldn't put back ${failed} task${failed === 1 ? "" : "s"} or note${failed === 1 ? "" : "s"} - check them on the list.`);
      }
      setUndoable(null);
      await refresh();
    } catch (e) { setError(`Couldn't undo: ${(e as Error).message}`); }
    finally { setUndoing(false); }
  };

  const onDelete = async (id: string) => {
    if (!(await appConfirm({ message: "Delete this task? This action is audited.", tone: "danger" }))) return;
    setBusy(true);
    try { await deleteMilestone(id, userId); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const hasBaseline = useMemo(() => milestones.some((m) => m.baselineFinishAt), [milestones]);
  const [baselineBusy, setBaselineBusy] = useState(false);
  // A phase picked: its own plan only, never the other phases' saved plans.
  const pickedPhase = phase ? phases.find((p) => p.id === phase) ?? null : null;
  const baselineIds = pickedPhase ? phaseMilestones.map((m) => m.id).filter((x): x is string => !!x) : undefined;
  const onSetBaseline = async () => {
    const whose = pickedPhase ? `${pickedPhase.name}'s` : "the current";
    const msg = (hasBaseline
      ? `Re-capture ${whose} plan as the new baseline? Drift will be measured from now on against this snapshot.${pickedPhase ? " Other phases keep theirs." : ""}`
      : `Snapshot ${whose} plan as the baseline? Every view will then show how far the schedule drifts from it.`)
      + (!pickedPhase && phases.length > 1 && hasBaseline ? " This replaces every phase's saved plan; pick a phase first to re-capture only its own." : "");
    if (!(await appConfirm(msg))) return;
    setBaselineBusy(true);
    try {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole, ids: baselineIds });
      if (!res.ok) setError(res.error ?? "Couldn't set baseline.");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBaselineBusy(false); }
  };

  // Schedule setup: everything the reports hang on, in one wizard.
  const setupProps = {
    projectId, projectName, timezone, milestones, hasBaseline, canManage: !!canManage, canEdit, userId, userEmail: userEmail ?? userName,
    onProjectChanged: () => onProjectChanged?.(),
    onSetBaseline: async () => {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole, ids: baselineIds });
      if (!res.ok) throw new Error(res.error ?? "Couldn't set the baseline.");
      await refresh();
    },
  };

  // What's still to set up: a row on the first card of whichever tab is open.
  const [setupMissing, setSetupMissing] = useState<SetupItem[]>([]);
  const setupNotice = setupMissing.length > 0 ? <SetupNotice missing={setupMissing} canManage={!!canManage} /> : null;
  // Right after Clear schedule or Reset progress: put it back.
  const undoRow = undoable && canEdit ? (
    <div role="status" className="flex items-center gap-2 flex-wrap py-2.5 text-[13px] text-[var(--color-text)]">
      <span aria-hidden className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
      <span className="flex-1 min-w-48">
        {undoable.kind === "clear"
          ? `Schedule cleared: ${undoable.count} task${undoable.count === 1 ? "" : "s"} deleted.`
          : `Progress reset on ${undoable.count} task${undoable.count === 1 ? "" : "s"}.`}
        {" "}Undo puts {undoable.kind === "clear" ? "every task back with its notes" : "each task's status, %, times and baseline back as they were"}.
      </span>
      <button onClick={() => void onUndo()} disabled={undoing} className={QUIET}>
        {undoing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Undo
      </button>
      <button onClick={() => setUndoable(null)} disabled={undoing} className="h-9 px-2 text-[13px] font-semibold text-[var(--color-text-muted)] hover:underline">Dismiss</button>
    </div>
  ) : null;

  // The Plan list shows its first rows; "Show N more" brings the rest.
  const [rowLimit, setRowLimit] = useState(ROW_STEP);

  // A task just added: scroll it into view and mark it for a moment.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const showNewRow = (id: string | null) => {
    if (!id) return;
    setRowLimit(Infinity);
    setJustAdded(id);
    requestAnimationFrame(() => document.getElementById(`ms-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    setTimeout(() => setJustAdded((x) => (x === id ? null : x)), 4000);
  };

  return (
    <ProjectTypeProvider projectId={projectId} projectName={projectName} groups={groupNames}>
    <PhaseProvider value={phaseCtx}>
    <EquipmentScopeProvider value={equipmentScope}>
    <div className="space-y-4">
      {/* The wizard, and what's still to set up (shown on the first card below). */}
      <ScheduleSetup {...setupProps} onMissing={setSetupMissing} />
      {/* + Finding (a step, a work order, an hour) and the close-out review, on every tab. */}
      <FindingHost orgId={orgId} projectId={projectId} milestones={allMilestones} canEdit={canEdit} />
      <FindingsReviewHost orgId={orgId} projectId={projectId} canEdit={canEdit} timeZone={tz} />
      {error && (
        // Above every panel and day list, so a failed save is never hidden
        // behind the thing you were working in.
        <div role="alert" className="fixed bottom-4 max-sm:bottom-24 left-1/2 -translate-x-1/2 z-[400] max-w-[92vw] flex items-center gap-2 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 shadow-lg">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 font-bold underline">Dismiss</button>
        </div>
      )}

      {/* No import tip here: an empty schedule shows Import (ScheduleEmptyState), and once there is one it's noise. */}

      {/* Zero-state onboarding — the front door for a new user. */}
      {/* Loading: the shape of the schedule, never a blank area. */}
      {loading && (
        <Card>
          <div aria-busy="true" aria-label="Loading the schedule" className="space-y-2.5">
            {[72, 58, 64, 46, 68, 52, 60].map((w, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-3.5 w-3.5 rounded bg-[var(--color-surface-2)]" />
                <div className="h-3.5 rounded bg-[var(--color-surface-2)] animate-pulse" style={{ width: `${w * 0.45}%` }} />
                <div className="h-3 ml-auto rounded bg-[var(--color-surface-2)] animate-pulse" style={{ width: `${w * 0.4}%` }} />
              </div>
            ))}
            <p className="text-[13px] text-[var(--color-text-muted)]">Loading the schedule…</p>
          </div>
        </Card>
      )}
      {!loading && milestones.length === 0 && (
        <ScheduleEmptyState
          canEdit={canEdit}
          onImport={() => { onMode("plan"); setImportOpen(true); }}
          onAdd={() => { onMode("plan"); setAdding(true); }}
          phaseName={phase ? phases.find((x) => x.id === phase)?.name ?? null : null}
          // Work: the band offers "Import the schedule"; Plan and Shift keep this one orange.
          quietMain={bandAction || mode === "work"}
          lead={setupNotice || undoRow ? <div className="divide-y divide-[var(--color-border)]">{setupNotice}{undoRow}</div> : undefined}
        />
      )}

      {/* Progress first, with the schedule's toolbar as a quiet row on top
          of it: one main action (Add task); Import and Setup beside it; the
          rest folded under More. Work has its summary at the top of the board. */}
      {mode === "plan" && !loading && milestones.length > 0 && (
        <ScheduleProgress milestones={milestones} metrics={metrics} projectId={projectId} head={
          <div className="divide-y divide-[var(--color-border)]">
            <div className="flex items-center gap-x-3 gap-y-2 flex-wrap pb-3 first:pt-0">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-[13px] font-semibold text-[var(--color-text-muted)]">Schedule</div>
                <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">
                  {`${milestones.length} task${milestones.length === 1 ? "" : "s"}: phases, tasks, steps. `}
                  {/* Which clock the schedule runs on. Every date and time below is the
                      plant's; a project without a zone still reads as UTC, so say so. */}
                  {tz === DEFAULT_SCHEDULE_TZ ? (
                    <span>Times are in <b className="text-[var(--color-text)]">UTC</b>. Set the plant&apos;s timezone under <b className="text-[var(--color-text)]">Edit project</b> so days and shifts line up for everyone.</span>
                  ) : (
                    <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5 shrink-0" /> Plant time, {tzLabel(tz)}.</span>
                  )}
                </div>
              </div>
              <div className="inline-flex flex-wrap items-center gap-2">
                <ScheduleSetupButton {...setupProps} />
                {canEdit && (
                  <button onClick={() => setImportOpen(true)} className={QUIET}>
                    <Upload className="w-4 h-4" /> Import schedule
                  </button>
                )}
                {(() => {
                  const more: MoreItem[] = [
                    { icon: showGhost ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />, label: showGhost ? "Hide imported rows" : "Show imported rows", onClick: () => setShowGhost((v) => !v) },
                  ];
                  if (canEdit && milestones.length > 0 && !busy) {
                    if (!baselineBusy) more.push({ icon: <Flag className="w-4 h-4" />, label: hasBaseline ? "Re-baseline" : "Set baseline", onClick: onSetBaseline, line: true });
                    more.push({ icon: <Calendar className="w-4 h-4" />, label: "Rebase dates", onClick: () => setRebaseOpen(true) });
                    if (!resetting) more.push({ icon: <RotateCcw className="w-4 h-4" />, label: "Reset progress", onClick: onResetProgress, line: true });
                    if (!clearing) more.push({ icon: <Trash2 className="w-4 h-4" />, label: "Clear schedule", onClick: onClearSchedule, tone: "bad" });
                  }
                  return <MoreMenu items={more} triggerClass={QUIET} />;
                })()}
                {(resetting || clearing || baselineBusy) && <Loader2 aria-label="Working" className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />}
                {canEdit && !adding && (
                  <button onClick={() => setAdding(true)} className={quietMain ? QUIET : heroPrimary}>
                    <Plus className="w-4 h-4" /> Add task
                  </button>
                )}
              </div>
            </div>
            {setupNotice}
            {undoRow}
          </div>
        } />
      )}

      {/* What earlier jobs on this equipment and unit taught. */}
      {mode === "plan" && <PastJobsPanel orgId={orgId} projectId={projectId} milestones={allMilestones} canEdit={canEdit} />}

      {/* Active view. The board's first card carries Update by note, what's
          still to set up, and the jobs taken off this schedule. */}
      {!loading && milestones.length > 0 && view === "execution" && (
        <ExecutionView
          quietMain={quietMain}
          tools={canEdit && (mode === "today" || mode === "work")
            ? <QuickUpdate milestones={milestones} tz={tz} times={shiftTimes} orgId={orgId} projectId={projectId} userId={userId} userName={userName} onSaved={() => void refresh()} />
            : undefined}
          notice={setupNotice || undoRow ? <div className="divide-y divide-[var(--color-border)]">{setupNotice}{undoRow}</div> : undefined}
          cancelledBar={cancelled.length > 0 && mode === "work"
            ? <CancelledJobsBar jobs={cancelled} canEdit={canEdit} userId={userId} userEmail={userEmail} onChanged={refresh} />
            : undefined}
          // The whole schedule, always: the Planning filter and the
          // imported-rows toggle are for that list. Execution has its own
          // search, and moves, the shift report and bulk changes must see
          // every task.
          milestones={milestones}
          cancelled={cancelled}
          mode={mode === "plan" ? "work" : mode}
          onMode={onMode}
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
      {/* Planning view — the schedule as an editable list, on its own card:
          search and filters as a quiet row, then the rows. */}
      {!loading && milestones.length > 0 && view === "planning" && (
        <Card pad={false}>
          <div className="px-4 sm:px-5 pt-4 pb-3 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--color-text-muted)]">Tasks</h2>
            <span className="text-[12px] text-[var(--color-text-muted)] tabular-nums">{visible.length}</span>
            <span className="flex-1" />
            <HelpTooltip>
              <b>Imported rows</b> are read-only milestones from your scheduling tool (P6 / MS Project). They still count toward the earned-value rollup. More › Hide imported rows takes them off this list; they still count.
            </HelpTooltip>
          </div>
          <div className="px-4 sm:px-5 pb-3">
            <ScheduleFilterBar
              filter={planFilter}
              onChange={setPlanFilter}
              groups={planGroups}
              matchCount={planLeafStats.shown}
              totalCount={planLeafStats.total}
              classSelects={<WoClassSelects c={woClasses} units={planFilter.units ?? []} types={planFilter.types ?? []}
                onUnits={(v) => setPlanFilter((f) => ({ ...f, units: v }))} onTypes={(v) => setPlanFilter((f) => ({ ...f, types: v }))} />}
            />
          </div>
          {cancelled.length > 0 && (
            <div className="px-4 sm:px-5 py-1.5 border-t border-[var(--color-border)]">
              <CancelledJobsBar jobs={cancelled} canEdit={canEdit} userId={userId} userEmail={userEmail} onChanged={refresh} />
            </div>
          )}

          <div className="border-t border-[var(--color-border)]">
          {adding && (
            <AddMilestoneForm
              orgId={orgId}
              projectId={projectId}
              userId={userId}
              userName={userName}
              userEmail={userEmail}
              userRole={userRole}
              milestones={milestones}
              quiet={quietMain}
              onCancel={() => setAdding(false)}
              onCreated={(id) => { setAdding(false); void refresh().then(() => showNewRow(id)); }}
            />
          )}

          {visible.length === 0 ? (
            <div className="px-5 py-10 text-center text-[13px] text-[var(--color-text-muted)]">
              {planFilterOn ? "No tasks match the current search/filter." : <>No tasks here yet.{canEdit && " Add task puts the first one in."}</>}
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {marking && (
                <MarkSheet names={[allMilestones.find((x) => x.id === marking.id)?.name ?? "Step"]} status={marking.status} tz={tz} times={shiftTimes}
                  onSave={(when, note) => saveMark(marking.id, marking.status, when, note)} onClose={() => setMarking(null)} />
              )}
              {planningRows.slice(0, rowLimit).map(({ m, depth }) => (
                <MilestoneRow
                  key={m.id}
                  m={m}
                  depth={depth}
                  info={m.id ? planProgress.get(m.id) : undefined}
                  fresh={!!m.id && m.id === justAdded}
                  canEdit={canEdit}
                  busy={busy}
                  onSetStatus={onSetStatus}
                  onDelete={onDelete}
                />
              ))}
              {/* A long schedule ends with "Show N more", so it's plain there's more. */}
              {planningRows.length > rowLimit && (
                <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setRowLimit((n) => n + ROW_STEP)} className={QUIET}>
                    Show {Math.min(ROW_STEP, planningRows.length - rowLimit)} more
                  </button>
                  <button type="button" onClick={() => setRowLimit(Infinity)} className="h-9 px-3 rounded-[10px] text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                    Show all {planningRows.length}
                  </button>
                  <span className="text-[12px] text-[var(--color-text-muted)]">{Math.min(rowLimit, planningRows.length)} of {planningRows.length} shown</span>
                </div>
              )}
            </div>
          )}
          </div>
        </Card>
      )}

      {/* Inline add form shown on the Execution view too when triggered */}
      {adding && view !== "planning" && (
        <Card pad={false} className="overflow-hidden">
          <AddMilestoneForm
            orgId={orgId}
            projectId={projectId}
            userId={userId}
            userName={userName}
            userEmail={userEmail}
            userRole={userRole}
            milestones={milestones}
            quiet={quietMain}
            onCancel={() => setAdding(false)}
            onCreated={() => { setAdding(false); void refresh(); }}
          />
        </Card>
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
          progressNote={progressWarning(allMilestones)}
          existing={allMilestones}
          phases={phases}
          phase={phase}
          phaseMilestones={phases.length ? (pid: string) => inPhase(allMilestones, phases, pid) : undefined}
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
    </EquipmentScopeProvider>
    </PhaseProvider>
    </ProjectTypeProvider>
  );
}


function MilestoneRow({ m, depth = 0, info, fresh, canEdit, busy, onSetStatus, onDelete }: {
  m: Milestone; depth?: number; info?: ProgressInfo; fresh?: boolean; canEdit: boolean; busy: boolean;
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

  // Ink and paper: the row stays white; a problem (missed, blocked, held,
  // overdue) is said on the row itself, in its colour, and marked at the edge.
  const problem =
    effStatus === "missed" || effStatus === "blocked" || (overdue && effStatus !== "on_hold") ? "rose" :
    effStatus === "on_hold" ? "amber" : null;

  const ghost = m.source !== "manual";

  return (
    <div id={m.id ? `ms-row-${m.id}` : undefined} className={`relative py-3 pr-4 sm:pr-5 flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-1 ${ghost ? "opacity-90" : ""} ${fresh ? "bg-[var(--color-surface-2)]" : "hover:bg-[var(--color-surface-2)]/60"} transition-colors`} style={{ paddingLeft: 16 + depth * 18 }}>
      {problem && <span aria-hidden className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-r ${problem === "rose" ? "bg-rose-600" : "bg-amber-500"}`} />}
      {m.isSummary
        ? <Layers className="w-4 h-4 mt-0.5 text-[var(--color-text-muted)] shrink-0" />
        : <Flag className="w-4 h-4 mt-0.5 text-[var(--color-text-faint)] shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          {m.wbs && <span className="font-mono text-[11px] text-[var(--color-text-faint)] shrink-0">{m.wbs}</span>}
          <span className={`text-[14px] min-w-0 break-words sm:truncate ${m.isSummary ? "font-extrabold" : "font-semibold"} ${effStatus === "completed" && !m.isSummary ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>{m.name}</span>
          <StatusChip status={effStatus} />
          <span className="text-[12px] font-bold tabular-nums text-[var(--color-text-muted)]" title={isParent ? "Rolled up from sub-tasks" : "% complete"}>{effPct}%</span>
          {driftDays !== 0 && blFinish && (
            <span className={`text-[12px] font-semibold ${driftDays > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}`} title="Drift vs approved plan">
              {driftDays > 0 ? `+${driftDays}d` : `${driftDays}d`} vs plan
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)] flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {start && start.getTime() !== planned.getTime() ? `${fmt(start)} – ${fmt(planned)}` : fmt(planned)}
          </span>
          {typeof m.durationHours === "number" && m.durationHours > 0 && (
            <span className="tabular-nums">· {m.durationHours}h</span>
          )}
          {m.workOrderRef && <span className="font-mono">· WO {m.workOrderRef}</span>}
          {(m.responsibleParty || m.responsibleOrg) && (
            <span>· {[m.responsibleParty, m.responsibleOrg].filter(Boolean).join(" / ")}</span>
          )}
          {m.location && <span>· {m.location}</span>}
          {actual && (
            <>
              <ArrowRight className="w-3 h-3 text-[var(--color-text-faint)]" />
              <span className={slipDays > 0 ? "text-rose-700 dark:text-rose-300 font-semibold" : "text-emerald-700 dark:text-emerald-300"}>
                actual {actual.toLocaleDateString()}{slipDays !== 0 && ` (${slipDays > 0 ? "+" : ""}${slipDays}d)`}
              </span>
            </>
          )}
          {overdue && !actual && <span className="text-rose-700 dark:text-rose-300 font-bold">overdue</span>}
          {m.linkedRevisionLabel && (
            <span className="font-mono">· {m.linkedRevisionLabel}</span>
          )}
        </div>
        {m.description && <div className="mt-1 text-[12px] text-[var(--color-text)] whitespace-pre-wrap line-clamp-2">{m.description}</div>}
      </div>

      {canEdit && (
        // Beside the row on a wide screen; under it on a phone, so the name has the width.
        <div className="shrink-0 flex items-center gap-1 max-sm:w-full max-sm:justify-end">
          {/* A phase rolls up — its status isn't set directly; only leaves are. */}
          {isParent ? (
            <span className="text-[12px] text-[var(--color-text-faint)] px-1.5" title="Status rolls up from sub-tasks">Rolls up</span>
          ) : (
            <>
              {effStatus !== "completed" && (
                <button
                  onClick={() => onSetStatus(m.id!, "completed")}
                  disabled={busy}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-[12px] font-semibold text-[var(--color-text)] bg-[var(--color-surface-2)] hover:bg-[var(--color-border)] disabled:opacity-40 transition-colors"
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
            className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-faint)] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
            title="Delete task"
            aria-label="Delete task"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: MilestoneStatus }) {
  // A word, not a coloured pill: red/amber only for a problem, green for done.
  const tone =
    status === "completed" ? "text-emerald-700 dark:text-emerald-300" :
    status === "missed" || status === "blocked" ? "text-rose-700 dark:text-rose-300 font-bold" :
    status === "on_hold" ? "text-amber-700 dark:text-amber-300 font-bold" :
    "text-[var(--color-text-muted)]";
  return (
    <span className={`text-[12px] font-semibold ${tone}`}>
      {status === "in_progress" ? "In progress" : status === "on_hold" ? "On hold" : status === "completed" ? "Done" : status[0].toUpperCase() + status.slice(1)}
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
        className="inline-flex items-center gap-0.5 h-8 px-2 rounded-lg text-[12px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40 transition-colors"
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
                className={`w-full flex items-center gap-1.5 text-left text-xs px-3 py-1.5 hover:bg-[var(--color-surface-2)] capitalize transition-colors text-[var(--color-text)] ${s === current ? "font-bold bg-[var(--color-surface-2)]" : ""}`}
              >
                {s.replace("_", " ")}{s === current && <Check className="w-3 h-3 ml-auto" />}
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
  orgId, projectId, userId, userName, userEmail, userRole, milestones, quiet, onCancel, onCreated,
}: {
  /** The page's one orange action is in the band: the submit is ink, not orange. */
  quiet?: boolean;
  orgId: string; projectId: string; userId: string;
  userName?: string; userEmail?: string; userRole?: string;
  /** Current schedule, for the "under" (equipment / group) picker. */
  milestones?: Milestone[];
  onCancel: () => void; onCreated: (id: string | null) => void;
}) {
  const tz = useScheduleTz();
  const [name, setName] = useState("");
  // Starts at the next whole hour, plant time; change it if the step is later.
  const [startAt, setStartAt] = useState(() => toDateTimeInput(Math.ceil(Date.now() / 3600_000) * 3600_000, tz));   // plant-time "YYYY-MM-DDTHH:MM"
  const [finishAt, setFinishAt] = useState("");
  const [hours, setHours] = useState("");
  const [parentId, setParentId] = useState("");
  const [weight, setWeight] = useState("1");
  const [linkedRev, setLinkedRev] = useState("");
  const [description, setDescription] = useState("");
  // Notes typed here survive a reload until the task is added.
  const draft = useDraft<string>(`milestone-add:${projectId}`, description, setDescription, (v) => !v.trim());
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
      const made = await createMilestone({
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
      draft.clear();
      onCreated(made.id ?? null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const inp = "h-9 text-[13px] border border-[var(--color-border-strong)] rounded-lg px-2.5 bg-[var(--color-surface)]";
  const lbl = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1";

  return (
    <form onSubmit={submit} className="px-4 sm:px-5 py-4 bg-[var(--color-surface-2)]/60 border-b border-[var(--color-border)] space-y-3">
      <div className="text-[14px] font-bold text-[var(--color-text)]">Add a task</div>
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
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes" rows={1} className={`${inp} h-auto min-h-9 py-1.5 md:col-span-3 resize-y`} />
      </div>
      {finishFromHours && !finishAt && (
        <div className="text-[12px] text-[var(--color-text-muted)]">Finish will be set to <b>{fmtInTz(finishFromHours, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</b> (start + {hours} h).</div>
      )}
      {error && (
        <div role="alert" className="text-[12px] text-red-700 dark:text-red-300">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-9 px-3 text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !startAt} className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] text-[13px] font-extrabold disabled:opacity-40 transition-colors ${quiet ? "bg-[var(--color-text)] text-[var(--color-surface)] hover:opacity-90" : "text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"}`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add to schedule
        </button>
      </div>
    </form>
  );
}

