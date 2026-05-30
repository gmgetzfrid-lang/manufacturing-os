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
  User, HardHat,
  CalendarDays, Layers, MessageSquarePlus, History, ChevronRight, ChevronLeft,
} from "lucide-react";
import type { Milestone, MilestoneStatus, MilestoneNote } from "@/types/schema";
import {
  updateMilestone, setMilestoneStatus, deleteMilestone,
  listMilestoneNotes, addMilestoneNote, type MilestonePatch,
} from "@/lib/milestones";
import StatusControl from "@/components/projects/StatusControl";

interface Props {
  milestone: Milestone;
  subtasks: Milestone[];                 // direct children
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
  milestone, subtasks, childCount, ancestors, canEdit, userId, userName, userEmail, userRole,
  onClose, onChanged, onSelectSubtask, onSelectMilestone, onMoveDays,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyStatus, setBusyStatus] = useState(false);
  const [notes, setNotes] = useState<MilestoneNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");

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

              {/* Subtasks */}
              {subtasks.length > 0 && (
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Layers className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Subtasks</span>
                    {leafProgress && <span className="text-[11px] font-mono text-indigo-600 font-bold ml-auto">{leafProgress.done}/{leafProgress.total} · {leafProgress.pct}%</span>}
                  </div>
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
                          {n.statusAt && <StatusPill status={n.statusAt} dotOnly />}
                          <span className="font-semibold text-slate-700">{n.createdByName ?? "Someone"}</span>
                          <span className="text-slate-400">{n.kind === "status" ? "set status" : n.kind === "reschedule" ? "rescheduled" : "noted"}{n.statusAt ? ` · ${labelOf(n.statusAt)}` : ""}</span>
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
  const [description, setDescription] = useState(m.description ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!m.id) return;
    setSaving(true); setError(null);
    try {
      const patch: MilestonePatch = {
        name: name.trim(),
        plannedStartAt: start ? new Date(start).toISOString() : null,
        plannedAt: finish ? new Date(finish).toISOString() : m.plannedAt,
        durationHours: durationHours ? Number(durationHours) : null,
        workOrderRef, responsibleParty, responsibleOrg, responsibleKind,
        actualParty, actualOrg, actualKind, location, description,
      };
      await updateMilestone({
        id: m.id, patch,
        updatedBy: userId, updatedByName: userName, updatedByEmail: userEmail, updatedByRole: userRole,
      });
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 space-y-3">
      <L label="Task name"><input value={name} onChange={(e) => setName(e.target.value)} className={inp} /></L>
      <div className="grid grid-cols-2 gap-2">
        <L label="Start"><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={inp} /></L>
        <L label="Finish"><input type="datetime-local" value={finish} onChange={(e) => setFinish(e.target.value)} className={inp} /></L>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <L label="Work hours"><input type="number" min={0} value={durationHours} onChange={(e) => setDurationHours(e.target.value)} className={inp} /></L>
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
      <L label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} className={inp} /></L>
      <L label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inp} resize-y`} /></L>
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</div>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
        <button onClick={() => void save()} disabled={saving || !canSave || !name.trim()} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-md disabled:opacity-40">
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

function fmtRange(m: Milestone): string {
  const s = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const f = new Date(m.plannedAt as string);
  const opt: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (s && s.getTime() !== f.getTime()) return `${s.toLocaleString(undefined, opt)}  →  ${f.toLocaleString(undefined, opt)}`;
  return f.toLocaleString(undefined, opt);
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
