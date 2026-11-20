"use client";

// ArchiveConfirmModal — soft-delete a document. Records actor + reason on
// the documents row and writes an ARCHIVE_DOC audit entry. Archived rows
// are hidden from the default library list but recoverable by admins.

import React, { useState } from "react";
import { X, Archive, AlertTriangle, Loader2, ArchiveRestore } from "lucide-react";
import { archiveDocument, unarchiveDocument } from "@/lib/revisions";
import type { DocumentRecord } from "@/types/schema";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { useDraft } from "@/hooks/useDraft";

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
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose(), isOpen);
  const [reason, setReason] = useState("");
  // Typed words are kept on this device until this goes through.
  useDraft<string>(isOpen && doc.id ? `archive:${doc.id}:${mode}` : null, reason, setReason, (v) => !v.trim());
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
    <div className="fixed inset-0 z-[210] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className={`p-2 ${isArchive ? "bg-[var(--color-surface-2)]" : "bg-emerald-100"} rounded-lg`}>
            {isArchive
              ? <Archive className="w-5 h-5 text-[var(--color-text)]" />
              : <ArchiveRestore className="w-5 h-5 text-emerald-700" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">
              {isArchive ? "Archive Document" : "Restore from Archive"}
            </div>
            <div className="text-[13px] text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-[var(--color-text)]">
            {isArchive ? (
              <p>
                The document and its entire revision history will be hidden from the default library view.
                Nothing is deleted - admins can restore it any time. The action is logged.
              </p>
            ) : (
              <p>
                The document will be returned to <b>Issued</b> status and visible in the library list again.
              </p>
            )}
          </div>

          <div>
            <label className="text-[13px] font-semibold text-[var(--color-text)] ">
              {isArchive ? "Reason *" : "Note"}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none resize-y"
              placeholder={isArchive
                ? "e.g. Equipment removed during 2026 turnaround. Drawing no longer applicable."
                : "Optional note for the audit log"}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 text-[13px] border-l-2 border-rose-500 pl-3 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-[13px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold disabled:opacity-60 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)]"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : (isArchive ? <Archive className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />)}
            {busy ? "Saving…" : (isArchive ? "Archive Document" : "Restore Document")}
          </button>
        </div>
      </div>
    </div>
  );
}
