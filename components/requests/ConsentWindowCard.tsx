"use client";

// ConsentWindowCard — the consent window on the request (drafting-flow
// DF-P7: GAP-109 on GAP-113; DEC-38, DEC-39).
//
// Mounted by the request page ONLY when the ticket carries a window
// (lib/consentWindow.ts consentWindowMarker — the roster's mirror, written in
// the same statement as the ticket's consent_window_* columns), so a ticket
// with no window renders exactly as before.
//
// It says who was told and when, when the reminder went (or goes) out, when
// the window closes, and — once it has closed — who opened the notice and
// who did not (the record the maintenance run wrote, ticket_notice_events),
// or who objected. One of the people asked may object here (comment
// required): the slot then waits for a sign-off. Reads only what the viewer
// may read (the ticket, its notice events and the members, through RLS); a
// person's opened / not-opened state is shown only once the window has
// closed — before that only the people asked know whether they looked.

import React, { useEffect, useState } from "react";
import { Hourglass, ShieldAlert, CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { consentWindowMarker, mayObject, recordMoment } from "@/lib/consentWindow";
import type { Ticket, TicketReviewRoster } from "@/types/schema";

interface NoticeRow { kind: string; recipient: string | null; created_at: string; details: Record<string, unknown> | null }

/** The card's one-line state (pure; exported for tests). */
export function consentWindowHeadline(roster: Pick<TicketReviewRoster, "consentWindow" | "slots" | "closedAt" | "closedReason"> | null | undefined): string | null {
  const w = roster?.consentWindow;
  if (!w) return null;
  const slot = roster!.slots.find((s) => s.kind === w.slot);
  const label = slot?.label || w.slot;
  if (w.objectedAt) return `"${label}": objected to ${recordMoment(w.objectedAt)} — it waits for a sign-off.`;
  if (slot?.status === "satisfied" && slot.via === "consent") return `"${label}": the window closed ${recordMoment(w.expiredAt ?? slot.satisfiedAt ?? null)} with no objection — recorded as given without objection.`;
  if (w.expiredAt) return `"${label}": the window closed ${recordMoment(w.expiredAt)} with no objection, but it still needs a sign-off (see the history).`;
  if (slot?.status === "satisfied") return `"${label}": signed off before the window closed.`;
  if (roster!.closedAt) return `"${label}": the review closed (${roster!.closedReason || "closed"}) before the window did.`;
  return `"${label}" goes ahead without objection when the window closes ${recordMoment(w.closesAt)}.`;
}

export default function ConsentWindowCard({ ticket, uid }: { ticket: Ticket; uid: string | null | undefined }) {
  const roster = (ticket.metadata as Record<string, unknown> | undefined)?.review_roster as TicketReviewRoster | undefined;
  const mark = consentWindowMarker(ticket);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [events, setEvents] = useState<NoticeRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [objecting, setObjecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipients = mark?.recipients ?? [];
  const rosterId = roster?.id ?? null;

  useEffect(() => {
    if (!ticket.id || !mark) return;
    let alive = true;
    void (async () => {
      const [{ data: ms }, { data: evs, error: evErr }] = await Promise.all([
        supabase.from("org_members").select("uid, display_name, email").eq("org_id", ticket.orgId).in("uid", recipients),
        supabase.from("ticket_notice_events").select("kind, recipient, created_at, details").eq("ticket_id", ticket.id!).eq("roster_id", rosterId ?? "").order("created_at"),
      ]);
      if (!alive) return;
      const m = new Map<string, string>();
      for (const r of (ms as Array<{ uid: string; display_name?: string | null; email?: string | null }> | null) ?? []) {
        m.set(r.uid, (r.display_name || "").trim() || (r.email || "").split("@")[0] || "a member");
      }
      setNames(m);
      if (evErr) setReadError("The window's notice record could not be read — the request's history carries it.");
      setEvents((evs as NoticeRow[] | null) ?? []);
    })();
    return () => { alive = false; };
    // recipients is the frozen list on the mark: its identity changes only with the ticket
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.orgId, rosterId, mark?.openedAt]);

  if (!mark) return null;
  const nameOf = (u: string) => names.get(u) || `member ${u.slice(0, 8)}`;
  const closed = (events ?? []).filter((e) => e.kind === "expired" && e.recipient);
  const noticeOf = (u: string): string | null => {
    const e = closed.find((x) => x.recipient === u);
    const n = e?.details?.notice;
    if (n === "opened") return e?.details?.openedAt ? `opened ${recordMoment(String(e.details.openedAt))}` : "opened";
    if (n === "unopened") return "did not open it";
    if (n === "not_delivered") return "no delivery on record";
    return null;
  };
  const canObject = mayObject(roster, uid);

  const object = async () => {
    if (!ticket.id || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/tickets/workflow-action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ ticketId: ticket.id, actionType: "object_consent_window", comment: reason.trim() }),
      });
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(out.error || `The objection was not recorded (HTTP ${res.status})`);
      setObjecting(false);
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="consent-window-card" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3 text-sm">
      <div className="flex items-start gap-2">
        {mark.objectedAt ? <ShieldAlert className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" /> : mark.expiredAt ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /> : <Hourglass className="w-4 h-4 mt-0.5 text-sky-600 shrink-0" />}
        <p className="text-[var(--color-text)]" data-testid="consent-window-headline">{consentWindowHeadline(roster)}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
        <dt>Told</dt><dd>{recordMoment(mark.openedAt)}</dd>
        <dt>Reminder</dt><dd>{mark.warnedAt ? `sent ${recordMoment(mark.warnedAt)}` : `due ${recordMoment(mark.warnAt)}`}</dd>
        <dt>Closes</dt><dd>{recordMoment(mark.closesAt)}</dd>
        {mark.objectedAt && (<><dt>Objected</dt><dd>{mark.objectedBy ? nameOf(mark.objectedBy) : "someone asked"}, {recordMoment(mark.objectedAt)}</dd></>)}
      </dl>
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-faint)]">Asked ({recipients.length})</p>
        <ul className="mt-1 space-y-0.5" data-testid="consent-window-recipients">
          {recipients.map((u) => {
            const n = noticeOf(u);
            return <li key={u}><span className="font-semibold text-[var(--color-text)]">{nameOf(u)}</span>{n ? <span className="ml-2 text-xs text-[var(--color-text-muted)]">— {n}</span> : null}</li>;
          })}
        </ul>
      </div>
      {readError && <p role="alert" className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="w-3.5 h-3.5" />{readError}</p>}
      {canObject && !objecting && (
        <button type="button" data-testid="consent-window-object" className="text-xs font-semibold text-amber-700 underline" onClick={() => setObjecting(true)}>
          Object — stop the automatic advance
        </button>
      )}
      {canObject && objecting && (
        <div className="space-y-2">
          <label className="block text-xs text-[var(--color-text-muted)]" htmlFor="consent-objection">Why should this not go ahead? (recorded on the request)</label>
          <textarea id="consent-objection" className="w-full rounded border border-[var(--color-border)] p-2 text-sm" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" disabled={busy || !reason.trim()} onClick={() => void object()} className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Object</button>
            <button type="button" disabled={busy} onClick={() => { setObjecting(false); setError(null); }} className="rounded px-3 py-1 text-xs">Cancel</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    </section>
  );
}
