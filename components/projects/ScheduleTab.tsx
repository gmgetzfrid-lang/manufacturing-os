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
import { Flag, Plus, Loader2, Check, Calendar, ChevronRight, Upload, Eye, EyeOff, Clock, Trash2, RotateCcw, MoreHorizontal } from "lucide-react";
import DiscoveryTag from "@/components/projects/DiscoveryTag";
import { discoveryOf } from "@/lib/discovery";
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
import { requestSetup, type SetupItem } from "@/lib/scheduleSetup";
import { Card, heroPrimary } from "@/components/ui/PageHero";
import { FindingHost, FindingsReviewHost, PastJobsPanel } from "@/components/projects/Findings";
import { splitCancelled } from "@/lib/cancelledJobs";
import { applyNightStaffing } from "@/lib/nightStaffing";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import QuickUpdate from "@/components/projects/QuickUpdate";
import { sayError } from "@/components/projects/sayError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";

// The project's four schedule tabs: Plan (build the schedule as a list,
// import it, set it up), Today (the shift's screen), Work (the timeline,
// calendar and work orders) and Reports (every report).
export type ScheduleMode = "plan" | "today" | "work" | "reports";
const NO_PHASES: ProjectPhase[] = [];

// A quiet button on a white card; the one orange action is heroPrimary.
const QUIET = "inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors";
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
    } catch (e) { setError(sayError(e)); }
    finally { setLoading(false); }
  }, [orgId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { refreshRef.current = () => { void refresh(); }; }, [refresh]);
  // A change made outside this tab's own views (the baseline set from
  // Setup opened on another part of the page): Shift and Work re-read
  // through their board; Plan re-reads here.
  useEffect(() => {
    if (mode !== "plan") return;
    const on = () => { void refresh(); };
    window.addEventListener("schedule:changed", on);
    return () => window.removeEventListener("schedule:changed", on);
  }, [mode, refresh]);

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
    } catch (e) { setError(sayError(e)); return false; }
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
    } catch (e) { setError(sayError(e)); }
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
    } catch (e) { setError(sayError(e)); }
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
    } catch (e) { setError(`Couldn't undo: ${sayError(e)}`); }
    finally { setUndoing(false); }
  };

  const onDelete = async (id: string) => {
    if (!(await appConfirm({ message: "Delete this task? This action is audited.", tone: "danger" }))) return;
    setBusy(true);
    try { await deleteMilestone(id, userId); await refresh(); }
    catch (e) { setError(sayError(e)); }
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
    } catch (e) { setError(sayError(e)); }
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
      <span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)] shrink-0" />
      <span className="flex-1 min-w-48">
        {undoable.kind === "clear"
          ? `Schedule cleared: ${undoable.count} task${undoable.count === 1 ? "" : "s"} deleted.`
          : `Progress reset on ${undoable.count} task${undoable.count === 1 ? "" : "s"}.`}
        {" "}Undo puts {undoable.kind === "clear" ? "every task back with its notes" : "each task's status, %, times and baseline back as they were"}.
      </span>
      <button onClick={() => void onUndo()} disabled={undoing} className={QUIET}>
        {undoing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Undo
      </button>
      <button onClick={() => setUndoable(null)} disabled={undoing} className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">Dismiss</button>
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
    // The desk table's row, or the phone list's: whichever is showing.
    requestAnimationFrame(() => [document.getElementById(`ms-row-${id}`), document.getElementById(`ms-row-m-${id}`)]
      .find((el) => el && el.getClientRects().length > 0)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    setTimeout(() => setJustAdded((x) => (x === id ? null : x)), 4000);
  };

  return (
    <ProjectTypeProvider projectId={projectId} projectName={projectName} groups={groupNames}>
    <PhaseProvider value={phaseCtx}>
    <EquipmentScopeProvider value={equipmentScope}>
    <div className="space-y-4">
      {/* What's still to set up (shown on the first card below). The wizard
          itself opens from the project page's own copy, on every tab. */}
      <ScheduleSetup {...setupProps} onMissing={setSetupMissing} listen={false} />
      {/* + Finding (a step, a work order, an hour) and the close-out review, on every tab. */}
      <FindingHost orgId={orgId} projectId={projectId} milestones={allMilestones} canEdit={canEdit} />
      <FindingsReviewHost orgId={orgId} projectId={projectId} canEdit={canEdit} timeZone={tz} />
      {error && (
        // Above every panel and day list, so a failed save is never hidden
        // behind the thing you were working in.
        <div className="ui-float ui-float-in fixed bottom-4 max-sm:bottom-[calc(6rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[400] w-[min(36rem,92vw)] flex items-start gap-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-4 py-3">
          <ErrorNote compact className="flex-1" title={error} next="" />
          <button onClick={() => setError(null)} className="shrink-0 -my-1 inline-flex items-center justify-center h-8 pointer-coarse:h-11 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">Dismiss</button>
        </div>
      )}

      {/* No import tip here: an empty schedule shows Import (ScheduleEmptyState), and once there is one it's noise. */}

      {/* Zero-state onboarding — the front door for a new user. */}
      {/* Loading: the shape of the schedule, never a blank area. */}
      {loading && <SkeletonRows rows={7} cols={2} what="the schedule" />}
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
                    <span>Times are in <b className="text-[var(--color-text)]">UTC</b>, the app default.{" "}
                      {canManage ? <button type="button" onClick={() => requestSetup("timezone")} className="font-semibold text-[var(--color-accent-text)] hover:underline">Set the plant time zone</button> : "The project owner sets the plant time zone"} so days and shifts line up for everyone.</span>
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
              setError(sayError(e));
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
              setError(sayError(e));
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
              setError(sayError(e));
              return false;
            }
          }}
        />
      )}
      {/* Planning view — the schedule as an editable list, on its own card:
          search and filters as a quiet row, then the rows. */}
      {!loading && milestones.length > 0 && view === "planning" && (
        <Card pad={false} label={<>Tasks <span className="ml-1 text-[15px] font-normal tabular-nums text-[var(--color-text-muted)]">{visible.length}</span></>}
          action={
            <HelpTooltip>
              <b>Imported rows</b> are read-only milestones from your scheduling tool (P6 / MS Project). They still count toward the earned-value rollup. More › Hide imported rows takes them off this list; they still count.
            </HelpTooltip>
          }>
          <div className="px-4 sm:px-5 py-3">
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
            <div>
              {marking && (
                <MarkSheet names={[allMilestones.find((x) => x.id === marking.id)?.name ?? "Step"]} status={marking.status} tz={tz} times={shiftTimes}
                  onSave={(when, note) => saveMark(marking.id, marking.status, when, note)} onClose={() => setMarking(null)} />
              )}
              <PlanTable rows={planningRows.slice(0, rowLimit)} progress={planProgress} freshId={justAdded}
                canEdit={canEdit} busy={busy} onSetStatus={onSetStatus} onDelete={onDelete}
                query={planFilter.query} onQuery={(q) => setPlanFilter((f) => ({ ...f, query: f.query === q ? "" : q }))} />
              {/* A long schedule ends with "Show N more", so it's plain there's more. */}
              {planningRows.length > rowLimit && (
                <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setRowLimit((n) => n + ROW_STEP)} className={QUIET}>
                    Show {Math.min(ROW_STEP, planningRows.length - rowLimit)} more
                  </button>
                  <button type="button" onClick={() => setRowLimit(Infinity)} className={QUIET}>
                    Show all {planningRows.length}
                  </button>
                  <span className="text-[13px] text-[var(--color-text-muted)]">{Math.min(rowLimit, planningRows.length)} of {planningRows.length} shown</span>
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


// ─── The Plan list: one ruled table ─────────────────────────────

/** What one row of the Plan list reads from its task. */
interface PlanFacts {
  isParent: boolean;
  status: MilestoneStatus;
  pct: number;
  start: Date | null;
  finish: Date;
  actual: Date | null;
  /** Days the actual finish was past (+) or ahead of (−) the planned one. */
  slipDays: number;
  /** Past its planned finish and not done. */
  overdue: boolean;
  /** Days past its planned finish (overdue only). */
  lateDays: number;
  /** Planned finish against the saved baseline, in days (0 = none). */
  driftDays: number;
  baseline: Date | null;
  crew: string;
  /** The row's edge: late, blocked or missed in red; on hold in amber. */
  edge: "bad" | "held" | null;
  imported: boolean;
}

function planFacts(m: Milestone, info: ProgressInfo | undefined, nowMs: number): PlanFacts {
  // A phase's status and % are rolled up from its steps: shown, not set.
  const isParent = info ? !info.isLeaf : !!m.isSummary;
  const status: MilestoneStatus = isParent && info ? info.status : m.status;
  const pct = info ? info.percent : (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));
  const start = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const finish = new Date(m.plannedAt as string);
  const actual = m.actualAt ? new Date(m.actualAt as string) : null;
  const overdue = !actual && finish.getTime() < nowMs && status !== "completed";
  const baseline = m.baselineFinishAt ? new Date(m.baselineFinishAt as string) : null;
  const edge = status === "missed" || status === "blocked" || (overdue && status !== "on_hold") ? "bad" : status === "on_hold" ? "held" : null;
  return {
    isParent, status, pct, start, finish, actual, overdue, baseline, edge,
    slipDays: actual ? Math.round((actual.getTime() - finish.getTime()) / 86400_000) : 0,
    lateDays: overdue ? Math.floor((nowMs - finish.getTime()) / 86400_000) : 0,
    driftDays: baseline ? Math.round((finish.getTime() - baseline.getTime()) / 86400_000) : 0,
    crew: [m.responsibleParty, m.responsibleOrg].map((x) => x?.trim()).filter(Boolean).join(" / "),
    imported: m.source !== "manual",
  };
}

const STATUS_WORD: Record<MilestoneStatus, string> = { planned: "Not started", in_progress: "In progress", completed: "Done", on_hold: "On hold", blocked: "Blocked", missed: "Missed" };
const STATUS_DOT: Record<MilestoneStatus, string> = {
  planned: "var(--color-border-strong)", in_progress: "var(--color-text-muted)", completed: "var(--state-released)",
  on_hold: "var(--state-held)", blocked: "var(--state-overdue)", missed: "var(--state-overdue)",
};

/** Soft status pills: done green, blocked or missed red, on hold amber,
 *  under way in the brand color, not started grey. */
const PILL_TONE: Record<MilestoneStatus, string> = {
  completed: "is-good", blocked: "is-bad", missed: "is-bad", on_hold: "is-warn", in_progress: "", planned: "is-muted",
};

/** Its status as a small soft pill. */
function StatusTag({ status }: { status: MilestoneStatus }) {
  return <span className={`ui-pill ${PILL_TONE[status]}`}>{STATUS_WORD[status]}</span>;
}

/** A tag that filters the list (again: clears it); brand-filled while on. */
function FilterTag({ value, on, onPick, title, className = "", children }: {
  value: string; on: boolean; onPick?: (v: string) => void; title: string; className?: string; children: React.ReactNode;
}) {
  if (!onPick) return <span className={`ui-tag ${className}`}>{children}</span>;
  return (
    <button type="button" onClick={() => onPick(value)} aria-pressed={on} title={on ? "Show every task" : title}
      className={`ui-tag ${on ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : ""} ${className}`}>{children}</button>
  );
}

/** A thin bar in the main color and the %. */
function PctBar({ f }: { f: PlanFacts }) {
  return (
    <span className="inline-flex items-center gap-2" title={f.isParent ? "Rolled up from its steps" : "% complete"}>
      <span className="relative h-2 w-14 rounded-full bg-[var(--color-accent-soft)] overflow-hidden" role="progressbar" aria-valuenow={f.pct} aria-valuemin={0} aria-valuemax={100} aria-label="% complete">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--color-main)]" style={{ width: `${Math.min(100, Math.max(0, f.pct))}%` }} />
      </span>
      <span className="font-display text-[14px] font-semibold tabular-nums text-[var(--color-text)] w-9">{f.pct}%</span>
    </span>
  );
}

