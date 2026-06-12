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
import {
  Briefcase, AlertOctagon, FileSignature, Lock,
  Bell, Loader2, RefreshCw, AlertTriangle, MessageSquare, Clock, Flag,
  ChevronRight, Calendar, Download, Send, XCircle, Sparkles, ClipboardList,
  Plus, ArrowRight, FileStack, FolderKanban, CheckCheck, AtSign, Zap,
  GitBranch, Layers,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { useTicketNotifications, type AttentionItem } from "@/hooks/useTicketNotifications";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { computeNudges } from "@/lib/nudges";
import { useToast } from "@/components/providers/ToastProvider";
import SetupChecklist from "@/components/onboarding/SetupChecklist";
import ViewTabs, { HOME_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";

// Headline counts for the three command-deck pillars. Fetched separately from
// the personal inbox snapshot (org-wide numbers), each guarded so a missing
// table/column degrades that one stat to 0 instead of blanking the deck.
interface PillarStats {
  openRequests: number;
  lockedDocs: number;
  activeProjects: number;
  loaded: boolean;
}
type AttnFilter = "all" | "action" | "unread";

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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // One attention count (action-required + unread tickets + notifications) shared
  // with the sidebar + bell, plus the inbox-only buckets (watching/checkouts/…).
  const total = attentionCount
    + (data ? data.ticketsWatching.length + data.myCheckouts.length + data.myOpenHolds.length
      + data.markupRequestsToMe.length + data.milestonesUpcoming.length + data.transmittalsAwaitingAck.length : 0);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
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
            <QuickActions />
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
                    <li key={s.id} className="text-xs flex items-center gap-2">
                      <DocHoverPreview documentId={s.documentId}>
                        <DocThumb documentId={s.documentId} width={28} />
                      </DocHoverPreview>
                      <span className="font-mono text-slate-500">{s.mode}</span>
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

// ─── COMMAND DECK ──────────────────────────────────────────────────────────
// The cockpit hero. A dark, high-tech band: personal greeting + ops status on
// the left, and the three main attractions (Requests · Documents · Projects)
// as live, deep-linked pillars with their own primary actions.

interface CommandDeckProps {
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
}

function CommandDeck({
  userEmail, data, pillars, attentionCount, actionCount, focus,
  lastLoadedAt, refreshing, canExport, onRefresh, onExport,
}: CommandDeckProps) {
  const name = userEmail?.split("@")[0];
  const stale = data?.myStaleCheckouts.length ?? 0;

  return (
    <div className="relative overflow-hidden rounded-3xl mb-4 border border-slate-800 bg-slate-950 text-slate-200 shadow-2xl shadow-slate-900/30">
      {/* Ambient glows + grid texture for the "console" feel. */}
      <div aria-hidden className="pointer-events-none absolute -top-24 -left-16 w-72 h-72 rounded-full bg-orange-500/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 right-1/4 w-72 h-72 rounded-full bg-blue-500/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -top-10 right-0 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)", backgroundSize: "28px 28px" }}
      />

      <div className="relative p-5 sm:p-6">
        {/* Top status row */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Mission control · live</span>
            </div>
            <h1 className="text-2xl font-black text-white">
              {greeting()}{name ? <>, <span className="text-orange-400">{name}</span></> : ""}.
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              {focus || "Everything that needs you, and the work you run — in one place."}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:flex items-center gap-3 mr-1 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10">
              <DeckStat label="Needs you" value={attentionCount} tone={attentionCount > 0 ? "text-orange-400" : "text-slate-300"} />
              <span className="w-px h-6 bg-white/10" />
              <DeckStat label="Action" value={actionCount} tone={actionCount > 0 ? "text-rose-400" : "text-slate-300"} />
            </div>
            <button
              onClick={onExport}
              disabled={!canExport}
              title="Download today's inbox as a CSV"
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs font-bold text-slate-200 disabled:opacity-40 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Export</span>
            </button>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs font-bold text-slate-200 disabled:opacity-60 transition-colors"
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
                ? { label: `${stale} past due`, tone: "text-rose-300" }
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
            secondary={{ label: "Coordination", href: "/war-room" }}
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
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
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
    orange: { tile: "from-orange-500 to-amber-600", glow: "bg-orange-500/20", btn: "bg-orange-500 hover:bg-orange-400 text-white", ring: "hover:border-orange-400/40", hint: "text-orange-300/80" },
    blue:   { tile: "from-blue-500 to-indigo-600", glow: "bg-blue-500/20", btn: "bg-blue-500 hover:bg-blue-400 text-white", ring: "hover:border-blue-400/40", hint: "text-blue-300/80" },
    emerald:{ tile: "from-emerald-500 to-teal-600", glow: "bg-emerald-500/20", btn: "bg-emerald-500 hover:bg-emerald-400 text-white", ring: "hover:border-emerald-400/40", hint: "text-emerald-300/80" },
  };
  const a = A[accent];
  return (
    <div className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:bg-white/[0.06] ${a.ring}`}>
      <div aria-hidden className={`pointer-events-none absolute -top-12 -right-12 w-32 h-32 rounded-full blur-2xl ${a.glow}`} />
      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${a.tile} flex items-center justify-center shadow-lg`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">{label}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-4xl font-black text-white tabular-nums leading-none">
            {value === null ? "—" : value}
          </span>
          <span className={`text-xs font-bold ${a.hint}`}>{valueHint}</span>
        </div>
        <div className="mt-2 space-y-0.5">
          {stats.map((s, i) => (
            <div key={i} className={`text-[11px] font-semibold ${s.tone ?? (s.dim ? "text-slate-500" : "text-slate-400")}`}>{s.label}</div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Link href={primary.href} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold shadow-sm transition-colors ${a.btn}`}>
            <primary.icon className="w-3.5 h-3.5" /> {primary.label}
          </Link>
          {secondary && (
            <Link href={secondary.href} className="inline-flex items-center gap-1 text-xs font-bold text-slate-400 hover:text-white transition-colors">
              {secondary.label} <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ATTENTION FEED ────────────────────────────────────────────────────────
// The notifications, reimagined: color-coded by type, action items flagged and
// pulled to the eye, relative timestamps, one-tap mark-read on notification
// rows, a filter, and "mark all read". The SAME unified items the sidebar
// badge + header bell show — just made to actually work as a surface.

const FEED_TONES: Record<string, string> = {
  orange: "bg-orange-50 text-orange-600 border-orange-200",
  blue: "bg-blue-50 text-blue-600 border-blue-200",
  indigo: "bg-indigo-50 text-indigo-600 border-indigo-200",
  violet: "bg-violet-50 text-violet-600 border-violet-200",
  rose: "bg-rose-50 text-rose-600 border-rose-200",
  amber: "bg-amber-50 text-amber-600 border-amber-200",
  emerald: "bg-emerald-50 text-emerald-600 border-emerald-200",
  slate: "bg-slate-100 text-slate-500 border-slate-200",
};

function attentionVisual(item: AttentionItem): { Icon: React.ComponentType<{ className?: string }>; tone: string } {
  if (item.actionRequired) return { Icon: Zap, tone: "orange" };
  const k = String(item.kind).toLowerCase();
  if (k.includes("mention")) return { Icon: AtSign, tone: "violet" };
  if (k.includes("comment") || k.includes("message")) return { Icon: MessageSquare, tone: "blue" };
  if (k.includes("conflict")) return { Icon: AlertTriangle, tone: "amber" };
  if (k.includes("checkout") || k.includes("lock")) return { Icon: Lock, tone: "indigo" };
  if (k.includes("markup")) return { Icon: FileSignature, tone: "violet" };
  if (k.includes("hold")) return { Icon: AlertOctagon, tone: "rose" };
  if (k.includes("milestone")) return { Icon: Flag, tone: "emerald" };
  if (k.includes("rev") || k.includes("revision") || k.includes("version")) return { Icon: GitBranch, tone: "blue" };
  if (k.includes("transmittal")) return { Icon: Send, tone: "blue" };
  if (k.includes("approval") || k.includes("request") || k.includes("assign")) return { Icon: Briefcase, tone: "orange" };
  if (k.includes("equipment") || k.includes("asset")) return { Icon: Layers, tone: "amber" };
  return { Icon: Bell, tone: "slate" };
}

interface AttentionFeedProps {
  items: AttentionItem[];
  counts: { all: number; action: number; unread: number };
  filter: AttnFilter;
  onFilter: (f: AttnFilter) => void;
  onMarkRead: (id: string) => void;
  onMarkAll: () => void;
  markingAll: boolean;
}

function AttentionFeed({ items, counts, filter, onFilter, onMarkRead, onMarkAll, markingAll }: AttentionFeedProps) {
  const FILTERS: Array<{ key: AttnFilter; label: string; n: number }> = [
    { key: "all", label: "All", n: counts.all },
    { key: "action", label: "Action", n: counts.action },
    { key: "unread", label: "Activity", n: counts.unread },
  ];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2 flex-wrap">
        <ClipboardList className="w-4 h-4 text-orange-500" />
        <span className="text-sm font-black text-slate-900">Needs your attention</span>
        {counts.all > 0 && (
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-orange-500 text-white text-xs font-black">{counts.all}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Segmented filter */}
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 border border-slate-200">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => onFilter(f.key)}
                className={`inline-flex items-center gap-1 px-2 h-6 rounded-md text-[11px] font-bold transition-colors ${
                  filter === f.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {f.label}
                <span className={`text-[10px] ${filter === f.key ? "text-orange-600" : "text-slate-400"}`}>{f.n}</span>
              </button>
            ))}
          </div>
          {counts.unread > 0 && (
            <button
              onClick={onMarkAll}
              disabled={markingAll}
              title="Mark all notifications read"
              className="inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              {markingAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCheck className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Mark all read</span>
            </button>
          )}
        </div>
      </div>

      {counts.all === 0 ? (
        <div className="px-4 py-10 text-center">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center mb-3">
            <CheckCheck className="w-6 h-6 text-emerald-500" />
          </div>
          <div className="text-sm font-bold text-slate-800">You&apos;re all caught up</div>
          <div className="text-xs text-slate-400 mt-1">Nothing needs your attention right now.</div>
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-slate-400 italic">Nothing in this filter.</div>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
          {items.slice(0, 30).map((item) => (
            <AttentionRow key={item.key} item={item} onMarkRead={onMarkRead} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AttentionRow({ item, onMarkRead }: { item: AttentionItem; onMarkRead: (id: string) => void }) {
  const { Icon, tone } = attentionVisual(item);
  return (
    <li className="relative group">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${item.actionRequired ? "bg-orange-400" : "bg-transparent group-hover:bg-slate-200"}`} />
      <Link
        href={item.link}
        onClick={() => { if (item.notificationId) onMarkRead(item.notificationId); }}
        className="flex items-center gap-3 pl-4 pr-3 py-2.5 hover:bg-slate-50"
      >
        <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${FEED_TONES[tone] ?? FEED_TONES.slate}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-slate-900 truncate">{item.title}</div>
          <div className={`text-[11px] font-semibold truncate ${item.actionRequired ? "text-orange-700" : "text-slate-500"}`}>
            {item.subtitle || "New activity"}
          </div>
        </div>
        {item.actionRequired && (
          <span className="text-[9px] font-black uppercase tracking-wider text-orange-600 bg-orange-50 border border-orange-200 rounded px-1.5 py-0.5 shrink-0">Action</span>
        )}
        <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{formatAgo(item.when || undefined)}</span>
        {item.notificationId ? (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkRead(item.notificationId!); }}
            title="Mark read"
            className="p-1 rounded-md text-slate-300 hover:text-emerald-600 hover:bg-emerald-50 shrink-0"
          >
            <CheckCheck className="w-3.5 h-3.5" />
          </button>
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
        )}
      </Link>
    </li>
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

// Daily Brief — turns the raw snapshot into a narrated "here's your day".
// Deterministic (reliable + offline), so it always reads like a smart summary
// rather than a list. Time-of-day greeting + the few things that actually
// matter, with the most urgent surfaced first.
function buildBriefSentences(d: InboxSnapshot): string[] {
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
  if (checkouts > 0) s.push(`${checkouts} document${checkouts === 1 ? "" : "s"} checked out${stale > 0 ? ` (${stale} past due — worth releasing)` : ""}`);
  if (holds > 0) s.push(`${holds} hold${holds === 1 ? "" : "s"} you opened still blocking work`);
  if (acks > 0) s.push(`${acks} transmittal${acks === 1 ? "" : "s"} awaiting the recipient's acknowledgement`);
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
function topAction(d: InboxSnapshot): { label: string; href: string } | null {
  if (d.myStaleCheckouts.length > 0)
    return { label: `Release a stale checkout (${d.myStaleCheckouts.length} past due)`, href: "/checkouts" };
  if (d.markupRequestsToMe.length > 0)
    return { label: `Respond to ${d.markupRequestsToMe.length} markup request${d.markupRequestsToMe.length === 1 ? "" : "s"}`, href: "/inbox" };
  if (d.ticketsAssigned.length > 0) {
    const t = d.ticketsAssigned[0];
    return { label: `Open your next request${t.ticketId ? ` — ${t.ticketId}` : ""}`, href: t.id ? `/requests/${t.id}` : "/requests" };
  }
  if (d.myOpenHolds.length > 0)
    return { label: `Clear an open hold (${d.myOpenHolds.length})`, href: "/admin/holds" };
  const overdue = d.milestonesUpcoming.find((m) => (m.__dueInDays ?? 99) <= 0);
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

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function DailyBrief({ data }: { data: InboxSnapshot }) {
  const sentences = buildBriefSentences(data);
  const urgent = data.myStaleCheckouts.length + data.markupRequestsToMe.length + data.myOpenHolds.length;
  const next = topAction(data);

  const narrative = sentences.length === 0
    ? "Your queue is clear — nothing needs you right now. Good time to get ahead on something."
    : `You have ${sentences[0]}${sentences.length > 1 ? `, plus ${sentences.length - 1} more thing${sentences.length - 1 === 1 ? "" : "s"} below` : ""}.`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-sm p-5">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-700 flex items-center justify-center shadow-sm shrink-0">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-black uppercase tracking-widest text-slate-400">Daily brief</h2>
            {urgent > 0 && <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-rose-600 bg-rose-50 border border-rose-100 rounded-full px-2 py-0.5">{urgent} urgent</span>}
          </div>
          <p className="text-sm text-slate-700 mt-1 leading-relaxed">{narrative}</p>
          {next && (
            <Link href={next.href} className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 transition-colors">
              <span className="text-[10px] font-black uppercase tracking-wider text-orange-400">Start here</span>
              {next.label}
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {sentences.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {sentences.map((line, i) => (
                <span key={i} className="inline-flex items-center text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-full px-2.5 py-1">{line}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Quick-action launcher — the common "start something" entry points, so Home
// is a place you DO things from, not just a list that's sometimes empty.
const QUICK_ACTIONS: Array<{ label: string; sub: string; href?: string; icon: React.ComponentType<{ className?: string }>; tone: string; action?: "search" }> = [
  { label: "New request", sub: "Drafting / design", href: "/requests/new", icon: Send, tone: "text-orange-600 bg-orange-50" },
  { label: "Documents", sub: "Browse & check out", href: "/documents", icon: Briefcase, tone: "text-blue-600 bg-blue-50" },
  { label: "New note", sub: "Scratchpad", href: "/scratchpad", icon: MessageSquare, tone: "text-amber-600 bg-amber-50" },
  { label: "Coordination", sub: "Collisions & blockers", href: "/war-room", icon: Sparkles, tone: "text-rose-600 bg-rose-50" },
  { label: "Search", sub: "⌘K everything", action: "search", icon: RefreshCw, tone: "text-slate-600 bg-slate-100" },
];

function QuickActions() {
  const openSearch = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Zap className="w-4 h-4 text-slate-400" />
        <span className="text-xs font-black uppercase tracking-wider text-slate-500">Quick launch</span>
      </div>
      <div className="p-2">
        {QUICK_ACTIONS.map((a) => {
          const inner = (
            <div className="group flex items-center gap-3 rounded-xl p-2.5 hover:bg-slate-50 transition-colors">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${a.tone}`}><a.icon className="w-4 h-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-900 truncate">{a.label}</div>
                <div className="text-[11px] text-slate-400 truncate">{a.sub}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>
          );
          return a.href
            ? <Link key={a.label} href={a.href} className="block">{inner}</Link>
            : <button key={a.label} onClick={openSearch} className="text-left w-full block">{inner}</button>;
        })}
      </div>
    </div>
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
