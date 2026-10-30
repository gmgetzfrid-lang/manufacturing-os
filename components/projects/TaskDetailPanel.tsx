"use client";

// TaskDetailPanel — the "click a task to see everything" slide-over,
// shared by the Execution timeline and the calendar tile view. Models
// the Outlook "click a meeting → detail popover" pattern but for
// execution work: full metadata, inline edit, status changes with a
// captured note, the subtask checklist, and the task's breadcrumb
// activity trail.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useScheduleTz } from "@/components/projects/ScheduleTzContext";
import { spanLabel, startOf, finishOf, effectiveSpans } from "@/lib/scheduleTime";
import { workShiftOf, calendarShift, hoursInSpan, type ShiftCredit } from "@/lib/shiftReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import DateTimePicker from "@/components/projects/DateTimePicker";
import { fmtInTz, fromDateTimeInput, toDateTimeInput, tzAbbrev } from "@/lib/scheduleTz";
import {
  X as XIcon, Pencil, Trash2, Loader2, Save, Clock, MapPin, Hash,
  User, HardHat, AlertTriangle, Sun, Moon, Sunset,
  CalendarDays, Layers, MessageSquarePlus, History, ChevronRight, ChevronLeft,
  Link2, Target, Zap, Ban, ArrowRight,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneNote, ProjectMember } from "@/types/schema";
import { wouldCreateCycle, cascadeDependents, withAncestors, type ReflowNode } from "@/lib/scheduleReflow";
import { LINK_LABEL, linkOf, linkShort, type LinkMap, type LinkType } from "@/lib/scheduleLinks";
import { listMembers } from "@/lib/projects";
import {
  updateMilestone, setMilestoneStatus, setMilestoneProgress, deleteMilestones, setActualTimes, creditProgressTo,
  listMilestoneNotes, addMilestoneNote, updateMilestoneNote, deleteMilestoneNote, applyMilestoneMoves, applyBulkFieldChange, type MilestonePatch,
} from "@/lib/milestones";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import StatusControl from "@/components/projects/StatusControl";
import { CancelJobForm } from "@/components/projects/CancelledJobs";
import CrewPicker from "@/components/projects/CrewPicker";
import ProgressControl, { ProgressSlider, ProgressNoteForm } from "@/components/projects/ProgressControl";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";

interface Props {
  milestone: Milestone;
  subtasks: Milestone[];                 // direct children
  allTasks?: Milestone[];                // every task in the project (for dependency picking)
  childCount: (id: string) => number;    // grandchild counts for subtask rows
  /** Ancestor chain, nearest parent first up to the top-level unit.
   *  Drives the breadcrumb so a task is never shown context-free. */
  ancestors?: Milestone[];
  canEdit: boolean;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  onClose: () => void;
  /** Open on the edit form (a step card's "Edit plan"). */
  startEditing?: boolean;
  onChanged: () => void;                 // parent refreshes its milestone list
  onSelectSubtask?: (m: Milestone) => void;
  /** Open another milestone (used by the breadcrumb to jump to a parent). */
  onSelectMilestone?: (m: Milestone) => void;
  /** Move a task/subtask by N days (routes through the reflow engine,
   *  so the parent span follows). Powers the per-row ◀ ▶ buttons. */
  onMoveDays?: (id: string, deltaDays: number) => void;
  /** The project's critical path (unfinished steps on it) and where it
   *  comes from ("From the schedule file") — for the Critical path row. */
  critical?: { ids: Set<string>; sourceLabel: string };
  /** A step's % with what got done (required for work in progress), and
   *  starting one — for the steps listed under a work order. */
  onSetProgressNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
  /** The schedule's own status save (the time it happened, "record it
   *  early?", undo, filing under the right shift) — used when given. */
  onSetStatus?: (id: string, status: MilestoneStatus, reason?: string, percent?: number, forShift?: ShiftCredit) => Promise<boolean>;
  onStartNote?: (id: string, percent: number, note: string, forShift?: ShiftCredit) => Promise<boolean> | boolean;
}

/** Schedule-file values the app reads for itself, shown elsewhere in
 *  plain words (Critical path row), not in the raw list. */
import { discoveryOf, impactLine, ADDED, kindOf } from "@/lib/discovery";

const HIDDEN_ATTRS = new Set(["ms_critical", "discovery"]);

