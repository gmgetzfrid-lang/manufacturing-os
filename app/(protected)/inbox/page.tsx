"use client";

// /inbox — personal cockpit. Aggregates every meaningful "needs your
// attention" surface across the product: tickets assigned to me,
// tickets with unread activity, tickets I'm watching, documents I
// hold checked out (with stale warnings), holds I opened, markup
// requests waiting on me, milestones due this week, unread notifs.
//
// Designed so a daily-user opens this first thing in the morning and
// can see everything outstanding without bouncing between five pages.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import ScratchpadStrip from "@/components/notes/ScratchpadStrip";
import { Briefcase, AlertOctagon, FileSignature, Lock, Bell, Loader2, AlertTriangle, MessageSquare, Clock, Flag, ChevronRight, Calendar, Send, XCircle, Zap } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { computeNudges } from "@/lib/nudges";
import { useToast } from "@/components/providers/ToastProvider";
import SetupChecklist from "@/components/onboarding/SetupChecklist";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { DailyBrief } from "@/components/cockpit/DailyBrief";
import { QuickLaunch } from "@/components/cockpit/QuickLaunch";
import { CommandDeck, roleFocus, formatAgo, exportInboxCsv, type PillarStats } from "@/components/cockpit/CommandDeck";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";

export default function InboxPage() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  // Same unified feed the sidebar badge + header bell use, so all three agree.
  const {
    items: attentionItems, count: attentionCount,
    actionRequiredCount, markRead, markAllRead,
  } = useTicketNotifications();
  const { showToast } = useToast();
  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [attnFilter, setAttnFilter] = useState<AttnFilter>("all");
  const [markingAll, setMarkingAll] = useState(false);
  const [pillars, setPillars] = useState<PillarStats>({ openRequests: 0, lockedDocs: 0, activeProjects: 0, loaded: false });

  // Org-wide headline numbers for the deck pillars. Independent + best-effort.
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void (async () => {
      const headCount = async (build: () => Promise<{ count: number | null }>) => {
        try { return (await build()).count ?? 0; } catch { return 0; }
      };
      const [openRequests, lockedDocs, activeProjects] = await Promise.all([
        headCount(() => supabase.from("tickets").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
        headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).not("checked_out_by", "is", null) as unknown as Promise<{ count: number | null }>),
        headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
      ]);
      if (alive) setPillars({ openRequests, lockedDocs, activeProjects, loaded: true });
    })();
    return () => { alive = false; };
  }, [activeOrgId, lastLoadedAt]);

  // Accurate per-filter counts (from the unified feed itself — the hook's
  // ticket-only counters don't include notification rows).
  const attnCounts = useMemo(() => ({
    all: attentionItems.length,
    action: attentionItems.filter((i) => i.actionRequired).length,
    unread: attentionItems.filter((i) => !i.actionRequired).length,
  }), [attentionItems]);

  // Filtered attention feed for the segmented control.
  const filteredAttention = useMemo(() => {
    if (attnFilter === "action") return attentionItems.filter((i) => i.actionRequired);
    if (attnFilter === "unread") return attentionItems.filter((i) => !i.actionRequired);
    return attentionItems;
  }, [attentionItems, attnFilter]);

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    try {
      await markAllRead();
      showToast({ type: "success", title: "All caught up", message: "Cleared your unread notifications." });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't mark all read", message: (e as Error).message });
    } finally {
      setMarkingAll(false);
    }
  }, [markAllRead, showToast]);

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
      <div className="min-h-screen bg-[var(--color-canvas)] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-muted)]" />
      </div>
    );
  }

  // One attention count (action-required + unread tickets + notifications) shared
  // with the sidebar + bell, plus the inbox-only buckets (watching/checkouts/…).
  const total = attentionCount
    + (data ? data.ticketsWatching.length + data.myCheckouts.length + data.myOpenHolds.length
      + data.markupRequestsToMe.length + data.milestonesUpcoming.length + data.transmittalsAwaitingAck.length : 0);

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] pb-24">
      <div className="max-w-6xl mx-auto p-6">
        <ViewTabs title="Home" tabs={HOME_VIEWS} />

        {/* ── COMMAND DECK ─────────────────────────────────────────────
            The cockpit hero: personal greeting + the three main attractions
            (Requests · Documents · Projects) as live, deep-linked pillars
            with their own primary actions, on a dark high-tech band. ── */}
        <CommandDeck
          userEmail={userEmail ?? undefined}
          data={data}
          pillars={pillars}
          attentionCount={attentionCount}
          actionCount={actionRequiredCount}
          focus={data ? roleFocus(activeRole, data) : null}
          lastLoadedAt={lastLoadedAt}
          refreshing={loading || refreshing}
          canExport={!!data && total > 0}
          onRefresh={() => void refresh()}
          onExport={() => data && exportInboxCsv(data, userEmail ?? undefined)}
        />

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* First-run setup guidance for new orgs (admins only; self-hides). */}
        <SetupChecklist />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* Left rail (2/3): the brief + the rich attention feed. */}
          <div className="lg:col-span-2 space-y-4">
            {/* Daily Brief — narrated synthesis of the day. */}
            {data && <DailyBrief data={data} />}

            {/* Proactive nudges — what to DO, derived from the snapshot. */}
            {data && (() => {
              const nudges = computeNudges(data);
              if (nudges.length === 0) return null;
              return (
                <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50/40 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Zap className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-black text-[var(--color-text)]">Suggested actions</span>
                  </div>
                  <ul className="space-y-1.5">
                    {nudges.map((n) => (
                      <li key={n.id} className="text-xs text-[var(--color-text-faint)] flex items-start gap-2">
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

            {/* Rich, filterable, actionable attention feed. */}
            <AttentionFeed
              items={filteredAttention}
              counts={attnCounts}
              filter={attnFilter}
              onFilter={setAttnFilter}
              onMarkRead={(id) => { void markRead(id); }}
              onMarkAll={handleMarkAll}
              markingAll={markingAll}
            />
          </div>

          {/* Right rail (1/3): quick launch pad. */}
          <div className="space-y-4">
            <ScratchpadStrip />
            <QuickLaunch />
          </div>
        </div>

        {!data || total === 0 ? null : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {data.markupRequestsToMe.length > 0 && (
              <Card icon={FileSignature} tone="violet" title="Markup requests for you" count={data.markupRequestsToMe.length}>
                <ul className="space-y-1.5">
                  {data.markupRequestsToMe.slice(0, 6).map((mr) => (
                    <li key={mr.id} className="text-xs">
                      <Link href={`/documents`} className="text-violet-700 hover:underline font-bold">
                        {mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)}
                      </Link>
                      {mr.requestedByName && <span className="text-[var(--color-text-muted)]"> · from {mr.requestedByName}</span>}
                      {mr.message && <div className="text-[var(--color-text-faint)] truncate mt-0.5 italic">&quot;{mr.message}&quot;</div>}
                      <div className="mt-1 flex items-center gap-1.5">
                        <button
                          onClick={() => respondToMarkup(mr, "shared")}
                          disabled={resolvingId === mr.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-[var(--color-text)] text-[11px] font-bold disabled:opacity-50"
                        >
                          <Send className="w-3 h-3" /> Mark shared
                        </button>
                        <button
                          onClick={() => respondToMarkup(mr, "declined")}
                          disabled={resolvingId === mr.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-canvas)] text-[var(--color-text-faint)] text-[11px] font-bold disabled:opacity-50"
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
                    <li key={s.id} className="text-xs flex items-center gap-2">
                      <DocHoverPreview documentId={s.documentId}>
                        <DocThumb documentId={s.documentId} width={28} />
                      </DocHoverPreview>
                      <span className="font-mono text-[var(--color-text-muted)]">{s.mode}</span>
                      <Link href={`/documents/${s.libraryId ?? ""}?doc=${s.documentId}`} className="text-blue-700 hover:underline font-bold">
                        {s.documentId.slice(0, 8)}
                      </Link>
                      {s.purpose && <span className="text-[var(--color-text-faint)] truncate">— {s.purpose}</span>}
                      <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{formatAgo(typeof s.startedAt === "string" ? s.startedAt : undefined)}</span>
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
                      {h.notes && <div className="text-[var(--color-text-faint)] truncate mt-0.5 italic">&quot;{h.notes}&quot;</div>}
                      <div className="text-[10px] text-[var(--color-text-muted)]">opened {formatAgo(typeof h.openedAt === "string" ? h.openedAt : undefined)}</div>
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
                <p className="text-xs text-[var(--color-text-faint)] mb-2">Issued to a recipient who hasn&apos;t acknowledged yet — chase the receipt for a clean paper trail.</p>
                <ul className="space-y-1.5">
                  {data.transmittalsAwaitingAck.slice(0, 6).map((t) => (
                    <li key={t.id} className="text-xs flex items-center gap-2">
                      <Link href="/transmittals" className="font-mono font-bold text-blue-700 hover:underline shrink-0">{t.number}</Link>
                      <span className="text-[var(--color-text-faint)] truncate flex-1">{t.subject || [t.recipientName, t.recipientCompany].filter(Boolean).join(" · ") || `${t.documentCount} doc${t.documentCount === 1 ? "" : "s"}`}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        (t.__ageDays ?? 0) >= 14 ? "bg-rose-100 text-rose-800"
                        : (t.__ageDays ?? 0) >= 7 ? "bg-amber-100 text-amber-800"
                        : "bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"
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
                      <Calendar className="w-3 h-3 text-emerald-600 dark:text-emerald-500 shrink-0" />
                      <span className="font-bold text-[var(--color-text)] truncate flex-1">{m.name}</span>
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
    slate:  "border-[var(--color-border)] bg-[var(--color-canvas)]",
  };
  const iconTones: Record<CardProps["tone"], string> = {
    indigo: "text-indigo-700",
    orange: "text-orange-700",
    amber:  "text-amber-700",
    rose:   "text-rose-700",
    blue:   "text-blue-700",
    emerald:"text-emerald-700",
    violet: "text-violet-700",
    slate:  "text-[var(--color-text-faint)]",
  };
  return (
    <div className={`rounded-2xl border ${tones[tone]} shadow-sm p-4`}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-black text-[var(--color-text)] inline-flex items-center gap-1.5">
          <Icon className={`w-4 h-4 ${iconTones[tone]}`} />
          {title}
        </h2>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[11px] font-black ${iconTones[tone]}`}>{count}</span>
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
          <span className="font-mono text-[var(--color-text-muted)]">{t.ticketId ?? "—"}</span>
          <Link href={`/requests/${t.id ?? ""}`} className="text-[var(--color-text)] hover:text-indigo-700 font-bold truncate flex-1">
            {t.title ?? "(untitled)"}
          </Link>
          <span className="text-[10px] font-bold uppercase text-[var(--color-text-faint)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded">{t.status ?? "—"}</span>
          <span className="text-[10px] text-[var(--color-text-muted)]"><Clock className="inline w-2.5 h-2.5 mr-0.5" />{formatAgo(typeof t.lastModified === "string" ? t.lastModified : undefined)}</span>
        </li>
      ))}
    </ul>
  );
}

