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
import { workShiftOf } from "@/lib/shiftReport";
import { useShiftTimes } from "@/lib/shiftTimesStore";
import { fmtInTz, fromDateTimeInput, toDateTimeInput, tzAbbrev } from "@/lib/scheduleTz";
import {
  X as XIcon, Pencil, Trash2, Loader2, Save, Clock, MapPin, Hash,
  User, HardHat, AlertTriangle, Sun, Moon, Sunset,
  CalendarDays, Layers, MessageSquarePlus, History, ChevronRight, ChevronLeft,
  Link2, Target,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneNote, ProjectMember } from "@/types/schema";
import { wouldCreateCycle, cascadeDependents, type ReflowNode } from "@/lib/scheduleReflow";
import { LINK_LABEL, linkOf, linkShort, type LinkMap, type LinkType } from "@/lib/scheduleLinks";
import { listMembers } from "@/lib/projects";
import {
  updateMilestone, setMilestoneStatus, setMilestoneProgress, deleteMilestones, setActualTimes,
  listMilestoneNotes, addMilestoneNote, updateMilestoneNote, deleteMilestoneNote, applyMilestoneMoves, type MilestonePatch,
} from "@/lib/milestones";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import StatusControl from "@/components/projects/StatusControl";
import { ProgressSlider } from "@/components/projects/ProgressControl";
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
  onChanged: () => void;                 // parent refreshes its milestone list
  onSelectSubtask?: (m: Milestone) => void;
  /** Open another milestone (used by the breadcrumb to jump to a parent). */
  onSelectMilestone?: (m: Milestone) => void;
  /** Move a task/subtask by N days (routes through the reflow engine,
   *  so the parent span follows). Powers the per-row ◀ ▶ buttons. */
  onMoveDays?: (id: string, deltaDays: number) => void;
}

