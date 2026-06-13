"use client";

// LibraryOrderModal — admin-only modal for setting the persistent
// display order of documents in a library. Drag-and-drop (HTML5 API,
// no library dependency) saves to documents.sort_order. NULL values
// fall back to updated_at ordering.

import React, { useEffect, useState } from "react";
import {
  X, GripVertical, RotateCcw, Save, AlertTriangle, Loader2,
  FileText, ArrowDownAZ,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";

interface DocItem {
  id: string;
  documentNumber: string;
  title: string;
  rev?: string;
  sort_order: number | null;
}

interface LibraryOrderModalProps {
  isOpen: boolean;
  orgId: string;
  libraryId: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function LibraryOrderModal({
  isOpen, orgId, libraryId, onClose, onSaved,
}: LibraryOrderModalProps) {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error: e } = await supabase
          .from("documents")
          .select("id, document_number, title, rev, sort_order")
          .eq("org_id", orgId)
          .eq("library_id", libraryId)
          .order("sort_order", { ascending: true, nullsFirst: false })
          .order("updated_at", { ascending: false });
        if (e) throw e;
        if (alive) {
          setDocs(((data as Array<Record<string, unknown>>) ?? []).map((d) => ({
            id: d.id as string,
            documentNumber: (d.document_number as string) || "",
            title: (d.title as string) || "",
            rev: (d.rev as string) || undefined,
            sort_order: d.sort_order as number | null,
          })));
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, orgId, libraryId]);

  // ── Drag-drop handlers ──────────────────────────────────────────
  const onDragStart = (id: string) => setDragId(id);
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const onDrop = (overId: string) => {
    if (!dragId || dragId === overId) return;
    setDocs((prev) => {
      const fromIdx = prev.findIndex((d) => d.id === dragId);
      const toIdx = prev.findIndex((d) => d.id === overId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDragId(null);
    setDirty(true);
  };

  // ── Save: assign 0..N sort_order in current array order ─────────
  const save = async () => {
    setBusy(true); setError(null);
    try {
      // Bulk-update sort_order. One row per update to avoid the
      // upsert-with-conflict dance (Postgres-via-Supabase doesn't have
      // a clean bulk-update API).
      await Promise.all(docs.map((d, idx) =>
        supabase.from("documents").update({ sort_order: idx }).eq("id", d.id)
      ));
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // ── Reset: clear sort_order on every doc → fall back to date ────
  const reset = async () => {
    if (!(await appConfirm({ title: "Clear custom order", message: "Clear custom order? Documents will fall back to updated-date order.", tone: "danger" }))) return;
    setBusy(true);
    try {
      await supabase.from("documents")
        .update({ sort_order: null })
        .eq("org_id", orgId)
        .eq("library_id", libraryId);
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // ── Alphabetize: assign sort_order by docNum ─────────────────────
  const alphabetize = () => {
    setDocs((prev) => [...prev].sort((a, b) => a.documentNumber.localeCompare(b.documentNumber)));
    setDirty(true);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[320] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95">
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-purple-100 rounded-lg"><GripVertical className="w-4 h-4 text-purple-700" /></div>
            <div>
              <div className="text-sm font-black text-[var(--color-text)]">Library Display Order</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Drag rows to set the order documents appear in this library.</div>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex items-center justify-between text-[11px] shrink-0">
          <div className="text-[var(--color-text-muted)]">
            {docs.length} document{docs.length === 1 ? "" : "s"} ·
            {dirty ? <span className="text-orange-700 font-bold"> unsaved changes</span> : <span> position saved</span>}
          </div>
          <button onClick={alphabetize} className="inline-flex items-center gap-1 text-[var(--color-text)] hover:text-[var(--color-text)] font-bold">
            <ArrowDownAZ className="w-3 h-3" /> Alphabetize
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            <div className="text-center text-sm text-[var(--color-text-muted)] py-8">
              <Loader2 className="w-4 h-4 animate-spin inline" /> Loading…
            </div>
          ) : docs.length === 0 ? (
            <div className="text-center text-sm text-[var(--color-text-faint)] py-8 italic">No documents in this library yet.</div>
          ) : (
            <div className="space-y-1">
              {docs.map((d, idx) => (
                <div
                  key={d.id}
                  draggable
                  onDragStart={() => onDragStart(d.id)}
                  onDragOver={onDragOver}
                  onDrop={() => onDrop(d.id)}
                  className={`bg-[var(--color-surface)] border rounded-lg px-2.5 py-2 flex items-center gap-2.5 cursor-move transition-all ${
                    dragId === d.id ? "border-purple-400 ring-2 ring-purple-200 opacity-50" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <GripVertical className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <span className="text-[10px] font-mono text-[var(--color-text-faint)] w-7 text-right shrink-0">{idx + 1}.</span>
                  <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold text-[var(--color-text)] truncate">{d.documentNumber}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] truncate">{d.title}</div>
                  </div>
                  {d.rev && <span className="text-[10px] font-bold text-[var(--color-text-muted)] shrink-0">Rev {d.rev}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="px-5 py-2 bg-red-50 border-t border-red-200 text-xs text-red-700 flex items-start gap-2 shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          <button onClick={reset} disabled={busy} className="text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] inline-flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> Clear custom order
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
            <button onClick={save} disabled={busy || !dirty} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
