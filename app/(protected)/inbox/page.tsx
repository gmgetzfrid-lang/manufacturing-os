"use client";

// /inbox — personal cockpit. Aggregates every meaningful "needs your
// attention" surface across the product: tickets assigned to me,
// tickets with unread activity, tickets I'm watching, documents I
// hold checked out (with stale warnings), holds I opened, markup
// requests waiting on me, milestones due this week, unread notifs.
//
// Designed so a daily-user opens this first thing in the morning and
// can see everything outstanding without bouncing between five pages.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Inbox as InboxIcon, Briefcase, AlertOctagon, FileSignature, Lock,
  Bell, Loader2, RefreshCw, AlertTriangle, MessageSquare, Clock, Flag,
  ChevronRight, Calendar, Download,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";

export default function InboxPage() {
  const { uid, userEmail, activeOrgId } = useRole();
  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!uid || !activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const snap = await loadInbox(activeOrgId, uid, userEmail ?? undefined);
      setData(snap);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [uid, activeOrgId, userEmail]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const total = !data ? 0
    : data.ticketsAssigned.length + data.ticketsUnread.length + data.ticketsWatching.length
    + data.myCheckouts.length + data.myOpenHolds.length + data.markupRequestsToMe.length
    + data.milestonesUpcoming.length + data.unreadNotificationCount;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              <InboxIcon className="w-7 h-7 text-orange-500" /> My Inbox
              {data && total > 0 && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-orange-500 text-white text-sm font-black">
                  {total}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Everything that needs your attention across the product, in one place. {userEmail && <span className="text-slate-400">· signed in as {userEmail}</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => data && exportInboxCsv(data, userEmail ?? undefined)}
              disabled={!data || total === 0}
              title="Download today's inbox as a CSV — useful for sending to email/Slack at end of day."
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700 disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {!data ? null : total === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {data.unreadNotificationCount > 0 && (
              <Card icon={Bell} tone="amber" title="Unread notifications" count={data.unreadNotificationCount}>
                <p className="text-xs text-slate-600 mb-2">{data.unreadNotificationCount} item{data.unreadNotificationCount === 1 ? "" : "s"} in the bell-icon drawer.</p>
                <Link href="/dashboard" className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:text-amber-900">
                  Open via the bell <ChevronRight className="w-3 h-3" />
                </Link>
              </Card>
            )}

            {data.markupRequestsToMe.length > 0 && (
              <Card icon={FileSignature} tone="violet" title="Markup requests for you" count={data.markupRequestsToMe.length}>
                <ul className="space-y-1.5">
                  {data.markupRequestsToMe.slice(0, 6).map((mr) => (
                    <li key={mr.id} className="text-xs">
                      <Link href={`/requests`} className="text-violet-700 hover:underline font-bold">
                        {mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)}
                      </Link>
                      {mr.requestedByName && <span className="text-slate-500"> · from {mr.requestedByName}</span>}
                      {mr.message && <div className="text-slate-600 truncate mt-0.5 italic">&quot;{mr.message}&quot;</div>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data.ticketsAssigned.length > 0 && (
              <Card icon={Briefcase} tone="indigo" title="Tickets assigned to you" count={data.ticketsAssigned.length}>
                <TicketList tickets={data.ticketsAssigned} />
              </Card>
            )}

            {data.ticketsUnread.length > 0 && (
              <Card icon={MessageSquare} tone="orange" title="Unread activity" count={data.ticketsUnread.length}>
                <TicketList tickets={data.ticketsUnread} />
              </Card>
            )}

            {data.ticketsWatching.length > 0 && (
              <Card icon={Bell} tone="slate" title="Watching" count={data.ticketsWatching.length}>
                <TicketList tickets={data.ticketsWatching} />
              </Card>
            )}

            {data.myCheckouts.length > 0 && (
              <Card icon={Lock} tone={data.myStaleCheckouts.length > 0 ? "rose" : "blue"} title="Your active checkouts" count={data.myCheckouts.length}>
                {data.myStaleCheckouts.length > 0 && (
                  <div className="mb-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                    <AlertTriangle className="inline w-3 h-3 mr-1" />
                    {data.myStaleCheckouts.length} past expected release — please check in or extend
                  </div>
                )}
                <ul className="space-y-1.5">
                  {data.myCheckouts.slice(0, 6).map((s) => (
                    <li key={s.id} className="text-xs flex items-center gap-1.5">
                      <span className="font-mono text-slate-500">{s.mode}</span>
                      <span className="text-slate-300">·</span>
                      <Link href={`/documents/${s.libraryId ?? ""}?doc=${s.documentId}`} className="text-blue-700 hover:underline font-bold">
                        {s.documentId.slice(0, 8)}
                      </Link>
                      {s.purpose && <span className="text-slate-600 truncate">— {s.purpose}</span>}
                      <span className="ml-auto text-[10px] text-slate-400">{formatAgo(typeof s.startedAt === "string" ? s.startedAt : undefined)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data.myOpenHolds.length > 0 && (
              <Card icon={AlertOctagon} tone="rose" title="Holds you opened" count={data.myOpenHolds.length}>
                <ul className="space-y-1.5">
                  {data.myOpenHolds.slice(0, 6).map((h) => (
                    <li key={h.id} className="text-xs">
                      <span className="font-bold text-rose-700">{h.reason}</span>
                      {h.notes && <div className="text-slate-600 truncate mt-0.5 italic">&quot;{h.notes}&quot;</div>}
                      <div className="text-[10px] text-slate-400">opened {formatAgo(typeof h.openedAt === "string" ? h.openedAt : undefined)}</div>
                    </li>
                  ))}
                </ul>
                <Link href="/admin/holds" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-rose-700 hover:text-rose-900">
                  Hold queue <ChevronRight className="w-3 h-3" />
                </Link>
              </Card>
            )}

            {data.milestonesUpcoming.length > 0 && (
              <Card icon={Flag} tone="emerald" title="Milestones due this week" count={data.milestonesUpcoming.length}>
                <ul className="space-y-1.5">
                  {data.milestonesUpcoming.slice(0, 8).map((m) => (
                    <li key={m.id} className="text-xs flex items-center gap-2">
                      <Calendar className="w-3 h-3 text-emerald-500 shrink-0" />
                      <span className="font-bold text-slate-900 truncate flex-1">{m.name}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        (m.__dueInDays ?? 0) === 0 ? "bg-rose-100 text-rose-800"
                        : (m.__dueInDays ?? 0) <= 2 ? "bg-amber-100 text-amber-800"
                        : "bg-emerald-100 text-emerald-800"
                      }`}>
                        {(m.__dueInDays ?? 0) === 0 ? "today" : `${m.__dueInDays}d`}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
  tone: "indigo" | "orange" | "amber" | "rose" | "blue" | "emerald" | "violet" | "slate";
  children: React.ReactNode;
}
function Card({ icon: Icon, title, count, tone, children }: CardProps) {
  const tones: Record<CardProps["tone"], string> = {
    indigo: "border-indigo-200 bg-indigo-50/40",
    orange: "border-orange-200 bg-orange-50/40",
    amber:  "border-amber-200 bg-amber-50/40",
    rose:   "border-rose-200 bg-rose-50/40",
    blue:   "border-blue-200 bg-blue-50/40",
    emerald:"border-emerald-200 bg-emerald-50/40",
    violet: "border-violet-200 bg-violet-50/40",
    slate:  "border-slate-200 bg-slate-50/40",
  };
  const iconTones: Record<CardProps["tone"], string> = {
    indigo: "text-indigo-700",
    orange: "text-orange-700",
    amber:  "text-amber-700",
    rose:   "text-rose-700",
    blue:   "text-blue-700",
    emerald:"text-emerald-700",
    violet: "text-violet-700",
    slate:  "text-slate-700",
  };
  return (
    <div className={`rounded-2xl border ${tones[tone]} shadow-sm p-4`}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-black text-slate-900 inline-flex items-center gap-1.5">
          <Icon className={`w-4 h-4 ${iconTones[tone]}`} />
          {title}
        </h2>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full bg-white border border-slate-200 text-[11px] font-black ${iconTones[tone]}`}>{count}</span>
      </div>
      {children}
    </div>
  );
}

interface TicketListItem {
  id?: string;
  ticketId?: string;
  title?: string;
  status?: string;
  lastModified?: unknown;
}
function TicketList({ tickets }: { tickets: TicketListItem[] }) {
  return (
    <ul className="space-y-1.5">
      {tickets.slice(0, 6).map((t) => (
        <li key={t.id ?? Math.random()} className="text-xs flex items-center gap-2">
          <span className="font-mono text-slate-400">{t.ticketId ?? "—"}</span>
          <Link href={`/requests/${t.id ?? ""}`} className="text-slate-900 hover:text-indigo-700 font-bold truncate flex-1">
            {t.title ?? "(untitled)"}
          </Link>
          <span className="text-[10px] font-bold uppercase text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">{t.status ?? "—"}</span>
          <span className="text-[10px] text-slate-400"><Clock className="inline w-2.5 h-2.5 mr-0.5" />{formatAgo(typeof t.lastModified === "string" ? t.lastModified : undefined)}</span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 mx-auto flex items-center justify-center mb-4">
        <InboxIcon className="w-7 h-7 text-emerald-600" />
      </div>
      <h2 className="text-lg font-black text-slate-900">All caught up</h2>
      <p className="text-sm text-slate-500 mt-1">Nothing assigned, unread, watching, checked out, on hold, or due this week.</p>
    </div>
  );
}

function formatAgo(iso: string | undefined): string {
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
function exportInboxCsv(d: InboxSnapshot, signedInAs?: string) {
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
