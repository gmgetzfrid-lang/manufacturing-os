"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import type { LibraryDeleteImpact } from "@/lib/libraryDeleteImpact";

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  libraryName: string;
  isLoading: boolean;
  /** ALOG-3: what the cascade removes, counted on the server before the
   *  delete. null while it is being counted (or when it could not be). */
  impact?: LibraryDeleteImpact | null;
  /** Why the counts could not be read — the delete is refused until they can. */
  impactError?: string | null;
  onRetryImpact?: () => void;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function DeleteSafetyModal(props: DeleteModalProps) {
  // The body unmounts whenever the modal is closed, so each reopen is already a
  // fresh mount with reset state — no synthetic remount key needed.
  if (!props.isOpen) return null;
  return <DeleteSafetyModalBody {...props} />;
}

function DeleteSafetyModalBody({
  onClose,
  onConfirm,
  libraryName,
  isLoading,
  impact = null,
  impactError = null,
  onRetryImpact,
}: DeleteModalProps) {
  const [confirmText, setConfirmText] = useState("");
  const isMatch = confirmText === libraryName;
  // ALOG-3: the person confirms what is deleted — no counts, no confirm.
  const countsKnown = !!impact && !impactError;

  return (
    <div className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center overflow-y-auto p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--color-surface)] w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border-2 border-red-100">
        <div className="px-6 py-4 bg-red-50 border-b border-red-100 flex items-center justify-between">
          <h3 className="text-lg font-bold text-red-900 flex items-center">
            <AlertTriangle className="w-5 h-5 mr-2 text-red-600" />
            Delete Library?
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-red-100 text-red-400 hover:text-red-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
            This action is <span className="font-bold text-red-600">irreversible</span>. Deleting
            the <strong>{libraryName}</strong> library also deletes everything the database holds
            under it — the delete cascades. These records are not orphaned; they are gone:
          </p>

          {impactError ? (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
              <p>Couldn&apos;t count what this deletion would remove ({impactError}). The library can&apos;t be deleted until the counts can be read.</p>
              {onRetryImpact && (
                <button type="button" onClick={onRetryImpact} className="font-bold underline">Count again</button>
              )}
            </div>
          ) : !impact ? (
            <p className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Counting what this deletion removes…
            </p>
          ) : (
            <div className="space-y-2">
              <ul data-testid="library-delete-impact" className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-sm text-red-900 space-y-0.5 list-disc pl-6">
                <li>{plural(impact.documents, "document record", "document records")}</li>
                <li>{plural(impact.revisions, "revision", "revisions")} of those documents</li>
                <li>{plural(impact.folders, "folder", "folders")}</li>
                {impact.openHolds > 0 && <li>{plural(impact.openHolds, "open hold", "open holds")} (stop-work signals) on those documents</li>}
              </ul>
              {impact.legalHolds > 0 && (
                <p className="text-xs font-bold text-red-700">
                  {plural(impact.legalHolds, "document is", "documents are")} under legal hold — the database will refuse this delete until the hold is released.
                </p>
              )}
              {impact.requests > 0 && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {plural(impact.requests, "request was", "requests were")} raised from these documents. The requests are kept, but they will point at documents that no longer exist.
                </p>
              )}
              <p className="text-xs text-[var(--color-text-muted)]">
                The stored files are not deleted with the records: they stay in storage with nothing pointing at them. The deletion and these counts are recorded in the audit log.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
              Type{" "}
              <span className="select-all font-mono text-[var(--color-text)] bg-[var(--color-surface-2)] px-1 py-0.5 rounded border border-[var(--color-border)]">
                {libraryName}
              </span>{" "}
              to confirm:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full p-3 border border-[var(--color-border-strong)] rounded-lg text-sm font-bold focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all placeholder:font-normal"
              placeholder="Type library name here..."
              autoFocus
            />
          </div>
        </div>

        <div className="px-6 py-4 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] border border-transparent hover:border-[var(--color-border)] rounded-lg transition-all"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!isMatch || isLoading || !countsKnown}
            className="px-4 py-2 bg-red-600 text-white text-sm font-bold rounded-lg shadow-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-2" />
            )}
            I understand, delete this library
          </button>
        </div>
      </div>
    </div>
  );
}
