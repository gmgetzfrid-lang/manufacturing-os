"use client";

// FieldLogPanel — frictionless field input for ACTUAL HOURS.
//
// "A stripped-down, idiot-proof interface for field crews to log hours worked.
// If it takes more than three taps to input data, they won't use it."
//
// Each active task gets large +1 / +4 / +8 quick-add buttons (a tap logs a
// shift's worth of hours) plus a direct numeric field. Every entry persists
// immediately via lib/milestones.logActualHours, writes an audit breadcrumb,
// and — once a blended rate is set — feeds ACWP so CPI / CV / EAC update live.
// Mobile-first: big touch targets, no modal, no submit ceremony.
//
// Tolerant of pre-migration environments: if the actual_hours column isn't
// there yet, the first write flips a banner instead of erroring per-tap.

import React, { useRef, useState } from "react";
import {
  ClipboardList, Loader2, Plus, AlertTriangle, Check, ChevronDown, ChevronRight,
} from "lucide-react";
import { logActualHours } from "@/lib/milestones";
import { formatMoney } from "@/lib/evm";
import type { Milestone, MilestoneStatus } from "@/types/schema";

interface Props {
  milestones: Milestone[];
  blendedRate: number;
  currency: string;
  canEdit: boolean;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  /** Re-fetch the schedule after a log so the cost EVM recomputes. */
  onLogged: () => void;
}

const ACTIVE: ReadonlySet<MilestoneStatus> = new Set(["in_progress", "blocked", "on_hold"]);

