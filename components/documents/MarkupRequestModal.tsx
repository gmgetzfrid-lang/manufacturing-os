"use client";

// MarkupRequestModal — composer for "can I see your markups on this?"
// Opened from the Inspector / viewer when a doc is checked out by someone
// other than the current user. Posts to the project activity feed and to
// markup_requests so the owner can respond publicly.

import React, { useState } from "react";
import { X, MessageSquare, Loader2, AlertTriangle, Send } from "lucide-react";
import { createMarkupRequest } from "@/lib/markupRequests";
import type { DocumentRecord } from "@/types/schema";

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
  const [message, setMessage] = useState("");
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
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <MessageSquare className="w-5 h-5 text-purple-700" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-black text-slate-900">Request markups</div>
            <div className="text-xs text-slate-500 truncate">
              {document.documentNumber || document.title || document.name} — from <b>{holderUserName || "the current checkout holder"}</b>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-900">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-slate-600">
            Your request will be visible on the project feed{projectId ? "" : " (this is an ad-hoc checkout, so it will only be visible to you and the holder)"}.
            The holder can decline, share their current markup PDF, or upload a stamped copy in response.
          </p>
          <div>
            <label className="text-[10px] font-black text-slate-700 uppercase tracking-widest">Message *</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm resize-y focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:outline-none"
              placeholder="e.g. Working on the discharge piping for the same project — could you share your markups on PSV-201 so we don't conflict?"
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {busy ? "Sending…" : "Send Request"}
          </button>
        </div>
      </div>
    </div>
  );
}
