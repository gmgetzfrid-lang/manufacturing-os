"use client";

// BulkEditModal — change a name on every task at once, or set a value on
// the tasks you selected. Shows exactly which tasks change (before → after)
// before anything is written.

import React, { useMemo, useState } from "react";
import { Replace, Loader2, ArrowRight, Search } from "lucide-react";
import type { Milestone } from "@/types/schema";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { BULK_FIELDS, valuesIn, planReplace, planSet, valueLabel, type BulkField } from "@/lib/bulkEdit";
import { applyBulkFieldChange } from "@/lib/milestones";

export default function BulkEditModal({ milestones, selectedIds, startMode, orgId, projectId, userId, userEmail, onClose, onDone }: {
  milestones: Milestone[];
  selectedIds: Set<string>;
  startMode: "replace" | "set";
  orgId: string; projectId: string; userId: string; userEmail?: string;
  onClose: () => void;
  /** After a change is written: how many tasks changed, and how to put
   *  every one of them back (Undo). */
  onDone: (count: number, undo: () => Promise<void>) => void;
}) {
  const [mode, setMode] = useState<"replace" | "set">(selectedIds.size > 0 ? startMode : "replace");
  const [field, setField] = useState<BulkField>(BULK_FIELDS[0]);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values = useMemo(() => valuesIn(milestones, field), [milestones, field]);
  const shownValues = values.filter((v) => !query || v.value.toLowerCase().includes(query.toLowerCase()));
  const plan = useMemo(() => mode === "replace"
    ? (from ? planReplace(milestones, field, from, to) : [])
    : planSet(milestones, field, selectedIds, to),
  [mode, from, to, milestones, field, selectedIds]);

  const apply = async () => {
    if (plan.length === 0) return;
    setBusy(true); setError(null);
    try {
      await applyBulkFieldChange({
        orgId, projectId, field: field.key, changes: plan.map((c) => ({ id: c.id, after: c.after })),
        summary: mode === "replace" ? { mode, from: from ?? "", to: to.trim() || null } : { mode, to: to.trim() || null },
        actorUserId: userId, actorUserEmail: userEmail,
      });
      const key = field.key;
      const back = plan.map((c) => ({ id: c.id, after: c.before }));
      onDone(plan.length, () => applyBulkFieldChange({
        orgId, projectId, field: key, changes: back, summary: { mode: "set", to: "(undo)" },
        actorUserId: userId, actorUserEmail: userEmail,
      }));
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const pickField = (key: string) => {
    const f = BULK_FIELDS.find((x) => x.key === key) ?? BULK_FIELDS[0];
    setField(f); setFrom(null); setTo(""); setQuery("");
    // A fixed-choice field (the crew) is set on the selection.
    if (f.options && selectedIds.size > 0) setMode("set");
  };
  const inp = "w-full h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent-ring)]";

  return (
    <Modal onClose={busy ? () => undefined : onClose} size="lg" dismissable={!busy}>
      <ModalHeader icon={Replace} title="Change on many tasks"
        subtitle="Swap a contractor, crew, company or location everywhere it appears - or set it (or day / night) on the tasks you selected." onClose={busy ? undefined : onClose} />
      <ModalBody className="space-y-3">
        <div className="inline-flex rounded-lg bg-[var(--color-surface-2)] p-0.5 text-[12px] font-bold">
          <button onClick={() => setMode("replace")} className={`px-3 py-1.5 rounded-md ${mode === "replace" ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>Replace a name everywhere</button>
          <button onClick={() => selectedIds.size > 0 && setMode("set")} disabled={selectedIds.size === 0}
            title={selectedIds.size === 0 ? "Select tasks on the timeline first" : undefined}
            className={`px-3 py-1.5 rounded-md disabled:opacity-40 ${mode === "set" ? "bg-[var(--color-surface)] shadow-sm text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
            Set on {selectedIds.size} selected task{selectedIds.size === 1 ? "" : "s"}
          </button>
        </div>

        <label className="block">
          <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Field</span>
          <select value={field.key} onChange={(e) => pickField(e.target.value)} className={inp}>
            {BULK_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>

        {mode === "replace" && field.options && (
          <p className="text-[12px] text-[var(--color-text-muted)]">Select the tasks on the timeline first, then set the crew on them.</p>
        )}
        {mode === "replace" && !field.options && (
          <div>
            <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Replace</span>
            {values.length === 0 ? (
              <p className="text-[12px] text-[var(--color-text-muted)]">No task has this field filled in.</p>
            ) : (
              <>
                {values.length > 8 && (
                  <div className="relative mb-1.5">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a name…" className={`${inp} h-8 pl-8 text-xs`} />
                  </div>
                )}
                <ul className="max-h-44 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
                  {shownValues.map((v) => (
                    <li key={v.value}>
                      <button onClick={() => setFrom(v.value)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] ${from === v.value ? "bg-[var(--color-accent-soft)] font-bold text-[var(--color-text)]" : "text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
                        <span className="flex-1 truncate">{v.value}</span>
                        <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{v.count} task{v.count === 1 ? "" : "s"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {mode === "set" && field.options && (
          <label className="block">
            <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Set to</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} className={inp}>
              {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        {(mode === "set" || from) && !field.options && (
          <label className="block">
            <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              {mode === "replace" ? <>With <span className="normal-case font-semibold">(leave blank to remove &ldquo;{from}&rdquo;)</span></> : "Set to (blank clears it)"}
            </span>
            <input value={to} onChange={(e) => setTo(e.target.value)} autoFocus list="bulk-values" placeholder={mode === "replace" ? "New name" : "Value"} className={inp} />
            <datalist id="bulk-values">{values.map((v) => <option key={v.value} value={v.value} />)}</datalist>
          </label>
        )}

        {plan.length > 0 && (
          <div>
            <span className="block text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">Will change {plan.length} task{plan.length === 1 ? "" : "s"}</span>
            <ul className="max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] text-[12px]">
              {plan.slice(0, 200).map((c) => (
                <li key={c.id} className="px-3 py-1.5 flex items-center gap-2">
                  <span className="w-44 shrink-0 truncate font-semibold text-[var(--color-text)]" title={c.name}>{c.name}</span>
                  <span className="truncate text-[var(--color-text-muted)] line-through" title={c.before ?? ""}>{valueLabel(field, c.before) || "-"}</span>
                  <ArrowRight className="w-3 h-3 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="truncate font-semibold text-[var(--color-text)]" title={c.after ?? ""}>{valueLabel(field, c.after) || "(empty)"}</span>
                </li>
              ))}
              {plan.length > 200 && <li className="px-3 py-1.5 text-[var(--color-text-muted)]">…and {plan.length - 200} more</li>}
            </ul>
          </div>
        )}
        {error && <div className="text-[12px] font-bold text-rose-700 dark:text-rose-400">{error}</div>}
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} disabled={busy} className="h-9 px-3 rounded-lg text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
        <button onClick={() => void apply()} disabled={busy || plan.length === 0}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Replace className="w-4 h-4" />}
          {plan.length ? `Change ${plan.length} task${plan.length === 1 ? "" : "s"}` : "Change"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
