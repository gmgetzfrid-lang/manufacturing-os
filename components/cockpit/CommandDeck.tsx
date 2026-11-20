"use client";

// ─── COMMAND DECK ──────────────────────────────────────────────────────────
// Home's top card: "Needs you". The page's band above it says how many things
// wait on you and names the first; this card lists them, the first one on its
// own line and the rest under "Also open", then a quiet row of the three main
// tools (requests, documents, projects) with their live counts.
//
// The customizable dashboard renders <CommandDeck fill /> as a widget (see the
// `commandDeck` entry in the widget catalog).

import React from "react";
import Link from "next/link";
import { RefreshCw, Download, ChevronRight } from "lucide-react";
import type { InboxSnapshot } from "@/lib/inbox";
import type { AttentionItem } from "@/hooks/useTicketNotifications";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";

// Headline counts for the three tools in the card's last row. Fetched
// separately from the personal inbox snapshot (org-wide numbers), each guarded
// so a missing table/column degrades that one stat to 0 instead of blanking it.
export interface PillarStats {
  openRequests: number;
  lockedDocs: number;
  activeProjects: number;
  loaded: boolean;
}

export interface CommandDeckProps {
  userEmail?: string;
  data: InboxSnapshot | null;
  pillars: PillarStats;
  attentionCount: number;
  actionCount: number;
  /** What waits on you, newest first (the same feed as the bell). */
  items?: AttentionItem[];
  focus: string | null;
  lastLoadedAt: number | null;
  refreshing: boolean;
  canExport: boolean;
  onRefresh: () => void;
  onExport: () => void;
  /** When true, the card fills its parent's height (and scrolls inside if
   *  cramped). Used while the dashboard is being arranged. */
  fill?: boolean;
}