export default function TaskDetailPanel({
  milestone, subtasks, allTasks, childCount, ancestors, canEdit, userId, userName, userEmail, userRole,
  onClose, onChanged, onSelectSubtask, onSelectMilestone, onMoveDays, critical, onSetProgressNote, onStartNote, onSetStatus, startEditing,
}: Props) {
  const tz = useScheduleTz();
  const [editing, setEditing] = useState(!!startEditing && canEdit);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  // A failed save says so, here, instead of the control just snapping back.
  const [err, setErr] = useState<string | null>(null);
  const failed = (e: unknown) => setErr((e as Error)?.message || "That didn't save - try again.");
  const shiftTimes = useShiftTimes(milestone.projectId);

  const m = milestone;
  const isLeaf = subtasks.length === 0;
  // When it really runs: a phase from its first step to its last — the same
  // times the timeline shows.
  const span = useMemo(() => {
    const sp = m.id && allTasks?.length ? effectiveSpans(allTasks).get(m.id) : undefined;
    return sp ?? { start: startOf(m), finish: finishOf(m) };
  }, [m, allTasks]);

  // Effective progress + status: a leaf carries its own; a summary rolls up its
  // leaf descendants, duration-weighted (computed from the full task list, so
  // sub-rows that are themselves phases also read as derived).
  const progressIndex = useMemo(
    () => buildProgressIndex(allTasks && allTasks.length ? allTasks : [m, ...subtasks], tz),
    [allTasks, m, subtasks, tz],
  );
  const progressInfo = m.id ? progressIndex.get(m.id) : undefined;
  const effPct = progressInfo?.percent ?? (m.percentComplete != null ? Math.round(m.percentComplete) : (m.status === "completed" ? 100 : 0));
  const effStatus: MilestoneStatus = !isLeaf && progressInfo ? progressInfo.status : m.status;

  // Summary roll-up shown on the Subtasks header (done / total leaves + %).
  const leafProgress = useMemo(() => {
    if (isLeaf) return null;
    return {
      done: progressInfo?.leafDone ?? subtasks.filter((s) => s.status === "completed").length,
      total: progressInfo?.leafTotal ?? subtasks.length,
      pct: effPct,
    };
  }, [isLeaf, progressInfo, subtasks, effPct]);

  const loadNotes = useCallback(() => {
    if (!m.id) return;
    listMilestoneNotes(m.id).then(setNotes).catch(() => setNotes([]));
  }, [m.id]);
  useEffect(() => { loadNotes(); }, [loadNotes]);

  const applyStatus = useCallback(async (status: MilestoneStatus, reason?: string, percent?: number, forShift?: ShiftCredit) => {
    if (!m.id) return;
    setBusyStatus(true); setErr(null);
    try {
      if (onSetStatus) await onSetStatus(m.id, status, reason, percent, forShift);
      else {
        await setMilestoneStatus({
          id: m.id, status, statusReason: reason, percentComplete: percent,
          ...(forShift ? { at: new Date(forShift.at).toISOString() } : {}),
          actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
        });
        // At the time it happened (when that wasn't just now).
        if (forShift && Math.abs(forShift.at - Date.now()) > 120_000) await creditProgressTo(m.id, forShift.at);
      }
      loadNotes();
    } catch (e) { failed(e); }
    finally { setBusyStatus(false); onChanged(); }
  }, [m.id, userId, userName, userEmail, userRole, onChanged, loadNotes, onSetStatus]);

  const applyProgress = useCallback(async (percent: number) => {
    if (!m.id) return;
    setBusyStatus(true); setErr(null);
    try {
      await setMilestoneProgress({
        id: m.id, percentComplete: percent,
        actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      loadNotes();
    } catch (e) { failed(e); }
    finally { setBusyStatus(false); onChanged(); }
  }, [m.id, userId, userName, userEmail, userRole, onChanged, loadNotes]);

  const addNote = useCallback(async () => {
    if (!m.id || !noteDraft.trim()) return;
    setErr(null);
    try {
      await addMilestoneNote({
        orgId: m.orgId, milestoneId: m.id, kind: "note", statusAt: m.status,
        body: noteDraft.trim(), createdBy: userId, createdByName: userName,
      });
      setNoteDraft("");
      loadNotes();
    } catch (e) { failed(e); }
  }, [m.id, m.orgId, m.status, noteDraft, userId, userName, loadNotes]);

  // Fix or remove a comment (the shift report shows the latest one).
  const [editNote, setEditNote] = useState<{ id: string; body: string } | null>(null);
  const saveNoteEdit = useCallback(async () => {
    if (!editNote) return;
    setErr(null);
    try { await updateMilestoneNote(editNote.id, editNote.body); setEditNote(null); loadNotes(); }
    catch (e) { failed(e); }
  }, [editNote, loadNotes]);
  const removeNote = useCallback(async (id: string) => {
    if (!(await appConfirm({ message: "Delete this comment? It comes off the shift report too.", tone: "danger", confirmLabel: "Delete" }))) return;
    setErr(null);
    try { await deleteMilestoneNote(id); loadNotes(); } catch (e) { failed(e); }
  }, [loadNotes]);

  // Cancel: off this schedule, still done elsewhere — note and where it went.
  const [cancelling, setCancelling] = useState(false);
  const stepCount = useMemo(() => {
    const list = allTasks ?? subtasks;
    const kids = new Map<string, Milestone[]>();
    for (const t of list) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    const count = (id: string | undefined, guard = 0): number => {
      const ch = id ? kids.get(id) ?? [] : [];
      return ch.length === 0 || guard > 50 ? 1 : ch.reduce((n, c) => n + count(c.id, guard + 1), 0);
    };
    return count(m.id);
  }, [allTasks, subtasks, m.id]);

  const onDelete = useCallback(async () => {
    if (!m.id || !m.projectId) return;
    const n = subtasks.length;
    if (!(await appConfirm({
      message: n > 0
        ? `Delete "${m.name}" and the ${n} step${n === 1 ? "" : "s"} under it, with their comments? This is audited. Use Delete on the timeline's selection if you want Undo.`
        : `Delete "${m.name}" and its comments? This is audited. Use Delete on the timeline's selection if you want Undo.`,
      tone: "danger",
    }))) return;
    setErr(null);
    try {
      await deleteMilestones({ orgId: m.orgId, projectId: m.projectId, ids: [m.id], withChildren: true, actorUserId: userId, actorUserEmail: userEmail });
      onChanged();
      onClose();
    } catch (e) { failed(e); }
  }, [m.id, m.name, m.orgId, m.projectId, subtasks.length, userId, userEmail, onChanged, onClose]);

  // Correct when the work really started / finished (a night completion
  // entered the next morning belongs to the night).
  const [actualEdit, setActualEdit] = useState<{ start: string; finish: string } | null>(null);
  const saveActuals = useCallback(async () => {
    if (!m.id || !actualEdit) return;
    setErr(null);
    // A day without its time isn't a time — don't save it as cleared.
    if ((actualEdit.start && actualEdit.start.length < 16) || (m.status === "completed" && actualEdit.finish && actualEdit.finish.length < 16)) { setErr("Pick the time as well as the day."); return; }
    try {
      await setActualTimes({
        id: m.id,
        actualStartAt: actualEdit.start ? fromDateTimeInput(actualEdit.start, tz) : null,
        ...(m.status === "completed" ? { actualAt: actualEdit.finish ? fromDateTimeInput(actualEdit.finish, tz) : null } : {}),
        actorUserId: userId, actorUserName: userName,
      });
      setActualEdit(null); loadNotes(); onChanged();
    } catch (e) { failed(e); }
  }, [m.id, m.status, actualEdit, tz, userId, userName, loadNotes, onChanged]);

  return (
    <div className="fixed inset-0 z-[150] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full max-w-[440px] bg-[var(--color-surface)] shadow-2xl ring-1 ring-slate-900/10 flex flex-col animate-[slidein_.15s_ease-out]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-start gap-2 bg-gradient-to-b from-white dark:from-[var(--color-surface)] to-slate-50/50 dark:to-[var(--color-surface)]">
          <div className="flex-1 min-w-0">
            {/* Breadcrumb: DEC OUTAGE › Transmix 1 › Shut Down … so the
                task is always shown in the context of its unit. Each
                crumb is clickable to jump up the tree. */}
            {ancestors && ancestors.length > 0 && (
              <nav className="flex items-center gap-0.5 flex-wrap mb-1 text-[10px] text-[var(--color-text-muted)]">
                {ancestors.slice().reverse().map((a, i) => (
                  <React.Fragment key={a.id ?? i}>
                    {i > 0 && <ChevronRight className="w-2.5 h-2.5 text-slate-300" />}
                    <button
                      onClick={() => onSelectMilestone?.(a)}
                      className="font-semibold hover:text-indigo-700 hover:underline truncate max-w-[120px]"
                      title={a.name}
                    >
                      {a.name}
                    </button>
                  </React.Fragment>
                ))}
                <ChevronRight className="w-2.5 h-2.5 text-slate-300" />
              </nav>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill status={effStatus} />
              <span className="text-[10px] font-black tabular-nums text-[var(--color-text-muted)]">{effPct}%</span>
              {m.wbs && <span className="font-mono text-[10px] text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{m.wbs}</span>}
              {!isLeaf && <span className="text-[9px] font-black uppercase tracking-wider bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded">Summary</span>}
            </div>
            <h2 className="mt-1.5 text-base font-bold text-[var(--color-text)] leading-snug break-words">{m.name}</h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canEdit && !editing && (
              <button onClick={() => setEditing(true)} title="Edit" className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Pencil className="w-4 h-4" /></button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"><XIcon className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {err && (
            <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-2 text-[12px] text-rose-800 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span className="flex-1">{err}</span>
              <button onClick={() => setErr(null)} className="shrink-0" title="Dismiss"><XIcon className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {editing ? (
            <>
              <EditForm
                milestone={m} isLeaf={isLeaf} allTasks={allTasks} canSave={canEdit} saving={saving} setSaving={setSaving}
                userId={userId} userName={userName} userEmail={userEmail} userRole={userRole}
                onDone={() => { setEditing(false); onChanged(); }}
                onCancel={() => setEditing(false)}
              />
              {/* Its links are part of the plan too: what it waits on, what
                  waits on it (each saves as it's changed). */}
              <DependencyEditor key={`d:${m.id}`} milestone={m} allTasks={allTasks ?? []} canEdit={canEdit} userId={userId} onChanged={onChanged} onSelectMilestone={onSelectMilestone} />
              <HoldsUpEditor key={`h:${m.id}`} milestone={m} allTasks={allTasks ?? []} canEdit={canEdit} userId={userId} onChanged={onChanged} onSelectMilestone={onSelectMilestone} />
            </>
          ) : (
            <>
              {/* Status + progress. A LEAF is set directly (status picker +
                  the % slider, which keep each other coherent). A SUMMARY is
                  read-only — its status and % roll up from its sub-tasks, just
                  like MS Project / Primavera, so you can't mark a phase done
                  while work under it is still open. */}
              {isLeaf ? (
                <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Status</span>
                    <StatusControl
                      status={m.status}
                      busy={busyStatus}
                      variant="pill"
                      disabled={!canEdit}
                      onPick={(s, reason, p, w) => void applyStatus(s, reason, p, w)}
                      // "In progress" asks for the % (and what got done) — never a bare status.
                      percent={effPct}
                      onSetProgress={(p) => void applyProgress(p)}
                      onStartWithNote={onStartNote && m.id ? async (p, n, w) => { const ok = await onStartNote(m.id!, p, n, w); loadNotes(); onChanged(); return ok; } : undefined}
                    />
                    <span className="text-[10px] text-[var(--color-text-faint)]">incl. on-hold / blocked</span>
                  </div>
                  {/* % done: one tap (or type it), with what got done — a
                      correction too: pick the right number, say why. */}
                  {onSetProgressNote && m.id && canEdit ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">% done</span>
                        <span className="text-sm font-black text-[var(--color-text)] tabular-nums">{effPct}%</span>
                      </div>
                      <ProgressNoteForm key={`${m.id}:${effPct}`} percent={effPct} autoFocus={false} busy={busyStatus}
                        onSave={async (v, n, w) => { const ok = await onSetProgressNote(m.id!, v, n, w); loadNotes(); onChanged(); return ok; }} />
                    </div>
                  ) : (
                    <ProgressSlider percent={effPct} onPick={(p) => void applyProgress(p)} disabled={!canEdit} busy={busyStatus} />
                  )}
                </div>
              ) : (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Phase status</span>
                    <StatusControl status={effStatus} variant="pill" readOnly title="Rolls up from sub-tasks" onPick={() => {}} />
                    <span className="text-sm font-black tabular-nums text-[var(--color-text)]">{effPct}%</span>
                  </div>
                  {/* Rolled-up progress bar. */}
                  <div className="mt-2 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className={`h-full ${effPct === 100 ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`} style={{ width: `${effPct}%` }} />
                  </div>
                  <div className="mt-2 text-[10px] text-[var(--color-text-faint)] flex items-start gap-1">
                    <Layers className="w-3 h-3 mt-0.5 shrink-0" />
                    Its status and % roll up from its steps. Set each step&apos;s progress in the list below.
                  </div>
                </div>
              )}

              {/* Move — reschedule the whole task without dragging. */}
              {canEdit && onMoveDays && m.id && (
                <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Move</span>
                  <div className="inline-flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden">
                    <button onClick={() => onMoveDays(m.id!, -7)} title="1 week earlier" className="px-2 py-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">−1w</button>
                    <button onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]"><ChevronRight className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 7)} title="1 week later" className="px-2 py-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]">+1w</button>
                  </div>
                  <span className="text-[10px] text-[var(--color-text-faint)]">{m.isSummary ? "moves the whole phase together" : "shifts this task (its sub-steps come along)"}</span>
                </div>
              )}

              {/* Metadata */}
              <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2.5">
                <Field icon={<CalendarDays className="w-3.5 h-3.5" />} label="Scheduled">
                  {spanLabel(span.start, span.finish, tz)} <span className="text-[10px] text-[var(--color-text-faint)]">{tzAbbrev(tz, span.start)}</span>
                  {!isLeaf && <span className="block text-[10px] text-[var(--color-text-faint)]">from its first step to its last</span>}
                </Field>
                {isLeaf && (m.actualStartAt || m.actualAt || canEdit) && (
                  <Field icon={<Clock className="w-3.5 h-3.5" />} label="Actual">
                    {actualEdit ? (
                      <span className="block space-y-2.5">
                        <DateTimePicker label="Started" value={actualEdit.start} onChange={(v) => setActualEdit({ ...actualEdit, start: v })} tz={tz} times={shiftTimes}
                          planned={span.start} shortcuts={[{ label: "Planned", at: span.start }]} />
                        {m.status === "completed" && (
                          <DateTimePicker label="Finished" value={actualEdit.finish} onChange={(v) => setActualEdit({ ...actualEdit, finish: v })} tz={tz} times={shiftTimes}
                            planned={span.finish} shortcuts={[{ label: "Planned", at: span.finish }]} />
                        )}
                        <span className="flex justify-end gap-2">
                          <button onClick={() => setActualEdit(null)} className="text-[11px] text-[var(--color-text-muted)]">Cancel</button>
                          <button onClick={() => void saveActuals()} className="text-[11px] font-bold text-[var(--color-accent)]">Save ({tzAbbrev(tz)})</button>
                        </span>
                      </span>
                    ) : (
                      <span>
                        {m.actualStartAt ? `started ${fmtInTz(m.actualStartAt as string, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}`
                          : m.status === "completed" ? "start time not recorded" : m.status === "planned" ? "not started" : "start time not recorded"}
                        {m.status === "completed" ? (m.actualAt ? ` · finished ${fmtInTz(m.actualAt as string, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}` : " · finish time not recorded") : ""}
                        {canEdit && (m.actualStartAt || m.status !== "planned") && (
                          <button onClick={() => setActualEdit({ start: toDateTimeInput(m.actualStartAt as string | null, tz), finish: toDateTimeInput(m.actualAt as string | null, tz) })}
                            className="ml-1.5 text-[10px] font-bold text-[var(--color-accent)] hover:underline" title="Correct when the work really started or finished - the shift that did it gets the credit">correct</button>
                        )}
                      </span>
                    )}
                  </Field>
                )}
                {m.durationHours != null && (
                  <Field icon={<Clock className="w-3.5 h-3.5" />} label="Planned work">{m.durationHours} h</Field>
                )}
                {m.workOrderRef && (
                  <Field icon={<Hash className="w-3.5 h-3.5" />} label="Work order">{m.workOrderRef}</Field>
                )}
                {(m.responsibleParty || m.responsibleOrg) && (
                  <Field icon={<User className="w-3.5 h-3.5" />} label="Responsible (planned)">
                    {[m.responsibleParty, m.responsibleOrg].filter(Boolean).join(" · ")}
                    {m.responsibleKind && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-faint)]">{m.responsibleKind}</span>}
                  </Field>
                )}
                {(m.actualParty || m.actualOrg) && (
                  <Field icon={<HardHat className="w-3.5 h-3.5" />} label="Actually performed by">
                    {[m.actualParty, m.actualOrg].filter(Boolean).join(" · ")}
                    {m.actualKind && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-faint)]">{m.actualKind}</span>}
                  </Field>
                )}
                {m.location && (
                  <Field icon={<MapPin className="w-3.5 h-3.5" />} label="Location">{m.location}</Field>
                )}
                {!isLeaf ? null : (() => {
                  // Which crew does it — what the shift report counts it against.
                  const w = workShiftOf(m, tz, shiftTimes);
                  const label = w === "both" ? "Round the clock" : w === "night" ? "Night shift" : "Day shift";
                  return (
                    <Field icon={w === "night" ? <Moon className="w-3.5 h-3.5" /> : w === "both" ? <Sunset className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />} label="Worked on">
                      {label} <span className="text-[10px] text-[var(--color-text-faint)]">{m.shift === "swing" || ((m.shift === "day" || m.shift === "night") && w === m.shift) ? "· set on the task"
                        : calendarShift(m, shiftTimes) ? `· from its calendar${typeof m.attributes?.work_calendar === "string" ? ` (${m.attributes.work_calendar}, ${String(m.attributes.work_hours ?? "").replace(/,/g, ", ")})` : ""}`
                        : "· from its times - set the crew if that's wrong"}</span>
                    </Field>
                  );
                })()}
                {critical && <CriticalRow m={m} isLeaf={isLeaf} allTasks={allTasks ?? []} critical={critical} canEdit={canEdit}
                  userId={userId} userEmail={userEmail} onChanged={onChanged} />}
                {m.description && (
                  <div className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap pt-1">{m.description}</div>
                )}
              </div>

              {/* Discovery work: what was found, and what it did to the schedule. */}
              {(() => {
                const d = discoveryOf(m);
                if (!d) return null;
                return (
                  <div className="px-4 py-3 border-b border-[var(--color-border)] bg-violet-50/60 dark:bg-violet-950/20">
                    <div className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 mb-1">{ADDED[kindOf(d)].word}{d.of > 1 ? ` · step ${d.seq} of ${d.of}` : ""}</div>
                    <div className="text-xs text-[var(--color-text)] break-words">{d.what}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {ADDED[kindOf(d)].found[0].toUpperCase() + ADDED[kindOf(d)].found.slice(1)} {fmtInTz(d.foundAt, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}{d.foundBy ? ` by ${d.foundBy}` : ""}{d.approvedBy ? ` · approved by ${d.approvedBy}` : ""}
                    </div>
                    <div className={`text-[11px] mt-0.5 ${d.impact.critical ? "font-bold text-rose-700 dark:text-rose-400" : "text-[var(--color-text)]"}`}>When added: {impactLine(d.impact, (h) => `${h} h`)}</div>
                  </div>
                );
              })()}

              {/* Source attributes (the labeled columns from the schedule) */}
              {m.attributes && Object.keys(m.attributes).some((k) => !HIDDEN_ATTRS.has(k)) && (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">From the schedule</div>
                  <div className="grid grid-cols-1 gap-1">
                    {Object.entries(m.attributes).filter(([k]) => !HIDDEN_ATTRS.has(k)).map(([k, v]) => (
                      <div key={k} className="flex items-baseline gap-2 text-xs">
                        <span className="text-[var(--color-text-muted)] shrink-0 capitalize">{k}</span>
                        <span className="flex-1 text-[var(--color-text)] break-words text-right font-medium">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Responsible member (deliverable owner) */}
              <AssigneeEditor milestone={m} canEdit={canEdit} userId={userId} onChanged={onChanged} />

              {/* Dependencies (finish-to-start) */}
              <DependencyEditor
                // A fresh editor per task: nothing typed on one carries to the next.
                key={m.id}
                milestone={m}
                allTasks={allTasks ?? []}
                canEdit={canEdit}
                userId={userId}
                onChanged={onChanged}
                onSelectMilestone={onSelectMilestone}
              />
              <HoldsUpEditor key={`h:${m.id}`} milestone={m} allTasks={allTasks ?? []} canEdit={canEdit} userId={userId} onChanged={onChanged} onSelectMilestone={onSelectMilestone} />

              {/* Subtasks */}
              {subtasks.length > 0 && (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Subtasks</span>
                    {leafProgress && <span className="text-[11px] font-mono text-indigo-600 dark:text-indigo-400 font-bold ml-auto">{leafProgress.done}/{leafProgress.total} · {leafProgress.pct}%</span>}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-faint)] mb-2">
                    % = progress and what got done · dot = status · ◀ ▶ = move this step a day (the rest stay put) · name = open it
                  </div>
                  <ul className="space-y-1">
                    {subtasks.map((s) => {
                      const sInfo = s.id ? progressIndex.get(s.id) : undefined;
                      const sIsSummary = (s.id ? childCount(s.id) : 0) > 0;
                      const sStatus = sIsSummary && sInfo ? sInfo.status : s.status;
                      return (
                      <li key={s.id} className="flex items-center gap-2 py-1 px-1.5 rounded-md hover:bg-[var(--color-surface-2)] group">
                        <span className="shrink-0">
                          {sIsSummary ? (
                            <StatusControl status={sStatus} size="sm" variant="dot" readOnly title="Phase - rolls up from its sub-tasks" onPick={() => {}} />
                          ) : (
                            <StatusControl
                              status={s.status}
                              size="sm"
                              variant="dot"
                              disabled={!canEdit}
                              percent={sInfo?.percent ?? (s.status === "completed" ? 100 : Math.round(s.percentComplete ?? 0))}
                              onPick={(st, reason, p, w) => s.id && void (onSetStatus ? onSetStatus(s.id, st, reason, p, w) : setMilestoneStatus({
                                id: s.id, status: st, statusReason: reason, percentComplete: p,
                                ...(w ? { at: new Date(w.at).toISOString() } : {}),
                                actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
                              }).then(() => (w && Math.abs(w.at - Date.now()) > 120_000 ? creditProgressTo(s.id!, w.at) : undefined))).catch(failed).finally(onChanged)}
                              onStartWithNote={onStartNote && s.id ? async (p, n, w) => { const ok = await onStartNote(s.id!, p, n, w); onChanged(); return ok; } : undefined}
                            />
                          )}
                        </span>
                        <button onClick={() => onSelectSubtask?.(s)} className="flex-1 min-w-0 text-left" title="Open subtask">
                          <span className={`block text-[12px] truncate ${sStatus === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{s.name}</span>
                          <span className="block text-[10px] text-[var(--color-text-muted)] font-mono">{spanLabel(startOf(s), finishOf(s), tz)}{sInfo ? ` · ${sInfo.percent}%` : ""}</span>
                        </button>
                        {/* A step's % with what got done — right here, no need to open it. */}
                        {!sIsSummary && s.id && (
                          <span className="shrink-0">
                            <ProgressControl
                              percent={sInfo?.percent ?? (s.status === "completed" ? 100 : Math.round(s.percentComplete ?? 0))}
                              onPick={(v) => void setMilestoneProgress({
                                id: s.id!, percentComplete: v,
                                actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
                              }).catch(failed).finally(onChanged)}
                              onSaveWithNote={onSetProgressNote ? async (v, n, w) => { const ok = await onSetProgressNote(s.id!, v, n, w); onChanged(); return ok; } : undefined}
                              disabled={!canEdit}
                              size="sm"
                            />
                          </span>
                        )}
                        {canEdit && onMoveDays && s.id && (
                          <span className="shrink-0 flex items-center gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, -1); }}
                              title="Move this step 1 day earlier"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-indigo-700 hover:bg-indigo-50"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, 1); }}
                              title="Move this step 1 day later"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-indigo-700 hover:bg-indigo-50"
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </span>
                        )}
                        {s.id && childCount(s.id) > 0 && <span className="text-[10px] text-[var(--color-text-faint)] font-mono shrink-0">{childCount(s.id)}</span>}
                      </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {/* Activity / breadcrumb trail */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <History className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Activity</span>
                </div>
                {canEdit && (
                  <div className="flex items-start gap-2 mb-3">
                    <input
                      value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Add a note…"
                      className="flex-1 text-xs px-2 py-1.5 border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30"
                      onKeyDown={(e) => { if (e.key === "Enter") void addNote(); }}
                    />
                    <button onClick={() => void addNote()} disabled={!noteDraft.trim()} className="p-1.5 rounded-md text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 disabled:opacity-40" title="Add note">
                      <MessageSquarePlus className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {notes.length === 0 ? (
                  <div className="text-[11px] text-[var(--color-text-faint)] italic">No activity yet.</div>
                ) : (
                  <ul className="space-y-2">
                    {notes.map((n) => (
                      <li key={n.id} className="text-xs">
                        <div className="flex items-center gap-1.5">
                          {n.kind === "reschedule"
                            ? <CalendarDays className="w-3 h-3 text-violet-500 shrink-0" />
                            : n.statusAt
                              ? <StatusPill status={n.statusAt} dotOnly />
                              : <MessageSquarePlus className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />}
                          <span className="font-semibold text-[var(--color-text)]">{n.createdByName ?? "Someone"}</span>
                          <span className="text-[var(--color-text-faint)]">{n.kind === "status" ? "set status" : n.kind === "reschedule" ? "rescheduled" : "noted"}{n.kind === "status" && n.statusAt ? ` · ${labelOf(n.statusAt)}` : ""}</span>
                          <span className="text-[var(--color-text-faint)] ml-auto">{fmtWhen(n.createdAt, tz)}</span>
                        </div>
                        {editNote && editNote.id === n.id ? (
                          <div className="mt-1 flex items-center gap-1.5">
                            <input value={editNote.body} autoFocus onChange={(e) => setEditNote({ id: editNote.id, body: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") void saveNoteEdit(); if (e.key === "Escape") setEditNote(null); }}
                              className="flex-1 text-xs px-2 py-1 border border-[var(--color-border-strong)] rounded-md bg-[var(--color-surface)]" />
                            <button onClick={() => void saveNoteEdit()} className="text-[11px] font-bold text-[var(--color-accent)]">Save</button>
                            <button onClick={() => setEditNote(null)} className="text-[11px] text-[var(--color-text-muted)]">Cancel</button>
                          </div>
                        ) : n.body && (
                          <div className="group flex items-start gap-1.5 mt-0.5 pl-1 border-l-2 border-[var(--color-border)] ml-1">
                            <span className="flex-1 text-[var(--color-text-muted)]">{n.body}</span>
                            {/* A comment is its author's to change. */}
                            {canEdit && n.kind === "note" && n.id && n.createdBy === userId && (
                              <span className="shrink-0 flex gap-1.5 text-[10px] font-bold">
                                <button onClick={() => setEditNote({ id: n.id!, body: n.body ?? "" })} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">Edit</button>
                                <button onClick={() => void removeNote(n.id!)} className="text-[var(--color-text-faint)] hover:text-rose-600">Delete</button>
                              </span>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {canEdit && !editing && (
          <div className="px-4 py-2.5 border-t border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] flex items-center gap-2">
            {cancelling && m.id ? (
              <CancelJobForm id={m.id} name={m.name} steps={stepCount} userId={userId} userName={userName} userEmail={userEmail}
                onClose={() => setCancelling(false)} onDone={() => { onChanged(); onClose(); }} />
            ) : (
              <>
                <button onClick={() => setCancelling(true)} title="Planned, but not done here: kept on record as cancelled, with why (and where it moved)"
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1 rounded-md">
                  <Ban className="w-3.5 h-3.5" /> Cancel job
                </button>
                <button onClick={() => void onDelete()} title="Put in by mistake: gone for good" className="inline-flex items-center gap-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:text-rose-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 px-2 py-1 rounded-md">
                  <Trash2 className="w-3.5 h-3.5" /> Delete task
                </button>
              </>
            )}
          </div>
        )}
        {saving && <div className="absolute inset-0 bg-white/40 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-indigo-600 dark:text-indigo-400" /></div>}
      </div>
      <style jsx>{`@keyframes slidein { from { transform: translateX(16px); opacity: .6 } to { transform: translateX(0); opacity: 1 } }`}</style>
    </div>
  );
}

// ─── Edit form ─────────────────────────────────────────────────

function EditForm({
  milestone, isLeaf, allTasks, canSave, saving, setSaving, userId, userName, userEmail, userRole, onDone, onCancel,
}: {
  milestone: Milestone; isLeaf: boolean; allTasks?: Milestone[]; canSave: boolean; saving: boolean; setSaving: (b: boolean) => void;
  userId: string; userName?: string; userEmail?: string; userRole?: string;
  onDone: () => void; onCancel: () => void;
}) {
  const tz = useScheduleTz();
  const shiftTimes = useShiftTimes(milestone.projectId);
  const m = milestone;
  const [name, setName] = useState(m.name);
  const [start, setStart] = useState(toLocalInput(m.plannedStartAt as string | null | undefined, tz));
  const [finish, setFinish] = useState(toLocalInput(m.plannedAt as string, tz));
  const [durationHours, setDurationHours] = useState(m.durationHours != null ? String(m.durationHours) : "");
  // The work hours the dates hold on its crew's hours — the hours follow
  // the dates when they're changed here, unless the hours were typed.
  const [hoursTyped, setHoursTyped] = useState(false);
  const spanOf = (s: string, f: string) => {
    const a = s.length >= 16 ? Date.parse(fromDateTimeInput(s, tz) ?? "") : NaN, b = f.length >= 16 ? Date.parse(fromDateTimeInput(f, tz) ?? "") : NaN;
    return isLeaf ? hoursInSpan(m, a, b, tz, shiftTimes) : 0;
  };
  const fromDates = spanOf(start, finish);
  const crewWord = (() => {
    const k = isLeaf && fromDates > 0 ? workShiftOf({ ...m, plannedStartAt: fromDateTimeInput(start, tz) ?? m.plannedStartAt, plannedAt: fromDateTimeInput(finish, tz) ?? m.plannedAt, durationHours: null } as Milestone, tz, shiftTimes) : null;
    return k === "both" ? "round the clock" : k === "night" ? "night shift hours" : k === "day" ? "day shift hours" : "";
  })();
  const datesTo = (s: string, f: string) => {
    setStart(s); setFinish(f);
    const h = spanOf(s, f);
    if (!hoursTyped && h > 0) setDurationHours(String(h));
  };
  const [workOrderRef, setWorkOrderRef] = useState(m.workOrderRef ?? "");
  const [responsibleParty, setResponsibleParty] = useState(m.responsibleParty ?? "");
  // Every crew on the schedule, to pick from.
  const crewList = useMemo(() => [...new Set((allTasks ?? []).map((t) => t.responsibleParty?.trim()).filter((x): x is string => !!x))], [allTasks]);
  const [responsibleOrg, setResponsibleOrg] = useState(m.responsibleOrg ?? "");
  const [responsibleKind, setResponsibleKind] = useState(m.responsibleKind ?? "");
  const [actualParty, setActualParty] = useState(m.actualParty ?? "");
  const [actualOrg, setActualOrg] = useState(m.actualOrg ?? "");
  const [actualKind, setActualKind] = useState(m.actualKind ?? "");
  const [location, setLocation] = useState(m.location ?? "");
  const [shift, setShift] = useState<string>(m.shift ?? "");
  const [description, setDescription] = useState(m.description ?? "");
  const [error, setError] = useState<string | null>(null);

  // Live validation — plain-language, computed as you type. `errors`
  // block save; `warnings` are advisory (save still allowed).
  const v = useMemo(() => {
    const errors: Record<string, string> = {};
    const warnings: Record<string, string> = {};
    if (!name.trim()) errors.name = "Give the task a name.";
    const startMs = start ? Date.parse(start) : NaN;
    const finishMs = finish ? Date.parse(finish) : NaN;
    if (!finish || Number.isNaN(finishMs)) errors.finish = "A finish date is required.";
    // A day picked without its time isn't a time yet.
    if (start && start.length < 16) errors.start = "Pick the start time too.";
    if (finish && finish.length < 16) errors.finish = "Pick the finish time too.";
    if (Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs < startMs) {
      errors.finish = "Finish can't be before the start.";
    }
    if (durationHours) {
      const h = Number(durationHours);
      if (Number.isNaN(h) || h < 0) errors.durationHours = "Hours must be 0 or more.";
      else if (h > 24 * 365) warnings.durationHours = "That's a lot of hours - double-check.";
    }
    // Advisory: span vs hours sanity. If a 1-day task claims 200h, flag.
    if (Number.isFinite(startMs) && Number.isFinite(finishMs) && durationHours) {
      const spanDays = Math.max(1, Math.round((finishMs - startMs) / 86400000) + 1);
      const h = Number(durationHours);
      if (!Number.isNaN(h) && h > spanDays * 24) {
        warnings.durationHours = `${h}h won't fit in ${spanDays} day${spanDays === 1 ? "" : "s"} of calendar time.`;
      }
    }
    if (m.baselineFinishAt && finish && Number.isFinite(finishMs)) {
      const drift = Math.round((finishMs - Date.parse(m.baselineFinishAt as string)) / 86400000);
      if (drift !== 0) warnings.finish = `${drift > 0 ? `+${drift}` : drift} day${Math.abs(drift) === 1 ? "" : "s"} vs the approved plan.`;
    }
    return { errors, warnings, hasErrors: Object.keys(errors).length > 0 };
  }, [name, start, finish, durationHours, m.baselineFinishAt]);

  const save = async () => {
    if (!m.id || v.hasErrors) return;
    setSaving(true); setError(null);
    try {
      // Only what was changed here: a field someone else edited while this
      // form was open isn't written back over.
      const was = (x: unknown) => (x == null ? "" : String(x));
      const patch: MilestonePatch = {};
      if (name.trim() !== m.name) patch.name = name.trim();
      const datesChanged = isLeaf && (start !== toLocalInput(m.plannedStartAt as string | null | undefined, tz) || finish !== toLocalInput(m.plannedAt as string, tz));
      if (datesChanged) {
        patch.plannedStartAt = fromDateTimeInput(start, tz);
        patch.plannedAt = fromDateTimeInput(finish, tz) ?? m.plannedAt;
      }
      if (durationHours !== (m.durationHours != null ? String(m.durationHours) : "")) patch.durationHours = durationHours ? Number(durationHours) : null;
      const text: Array<[keyof MilestonePatch, string, unknown]> = [
        ["workOrderRef", workOrderRef, m.workOrderRef], ["responsibleParty", responsibleParty, m.responsibleParty],
        ["responsibleOrg", responsibleOrg, m.responsibleOrg], ["responsibleKind", responsibleKind, m.responsibleKind],
        ["actualParty", actualParty, m.actualParty], ["actualOrg", actualOrg, m.actualOrg], ["actualKind", actualKind, m.actualKind],
        ["location", location, m.location], ["description", description, m.description],
      ];
      for (const [k, now, before] of text) if (now !== was(before)) (patch as Record<string, unknown>)[k] = now;
      if (shift !== (m.shift ?? "")) patch.shift = (shift || null) as MilestonePatch["shift"];
      if (Object.keys(patch).length > 0) {
        await updateMilestone({
          id: m.id, patch,
          updatedBy: userId, updatedByName: userName, updatedByEmail: userEmail, updatedByRole: userRole,
        });
      }
      // New dates keep its task row around it, as a drag on the timeline
      // does. The steps linked after it keep their planned dates.
      if (datesChanged && allTasks?.length && m.projectId) {
        const nodes: ReflowNode[] = allTasks.map((t) => ({
          id: t.id!, parentId: t.parentId ?? null,
          plannedStartAt: (t.plannedStartAt as string | undefined) ?? null,
          plannedAt: t.plannedAt as string,
          status: t.status, dependsOn: t.dependsOn ?? null, links: t.linkTypes ?? null,
        }));
        const mine = { id: m.id, plannedStartAt: (patch.plannedStartAt as string | null | undefined) ?? (m.plannedStartAt as string | undefined) ?? (patch.plannedAt as string) ?? (m.plannedAt as string), plannedAt: (patch.plannedAt as string | undefined) ?? (m.plannedAt as string) };
        const moves = withAncestors(nodes, [mine]).filter((c) => c.id !== m.id);
        if (moves.length) await applyMilestoneMoves({ orgId: m.orgId, projectId: m.projectId, moves, actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole });
      }
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const cls = (field: string) =>
    `${inp} ${v.errors[field] ? "border-rose-400 focus:ring-rose-400/30" : v.warnings[field] ? "border-amber-400 focus:ring-amber-400/30" : ""}`;

  return (
    <div className="p-4 space-y-3">
      <L label="Task name"><input value={name} onChange={(e) => setName(e.target.value)} className={cls("name")} /><Note err={v.errors.name} warn={v.warnings.name} /></L>
      <div className="space-y-2.5">
        <div><DateTimePicker label="Planned start" value={start} onChange={(x) => datesTo(x, finish)} tz={tz} times={shiftTimes} disabled={!isLeaf} future showNow={false} /><Note err={v.errors.start} warn={v.warnings.start} /></div>
        <div><DateTimePicker label="Planned finish" value={finish} onChange={(x) => datesTo(start, x)} tz={tz} times={shiftTimes} disabled={!isLeaf} future showNow={false} /><Note err={v.errors.finish} warn={v.warnings.finish} /></div>
      </div>
      {!isLeaf && <div className="text-[10px] text-[var(--color-text-muted)] -mt-1">A phase runs from its first step to its last - move the phase (or its steps) on the timeline to change its dates.</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Work hours">
          <input type="number" min={0} value={durationHours} onChange={(e) => { setDurationHours(e.target.value); setHoursTyped(true); }} className={cls("durationHours")} />
          <Note err={v.errors.durationHours} warn={v.warnings.durationHours} />
          {fromDates > 0 && (Number(durationHours) !== fromDates ? (
            <span className="block mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              Its dates hold {fromDates} h{crewWord ? ` (${crewWord})` : ""}.{" "}
              <button type="button" onClick={() => { setDurationHours(String(fromDates)); setHoursTyped(false); }} className="font-bold underline">Use {fromDates} h</button>
            </span>
          ) : (
            <span className="block mt-1 text-[11px] text-[var(--color-text-muted)]">From its dates{crewWord ? `, ${crewWord}` : ""}.</span>
          ))}
        </L>
        <L label="Work order #"><input value={workOrderRef} onChange={(e) => setWorkOrderRef(e.target.value)} className={inp} /></L>
      </div>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] pt-1">Responsible (planned)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Person / crew"><CrewPicker value={responsibleParty} onChange={setResponsibleParty} crews={crewList} className="w-full" label="Person / crew" /></L>
        <L label="Dept / company"><input value={responsibleOrg} onChange={(e) => setResponsibleOrg(e.target.value)} className={inp} /></L>
      </div>
      <L label="Type"><KindSelect value={responsibleKind} onChange={setResponsibleKind} /></L>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] pt-1">Actually performed by</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Person / crew"><input value={actualParty} onChange={(e) => setActualParty(e.target.value)} className={inp} /></L>
        <L label="Dept / company"><input value={actualOrg} onChange={(e) => setActualOrg(e.target.value)} className={inp} /></L>
      </div>
      <L label="Type"><KindSelect value={actualKind} onChange={setActualKind} /></L>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} className={inp} /></L>
        <L label="Shift">
          <select value={shift} onChange={(e) => setShift(e.target.value)} className={inp}
            title="Which crew does this work. The shift report counts its planned hours only on that shift.">
            <option value="">Auto - from its times</option>
            <option value="day">Day shift</option>
            <option value="night">Night shift</option>
            <option value="swing">Round the clock</option>
          </select>
        </L>
      </div>
      <L label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inp} resize-y`} /></L>
      {error && <div className="text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-md p-2">{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">Cancel</button>
        <button onClick={() => void save()} disabled={saving || !canSave || v.hasErrors} title={v.hasErrors ? "Fix the highlighted fields first" : undefined} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md disabled:opacity-40">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
        </button>
      </div>
    </div>
  );
}

const inp = "w-full px-2.5 py-1.5 text-sm border border-[var(--color-border-strong)] rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Inline field message — red for a blocking error, amber for advice.
function Note({ err, warn }: { err?: string; warn?: string }) {
  if (!err && !warn) return null;
  return (
    <div className={`mt-0.5 flex items-start gap-1 text-[10.5px] ${err ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}>
      <AlertTriangle className="w-3 h-3 shrink-0 mt-px" /> {err ?? warn}
    </div>
  );
}

function KindSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inp}>
      <option value="">-</option>
      <option value="employee">Employee (in-house)</option>
      <option value="contractor">Contractor</option>
    </select>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[var(--color-text-faint)] mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">{label}</div>
        <div className="text-[13px] text-[var(--color-text)] break-words">{children}</div>
      </div>
    </div>
  );
}

function StatusPill({ status, dotOnly }: { status: MilestoneStatus; dotOnly?: boolean }) {
  const tone =
    status === "completed"   ? "bg-emerald-500" :
    status === "in_progress" ? "bg-blue-500" :
    status === "on_hold"     ? "bg-amber-500" :
    status === "blocked"     ? "bg-rose-500" :
    status === "missed"      ? "bg-rose-600" : "bg-slate-400";
  if (dotOnly) return <span className={`shrink-0 w-2 h-2 rounded-full ${tone}`} title={labelOf(status)} />;
  const text =
    status === "completed"   ? "text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40 border-emerald-200 dark:border-emerald-800" :
    status === "in_progress" ? "text-blue-800 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/40 border-blue-200 dark:border-blue-800" :
    status === "on_hold"     ? "text-amber-900 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/40 border-amber-200 dark:border-amber-800" :
    status === "blocked"     ? "text-rose-800 dark:text-rose-300 bg-rose-100 dark:bg-rose-900/40 border-rose-200 dark:border-rose-800" :
    status === "missed"      ? "text-rose-900 dark:text-rose-200 bg-rose-100 dark:bg-rose-900/40 border-rose-200 dark:border-rose-800" : "text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]";
  return <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${text}`}><span className={`w-1.5 h-1.5 rounded-full ${tone}`} />{labelOf(status)}</span>;
}

function labelOf(s: MilestoneStatus): string {
  return s === "in_progress" ? "In progress" : s === "on_hold" ? "On hold" : s.charAt(0).toUpperCase() + s.slice(1);
}


/** "Oct 26 14:05" in plant time, like every other time on the schedule. */
function fmtWhen(iso: string | number | Date | null | undefined, tz: string): string {
  if (!iso) return "";
  try { return fmtInTz(iso, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }); }
  catch { return ""; }
}

// datetime-local wants "YYYY-MM-DDTHH:mm" — shown and typed in PLANT time.
function toLocalInput(iso: string | null | undefined, tz: string): string {
  return toDateTimeInput(iso, tz);
}

// ─── Dependency editor (finish-to-start links) ─────────────────
function DependencyEditor({
  milestone, allTasks, canEdit, userId, onChanged, onSelectMilestone,
}: {
  milestone: Milestone;
  allTasks: Milestone[];
  canEdit: boolean;
  userId: string;
  onChanged: () => void;
  onSelectMilestone?: (m: Milestone) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The predecessors as last saved here, so adding two in a row (before the
  // schedule reloads) keeps both.
  const [localDeps, setLocalDeps] = useState<{ from: unknown; deps: string[] }>({ from: milestone.dependsOn, deps: milestone.dependsOn ?? [] });
  const deps = useMemo(() => (localDeps.from === milestone.dependsOn ? localDeps.deps : (milestone.dependsOn ?? [])), [localDeps, milestone.dependsOn]);

  const byId = useMemo(() => {
    const map = new Map<string, Milestone>();
    for (const t of allTasks) if (t.id) map.set(t.id, t);
    return map;
  }, [allTasks]);

  const reflowNodes = useMemo<ReflowNode[]>(() => allTasks.map((t) => ({
    id: t.id!, parentId: t.parentId ?? null,
    plannedStartAt: (t.plannedStartAt as string | undefined) ?? null,
    plannedAt: t.plannedAt as string, dependsOn: t.dependsOn ?? null,
    links: t.linkTypes ?? null, status: t.status,
  })), [allTasks]);
  const tz = useScheduleTz();

  // Candidates: any other task that wouldn't create a cycle and isn't already a dep.
  const candidates = useMemo(() => allTasks
    .filter((t) => t.id && t.id !== milestone.id && !deps.includes(t.id) && !wouldCreateCycle(reflowNodes, milestone.id!, t.id))
    .sort((a, b) => (Date.parse(a.plannedAt as string) - Date.parse(b.plannedAt as string)) || (a.name || "").localeCompare(b.name || "")),
    [allTasks, deps, reflowNodes, milestone.id]);

  // The links as last saved here, so a second edit made before the refresh
  // lands builds on the first instead of overwriting it.
  const [localLinks, setLocalLinks] = useState<{ from: unknown; links: LinkMap }>({ from: milestone.linkTypes, links: milestone.linkTypes ?? {} });
  const links = localLinks.from === milestone.linkTypes ? localLinks.links : (milestone.linkTypes ?? {});
  // Save the predecessors and how it waits on each; then, if THIS task now
  // starts too early for one of them, push it (and its own steps, and the
  // task row around it) — nothing else: the steps after it keep their plan.
  const save = async (next: string[], nextLinks: LinkMap = links) => {
    if (!milestone.id) return;
    setSaving(true); setError(null);
    try {
      const kept: LinkMap = {};
      for (const id of next) { const l = nextLinks[id]; if (l && (l.type !== "FS" || l.lagHours)) kept[id] = l; }
      setLocalLinks({ from: milestone.linkTypes, links: kept });
      setLocalDeps({ from: milestone.dependsOn, deps: next });
      await updateMilestone({ id: milestone.id, patch: { dependsOn: next, linkTypes: Object.keys(kept).length ? kept : null }, updatedBy: userId });
      if (next.length && milestone.projectId) {
        const me = milestone.id;
        const nodes = reflowNodes.map((n) => (n.id === me ? { ...n, dependsOn: next, links: kept } : n));
        // 1) Where this task (and its own steps) must now sit.
        const kids = new Map<string, string[]>();
        for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
        const mine = new Set<string>();
        const stack = [me];
        while (stack.length) { const c = stack.pop()!; if (mine.has(c)) continue; mine.add(c); stack.push(...(kids.get(c) ?? [])); }
        const own = cascadeDependents(nodes, next, tz).filter((c) => mine.has(c.id));
        // 2) The task row around it refits; what follows it stays put.
        const moves = withAncestors(nodes, own);
        if (moves.length) await applyMilestoneMoves({ orgId: milestone.orgId, projectId: milestone.projectId, moves, actorUserId: userId });
      }
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  if (allTasks.length === 0) return null;

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Link2 className="w-3.5 h-3.5 text-indigo-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Depends on</span>
        <span className="text-[10px] text-[var(--color-text-faint)]">- and how it waits on each</span>
      </div>
      {deps.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-faint)] italic mb-1.5">No dependencies.</div>
      ) : (
        <div className="space-y-1 mb-1.5">
          {deps.map((id) => {
            const t = byId.get(id);
            const l = linkOf(links, id);
            return (
              <div key={id} className="flex flex-wrap items-center gap-1.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-300 text-[11px] font-semibold pl-2 pr-1 py-0.5">
                <button type="button" className="flex-1 min-w-[55%] break-words text-left hover:underline" onClick={() => t && onSelectMilestone?.(t)} title={withTask(t, byId)}>
                  {withTask(t, byId)}
                </button>
                {canEdit ? (
                  <>
                    <select value={l.type} disabled={saving} title="How this task waits on it"
                      onChange={(e) => void save(deps, { ...links, [id]: { ...l, type: e.target.value as LinkType } })}
                      className="text-[10.5px] font-semibold rounded border border-indigo-200 dark:border-indigo-800 bg-[var(--color-surface)] text-[var(--color-text)] px-1 py-0.5">
                      {(Object.keys(LINK_LABEL) as LinkType[]).map((k) => <option key={k} value={k}>{LINK_LABEL[k]}</option>)}
                    </select>
                    <label className="inline-flex items-center gap-0.5 text-[10.5px]" title="Lag in hours (negative = lead)">
                      +<input key={`${id}-${l.lagHours}`} type="number" step={0.5} defaultValue={l.lagHours} disabled={saving}
                        onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== l.lagHours) void save(deps, { ...links, [id]: { ...l, lagHours: v } }); }}
                        className="w-12 rounded border border-indigo-200 dark:border-indigo-800 bg-[var(--color-surface)] text-[var(--color-text)] px-1 py-0.5 text-right" />h
                    </label>
                  </>
                ) : linkShort(l) ? <span className="text-[10px]">{linkShort(l)}</span> : null}
                {canEdit && (
                  <button type="button" disabled={saving} onClick={() => void save(deps.filter((dd) => dd !== id))} className="p-0.5 rounded-full hover:bg-indigo-200/60 text-indigo-500 hover:text-indigo-800" title="Remove dependency">
                    <XIcon className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {canEdit && (
        <select
          value=""
          disabled={saving || candidates.length === 0}
          onChange={(e) => { if (e.target.value) void save([...deps, e.target.value]); }}
          className="w-full text-[12px] border border-[var(--color-border-strong)] rounded-md px-2 py-1.5 bg-[var(--color-surface)] text-[var(--color-text)] disabled:opacity-50"
        >
          <option value="">{candidates.length === 0 ? "No other tasks available" : "+ Add a predecessor…"}</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id!}>{withTask(t, byId)}</option>
          ))}
        </select>
      )}
      {error && <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">{error}</div>}
    </div>
  );
}

/** "V-7 - Overhead and Bottoms Piping › Welded pipe replacements": a step
 *  with the task it's under, so two of the same name can be told apart. */
function withTask(t: Milestone | undefined, byId: Map<string, Milestone>): string {
  if (!t) return "(removed task)";
  const p = t.parentId ? byId.get(t.parentId) : undefined;
  const h = t.durationHours != null && t.durationHours > 0 ? ` (${Math.round(t.durationHours * 10) / 10} h)` : "";
  return `${p ? `${p.name} › ` : ""}${t.name}${h}`;
}

// ─── Holds up: what can't start until this is done ─────────────
/** The steps that wait on this one (they have it under Depends on), to see
 *  and to change from here: the link is kept on the step that waits. Their
 *  planned dates stay; what the wait pushes shows in the forecast (the
 *  critical path reads the links). */
function HoldsUpEditor({ milestone, allTasks, canEdit, userId, onChanged, onSelectMilestone }: {
  milestone: Milestone; allTasks: Milestone[]; canEdit: boolean; userId: string;
  onChanged: () => void; onSelectMilestone?: (m: Milestone) => void;
}) {
  const me = milestone.id ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(allTasks.filter((t) => t.id).map((t) => [t.id!, t])), [allTasks]);
  // As last saved here, so two changes in a row (before the reload) both stand.
  const [local, setLocal] = useState<{ from: Milestone[]; deps: Map<string, string[]> } | null>(null);
  const depsOf = (t: Milestone) => (local && local.from === allTasks ? local.deps.get(t.id!) : undefined) ?? t.dependsOn ?? [];
  const waiting = allTasks.filter((t) => t.id && t.id !== me && depsOf(t).includes(me))
    .sort((a, b) => Date.parse((a.plannedStartAt ?? a.plannedAt) as string) - Date.parse((b.plannedStartAt ?? b.plannedAt) as string));
  const reflowNodes = useMemo<ReflowNode[]>(() => allTasks.map((t) => ({
    id: t.id!, parentId: t.parentId ?? null, plannedStartAt: (t.plannedStartAt as string | undefined) ?? null,
    plannedAt: t.plannedAt as string, dependsOn: t.dependsOn ?? null, links: t.linkTypes ?? null, status: t.status,
  })), [allTasks]);
  // Steps (not whole tasks) that could wait on it: its own task's first.
  const parents = useMemo(() => new Set(allTasks.map((t) => t.parentId).filter(Boolean)), [allTasks]);
  const candidates = allTasks
    .filter((t) => t.id && t.id !== me && !parents.has(t.id) && t.status !== "completed" && !t.cancelledAt && !depsOf(t).includes(me) && !wouldCreateCycle(reflowNodes, t.id, me))
    .sort((a, b) => Number(b.parentId === milestone.parentId) - Number(a.parentId === milestone.parentId)
      || Date.parse((a.plannedStartAt ?? a.plannedAt) as string) - Date.parse((b.plannedStartAt ?? b.plannedAt) as string));
  const save = async (t: Milestone, next: string[]) => {
    if (!t.id) return;
    setSaving(true); setError(null);
    try {
      const lt = { ...(t.linkTypes ?? {}) };
      for (const k of Object.keys(lt)) if (!next.includes(k)) delete lt[k];
      setLocal((x) => { const deps = new Map(x && x.from === allTasks ? x.deps : []); deps.set(t.id!, next); return { from: allTasks, deps }; });
      await updateMilestone({ id: t.id, patch: { dependsOn: next, linkTypes: Object.keys(lt).length ? lt : null }, updatedBy: userId });
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  if (!me || allTasks.length === 0) return null;
  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 mb-1.5">
        <ArrowRight className="w-3.5 h-3.5 text-amber-600" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Holds up</span>
        <span className="text-[10px] text-[var(--color-text-faint)]">- can&apos;t start until this is done</span>
      </div>
      {waiting.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-faint)] italic mb-1.5">Nothing waits on it.</div>
      ) : (
        <div className="space-y-1 mb-1.5">
          {waiting.map((t) => (
            <div key={t.id} className="flex items-center gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-[11px] font-semibold pl-2 pr-1 py-0.5">
              <button type="button" className="flex-1 min-w-0 break-words text-left hover:underline" onClick={() => onSelectMilestone?.(t)} title={withTask(t, byId)}>
                {withTask(t, byId)}{t.status === "completed" ? " (done)" : ""}
              </button>
              {canEdit && (
                <button type="button" disabled={saving} onClick={() => void save(t, depsOf(t).filter((d) => d !== me))} className="p-0.5 rounded-full hover:bg-amber-200/60 text-amber-700 hover:text-amber-900" title="It doesn't wait on this">
                  <XIcon className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <select value="" disabled={saving || candidates.length === 0} aria-label="Add a step it holds up"
          onChange={(e) => { const t = byId.get(e.target.value); if (t) void save(t, [...depsOf(t), me]); }}
          className="w-full text-[12px] border border-[var(--color-border-strong)] rounded-md px-2 py-1.5 bg-[var(--color-surface)] text-[var(--color-text)] disabled:opacity-50">
          <option value="">{candidates.length === 0 ? "Nothing else could wait on it" : "+ Add a step it holds up…"}</option>
          {candidates.map((t) => <option key={t.id} value={t.id!}>{withTask(t, byId)}</option>)}
        </select>
      )}
      {error && <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">{error}</div>}
    </div>
  );
}

// ─── Assignee (responsible deliverable owner) ──────────────────
function AssigneeEditor({ milestone, canEdit, userId, onChanged }: {
  milestone: Milestone; canEdit: boolean; userId: string; onChanged: () => void;
}) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!milestone.projectId) return;
    let alive = true;
    listMembers(milestone.projectId).then((ms) => { if (alive) setMembers(ms); }).catch(() => {});
    return () => { alive = false; };
  }, [milestone.projectId]);

  const assignedId = milestone.responsibleUserId ?? "";
  const assignedName = milestone.responsibleUserName
    ?? members.find((m) => m.userId === assignedId)?.userName
    ?? null;

  const assign = async (uid: string) => {
    setSaving(true);
    try {
      const m = members.find((x) => x.userId === uid);
      await updateMilestone({
        id: milestone.id!,
        patch: { responsibleUserId: uid || null, responsibleUserName: m?.userName ?? m?.userEmail ?? null },
        updatedBy: userId,
      });
      onChanged();
    } catch (e) { await appAlert({ message: (e as Error).message, tone: "danger" }); }
    finally { setSaving(false); }
  };

  if (!milestone.projectId) return null;

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Target className="w-3.5 h-3.5 text-indigo-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Responsible</span>
        <span className="text-[10px] text-[var(--color-text-faint)]">- the member who owns this deliverable</span>
      </div>
      {canEdit ? (
        <select
          value={assignedId}
          disabled={saving}
          onChange={(e) => void assign(e.target.value)}
          className="w-full text-[12px] border border-[var(--color-border-strong)] rounded-md px-2 py-1.5 bg-[var(--color-surface)] text-[var(--color-text)] disabled:opacity-50"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {(m.userName || m.userEmail || m.userId.slice(0, 8))}{m.responsibility ? ` - ${m.responsibility}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-xs text-[var(--color-text-muted)]">{assignedName || <span className="text-[var(--color-text-faint)] italic">Unassigned</span>}</div>
      )}
    </div>
  );
}

/** On the critical path or not, why, and — for whoever can edit — Auto /
 *  Critical / Not critical. Marking an overall task marks every step under
 *  it (their own marks are cleared so the whole branch follows). */
function CriticalRow({ m, isLeaf, allTasks, critical, canEdit, userId, userEmail, onChanged }: {
  m: Milestone; isLeaf: boolean; allTasks: Milestone[];
  critical: { ids: Set<string>; sourceLabel: string };
  canEdit: boolean; userId: string; userEmail?: string; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(allTasks.filter((t) => t.id).map((t) => [t.id!, t])), [allTasks]);
  const below = useMemo(() => {
    if (isLeaf || !m.id) return [] as Milestone[];
    const kids = new Map<string, Milestone[]>();
    for (const t of allTasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    const out: Milestone[] = [];
    const walk = (id: string) => { for (const c of kids.get(id) ?? []) { out.push(c); if (c.id) walk(c.id); } };
    walk(m.id);
    return out;
  }, [isLeaf, m.id, allTasks]);
  const onCount = isLeaf ? (m.id && critical.ids.has(m.id) ? 1 : 0) : below.filter((t) => t.id && critical.ids.has(t.id)).length;
  const own = m.criticalOverride ?? null;
  const inherited = !own && m.parentId ? (() => {
    for (let t = byId.get(m.parentId!); t; t = t.parentId ? byId.get(t.parentId) : undefined) if (t.criticalOverride) return t;
    return undefined;
  })() : undefined;
  const why = own ? "set on this task" : inherited ? `set on ${inherited.name}` : critical.sourceLabel.toLowerCase();
  const set = async (v: "yes" | "no" | null) => {
    if (!m.id || busy || v === own) return;
    setBusy(true);
    try {
      const clear = below.filter((t) => t.id && t.criticalOverride).map((t) => ({ id: t.id!, after: null }));
      await applyBulkFieldChange({
        orgId: m.orgId, projectId: m.projectId!, field: "criticalOverride",
        changes: [{ id: m.id, after: v }, ...clear],
        summary: { mode: "set", to: v }, actorUserId: userId, actorUserEmail: userEmail,
      });
      onChanged();
    } catch (e) {
      void appAlert({ title: "Not saved", message: /critical_override/.test((e as Error).message) ? "Run migration 20261101_critical_path_control.sql first." : (e as Error).message });
    } finally { setBusy(false); }
  };
  const opt = (v: "yes" | "no" | null, label: string) => (
    <button type="button" disabled={busy} onClick={() => void set(v)} aria-pressed={own === v}
      className={`px-2 py-0.5 text-[11px] font-bold ${own === v ? (v === "yes" ? "bg-rose-600 text-white" : "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900") : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"}`}>
      {label}
    </button>
  );
  return (
    <Field icon={<Zap className="w-3.5 h-3.5" />} label="Critical path">
      <span className={onCount ? "font-bold text-rose-700 dark:text-rose-300" : ""}>
        {isLeaf ? (onCount ? "On the critical path" : "Not critical") : onCount ? `${onCount} of ${below.filter((t) => !allTasks.some((c) => c.parentId === t.id)).length} steps critical` : "No steps critical"}
      </span>
      <span className="ml-1 text-[10px] text-[var(--color-text-faint)]">· {why}</span>
      {canEdit && (
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border-strong)] divide-x divide-[var(--color-border)]" role="group" aria-label="Critical path">
            {opt(null, "Auto")}{opt("yes", "Critical")}{opt("no", "Not critical")}
          </div>
          {!isLeaf && <span className="text-[10px] text-[var(--color-text-faint)]">applies to every step under it</span>}
          {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-faint)]" />}
        </div>
      )}
    </Field>
  );
}
