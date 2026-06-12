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
import { Flag, Plus, Loader2, AlertTriangle, Check, X, Calendar, ChevronDown, Upload, ArrowRight, Eye, EyeOff, Zap, Layers } from "lucide-react";
import {
  listMilestones, createMilestone, setMilestoneStatus, deleteMilestone,
  updateMilestone, computeScheduleMetrics, setBaseline,
} from "@/lib/milestones";
import type { Milestone, MilestoneStatus } from "@/types/schema";
import HelpTooltip from "@/components/ui/HelpTooltip";
import FirstRunHint from "@/components/ui/FirstRunHint";
import ScheduleProgress from "@/components/projects/ScheduleProgress";
import ScheduleImportModal from "@/components/projects/ScheduleImportModal";
import ScheduleGeneratorModal from "@/components/projects/ScheduleGeneratorModal";
import ScheduleEmptyState from "@/components/projects/ScheduleEmptyState";
import ScheduleFilterBar from "@/components/projects/ScheduleFilterBar";
import { filterMilestones, isFilterActive, EMPTY_FILTER, type ScheduleFilter } from "@/lib/scheduleFilter";
import RebaseScheduleModal from "@/components/projects/RebaseScheduleModal";
import { ClipboardList, PlayCircle } from "lucide-react";
import ExecutionView from "@/components/projects/ExecutionView";

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
}

