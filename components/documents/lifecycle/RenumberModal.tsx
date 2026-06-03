"use client";

// RenumberModal — change documents.document_number with audit.
// Single-step form. No file upload, no revision change.

import React, { useState } from "react";
import { X, Hash, Loader2, AlertTriangle, Check } from "lucide-react";
import { renumberDocument } from "@/lib/documentLifecycle";
import type { DocumentRecord } from "@/types/schema";

interface RenumberModalProps {
  doc: DocumentRecord;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onCancel: () => void;
  onSuccess: () => void;
}

export default function RenumberModal(props: RenumberModalProps) {
  const { doc, orgId, actorUserId, actorEmail, actorRole, onCancel, onSuccess } = props;
  const [newNumber, setNewNumber] = useState(doc.documentNumber ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = newNumber.trim().length > 0
    && newNumber.trim() !== (doc.documentNumber ?? "")
    && reason.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await renumberDocument({
        doc, newDocumentNumber: newNumber, reason,
        orgId, actorUserId, actorEmail, actorRole,
      });
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <Hash className="w-5 h-5 text-slate-600" />
            <div>
              <h2 className="font-black text-slate-900">Renumber Document</h2>
              <div className="text-[11px] text-slate-500 mt-0.5">Existing revisions and history are preserved.</div>
            </div>
          </div>
          <button type="button" onClick={onCancel} className="p-1.5 rounded hover:bg-slate-200 text-slate-500">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <div className="text-xs text-slate-600">
            Cross-references inside other drawings (callouts like &ldquo;see Sheet 3&rdquo;) won&apos;t auto-update.
            Those live in the PDF content.
          </div>

          <label className="block">
            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Current number</span>
            <div className="mt-1 px-2.5 py-1.5 text-sm font-mono bg-slate-100 border border-slate-200 rounded text-slate-700">
              {doc.documentNumber || "(none)"}
            </div>
          </label>

          <label className="block">
            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">New number *</span>
            <input
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              className="mt-1 w-full text-sm font-mono border border-slate-300 rounded px-2.5 py-1.5"
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Reason *</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder='e.g. "Scheme migration from P-001 to P-101 series."'
              className="mt-1 w-full text-sm border border-slate-300 rounded px-2.5 py-1.5"
            />
          </label>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5">Cancel</button>
          <button type="submit" disabled={!valid || busy} className="inline-flex items-center gap-1.5 text-sm font-bold bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Renumber
          </button>
        </div>
      </form>
    </div>
  );
}
