"use client";

// ArchiveConfirmModal — soft-delete a document. Records actor + reason on
// the documents row and writes an ARCHIVE_DOC audit entry. Archived rows
// are hidden from the default library list but recoverable by admins.

import React, { useState } from "react";
import { X, Archive, AlertTriangle, Loader2, ArchiveRestore } from "lucide-react";
import { archiveDocument, unarchiveDocument } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";

interface ArchiveConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  /** True if the doc is already archived and we're un-archiving. */
  mode: "archive" | "unarchive";
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess: () => void;
}

export default function ArchiveConfirmModal({
  isOpen, onClose, doc, mode,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: ArchiveConfirmModalProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isArchive = mode === "archive";

  const submit = async () => {
    if (isArchive && !reason.trim()) return setError("Reason is required when archiving.");
    setBusy(true); setError(null);
    try {
      if (isArchive) {
        await archiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole });
      } else {
        await unarchiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole });
      }
      onSuccess();
      setReason("");
      onClose();
    } catch (e) {
      setError((e as Error).message || `Failed to ${mode}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/70 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className={`p-2 ${isArchive ? "bg-slate-100" : "bg-emerald-100"} rounded-lg`}>
            {isArchive
              ? <Archive className="w-5 h-5 text-slate-700" />
              : <ArchiveRestore className="w-5 h-5 text-emerald-700" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-slate-900">
              {isArchive ? "Archive Document" : "Restore from Archive"}
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
            {isArchive ? (
              <p>
                The document and its entire revision history will be hidden from the default library view.
                Nothing is deleted — admins can restore it any time. The action is logged.
              </p>
            ) : (
              <p>
                The document will be returned to <b>Issued</b> status and visible in the library list again.
              </p>
            )}
          </div>

          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">
              {isArchive ? "Reason *" : "Note"}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2.5 py-2 border border-slate-300 rounded-lg text-sm focus:outline-2 focus:outline-slate-700 resize-y"
              placeholder={isArchive
                ? "e.g. Equipment removed during 2026 turnaround. Drawing no longer applicable."
                : "Optional note for the audit log"}
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
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-60 ${
              isArchive ? "bg-slate-700 hover:bg-slate-800" : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (isArchive ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />)}
            {busy ? "Saving…" : (isArchive ? "Archive Document" : "Restore Document")}
          </button>
        </div>
      </div>
    </div>
  );
}