export default function FieldLogPanel({
  milestones, blendedRate, currency, canEdit, userId, userName, userEmail, userRole, onLogged,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-row in-flight set — a single id would clear one row's spinner when
  // another row starts saving.
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());

  const parentIds = new Set<string>();
  for (const m of milestones) if (m.parentId) parentIds.add(m.parentId);
  const leaves = milestones.filter((m) => !(m.id && parentIds.has(m.id)));

  const isActive = (m: Milestone) => ACTIVE.has(m.status) || m.actualHours != null;
  const startMs = (m: Milestone) => Date.parse((m.plannedStartAt as string | undefined) ?? (m.plannedAt as string)) || 0;
  const ordered = (showAll ? leaves : leaves.filter(isActive))
    .slice()
    .sort((a, b) => {
      const aa = isActive(a) ? 0 : 1;
      const bb = isActive(b) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return startMs(a) - startMs(b);
    });

  const totalLogged = leaves.reduce((s, m) => s + (m.actualHours && m.actualHours > 0 ? m.actualHours : 0), 0);
  const totalPlanned = leaves.reduce((s, m) => s + (m.durationHours && m.durationHours > 0 ? m.durationHours : 0), 0);
  const derivedAc = blendedRate > 0 ? totalLogged * blendedRate : null;

  const persist = async (id: string, hours: number | null) => {
    setSavingIds((prev) => { const n = new Set(prev); n.add(id); return n; });
    setError(null);
    try {
      const res = await logActualHours({
        id, actualHours: hours,
        actorUserId: userId, actorUserName: userName, actorUserEmail: userEmail, actorUserRole: userRole,
      });
      if (!res.ok) {
        if (res.needsMigration) setNeedsMigration(true);
        return;
      }
      onLogged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  if (leaves.length === 0) return null;

  const hiddenCount = leaves.length - leaves.filter(isActive).length;

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap">
        <ClipboardList className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="font-bold text-sm text-[var(--color-text)]">Field log — actual hours</div>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
          <span><b className="text-[var(--color-text)]">{round1(totalLogged)}</b> / {round1(totalPlanned)}h logged</span>
          {derivedAc != null && <span>ACWP <b className="text-[var(--color-text)]">{formatMoney(derivedAc, currency)}</b></span>}
        </div>
      </div>

      {needsMigration && (
        <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Logged hours can&rsquo;t be saved yet — run migration <b>20260802_milestone_actual_hours.sql</b> in Supabase to enable field-driven actual cost.</span>
        </div>
      )}
      {error && (
        <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 text-[11px] text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {ordered.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
          No active tasks. {hiddenCount > 0 && <button onClick={() => setShowAll(true)} className="text-[var(--color-accent)] font-bold hover:underline">Show all {leaves.length} tasks</button>}
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {ordered.map((m) => (
            <FieldLogRow
              // Key on the persisted value so the row re-seeds (remounts) when
              // actual_hours changes server-side — after a save or an external
              // edit — without a state-syncing effect. The row isn't focused at
              // that point (saves fire from a blur or a quick-tap), so no typing
              // is interrupted; rows whose value didn't change don't remount.
              key={`${m.id}:${m.actualHours ?? ""}`}
              m={m}
              currency={currency}
              blendedRate={blendedRate}
              canEdit={canEdit}
              saving={!!m.id && savingIds.has(m.id)}
              disabled={needsMigration}
              onPersist={persist}
            />
          ))}
        </div>
      )}

      {leaves.length > leaves.filter(isActive).length && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-4 py-2 text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center justify-center gap-1 border-t border-[var(--color-border)] transition-colors"
        >
          {showAll ? <><ChevronDown className="w-3.5 h-3.5" /> Active tasks only</> : <><ChevronRight className="w-3.5 h-3.5" /> Show all {leaves.length} tasks ({hiddenCount} more)</>}
        </button>
      )}
    </div>
  );
}

function FieldLogRow({
  m, currency, blendedRate, canEdit, saving, disabled, onPersist,
}: {
  m: Milestone;
  currency: string;
  blendedRate: number;
  canEdit: boolean;
  saving: boolean;
  disabled: boolean;
  onPersist: (id: string, hours: number | null) => void;
}) {
  const planned = m.durationHours && m.durationHours > 0 ? m.durationHours : 0;
  // Seeded once from the persisted value; the row remounts (via its key) when
  // that value changes, so this stays reconciled without a syncing effect.
  const propValue = m.actualHours ?? null;
  const [draft, setDraft] = useState<string>(propValue != null ? String(propValue) : "");
  // Synchronous source of truth so rapid taps accumulate correctly even before
  // React re-renders (a quick(+8) tapped twice must reach 16, not lose one).
  const valueRef = useRef<number | null>(propValue);

  const parsed = draft.trim() === "" ? null : Number(draft);
  const actual = parsed != null && Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  const variance = planned > 0 && actual != null ? actual - planned : null;
  // Green check only when the shown value is the confirmed-persisted one (after
  // a save the row has remounted with draft == propValue).
  const persisted = !saving && actual != null && actual === propValue;

  const commit = (next: number | null) => {
    if (!m.id || disabled) return;
    onPersist(m.id, next);
  };
  const quick = (inc: number) => {
    const base = valueRef.current ?? 0;
    const nv = Math.max(0, Math.round((base + inc) * 100) / 100);
    valueRef.current = nv;
    setDraft(String(nv));
    commit(nv);
  };
  const onType = (text: string) => {
    setDraft(text);
    const n = text.trim() === "" ? null : Number(text);
    valueRef.current = n != null && Number.isFinite(n) ? Math.max(0, n) : null;
  };
  const commitDraft = () => commit(valueRef.current);

  return (
    <div className="px-4 py-3 flex items-center gap-3 flex-wrap sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--color-text)] truncate">{m.name}</span>
          <StatusDot status={m.status} />
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
          <span className="font-mono">plan {planned > 0 ? `${round1(planned)}h` : "—"}</span>
          {actual != null && (
            <span className="font-mono">· actual {round1(actual)}h</span>
          )}
          {variance != null && variance !== 0 && (
            <span className={`font-bold ${variance > 0 ? "text-rose-700" : "text-emerald-700"}`}>
              {variance > 0 ? "+" : ""}{round1(variance)}h {variance > 0 ? "over" : "under"}
            </span>
          )}
          {blendedRate > 0 && actual != null && actual > 0 && (
            <span className="text-[var(--color-text-faint)]">· {formatMoney(actual * blendedRate, currency)}</span>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex items-center gap-1.5 shrink-0">
          {[1, 4, 8].map((inc) => (
            <button
              key={inc}
              onClick={() => quick(inc)}
              disabled={disabled || saving}
              className="inline-flex items-center justify-center min-w-[2.5rem] h-9 px-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-xs font-bold text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-accent-ring)] active:scale-95 disabled:opacity-40 transition-all"
              title={`Add ${inc} hour${inc === 1 ? "" : "s"}`}
            >
              <Plus className="w-3 h-3" />{inc}
            </button>
          ))}
          <input
            inputMode="decimal"
            value={draft}
            onChange={(e) => onType(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
            disabled={disabled}
            placeholder="0"
            aria-label={`Actual hours for ${m.name}`}
            className="w-16 h-9 px-2 text-sm text-center font-mono rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)] disabled:opacity-50"
          />
          <span className="text-[10px] font-bold text-[var(--color-text-faint)] w-3">h</span>
          <span className="w-4 inline-flex justify-center">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-accent)]" /> : persisted ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : null}
          </span>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: MilestoneStatus }) {
  const tone =
    status === "completed" ? "bg-emerald-500" :
    status === "in_progress" ? "bg-blue-500" :
    status === "blocked" ? "bg-amber-500" :
    status === "on_hold" ? "bg-amber-400" :
    status === "missed" ? "bg-rose-500" :
    "bg-slate-300";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${tone}`} title={status.replace("_", " ")} />;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