/** "KE-DDRT-26-0003 do stuff" → ["KE-DDRT-26-0003", "do stuff"]. */
export function splitRef(title: string): [string | null, string] {
  const m = /^([A-Z0-9]+(?:-[A-Z0-9]+)+)\s+(.*)$/.exec(title.trim());
  return m ? [m[1], m[2] || ""] : [null, title];
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

const SHOWN = 4;

export function CommandDeck({
  data, pillars, attentionCount, actionCount, items = [], focus,
  lastLoadedAt, refreshing, canExport, onRefresh, onExport, fill = false,
}: CommandDeckProps) {
  const stale = data?.myStaleCheckouts.length ?? 0;
  const { open: openCenter } = useNotificationCenter();
  const first = items.find((i) => i.actionRequired) ?? items[0];
  const rest = items.filter((i) => i !== first);
  const more = Math.max(0, rest.length - (SHOWN - 1));
  const iconBtn = "h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-40";
  const tool = "flex items-center gap-2 min-w-0 py-2.5 text-[13px] text-[var(--color-text)] hover:text-[var(--color-accent-text)]";

  const row = (it: AttentionItem, lead: boolean) => {
    const [ref, rest] = it.source === "ticket" ? splitRef(it.title) : [null, it.title];
    return (
      <Link key={it.key} href={it.link}
        className={`group flex items-center gap-3 sm:gap-4 border-t border-[var(--color-border)] ${lead ? "py-3.5" : "py-3"} text-[var(--color-text)] hover:bg-[var(--color-surface-2)] -mx-4 sm:-mx-5 px-4 sm:px-5`}>
        <span className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-x-4 gap-y-0.5">
          {ref && <span className="sm:w-36 shrink-0 font-mono text-[12px] font-semibold text-[var(--color-text-muted)] truncate">{ref}</span>}
          <span className={`min-w-0 flex-1 truncate text-[14px] ${lead ? "font-semibold" : ""}`}>
            {rest || it.title}
            {it.subtitle && <span className="font-normal text-[var(--color-text-muted)]"> · {it.subtitle}</span>}
          </span>
        </span>
        {it.when && <span className={`shrink-0 text-[12px] ${it.actionRequired ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{shortDate(it.when)}</span>}
        <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
      </Link>
    );
  };

  return (
    <section aria-label="Needs you"
      className={`rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] text-[var(--color-text)] ${fill ? "h-full flex flex-col" : ""}`}>
      <div className={`p-4 sm:p-5 ${fill ? "flex-1 min-h-0 overflow-y-auto" : ""}`}>
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
            {first ? (actionCount > 0 && actionCount < attentionCount ? `Needs you · ${actionCount} to act on` : "Needs you") : "Nothing waiting"}
          </h2>
          <div className="flex-1" />
          {items.length > 0 && (
            <button type="button" onClick={() => openCenter("all")}
              className="h-8 px-2.5 rounded-lg text-[12.5px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              Show all
            </button>
          )}
          <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title={lastLoadedAt ? `Updated ${formatAgo(new Date(lastLoadedAt).toISOString())}` : "Refresh"} className={iconBtn}>
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button type="button" onClick={onExport} disabled={!canExport} aria-label="Export" title="Download what needs you as a spreadsheet (CSV)" className={iconBtn}>
            <Download className="w-4 h-4" />
          </button>
        </div>

        {first ? (
          <div className="mt-2">
            {row(first, true)}
            {rest.length > 0 && (
              <>
                <div className="mt-3 mb-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)]">Also open</div>
                {rest.slice(0, SHOWN - 1).map((it) => row(it, false))}
                {more > 0 && (
                  <button type="button" onClick={() => openCenter("all")}
                    className="w-full text-left border-t border-[var(--color-border)] pt-2.5 pb-1 text-[13px] font-bold text-[var(--color-accent-text)] hover:text-[var(--color-accent-hover)]">
                    Show {more} more
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
            {focus ?? "No requests, reviews or alerts are waiting on you."}
          </p>
        )}

        {/* The three main tools, with their live counts. */}
        <div className="mt-3 pt-1 border-t border-[var(--color-border)] grid grid-cols-1 sm:grid-cols-3 sm:gap-4">
          <Link href="/requests" className={tool}>
            <span className="min-w-0 truncate"><b>Drafting requests</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.openRequests} open` : ""}{data ? `${pillars.loaded ? ", " : ""}${data.ticketsAssigned.length} yours` : ""}</span></span>
          </Link>
          <Link href="/checkouts" className={tool}>
            <span className="min-w-0 truncate"><b>Documents</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.lockedDocs} checked out` : ""}{data ? `${pillars.loaded ? ", " : ""}${data.myCheckouts.length} by you` : ""}</span>
              {stale > 0 && <span className="ml-1 font-bold text-rose-700 dark:text-rose-400">{stale} past due</span>}</span>
          </Link>
          <Link href="/projects" className={tool}>
            <span className="min-w-0 truncate"><b>Projects</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.activeProjects} active` : ""}{data && data.milestonesUpcoming.length ? `, ${data.milestonesUpcoming.length} milestones this week` : ""}</span></span>
          </Link>
        </div>
      </div>
    </section>
  );
}

// Role-aware "focus" line — the single thing this role most likely cares about
// right now, computed from the live snapshot. Keeps the shared cockpit but
// frames it for who's looking.
export function roleFocus(role: string | null | undefined, d: InboxSnapshot): string | null {
  const r = (role ?? "").toLowerCase();
  const assigned = d.ticketsAssigned.length;
  const checkouts = d.myCheckouts.length;
  const markups = d.markupRequestsToMe.length;
  const milestones = d.milestonesUpcoming.length;
  if (r.includes("draft")) {
    if (assigned > 0) return `You have ${assigned} request${assigned === 1 ? "" : "s"} assigned - drafting is your lane today.`;
    if (markups > 0) return `${markups} markup request${markups === 1 ? "" : "s"} waiting on you.`;
    return "No requests assigned - check the pool for work to claim.";
  }
  if (r.includes("engineer")) {
    if (assigned > 0) return `${assigned} item${assigned === 1 ? "" : "s"} need your engineering review or approval.`;
    return "Nothing awaiting your review right now.";
  }
  if (r === "admin" || r === "docctrl") {
    if (checkouts > 0) return `${checkouts} document${checkouts === 1 ? "" : "s"} checked out under your name.`;
    if (milestones > 0) return `${milestones} milestone${milestones === 1 ? "" : "s"} due this week across projects.`;
    return null;
  }
  // Requester / other
  if (assigned > 0 || d.ticketsUnread.length > 0) return `Track your requests - ${d.ticketsUnread.length} ha${d.ticketsUnread.length === 1 ? "s" : "ve"} new activity.`;
  return null;
}

