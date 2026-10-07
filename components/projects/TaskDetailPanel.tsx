"use client";

// TaskDetailPanel — the "click a task to see everything" slide-over,
// shared by the Execution timeline and the calendar tile view. Models
// the Outlook "click a meeting → detail popover" pattern but for
// execution work: full metadata, inline edit, status changes with a
// captured note, the subtask checklist, and the task's breadcrumb
// activity trail.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { userFacingCaughtError } from "@/lib/userFacingError";
import {
  X as XIcon, Pencil, Trash2, Loader2, Save, Clock, MapPin, Hash,
  User, HardHat, AlertTriangle, Sun, Moon, Sunset,
  CalendarDays, Layers, MessageSquarePlus, History, ChevronRight, ChevronLeft,
  Link2, Target,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneNote, ProjectMember } from "@/types/schema";
import { dependentsClosure, reflowNodesFromMilestones, toWallClock, fromWallClock } from "@/lib/scheduleReflow";
import { isImportedMilestone } from "@/lib/milestoneLiveness";
import { listMembers } from "@/lib/projects";
import {
  updateMilestone, setMilestoneStatus, setMilestoneProgress, deleteMilestone,
  listMilestoneNotes, addMilestoneNote, planMilestoneDelete, type MilestonePatch,
} from "@/lib/milestones";
import { buildProgressIndex } from "@/lib/scheduleProgress";
import StatusControl from "@/components/projects/StatusControl";
import { ProgressSlider } from "@/components/projects/ProgressControl";
import { appAlert, appConfirm } from "@/components/providers/DialogProvider";

interface Props {
  milestone: Milestone;
  subtasks: Milestone[];                 // direct children
  allTasks?: Milestone[];                // EVERY task in the project — never a filtered view (dependency picking, PT SCH-9)
  /** Rows the board's display filter hides — a link to one reads "hidden
   *  by filter", not "removed" (PT SCH-9). */
  hiddenIds?: ReadonlySet<string>;
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
  milestone, subtasks, allTasks, hiddenIds, childCount, ancestors, canEdit, userId, userName, userEmail, userRole,
  onClose, onChanged, onSelectSubtask, onSelectMilestone, onMoveDays,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");

  const m = milestone;
  const isLeaf = subtasks.length === 0;
  // An imported row's dates, structure and planned fields belong to the
  // scheduling tool (PT SCH-13) — shown here, set there.
  const imported = isImportedMilestone(m);

