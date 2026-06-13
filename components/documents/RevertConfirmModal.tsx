"use client";

// RevertConfirmModal — confirm rolling a document back to a previous revision.
// Revert is destructive in spirit (you're choosing not to use the current
// version), so we require a reason and surface the audit consequences.

import React, { useState } from "react";
import { X, RotateCcw, AlertTriangle, Loader2 } from "lucide-react";
import { revertToVersion } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

interface RevertConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: DocumentRecord;
  targetVersion: DocumentVersion;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess: (newVersion: DocumentVersion) => void;
}

export default function RevertConfirmModal({
  isOpen, onClose, doc, targetVersion,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: RevertConfirmModalProps) {
  const [reason, setReason] = useState("");
  const [mocRef, setMocRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const submit = async () => {
    if (!reason.trim()) return setError("Reason is required for a revert.");
    setBusy(true); setError(null);
    try {
      const newVersion = await revertToVersion({
        doc, targetVersion, reason, mocReference: mocRef,
        orgId, actorUserId, actorEmail, actorRole,
      });
      onSuccess(newVersion);
      setReason(""); setMocRef("");
      onClose();
    } catch (e) {
      setError((e as Error).message || "Revert failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <RotateCcw className="w-5 h-5 text-purple-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">Revert to Rev {targetVersion.revisionLabel}</div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name} — current is Rev {doc.rev}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-[var(--color-text)] space-y-2">
            <p>
              This will create a <b>new revision</b> on the document that copies the file payload from <b>Rev {targetVersion.revisionLabel}</b>.
              The current revision will be marked superseded but remain in the history.
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">
              Reverts never overwrite history — the audit chain stays intact and the action is logged with your reason.
            </p>
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Reason *</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none resize-y"
              placeholder="e.g. Rev 4 introduced incorrect orifice plate sizing on FE-201. Rolling back to Rev 3 per ops request."
            />
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">MOC Reference</label>
            <input
              value={mocRef}
              onChange={(e) => setMocRef(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none"
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

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            {busy ? "Reverting…" : "Confirm Revert"}
          </button>
        </div>
      </div>
    </div>
  );
}
