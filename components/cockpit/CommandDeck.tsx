"use client";

// Needs you (Home's first section). The page's header says how many things
// wait on you; this section lists them as a ruled table (item, what to do,
// status, date), late rows first with a red edge, and closes with one quiet
// line of the three main tools and their live counts.
//
// The customizable dashboard renders it as the `commandDeck` widget.

import React from "react";
import Link from "next/link";
import { RefreshCw, Download } from "lucide-react";
import type { InboxSnapshot } from "@/lib/inbox";
import type { AttentionItem } from "@/hooks/useTicketNotifications";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";
import { useNotificationsSeen } from "@/components/notifications/seen";
import { buildNeeds } from "./needsYou";
import NeedsTable from "./NeedsTable";
import { sheet, iconBtn, link, humanTime, SectionHead } from "./ui";

// Headline counts for the three tools in the section's last row. Fetched
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
  /** Opening a row (marks its notification read). */
  onOpenItem?: (notificationId: string) => void;
  /** When true, the section fills its parent's height (and scrolls inside
   *  if cramped), and its tools step aside for the editor's. Used while the
   *  dashboard is being arranged. */
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
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

const SHOWN = 8;

export function CommandDeck({
  data, pillars, items = [], focus,
  lastLoadedAt, refreshing, canExport, onRefresh, onExport, onOpenItem, fill = false,
}: CommandDeckProps) {
  const stale = data?.myStaleCheckouts.length ?? 0;
  const { open: openCenter } = useNotificationCenter();
  const { seenAt } = useNotificationsSeen();
  const rows = React.useMemo(() => buildNeeds(items), [items]);
  const more = Math.max(0, rows.length - SHOWN);

  // The three main tools as one quiet line of labelled figures (each opens
  // its tool); a zero reads muted, checkouts past their date in red.
  const tools: Array<{ href: string; label: string; value: number | undefined; note?: string; bad?: boolean }> = [
    { href: "/requests", label: "Open drafting requests", value: pillars.openRequests, note: data ? `${data.ticketsAssigned.length.toLocaleString()} yours` : undefined },
    { href: "/checkouts", label: "Documents checked out", value: pillars.lockedDocs, bad: stale > 0,
      note: data ? (stale > 0 ? `${stale.toLocaleString()} past due` : `${data.myCheckouts.length.toLocaleString()} by you`) : undefined },
    { href: "/projects", label: "Active projects", value: pillars.activeProjects, note: data && data.milestonesUpcoming.length ? `${data.milestonesUpcoming.length.toLocaleString()} milestones this week` : undefined },
  ];

  return (
    <section aria-label="Needs you" className={`min-w-0 ${fill ? "h-full flex flex-col" : ""}`}>
      <SectionHead title="Needs you" count={rows.length} tone={rows.some((r) => r.overdue) ? "bad" : undefined}>
        {!fill && (
          <div className="flex items-center gap-1">
            <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title={lastLoadedAt ? `Refresh (updated ${humanTime(new Date(lastLoadedAt).toISOString())})` : "Refresh"} className={iconBtn}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <button type="button" onClick={onExport} disabled={!canExport} aria-label="Download as a spreadsheet" title="Download what needs you as a spreadsheet (CSV)" className={iconBtn}>
              <Download className="w-4 h-4" />
            </button>
            {rows.length > 0 && (
              <button type="button" onClick={() => openCenter("all")} className={`ml-2 text-[14px] font-semibold ${link}`}>
                {more > 0 ? `Show all ${rows.length.toLocaleString()}` : "Show all"}
              </button>
            )}
          </div>
        )}
      </SectionHead>

      <div className={`${sheet} ${fill ? "flex-1 min-h-0 overflow-y-auto" : ""}`}>
        {rows.length > 0 ? (
          <NeedsTable rows={rows} limit={SHOWN} seenAt={seenAt} onOpen={(r) => { if (r.notificationId) onOpenItem?.(r.notificationId); }} />
        ) : (
          <p className="px-4 py-4 text-[15px] text-[var(--color-text-muted)]">
            {focus ?? "No requests, reviews or alerts are waiting on you."}
          </p>
        )}
        {more > 0 && (
          <div className="border-t border-[var(--color-border)] px-4 py-2.5 text-[13px] text-[var(--color-text-muted)]">
            Showing {SHOWN} of {rows.length.toLocaleString()}, late ones first.
          </div>
        )}
      </div>
      {/* The three main tools, with their live counts: quiet text. */}
      <ul aria-label="Your tools" className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[14px]">
        {tools.map((t) => {
          const v = pillars.loaded ? t.value ?? 0 : null;
          return (
            <li key={t.href}>
              <Link href={t.href} className="group inline-flex items-baseline gap-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <span className="group-hover:underline underline-offset-2">{t.label}</span>
                <span className={`font-semibold tabular-nums ${v === null || v === 0 ? "text-[var(--color-text-faint)]" : t.bad ? "text-[var(--state-overdue-text)]" : "text-[var(--color-text)]"}`}>{v === null ? "–" : v.toLocaleString()}</span>
                {t.note && <span className={t.bad ? "text-[var(--state-overdue-text)]" : ""}>({t.note})</span>}
              </Link>
            </li>
          );
        })}
      </ul>
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
    if (assigned > 0) return `You have ${assigned} request${assigned === 1 ? "" : "s"} assigned to you.`;
    if (markups > 0) return `${markups} markup request${markups === 1 ? "" : "s"} waiting on you.`;
    return "No requests assigned to you. The unassigned ones are on Drafting Requests.";
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
  if (assigned > 0 || d.ticketsUnread.length > 0) return `${d.ticketsUnread.length} of your requests ha${d.ticketsUnread.length === 1 ? "s" : "ve"} new activity.`;
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
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
