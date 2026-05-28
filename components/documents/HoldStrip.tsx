"use client";

// HoldStrip — inspector-panel strip showing active holds on a
// document and the controls to open/release them.
//
// Design choices:
//   - One-click for the four predefined reasons (matches the
//     directive's "one-click hold states" requirement).
//   - "Other" reveals a free-text input + Submit; deliberately
//     two-click so an arbitrary string isn't created accidentally.
//   - Release uses an inline confirm (small textarea optional)
//     rather than a modal — the directive says "lightweight
//     interactions" and "avoid excessive forms."
//   - Stale indicator: when an active hold has gone past its
//     expected_release_at, the duration label switches to red and
//     prefixes with "+Nd late" — the directive's "schedule
//     variance visibility" in its lightest form.

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertOctagon, Plus, X, Loader2, Clock, AlertTriangle, Lock, Check,
} from "lucide-react";
import {
  listActiveHoldsForDocument, openHold, releaseHold,
  PREDEFINED_HOLD_REASONS,
} from "@/lib/holds";
import type { DocumentHold } from "@/types/schema";
import HelpTooltip from "@/components/ui/HelpTooltip";
import IsoGuidance from "@/components/ui/IsoGuidance";

const REASON_HELP: Record<string, string> = {
  "Awaiting Engineering":      "Drafting can't advance until an engineer signs off on a design decision.",
  "Field Verification Needed": "Drawing reflects assumed conditions — someone needs to walk down the unit and confirm.",
  "Missing Vendor Data":       "Waiting on a datasheet, drawing, or spec from a vendor or contractor.",
  "Client Review":             "Drawing is in the client's hands; can't proceed until they return comments or approval.",
};

interface HoldStripProps {
  documentId: string;
  orgId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  /** When false, the strip renders read-only (no open/release buttons).
   *  Defaults true — callers gate on app-level role checks. */
  canEdit?: boolean;
  /** Bump from outside to force a refresh (e.g. after a parent action
   *  that may have closed a hold via a different code path). */
  refreshKey?: number;
  /** Called after a successful open or release, so the parent can
   *  refresh related views (timeline, version history, etc.). */
  onChange?: () => void;
}

