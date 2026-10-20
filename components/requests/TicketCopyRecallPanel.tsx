"use client";

// TicketCopyRecallPanel — public-surfaces PHYS-18 (drafting-flow DF-P15
// DELIVERABLE PAGE WIRING): "who took a copy of this request's files, and is
// it still the one to work from?" on the ticket page, for the people who may
// recall them — the requester, the assigned drafter and a controller (the
// page decides; this panel only renders for them).
//
// Built on the ticket arm of the stale-copy recall (lib/staleCopies.ts
// getTicketCopyRecall / nudgeStaleTicketHolders, DF-P12): each copy is read
// as a scan of it would read now. "Recall outdated copies" tells every member
// holding an outdated copy who has not since taken the current one, and puts
// the recall on the ticket's audit trail (`source: "manual"`). A record that
// could not be read (before 20261223 is pasted, or a failed read) is said as
// a gap — never "nobody holds a copy" — and recalling then records that the
// recall could not be evaluated and tells nobody (the arm's rule). A capped
// list says holders may be missing.

import React, { useCallback, useEffect, useState } from "react";
import { FileDown, ChevronDown, ChevronUp, AlertTriangle, BellRing, Loader2, RotateCw } from "lucide-react";
import { getTicketCopyRecall, nudgeStaleTicketHolders, type TicketCopyHolder, type TicketForRecall } from "@/lib/staleCopies";

export interface TicketCopyRecallPanelProps {
  ticket: TicketForRecall;
  ticketNumber: string | null;
  currentUserId: string;
  currentUserName?: string | null;
}

const VERDICT_WORDS: Record<string, string> = {
  superseded: "superseded",
  withdrawn: "request withdrawn",
  draft_copy: "review draft",
  current: "current",
  revision_in_progress: "newer revision in progress",
  unknown: "cannot confirm",
};

export default function TicketCopyRecallPanel({ ticket, ticketNumber, currentUserId, currentUserName }: TicketCopyRecallPanelProps) {
  const [loaded, setLoaded] = useState(false);
  const [holders, setHolders] = useState<TicketCopyHolder[]>([]);
  const [capped, setCapped] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [latestIssuedRev, setLatestIssuedRev] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [told, setTold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const recall = await getTicketCopyRecall(ticket);
    setHolders(recall.holders);
    setCapped(recall.capped);
    setUnavailable(recall.unavailable);
    setLatestIssuedRev(recall.latestIssuedRev);
    setLoaded(true);
  }, [ticket]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setTold(null);
      setError(null);
      if (alive) await load();
    })();
    return () => { alive = false; };
  }, [load]);

  if (!loaded) return null;
  if (!unavailable && holders.length === 0) return null;

  const outdated = holders.filter((h) => h.outdated && !h.hasCurrent);
  const reachable = outdated.filter((h) => h.userId !== currentUserId);

  const recall = async () => {
    setRecalling(true);
    setError(null);
    try {
      const n = await nudgeStaleTicketHolders({
        orgId: ticket.orgId,
        ticketId: ticket.id,
        ticketNumber,
        latestIssuedRev,
        holders,
        actorUserId: currentUserId,
        actorName: currentUserName ?? null,
        source: "manual",
        unavailable,
      });
      setTold(n);
      await load();
    } catch (e) {
      // A failed recall never looks like a sent one.
      setError((e as Error)?.message || "The recall could not be sent.");
    } finally {
      setRecalling(false);
    }
  };

  const name = (h: TicketCopyHolder) => h.userEmail?.split("@")[0] ?? "a member";

  return (
    <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden" data-testid="ticket-copy-recall">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3.5 py-2.5 flex items-center gap-2 hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <FileDown className="w-4 h-4 text-teal-600 shrink-0" />
        <span className="text-xs font-bold text-[var(--color-text)]">Copies taken of this request&apos;s files</span>
        <span className="ml-auto flex items-center gap-1.5">
          {unavailable ? (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">record unavailable</span>
          ) : outdated.length > 0 ? (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">
              {outdated.length} of {holders.length}{capped ? "+" : ""} outdated
            </span>
          ) : (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
              all {holders.length}{capped ? "+" : ""} current
            </span>
          )}
          {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--color-text-faint)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-faint)]" />}
        </span>
      </button>
      {open && (
        <div className="px-3.5 pb-3 space-y-2 text-xs">
          {unavailable && (
            <p className="flex items-start gap-1.5 text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              The record of who took a copy could not be read, so who holds one is unknown — not &quot;nobody&quot;.
              <button type="button" onClick={() => { void load(); }} className="ml-1 inline-flex items-center gap-1 font-bold underline">
                <RotateCw className="w-3 h-3" /> Try again
              </button>
            </p>
          )}
          {capped && !unavailable && (
            <p className="text-amber-800">Only the most recent copies are listed — some holders may be missing.</p>
          )}
          {holders.length > 0 && (
            <ul className="divide-y divide-[var(--color-border)]">
              {holders.map((h) => (
                <li key={h.userId} className="py-1.5 flex items-center gap-2">
                  <span className="font-semibold text-[var(--color-text)]">{name(h)}</span>
                  <span className="text-[var(--color-text-muted)] truncate">
                    {h.copies.slice(0, 3).map((c) => `${c.rev ? `Rev ${c.rev}` : "a file"} — ${VERDICT_WORDS[c.verdict] ?? c.verdict}`).join(" · ")}
                  </span>
                  {h.outdated && !h.hasCurrent && (
                    <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">outdated</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(reachable.length > 0 || unavailable) && (
            <button
              type="button"
              onClick={() => { void recall(); }}
              disabled={recalling}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-bold"
            >
              {recalling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
              {unavailable ? "Record a recall (nobody can be told while the record is unreadable)" : `Recall outdated copies (${reachable.length})`}
            </button>
          )}
          {told !== null && (
            <p className="text-emerald-700" role="status">
              {unavailable ? "The recall was recorded; nobody could be told." : `${told} ${told === 1 ? "person was" : "people were"} told their copy is out of date.`}
            </p>
          )}
          {error && <p className="text-red-700" role="alert">The recall was not sent: {error}</p>}
        </div>
      )}
    </div>
  );
}
