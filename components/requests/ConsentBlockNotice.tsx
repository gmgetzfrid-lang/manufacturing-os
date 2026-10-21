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

import React, { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { isMissingConsentSchema } from "@/lib/consentWindow";
import { consentBlockReason, type ConsentBlockRow } from "@/lib/requestPageReview";
import type { TicketReviewRoster } from "@/types/schema";

/** Does this request's roster ask for the notice record at all? (pure) */
export function rosterHasConsent(roster: Pick<TicketReviewRoster, "consentPlan" | "slots"> | null | undefined): boolean {
  if (!roster) return false;
  return !!roster.consentPlan || (Array.isArray(roster.slots) && roster.slots.some((s) => s.mode === "consent_window"));
}

export default function ConsentBlockNotice({
  ticketId, roster, onRows,
}: {
  ticketId: string | null | undefined;
  roster: TicketReviewRoster | null | undefined;
  /** The rows read, for the page's history (Audit Log tab). */
  onRows?: (rows: ConsentBlockRow[]) => void;
}) {
  const [rows, setRows] = useState<ConsentBlockRow[]>([]);
  const [readError, setReadError] = useState(false);
  const asks = rosterHasConsent(roster);

  useEffect(() => {
    if (!ticketId || !asks) return;
    let alive = true;
    void (async () => {
      const { data, error } = await supabase
        .from("ticket_notice_events")
        .select("created_at, slot_kind, actor_name, details")
        .eq("ticket_id", ticketId)
        .eq("kind", "blocked")
        .order("created_at", { ascending: true })
        .limit(50);
      if (!alive) return;
      if (error) {
        setRows([]);
        setReadError(!isMissingConsentSchema(error));
        return;
      }
      setReadError(false);
      setRows((data ?? []) as ConsentBlockRow[]);
    })();
    return () => { alive = false; };
  }, [ticketId, asks, roster?.id]);

  useEffect(() => { onRows?.(rows); }, [rows, onRows]);

  if (!asks || (rows.length === 0 && !readError)) return null;
  const labelOf = (slot: string | null) => roster?.slots.find((s) => s.kind === slot)?.label ?? null;
  return (
    <section data-testid="consent-block-notice" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
      {rows.map((r, i) => (
        <p key={`${r.created_at}-${i}`} className="flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{consentBlockReason(r, labelOf(r.slot_kind))}</span>
        </p>
      ))}
      {readError && <p role="alert">The consent window&apos;s notice record could not be read — if a window was not opened, the reason is not shown here.</p>}
    </section>
  );
}