export default function TaskDetailPanel({
  milestone, subtasks, allTasks, childCount, ancestors, canEdit, userId, userName, userEmail, userRole,
  onClose, onChanged, onSelectSubtask, onSelectMilestone, onMoveDays,
}: Props) {
  const tz = useScheduleTz();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  // A failed save says so, here, instead of the control just snapping back.
  const [err, setErr] = useState<string | null>(null);
  const failed = (e: unknown) => setErr((e as Error)?.message || "That didn't save — try again.");
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

  const applyStatus = useCallback(async (status: MilestoneStatus, reason?: string, percent?: number) => {
    if (!m.id) return;
    setBusyStatus(true); setErr(null);
    try {
      await setMilestoneStatus({
        id: m.id, status, statusReason: reason, percentComplete: percent,
        actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      loadNotes();
    } catch (e) { failed(e); }
    finally { setBusyStatus(false); onChanged(); }
  }, [m.id, userId, userName, userEmail, userRole, onChanged, loadNotes]);

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
            <EditForm
              milestone={m} isLeaf={isLeaf} allTasks={allTasks} canSave={canEdit} saving={saving} setSaving={setSaving}
              userId={userId} userName={userName} userEmail={userEmail} userRole={userRole}
              onDone={() => { setEditing(false); onChanged(); }}
              onCancel={() => setEditing(false)}
            />
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
                      onPick={(s, reason, p) => void applyStatus(s, reason, p)}
                    />
                    <span className="text-[10px] text-[var(--color-text-faint)]">incl. on-hold / blocked</span>
                  </div>
                  <ProgressSlider percent={effPct} onPick={(p) => void applyProgress(p)} disabled={!canEdit} busy={busyStatus} />
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
                    This is a phase — its status and % complete roll up automatically from the sub-tasks below. Set progress on the individual tasks.
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
                      <span className="block space-y-1.5">
                        <label className="flex items-center gap-2 text-[11px]"><span className="w-12 text-[var(--color-text-muted)]">Started</span>
                          <input type="datetime-local" value={actualEdit.start} onChange={(e) => setActualEdit({ ...actualEdit, start: e.target.value })} className="flex-1 h-7 px-1.5 text-xs border border-[var(--color-border-strong)] rounded bg-[var(--color-surface)]" /></label>
                        {m.status === "completed" && (
                          <label className="flex items-center gap-2 text-[11px]"><span className="w-12 text-[var(--color-text-muted)]">Finished</span>
                            <input type="datetime-local" value={actualEdit.finish} onChange={(e) => setActualEdit({ ...actualEdit, finish: e.target.value })} className="flex-1 h-7 px-1.5 text-xs border border-[var(--color-border-strong)] rounded bg-[var(--color-surface)]" /></label>
                        )}
                        <span className="flex justify-end gap-2">
                          <button onClick={() => setActualEdit(null)} className="text-[11px] text-[var(--color-text-muted)]">Cancel</button>
                          <button onClick={() => void saveActuals()} className="text-[11px] font-bold text-[var(--color-accent)]">Save ({tzAbbrev(tz)})</button>
                        </span>
                      </span>
                    ) : (
                      <span>
                        {m.actualStartAt ? `started ${fmtInTz(m.actualStartAt as string, tz, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
                          : m.status === "completed" ? "start time not recorded" : m.status === "planned" ? "not started" : "start time not recorded"}
                        {m.status === "completed" ? (m.actualAt ? ` · finished ${fmtInTz(m.actualAt as string, tz, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : " · finish time not recorded") : ""}
                        {canEdit && (m.actualStartAt || m.status !== "planned") && (
                          <button onClick={() => setActualEdit({ start: toDateTimeInput(m.actualStartAt as string | null, tz), finish: toDateTimeInput(m.actualAt as string | null, tz) })}
                            className="ml-1.5 text-[10px] font-bold text-[var(--color-accent)] hover:underline" title="Correct when the work really started or finished — the shift that did it gets the credit">correct</button>
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
                      {label} <span className="text-[10px] text-[var(--color-text-faint)]">{m.shift === "swing" || ((m.shift === "day" || m.shift === "night") && w === m.shift) ? "· set on the task" : "· from its times"}</span>
                    </Field>
                  );
                })()}
                {m.description && (
                  <div className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap pt-1">{m.description}</div>
                )}
              </div>

              {/* Source attributes (the labeled columns from the schedule) */}
              {m.attributes && Object.keys(m.attributes).length > 0 && (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] mb-2">From the schedule</div>
                  <div className="grid grid-cols-1 gap-1">
                    {Object.entries(m.attributes).map(([k, v]) => (
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
                milestone={m}
                allTasks={allTasks ?? []}
                canEdit={canEdit}
                userId={userId}
                onChanged={onChanged}
                onSelectMilestone={onSelectMilestone}
              />

              {/* Subtasks */}
              {subtasks.length > 0 && (
                <div className="px-4 py-3 border-b border-[var(--color-border)]">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Subtasks</span>
                    {leafProgress && <span className="text-[11px] font-mono text-indigo-600 dark:text-indigo-400 font-bold ml-auto">{leafProgress.done}/{leafProgress.total} · {leafProgress.pct}%</span>}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-faint)] mb-2">
                    Dot = set status · ◀ ▶ = move this step a day earlier/later (the rest stay put) · name = open it
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
                            <StatusControl status={sStatus} size="sm" variant="dot" readOnly title="Phase — rolls up from its sub-tasks" onPick={() => {}} />
                          ) : (
                            <StatusControl
                              status={s.status}
                              size="sm"
                              variant="dot"
                              disabled={!canEdit}
                              onPick={(st, reason, p) => s.id && void setMilestoneStatus({
                                id: s.id, status: st, statusReason: reason, percentComplete: p,
                                actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
                              }).catch(failed).finally(onChanged)}
                            />
                          )}
                        </span>
                        <button onClick={() => onSelectSubtask?.(s)} className="flex-1 min-w-0 text-left" title="Open subtask">
                          <span className={`block text-[12px] truncate ${sStatus === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{s.name}</span>
                          <span className="block text-[10px] text-[var(--color-text-muted)] font-mono">{spanLabel(startOf(s), finishOf(s), tz)}{sInfo ? ` · ${sInfo.percent}%` : ""}</span>
                        </button>
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
                            {canEdit && n.kind === "note" && n.id && (
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
          <div className="px-4 py-2.5 border-t border-[var(--color-border)] bg-slate-50/60 dark:bg-[var(--color-surface-2)] flex items-center">
            <button onClick={() => void onDelete()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400 hover:text-rose-800 hover:bg-rose-50 px-2 py-1 rounded-md">
              <Trash2 className="w-3.5 h-3.5" /> Delete task
            </button>
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
  const m = milestone;
  const [name, setName] = useState(m.name);
  const [start, setStart] = useState(toLocalInput(m.plannedStartAt as string | null | undefined, tz));
  const [finish, setFinish] = useState(toLocalInput(m.plannedAt as string, tz));
  const [durationHours, setDurationHours] = useState(m.durationHours != null ? String(m.durationHours) : "");
  const [workOrderRef, setWorkOrderRef] = useState(m.workOrderRef ?? "");
  const [responsibleParty, setResponsibleParty] = useState(m.responsibleParty ?? "");
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
    if (Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs < startMs) {
      errors.finish = "Finish can't be before the start.";
    }
    if (durationHours) {
      const h = Number(durationHours);
      if (Number.isNaN(h) || h < 0) errors.durationHours = "Hours must be 0 or more.";
      else if (h > 24 * 365) warnings.durationHours = "That's a lot of hours — double-check.";
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
      // New dates push the steps linked after it (finish-to-start) and keep
      // its phase around it, exactly as a drag on the timeline does.
      if (datesChanged && allTasks?.length && m.projectId) {
        const nodes: ReflowNode[] = allTasks.map((t) => ({
          id: t.id!, parentId: t.parentId ?? null,
          plannedStartAt: t.id === m.id ? (patch.plannedStartAt as string | null) ?? null : (t.plannedStartAt as string | undefined) ?? null,
          plannedAt: t.id === m.id ? (patch.plannedAt as string) : (t.plannedAt as string),
          status: t.status, dependsOn: t.dependsOn ?? null, links: t.linkTypes ?? null,
        }));
        const moves = cascadeDependents(nodes, [m.id], tz).filter((c) => c.id !== m.id);
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label={`Start (${tzAbbrev(tz)})`}><input type="datetime-local" value={start} disabled={!isLeaf} onChange={(e) => setStart(e.target.value)} className={cls("start")} /><Note err={v.errors.start} warn={v.warnings.start} /></L>
        <L label={`Finish (${tzAbbrev(tz)})`}><input type="datetime-local" value={finish} disabled={!isLeaf} onChange={(e) => setFinish(e.target.value)} className={cls("finish")} /><Note err={v.errors.finish} warn={v.warnings.finish} /></L>
      </div>
      {!isLeaf && <div className="text-[10px] text-[var(--color-text-muted)] -mt-1">A phase runs from its first step to its last — move the phase (or its steps) on the timeline to change its dates.</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Work hours"><input type="number" min={0} value={durationHours} onChange={(e) => setDurationHours(e.target.value)} className={cls("durationHours")} /><Note err={v.errors.durationHours} warn={v.warnings.durationHours} /></L>
        <L label="Work order #"><input value={workOrderRef} onChange={(e) => setWorkOrderRef(e.target.value)} className={inp} /></L>
      </div>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] pt-1">Responsible (planned)</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Person / crew"><input value={responsibleParty} onChange={(e) => setResponsibleParty(e.target.value)} className={inp} /></L>
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
            <option value="">Auto — from its times</option>
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
      <option value="">—</option>
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
  try { return fmtInTz(iso, tz, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
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
  const deps = useMemo(() => milestone.dependsOn ?? [], [milestone.dependsOn]);

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
  // starts too early for one of them, push it and what follows it — and
  // nothing else (other tasks waiting on the same predecessor stay put).
  const save = async (next: string[], nextLinks: LinkMap = links) => {
    if (!milestone.id) return;
    setSaving(true); setError(null);
    try {
      const kept: LinkMap = {};
      for (const id of next) { const l = nextLinks[id]; if (l && (l.type !== "FS" || l.lagHours)) kept[id] = l; }
      setLocalLinks({ from: milestone.linkTypes, links: kept });
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
        // 2) What follows it, from there.
        const moved = new Map(own.map((c) => [c.id, c]));
        const nodes2 = nodes.map((n) => { const c = moved.get(n.id); return c ? { ...n, plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt } : n; });
        const after = own.length ? cascadeDependents(nodes2, [me], tz) : [];
        const moves = [...own, ...after.filter((c) => !moved.has(c.id))];
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
        <span className="text-[10px] text-[var(--color-text-faint)]">— and how it waits on each</span>
      </div>
      {deps.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-faint)] italic mb-1.5">No dependencies.</div>
      ) : (
        <div className="space-y-1 mb-1.5">
          {deps.map((id) => {
            const t = byId.get(id);
            const l = linkOf(links, id);
            return (
              <div key={id} className="flex items-center gap-1.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-800 dark:text-indigo-300 text-[11px] font-semibold pl-2 pr-1 py-0.5">
                <button type="button" className="flex-1 min-w-0 truncate text-left hover:underline" onClick={() => t && onSelectMilestone?.(t)} title={t?.name ?? id}>
                  {t?.name ?? "(removed task)"}
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
            <option key={t.id} value={t.id!}>{t.name}</option>
          ))}
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
        <span className="text-[10px] text-[var(--color-text-faint)]">— the member who owns this deliverable</span>
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
              {(m.userName || m.userEmail || m.userId.slice(0, 8))}{m.responsibility ? ` — ${m.responsibility}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-xs text-[var(--color-text-muted)]">{assignedName || <span className="text-[var(--color-text-faint)] italic">Unassigned</span>}</div>
      )}
    </div>
  );
}
