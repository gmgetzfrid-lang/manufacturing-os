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

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Flag, Plus, Loader2, AlertTriangle, Check, X, Calendar, ChevronDown,
  Upload, FileText, ArrowRight, TrendingUp, Eye, EyeOff,
} from "lucide-react";
import { supabase as supabaseClient } from "@/lib/supabase";
import {
  listMilestones, createMilestone, setMilestoneStatus, deleteMilestone,
  updateMilestone, computeScheduleMetrics,
} from "@/lib/milestones";
import type { Milestone, MilestoneStatus, MilestoneSource } from "@/types/schema";
import HelpTooltip from "@/components/ui/HelpTooltip";
import FirstRunHint from "@/components/ui/FirstRunHint";
import GanttView from "@/components/projects/GanttView";
import ScheduleCalendarView from "@/components/projects/ScheduleCalendarView";
import ScheduleProgress from "@/components/projects/ScheduleProgress";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";
import RebaseScheduleModal from "@/components/projects/RebaseScheduleModal";
import { BarChart3, CalendarDays, GanttChartSquare, List as ListIcon, PlayCircle } from "lucide-react";
import ExecutionView from "@/components/projects/ExecutionView";

type ScheduleView = "execution" | "gantt" | "calendar" | "list";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);
const STATUS_OPTIONS: MilestoneStatus[] = ["planned", "in_progress", "completed", "missed", "blocked"];

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
}

