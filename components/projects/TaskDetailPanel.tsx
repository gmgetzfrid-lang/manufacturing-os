"use client";

// TaskDetailPanel — the "click a task to see everything" slide-over,
// shared by the Execution timeline and the calendar tile view. Models
// the Outlook "click a meeting → detail popover" pattern but for
// execution work: full metadata, inline edit, status changes with a
// captured note, the subtask checklist, and the task's breadcrumb
// activity trail.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  X as XIcon, Pencil, Trash2, Loader2, Save, Clock, MapPin, Hash,
  User, HardHat, AlertTriangle, Sun, Moon, Sunset,
  CalendarDays, Layers, MessageSquarePlus, History, ChevronRight, ChevronLeft,
  Link2, Target, Plus, Zap,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneNote, ProjectMember } from "@/types/schema";
import { wouldCreateCycle, cascadeDependents, type ReflowNode, type DateChange } from "@/lib/scheduleReflow";
import {
  normalizeLinks, linkCode, LINK_TYPES, LINK_TYPE_HINT, LINK_TYPE_LABEL,
  type DependencyLink, type LinkType,
} from "@/lib/scheduleLinks";
import { listMembers } from "@/lib/projects";
import {
  updateMilestone, setMilestoneStatus, deleteMilestone, createMilestone,
  listMilestoneNotes, addMilestoneNote, type MilestonePatch,
} from "@/lib/milestones";
import StatusControl from "@/components/projects/StatusControl";

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
  /** Persist a batch of reflowed dates — used to cascade dependents the
   *  moment a dependency link is created, so links drive the schedule. */
  onMoveMany?: (changes: DateChange[]) => Promise<boolean>;
  /** CPM result for this task, when the schedule carries dependency links. */
  cpmInfo?: { critical: boolean; totalFloatDays: number } | null;
}

