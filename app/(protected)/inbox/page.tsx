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
  ChevronRight, Calendar, Download, Send, XCircle, Sparkles,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { computeNudges } from "@/lib/nudges";
import { useToast } from "@/components/providers/ToastProvider";
import { EmptyState as SharedEmptyState } from "@/components/ui/EmptyState";
import SetupChecklist from "@/components/onboarding/SetupChecklist";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";

export default function InboxPage() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const { showToast } = useToast();
  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    if (!uid || !activeOrgId) return;
    if (opts?.background) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const snap = await loadInbox(activeOrgId, uid, userEmail ?? undefined);
      setData(snap);
      setLastLoadedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [uid, activeOrgId, userEmail]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Keep the cockpit fresh without a manual click: refresh when the tab
  // regains focus/visibility, and on a 60s heartbeat while visible. Background
  // refreshes don't trigger the full-page spinner, so the view never flickers.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refresh({ background: true }); };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    const id = window.setInterval(tick, 60_000);
    return () => {
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
      window.clearInterval(id);
    };
  }, [refresh]);

  // Respond to a markup request right from the cockpit — closes the loop that
  // was previously one-way (the request had no in-app way to be answered).
  const respondToMarkup = async (
    mr: InboxSnapshot["markupRequestsToMe"][number],
    status: "shared" | "declined",
  ) => {
    if (!uid || !activeOrgId || resolvingId) return;
    setResolvingId(mr.id);
    try {
      await resolveMarkupRequest({
        markupRequestId: mr.id,
        status,
        orgId: activeOrgId,
        projectId: mr.projectId ?? undefined,
        actorUserId: uid,
        actorEmail: userEmail ?? undefined,
        actorRole: activeRole ?? undefined,
      });
      showToast({
        type: "success",
        title: status === "shared" ? "Marked as shared" : "Request declined",
        message: status === "shared"
          ? "The requester can see your markups are available."
          : "The requester has been told you declined.",
      });
      await refresh({ background: true });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't update the request", message: (e as Error).message });
    } finally {
      setResolvingId(null);
    }
  };

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
    + data.milestonesUpcoming.length + data.transmittalsAwaitingAck.length + data.unreadNotificationCount;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-6xl mx-auto p-6">
        <ViewTabs title="Home" tabs={HOME_VIEWS} />
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between mb-6 gap-4">
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
            {data && (() => {
              const focus = roleFocus(activeRole, data);
              return focus ? (
                <p className="text-xs font-bold text-orange-700 mt-1.5 inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> {focus}
                </p>
              ) : null;
            })()}
          </div>
          <div className="flex items-center gap-2">
            {lastLoadedAt && (
              <span className="hidden sm:inline text-[11px] text-slate-400 mr-1" title={new Date(lastLoadedAt).toLocaleString()}>
                Updated {formatAgo(new Date(lastLoadedAt).toISOString())}
              </span>
            )}
            <button
              onClick={() => data && exportInboxCsv(data, userEmail ?? undefined)}
              disabled={!data || total === 0}
              title="Download today's inbox as a CSV — useful for sending to email/Slack at end of day."
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700 disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
            <button
              onClick={() => void refresh()}
              disabled={loading || refreshing}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700 disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading || refreshing ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* First-run setup guidance for new orgs (admins only; self-hides). */}
        <SetupChecklist />

        {/* Proactive nudges — what to DO, derived from the snapshot. */}
        {data && (() => {
          const nudges = computeNudges(data);
          if (nudges.length === 0) return null;
          return (
            <div className="mb-4 rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50/40 p-4 shadow-sm">
              <div className="flex items-center gap-1.5 mb-2">
                <Sparkles className="w-4 h-4 text-orange-600" />
                <span className="text-sm font-black text-slate-900">Suggested actions</span>
              </div>
              <ul className="space-y-1.5">
                {nudges.map((n) => (
                  <li key={n.id} className="text-xs text-slate-700 flex items-start gap-2">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${n.severity === "high" ? "bg-rose-500" : "bg-amber-500"}`} />
                    <span className="flex-1">{n.message}</span>
                    {n.actionLabel && n.href && (
                      <Link href={n.href} className="font-bold text-orange-700 hover:text-orange-900 inline-flex items-center gap-0.5 shrink-0">
                        {n.actionLabel} <ChevronRight className="w-3 h-3" />
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        {!data ? null : total === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {data.unreadNotificationCount > 0 && (
              <Card icon={Bell} tone="amber" title="Unread notifications" count={data.unreadNotificationCount}>
                <p className="text-xs text-slate-600 mb-2">{data.unreadNotificationCount} item{data.unreadNotificationCount === 1 ? "" : "s"} in the bell-icon drawer.</p>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("mfgos:open-notifications"))}
                  className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 hover:text-amber-900"
                >
                  Open notifications <ChevronRight className="w-3 h-3" />
                </button>
              </Card>
            )}

            {data.markupRequestsToMe.length > 0 && (
              <Card icon={FileSignature} tone="violet" title="Markup requests for you" count={data.markupRequestsToMe.length}>
                <ul className="space-y-1.5">
                  {data.markupRequestsToMe.slice(0, 6).map((mr) => (
                    <li key={mr.id} className="text-xs">
                      <Link href={`/documents`} className="text-violet-700 hover:underline font-bold">
                        {mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)}
                      </Link>
                      {mr.requestedByName && <span className="text-slate-500"> · from {mr.requestedByName}</span>}
                      {mr.message && <div className="text-slate-600 truncate mt-0.5 italic">&quot;{mr.message}&quot;</div>}
                      <div className="mt-1 flex items-center gap-1.5">
                        <button
                          onClick={() => respondToMarkup(mr, "shared")}
                          disabled={resolvingId === mr.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-bold disabled:opacity-50"
                        >
                          <Send className="w-3 h-3" /> Mark shared
                        </button>
                        <button
                          onClick={() => respondToMarkup(mr, "declined")}
                          disabled={resolvingId === mr.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 text-[11px] font-bold disabled:opacity-50"
                        >
                          <XCircle className="w-3 h-3" /> Decline
                        </button>
                      </div>
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

            {data.transmittalsAwaitingAck.length > 0 && (
              <Card icon={Send} tone="blue" title="Transmittals awaiting receipt" count={data.transmittalsAwaitingAck.length}>
                <p className="text-xs text-slate-600 mb-2">Issued to a recipient who hasn&apos;t acknowledged yet — chase the receipt for a clean paper trail.</p>
                <ul className="space-y-1.5">
                  {data.transmittalsAwaitingAck.slice(0, 6).map((t) => (
                    <li key={t.id} className="text-xs flex items-center gap-2">
                      <Link href="/transmittals" className="font-mono font-bold text-blue-700 hover:underline shrink-0">{t.number}</Link>
                      <span className="text-slate-600 truncate flex-1">{t.subject || [t.recipientName, t.recipientCompany].filter(Boolean).join(" · ") || `${t.documentCount} doc${t.documentCount === 1 ? "" : "s"}`}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        (t.__ageDays ?? 0) >= 14 ? "bg-rose-100 text-rose-800"
                        : (t.__ageDays ?? 0) >= 7 ? "bg-amber-100 text-amber-800"
                        : "bg-slate-100 text-slate-600"
                      }`}>{t.__ageDays === 0 ? "today" : `${t.__ageDays}d`}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/transmittals" className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-700 hover:text-blue-900">
                  Transmittal register <ChevronRight className="w-3 h-3" />
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
      {tickets.slice(0, 6).map((t, i) => (
        <li key={t.id ?? `t-${i}`} className="text-xs flex items-center gap-2">
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
    <SharedEmptyState
      icon={InboxIcon}
      title="All caught up"
      description="Nothing assigned, unread, watching, checked out, on hold, or due this week."
    />
  );
}

// Role-aware "focus" line — the single thing this role most likely cares about
// right now, computed from the live snapshot. Keeps the shared cockpit but
// frames it for who's looking.
function roleFocus(role: string | null | undefined, d: InboxSnapshot): string | null {
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
