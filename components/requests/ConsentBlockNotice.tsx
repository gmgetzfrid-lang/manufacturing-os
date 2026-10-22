"use client";

// ConsentBlockNotice — a consent window that was NOT opened, said on the
// request page (drafting-flow DF-P18: GAP-113 acceptance 1's page half; the
// DF-P7 editor residual's sibling).
//
// DF-P7 records a failed open — the route's (`window_not_opened`, with the
// error) and the maintenance run's (`window_never_opened`, with why) — as a
// `blocked` row of the request's notice record (ticket_notice_events,
// 20261255); until now only the action's answer and that row said it. This
// card reads those rows (RLS: whoever can read the request) and says each in
// words; the page also shows them in the Audit Log tab, merged by date with
// the request's own history (read-only — nothing is written to the ticket).
//
// Mounted by the page ONLY when the request's review roster carries a
// consent plan or a consent slot (DEC-90 ruling (1) for DF-P18: a workspace
// with no consent slot sees exactly today's page and makes no extra read).
// Before 20261255 the table is not there: nothing is said (nothing could have
// been recorded).
//
// DF-P18 fix pass (review, major): only THIS roster's rows are read (an
// earlier roster's blocks say nothing about the current review), newest
// first before the cap (so the cap drops the oldest, never the newest), and a
// failed open the maintenance run later opened is no longer said here (the
// Audit Log tab keeps it, marked "opened later"). Fix pass 2 (review,
// major): nor is a block whose consent slot has since been signed, or any
// block once the review is over (the roster closed, or the request no longer
// in review — `ticketStatus`); the Audit Log tab marks them "signed later" /
// "review closed". Fix pass 3 (review minor): when the roster changes the
// rows already read are cleared before anything else (and stay cleared for a
// roster with no consent slot), so the page's history never carries them on.

import React, { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isMissingConsentSchema } from "@/lib/consentWindow";
import { consentBlockReason, currentConsentBlockRows, type ConsentBlockRow } from "@/lib/requestPageReview";
import type { TicketReviewRoster } from "@/types/schema";

/** Does this request's roster ask for the notice record at all? (pure) */
export function rosterHasConsent(roster: Pick<TicketReviewRoster, "consentPlan" | "slots"> | null | undefined): boolean {
  if (!roster) return false;
  return !!roster.consentPlan || (Array.isArray(roster.slots) && roster.slots.some((s) => s.mode === "consent_window"));
}

export default function ConsentBlockNotice({
  ticketId, roster, ticketStatus, onRows,
}: {
  ticketId: string | null | undefined;
  roster: TicketReviewRoster | null | undefined;
  /** The request's status: outside PENDING_REVIEW no block stands. */
  ticketStatus?: string | null;
  /** The rows read, for the page's history (Audit Log tab). */
  onRows?: (rows: ConsentBlockRow[]) => void;
}) {
  const [rows, setRows] = useState<ConsentBlockRow[]>([]);
  const [readError, setReadError] = useState(false);
  const asks = rosterHasConsent(roster);
  const rosterId = roster && typeof roster.id === "string" && roster.id ? roster.id : null;

  useEffect(() => {
    // DF-P18 fix pass 3 (review minor): the earlier roster's rows go first —
    // a roster that asks nothing (or a re-read for a new roster) never keeps
    // them in the page's history, judged against a roster they are not of.
    setRows((prev) => (prev.length === 0 ? prev : []));
    setReadError(false);
    if (!ticketId || !asks) return;
    let alive = true;
    void (async () => {
      let q = supabase
        .from("ticket_notice_events")
        .select("created_at, roster_id, slot_kind, actor_name, details")
        .eq("ticket_id", ticketId)
        .eq("kind", "blocked");
      if (rosterId) q = q.eq("roster_id", rosterId);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(50);
      if (!alive) return;
      if (error) {
        setRows([]);
        setReadError(!isMissingConsentSchema(error));
        return;
      }
      setReadError(false);
      // Oldest first, this roster only (a row of another roster is dropped
      // even if the filter could not be applied).
      setRows(currentConsentBlockRows((data ?? []) as ConsentBlockRow[], roster).rows);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, asks, rosterId]);

  useEffect(() => { onRows?.(rows); }, [rows, onRows]);

  // What still holds: a failed open the maintenance run later opened, a
  // slot since signed, or a review that is over is not said (re-evaluated on
  // every render, so it clears as the roster and the request update).
  const standing = currentConsentBlockRows(rows, roster, ticketStatus).standing;
  if (!asks || (standing.length === 0 && !readError)) return null;
  const labelOf = (slot: string | null) => roster?.slots.find((s) => s.kind === slot)?.label ?? null;
  return (
    <section data-testid="consent-block-notice" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
      {standing.map((r, i) => (
        <p key={`${r.created_at}-${i}`} className="flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{consentBlockReason(r, labelOf(r.slot_kind))}</span>
        </p>
      ))}
      {readError && <p role="alert">The consent window&apos;s notice record could not be read — if a window was not opened, the reason is not shown here.</p>}
    </section>
  );
}