/** Under the finish date: when it really finished, or how late it is. */
function FinishNote({ f, fmtDay }: { f: PlanFacts; fmtDay: (d: Date) => string }) {
  // On the day it was planned: nothing to add.
  if (f.actual && f.slipDays === 0) return null;
  if (f.actual) {
    const late = f.slipDays > 0;
    return (
      <div className={`text-[13px] whitespace-nowrap ${late ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text-muted)]"}`}>
        Done {fmtDay(f.actual)}, {Math.abs(f.slipDays)}d {late ? "late" : "early"}
      </div>
    );
  }
  if (f.overdue) return <div className="text-[13px] font-semibold whitespace-nowrap text-[var(--state-overdue)]">{f.lateDays > 0 ? `${f.lateDays}d late` : "Late"}</div>;
  return null;
}

/** The row's actions: Done, and the rest (status, delete) in a menu. */
function RowActions({ m, f, busy, onSetStatus, onDelete }: {
  m: Milestone; f: PlanFacts; busy: boolean;
  onSetStatus: (id: string, s: MilestoneStatus) => void; onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {!f.isParent && f.status !== "completed" && (
        <button type="button" onClick={() => onSetStatus(m.id!, "completed")} disabled={busy} title="Mark it done"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
          <Check className="w-3.5 h-3.5" /> Done
        </button>
      )}
      <RowMenu name={m.name} current={f.isParent ? null : m.status} disabled={busy}
        onPick={(s) => onSetStatus(m.id!, s)} onDelete={() => onDelete(m.id!)} />
    </div>
  );
}

