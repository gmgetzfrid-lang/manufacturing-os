"use client";

// HoldStrip — inspector-panel strip showing active holds on a
// document and the controls to open/release them.
//
// Design choices:
//   - One-click for the four predefined reasons (matches the
//     directive's "one-click hold states" requirement) — the click
//     opens an inline confirm row that asks for an OPTIONAL expected
//     release date (HLD-14) and places the hold on the second click.
//   - "Other" reveals a free-text input + Submit; deliberately
//     two-click so an arbitrary string isn't created accidentally.
//   - Release uses an inline confirm (a REQUIRED one-line reason,
//     HLD-10) rather than a modal — the directive says "lightweight
//     interactions" and "avoid excessive forms." A stop-work is lifted
//     for a stated reason; the database holds the same rule.
//   - Stale indicator: when an active hold has gone past the
//     expected_release_at the opener set in the picker, the duration
//     label switches to red and prefixes with "+Nd late". Holds with no
//     date never read late here; the maintenance cron's aging sweep
//     (lib/holds.ts scanStaleHolds) nudges the opener and the release
//     pool once a hold is past its date, or past HOLD_AGING_DAYS with
//     none — the directive's "schedule variance visibility".
//   - Who sees the controls is decided by the org's capability policy
//     (holds.open / holds.release — role tokens, the additive collection
//     and per-person grants) through lib/holds.ts holdControlsFor, never
//     a literal role list (HLD-8). `canEdit` is a caller-side hard OFF
//     (read-only contexts); it can hide controls, never grant them.

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertOctagon, Plus, X, Loader2, Clock, AlertTriangle, Lock, Check, Printer, CalendarClock,
} from "lucide-react";
import {
  listActiveHoldsForDocument, openHold, releaseHold, holdControlsFor, expectedReleaseIso,
  PREDEFINED_HOLD_REASONS, type HoldRecord,
} from "@/lib/holds";
import { loadCapabilityPolicy, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
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
  /** When false, the strip renders read-only (no open/release buttons)
   *  whatever the policy says. Defaults true. It never grants: the
   *  controls also need the org's holds.open / holds.release capability. */
  canEdit?: boolean;
  /** Bump from outside to force a refresh (e.g. after a parent action
   *  that may have closed a hold via a different code path). */
  refreshKey?: number;
  /** Called after a successful open or release, so the parent can
   *  refresh related views (timeline, version history, etc.). */
  onChange?: () => void;
}

