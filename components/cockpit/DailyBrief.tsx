"use client";

// Daily Brief — turns the raw inbox snapshot into a narrated "here's your day".
//
// Extracted from the /inbox cockpit so the same hero can be dropped onto the
// customizable dashboard as a widget. Deterministic (reliable + offline), so it
// always reads like a smart summary rather than a list. Time-of-day greeting +
// the few things that actually matter, with the most urgent surfaced first.

import React from "react";
import Link from "next/link";
import { Zap, ChevronRight } from "lucide-react";
import type { InboxSnapshot } from "@/lib/inbox";

// Builds the short "what's on your plate" sentences, most-urgent first.
export function buildBriefSentences(d: InboxSnapshot): string[] {
  const s: string[] = [];
  const assigned = d.ticketsAssigned.length;
  const unread = d.ticketsUnread.length;
  const stale = d.myStaleCheckouts.length;
  const checkouts = d.myCheckouts.length;
  const holds = d.myOpenHolds.length;
  const markups = d.markupRequestsToMe.length;
  const acks = d.transmittalsAwaitingAck.length;
  const dueSoonest = d.milestonesUpcoming.slice().sort((a, b) => (a.__dueInDays ?? 99) - (b.__dueInDays ?? 99))[0];

  if (assigned > 0) s.push(`${assigned} request${assigned === 1 ? "" : "s"} assigned to you`);
  if (markups > 0) s.push(`${markups} markup request${markups === 1 ? "" : "s"} waiting on you`);
  if (unread > 0) s.push(`${unread} ticket${unread === 1 ? "" : "s"} with new activity`);
  if (checkouts > 0) s.push(`${checkouts} document${checkouts === 1 ? "" : "s"} checked out${stale > 0 ? ` (${stale} aging — worth releasing)` : ""}`);
  if (holds > 0) s.push(`${holds} hold${holds === 1 ? "" : "s"} you opened still blocking work`);
  if (acks > 0) s.push(`${acks} transmittal${acks === 1 ? "" : "s"} awaiting the recipient's acknowledgement`);
  const overdueCount = (d.milestonesOverdue ?? []).length;
  if (overdueCount > 0) s.push(`${overdueCount} milestone${overdueCount === 1 ? " is" : "s are"} overdue`);
  if (d.milestonesUpcoming.length > 0) {
    const due = dueSoonest?.__dueInDays;
    const when = due === undefined ? "this week" : due <= 0 ? "today" : due === 1 ? "tomorrow" : `in ${due} days`;
    s.push(`${d.milestonesUpcoming.length} milestone${d.milestonesUpcoming.length === 1 ? "" : "s"} due this week (next ${when})`);
  }
  return s;
}

// The single highest-priority next action, picked from the snapshot. Surfaced
// as a "Start here" button so Home doesn't just describe the day — it points at
// the one thing most worth doing right now.
export function topAction(d: InboxSnapshot): { label: string; href: string } | null {
  if (d.myStaleCheckouts.length > 0)
    return { label: `Release a stale checkout (${d.myStaleCheckouts.length} aging)`, href: "/checkouts" };
  if (d.markupRequestsToMe.length > 0)
    return { label: `Respond to ${d.markupRequestsToMe.length} markup request${d.markupRequestsToMe.length === 1 ? "" : "s"}`, href: "/inbox" };
  if (d.ticketsAssigned.length > 0) {
    const t = d.ticketsAssigned[0];
    return { label: `Open your next request${t.ticketId ? ` — ${t.ticketId}` : ""}`, href: t.id ? `/requests/${t.id}` : "/requests" };
  }
  if (d.myOpenHolds.length > 0)
    return { label: `Clear an open hold (${d.myOpenHolds.length})`, href: "/admin/holds" };
  const overdue = (d.milestonesOverdue ?? [])[0];
  if (overdue)
    return { label: `Address an overdue milestone${overdue.__projectName ? ` in ${overdue.__projectName}` : ""}`, href: overdue.projectId ? `/projects/${overdue.projectId}` : "/inbox" };
  if (d.milestonesUpcoming.length > 0) {
    const m = d.milestonesUpcoming[0];
    return { label: `Get ahead of a milestone due soon`, href: m.projectId ? `/projects/${m.projectId}` : "/inbox" };
  }
  if (d.transmittalsAwaitingAck.length > 0)
    return { label: `Follow up on ${d.transmittalsAwaitingAck.length} unacknowledged transmittal${d.transmittalsAwaitingAck.length === 1 ? "" : "s"}`, href: "/transmittals" };
  if (d.ticketsUnread.length > 0) {
    const t = d.ticketsUnread[0];
    return { label: `Catch up on new ticket activity`, href: t.id ? `/requests/${t.id}` : "/requests" };
  }
  return null;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function DailyBrief({ data }: { data: InboxSnapshot }) {
  const sentences = buildBriefSentences(data);
  const urgent = data.myStaleCheckouts.length + data.markupRequestsToMe.length + data.myOpenHolds.length;
  const next = topAction(data);

  const narrative = sentences.length === 0
    ? "Your queue is clear — nothing needs you right now. Good time to get ahead on something."
    : `You have ${sentences[0]}${sentences.length > 1 ? `, plus ${sentences.length - 1} more thing${sentences.length - 1 === 1 ? "" : "s"} below` : ""}.`;

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-surface-2)] shadow-sm p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center shadow-sm shrink-0">
          <Zap className="w-5 h-5 text-[var(--color-text)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-black uppercase tracking-widest text-[var(--color-text-muted)]">Daily brief</h2>
            {urgent > 0 && <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-rose-600 bg-rose-50 border border-rose-100 rounded-full px-2 py-0.5">{urgent} urgent</span>}
          </div>
          <p className="text-sm text-[var(--color-text-faint)] mt-1 leading-relaxed">{narrative}</p>
          {next && (
            <Link href={next.href} className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-bold hover:bg-[var(--color-accent-hover)] transition-colors">
              <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-accent)]">Start here</span>
              {next.label}
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {sentences.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {sentences.map((line, i) => (
                <span key={i} className="inline-flex items-center text-[11px] font-bold text-[var(--color-text-faint)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full px-2.5 py-1">{line}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