export default function HoldStrip({
  documentId, orgId, userId, userName, userEmail, userRole,
  canEdit = true, refreshKey, onChange,
}: HoldStripProps) {
  const [holds, setHolds] = useState<DocumentHold[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [otherDraft, setOtherDraft] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseReasonDraft, setReleaseReasonDraft] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listActiveHoldsForDocument(documentId);
      setHolds(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [documentId]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const onOpen = async (reason: string) => {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openHold({
        orgId, documentId,
        reason: reason.trim(),
        openedBy: userId,
        openedByName: userName,
        openedByEmail: userEmail,
        openedByRole: userRole,
      });
      setOtherDraft(null);
      await refresh();
      onChange?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onRelease = async (holdId: string) => {
    setBusy(true);
    setError(null);
    try {
      await releaseHold({
        holdId,
        releasedBy: userId,
        releasedByName: userName,
        releasedByEmail: userEmail,
        releasedByRole: userRole,
        releasedReason: releaseReasonDraft.trim() || undefined,
      });
      setReleasingId(null);
      setReleaseReasonDraft("");
      await refresh();
      onChange?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const heldReasons = new Set(holds.map((h) => h.reason));

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <AlertOctagon className="w-3 h-3" /> Holds
          <HelpTooltip>
            A <b>hold</b> is an explicit block on this document — it can&apos;t be advanced until cleared. Multiple holds can be active at once. Duration is tracked automatically.
          </HelpTooltip>
          <IsoGuidance topic="hold" />
        </span>
        {holds.length > 0 && (
          <span className={`text-[10px] font-mono ${holds.length > 0 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-slate-500 bg-slate-50 border-slate-200"} border px-1.5 py-0.5 rounded`}>
            {holds.length} active
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {error}
        </div>
      ) : holds.length === 0 ? (
        <div className="text-xs text-slate-500 italic">No active holds.</div>
      ) : (
        <div className="space-y-2">
          {holds.map((h) => <ActiveHoldRow
            key={h.id}
            hold={h}
            canEdit={canEdit}
            isReleasing={releasingId === h.id}
            onStartRelease={() => { setReleasingId(h.id!); setReleaseReasonDraft(""); }}
            onCancelRelease={() => { setReleasingId(null); setReleaseReasonDraft(""); }}
            onConfirmRelease={() => onRelease(h.id!)}
            releaseReasonDraft={releaseReasonDraft}
            setReleaseReasonDraft={setReleaseReasonDraft}
            busy={busy}
          />)}
        </div>
      )}

      {canEdit && (
        <div className="pt-1 border-t border-slate-100 space-y-2">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Place hold</div>
          <div className="flex flex-wrap gap-1.5">
            {PREDEFINED_HOLD_REASONS.map((r) => (
              <span key={r} className="inline-flex items-center gap-0.5">
                <button
                  onClick={() => onOpen(r)}
                  disabled={busy || heldReasons.has(r)}
                  title={heldReasons.has(r) ? "Already on hold for this reason" : `Place hold: ${r}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="w-3 h-3" /> {r}
                </button>
                {REASON_HELP[r] && <HelpTooltip>{REASON_HELP[r]}</HelpTooltip>}
              </span>
            ))}
            <button
              onClick={() => setOtherDraft(otherDraft === null ? "" : null)}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200"
            >
              <Plus className="w-3 h-3" /> Other…
            </button>
          </div>

          {otherDraft !== null && (
            <div className="flex items-center gap-1.5 mt-1">
              <input
                value={otherDraft}
                onChange={(e) => setOtherDraft(e.target.value)}
                placeholder="Custom hold reason"
                className="flex-1 text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-500"
                autoFocus
              />
              <button
                onClick={() => otherDraft && onOpen(otherDraft)}
                disabled={!otherDraft?.trim() || busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40"
              >
                <Check className="w-3 h-3" /> Add
              </button>
              <button
                onClick={() => setOtherDraft(null)}
                disabled={busy}
                className="p-1 rounded text-slate-500 hover:bg-slate-100"
              ><X className="w-3 h-3" /></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Per-active-hold row ───────────────────────────────────────

function ActiveHoldRow({
  hold, canEdit, isReleasing, onStartRelease, onCancelRelease, onConfirmRelease,
  releaseReasonDraft, setReleaseReasonDraft, busy,
}: {
  hold: DocumentHold;
  canEdit: boolean;
  isReleasing: boolean;
  onStartRelease: () => void;
  onCancelRelease: () => void;
  onConfirmRelease: () => void;
  releaseReasonDraft: string;
  setReleaseReasonDraft: (v: string) => void;
  busy: boolean;
}) {
  // Capture "now" once per mount so render stays pure (React 19
  // strict). The hold age is informational; if the user wants a
  // fresh value, they refresh the panel.
  const [nowMs] = useState<number>(() => Date.now());
  const openedAtMs = new Date(hold.openedAt as string).getTime();
  const ageDays = Math.max(0, Math.round((nowMs - openedAtMs) / 86400_000));
  const expectedMs = hold.expectedReleaseAt ? new Date(hold.expectedReleaseAt as string).getTime() : null;
  const isLate = expectedMs !== null && nowMs > expectedMs;
  const lateDays = isLate ? Math.round((nowMs - (expectedMs as number)) / 86400_000) : 0;

  return (
    <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3 text-amber-700 shrink-0" />
            <span className="text-xs font-bold text-amber-900">{hold.reason}</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-600 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {ageDays === 0 ? "today" : `${ageDays}d`}
              {isLate && <span className="ml-1 font-bold text-red-700">(+{lateDays}d late)</span>}
            </span>
            {hold.openedByName && <span>by {hold.openedByName}</span>}
          </div>
          {hold.notes && (
            <div className="mt-1 text-[11px] text-slate-700 whitespace-pre-wrap">{hold.notes}</div>
          )}
        </div>
        {canEdit && !isReleasing && (
          <button
            onClick={onStartRelease}
            disabled={busy}
            className="shrink-0 text-[10px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-1.5 py-1 rounded inline-flex items-center gap-1 disabled:opacity-40"
          >
            <Check className="w-3 h-3" /> Release
          </button>
        )}
      </div>

      {isReleasing && (
        <div className="mt-2 flex items-center gap-1.5 pt-2 border-t border-amber-100">
          <input
            value={releaseReasonDraft}
            onChange={(e) => setReleaseReasonDraft(e.target.value)}
            placeholder="Resolution (optional)"
            className="flex-1 text-[11px] border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            autoFocus
          />
          <button
            onClick={onConfirmRelease}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40"
          >
            <Check className="w-3 h-3" /> Release
          </button>
          <button
            onClick={onCancelRelease}
            disabled={busy}
            className="p-1 rounded text-slate-500 hover:bg-slate-100"
          ><X className="w-3 h-3" /></button>
        </div>
      )}
    </div>
  );
}