export default function TaskDetailPanel({
  milestone, subtasks, allTasks, childCount, ancestors, canEdit, userId, userName, userEmail, userRole,
  onClose, onChanged, onSelectSubtask, onSelectMilestone, onMoveDays, onMoveMany, cpmInfo,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [addingSub, setAddingSub] = useState(false);
  const [subName, setSubName] = useState("");
  const [subBusy, setSubBusy] = useState(false);

  const m = milestone;
  const leafProgress = useMemo(() => {
    if (subtasks.length === 0) return null;
    const done = subtasks.filter((s) => s.status === "completed").length;
    return { done, total: subtasks.length, pct: Math.round((done / subtasks.length) * 100) };
  }, [subtasks]);

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

  const addNote = useCallback(async () => {
    if (!m.id || !noteDraft.trim()) return;
    await addMilestoneNote({
      orgId: m.orgId, milestoneId: m.id, kind: "note", statusAt: m.status,
      body: noteDraft.trim(), createdBy: userId, createdByName: userName,
    });
    setNoteDraft("");
    loadNotes();
  }, [m.id, m.orgId, m.status, noteDraft, userId, userName, loadNotes]);

  const onDelete = useCallback(async () => {
    if (!m.id) return;
    if (!confirm(`Delete "${m.name}"? This is audited and cannot be undone.`)) return;
    await deleteMilestone(m.id, userId);
    onChanged();
    onClose();
  }, [m.id, m.name, userId, onChanged, onClose]);

  const addSubtask = useCallback(async () => {
    if (!m.id || !subName.trim()) return;
    setSubBusy(true);
    try {
      await createMilestone({
        orgId: m.orgId,
        projectId: m.projectId ?? undefined,
        parentId: m.id,
        name: subName.trim(),
        // Land inside the parent's span so it renders under the phase.
        plannedStartAt: (m.plannedStartAt as string | undefined) ?? (m.plannedAt as string),
        plannedAt: m.plannedAt as string,
        createdBy: userId, createdByName: userName, createdByEmail: userEmail, createdByRole: userRole,
      });
      setSubName(""); setAddingSub(false);
      onChanged();
    } catch (e) { alert((e as Error).message); }
    finally { setSubBusy(false); }
  }, [m.id, m.orgId, m.projectId, m.plannedStartAt, m.plannedAt, subName, userId, userName, userEmail, userRole, onChanged]);

  return (
    <div className="fixed inset-0 z-[150] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full max-w-[440px] bg-white shadow-2xl ring-1 ring-slate-900/10 flex flex-col animate-[slidein_.15s_ease-out]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-2 bg-gradient-to-b from-white to-slate-50/50">
          <div className="flex-1 min-w-0">
            {/* Breadcrumb: DEC OUTAGE › Transmix 1 › Shut Down … so the
                task is always shown in the context of its unit. Each
                crumb is clickable to jump up the tree. */}
            {ancestors && ancestors.length > 0 && (
              <nav className="flex items-center gap-0.5 flex-wrap mb-1 text-[10px] text-slate-500">
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
              <StatusPill status={m.status} />
              {m.wbs && <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{m.wbs}</span>}
              {m.isSummary && <span className="text-[9px] font-black uppercase tracking-wider bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">Summary</span>}
              {cpmInfo && (cpmInfo.critical
                ? <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded" title="On the critical path — slipping this slips the project finish"><Zap className="w-2.5 h-2.5" />Critical</span>
                : cpmInfo.totalFloatDays > 0
                  ? <span className="text-[9px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded" title="Slack before this affects the project finish">{cpmInfo.totalFloatDays}d float</span>
                  : null)}
            </div>
            <h2 className="mt-1.5 text-base font-bold text-slate-900 leading-snug break-words">{m.name}</h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canEdit && !editing && (
              <button onClick={() => setEditing(true)} title="Edit" className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"><Pencil className="w-4 h-4" /></button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
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
              {/* Status — the same picker used on chips & sub-tasks,
                  so the interaction is identical everywhere. */}
              {canEdit && (
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Status</span>
                    <StatusControl
                      status={m.status}
                      busy={busyStatus}
                      variant="pill"
                      onPick={(s, reason) => void applyStatus(s, reason)}
                    />
                    <span className="text-[10px] text-slate-400">click to change · all states incl. on-hold / blocked</span>
                  </div>
                  {m.isSummary && (
                    <div className="mt-2 text-[10px] text-slate-400 flex items-start gap-1">
                      <Layers className="w-3 h-3 mt-0.5 shrink-0" />
                      This is a parent/phase — its progress also rolls up automatically as you complete the sub-tasks below.
                    </div>
                  )}
                </div>
              )}

              {/* Move — reschedule the whole task without dragging. */}
              {canEdit && onMoveDays && m.id && (
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Move</span>
                  <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
                    <button onClick={() => onMoveDays(m.id!, -7)} title="1 week earlier" className="px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-100">−1w</button>
                    <button onClick={() => onMoveDays(m.id!, -1)} title="1 day earlier" className="px-2 py-1 text-slate-600 hover:bg-slate-100 border-l border-slate-200"><ChevronLeft className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 1)} title="1 day later" className="px-2 py-1 text-slate-600 hover:bg-slate-100 border-l border-slate-200"><ChevronRight className="w-3.5 h-3.5" /></button>
                    <button onClick={() => onMoveDays(m.id!, 7)} title="1 week later" className="px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-100 border-l border-slate-200">+1w</button>
                  </div>
                  <span className="text-[10px] text-slate-400">{m.isSummary ? "moves the whole phase together" : "shifts this task (its sub-steps come along)"}</span>
                </div>
              )}

              {/* Metadata */}
              <div className="px-4 py-3 border-b border-slate-100 space-y-2.5">
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
                    {m.responsibleKind && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">{m.responsibleKind}</span>}
                  </Field>
                )}
                {(m.actualParty || m.actualOrg) && (
                  <Field icon={<HardHat className="w-3.5 h-3.5" />} label="Actually performed by">
                    {[m.actualParty, m.actualOrg].filter(Boolean).join(" · ")}
                    {m.actualKind && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">{m.actualKind}</span>}
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
                  <div className="text-xs text-slate-600 whitespace-pre-wrap pt-1">{m.description}</div>
                )}
              </div>

              {/* Source attributes (the labeled columns from the schedule) */}
              {m.attributes && Object.keys(m.attributes).length > 0 && (
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">From the schedule</div>
                  <div className="grid grid-cols-1 gap-1">
                    {Object.entries(m.attributes).map(([k, v]) => (
                      <div key={k} className="flex items-baseline gap-2 text-xs">
                        <span className="text-slate-500 shrink-0 capitalize">{k}</span>
                        <span className="flex-1 text-slate-800 break-words text-right font-medium">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Responsible member (deliverable owner) */}
              <AssigneeEditor milestone={m} canEdit={canEdit} userId={userId} onChanged={onChanged} />

              {/* Dependencies — predecessors + successors, typed (FS/SS/FF/SF + lag) */}
              <LinkEditor
                milestone={m}
                allTasks={allTasks ?? []}
                canEdit={canEdit}
                userId={userId}
                onChanged={onChanged}
                onSelectMilestone={onSelectMilestone}
                onMoveMany={onMoveMany}
              />

              {/* Subtasks */}
              {(subtasks.length > 0 || canEdit) && (
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Subtasks</span>
                    {leafProgress && <span className="text-[11px] font-mono text-indigo-600 font-bold">{leafProgress.done}/{leafProgress.total} · {leafProgress.pct}%</span>}
                    {canEdit && (
                      <button onClick={() => setAddingSub((v) => !v)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-indigo-700 hover:text-indigo-900">
                        <Plus className="w-3 h-3" /> Add sub-task
                      </button>
                    )}
                  </div>
                  {addingSub && canEdit && (
                    <div className="flex items-center gap-1.5 mb-2">
                      <input
                        autoFocus value={subName} onChange={(e) => setSubName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void addSubtask(); if (e.key === "Escape") { setAddingSub(false); setSubName(""); } }}
                        placeholder="New sub-task name…"
                        className="flex-1 text-xs px-2 py-1.5 border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30"
                      />
                      <button onClick={() => void addSubtask()} disabled={subBusy || !subName.trim()} className="inline-flex items-center gap-1 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1.5 rounded-md disabled:opacity-40">
                        {subBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Add"}
                      </button>
                    </div>
                  )}
                  {subtasks.length === 0 ? (
                    <div className="text-[11px] text-slate-400 italic">No sub-tasks yet.{canEdit && " Break this task into steps with Add sub-task."}</div>
                  ) : (
                  <>
                  <div className="text-[10px] text-slate-400 mb-2">
                    Dot = set status · ◀ ▶ = move this step a day earlier/later (the rest stay put) · name = open it
                  </div>
                  <ul className="space-y-1">
                    {subtasks.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 py-1 px-1.5 rounded-md hover:bg-slate-50 group">
                        <span className="shrink-0">
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
                        </span>
                        <button onClick={() => onSelectSubtask?.(s)} className="flex-1 min-w-0 text-left" title="Open subtask">
                          <span className={`block text-[12px] truncate ${s.status === "completed" ? "line-through text-slate-400" : "text-slate-700"}`}>{s.name}</span>
                          <span className="block text-[9px] text-slate-400 font-mono">{shortDate(s.plannedAt as string)}</span>
                        </button>
                        {canEdit && onMoveDays && s.id && (
                          <span className="shrink-0 flex items-center gap-0.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, -1); }}
                              title="Move this step 1 day earlier"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-indigo-700 hover:bg-indigo-50"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onMoveDays(s.id!, 1); }}
                              title="Move this step 1 day later"
                              className="w-5 h-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-indigo-700 hover:bg-indigo-50"
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </span>
                        )}
                        {s.id && childCount(s.id) > 0 && <span className="text-[10px] text-slate-400 font-mono shrink-0">{childCount(s.id)}</span>}
                      </li>
                    ))}
                  </ul>
                  </>
                  )}
                </div>
              )}

              {/* Activity / breadcrumb trail */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <History className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Activity</span>
                </div>
                {canEdit && (
                  <div className="flex items-start gap-2 mb-3">
                    <input
                      value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Add a note…"
                      className="flex-1 text-xs px-2 py-1.5 border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30"
                      onKeyDown={(e) => { if (e.key === "Enter") void addNote(); }}
                    />
                    <button onClick={() => void addNote()} disabled={!noteDraft.trim()} className="p-1.5 rounded-md text-indigo-600 hover:bg-indigo-50 disabled:opacity-40" title="Add note">
                      <MessageSquarePlus className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {notes.length === 0 ? (
                  <div className="text-[11px] text-slate-400 italic">No activity yet.</div>
                ) : (
                  <ul className="space-y-2">
                    {notes.map((n) => (
                      <li key={n.id} className="text-xs">
                        <div className="flex items-center gap-1.5">
                          {n.kind === "reschedule"
                            ? <CalendarDays className="w-3 h-3 text-violet-500 shrink-0" />
                            : n.statusAt
                              ? <StatusPill status={n.statusAt} dotOnly />
                              : <MessageSquarePlus className="w-3 h-3 text-slate-400 shrink-0" />}
                          <span className="font-semibold text-slate-700">{n.createdByName ?? "Someone"}</span>
                          <span className="text-slate-400">{n.kind === "status" ? "set status" : n.kind === "reschedule" ? "rescheduled" : "noted"}{n.kind === "status" && n.statusAt ? ` · ${labelOf(n.statusAt)}` : ""}</span>
                          <span className="text-slate-300 ml-auto">{fmtWhen(n.createdAt)}</span>
                        </div>
                        {n.body && <div className="text-slate-600 mt-0.5 pl-1 border-l-2 border-slate-200 ml-1">{n.body}</div>}
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
          <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50/60 flex items-center">
            <button onClick={() => void onDelete()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-rose-600 hover:text-rose-800 hover:bg-rose-50 px-2 py-1 rounded-md">
              <Trash2 className="w-3.5 h-3.5" /> Delete task
            </button>
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
  const [name, setName] = useState(m.name);
  const [start, setStart] = useState(toLocalInput(m.plannedStartAt as string | null | undefined));
  const [finish, setFinish] = useState(toLocalInput(m.plannedAt as string));
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
      const patch: MilestonePatch = {
        name: name.trim(),
        plannedStartAt: start ? new Date(start).toISOString() : null,
        plannedAt: finish ? new Date(finish).toISOString() : m.plannedAt,
        durationHours: durationHours ? Number(durationHours) : null,
        workOrderRef, responsibleParty, responsibleOrg, responsibleKind,
        actualParty, actualOrg, actualKind, location, description,
        shift: (shift || null) as MilestonePatch["shift"],
      };
      await updateMilestone({
        id: m.id, patch,
        updatedBy: userId, updatedByName: userName, updatedByEmail: userEmail, updatedByRole: userRole,
      });
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const cls = (field: string) =>
    `${inp} ${v.errors[field] ? "border-rose-400 focus:ring-rose-400/30" : v.warnings[field] ? "border-amber-400 focus:ring-amber-400/30" : ""}`;

  return (
    <div className="p-4 space-y-3">
      <L label="Task name"><input value={name} onChange={(e) => setName(e.target.value)} className={cls("name")} /><Note err={v.errors.name} warn={v.warnings.name} /></L>
      <div className="grid grid-cols-2 gap-2">
        <L label="Start"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={cls("start")} /><Note err={v.errors.start} warn={v.warnings.start} /></L>
        <L label="Finish"><input type="datetime-local" value={finish} onChange={(e) => setFinish(e.target.value)} className={cls("finish")} /><Note err={v.errors.finish} warn={v.warnings.finish} /></L>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <L label="Work hours"><input type="number" min={0} value={durationHours} onChange={(e) => setDurationHours(e.target.value)} className={cls("durationHours")} /><Note err={v.errors.durationHours} warn={v.warnings.durationHours} /></L>
        <L label="Work order #"><input value={workOrderRef} onChange={(e) => setWorkOrderRef(e.target.value)} className={inp} /></L>
      </div>
      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 pt-1">Responsible (planned)</div>
      <div className="grid grid-cols-2 gap-2">
        <L label="Person / crew"><input value={responsibleParty} onChange={(e) => setResponsibleParty(e.target.value)} className={inp} /></L>
        <L label="Dept / company"><input value={responsibleOrg} onChange={(e) => setResponsibleOrg(e.target.value)} className={inp} /></L>
      </div>
      <L label="Type"><KindSelect value={responsibleKind} onChange={setResponsibleKind} /></L>
      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 pt-1">Actually performed by</div>
      <div className="grid grid-cols-2 gap-2">
        <L label="Person / crew"><input value={actualParty} onChange={(e) => setActualParty(e.target.value)} className={inp} /></L>
        <L label="Dept / company"><input value={actualOrg} onChange={(e) => setActualOrg(e.target.value)} className={inp} /></L>
      </div>
      <L label="Type"><KindSelect value={actualKind} onChange={setActualKind} /></L>
      <div className="grid grid-cols-2 gap-2">
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
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
        <button onClick={() => void save()} disabled={saving || !canSave || v.hasErrors} title={v.hasErrors ? "Fix the highlighted fields first" : undefined} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md disabled:opacity-40">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
        </button>
      </div>
    </div>
  );
}

const inp = "w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Inline field message — red for a blocking error, amber for advice.
function Note({ err, warn }: { err?: string; warn?: string }) {
  if (!err && !warn) return null;
  return (
    <div className={`mt-0.5 flex items-start gap-1 text-[10.5px] ${err ? "text-rose-600" : "text-amber-600"}`}>
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
      <span className="text-slate-400 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
        <div className="text-[13px] text-slate-800 break-words">{children}</div>
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
    status === "completed"   ? "text-emerald-800 bg-emerald-100 border-emerald-200" :
    status === "in_progress" ? "text-blue-800 bg-blue-100 border-blue-200" :
    status === "on_hold"     ? "text-amber-900 bg-amber-100 border-amber-200" :
    status === "blocked"     ? "text-rose-800 bg-rose-100 border-rose-200" :
    status === "missed"      ? "text-rose-900 bg-rose-100 border-rose-200" : "text-slate-700 bg-slate-100 border-slate-200";
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

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time.
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Link editor — typed predecessors + successors (FS/SS/FF/SF + lag) ──
function LinkEditor({
  milestone, allTasks, canEdit, userId, onChanged, onSelectMilestone, onMoveMany,
}: {
  milestone: Milestone;
  allTasks: Milestone[];
  canEdit: boolean;
  userId: string;
  onChanged: () => void;
  onSelectMilestone?: (m: Milestone) => void;
  onMoveMany?: (changes: DateChange[]) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addPred, setAddPred] = useState(false);
  const [addSucc, setAddSucc] = useState(false);

  const byId = useMemo(() => {
    const map = new Map<string, Milestone>();
    for (const t of allTasks) if (t.id) map.set(t.id, t);
    return map;
  }, [allTasks]);

  const reflowNodes = useMemo<ReflowNode[]>(() => allTasks.map((t) => ({
    id: t.id!, parentId: t.parentId ?? null,
    plannedStartAt: (t.plannedStartAt as string | undefined) ?? null,
    plannedAt: t.plannedAt as string,
    dependsOn: t.dependsOn ?? null,
    links: t.dependencyLinks ?? null,
  })), [allTasks]);

  const linksFor = useCallback((t: Milestone): DependencyLink[] =>
    normalizeLinks(t.dependsOn, t.dependencyLinks, t.id), []);

  // This task's predecessors (typed).
  const preds = useMemo(() => linksFor(milestone), [milestone, linksFor]);

  // Successors = other tasks that link back to this one.
  const succs = useMemo(() => {
    const out: Array<{ task: Milestone; link: DependencyLink }> = [];
    for (const t of allTasks) {
      if (!t.id || t.id === milestone.id) continue;
      const l = linksFor(t).find((x) => x.predId === milestone.id);
      if (l) out.push({ task: t, link: l });
    }
    return out.sort((a, b) => Date.parse(a.task.plannedAt as string) - Date.parse(b.task.plannedAt as string));
  }, [allTasks, milestone.id, linksFor]);

  const predCandidates = useMemo(() => allTasks
    .filter((t) => t.id && t.id !== milestone.id && !preds.some((l) => l.predId === t.id) && !wouldCreateCycle(reflowNodes, milestone.id!, t.id))
    .sort((a, b) => (Date.parse(a.plannedAt as string) - Date.parse(b.plannedAt as string)) || (a.name || "").localeCompare(b.name || "")),
    [allTasks, preds, reflowNodes, milestone.id]);

  const succCandidates = useMemo(() => allTasks
    .filter((t) => t.id && t.id !== milestone.id && !succs.some((s) => s.task.id === t.id) && !wouldCreateCycle(reflowNodes, t.id, milestone.id!))
    .sort((a, b) => (Date.parse(a.plannedAt as string) - Date.parse(b.plannedAt as string)) || (a.name || "").localeCompare(b.name || "")),
    [allTasks, succs, reflowNodes, milestone.id]);

  const saveLinksOn = useCallback(async (taskId: string, next: DependencyLink[], seedIds?: string[]) => {
    setSaving(true); setError(null);
    try {
      await updateMilestone({ id: taskId, patch: { dependencyLinks: next }, updatedBy: userId });
      // Reschedule dependents so a newly-created link actually drives the
      // schedule (a successor that violates it gets pushed forward). Removing a
      // link passes no seed — relaxing a constraint never needs a push.
      if (onMoveMany && seedIds?.length) {
        const updated = reflowNodes.map((n) => (n.id === taskId ? { ...n, links: next } : n));
        const changes = cascadeDependents(updated, seedIds);
        if (changes.length > 0) await onMoveMany(changes);
      }
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }, [userId, onChanged, onMoveMany, reflowNodes]);

  if (allTasks.length === 0) return null;

  return (
    <div className="px-4 py-3 border-b border-slate-100 space-y-3">
      {/* Predecessors */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Link2 className="w-3.5 h-3.5 text-indigo-500" />
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Predecessors</span>
          <span className="text-[10px] text-slate-400">— must come before this</span>
        </div>
        {preds.length === 0 ? (
          <div className="text-[11px] text-slate-400 italic mb-1">No predecessors.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {preds.map((l) => (
              <LinkChip
                key={l.predId}
                name={byId.get(l.predId)?.name ?? "(removed task)"}
                code={linkCode(l)}
                title={`${LINK_TYPE_LABEL[l.type]}${l.lagDays ? `, ${l.lagDays > 0 ? "+" : ""}${l.lagDays}d lag` : ""}`}
                canEdit={canEdit} saving={saving}
                onOpen={() => { const t = byId.get(l.predId); if (t) onSelectMilestone?.(t); }}
                onRemove={() => void saveLinksOn(milestone.id!, preds.filter((p) => p.predId !== l.predId))}
              />
            ))}
          </div>
        )}
        {canEdit && (addPred ? (
          <AddLinkRow
            candidates={predCandidates}
            onAdd={(predId, type, lagDays) => { setAddPred(false); void saveLinksOn(milestone.id!, [...preds, { predId, type, lagDays }], [predId]); }}
            onCancel={() => setAddPred(false)}
          />
        ) : (
          <button onClick={() => setAddPred(true)} disabled={predCandidates.length === 0} className="text-[11px] font-bold text-indigo-700 hover:text-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed">
            + Add predecessor
          </button>
        ))}
      </div>

      {/* Successors */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Link2 className="w-3.5 h-3.5 text-violet-500 rotate-180" />
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Successors</span>
          <span className="text-[10px] text-slate-400">— depend on this</span>
        </div>
        {succs.length === 0 ? (
          <div className="text-[11px] text-slate-400 italic mb-1">No successors.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {succs.map(({ task, link }) => (
              <LinkChip
                key={task.id}
                name={task.name}
                code={linkCode(link)}
                title={`${LINK_TYPE_LABEL[link.type]}${link.lagDays ? `, ${link.lagDays > 0 ? "+" : ""}${link.lagDays}d lag` : ""}`}
                canEdit={canEdit} saving={saving} tone="violet"
                onOpen={() => onSelectMilestone?.(task)}
                onRemove={() => void saveLinksOn(task.id!, linksFor(task).filter((l) => l.predId !== milestone.id))}
              />
            ))}
          </div>
        )}
        {canEdit && (addSucc ? (
          <AddLinkRow
            candidates={succCandidates}
            onAdd={(succId, type, lagDays) => {
              setAddSucc(false);
              const t = byId.get(succId);
              if (t) void saveLinksOn(succId, [...linksFor(t), { predId: milestone.id!, type, lagDays }], [milestone.id!]);
            }}
            onCancel={() => setAddSucc(false)}
          />
        ) : (
          <button onClick={() => setAddSucc(true)} disabled={succCandidates.length === 0} className="text-[11px] font-bold text-violet-700 hover:text-violet-900 disabled:opacity-40 disabled:cursor-not-allowed">
            + Add successor
          </button>
        ))}
      </div>

      {error && <div className="text-[11px] text-rose-600">{error}</div>}
    </div>
  );
}

function LinkChip({ name, code, title, canEdit, saving, tone = "indigo", onOpen, onRemove }: {
  name: string; code: string; title: string; canEdit: boolean; saving: boolean;
  tone?: "indigo" | "violet"; onOpen: () => void; onRemove: () => void;
}) {
  const cls = tone === "violet"
    ? "bg-violet-50 border-violet-200 text-violet-800"
    : "bg-indigo-50 border-indigo-200 text-indigo-800";
  const hover = tone === "violet" ? "hover:bg-violet-200/60 text-violet-500 hover:text-violet-800" : "hover:bg-indigo-200/60 text-indigo-500 hover:text-indigo-800";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border text-[11px] font-semibold pl-1.5 pr-1 py-0.5 ${cls}`} title={title}>
      <span className="font-mono text-[9px] bg-white/70 rounded px-1 py-px">{code}</span>
      <button type="button" className="truncate max-w-[150px] hover:underline" onClick={onOpen} title={name}>{name}</button>
      {canEdit && (
        <button type="button" disabled={saving} onClick={onRemove} className={`p-0.5 rounded-full ${hover}`} title="Remove link">
          <XIcon className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function AddLinkRow({ candidates, onAdd, onCancel }: {
  candidates: Milestone[];
  onAdd: (id: string, type: LinkType, lagDays: number) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [type, setType] = useState<LinkType>("FS");
  const [lag, setLag] = useState("0");
  return (
    <div className="flex items-center gap-1.5 flex-wrap bg-slate-50 border border-slate-200 rounded-md p-1.5">
      <select value={id} onChange={(e) => setId(e.target.value)} className="text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white max-w-[160px]">
        <option value="">Task…</option>
        {candidates.map((t) => <option key={t.id} value={t.id!}>{t.name}</option>)}
      </select>
      <select value={type} onChange={(e) => setType(e.target.value as LinkType)} title={LINK_TYPE_HINT[type]} className="text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white">
        {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input type="number" value={lag} onChange={(e) => setLag(e.target.value)} title="Lead/lag in days" className="w-12 text-[11px] border border-slate-300 rounded px-1 py-1" />
      <button disabled={!id} onClick={() => id && onAdd(id, type, Math.trunc(Number(lag) || 0))} className="text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1 rounded disabled:opacity-40">Add</button>
      <button onClick={onCancel} className="text-[11px] text-slate-500 hover:text-slate-800 px-1.5 py-1">Cancel</button>
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
    } catch (e) { alert((e as Error).message); }
    finally { setSaving(false); }
  };

  if (!milestone.projectId) return null;

  return (
    <div className="px-4 py-3 border-b border-slate-100">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Target className="w-3.5 h-3.5 text-indigo-500" />
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Responsible</span>
        <span className="text-[10px] text-slate-400">— the member who owns this deliverable</span>
      </div>
      {canEdit ? (
        <select
          value={assignedId}
          disabled={saving}
          onChange={(e) => void assign(e.target.value)}
          className="w-full text-[12px] border border-slate-300 rounded-md px-2 py-1.5 bg-white text-slate-700 disabled:opacity-50"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {(m.userName || m.userEmail || m.userId.slice(0, 8))}{m.responsibility ? ` — ${m.responsibility}` : ""}
            </option>
          ))}
        </select>
      ) : (
        <div className="text-xs text-slate-600">{assignedName || <span className="text-slate-400 italic">Unassigned</span>}</div>
      )}
    </div>
  );
}
