"use client";

// BulkEditModal — apply a single metadata change across many documents
// in one submit. The user picks a target field (status or a custom column)
// and a new value; the modal writes the update to every selected doc,
// recomputes uniqueness_key if relevant, and surfaces per-doc errors so a
// single failure doesn't blank the result.
//
// DRLS-15: Revision is not a bulk field. A document's revision label is its
// current revision's (the database refuses any other), so it is corrected on
// the revision itself, never set across rows.

import React, { useState } from "react";
import {
  X, Pencil, Loader2, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { computeUniquenessKey } from "@/lib/uniqueness";
import type { DocumentRecord, LibraryConfig, MetadataFieldDefinition } from "@/types/schema";

interface BulkEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  docs: DocumentRecord[];
  library: LibraryConfig;
  actorUserId: string;
  /** Refresh the parent's document list after a successful apply. */
  onApplied?: () => void;
}

type TargetField =
  | { kind: "status" }
  | { kind: "custom"; def: MetadataFieldDefinition };

const STATUS_OPTIONS = ["Draft", "In Review", "Issued", "IFC", "Superseded", "Archived"];

export default function BulkEditModal({
  isOpen, onClose, docs, library, actorUserId, onApplied,
}: BulkEditModalProps) {
  const [target, setTarget] = useState<TargetField>({ kind: "status" });
  const [newValue, setNewValue] = useState<string>(STATUS_OPTIONS[0]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ ok: number; failed: Array<{ doc: string; reason: string }> } | null>(null);

  if (!isOpen) return null;

  const customCols = (library.customColumns ?? []).filter((c) => !["title", "rev", "status", "documentNumber"].includes(c.key));
  const selectOptions = target.kind === "custom" && target.def.type === "select" ? (target.def.options ?? []) : null;

  const apply = async () => {
    setBusy(true);
    setResults(null);
    const failed: Array<{ doc: string; reason: string }> = [];
    let ok = 0;
    const now = new Date().toISOString();
    for (const doc of docs) {
      try {
        const updates: Record<string, unknown> = { updated_at: now, updated_by: actorUserId };
        if (target.kind === "status") {
          updates.status = newValue;
        } else if (target.kind === "custom") {
          // Custom field lives in metadata jsonb
          const meta = { ...(doc.metadata ?? {}) };
          (meta as Record<string, unknown>)[target.def.key] = newValue;
          updates.metadata = meta;
        }
        // If this change affects a uniqueness-key contributing field,
        // recompute and write the new key so the constraint stays valid.
        const fieldKey = target.kind === "status" ? "status" : target.def.key;
        const keys = library.uniquenessKeys?.length ? library.uniquenessKeys : ["documentNumber"];
        if (keys.includes(fieldKey)) {
          updates.uniqueness_key = computeUniquenessKey({
            documentNumber: doc.documentNumber,
            title: doc.title,
            rev: doc.rev,
            status: target.kind === "status" ? newValue : doc.status,
            customFields: target.kind === "custom"
              ? { ...(doc.metadata as Record<string, unknown> ?? {}), [target.def.key]: newValue }
              : (doc.metadata as Record<string, unknown> ?? {}),
          }, library.uniquenessKeys);
        }
        // Checked: an error, or a write the database filtered to no row, is a failure on this row.
        const { data: written, error } = await supabase.from("documents").update(updates).eq("id", doc.id).select("id");
        if (error) throw error;
        if (!written || written.length === 0) throw new Error("refused — the database updated nothing (no edit access to this document)");
        ok += 1;
      } catch (e) {
        failed.push({ doc: doc.documentNumber || doc.title || doc.id || "?", reason: (e as Error).message });
      }
    }
    setResults({ ok, failed });
    setBusy(false);
    if (ok > 0) onApplied?.();
  };

  return (
    <div className="fixed inset-0 z-[300] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-100 text-violet-700"><Pencil className="w-5 h-5" /></div>
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Bulk edit · {docs.length} document{docs.length === 1 ? "" : "s"}</div>
            <div className="text-xs text-[var(--color-text-muted)]">Apply one change to every selected row. Each insert is independent — a single failure doesn&apos;t roll back the rest.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5 block">Field to change</label>
            <select
              value={target.kind === "custom" ? `custom:${target.def.key}` : target.kind}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "status") {
                  setTarget({ kind: "status" }); setNewValue(STATUS_OPTIONS[0]);
                } else {
                  const key = v.replace(/^custom:/, "");
                  const def = customCols.find((c) => c.key === key);
                  if (def) {
                    setTarget({ kind: "custom", def });
                    setNewValue("");
                  }
                }
              }}
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
              disabled={busy}
            >
              <option value="status">Status</option>
              {customCols.map((c) => (
                <option key={c.key} value={`custom:${c.key}`}>{c.label} (custom)</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest mb-1.5 block">New value</label>
            {target.kind === "status" ? (
              <select
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                disabled={busy}
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : selectOptions ? (
              <select
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                disabled={busy}
              >
                <option value="">— pick one —</option>
                {selectOptions.map((o, i) => <option key={i} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                value={newValue} onChange={(e) => setNewValue(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"
                placeholder="Value to set on every selected doc"
                disabled={busy}
              />
            )}
          </div>

          {results && (
            <div className="space-y-2">
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                Applied to <b>{results.ok}</b> document{results.ok === 1 ? "" : "s"}.
              </div>
              {results.failed.length > 0 && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-800">
                  <div className="font-bold flex items-center gap-1.5 mb-1"><AlertTriangle className="w-4 h-4" /> {results.failed.length} failed</div>
                  <ul className="ml-5 list-disc space-y-0.5">
                    {results.failed.slice(0, 5).map((f, i) => (
                      <li key={i}><span className="font-mono">{f.doc}</span> — {f.reason}</li>
                    ))}
                    {results.failed.length > 5 && <li className="italic">+{results.failed.length - 5} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <button
              onClick={apply}
              disabled={busy || !newValue}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pencil className="w-3.5 h-3.5" />}
              {busy ? "Applying…" : `Apply to ${docs.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