/** Today as the date input's `min` (local date). */
function todayLocalIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function HoldStrip({
  documentId, orgId, userId, userName, userEmail, userRole,
  canEdit = true, refreshKey, onChange,
}: HoldStripProps) {
  const { roles: heldRoleCollection } = useRole();
  const [holds, setHolds] = useState<HoldRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [otherDraft, setOtherDraft] = useState<string | null>(null);
  /** A predefined reason awaiting its (optional) expected-release date. */
  const [pendingReason, setPendingReason] = useState<string | null>(null);
  const [expectedDraft, setExpectedDraft] = useState("");
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseReasonDraft, setReleaseReasonDraft] = useState("");
  const [policy, setPolicy] = useState<CapabilityPolicy | null>(null);

  // HLD-8: the controls follow the policy. Until it is read nothing is
  // offered (fail closed); a read error falls to the shipped defaults, the
  // same way every other policy consumer does — the database still enforces.
  useEffect(() => {
    let alive = true;
    void loadCapabilityPolicy(orgId)
      .then((p) => { if (alive) setPolicy(p); })
      .catch(() => { if (alive) setPolicy({}); });
    return () => { alive = false; };
  }, [orgId]);
  const { canOpen, canRelease } = policy
    ? holdControlsFor(policy, userRole, heldRoleCollection, userId)
    : { canOpen: false, canRelease: false };
  const showOpen = canEdit && canOpen;
  const showRelease = canEdit && canRelease;

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

  const onOpen = async (reason: string, expectedDate?: string) => {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await openHold({
        orgId, documentId,
        reason: reason.trim(),
        expectedReleaseAt: expectedReleaseIso(expectedDate),
        openedBy: userId,
        openedByName: userName,
        openedByEmail: userEmail,
        openedByRole: userRole,
      });
      setOtherDraft(null);
      setPendingReason(null);
      setExpectedDraft("");
      await refresh();
      onChange?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onRelease = async (holdId: string) => {
    const releasedReason = releaseReasonDraft.trim();
    if (!releasedReason) return;
    setBusy(true);
    setError(null);
    try {
      await releaseHold({
        holdId,
        releasedBy: userId,
        releasedByName: userName,
        releasedByEmail: userEmail,
        releasedByRole: userRole,
        releasedReason,
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
    <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-4 space-y-3">
      <div className="text-xs font-bold text-[var(--color-text-faint)] uppercase tracking-wider flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <AlertOctagon className="w-3 h-3" /> Holds
          <HelpTooltip>
            A <b>hold</b> is an explicit block on this document — it can&apos;t be advanced until cleared. Multiple holds can be active at once. Duration is tracked automatically.
          </HelpTooltip>
          <IsoGuidance topic="hold" />
        </span>
        {holds.length > 0 && (
          <span className={`text-[10px] font-mono ${holds.length > 0 ? "text-amber-700 bg-amber-50 border-amber-200" : "text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-[var(--color-border)]"} border px-1.5 py-0.5 rounded`}>
            {holds.length} active
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {error}
        </div>
      ) : holds.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] italic">No active holds.</div>
      ) : (
        <div className="space-y-2">
          {holds.map((h) => <ActiveHoldRow
            key={h.id}
            hold={h}
            canRelease={showRelease}
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

      {showOpen && (
        <div className="pt-1 border-t border-[var(--color-border)] space-y-2">
          <div className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-wider">Place hold</div>
          <div className="flex flex-wrap gap-1.5">
            {PREDEFINED_HOLD_REASONS.map((r) => (
              <span key={r} className="inline-flex items-center gap-0.5">
                <button
                  onClick={() => { setOtherDraft(null); setPendingReason(pendingReason === r ? null : r); setExpectedDraft(""); }}
                  disabled={busy || heldReasons.has(r)}
                  title={heldReasons.has(r) ? "Already on hold for this reason" : `Place hold: ${r}`}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    pendingReason === r
                      ? "bg-amber-600 text-white border-amber-700"
                      : "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200"
                  }`}
                >
                  <Plus className="w-3 h-3" /> {r}
                </button>
                {REASON_HELP[r] && <HelpTooltip>{REASON_HELP[r]}</HelpTooltip>}
              </span>
            ))}
            <button
              onClick={() => { setPendingReason(null); setExpectedDraft(""); setOtherDraft(otherDraft === null ? "" : null); }}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] transition-colors"
            >
              <Plus className="w-3 h-3" /> Other…
            </button>
          </div>

          {/* HLD-14: a predefined reason asks (optionally) when the hold is
              expected to clear, then places it. */}
          {pendingReason !== null && (
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[11px] font-bold text-amber-900">{pendingReason}</span>
              <label className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                <CalendarClock className="w-3 h-3" /> Expected release
                <input
                  type="date"
                  value={expectedDraft}
                  min={todayLocalIso()}
                  onChange={(e) => setExpectedDraft(e.target.value)}
                  aria-label="Expected release date (optional)"
                  className="text-[11px] border border-[var(--color-border-strong)] rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <span className="opacity-70">(optional)</span>
              </label>
              <button
                onClick={() => onOpen(pendingReason, expectedDraft)}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-40"
              >
                <Check className="w-3 h-3" /> Place hold
              </button>
              <button
                onClick={() => { setPendingReason(null); setExpectedDraft(""); }}
                disabled={busy}
                className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors"
              ><X className="w-3 h-3" /></button>
            </div>
          )}

          {otherDraft !== null && (
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <input
                value={otherDraft}
                onChange={(e) => setOtherDraft(e.target.value)}
                placeholder="Custom hold reason"
                className="flex-1 min-w-[10rem] text-xs border border-[var(--color-border-strong)] rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-amber-500"
                autoFocus
              />
              <input
                type="date"
                value={expectedDraft}
                min={todayLocalIso()}
                onChange={(e) => setExpectedDraft(e.target.value)}
                aria-label="Expected release date (optional)"
                title="Expected release (optional)"
                className="text-[11px] border border-[var(--color-border-strong)] rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <button
                onClick={() => otherDraft && onOpen(otherDraft, expectedDraft)}
                disabled={!otherDraft?.trim() || busy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-40"
              >
                <Check className="w-3 h-3" /> Add
              </button>
              <button
                onClick={() => { setOtherDraft(null); setExpectedDraft(""); }}
                disabled={busy}
                className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors"
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
  hold, canRelease, isReleasing, onStartRelease, onCancelRelease, onConfirmRelease,
  releaseReasonDraft, setReleaseReasonDraft, busy,
}: {
  hold: HoldRecord;
  canRelease: boolean;
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

  // Print the physical HOLD card. Auto-assembles from the hold + document —
  // zero inputs to fill. HLD-7: the card carries the rev the hold was placed
  // against (held at open time by the database) — the document's current rev
  // only when the hold predates that record.
  const printCard = async () => {
    try {
      const { data } = await supabase
        .from("documents")
        .select("document_number, title, name, rev")
        .eq("id", hold.documentId)
        .maybeSingle();
      const d = data as Record<string, unknown> | null;
      const { printHoldCard } = await import("@/lib/physicalBridge");
      await printHoldCard({
        holdId: hold.id!,
        docLabel: String(d?.document_number || d?.title || d?.name || "Document"),
        docRev: hold.heldRevLabel ?? ((d?.rev as string | null) ?? null),
        reason: hold.reason,
        notes: hold.notes ?? null,
        openedByName: hold.openedByName ?? null,
        openedAt: String(hold.openedAt),
      });
    } catch (e) {
      console.error("Hold card print failed", e);
    }
  };

  const openedAtMs = new Date(hold.openedAt as string).getTime();
  const ageDays = Math.max(0, Math.round((nowMs - openedAtMs) / 86400_000));
  const expectedMs = hold.expectedReleaseAt ? new Date(hold.expectedReleaseAt as string).getTime() : null;
  const isLate = expectedMs !== null && nowMs > expectedMs;
  const lateDays = isLate ? Math.round((nowMs - (expectedMs as number)) / 86400_000) : 0;
  const releaseReady = releaseReasonDraft.trim().length > 0;

  return (
    <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3 text-amber-700 shrink-0" />
            <span className="text-xs font-bold text-amber-900">{hold.reason}</span>
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {ageDays === 0 ? "today" : `${ageDays}d`}
              {isLate && <span className="ml-1 font-bold text-red-700">(+{lateDays}d late)</span>}
            </span>
            {hold.openedByName && <span>by {hold.openedByName}</span>}
            {hold.heldRevLabel && <span className="font-mono">at Rev {hold.heldRevLabel}</span>}
            {expectedMs !== null && !isLate && (
              <span className="inline-flex items-center gap-0.5"><CalendarClock className="w-2.5 h-2.5" /> expected {new Date(expectedMs).toLocaleDateString()}</span>
            )}
          </div>
          {hold.notes && (
            <div className="mt-1 text-[11px] text-[var(--color-text)] whitespace-pre-wrap">{hold.notes}</div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {/* Print the physical red tag — its QR answers "still active?"
              live, so stale paper tags stop lying. */}
          <button
            onClick={() => void printCard()}
            disabled={busy}
            title="Print a HOLD card for the field — scanning its QR shows whether this hold is still active"
            className="text-[10px] font-bold text-red-700 hover:text-red-800 bg-red-50 hover:bg-red-100 border border-red-200 px-1.5 py-1 rounded inline-flex items-center gap-1 transition-colors disabled:opacity-40"
          >
            <Printer className="w-3 h-3" /> Card
          </button>
          {canRelease && !isReleasing && (
            <button
              onClick={onStartRelease}
              disabled={busy}
              className="text-[10px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-1.5 py-1 rounded inline-flex items-center gap-1 transition-colors disabled:opacity-40"
            >
              <Check className="w-3 h-3" /> Release
            </button>
          )}
        </div>
      </div>

      {isReleasing && (
        <div className="mt-2 flex items-center gap-1.5 pt-2 border-t border-amber-100">
          <input
            value={releaseReasonDraft}
            onChange={(e) => setReleaseReasonDraft(e.target.value)}
            placeholder="Why is this hold being released? (required)"
            aria-label="Release reason (required)"
            className="flex-1 text-[11px] border border-[var(--color-border-strong)] rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            autoFocus
          />
          <button
            onClick={onConfirmRelease}
            disabled={busy || !releaseReady}
            title={releaseReady ? "Release this hold" : "State why the hold is being released"}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-40"
          >
            <Check className="w-3 h-3" /> Release
          </button>
          <button
            onClick={onCancelRelease}
            disabled={busy}
            className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors"
          ><X className="w-3 h-3" /></button>
        </div>
      )}
    </div>
  );
}