export function formatAgo(iso: string | undefined): string {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

// CSV export — dumps every Inbox section into one CSV with section
// headers. Friendly enough to send to email/Slack at end of day.
export function exportInboxCsv(d: InboxSnapshot, signedInAs?: string) {
  const csvField = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(`#### My Inbox - ${new Date().toISOString().slice(0, 10)}${signedInAs ? ` · ${signedInAs}` : ""} ####`);
  lines.push("");

  const addTable = (heading: string, header: string[], rows: unknown[][]) => {
    if (rows.length === 0) return;
    lines.push(heading);
    lines.push(header.map(csvField).join(","));
    for (const r of rows) lines.push(r.map(csvField).join(","));
    lines.push("");
  };

  addTable(
    `TICKETS ASSIGNED TO ME (${d.ticketsAssigned.length})`,
    ["Ticket ID", "Title", "Status", "Last Modified"],
    d.ticketsAssigned.map((t) => [t.ticketId, t.title, t.status, t.lastModified ?? ""]),
  );
  addTable(
    `TICKETS WITH UNREAD ACTIVITY (${d.ticketsUnread.length})`,
    ["Ticket ID", "Title", "Status", "Last Modified"],
    d.ticketsUnread.map((t) => [t.ticketId, t.title, t.status, t.lastModified ?? ""]),
  );
  addTable(
    `TICKETS I'M WATCHING (${d.ticketsWatching.length})`,
    ["Ticket ID", "Title", "Status", "Last Modified"],
    d.ticketsWatching.map((t) => [t.ticketId, t.title, t.status, t.lastModified ?? ""]),
  );
  addTable(
    `MY ACTIVE CHECKOUTS (${d.myCheckouts.length})`,
    ["Document ID", "Mode", "Purpose", "Started"],
    d.myCheckouts.map((s) => [s.documentId, s.mode, s.purpose ?? "", s.startedAt]),
  );
  addTable(
    `HOLDS I OPENED (${d.myOpenHolds.length})`,
    ["Reason", "Notes", "Opened"],
    d.myOpenHolds.map((h) => [h.reason, h.notes ?? "", h.openedAt]),
  );
  addTable(
    `MARKUP REQUESTS FOR ME (${d.markupRequestsToMe.length})`,
    ["Doc Number", "Title", "From", "Message", "Requested"],
    d.markupRequestsToMe.map((m) => [m.documentNumber ?? "", m.documentTitle ?? "", m.requestedByName ?? "", m.message ?? "", m.createdAt]),
  );
  addTable(
    `MILESTONES DUE THIS WEEK (${d.milestonesUpcoming.length})`,
    ["Name", "Planned", "Status", "Due in days"],
    d.milestonesUpcoming.map((m) => [m.name, String(m.plannedAt ?? ""), m.status, m.__dueInDays ?? ""]),
  );
  addTable(
    `TRANSMITTALS AWAITING RECEIPT (${d.transmittalsAwaitingAck.length})`,
    ["Number", "Subject", "Recipient", "Docs", "Issued", "Age (days)"],
    d.transmittalsAwaitingAck.map((t) => [t.number, t.subject ?? "", [t.recipientName, t.recipientCompany].filter(Boolean).join(" / "), t.documentCount, t.issuedAt ?? "", t.__ageDays ?? ""]),
  );

  const csv = lines.join("\n");
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inbox-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
