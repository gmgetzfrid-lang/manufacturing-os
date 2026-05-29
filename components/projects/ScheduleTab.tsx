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
import {
  listMilestones, createMilestone, setMilestoneStatus, deleteMilestone,
  importGhostMilestones, computeScheduleMetrics, type ScheduleMetrics,
} from "@/lib/milestones";
import type { Milestone, MilestoneStatus, MilestoneSource } from "@/types/schema";
import HelpTooltip from "@/components/ui/HelpTooltip";
import FirstRunHint from "@/components/ui/FirstRunHint";
import GanttView from "@/components/projects/GanttView";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);
const STATUS_OPTIONS: MilestoneStatus[] = ["planned", "in_progress", "completed", "missed", "blocked"];

interface ScheduleTabProps {
  orgId: string;
  projectId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
}

export default function ScheduleTab({ orgId, projectId, userId, userName, userEmail, userRole }: ScheduleTabProps) {
  const canEdit = !!userRole && ADMIN_ROLES.has(userRole);

  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showGhost, setShowGhost] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      <FirstRunHint storageKey="schedule.intro" tone="info">
        Milestones are dated checkpoints with a planned date, an actual date (when hit), and a weight.
        Track them manually or import from P6/MS Project as a read-only ghost overlay.
        We deliberately don&apos;t replace your scheduling tool — this just gives you document-anchored visibility.
      </FirstRunHint>

      {/* Earned-value widget */}
      <EarnedValueWidget metrics={metrics} loading={loading} />

      {/* Gantt — horizontal milestone timeline with today line + slip indicators */}
      <GanttView milestones={visible} />

      {/* Milestone list header */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Flag className="w-4 h-4 text-indigo-600" />
            <div className="font-bold text-slate-900 text-sm">Milestones</div>
            <span className="text-[10px] text-slate-500 font-mono">{visible.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGhost((v) => !v)}
              title={showGhost ? "Hide imported (ghost) milestones" : "Show imported (ghost) milestones"}
              className="inline-flex items-center gap-1 text-[11px] text-slate-600 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-100"
            >
              {showGhost ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              Ghost
            </button>
            <HelpTooltip>
              <b>Ghost milestones</b> are read-only rows imported from your scheduling tool (P6, MS Project). They still count toward earned-value rollup. Toggle to hide them from the list while metrics still consider them committed work.
            </HelpTooltip>
            {canEdit && (
              <>
                <button
                  onClick={() => setImportOpen(true)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-700 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2 py-1 rounded"
                >
                  <Upload className="w-3.5 h-3.5" /> Import
                </button>
                <button
                  onClick={() => setAdding((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-500 px-2 py-1 rounded"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </>
            )}
          </div>
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
            No milestones yet.{canEdit && " Click Add to create the first one."}
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

      {importOpen && (
        <ImportScheduleModal
          orgId={orgId}
          projectId={projectId}
          userId={userId}
          userName={userName}
          onClose={() => setImportOpen(false)}
          onDone={() => { setImportOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Earned-value widget ───────────────────────────────────────

function EarnedValueWidget({ metrics, loading }: { metrics: ScheduleMetrics; loading: boolean }) {
  const earnedPct = Math.round(metrics.percentEarned * 100);
  const plannedPct = Math.round(metrics.percentPlanned * 100);
  const spiTone =
    metrics.spi >= 1   ? "text-emerald-700 bg-emerald-50 border-emerald-200" :
    metrics.spi >= 0.9 ? "text-amber-700  bg-amber-50  border-amber-200"  :
                         "text-red-700    bg-red-50    border-red-200";
  const forecastDate = metrics.forecastEndAt ? new Date(metrics.forecastEndAt) : null;
  const plannedDate  = metrics.plannedEndAt  ? new Date(metrics.plannedEndAt)  : null;
  const slipDays = (forecastDate && plannedDate)
    ? Math.round((forecastDate.getTime() - plannedDate.getTime()) / 86400_000)
    : 0;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-600" />
          <div className="font-bold text-slate-900 text-sm inline-flex items-center gap-1">
            Earned Value
            <HelpTooltip>
              <b>Earned Value</b> compares planned progress against actual progress over time. Each completed milestone contributes its <b>weight</b> to the total. A milestone&apos;s weight defaults to 1; bump it higher for big-ticket deliverables.
            </HelpTooltip>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className={`font-mono font-bold border px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${spiTone}`}>
            SPI {(metrics.spi).toFixed(2)}
            <HelpTooltip>
              <b>Schedule Performance Index.</b> Earned weight ÷ planned weight to date. <b>1.0</b> = on track. <b>&lt; 1.0</b> = behind schedule. <b>&gt; 1.0</b> = ahead. The forecast end-date stretches the remaining duration by 1/SPI.
            </HelpTooltip>
          </span>
          {forecastDate && plannedDate && (
            <span
              className={`font-mono ${slipDays > 0 ? "text-red-700" : "text-emerald-700"}`}
              title={`Forecast: ${forecastDate.toLocaleDateString()}`}
            >
              {slipDays > 0 ? `+${slipDays}d` : `${slipDays}d`} vs plan
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> …
        </div>
      ) : metrics.totalWeight === 0 ? (
        <div className="text-xs text-slate-500">No milestones yet. Add some to see schedule performance.</div>
      ) : (
        <>
          {/* Twin bars: planned (light) over earned (filled) */}
          <div className="space-y-2">
            <BarRow label="Planned to date" pct={plannedPct} color="bg-slate-300" total={metrics.totalWeight} value={metrics.plannedValue} />
            <BarRow label="Earned"          pct={earnedPct}  color="bg-emerald-500" total={metrics.totalWeight} value={metrics.earnedValue} />
          </div>

          {/* Status counts */}
          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-3 text-[11px] flex-wrap">
            <StatusCount label="Planned"     count={metrics.byStatus.planned}     tone="slate" />
            <StatusCount label="In Progress" count={metrics.byStatus.in_progress} tone="blue" />
            <StatusCount label="Completed"   count={metrics.byStatus.completed}   tone="emerald" />
            <StatusCount label="Missed"      count={metrics.byStatus.missed}      tone="red" />
            <StatusCount label="Blocked"     count={metrics.byStatus.blocked}     tone="amber" />
          </div>
        </>
      )}
    </div>
  );
}

function BarRow({ label, pct, color, value, total }: { label: string; pct: number; color: string; value: number; total: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-700">{label}</span>
        <span className="font-mono text-slate-500">{value.toFixed(1)} / {total.toFixed(1)} ({pct}%)</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

function StatusCount({ label, count, tone }: { label: string; count: number; tone: "slate" | "blue" | "emerald" | "red" | "amber" }) {
  const toneClass =
    tone === "blue"    ? "text-blue-700    bg-blue-50    border-blue-200" :
    tone === "emerald" ? "text-emerald-700 bg-emerald-50 border-emerald-200" :
    tone === "red"     ? "text-red-700     bg-red-50     border-red-200" :
    tone === "amber"   ? "text-amber-700   bg-amber-50   border-amber-200" :
                         "text-slate-700   bg-slate-50   border-slate-200";
  return (
    <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 rounded font-mono ${toneClass}`}>
      {label} <b>{count}</b>
    </span>
  );
}

// ─── Milestone row ─────────────────────────────────────────────

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

// ─── Import modal ──────────────────────────────────────────────

function ImportScheduleModal({
  orgId, projectId, userId, userName, onClose, onDone,
}: {
  orgId: string; projectId: string; userId: string; userName?: string;
  onClose: () => void; onDone: () => void;
}) {
  const [csv, setCsv] = useState("name,planned_at,weight,external_ref\n");
  const [source, setSource] = useState<MilestoneSource>("p6");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inserted: number; updated: number; skipped: number; errors: string[] } | null>(null);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await importGhostMilestones({
        orgId, projectId,
        source: source === "manual" ? "p6" : source,
        csv,
        createdBy: userId,
        createdByName: userName,
      });
      setResult(r);
      if (r.errors.length === 0 && (r.inserted > 0 || r.updated > 0)) {
        onDone();
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-indigo-600" />
            <div>
              <h2 className="font-black text-slate-900">Import Schedule</h2>
              <div className="text-[11px] text-slate-500">Ghost overlay — read-only reference data from your PM tool.</div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="text-[11px] text-slate-600">
            Paste CSV with header row. Required columns:
            <code className="ml-1 font-mono bg-slate-100 px-1 rounded">name</code>,
            <code className="ml-1 font-mono bg-slate-100 px-1 rounded">planned_at</code>.
            Optional:
            <code className="ml-1 font-mono bg-slate-100 px-1 rounded">weight</code>,
            <code className="ml-1 font-mono bg-slate-100 px-1 rounded">description</code>,
            <code className="ml-1 font-mono bg-slate-100 px-1 rounded">external_ref</code>.
            Rows with <code className="font-mono bg-slate-100 px-1 rounded">external_ref</code> upsert on re-import.
            One-way only — we never write back to your PM tool.
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-700 font-bold">Source:</span>
            <select value={source} onChange={(e) => setSource(e.target.value as MilestoneSource)} className="border border-slate-300 rounded px-2 py-1 text-xs">
              <option value="p6">Primavera P6</option>
              <option value="msproject">MS Project</option>
              <option value="csv">Generic CSV</option>
            </select>
          </div>

          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={8}
            className="w-full text-xs font-mono border border-slate-300 rounded px-2 py-1.5 resize-y"
            placeholder="name,planned_at,weight,external_ref"
          />

          {result && (
            <div className="text-xs space-y-1">
              <div className="text-emerald-700">Inserted: <b>{result.inserted}</b></div>
              <div className="text-blue-700">Updated: <b>{result.updated}</b></div>
              {result.skipped > 0 && <div className="text-slate-600">Skipped: <b>{result.skipped}</b></div>}
              {result.errors.length > 0 && (
                <div className="text-red-700">
                  Errors: <b>{result.errors.length}</b>
                  <ul className="list-disc ml-5">
                    {result.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Close</button>
          <button onClick={submit} disabled={busy || csv.trim().length < 10} className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} Import
          </button>
        </div>
      </div>
    </div>
  );
}