export default function ScheduleTab({ orgId, projectId, projectName, projectStatus, userId, userName, userEmail, userRole }: ScheduleTabProps) {
  const canEdit = !!userRole && ADMIN_ROLES.has(userRole);

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ScheduleView>("execution");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listMilestones({ orgId, projectId, includeGhost: true });
      setMilestones(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [orgId, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Filtered view (toggle for ghost rows). Metrics still computed
  // over ALL milestones — ghost rows ARE commitments from the
  // imported schedule, so they count.
  const visible = useMemo(() => showGhost ? milestones : milestones.filter((m) => m.source === "manual"), [milestones, showGhost]);

  const metrics = useMemo(() => computeScheduleMetrics(milestones), [milestones]);

  const onSetStatus = async (id: string, status: MilestoneStatus) => {
    setBusy(true);
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
    if (!confirm("Delete this milestone? This action is audited.")) return;
    setBusy(true);
    try { await deleteMilestone(id, userId); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  // Calendar drag-drop callback.
  const onMoveMilestone = async (id: string, newPlannedAt: string): Promise<boolean> => {
    // Optimistic — update local state first so the drop feels instant.
    setMilestones((arr) => arr.map((m) => m.id === id ? { ...m, plannedAt: newPlannedAt } : m));
    try {
      await updateMilestone({
        id, patch: { plannedAt: newPlannedAt },
        updatedBy: userId, updatedByName: userName,
        updatedByEmail: userEmail, updatedByRole: userRole,
      });
      return true;
    } catch (e) {
      setError((e as Error).message);
      void refresh(); // resync from server on failure
      return false;
    }
  };

  // Calendar pill click — advance status one step.
  const onCycleStatus = (id: string, current: MilestoneStatus) => {
    const next: MilestoneStatus =
      current === "planned"     ? "in_progress" :
      current === "in_progress" ? "completed"   :
      current === "completed"   ? "planned"     :
      current === "missed"      ? "planned"     :
                                  "planned";
    void onSetStatus(id, next);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      <FirstRunHint storageKey="schedule.intro.v2" tone="info">
        Drop an exported schedule from MS Project (.xml / .csv) or Primavera P6 (.xml / .xer) and we&apos;ll parse it.
        Drag milestones in the calendar to reschedule; click a pill to advance its status. Metrics roll up live.
      </FirstRunHint>

      {/* Progress dashboard — always on top, summarizes everything */}
      <ScheduleProgress milestones={milestones} metrics={metrics} />

      {/* View tabs */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center bg-white border border-slate-200 rounded-xl shadow-sm p-1 gap-0.5">
          {([
            { id: "execution", label: "Execution", Icon: PlayCircle },
            { id: "gantt",     label: "Gantt",     Icon: GanttChartSquare },
            { id: "calendar",  label: "Calendar",  Icon: CalendarDays },
            { id: "list",      label: "List",      Icon: ListIcon },
          ] as Array<{ id: ScheduleView; label: string; Icon: typeof BarChart3 }>).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                view === id
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-2">
          <button
            onClick={() => setShowGhost((v) => !v)}
            title={showGhost ? "Hide imported (ghost) milestones" : "Show imported (ghost) milestones"}
            className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900 px-2 py-1.5 rounded hover:bg-slate-100"
          >
            {showGhost ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />} Ghost rows
          </button>
          {canEdit && (
            <>
              <button
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-50 border border-slate-200 px-2.5 py-1.5 rounded-lg shadow-sm"
              >
                <Upload className="w-3.5 h-3.5" /> Import schedule
              </button>
              {milestones.length > 0 && (
                <button
                  onClick={() => setRebaseOpen(true)}
                  title="Shift every task by a date delta — reuse an old schedule with a new start date"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-700 hover:text-violet-900 bg-violet-50 hover:bg-violet-100 border border-violet-200 px-2.5 py-1.5 rounded-lg shadow-sm"
                >
                  <Calendar className="w-3.5 h-3.5" /> Rebase
                </button>
              )}
              <button
                onClick={() => setAdding((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-500 px-2.5 py-1.5 rounded-lg shadow-sm shadow-indigo-900/20"
              >
                <Plus className="w-3.5 h-3.5" /> Add milestone
              </button>
            </>
          )}
        </div>
      </div>

      {/* Active view */}
      {view === "execution" && (
        <ExecutionView
          milestones={visible}
          canEdit={canEdit}
          onMove={async (id, newStart, newFinish) => {
            // optimistic
            setMilestones((arr) => arr.map((m) => m.id === id ? { ...m, plannedStartAt: newStart, plannedAt: newFinish } : m));
            try {
              await updateMilestone({
                id, patch: { plannedAt: newFinish },
                updatedBy: userId, updatedByName: userName,
                updatedByEmail: userEmail, updatedByRole: userRole,
              });
              // updateMilestone only writes planned_at; sneak planned_start_at in too.
              await supabaseClient.from("milestones").update({ planned_start_at: newStart }).eq("id", id);
              return true;
            } catch (e) {
              setError((e as Error).message);
              void refresh();
              return false;
            }
          }}
          onSetStatus={async (id, status) => {
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
        />
      )}
      {view === "gantt" && <GanttView milestones={visible} />}
      {view === "calendar" && (
        <ScheduleCalendarView
          milestones={visible}
          canEdit={canEdit}
          onMove={onMoveMilestone}
          onCycleStatus={onCycleStatus}
        />
      )}

      {/* List view */}
      {view === "list" && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50/60">
            <div className="flex items-center gap-2">
              <Flag className="w-4 h-4 text-indigo-600" />
              <div className="font-bold text-slate-900 text-sm">Milestones</div>
              <span className="text-[10px] text-slate-500 font-mono">{visible.length}</span>
            </div>
            <HelpTooltip>
              <b>Ghost milestones</b> are read-only rows imported from your scheduling tool. They still count toward the earned-value rollup. Toggle the Ghost button up top to hide them from this list while keeping them in metrics.
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
            <div className="px-4 py-8 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              No milestones yet.{canEdit && " Click Add milestone above to create the first one."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {visible.map((m) => (
                <MilestoneRow
                  key={m.id}
                  m={m}
                  canEdit={canEdit}
                  busy={busy}
                  onSetStatus={onSetStatus}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Inline add form shown on non-list views too when triggered */}
      {adding && view !== "list" && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
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


function MilestoneRow({ m, canEdit, busy, onSetStatus, onDelete }: {
  m: Milestone; canEdit: boolean; busy: boolean;
  onSetStatus: (id: string, s: MilestoneStatus) => void;
  onDelete: (id: string) => void;
}) {
  // Capture "now" once per mount — render stays pure (React 19 strict).
  const [nowMs] = useState<number>(() => Date.now());
  const planned = new Date(m.plannedAt as string);
  const actual = m.actualAt ? new Date(m.actualAt as string) : null;
  const overdue = !actual && planned.getTime() < nowMs && m.status !== "completed";
  const slipDays = actual ? Math.round((actual.getTime() - planned.getTime()) / 86400_000) : 0;

  const tone =
    m.status === "completed" ? "border-emerald-300 bg-emerald-50/50" :
    m.status === "missed"    ? "border-red-300 bg-red-50/50" :
    m.status === "blocked"   ? "border-amber-300 bg-amber-50/50" :
    overdue                  ? "border-red-300 bg-red-50/40" :
                               "border-slate-200 bg-white";

  const ghost = m.source !== "manual";

  return (
    <div className={`px-4 py-3 flex items-start gap-3 border-l-4 ${tone} ${ghost ? "opacity-80" : ""}`}>
      <Flag className="w-4 h-4 mt-0.5 text-slate-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-slate-900 truncate">{m.name}</span>
          <StatusChip status={m.status} />
          {ghost && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500 bg-slate-100 border border-slate-200 px-1 py-0.5 rounded" title={`Imported from ${m.source}`}>
              Ghost · {m.source}
            </span>
          )}
          {m.weight !== 1 && (
            <span className="text-[10px] font-mono text-slate-500" title="Weight (relative)">w={m.weight}</span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> planned {planned.toLocaleDateString()}
          </span>
          {actual && (
            <>
              <ArrowRight className="w-3 h-3 text-slate-300" />
              <span className={slipDays > 0 ? "text-red-700" : "text-emerald-700"}>
                actual {actual.toLocaleDateString()}{slipDays !== 0 && ` (${slipDays > 0 ? "+" : ""}${slipDays}d)`}
              </span>
            </>
          )}
          {overdue && !actual && <span className="text-red-700 font-bold">overdue</span>}
          {m.linkedRevisionLabel && (
            <span className="text-slate-500 font-mono">· {m.linkedRevisionLabel}</span>
          )}
        </div>
        {m.description && <div className="mt-1 text-[11px] text-slate-700 whitespace-pre-wrap">{m.description}</div>}
      </div>

      {canEdit && (
        <div className="shrink-0 flex items-center gap-1">
          {m.status !== "completed" && (
            <button
              onClick={() => onSetStatus(m.id!, "completed")}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-1.5 py-1 rounded disabled:opacity-40"
              title="Mark complete"
            >
              <Check className="w-3 h-3" /> Done
            </button>
          )}
          <StatusMenu current={m.status} onPick={(s) => onSetStatus(m.id!, s)} disabled={busy} />
          <button
            onClick={() => onDelete(m.id!)}
            disabled={busy}
            className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
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
    status === "completed"   ? "bg-emerald-100 text-emerald-800 border-emerald-200" :
    status === "in_progress" ? "bg-blue-100    text-blue-800    border-blue-200" :
    status === "missed"      ? "bg-red-100     text-red-800     border-red-200" :
    status === "blocked"     ? "bg-amber-100   text-amber-800   border-amber-200" :
                               "bg-slate-100   text-slate-700   border-slate-200";
  return (
    <span className={`text-[9px] font-bold uppercase tracking-widest border px-1.5 py-0.5 rounded ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function StatusMenu({ current, onPick, disabled }: { current: MilestoneStatus; onPick: (s: MilestoneStatus) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 px-1.5 py-1 rounded disabled:opacity-40"
        title="Change status"
      >
        Status <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-10 py-1 w-36">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { setOpen(false); onPick(s); }}
              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-slate-100 ${s === current ? "font-bold" : ""}`}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      )}
    </div>
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
    <form onSubmit={submit} className="px-4 py-3 bg-indigo-50/40 border-b border-indigo-100 space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (required)" className="text-xs border border-slate-300 rounded px-2 py-1.5" autoFocus />
        <input type="date" value={plannedAt} onChange={(e) => setPlannedAt(e.target.value)} className="text-xs border border-slate-300 rounded px-2 py-1.5" title="Planned date" />
        <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="Weight" className="text-xs border border-slate-300 rounded px-2 py-1.5 font-mono" />
        <input value={linkedRev} onChange={(e) => setLinkedRev(e.target.value)} placeholder='Linked ref (e.g. "Rev 3 release")' className="text-xs border border-slate-300 rounded px-2 py-1.5" />
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" rows={2} className="w-full text-xs border border-slate-300 rounded px-2 py-1.5 resize-y" />
      {error && (
        <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{error}</div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="text-xs text-slate-600 hover:text-slate-900 px-2 py-1">Cancel</button>
        <button type="submit" disabled={busy || !name.trim() || !plannedAt} className="inline-flex items-center gap-1 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1 rounded disabled:opacity-40">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
        </button>
      </div>
    </form>
  );
}

