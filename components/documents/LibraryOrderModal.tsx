"use client";

// LibraryOrderModal — admin-only modal for setting the persistent
// display order of documents in a library. Drag-and-drop (HTML5 API,
// no library dependency) saves to documents.sort_order. NULL values
// fall back to updated_at ordering.

import React, { useEffect, useState } from "react";
import {
  X, GripVertical, RotateCcw, Save, AlertTriangle, Loader2,
  FileText, ArrowDownAZ, ChevronUp, ChevronDown,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useEscapeClose } from "@/components/documents/useEscapeClose";

import { friendlyError } from "@/lib/friendlyError";
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
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose(), isOpen);
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
        if (alive) setError(friendlyError(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [isOpen, orgId, libraryId]);

  // ── Drag-drop handlers ──────────────────────────────────────────
  const onDragStart = (id: string) => setDragId(id);

  // Touch fallback: HTML5 drag doesn't exist on phones/tablets, so every row
  // also gets up/down buttons — same reorder, no dragging required.
  const move = (id: string, dir: -1 | 1) => {
    setDocs((prev) => {
      const idx = prev.findIndex((d) => d.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
    setDirty(true);
  };
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
      const results = await Promise.all(docs.map((d, idx) =>
        supabase.from("documents").update({ sort_order: idx }).eq("id", d.id)
      ));
      const failed = results.filter((r) => r.error).length;
      if (failed) throw new Error(`${failed} of ${docs.length} documents didn't take their new place. Save again.`);
      onSaved();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };

  // ── Reset: clear sort_order on every doc → fall back to date ────
  const reset = async () => {
    if (!(await appConfirm({ title: "Clear custom order", message: "Clear custom order? Documents will fall back to updated-date order.", tone: "danger" }))) return;
    setBusy(true);
    try {
      const { error: resetErr } = await supabase.from("documents")
        .update({ sort_order: null })
        .eq("org_id", orgId)
        .eq("library_id", libraryId);
      if (resetErr) throw new Error(resetErr.message);
      onSaved();
      onClose();
    } catch (e) {
      setError(friendlyError(e));
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
    <div className="fixed inset-0 z-[320] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden my-8 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95">
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-[var(--color-surface-2)] rounded-lg"><GripVertical className="w-4 h-4 text-[var(--color-text-muted)]" /></div>
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">Library Display Order</div>
              <div className="text-body text-[var(--color-text-muted)]">Drag rows to set the order documents appear in this library.</div>
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-1.5 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)] flex items-center justify-between text-body shrink-0">
          <div className="text-[var(--color-text-muted)]">
            {docs.length} document{docs.length === 1 ? "" : "s"} ·
            {dirty ? <span className="text-[var(--color-text)] font-medium"> unsaved changes</span> : <span> position saved</span>}
          </div>
          <button onClick={alphabetize} className="inline-flex items-center gap-1 text-[var(--color-text)] hover:text-[var(--color-text)] font-medium">
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
                    dragId === d.id ? "border-[var(--color-border-strong)] ring-2 ring-[var(--color-border-strong)] opacity-50" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <GripVertical className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                  <span className="text-body font-display tabular-nums text-[var(--color-text-faint)] w-7 text-right shrink-0">{idx + 1}.</span>
                  <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-body font-medium text-[var(--color-text)] truncate">{d.documentNumber}</div>
                    <div className="text-body text-[var(--color-text-muted)] truncate">{d.title}</div>
                  </div>
                  {d.rev && <span className="text-body font-medium text-[var(--color-text-muted)] shrink-0">Rev {d.rev}</span>}
                  <div className="flex flex-col shrink-0 -my-1">
                    <button onClick={() => move(d.id, -1)} disabled={idx === 0} title="Move up"
                      className="p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-25">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => move(d.id, 1)} disabled={idx === docs.length - 1} title="Move down"
                      className="p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-25">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mx-5 my-2 text-body flex items-start gap-2 shrink-0 border-l-2 border-[var(--state-overdue)] pl-3 text-[var(--state-overdue)]">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-between shrink-0">
          <button onClick={reset} disabled={busy} className="text-body font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] inline-flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> Clear custom order
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-body font-medium text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
            <button onClick={save} disabled={busy || !dirty} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-body font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] disabled:opacity-50 shadow">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
