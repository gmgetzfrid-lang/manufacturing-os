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
  Briefcase, RefreshCw, Download, Plus, FileStack, FolderKanban, ChevronRight,
} from "lucide-react";
import type { InboxSnapshot } from "@/lib/inbox";
import { greeting } from "@/components/cockpit/DailyBrief";

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
  const stale = data?.myStaleCheckouts.length ?? 0;

  return (
    <div className={`relative overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-canvas)] text-[var(--color-text)] shadow-2xl shadow-slate-900/30 ${fill ? "h-full flex flex-col" : "mb-4"}`}>
      {/* Ambient glows + grid texture for the "console" feel. */}
      <div aria-hidden className="pointer-events-none absolute -top-24 -left-16 w-72 h-72 rounded-full bg-orange-500/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 right-1/4 w-72 h-72 rounded-full bg-blue-500/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -top-10 right-0 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)", backgroundSize: "28px 28px" }}
      />

      <div className={`relative p-5 sm:p-6 ${fill ? "flex-1 min-h-0 overflow-y-auto overscroll-contain" : ""}`}>
        {/* Top status row */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--color-text-muted)]">Mission control · live</span>
            </div>
            <h1 className="text-2xl font-black text-[var(--color-text)]">
              {greeting()}{name ? <>, <span className="text-[var(--color-accent)]">{name}</span></> : ""}.
            </h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
              {focus || "Everything that needs you, and the work you run — in one place."}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:flex items-center gap-3 mr-1 px-3 py-1.5 rounded-xl bg-black/5 dark:bg-[var(--color-surface)]/5 border border-black/10 dark:border-white/10">
              <DeckStat label="Needs you" value={attentionCount} tone={attentionCount > 0 ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"} />
              <span className="w-px h-6 bg-black/10 dark:bg-[var(--color-surface)]/10" />
              <DeckStat label="Action" value={actionCount} tone={actionCount > 0 ? "text-rose-600 dark:text-rose-400" : "text-[var(--color-text)]"} />
            </div>
            <button
              onClick={onExport}
              disabled={!canExport}
              title="Download today's inbox as a CSV"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-black/5 dark:bg-[var(--color-surface)]/5 border border-black/10 dark:border-white/10 hover:bg-black/10 dark:bg-[var(--color-surface)]/10 text-xs font-bold text-[var(--color-text)] disabled:opacity-40 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Export</span>
            </button>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-black/5 dark:bg-[var(--color-surface)]/5 border border-black/10 dark:border-white/10 hover:bg-black/10 dark:bg-[var(--color-surface)]/10 text-xs font-bold text-[var(--color-text)] disabled:opacity-60 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">{lastLoadedAt ? formatAgo(new Date(lastLoadedAt).toISOString()) : "Refresh"}</span>
            </button>
          </div>
        </div>

        {/* The three pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Pillar
            accent="orange"
            icon={Briefcase}
            label="Drafting Requests"
            value={pillars.loaded ? pillars.openRequests : null}
            valueHint="open"
            stats={[
              { label: `${data?.ticketsAssigned.length ?? 0} assigned to you` },
              { label: `${data?.ticketsUnread.length ?? 0} new activity`, dim: true },
            ]}
            primary={{ label: "New request", href: "/requests/new", icon: Plus }}
            secondary={{ label: "Open portal", href: "/requests" }}
          />
          <Pillar
            accent="blue"
            icon={FileStack}
            label="Document Control"
            value={pillars.loaded ? pillars.lockedDocs : null}
            valueHint="checked out"
            stats={[
              { label: `${data?.myCheckouts.length ?? 0} held by you` },
              stale > 0
                ? { label: `${stale} past due`, tone: "text-rose-700 dark:text-rose-300" }
                : { label: "all current", dim: true },
            ]}
            primary={{ label: "Browse & check out", href: "/documents", icon: FileStack }}
            secondary={{ label: "Active locks", href: "/checkouts" }}
          />
          <Pillar
            accent="emerald"
            icon={FolderKanban}
            label="Projects"
            value={pillars.loaded ? pillars.activeProjects : null}
            valueHint="active"
            stats={[
              { label: `${data?.milestonesUpcoming.length ?? 0} milestones this week` },
            ]}
            primary={{ label: "Open projects", href: "/projects", icon: FolderKanban }}
            secondary={{ label: "Coordination", href: "/coordination" }}
          />
        </div>
      </div>
    </div>
  );
}

function DeckStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="text-center">
      <div className={`text-lg font-black leading-none ${tone}`}>{value}</div>
      <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mt-0.5">{label}</div>
    </div>
  );
}

type PillarAccent = "orange" | "blue" | "emerald";
interface PillarStat { label: string; tone?: string; dim?: boolean }
function Pillar({
  accent, icon: Icon, label, value, valueHint, stats, primary, secondary,
}: {
  accent: PillarAccent;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | null;
  valueHint: string;
  stats: PillarStat[];
  primary: { label: string; href: string; icon: React.ComponentType<{ className?: string }> };
  secondary?: { label: string; href: string };
}) {
  const A: Record<PillarAccent, { tile: string; glow: string; btn: string; ring: string; hint: string }> = {
    orange: { tile: "from-orange-500 to-amber-600", glow: "bg-orange-500/20", btn: "bg-orange-500 hover:bg-orange-400 text-[var(--color-text)]", ring: "hover:border-orange-400/40", hint: "text-orange-300/80" },
    blue:   { tile: "from-blue-500 to-indigo-600", glow: "bg-blue-500/20", btn: "bg-blue-500 hover:bg-blue-400 text-[var(--color-text)]", ring: "hover:border-blue-400/40", hint: "text-blue-700/80 dark:text-blue-300/80" },
    emerald:{ tile: "from-emerald-500 to-teal-600", glow: "bg-emerald-500/20", btn: "bg-emerald-500 hover:bg-emerald-400 text-[var(--color-text)]", ring: "hover:border-emerald-400/40", hint: "text-emerald-700/80 dark:text-emerald-300/80" },
  };
  const a = A[accent];
  return (
    <div className={`group relative overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.03] dark:bg-[var(--color-surface)]/[0.03] p-4 transition-all hover:bg-black/[0.06] dark:bg-[var(--color-surface)]/[0.06] ${a.ring}`}>
      <div aria-hidden className={`pointer-events-none absolute -top-12 -right-12 w-32 h-32 rounded-full blur-2xl ${a.glow}`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${a.tile} flex items-center justify-center shadow-lg`}>
            <Icon className="w-5 h-5 text-[var(--color-text)]" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--color-text-muted)]">{label}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-4xl font-black text-[var(--color-text)] tabular-nums leading-none">
            {value === null ? "—" : value}
          </span>
          <span className={`text-xs font-bold ${a.hint}`}>{valueHint}</span>
        </div>
        <div className="mt-2 space-y-0.5">
          {stats.map((s, i) => (
            <div key={i} className={`text-[11px] font-semibold ${s.tone ?? (s.dim ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-muted)]")}`}>{s.label}</div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Link href={primary.href} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm transition-colors ${a.btn}`}>
            <primary.icon className="w-3.5 h-3.5" /> {primary.label}
          </Link>
          {secondary && (
            <Link href={secondary.href} className="inline-flex items-center gap-1 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
              {secondary.label} <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          )}
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
    if (assigned > 0) return `You have ${assigned} request${assigned === 1 ? "" : "s"} assigned — drafting is your lane today.`;
    if (markups > 0) return `${markups} markup request${markups === 1 ? "" : "s"} waiting on you.`;
    return "No requests assigned — check the pool for work to claim.";
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
  if (assigned > 0 || d.ticketsUnread.length > 0) return `Track your requests — ${d.ticketsUnread.length} ha${d.ticketsUnread.length === 1 ? "s" : "ve"} new activity.`;
  return null;
}

export function formatAgo(iso: string | undefined): string {
  if (!iso) return "—";
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
  lines.push(`#### My Inbox — ${new Date().toISOString().slice(0, 10)}${signedInAs ? ` · ${signedInAs}` : ""} ####`);
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