/** ⋯ on a row: set its status (a step; a phase rolls up) or delete it. */
function RowMenu({ name, current, onPick, onDelete, disabled }: {
  name: string; current: MilestoneStatus | null; onPick: (s: MilestoneStatus) => void; onDelete: () => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 });
  // In a portal at a fixed spot, so no card edge clips it; it opens up when
  // the row is near the bottom of the screen.
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - 232, r.right - 224));
      setPos(r.bottom + 330 > window.innerHeight ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const away = () => setOpen(false);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", away, true);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("scroll", away, true); };
  }, [open]);
  const item = "w-full flex items-center gap-2 text-left text-[14px] font-semibold px-3 min-h-10 hover:bg-[var(--color-surface-2)] transition-colors";
  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label={`More for ${name}`} title={current ? "Status, delete" : "Delete"}
        className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setOpen(false)} />
          <div role="menu" className="fixed z-[200] w-56 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg shadow-lg py-1" style={pos}>
            {current ? (
              <>
                <div className="px-3 pt-1.5 pb-1 text-[13px] text-[var(--color-text-muted)]">Set status</div>
                {STATUS_OPTIONS.map((s) => (
                  <button key={s} type="button" role="menuitemradio" aria-checked={s === current} onClick={() => { setOpen(false); if (s !== current) onPick(s); }}
                    className={`${item} ${s === current ? "bg-[var(--color-surface-2)]" : ""}`}>
                    <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: STATUS_DOT[s] }} />
                    {STATUS_WORD[s]}{s === current && <Check className="w-4 h-4 ml-auto" />}
                  </button>
                ))}
              </>
            ) : (
              <div className="px-3 py-2 text-[13px] text-[var(--color-text-muted)]">Its status rolls up from its steps.</div>
            )}
            <div className="my-1 h-px bg-[var(--color-border)]" />
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onDelete(); }} className={`${item} text-[var(--state-overdue)]`}>
              <Trash2 className="w-4 h-4" /> Delete task
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/** What a row opens to: the rest of what's known about the task. */
function RowDetails({ m, f, fmtWhen, fmtDay }: { m: Milestone; f: PlanFacts; fmtWhen: (d: Date) => string; fmtDay: (d: Date) => string }) {
  const tz = useScheduleTz();
  const found = discoveryOf(m);
  const facts: Array<[string, React.ReactNode]> = [
    ["Planned start", f.start ? fmtWhen(f.start) : "-"],
    ["Planned finish", fmtWhen(f.finish)],
    ...(f.actual ? [["Finished", <span key="a" className={f.slipDays > 0 ? "text-[var(--state-overdue)] font-semibold" : ""}>{fmtWhen(f.actual)}</span>] as [string, React.ReactNode]] : []),
    ...(typeof m.durationHours === "number" && m.durationHours > 0 ? [["Hours of work", <span key="h" className="font-display tabular-nums">{m.durationHours} h</span>] as [string, React.ReactNode]] : []),
    ...(m.workOrderRef ? [["Work order", <span key="w" className="ui-id">WO {m.workOrderRef}</span>] as [string, React.ReactNode]] : []),
    ...(f.crew ? [["Crew", f.crew] as [string, React.ReactNode]] : []),
    ...(m.location ? [["Location", m.location] as [string, React.ReactNode]] : []),
    ...(m.linkedRevisionLabel ? [["Linked ref", <span key="l" className="font-display tabular-nums">{m.linkedRevisionLabel}</span>] as [string, React.ReactNode]] : []),
    ...(f.baseline ? [["Against baseline", <span key="b" className={f.driftDays > 0 ? "text-[var(--state-overdue)] font-semibold" : ""}>{f.driftDays === 0 ? `On it (${fmtDay(f.baseline)})` : `${Math.abs(f.driftDays)}d ${f.driftDays > 0 ? "later" : "earlier"} than ${fmtDay(f.baseline)}`}</span>] as [string, React.ReactNode]] : []),
    ...(m.wbs ? [["WBS", <span key="s" className="font-display tabular-nums">{m.wbs}</span>] as [string, React.ReactNode]] : []),
    ["Source", f.imported ? "Imported schedule" : "Added by hand"],
  ];
  return (
    <div className="space-y-3">
      {found && <div className="text-[14px] text-[var(--color-text)]"><DiscoveryTag m={m} tz={tz} className="mr-2" />{found.what}</div>}
      {m.description?.trim() && <p className="max-w-3xl text-[14px] text-[var(--color-text)] whitespace-pre-wrap">{m.description.trim()}</p>}
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-2.5">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[13px] text-[var(--color-text-muted)]">{k}</dt>
            <dd className="text-[14px] text-[var(--color-text)] break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The Plan list: a ruled table on the desk, two-line rows on a phone.
 *  A row opens to its details. */
function PlanTable({ rows, progress, freshId, canEdit, busy, onSetStatus, onDelete, query = "", onQuery }: {
  rows: Array<{ m: Milestone; depth: number }>;
  /** The list's search, and a way to set it (a WO or crew tag filters by itself). */
  query?: string;
  onQuery?: (q: string) => void;
  progress: Map<string, ProgressInfo>;
  freshId: string | null;
  canEdit: boolean; busy: boolean;
  onSetStatus: (id: string, s: MilestoneStatus) => void;
  onDelete: (id: string) => void;
}) {
  const tz = useScheduleTz();
  // "Now" once per mount: render stays pure.
  const [nowMs] = useState<number>(() => Date.now());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Planned dates are plant time.
  const fmtDay = (d: Date) => fmtInTz(d, tz, { month: "short", day: "numeric" });
  const fmtWhen = (d: Date) => fmtInTz(d, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const list = rows.map(({ m, depth }) => ({ m, depth, f: planFacts(m, m.id ? progress.get(m.id) : undefined, nowMs), key: m.id ?? `${m.name}-${depth}` }));
  // A click anywhere on the row opens it, except on its own buttons.
  const rowClick = (e: React.MouseEvent, id: string) => { if (!(e.target as HTMLElement).closest("button, a, input, select")) toggle(id); };
  const edgeOf = (f: PlanFacts) => f.edge && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px]" style={{ background: f.edge === "bad" ? "var(--state-overdue)" : "var(--state-held)" }} />;
  const chevron = (key: string, name: string, isOpen: boolean) => (
    <button type="button" onClick={() => toggle(key)} aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} details for ${name}`}
      className="shrink-0 w-6 h-6 -ml-1 inline-flex items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
      <ChevronRight className={`w-4 h-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
    </button>
  );
  // The WBS, the name, its work order and an Added tag, in one line of text that wraps.
  // The WO tag filters the list to that work order.
  const name = (m: Milestone, f: PlanFacts) => (
    <span className="min-w-0 flex-1 break-words">
      {m.wbs && <span className="mr-1.5 font-display tabular-nums text-[13px] text-[var(--color-text-muted)]">{m.wbs}</span>}
      <span className={`text-[var(--color-text)] ${f.isParent ? "font-semibold" : ""}`}>{m.name}</span>
      {m.workOrderRef && (
        <FilterTag value={m.workOrderRef} on={query === m.workOrderRef} onPick={onQuery} title={`Show only WO ${m.workOrderRef}`} className="ml-1.5 !h-[1.375rem] !px-1.5 align-middle !text-[var(--color-heading)]">
          WO {m.workOrderRef}
        </FilterTag>
      )}
      <DiscoveryTag m={m} tz={tz} className="ml-1.5" />
    </span>
  );
  // The crew as a tag: tap it to see only that crew's tasks.
  const crewTag = (f: PlanFacts) => f.crew
    ? <FilterTag value={f.crew.split(" / ")[0]} on={query === f.crew.split(" / ")[0]} onPick={onQuery} title={`Show only ${f.crew}`} className="max-w-[180px] truncate">{f.crew}</FilterTag>
    : <span className="text-[var(--color-text-faint)]">-</span>;
  return (
    <>
      {/* Desk: a ruled table. */}
      <table className="max-sm:hidden w-full text-[14px]">
        <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
          <tr className="border-b border-[var(--color-border)]">
            <th scope="col" className="font-semibold pl-4 sm:pl-5 pr-4 h-10">Task</th>
            <th scope="col" className="font-semibold px-3 w-[128px]">Status</th>
            <th scope="col" className="font-semibold px-3 w-[120px]">Progress</th>
            <th scope="col" className="font-semibold px-3 w-[84px]">Start</th>
            <th scope="col" className="font-semibold px-3 w-[120px]">Finish</th>
            <th scope="col" className="font-semibold px-3 w-[180px] hidden lg:table-cell">Crew</th>
            {canEdit && <th scope="col" className="font-semibold pl-3 pr-4 sm:pr-5 w-[124px]"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {list.map(({ m, depth, f, key }) => {
            const isOpen = open.has(key);
            return (
              <React.Fragment key={key}>
                <tr id={m.id ? `ms-row-${m.id}` : undefined} onClick={(e) => rowClick(e, key)}
                  className={`border-b border-[var(--color-border)] align-top cursor-pointer transition-colors ${m.id && m.id === freshId ? "bg-[var(--color-surface-2)]" : isOpen ? "bg-[var(--color-surface-2)]/60" : "hover:bg-[var(--color-surface-2)]"}`}>
                  <td className="relative pr-4 py-2.5" style={{ paddingLeft: 16 + Math.min(depth, 6) * 18 }}>
                    {edgeOf(f)}
                    <div className="flex items-start gap-2 min-w-0 leading-6">
                      {chevron(key, m.name, isOpen)}
                      {name(m, f)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 leading-6"><StatusTag status={f.status} /></td>
                  <td className="px-3 py-2.5 leading-6"><PctBar f={f} /></td>
                  <td className="px-3 py-2.5 leading-6 whitespace-nowrap font-display tabular-nums text-[var(--color-text)]">{f.start ? fmtDay(f.start) : "-"}</td>
                  <td className="px-3 py-2.5 leading-6">
                    <div className={`whitespace-nowrap font-display tabular-nums ${f.overdue ? "text-[var(--state-overdue)] font-semibold" : "text-[var(--color-text)]"}`}>{fmtDay(f.finish)}</div>
                    <FinishNote f={f} fmtDay={fmtDay} />
                  </td>
                  <td className="px-3 py-2.5 leading-6 hidden lg:table-cell">{crewTag(f)}</td>
                  {canEdit && <td className="pl-3 pr-4 sm:pr-5 py-1.5"><RowActions m={m} f={f} busy={busy} onSetStatus={onSetStatus} onDelete={onDelete} /></td>}
                </tr>
                {isOpen && (
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
                    <td colSpan={canEdit ? 7 : 6} className="pr-5 pt-1 pb-4" style={{ paddingLeft: 16 + Math.min(depth, 6) * 18 + 28 }}>
                      <RowDetails m={m} f={f} fmtWhen={fmtWhen} fmtDay={fmtDay} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Phone: two lines a task. */}
      <ul className="sm:hidden divide-y divide-[var(--color-border)]">
        {list.map(({ m, depth, f, key }) => {
          const isOpen = open.has(key);
          return (
            <li key={key} id={m.id ? `ms-row-m-${m.id}` : undefined} className={`relative ${m.id && m.id === freshId ? "bg-[var(--color-surface-2)]" : ""}`}>
              {edgeOf(f)}
              <div onClick={(e) => rowClick(e, key)} className="pr-3 py-2.5 cursor-pointer active:bg-[var(--color-surface-2)]" style={{ paddingLeft: 14 + Math.min(depth, 4) * 10 }}>
                <div className="flex items-start gap-2 min-w-0 text-[15px] leading-6">
                  {chevron(key, m.name, isOpen)}
                  {name(m, f)}
                  <span className="shrink-0"><StatusTag status={f.status} /></span>
                </div>
                <div className="mt-1 pl-6 flex items-center gap-x-3 text-[13px] text-[var(--color-text-muted)]">
                  <span className="shrink-0"><PctBar f={f} /></span>
                  <span className={`shrink-0 font-display tabular-nums ${f.overdue ? "text-[var(--state-overdue)] font-semibold" : ""}`}>
                    {f.start && fmtDay(f.start) !== fmtDay(f.finish) ? `${fmtDay(f.start)} to ${fmtDay(f.finish)}` : fmtDay(f.finish)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{f.crew && crewTag(f)}</span>
                  {canEdit && <span className="shrink-0 -my-1"><RowActions m={m} f={f} busy={busy} onSetStatus={onSetStatus} onDelete={onDelete} /></span>}
                </div>
              </div>
              {isOpen && <div className="pr-3 pb-3" style={{ paddingLeft: 14 + Math.min(depth, 4) * 10 + 24 }}><FinishNote f={f} fmtDay={fmtDay} /><div className="mt-2"><RowDetails m={m} f={f} fmtWhen={fmtWhen} fmtDay={fmtDay} /></div></div>}
            </li>
          );
        })}
      </ul>
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
    } catch (e) { setError(sayError(e)); }
    finally { setBusy(false); }
  };

  const inp = "h-9 text-[13px] border border-[var(--color-border-strong)] rounded-lg px-2.5 bg-[var(--color-surface)]";
  const lbl = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1";

  return (
    <form onSubmit={submit} className="px-4 sm:px-5 py-4 bg-[var(--color-surface-2)]/60 border-b border-[var(--color-border)] space-y-3">
      <div className="font-display text-[17px] font-semibold text-[var(--color-text)]">Add a task</div>
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
            className={`${inp} w-full font-display tabular-nums`} />
        </label>
        <label>
          <span className={lbl}>Weight</span>
          <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="1"
            title="How much this step counts in the % complete when it has no hours - a big scope worth 3× a small one gets weight 3. Leave 1 when unsure."
            className={`${inp} w-full font-display tabular-nums`} />
        </label>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <input value={linkedRev} onChange={(e) => setLinkedRev(e.target.value)} placeholder='Linked ref (e.g. "WO 48812")' className={inp} />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional notes" rows={1} className={`${inp} h-auto min-h-9 py-1.5 md:col-span-3 resize-y`} />
      </div>
      {finishFromHours && !finishAt && (
        <div className="text-[13px] text-[var(--color-text-muted)]">Finish will be set to <b>{fmtInTz(finishFromHours, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</b> (start + {hours} h).</div>
      )}
      {error && (
        <div role="alert" className="text-[13px] font-semibold text-[var(--state-overdue)]">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className={QUIET}>Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !startAt} className={quiet ? QUIET : "inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-[14px] font-semibold disabled:opacity-40 transition-colors text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add to schedule
        </button>
      </div>
    </form>
  );
}