export default function ScheduleTab({ orgId, projectId, projectName, projectStatus, userId, userName, userEmail, userRole }: ScheduleTabProps) {
  const canEdit = !!userRole && ADMIN_ROLES.has(userRole);

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
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

  const hasBaseline = useMemo(() => milestones.some((m) => m.baselineFinishAt), [milestones]);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const onSetBaseline = async () => {
    const msg = hasBaseline
      ? "Re-capture the current plan as the new baseline? Drift will be measured from now on against this snapshot."
      : "Snapshot the current plan as the baseline? Every view will then show how far the schedule drifts from it.";
    if (!confirm(msg)) return;
    setBaselineBusy(true);
    try {
      const res = await setBaseline({ orgId, projectId, actorUserId: userId, actorUserEmail: userEmail, actorUserRole: userRole });
      if (!res.ok) setError(res.error ?? "Couldn't set baseline.");
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBaselineBusy(false); }
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
            { id: "planning",  label: "Planning",  Icon: ClipboardList },
            { id: "execution", label: "Execution", Icon: PlayCircle },
          ] as Array<{ id: ScheduleView; label: string; Icon: typeof PlayCircle }>).map(({ id, label, Icon }) => (
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
                onClick={() => setGenerateOpen(true)}
                title="Describe the work in plain English and we'll build the schedule"
                className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 px-2.5 py-1.5 rounded-lg shadow-sm"
              >
                <Zap className="w-3.5 h-3.5" /> Create with AI
              </button>
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
              {milestones.length > 0 && (
                <button
                  onClick={onSetBaseline}
                  disabled={baselineBusy}
                  title={hasBaseline
                    ? "Re-capture the approved plan as the new baseline to measure drift against"
                    : "Snapshot the current plan as the baseline — every view then shows how far you've drifted from it"}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-lg shadow-sm disabled:opacity-40"
                >
                  <Flag className="w-3.5 h-3.5" /> {hasBaseline ? "Re-baseline" : "Set baseline"}
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

      {/* Zero-state onboarding — the front door for a new user. */}
      {!loading && milestones.length === 0 && (
        <ScheduleEmptyState
          canEdit={canEdit}
          onGenerate={() => setGenerateOpen(true)}
          onImport={() => setImportOpen(true)}
          onAdd={() => setAdding(true)}
        />
      )}

      {/* Active view */}
      {!loading && milestones.length > 0 && view === "execution" && (
        <ExecutionView
          milestones={visible}
          canEdit={canEdit}
          orgId={orgId}
          projectId={projectId}
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
              await Promise.all(changes.map((c) =>
                updateMilestone({
                  id: c.id,
                  patch: { plannedStartAt: c.plannedStartAt, plannedAt: c.plannedAt },
                  updatedBy: userId, updatedByName: userName,
                  updatedByEmail: userEmail, updatedByRole: userRole,
                }),
              ));
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
              {planFilterOn ? "No tasks match the current search/filter." : <>No milestones yet.{canEdit && " Click Add milestone above to create the first one."}</>}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {planningRows.map(({ m, depth }) => (
                <MilestoneRow
                  key={m.id}
                  m={m}
                  depth={depth}
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

      {generateOpen && (
        <ScheduleGeneratorModal
          orgId={orgId}
          projectId={projectId}
          userId={userId}
          userName={userName}
          onClose={() => setGenerateOpen(false)}
          onDone={() => { setGenerateOpen(false); void refresh(); }}
        />
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


function MilestoneRow({ m, depth = 0, canEdit, busy, onSetStatus, onDelete }: {
  m: Milestone; depth?: number; canEdit: boolean; busy: boolean;
  onSetStatus: (id: string, s: MilestoneStatus) => void;
  onDelete: (id: string) => void;
}) {
  // Capture "now" once per mount — render stays pure (React 19 strict).
  const [nowMs] = useState<number>(() => Date.now());
  const start = m.plannedStartAt ? new Date(m.plannedStartAt as string) : null;
  const planned = new Date(m.plannedAt as string);
  const actual = m.actualAt ? new Date(m.actualAt as string) : null;
  const overdue = !actual && planned.getTime() < nowMs && m.status !== "completed";
  const slipDays = actual ? Math.round((actual.getTime() - planned.getTime()) / 86400_000) : 0;
  const blFinish = m.baselineFinishAt ? new Date(m.baselineFinishAt as string) : null;
  const driftDays = blFinish ? Math.round((planned.getTime() - blFinish.getTime()) / 86400_000) : 0;
  // Planned/baseline dates are wall-clock-as-UTC → render in UTC so the day
  // matches the schedule. (The actual-completion date below is a real instant,
  // so it stays in the viewer's local time.)
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

  const tone =
    m.status === "completed" ? "border-emerald-300 bg-emerald-50/50" :
    m.status === "missed"    ? "border-red-300 bg-red-50/50" :
    m.status === "blocked"   ? "border-amber-300 bg-amber-50/50" :
    m.status === "on_hold"   ? "border-amber-300 bg-amber-50/40" :
    overdue                  ? "border-red-300 bg-red-50/40" :
                               "border-slate-200 bg-white";

  const ghost = m.source !== "manual";

  return (
    <div className={`py-3 pr-4 flex items-start gap-3 border-l-4 ${tone} ${ghost ? "opacity-90" : ""}`} style={{ paddingLeft: 16 + depth * 18 }}>
      {m.isSummary
        ? <Layers className="w-4 h-4 mt-0.5 text-indigo-500 shrink-0" />
        : <Flag className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {m.wbs && <span className="font-mono text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{m.wbs}</span>}
          <span className={`text-sm truncate ${m.isSummary ? "font-black text-slate-900" : "font-bold text-slate-900"}`}>{m.name}</span>
          <StatusChip status={m.status} />
          {driftDays !== 0 && blFinish && (
            <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${driftDays > 0 ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`} title="Drift vs approved plan">
              {driftDays > 0 ? `+${driftDays}d` : `${driftDays}d`} vs plan
            </span>
          )}
          {ghost && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500 bg-slate-100 border border-slate-200 px-1 py-0.5 rounded" title={`Imported from ${m.source}`}>
              {m.source}
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {start && start.getTime() !== planned.getTime() ? `${fmt(start)} – ${fmt(planned)}` : fmt(planned)}
          </span>
          {typeof m.durationHours === "number" && m.durationHours > 0 && (
            <span className="font-mono text-slate-500">· {m.durationHours}h</span>
          )}
          {m.workOrderRef && <span className="font-mono text-slate-600">· WO {m.workOrderRef}</span>}
          {(m.responsibleParty || m.responsibleOrg) && (
            <span className="text-slate-600">· {[m.responsibleParty, m.responsibleOrg].filter(Boolean).join(" / ")}</span>
          )}
          {m.location && <span className="text-slate-600">· {m.location}</span>}
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
        {m.description && <div className="mt-1 text-[11px] text-slate-700 whitespace-pre-wrap line-clamp-2">{m.description}</div>}
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
        className="inline-flex items-center gap-0.5 text-[10px] text-slate-600 hover:text-slate-900 border border-slate-200 hover:border-slate-300 px-1.5 py-1 rounded disabled:opacity-40"
        title="Change status"
      >
        Status <ChevronDown className="w-3 h-3" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[190]" onClick={() => setOpen(false)} />
          <div className="fixed z-[200] bg-white border border-slate-200 rounded-lg shadow-xl ring-1 ring-slate-900/5 py-1 w-36" style={{ top: pos.top, left: pos.left }}>
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => { setOpen(false); onPick(s); }}
                className={`w-full text-left text-xs px-3 py-1.5 hover:bg-slate-100 capitalize ${s === current ? "font-bold text-indigo-700" : "text-slate-700"}`}
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

