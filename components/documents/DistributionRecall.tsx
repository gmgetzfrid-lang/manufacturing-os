"use client";

// DistributionRecall — "who is holding a copy of this drawing, and is it
// still current?" Built entirely from download history the system already
// keeps. One-line summary; expands to the holder list; one click nudges
// everyone with an outdated copy.

import React, { useEffect, useState } from "react";
import { FileDown, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, BellRing, Loader2 } from "lucide-react";
import { getDocumentRecall, nudgeStaleHolders, type RecallHolder } from "@/lib/staleCopies";

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
  const [open, setOpen] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [nudgedCount, setNudgedCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // All state mutations inside the async IIFE so render stays pure.
    (async () => {
      setHolders([]);
      setNudgedCount(null);
      setOpen(false);
      const rows = await getDocumentRecall(documentId, currentVersionId);
      if (alive) setHolders(rows);
    })();
    return () => { alive = false; };
  }, [documentId, currentVersionId]);

  if (holders.length === 0) return null;
  const outdated = holders.filter((h) => !h.hasCurrent);

  const handleNudge = async () => {
    setNudging(true);
    try {
      const n = await nudgeStaleHolders({
        orgId, documentId, libraryId, docLabel, currentRev, holders,
        actorUserId: currentUserId, actorName: currentUserName,
      });
      setNudgedCount(n);
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
        <FileDown className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
        <span className="text-[13px] font-bold text-[var(--color-text)]">Copies in circulation</span>
        <span className="ml-auto flex items-center gap-1.5">
          {outdated.length > 0 ? (
            <span className="text-[13px] font-bold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--state-held)_12%,transparent)] text-[var(--state-held)]">
              {outdated.length} of {holders.length} outdated
            </span>
          ) : (
            <span className="text-[13px] font-bold px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--state-released)_10%,transparent)] text-[var(--state-released)]">
              all {holders.length} current
            </span>
          )}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />}
      </button>

      {open && (
        <div className="px-3.5 pb-3 border-t border-[var(--color-border)] pt-2.5 space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
          {holders.slice(0, 10).map((h) => (
            <div key={h.userId} className="flex items-center gap-2 text-[13px] py-0.5">
              {h.hasCurrent
                ? <CheckCircle2 className="w-3 h-3 text-[var(--state-released)] shrink-0" />
                : <AlertTriangle className="w-3 h-3 text-[var(--state-held)] shrink-0" />}
              <span className="font-bold text-[var(--color-text)] truncate">{shortName(h)}</span>
              <span className="text-[var(--color-text-faint)] ml-auto shrink-0">
                Rev {h.lastDownloadedRev ?? "?"} · {new Date(h.lastDownloadedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
            </div>
          ))}
          {holders.length > 10 && (
            <div className="text-[13px] text-[var(--color-text-faint)]">…and {holders.length - 10} more</div>
          )}

          {outdated.length > 0 && (
            nudgedCount !== null ? (
              <div className="mt-1.5 text-[13px] font-bold text-[var(--state-released)] flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Recall sent to {nudgedCount} {nudgedCount === 1 ? "person" : "people"}
              </div>
            ) : (
              <button
                onClick={() => void handleNudge()}
                disabled={nudging}
                className="mt-1.5 w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[13px] font-bold text-[var(--color-text)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)] border border-[color-mix(in_srgb,var(--state-held)_40%,transparent)] transition-colors disabled:opacity-50"
              >
                {nudging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
                Recall outdated copies - notify {outdated.length} {outdated.length === 1 ? "person" : "people"}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