  // Effective progress + status: a leaf carries its own; a summary rolls up its
  // leaf descendants, duration-weighted (computed from the full task list, so
  // sub-rows that are themselves phases also read as derived).
  const progressIndex = useMemo(
    () => buildProgressIndex(allTasks && allTasks.length ? allTasks : [m, ...subtasks]),
    [allTasks, m, subtasks],
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

  const applyStatus = useCallback(async (status: MilestoneStatus, note?: string) => {
    if (!m.id) return;
    setBusyStatus(true);
    try {
      await setMilestoneStatus({
        id: m.id, status, note,
        actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      loadNotes();
      onChanged();
    } finally { setBusyStatus(false); }
  }, [m.id, userId, userName, userEmail, userRole, onChanged, loadNotes]);

  const applyProgress = useCallback(async (percent: number) => {
    if (!m.id) return;
    setBusyStatus(true);
    try {
      await setMilestoneProgress({
        id: m.id, percentComplete: percent,
        actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      loadNotes();
      onChanged();
    } finally { setBusyStatus(false); }
  }, [m.id, userId, userName, userEmail, userRole, onChanged, loadNotes]);

  const addNote = useCallback(async () => {
    if (!m.id || !noteDraft.trim()) return;
    await addMilestoneNote({
      orgId: m.orgId, milestoneId: m.id, kind: "note", statusAt: m.status,
      body: noteDraft.trim(), createdBy: userId, createdByName: userName,
    });
    setNoteDraft("");
    loadNotes();
  }, [m.id, m.orgId, m.status, noteDraft, userId, userName, loadNotes]);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const onDelete = useCallback(async () => {
    if (!m.id) return;
    // Say what the delete does to the rest of the schedule (PT SCH-17).
    const plan = planMilestoneDelete(allTasks && allTasks.length ? allTasks : [m, ...subtasks], m.id);
    const parentName = plan.newParentId ? (allTasks ?? []).find((t) => t.id === plan.newParentId)?.name ?? "its parent" : null;
    const parts = [`Delete "${m.name}"? This is audited and cannot be undone.`];
    if (plan.children.length > 0) parts.push(`Its ${plan.children.length} sub-task${plan.children.length === 1 ? "" : "s"}${plan.descendants > plan.children.length ? ` (${plan.descendants} tasks in all)` : ""} will move up to ${parentName ? `“${parentName}”` : "the top level"} — none is deleted.`);
    if (plan.dependents.length > 0) parts.push(`${plan.dependents.length} task${plan.dependents.length === 1 ? "" : "s"} that depend${plan.dependents.length === 1 ? "s" : ""} on it will lose that link.`);
    if (imported) parts.push(`It came from ${m.source}: the next import of a file that still contains it adds it back.`);
    if (!(await appConfirm({ message: parts.join(" "), tone: "danger" }))) return;
    setDeleteError(null);
    try {
      await deleteMilestone(m.id, userId);
    } catch (e) { setDeleteError(userFacingCaughtError(e, { context: "TaskDetailPanel" })); onChanged(); return; }
    onChanged();
    onClose();
  }, [m, subtasks, allTasks, imported, userId, onChanged, onClose]);

  return (
    <div className="fixed inset-0 z-[150] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full max-w-[440px] bg-[var(--color-surface)] shadow-2xl ring-1 ring-slate-900/10 flex flex-col animate-[slidein_.15s_ease-out]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-start gap-2 bg-gradient-to-b from-white to-slate-50/50">
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
                      className="font-semibold hover:text-indigo-700 dark:hover:text-indigo-300 hover:underline truncate max-w-[120px]"
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
              {!isLeaf && <span className="text-[9px] font-black uppercase tracking-wider bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded">Summary</span>}
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
          {editing ? (
            <EditForm
              milestone={m} canSave={canEdit} saving={saving} setSaving={setSaving}
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
                      onPick={(s, reason) => void applyStatus(s, reason)}
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
              {canEdit && imported && (
                <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]">
                  Imported from <b>{m.source}</b>: its dates, place in the outline and links are set in the scheduling tool and come back with the next import — change them there. Status, % complete and who did the work are recorded here and survive a re-import.
                </div>
              )}
              {canEdit && onMoveDays && m.id && !imported && (
                <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Move</span>
                  <div className="inline-flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden">
                    <button onClick={() => onMoveDays(m.id!, -7)} title="1 week earlier" className="px-2 py-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">−1w</button>
                    <button onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]"><ChevronLeft className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]"><ChevronRight className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 7)} title="1 week later" className="px-2 py-1 text-[11px] font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] border-l border-[var(--color-border)]">+1w</button>
                  </div>
                  <span className="text-[10px] text-[var(--color-text-faint)]">{m.isSummary ? "moves the whole phase together" : "shifts this task (its sub-tasks come along)"}</span>
                </div>
              )}

              {/* Metadata */}
              <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-2.5">
                <Field icon={<CalendarDays className="w-3.5 h-3.5" />} label="Scheduled">
                  {fmtRange(m)}
                </Field>
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
                {m.shift && (
                  <Field icon={m.shift === "night" ? <Moon className="w-3.5 h-3.5" /> : m.shift === "swing" ? <Sunset className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />} label="Shift">
                    <span className="capitalize">{m.shift}</span>
                  </Field>
                )}
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
                hiddenIds={hiddenIds}
                canEdit={canEdit && !imported}
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
                    {leafProgress && <span className="text-[11px] font-mono text-indigo-600 font-bold ml-auto">{leafProgress.done}/{leafProgress.total} · {leafProgress.pct}%</span>}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-faint)] mb-2">
                    Dot = set status · ◀ ▶ = move this sub-task a day earlier/later (the rest stay put) · name = open it
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
                              onPick={(st, reason) => s.id && void setMilestoneStatus({
                                id: s.id, status: st, note: reason,
                                actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
                              }).then(onChanged)}
                            />
                          )}
                        </span>
                        <button onClick={() => onSelectSubtask?.(s)} className="flex-1 min-w-0 text-left" title="Open subtask">
                          <span className={`block text-[12px] truncate ${sStatus === "completed" ? "line-through text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{s.name}</span>
                          <span className="block text-[9px] text-[var(--color-text-faint)] font-mono">{shortDate(s.plannedAt as string)}{sInfo ? ` · ${sInfo.percent}%` : ""}</span>
                        </button>
                        {canEdit && onMoveDays && s.id && (
                          <span className="shrink-0 flex items-center gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, -1); }}
                              title="Move this sub-task 1 day earlier"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-indigo-700 dark:hover:text-indigo-300 hover:bg-indigo-500/10"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, 1); }}
                              title="Move this sub-task 1 day later"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-[var(--color-text-faint)] hover:text-indigo-700 dark:hover:text-indigo-300 hover:bg-indigo-500/10"
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
                    <button onClick={() => void addNote()} disabled={!noteDraft.trim()} className="p-1.5 rounded-md text-indigo-600 hover:bg-indigo-500/10 disabled:opacity-40" title="Add note">
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
                          <span className="text-slate-300 ml-auto">{fmtWhen(n.createdAt)}</span>
                        </div>
                        {n.body && <div className="text-[var(--color-text-muted)] mt-0.5 pl-1 border-l-2 border-[var(--color-border)] ml-1">{n.body}</div>}
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
          <div className="px-4 py-2.5 border-t border-[var(--color-border)] bg-slate-50/60 flex items-center gap-2 flex-wrap">
            <button onClick={() => void onDelete()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:text-rose-800 dark:hover:text-rose-200 hover:bg-rose-500/10 px-2 py-1 rounded-md">
              <Trash2 className="w-3.5 h-3.5" /> Delete task
            </button>
            {deleteError && <span role="alert" className="text-[11px] text-rose-700 dark:text-rose-300">{deleteError}</span>}
          </div>
        )}
        {saving && <div className="absolute inset-0 bg-white/40 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-indigo-600" /></div>}
      </div>
      <style jsx>{`@keyframes slidein { from { transform: translateX(16px); opacity: .6 } to { transform: translateX(0); opacity: 1 } }`}</style>
    </div>
  );
}

// ─── Edit form ─────────────────────────────────────────────────

function EditForm({
  milestone, canSave, saving, setSaving, userId, userName, userEmail, userRole, onDone, onCancel,
}: {
  milestone: Milestone; canSave: boolean; saving: boolean; setSaving: (b: boolean) => void;
  userId: string; userName?: string; userEmail?: string; userRole?: string;
  onDone: () => void; onCancel: () => void;
}) {
  const m = milestone;
  // Planned dates are wall-clock-as-UTC: the inputs show and take the UTC
  // fields (PT SCH-10 — a local rendering read a day early west of UTC and
  // saved a day late). Only a date the user actually changed is written.
  const imported = isImportedMilestone(m);
  const initialStart = toScheduleInput(m.plannedStartAt as string | null | undefined);
  const initialFinish = toScheduleInput(m.plannedAt as string);
  const [name, setName] = useState(m.name);
  const [start, setStart] = useState(initialStart);
  const [finish, setFinish] = useState(initialFinish);
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
    const startMs = start ? Date.parse(fromScheduleInput(start) ?? "") : NaN;
    const finishMs = finish ? Date.parse(fromScheduleInput(finish) ?? "") : NaN;
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
      // An imported row sends only what is recorded here (PT SCH-13); the
      // plan fields belong to the scheduling tool (and are refused below the
      // UI if they differ).
      const patch: MilestonePatch = imported
        ? { actualParty, actualOrg, actualKind }
        : {
            name: name.trim(),
            durationHours: durationHours ? Number(durationHours) : null,
            workOrderRef, responsibleParty, responsibleOrg, responsibleKind,
            actualParty, actualOrg, actualKind, location, description,
            shift: (shift || null) as MilestonePatch["shift"],
          };
      if (!imported && start !== initialStart) patch.plannedStartAt = start ? fromScheduleInput(start) : null;
      if (!imported && finish !== initialFinish) patch.plannedAt = (finish ? fromScheduleInput(finish) : null) ?? m.plannedAt;
      await updateMilestone({
        id: m.id, patch,
        updatedBy: userId, updatedByName: userName, updatedByEmail: userEmail, updatedByRole: userRole,
      });
      onDone();
    } catch (e) { setError(userFacingCaughtError(e, { context: "TaskDetailPanel" })); }
    finally { setSaving(false); }
  };

  const cls = (field: string) =>
    `${inp} ${v.errors[field] ? "border-rose-400 focus:ring-rose-400/30" : v.warnings[field] ? "border-amber-400 focus:ring-amber-400/30" : ""}`;

  return (
    <div className="p-4 space-y-3">
      {imported && (
        <div className="text-[11px] text-[var(--color-text-muted)] rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          Imported from <b>{m.source}</b>: the name, dates, work hours and planned fields are set in the scheduling tool and come back with the next import, so they are read-only here. Who actually did the work is recorded here.
        </div>
      )}
      <fieldset disabled={imported} className="space-y-3 disabled:opacity-60">
      <L label="Task name"><input value={name} onChange={(e) => setName(e.target.value)} className={cls("name")} /><Note err={v.errors.name} warn={v.warnings.name} /></L>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Start (schedule time)"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${cls("start")} bg-[var(--color-surface)] [color-scheme:light] dark:[color-scheme:dark]`} /><Note err={v.errors.start} warn={v.warnings.start} /></L>
        <L label="Finish (schedule time)"><input type="datetime-local" value={finish} onChange={(e) => setFinish(e.target.value)} className={`${cls("finish")} bg-[var(--color-surface)] [color-scheme:light] dark:[color-scheme:dark]`} /><Note err={v.errors.finish} warn={v.warnings.finish} /></L>
      </div>
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
      </fieldset>
      <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)] pt-1">Actually performed by</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Person / crew"><input value={actualParty} onChange={(e) => setActualParty(e.target.value)} className={inp} /></L>
        <L label="Dept / company"><input value={actualOrg} onChange={(e) => setActualOrg(e.target.value)} className={inp} /></L>
      </div>
      <L label="Type"><KindSelect value={actualKind} onChange={setActualKind} /></L>
      <fieldset disabled={imported} className="space-y-3 disabled:opacity-60">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <L label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} className={inp} /></L>
        <L label="Shift">
          <select value={shift} onChange={(e) => setShift(e.target.value)} className={inp}>
            <option value="">—</option>
            <option value="day">Day</option>
            <option value="night">Night</option>
            <option value="swing">Swing</option>
          </select>
        </L>
      </div>
      <L label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inp} resize-y`} /></L>
      </fieldset>
      {error && <div role="alert" className="text-xs font-bold text-rose-700 dark:text-rose-300 bg-rose-500/[0.08] border border-rose-500/50 rounded-md p-2">{error}</div>}
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
    <div className={`mt-0.5 flex items-start gap-1 text-[10.5px] ${err ? "text-rose-700 dark:text-rose-300" : "text-amber-800 dark:text-amber-300"}`}>
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
    status === "completed"   ? "text-emerald-800 dark:text-emerald-300 bg-emerald-500/15 border-emerald-500/40" :
    status === "in_progress" ? "text-blue-800 dark:text-blue-300 bg-blue-500/15 border-blue-500/40" :
    status === "on_hold"     ? "text-amber-900 dark:text-amber-200 bg-amber-500/15 border-amber-500/40" :
    status === "blocked"     ? "text-rose-800 dark:text-rose-300 bg-rose-500/15 border-rose-500/40" :
    status === "missed"      ? "text-rose-900 dark:text-rose-200 bg-rose-500/15 border-rose-500/40" : "text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]";
  return <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${text}`}><span className={`w-1.5 h-1.5 rounded-full ${tone}`} />{labelOf(status)}</span>;
}

