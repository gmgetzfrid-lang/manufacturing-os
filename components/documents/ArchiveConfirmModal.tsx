"use client";

// ArchiveConfirmModal — soft-delete a document. Records actor + reason on
// the documents row and writes an ARCHIVE_DOC audit entry. Archived rows
// are hidden from the default library list but recoverable by admins.
//
// REV-18 (P13 second review fix): the un-archive asks what the document
// comes back as (UNARCHIVE_RESTORE_STATUSES). Restoring to Issued is a
// controlled issue the database decides (20261144): a Draft archived after
// that migration comes back a Draft by default, and a refused restore to
// Issued says the Draft restore is still open — never a dead end.

import React, { useEffect, useState } from "react";
import { X, Archive, AlertTriangle, Loader2, ArchiveRestore } from "lucide-react";
import {
  archiveDocument, unarchiveDocument, unarchiveRestoreDefault, UNARCHIVE_RESTORE_STATUSES,
} from "@/lib/revisions";
import { isIssueRefusal } from "@/lib/issueStatus";
import type { DocumentRecord } from "@/types/schema";

type RestoreStatus = (typeof UNARCHIVE_RESTORE_STATUSES)[number];

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
  /** Called after the write landed; an un-archive passes the status the
   *  document was restored to. */
  onSuccess: (restoredStatus?: string) => void;
}

export default function ArchiveConfirmModal({
  isOpen, onClose, doc, mode,
  orgId, actorUserId, actorEmail, actorRole, onSuccess,
}: ArchiveConfirmModalProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // REV-18: what an un-archive restores to, defaulted from what the document
  // WAS (unarchiveRestoreDefault reads the guard's retirement stamp).
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>("Draft");
  const [basis, setBasis] = useState<"loading" | "issued" | "not-issued" | "unknown">("loading");

  useEffect(() => {
    if (!isOpen || mode !== "unarchive") return;
    let alive = true;
    setBasis("loading");
    (async () => {
      const d = doc.id
        ? await unarchiveRestoreDefault(doc.id).catch(() => ({ status: "Draft" as RestoreStatus, basis: "unknown" as const }))
        : { status: "Draft" as RestoreStatus, basis: "unknown" as const };
      if (alive) { setRestoreStatus(d.status); setBasis(d.basis); }
    })();
    return () => { alive = false; };
  }, [isOpen, mode, doc.id]);

  if (!isOpen) return null;

  const isArchive = mode === "archive";

  const submit = async () => {
    if (isArchive && !reason.trim()) return setError("Reason is required when archiving.");
    setBusy(true); setError(null);
    try {
      if (isArchive) {
        await archiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole });
        onSuccess();
      } else {
        await unarchiveDocument({ doc, reason, orgId, actorUserId, actorEmail, actorRole, restoreStatus });
        onSuccess(restoreStatus);
      }
      setReason("");
      onClose();
    } catch (e) {
      const message = (e as Error).message || `Failed to ${mode}`;
      // REV-18: a refused restore to Issued is the issue rule — the Draft
      // restore is still open (then submit the revision for review).
      setError(!isArchive && restoreStatus === "Issued" && isIssueRefusal(message)
        ? `${message} Nothing was restored. You can restore it as a Draft instead (choose Draft above), then submit its revision for review.`
        : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className={`p-2 ${isArchive ? "bg-[var(--color-surface-2)]" : "bg-emerald-100"} rounded-lg`}>
            {isArchive
              ? <Archive className="w-5 h-5 text-[var(--color-text)]" />
              : <ArchiveRestore className="w-5 h-5 text-emerald-700" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-black text-[var(--color-text)]">
              {isArchive ? "Archive Document" : "Restore from Archive"}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] truncate">
              {doc.documentNumber || doc.title || doc.name}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-[var(--color-text)]">
            {isArchive ? (
              <p>
                The document and its entire revision history will be hidden from the default library view.
                Nothing is deleted — admins can restore it any time. The action is logged.
              </p>
            ) : (
              <div className="space-y-2">
                <p>
                  The document will be returned to <b>{restoreStatus}</b> status and visible in the library list again.
                </p>
                <label className="block">
                  <span className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Restore as</span>
                  <select
                    aria-label="Restore as"
                    value={restoreStatus}
                    onChange={(e) => setRestoreStatus(e.target.value as RestoreStatus)}
                    disabled={busy || basis === "loading"}
                    className="mt-1 w-full px-2.5 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]"
                  >
                    {UNARCHIVE_RESTORE_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                </label>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {basis === "loading" && "Checking what it was before it was archived…"}
                  {basis === "issued" && "It was issued when it was archived — restoring it as Issued puts that issue back."}
                  {basis === "not-issued" && "It was not issued when it was archived (a Draft or In Review), so it comes back as a Draft unless you choose otherwise."}
                  {basis === "unknown" && "What it was before it was archived isn't recorded, so it comes back as a Draft unless you choose otherwise."}
                </p>
                {restoreStatus === "Issued" && basis !== "issued" && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                    Restoring as <b>Issued</b> makes its current revision a controlled issue: in a library that requires
                    reviewer sign-off an unreviewed revision needs Document Control, and an active hold refuses it.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">
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
            disabled={busy || (!isArchive && basis === "loading")}
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
