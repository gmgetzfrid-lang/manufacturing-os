"use client";

// DistributionRecall — "who is holding a copy of this drawing, and is it
// still current?" Built entirely from download history the system already
// keeps. One-line summary; expands to the holder list; one click nudges
// everyone with an outdated copy.
//
// DIST-10: a recall is ON THE RECORD — it writes the document's audit trail
// (inside nudgeStaleHolders) and opens one confirmable distribution-ack row
// per outdated holder on the CURRENT version, so "recall sent, 3 of 8
// confirmed" survives remount and is visible to the next controller. The
// close-out ("I have this revision") is the recall acknowledgment.
// DIST-11: the holder list says when it is PARTIAL instead of asserting
// completeness over a truncated slice.

import React, { useCallback, useEffect, useState } from "react";
import { FileDown, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, BellRing, Loader2, Clock } from "lucide-react";
import { getDocumentRecall, nudgeStaleHolders, type RecallHolder } from "@/lib/staleCopies";
import { listAcksForVersion, requestAcks, type DistributionAck } from "@/lib/distributionAcks";

interface DistributionRecallProps {
  documentId: string;
  orgId: string;
  libraryId?: string | null;
  docLabel: string;
  currentRev: string | null;
  currentVersionId: string | null;
  currentUserId: string;
  currentUserName?: string | null;
}

export default function DistributionRecall({
  documentId, orgId, libraryId, docLabel, currentRev, currentVersionId,
  currentUserId, currentUserName,
}: DistributionRecallProps) {
  const [holders, setHolders] = useState<RecallHolder[]>([]);
  const [capped, setCapped] = useState(false);
  const [acks, setAcks] = useState<DistributionAck[]>([]);
  const [open, setOpen] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [nudgedCount, setNudgedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [recall, ackRows] = await Promise.all([
      getDocumentRecall(documentId, currentVersionId),
      currentVersionId ? listAcksForVersion(currentVersionId) : Promise.resolve([]),
    ]);
    setHolders(recall.holders);
    setCapped(recall.capped);
    setAcks(ackRows);
  }, [documentId, currentVersionId]);

  useEffect(() => {
    let alive = true;
    // All state mutations inside the async IIFE so render stays pure.
    (async () => {
      setHolders([]);
      setCapped(false);
      setAcks([]);
      setNudgedCount(null);
      setError(null);
      setOpen(false);
      if (alive) await load();
    })();
    return () => { alive = false; };
  }, [load]);

  if (holders.length === 0) return null;
  const outdated = holders.filter((h) => !h.hasCurrent);
  const ackByUid = new Map(acks.map((a) => [a.recipientUserId, a]));
  // The durable recall state: outdated holders who already carry an ack row
  // for the CURRENT version were recalled (by anyone, any session).
  const recalled = outdated.filter((h) => ackByUid.has(h.userId));
  const recallOutstanding = recalled.length > 0;
  const recallConfirmed = recalled.filter((h) => ackByUid.get(h.userId)?.acknowledgedAt).length;
  const earliestRecallAt = recalled
    .map((h) => ackByUid.get(h.userId)!.requestedAt)
    .sort()[0];

  const handleNudge = async () => {
    setNudging(true);
    setError(null);
    try {
      const n = await nudgeStaleHolders({
        orgId, documentId, libraryId, docLabel, currentRev, currentVersionId,
        holders, actorUserId: currentUserId, actorName: currentUserName,
        source: "manual",
      });
      // DIST-10: the close-out — one confirmable row per outdated holder on
      // the current version (silent: the nudge above IS the notification).
      // Re-sending reminds without resetting anyone's overdue clock (DIST-12).
      if (currentVersionId && outdated.length > 0) {
        await requestAcks({
          orgId, documentId, libraryId, docLabel,
          versionId: currentVersionId, revLabel: currentRev,
          recipients: outdated.map((h) => ({ uid: h.userId, email: h.userEmail })),
          actorUserId: currentUserId,
          actorName: currentUserName || "Document Control",
          notify: false,
        });
      }
      setNudgedCount(n);
      await load();
    } catch (e) {
      // DIST-12: a failed recall must never look like a sent one.
      setError((e as Error).message);
    } finally {
      setNudging(false);
    }
  };

  const shortName = (h: RecallHolder) => h.userEmail?.split("@")[0] ?? "someone";

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3.5 py-2.5 flex items-center gap-2 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <FileDown className="w-4 h-4 text-teal-600 shrink-0" />
        <span className="text-xs font-bold text-[var(--color-text)]">Copies in circulation</span>
        <span className="ml-auto flex items-center gap-1.5">
          {outdated.length > 0 ? (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
              {outdated.length} of {holders.length}{capped ? "+" : ""} outdated
            </span>
          ) : (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
              all {holders.length}{capped ? "+" : ""} current
            </span>
          )}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
      </button>

      {open && (
        <div className="px-3.5 pb-3 border-t border-[var(--color-border)] pt-2.5 space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
          {/* DIST-11: honesty about truncation, like the transmittal pill. */}
          {capped && (
            <div className="text-[10px] font-bold text-amber-700 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Showing the newest downloads only — earlier holders may be missing from this list and from the recall.
            </div>
          )}
          {holders.slice(0, 10).map((h) => {
            const a = !h.hasCurrent ? ackByUid.get(h.userId) : undefined;
            return (
              <div key={h.userId} className="flex items-center gap-2 text-[11px] py-0.5">
                {h.hasCurrent
                  ? <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                  : <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />}
                <span className="font-bold text-[var(--color-text)] truncate">{shortName(h)}</span>
                {a && (
                  a.acknowledgedAt
                    ? <span className="text-[9px] font-bold text-emerald-600 shrink-0">confirmed current ✓</span>
                    : <span className="text-[9px] font-bold text-amber-600 shrink-0 inline-flex items-center gap-0.5">
                        <Clock className="w-2.5 h-2.5" /> recalled {new Date(a.requestedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                )}
                <span className="text-[var(--color-text-faint)] ml-auto shrink-0">
                  Rev {h.lastDownloadedRev ?? "?"} · {new Date(h.lastDownloadedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </div>
            );
          })}
          {holders.length > 10 && (
            <div className="text-[10px] text-[var(--color-text-faint)]">…and {holders.length - 10} more</div>
          )}

          {/* DIST-10: recall state from the DATABASE — a second controller
              sees an outstanding recall instead of an innocent un-nudged
              button. */}
          {recallOutstanding && (
            <div className="mt-1 text-[11px] font-bold text-teal-700 flex items-center gap-1.5">
              <BellRing className="w-3.5 h-3.5" />
              Recall outstanding since {earliestRecallAt ? new Date(earliestRecallAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"} — {recallConfirmed} of {recalled.length} confirmed current.
            </div>
          )}
          {error && (
            <div className="mt-1 text-[11px] font-bold text-red-700">Recall not sent: {error}</div>
          )}

          {outdated.length > 0 && (
            nudgedCount !== null ? (
              <div className="mt-1.5 text-[11px] font-bold text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Recall sent to {nudgedCount} {nudgedCount === 1 ? "person" : "people"} — on the audit record.
              </div>
            ) : (
              <button
                onClick={() => void handleNudge()}
                disabled={nudging}
                className="mt-1.5 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[11px] font-bold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 transition-colors disabled:opacity-50"
              >
                {nudging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
                {recallOutstanding
                  ? `Re-send recall — remind ${outdated.length} ${outdated.length === 1 ? "person" : "people"}`
                  : `Recall outdated copies — notify ${outdated.length} ${outdated.length === 1 ? "person" : "people"}`}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