function labelOf(s: MilestoneStatus): string {
  return s === "in_progress" ? "In progress" : s === "on_hold" ? "On hold" : s.charAt(0).toUpperCase() + s.slice(1);
}

function shortDate(iso?: string): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }); }
  catch { return ""; }
}

// One end of a planned span. Schedule dates are wall-clock-as-UTC, so format in
// UTC (a task entered as 08:00 in MS Project reads as 08:00, not shifted into
// the viewer's timezone). Tasks with no meaningful time-of-day (stored at
// midnight UTC, e.g. a date-only import) show just the date — no "12:00 AM".
function fmtSchedulePoint(d: Date): string {
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0;
  const opt: Intl.DateTimeFormatOptions = hasTime
    ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }
    : { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" };
  return d.toLocaleString(undefined, opt);
}

function fmtRange(m: Milestone): string {
  const s = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const f = new Date(m.plannedAt as string);
  if (s && s.getTime() !== f.getTime()) return `${fmtSchedulePoint(s)}  →  ${fmtSchedulePoint(f)}`;
  return fmtSchedulePoint(f);
}

function fmtWhen(iso?: string | number | Date | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

// datetime-local wants "YYYY-MM-DDTHH:mm". Planned dates are wall-clock-as-
// UTC, so the input carries the UTC fields — the same day and time the board
// and the source file show, in every timezone (PT SCH-10).
function toScheduleInput(iso?: string | null): string {
  const w = toWallClock(iso);
  return w ? `${w.date}T${w.time}` : "";
}
function fromScheduleInput(v: string): string | null {
  const [date, time] = v.split("T");
  return fromWallClock(date ?? "", time ?? null);
}

// ─── Dependency editor (finish-to-start links) ─────────────────
function DependencyEditor({
  milestone, allTasks, hiddenIds, canEdit, userId, onChanged, onSelectMilestone,
}: {
  milestone: Milestone;
  allTasks: Milestone[];
  hiddenIds?: ReadonlySet<string>;
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

  // The cycle check runs over EVERY task the project has (the caller hands
  // the full list, never the filtered board — PT SCH-9), in one O(n + e)
  // walk: the tasks that already (transitively) depend on this one can never
  // be its predecessors (PT PERF-5: it was a DFS per candidate). The save is
  // checked again below the UI against the database (updateMilestone).
  const blocked = useMemo(
    () => (milestone.id ? dependentsClosure(reflowNodesFromMilestones(allTasks), milestone.id) : new Set<string>()),
    [allTasks, milestone.id],
  );

  // Candidates: any other task that wouldn't create a cycle and isn't already a dep.
  const candidates = useMemo(() => allTasks
    .filter((t) => t.id && t.id !== milestone.id && !deps.includes(t.id) && !blocked.has(t.id))
    .sort((a, b) => (Date.parse(a.plannedAt as string) - Date.parse(b.plannedAt as string)) || (a.name || "").localeCompare(b.name || "")),
    [allTasks, deps, blocked, milestone.id]);

  const save = async (next: string[]) => {
    if (!milestone.id) return;
    setSaving(true); setError(null);
    try {
      await updateMilestone({ id: milestone.id, patch: { dependsOn: next }, updatedBy: userId });
      onChanged();
    } catch (e) { setError(userFacingCaughtError(e, { context: "TaskDetailPanel" })); }
    finally { setSaving(false); }
  };

  if (allTasks.length === 0) return null;

  return (
    <div className="px-4 py-3 border-b border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Link2 className="w-3.5 h-3.5 text-indigo-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">Depends on</span>
        <span className="text-[10px] text-[var(--color-text-faint)]">— must finish before this starts</span>
      </div>
      {deps.length === 0 ? (
        <div className="text-[11px] text-[var(--color-text-faint)] italic mb-1.5">No dependencies.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {deps.map((id) => {
            const t = byId.get(id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/[0.08] border border-indigo-500/40 text-indigo-800 dark:text-indigo-300 text-[11px] font-semibold pl-2 pr-1 py-0.5">
                <button type="button" className="truncate max-w-[160px] hover:underline" onClick={() => t && onSelectMilestone?.(t)} title={t ? (hiddenIds?.has(id) ? `${t.name} — hidden by the imported-rows filter` : t.name) : "This task was deleted; the link points at nothing"}>
                  {t ? (hiddenIds?.has(id) ? `${t.name} (hidden by filter)` : t.name) : "(deleted task)"}
                </button>
                {canEdit && (
                  <button type="button" disabled={saving} onClick={() => void save(deps.filter((dd) => dd !== id))} className="p-0.5 rounded-full hover:bg-indigo-500/20 text-indigo-500 hover:text-indigo-800 dark:hover:text-indigo-300" title="Remove dependency">
                    <XIcon className="w-3 h-3" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {canEdit && (
        <PredecessorPicker
          candidates={candidates}
          hiddenIds={hiddenIds}
          disabled={saving}
          onPick={(id) => void save([...deps, id])}
        />
      )}
      {error && <div role="alert" className="text-[11px] text-rose-700 dark:text-rose-300 mt-1">{error}</div>}
    </div>
  );
}

/** PERF-5 remediation 4 (projects Round G J14): the most matches the
 *  predecessor picker draws at once — the picker never renders every task
 *  (a 5,000-task schedule was a 5,000-option <select>). */
export const PREDECESSOR_PICKER_LIMIT = 20;

/** The tasks a typed query matches, in the candidates' own order (planned
 *  date, then name): every word of the query appears in the name, case
 *  aside. An empty query matches every candidate. */
export function matchPredecessors(candidates: readonly Milestone[], query: string): Milestone[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...candidates];
  return candidates.filter((t) => { const n = (t.name ?? "").toLowerCase(); return words.every((w) => n.includes(w)); });
}

/** PERF-5 remediation 4 (projects Round G J14): a searchable predecessor
 *  picker in place of a <select> of every task. Type to narrow; at most
 *  PREDECESSOR_PICKER_LIMIT matches are drawn, and the rest are counted.
 *  The candidates are DependencyEditor's own (no cycle, not already a
 *  dependency, never this task), so what may be picked is unchanged.
 *
 *  (J14 fix pass, A11Y) The ARIA 1.2 combobox pattern, so a keyboard and a
 *  screen reader keep what the native <select> gave them: the input is a
 *  `combobox` (aria-expanded, aria-controls, aria-autocomplete="list",
 *  aria-activedescendant); the matches are a `listbox` of `option`s, the
 *  active one aria-selected; ArrowDown / ArrowUp (Home / End) move the
 *  active option, Enter picks it (the first match when none is active),
 *  Escape closes. Focus stays in the input throughout; the count is said in
 *  the status line. */
function PredecessorPicker({ candidates, hiddenIds, disabled, onPick }: {
  candidates: Milestone[];
  hiddenIds?: ReadonlySet<string>;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const baseId = React.useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;
  const matches = useMemo(() => matchPredecessors(candidates, query), [candidates, query]);
  const shown = matches.slice(0, PREDECESSOR_PICKER_LIMIT);
  const expanded = open && !disabled;
  const activeIndex = expanded && active >= 0 && active < shown.length ? active : -1;
  useEffect(() => {
    if (activeIndex < 0 || typeof document === "undefined") return;
    const el = document.getElementById(`${baseId}-option-${activeIndex}`) as (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }) | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, baseId]);
  const pick = (id: string) => { setQuery(""); setOpen(false); setActive(-1); onPick(id); };
  if (candidates.length === 0) {
    return <div className="text-[11px] text-[var(--color-text-faint)] italic">No other tasks available</div>;
  }
  const move = (to: number) => { setOpen(true); setActive(shown.length ? Math.max(0, Math.min(shown.length - 1, to)) : -1); };
  return (
    <div
      className="relative"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setActive(-1); } }}
    >
      <input
        type="search"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setActive(-1); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); move(expanded ? activeIndex + 1 : 0); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); move(expanded ? (activeIndex < 0 ? shown.length - 1 : activeIndex - 1) : shown.length - 1); return; }
          if (expanded && e.key === "Home" && activeIndex >= 0) { e.preventDefault(); move(0); return; }
          if (expanded && e.key === "End" && activeIndex >= 0) { e.preventDefault(); move(shown.length - 1); return; }
          if (e.key === "Enter") {
            const t = activeIndex >= 0 ? shown[activeIndex] : shown[0];
            if (t?.id) { e.preventDefault(); pick(t.id); }
          }
        }}
        placeholder="+ Add a predecessor — type to search…"
        aria-label="Add a predecessor — type to search the project's tasks"
        className="w-full text-[12px] border border-[var(--color-border-strong)] rounded-md px-2 py-1.5 bg-[var(--color-surface)] text-[var(--color-text)] disabled:opacity-50"
      />
      {expanded && (
        <div className="mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
          <ul id={listId} role="listbox" data-testid="dep-candidates" aria-label="Matching tasks" className="max-h-56 overflow-y-auto py-1">
            {shown.map((t, i) => (
              <li
                key={t.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                // the input keeps focus: a press on an option never blurs it (which would close the list first)
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => t.id && pick(t.id)}
                className={`w-full cursor-pointer text-left px-2 py-1.5 text-[12px] text-[var(--color-text)] truncate ${i === activeIndex ? "bg-[var(--color-surface-2)] outline outline-1 outline-[var(--color-accent)]" : "hover:bg-[var(--color-surface-2)]"}`}
              >
                {t.name}{t.id && hiddenIds?.has(t.id) ? " (hidden by filter)" : ""}
              </li>
            ))}
          </ul>
          <div role="status" className="px-2 py-1 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-faint)]">
            {matches.length === 0
              ? "No task matches — try another word."
              : matches.length > shown.length
                ? `Showing ${shown.length} of ${matches.length} — type to narrow.`
                : `${matches.length} task${matches.length === 1 ? "" : "s"}.`}
          </div>
        </div>
      )}
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
    } catch (e) { await appAlert({ message: userFacingCaughtError(e, { context: "TaskDetailPanel" }), tone: "danger" }); }
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
