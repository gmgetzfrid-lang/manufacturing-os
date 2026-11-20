"use client";

// MarkupRequestModal — composer for "can I see your markups on this?"
// Opened from the Inspector / viewer when a doc is checked out by someone
// other than the current user. Posts to the project activity feed and to
// markup_requests so the owner can respond publicly.

import React, { useState } from "react";
import { X, MessageSquare, Loader2, AlertTriangle, Send } from "lucide-react";
import { createMarkupRequest } from "@/lib/markupRequests";
import type { DocumentRecord } from "@/types/schema";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { useDraft } from "@/hooks/useDraft";

interface MarkupRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentRecord;
  // Identity of the user who holds the checkout (the recipient of the request)
  holderUserId: string;
  holderUserName?: string;
  // Optional project context if the checkout is tied to one
  projectId?: string;
  checkoutSessionId?: string;
  orgId: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
  onSuccess?: () => void;
}

export default function MarkupRequestModal({
  isOpen, onClose, document, holderUserId, holderUserName,
  projectId, checkoutSessionId, orgId,
  actorUserId, actorEmail, actorRole, onSuccess,
}: MarkupRequestModalProps) {
  // Escape closes this dialog (only the top one when they stack).
  useEscapeClose(() => onClose(), isOpen);
  const [message, setMessage] = useState("");
  // Typed words are kept on this device until this goes through.
  useDraft<string>(isOpen && document.id ? `markup-req:${document.id}` : null, message, setMessage, (v) => !v.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const submit = async () => {
    if (!message.trim()) return setError("Please add a short message");
    setBusy(true); setError(null);
    try {
      await createMarkupRequest({
        orgId,
        documentId: document.id!,
        checkoutSessionId,
        projectId,
        requestedFromUserId: holderUserId,
        requestedFromName: holderUserName,
        message,
        actorUserId,
        actorEmail,
        actorRole,
      });
      setMessage("");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-lg shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-[var(--color-surface-2)] rounded-lg">
            <MessageSquare className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-[var(--color-text)]">Request markups</div>
            <div className="text-[13px] text-[var(--color-text-muted)] truncate">
              {document.documentNumber || document.title || document.name} - from <b>{holderUserName || "the current checkout holder"}</b>
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            Your request will be visible on the project feed{projectId ? "" : " (this is an ad-hoc checkout, so it will only be visible to you and the holder)"}.
            The holder can decline, share their current markup PDF, or upload a stamped copy in response.
          </p>
          <div>
            <label className="text-[13px] font-semibold text-[var(--color-text)] ">Message *</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none"
              placeholder="e.g. Working on the discharge piping for the same project, could you share your markups on PSV-201 so we don't conflict?"
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 text-[13px] border-l-2 border-[var(--state-overdue)] pl-3 text-[var(--state-overdue)]">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-[13px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {busy ? "Sending…" : "Send Request"}
          </button>
        </div>
      </div>
    </div>
  );
}
