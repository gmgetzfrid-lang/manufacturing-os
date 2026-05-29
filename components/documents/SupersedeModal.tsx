"use client";

// SupersedeModal — retire a whole document. Optionally point to replacement
// documents (by document_number) so the audit chain reflects splits and
// restructures. Reason is required. Replacements are resolved server-side
// scoped to the same library at submit time.

import React, { useState } from "react";
import { X, Layers, AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { supersedeDocument } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";
import IsoGuidance from "@/components/ui/IsoGuidance";

interface SupersedeModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  libraryId: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess: (result: { unresolvedDocNumbers: string[] }) => void;
}

export default function SupersedeModal({
  isOpen, onClose, doc, libraryId,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: SupersedeModalProps) {
  const [reason, setReason] = useState("");
  const [mocRef, setMocRef] = useState("");
  const [replacementInput, setReplacementInput] = useState("");
  const [replacements, setReplacements] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);

  if (!isOpen) return null;

  const addReplacement = () => {
    const v = replacementInput.trim();
    if (!v) return;
    if (replacements.includes(v)) return;
    setReplacements([...replacements, v]);
    setReplacementInput("");
  };

  const removeReplacement = (v: string) => {
    setReplacements(replacements.filter((x) => x !== v));
  };

  const submit = async () => {
    if (!reason.trim()) return setError("Reason is required to supersede.");
    setBusy(true); setError(null); setUnresolved([]);
    try {
      const result = await supersedeDocument({
        doc,
        replacementDocNumbers: replacements,
        libraryId,
        reason,
        mocReference: mocRef,
        orgId,
        actorUserId,
        actorEmail,
        actorRole,
      });
      setUnresolved(result.unresolvedDocNumbers);
      onSuccess({ unresolvedDocNumbers: result.unresolvedDocNumbers });
      // Reset
      setReason(""); setMocRef(""); setReplacements([]); setReplacementInput("");
      if (result.unresolvedDocNumbers.length === 0) onClose();
    } catch (e) {
      setError((e as Error).message || "Supersede failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 bg-amber-100 rounded-lg">
            <Layers className="w-5 h-5 text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-900 inline-flex items-center gap-1">
              Supersede Document
              <IsoGuidance topic="supersede" />
            </div>
            <div className="text-xs text-slate-500 truncate">
              {doc.documentNumber || doc.title || doc.name}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-slate-700">
            <p>
              Marks this drawing as <b>Superseded</b> — no longer the authoritative document. This is for retirement
              or splits (e.g. P-101 is replaced by P-101A and P-101B). For a new revision of the same drawing,
              use <b>Publish New Revision</b> instead.
            </p>
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Reason *</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-2 focus:outline-amber-500 resize-y"
              placeholder="e.g. P-101 has been split into north (P-101A) and south (P-101B) loops to reflect 2026 expansion. Original P-101 retired."
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">
              Replacement Document Numbers
            </label>
            <div className="text-[10px] text-slate-500 mt-0.5">
              Optional. Add by document number — they must already exist in this library.
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <input
                value={replacementInput}
                onChange={(e) => setReplacementInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addReplacement(); } }}
                className="flex-1 px-2.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-2 focus:outline-amber-500"
                placeholder="P-101A"
              />
              <button
                onClick={addReplacement}
                disabled={!replacementInput.trim()}
                className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            {replacements.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {replacements.map((r) => (
                  <div key={r} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-50 border border-amber-200 text-xs font-mono text-amber-800">
                    {r}
                    <button
                      onClick={() => removeReplacement(r)}
                      className="ml-0.5 text-amber-600 hover:text-red-600"
                      title="Remove"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {unresolved.length > 0 && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
                <b>Note:</b> these document numbers couldn&apos;t be found in this library and were skipped:&nbsp;
                <span className="font-mono">{unresolved.join(", ")}</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">MOC Reference</label>
            <input
              value={mocRef}
              onChange={(e) => setMocRef(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-2 focus:outline-amber-500"
              placeholder="MOC-2026-0142 (optional)"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
            {busy ? "Saving…" : "Supersede Document"}
          </button>
        </div>
      </div>
    </div>
  );
}
