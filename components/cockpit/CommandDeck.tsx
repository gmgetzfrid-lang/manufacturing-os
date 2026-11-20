"use client";

// ─── COMMAND DECK ──────────────────────────────────────────────────────────
// The cockpit hero. A dark, high-tech band: personal greeting + ops status on
// the left, and the three main attractions (Requests · Documents · Projects)
// as live, deep-linked pillars with their own primary actions.
//
// Extracted verbatim from /inbox so the SAME hero can power both surfaces. The
// inbox imports these symbols unchanged (its masthead behavior is identical),
// and the customizable dashboard renders <CommandDeck fill /> as a first-class
// widget (see the `commandDeck` entry in the widget catalog).

import React from "react";
import Link from "next/link";
import {
  Briefcase, RefreshCw, Download, FileStack, FolderKanban, ChevronRight,
} from "lucide-react";
import type { InboxSnapshot } from "@/lib/inbox";
import { useGreeting } from "@/components/cockpit/DailyBrief";
import { useNotificationCenter } from "@/components/notifications/NotificationCenter";

// Headline counts for the three command-deck pillars. Fetched separately from
// the personal inbox snapshot (org-wide numbers), each guarded so a missing
// table/column degrades that one stat to 0 instead of blanking the deck.
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
  focus: string | null;
  lastLoadedAt: number | null;
  refreshing: boolean;
  canExport: boolean;
  onRefresh: () => void;
  onExport: () => void;
  /** When true, the deck fills its parent's height (and scrolls internally if
   *  cramped) instead of sitting at content height with a bottom margin. Used
   *  when the deck is rendered as a dashboard grid widget rather than the inbox
   *  masthead. */
  fill?: boolean;
}

export function CommandDeck({
  userEmail, data, pillars, attentionCount, actionCount, focus,
  lastLoadedAt, refreshing, canExport, onRefresh, onExport, fill = false,
}: CommandDeckProps) {
  const name = userEmail?.split("@")[0];
  const hello = useGreeting();
  const stale = data?.myStaleCheckouts.length ?? 0;
  const { open: openCenter } = useNotificationCenter();

  const n = attentionCount;
  const row = "flex items-center gap-3 py-2.5 border-t border-[var(--color-border)] text-[13.5px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] -mx-4 px-4";
  return (
    <div className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] ${fill ? "h-full flex flex-col" : "mb-4"}`}>
      <div className={`p-4 ${fill ? "flex-1 min-h-0 overflow-y-auto" : ""}`}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] text-[var(--color-text-muted)]">{hello}{name ? `, ${name}` : ""}.</p>
            <p className="text-[19px] font-black leading-snug">
              {n > 0 ? `${n} ${n === 1 ? "thing needs" : "things need"} you${actionCount > 0 ? `, ${actionCount} to act on` : ""}.` : "Nothing needs you right now."}
            </p>
            {focus && <p className="text-[13px] text-[var(--color-text-muted)] mt-0.5">{focus}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {n > 0 && (
              <button type="button" onClick={() => openCenter("all")}
                className="h-9 px-4 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[13px] font-black hover:bg-[var(--color-accent-hover)]">
                Show me
              </button>
            )}
            <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title={lastLoadedAt ? `Updated ${formatAgo(new Date(lastLoadedAt).toISOString())}` : "Refresh"}
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] disabled:opacity-60">
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <button type="button" onClick={onExport} disabled={!canExport} aria-label="Export" title="Download what needs you as a spreadsheet (CSV)"
              className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] disabled:opacity-40">
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="mt-3">
          <Link href="/requests" className={row}>
            <Briefcase className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="flex-1"><b>Drafting requests</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.openRequests} open` : ""}{data ? `, ${data.ticketsAssigned.length} assigned to you` : ""}</span></span>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />
          </Link>
          <Link href="/checkouts" className={row}>
            <FileStack className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="flex-1"><b>Documents</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.lockedDocs} checked out` : ""}{data ? `, ${data.myCheckouts.length} by you` : ""}</span>
              {stale > 0 && <span className="ml-1 font-bold text-rose-700 dark:text-rose-400">{stale} past due</span>}</span>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />
          </Link>
          <Link href="/projects" className={row}>
            <FolderKanban className="w-4 h-4 text-[var(--color-text-muted)]" />
            <span className="flex-1"><b>Projects</b> <span className="text-[var(--color-text-muted)]">{pillars.loaded ? `${pillars.activeProjects} active` : ""}{data && data.milestonesUpcoming.length ? `, ${data.milestonesUpcoming.length} milestones this week` : ""}</span></span>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-faint)]" />
          </Link>
        </div>
      </div>
    </div>
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
