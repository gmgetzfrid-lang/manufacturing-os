"use client";

// Dashboard widget catalog + body renderers.
//
// Each catalog entry carries the chrome metadata (title, icon, tone, the tool
// it links to), a default 2D size (`defaultW` columns / `defaultH` row-units)
// plus optional min sizes, and a `Body` component that renders rich, best-effort
// "insights" for that tool. Every data fetch is guarded so a missing
// table/column degrades the widget gracefully rather than breaking the
// dashboard. Per-item rows link to the individual record; the WidgetFrame
// footer is the explicit "open the whole tool" affordance.
//
// Bodies are written to FILL their widget's height: each returns a flex-column
// root, and any list scrolls internally (flex-1 + overflow-y-auto) so a tall
// widget shows more rows and a wide widget flows its content horizontally
// instead of leaving whitespace.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  FileStack, MailPlus, Inbox as InboxIcon, Briefcase, Activity as ActivityIcon,
  Tag, Users, BarChart3, ScrollText, ChevronRight, Settings2,
  Plus, Zap, Rocket, Loader2, Bell, Layers, Send,
  XCircle, LayoutDashboard,
  Sparkles,
  type LucideIcon, History, PenLine, FileLock, OctagonPause, Flag, CircleAlert,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/friendlyError";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useNotificationsSeen } from "@/components/notifications/seen";
import { useRole } from "@/components/providers/RoleContext";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { computeNudges } from "@/lib/nudges";
import { resolveMarkupRequest } from "@/lib/markupRequests";
import { useTicketNotifications } from "@/hooks/useTicketNotifications";
import { DailyBrief } from "@/components/cockpit/DailyBrief";
import { QuickLaunch } from "@/components/cockpit/QuickLaunch";
import { AttentionFeed, type AttnFilter } from "@/components/cockpit/AttentionFeed";
import {
  CommandDeck, roleFocus, exportInboxCsv, formatAgo, type PillarStats,
} from "@/components/cockpit/CommandDeck";
import { MiniBars, TrendChip, dayBuckets } from "./viz";
import { FactRow, StatusTag, rowBtn, link, SectionHead } from "@/components/cockpit/ui";
import AskKnowledgeBody from "./bodies/AskKnowledgeBody";
import DocBrowserBody from "./bodies/DocBrowserBody";
import {
  DraftingRequestsBody, ProjectsBody, ActivityBody, EquipmentBody, RecentDocsBody, AdminUsersBody, AdminAuditBody,
} from "./bodies/WorkBodies";
import type { DashboardWidget, WidgetType, WidgetSettingField } from "@/lib/dashboard/types";
import { badgeText } from "@/lib/badge";
import { appAlert } from "@/components/providers/DialogProvider";
import {
  FILL, SCROLL, BodyShell, Skeleton, Quiet, sum, useWidgetData, headCount,
  fetchRecentDates, weekSplit, useWidget,
} from "./kit";

export type Tone =
  | "blue" | "orange" | "indigo" | "violet" | "emerald"
  | "purple" | "amber" | "cyan" | "rose" | "slate";

// A widget's tone is only a tag now: every chip is the same quiet ink, since
// color means status (red, amber, green) and tap (orange), nothing else.
export function toneChip(_tone: Tone) {
  return "bg-[var(--color-surface-2)] text-[var(--color-text)]";
}

export interface WidgetMeta {
  type: WidgetType;
  title: string;
  description: string;
  icon: LucideIcon;
  tone: Tone;
  /** Where the footer / "open the full tool" link navigates. */
  href: string;
  /** Label for the footer CTA, e.g. "Open Document Control". */
  cta: string;
  /** Default column span (1..12) when freshly added. */
  defaultW: number;
  /** Default row-unit height when freshly added. */
  defaultH: number;
  /** Minimum column span the resize handle will allow. */
  minW?: number;
  /** Minimum row-unit height the resize handle will allow. */
  minH?: number;
  /** Maximum column span the resize handle will allow (defaults to 12). */
  maxW?: number;
  adminOnly?: boolean;
  hasSettings?: boolean;
  /** When true the widget supplies its OWN full visual shell — the frame skips
   *  its header/footer/padding/flare and just hosts the Body (+ edit controls)
   *  edge-to-edge. Used by the Command Deck, which is its own hero band. */
  bare?: boolean;
  /** Can be added more than once (e.g. one Ask widget per library). */
  multi?: boolean;
  /** Fields in this widget's settings window (a title field is always added). */
  settings?: WidgetSettingField[];
  /** Grouping in the Add-widget picker. */
  category: "Knowledge" | "Documents" | "Work" | "You" | "Admin";
  /** Shown as a "New" ribbon in the picker. */
  isNew?: boolean;
  Body: React.ComponentType<{ widget: DashboardWidget }>;
}

// ─── small shared bits (the rest live in ./kit) ───────────────────
/** A suggested action: a dot in its status color, the words, and a link. */
function NudgeList({ nudges }: { nudges: ReturnType<typeof computeNudges> }) {
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {nudges.map((n) => (
        <li key={n.id} className="py-2.5 flex items-baseline gap-3 text-reading text-[var(--color-text)]">
          <span aria-hidden className={`w-[7px] h-[7px] shrink-0 rounded-full -translate-y-px ${n.severity === "high" ? "bg-[var(--state-overdue)]" : "bg-[var(--state-held)]"}`} />
          <span className="flex-1 min-w-0">{n.message}</span>
          {n.actionLabel && n.href && (
            <Link href={n.href} className={`shrink-0 text-body font-medium ${link}`}>{n.actionLabel}</Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function InboxBody() {
  const { data, loading } = useWidgetData(async (orgId, uid) => {
    const [openRequests, lockedDocs, activeProjects, notifDates] = await Promise.all([
      headCount(() => supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).not("checked_out_by", "is", null) as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
      (async () => {
        if (!uid) return [] as string[];
        try {
          const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
          const { data } = await supabase.from("notifications").select("created_at")
            .eq("org_id", orgId).eq("user_id", uid).gte("created_at", since).limit(2000);
          return ((data ?? []) as Array<{ created_at: string | null }>).map((r) => r.created_at).filter(Boolean) as string[];
        } catch { return [] as string[]; }
      })(),
    ]);
    return { openRequests, lockedDocs, activeProjects, notifDates };
  });

  if (loading) return <Skeleton />;
  const buckets = dayBuckets(data?.notifDates ?? [], 14);
  const wk = weekSplit(data?.notifDates ?? []);
  return (
    // FILL + SCROLL: on phones the height is capped; the list scrolls.
    <div className="-m-4 p-4 flex-1 min-h-0 overflow-y-auto flex flex-col">
      <FactRow className="-mx-4 -mt-4 border-b border-[var(--color-border)]" cells={[
        { label: "Open requests", value: (data?.openRequests ?? 0).toLocaleString(), href: "/requests" },
        { label: "Checked out", value: (data?.lockedDocs ?? 0).toLocaleString(), href: "/documents" },
        { label: "Active projects", value: (data?.activeProjects ?? 0).toLocaleString(), href: "/projects" },
      ]} />
      {/* Your notifications over two weeks. */}
      <div className="mt-4 shrink-0">
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-body text-[var(--color-text-muted)]">Your notifications, last 14 days</span>
          <TrendChip current={wk.cur} previous={wk.prev} what="notifications" />
        </div>
        {sum(buckets.counts) > 0
          ? <MiniBars values={buckets.counts} labels={buckets.labels} height={36} />
          : <Quiet label="Nothing has notified you in 14 days." />}
      </div>
    </div>
  );
}

// ── Daily Brief widget — fetches the personal inbox snapshot and renders the
// same narrated brief as the cockpit, plus its proactive nudges.
function DailyBriefBody() {
  const { snap, loading } = useInboxSnapshot();
  if (loading) return <Skeleton />;
  if (!snap) return <BodyShell>Couldn&apos;t load your brief right now.</BodyShell>;
  const nudges = computeNudges(snap);

  return (
    <div className={`${FILL} ${SCROLL} gap-3`}>
      <DailyBrief data={snap} />
      {nudges.length > 0 && (
        <div className="border-t border-[var(--color-border)] pt-3">
          <h3 className="text-reading font-medium text-[var(--color-text)]">Suggested actions</h3>
          <NudgeList nudges={nudges} />
        </div>
      )}
    </div>
  );
}

// ── Quick Launch widget — the shared cockpit launcher.
function QuickLaunchBody() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto -m-4">
      <QuickLaunch />
    </div>
  );
}

// Shared loader for the personal inbox snapshot used by the cockpit-grade
// widgets below. `refresh()` bumps a key to re-run the fetch (so an in-widget
// action — e.g. resolving a markup request — can refresh without a page nav).
// All setState happens in async callbacks, never synchronously in the effect
// body, to satisfy react-hooks/set-state-in-effect.
function useInboxSnapshot(): { snap: InboxSnapshot | null; loading: boolean; refresh: () => void } {
  const { activeOrgId, uid, userEmail } = useRole();
  // The frame's ⟳ / timer refresh this too.
  const { refreshKey, reportLoaded } = useWidget();
  const [snap, setSnap] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId || !uid) return;
    loadInbox(activeOrgId, uid, userEmail ?? undefined)
      .then((s) => { if (alive) { setSnap(s); setLoading(false); reportLoaded(); } })
      .catch(() => { if (alive) { setLoading(false); reportLoaded(); } });
    return () => { alive = false; };
  }, [activeOrgId, uid, userEmail, reloadKey, refreshKey, reportLoaded]);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  return { snap, loading, refresh };
}

// ── Needs You widget — the rich, filterable attention feed from the cockpit,
// backed by the SAME unified notification hook the sidebar badge + bell use.
function AttentionBody() {
  const {
    items, markRead, markAllRead, loading,
  } = useTicketNotifications();
  const [filter, setFilter] = useState<AttnFilter>("all");
  const [markingAll, setMarkingAll] = useState(false);

  const counts = {
    all: items.length,
    action: items.filter((i) => i.actionRequired).length,
    unread: items.filter((i) => !i.actionRequired).length,
  };
  const filtered = filter === "action"
    ? items.filter((i) => i.actionRequired)
    : filter === "unread"
      ? items.filter((i) => !i.actionRequired)
      : items;

  const handleMarkAll = useCallback(async () => {
    setMarkingAll(true);
    try { await markAllRead(); }
    catch (e) { void appAlert({ title: "Couldn't mark them read", message: friendlyError(e), tone: "danger" }); }
    finally { setMarkingAll(false); }
  }, [markAllRead]);
  const { seenAt } = useNotificationsSeen();

  if (loading && items.length === 0) return <Skeleton />;

  return (
    // Edge to edge in the sheet: the rows carry their own side padding.
    <div className="flex-1 min-h-0 overflow-y-auto -m-4">
      <AttentionFeed
        plain
        items={filtered}
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        onMarkRead={(id) => { void markRead(id).catch((e: unknown) => appAlert({ title: "Couldn't mark it read", message: friendlyError(e), tone: "danger" })); }}
        onMarkAll={handleMarkAll}
        markingAll={markingAll}
        seenAt={seenAt}
      />
    </div>
  );
}

// ── Suggested Actions widget — the cockpit's proactive nudges block, derived
// from the inbox snapshot. Mirrors the inbox's nudges UI exactly.
function SuggestedActionsBody() {
  const { snap, loading } = useInboxSnapshot();
  if (loading) return <Skeleton />;
  if (!snap) return <BodyShell>Couldn&apos;t load suggestions right now.</BodyShell>;
  const nudges = computeNudges(snap);
  if (nudges.length === 0) {
    return <BodyShell>Nothing to suggest. You&apos;re ahead of the work.</BodyShell>;
  }
  return (
    <div className={`${FILL} ${SCROLL} -my-2.5`}>
      <NudgeList nudges={nudges} />
    </div>
  );
}

// ── Outstanding widget — the cockpit's "key open work" sections in one place:
// markup requests (with the live respond actions), my checkouts (with the
// stale warning), holds I opened, transmittals awaiting receipt, and milestones
// due this week. Interactive markup respond is preserved via resolveMarkupRequest.
/** A group inside the Outstanding widget: its name as text and a plain
 *  count, then its rows. */
function WidgetCard({
  title, count, children,
}: {
  /** Kept for older callers; not drawn (headings are text). */
  icon?: LucideIcon;
  title: string;
  count: number;
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="pt-1">
      <div className="flex items-baseline gap-2 pb-1.5 border-b border-[var(--color-border)]">
        <h3 className="text-reading font-medium text-[var(--color-text)]">{title}</h3>
        <span className="text-body tabular-nums text-[var(--color-text-muted)]">{badgeText(count)}</span>
      </div>
      {children}
    </section>
  );
}

const ageTone = (d: number | undefined): "overdue" | "held" | null => ((d ?? 0) >= 14 ? "overdue" : (d ?? 0) >= 7 ? "held" : null);
const ageWords = (d: number | undefined) => (d === 0 ? "Today" : `${d ?? 0} days`);

function OutstandingBody() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const { snap, loading, refresh } = useInboxSnapshot();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const respondToMarkup = useCallback(async (
    mr: InboxSnapshot["markupRequestsToMe"][number],
    status: "shared" | "declined",
  ) => {
    if (!uid || !activeOrgId || resolvingId) return;
    setResolvingId(mr.id);
    setResolveError(null);
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
      refresh();
    } catch (e) {
      setResolveError(`${status === "shared" ? "Not marked shared." : "Not declined."} ${friendlyError(e)}`);
    } finally {
      setResolvingId(null);
    }
  }, [uid, activeOrgId, userEmail, activeRole, resolvingId, refresh]);

  if (loading) return <Skeleton />;
  if (!snap) return <BodyShell>Couldn&apos;t load your outstanding work right now.</BodyShell>;

  const total = snap.markupRequestsToMe.length + snap.myCheckouts.length
    + snap.myOpenHolds.length + snap.transmittalsAwaitingAck.length + snap.milestonesUpcoming.length;

  if (total === 0) {
    return <BodyShell>Nothing outstanding: no markups, checkouts, holds, transmittals or milestones waiting.</BodyShell>;
  }
  const row = "py-2.5 flex items-center gap-3 min-w-0 text-reading";

  return (
    <div className={FILL}>
      <div className={`space-y-5 ${SCROLL}`}>
        {snap.markupRequestsToMe.length > 0 && (
          <WidgetCard icon={PenLine} title="Markup requests for you" count={snap.markupRequestsToMe.length}>
            {resolveError && <p role="alert" className="mt-2 text-body font-medium text-[var(--state-overdue-text)] flex items-start gap-1.5"><CircleAlert aria-hidden className="w-4 h-4 shrink-0 mt-px" /><span>{resolveError}</span></p>}
            <ul className="divide-y divide-[var(--color-border)]">
              {snap.markupRequestsToMe.slice(0, 6).map((mr) => (
                <li key={mr.id} className={`${row} flex-wrap`}>
                  <span className="min-w-0 flex-1">
                    <Link href={mr.libraryId ? `/documents/${mr.libraryId}?doc=${mr.documentId}` : "/documents"} className="ui-id">
                      {mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)}
                    </Link>
                    {mr.requestedByName && <span className="text-[var(--color-text-muted)]"> from {mr.requestedByName}</span>}
                    {mr.message && <span className="block text-body text-[var(--color-text-muted)] truncate">&ldquo;{mr.message}&rdquo;</span>}
                  </span>
                  <span className="shrink-0 flex items-center gap-2">
                    <button type="button" onClick={() => respondToMarkup(mr, "shared")} disabled={resolvingId === mr.id} className={rowBtn}>
                      <Send className="w-3.5 h-3.5" /> Mark shared
                    </button>
                    <button type="button" onClick={() => respondToMarkup(mr, "declined")} disabled={resolvingId === mr.id} className={rowBtn}>
                      <XCircle className="w-3.5 h-3.5" /> Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </WidgetCard>
        )}

        {snap.myCheckouts.length > 0 && (
          <WidgetCard icon={FileLock} title="Your checkouts" count={snap.myCheckouts.length}>
            {snap.myStaleCheckouts.length > 0 && (
              <p className="pt-2.5"><StatusTag tone="overdue">{snap.myStaleCheckouts.length} past the expected release. Check in or extend.</StatusTag></p>
            )}
            <ul className="divide-y divide-[var(--color-border)]">
              {snap.myCheckouts.slice(0, 6).map((s) => (
                <li key={s.id} className={row}>
                  <DocHoverPreview documentId={s.documentId}>
                    <DocThumb documentId={s.documentId} width={28} />
                  </DocHoverPreview>
                  <Link href={`/documents/${s.libraryId ?? ""}?doc=${s.documentId}`} className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                    {s.purpose || "Checked-out document"}
                  </Link>
                  <span className="shrink-0 ui-tag is-more capitalize">{String(s.mode).replace(/_/g, " ")}</span>
                  <span className="shrink-0 w-16 text-right text-body text-[var(--color-text-muted)] tabular-nums">{formatAgo(typeof s.startedAt === "string" ? s.startedAt : undefined)}</span>
                </li>
              ))}
            </ul>
          </WidgetCard>
        )}

        {snap.myOpenHolds.length > 0 && (
          <WidgetCard icon={OctagonPause} title="Holds you opened" count={snap.myOpenHolds.length}>
            <ul className="divide-y divide-[var(--color-border)]">
              {snap.myOpenHolds.slice(0, 6).map((h) => (
                <li key={h.id} className={row}>
                  <span className="min-w-0 flex-1">
                    <StatusTag tone="overdue">{h.reason}</StatusTag>
                    {h.notes && <span className="block text-body text-[var(--color-text-muted)] truncate">&ldquo;{h.notes}&rdquo;</span>}
                  </span>
                  <span className="shrink-0 text-body text-[var(--color-text-muted)]">Opened {formatAgo(typeof h.openedAt === "string" ? h.openedAt : undefined)}</span>
                </li>
              ))}
            </ul>
            <Link href="/admin/holds" className={`mt-1 inline-block text-body ${link}`}>Hold queue</Link>
          </WidgetCard>
        )}

        {snap.transmittalsAwaitingAck.length > 0 && (
          <WidgetCard icon={Send} title="Transmittals awaiting receipt" count={snap.transmittalsAwaitingAck.length}>
            <ul className="divide-y divide-[var(--color-border)]">
              {snap.transmittalsAwaitingAck.slice(0, 6).map((t) => {
                const tone = ageTone(t.__ageDays);
                return (
                  <li key={t.id} className={row}>
                    <Link href="/transmittals" className="shrink-0 ui-id">{t.number}</Link>
                    <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{t.subject || [t.recipientName, t.recipientCompany].filter(Boolean).join(", ") || `${t.documentCount} doc${t.documentCount === 1 ? "" : "s"}`}</span>
                    {tone ? <StatusTag tone={tone}>{ageWords(t.__ageDays)}</StatusTag> : <span className="shrink-0 text-body text-[var(--color-text-muted)]">{ageWords(t.__ageDays)}</span>}
                  </li>
                );
              })}
            </ul>
            <Link href="/transmittals" className={`mt-1 inline-block text-body ${link}`}>Transmittal register</Link>
          </WidgetCard>
        )}

        {snap.milestonesUpcoming.length > 0 && (
          <WidgetCard icon={Flag} title="Milestones due this week" count={snap.milestonesUpcoming.length}>
            <ul className="divide-y divide-[var(--color-border)]">
              {snap.milestonesUpcoming.slice(0, 8).map((m) => {
                const d = m.__dueInDays ?? 0;
                return (
                  <li key={m.id} className={row}>
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">{m.name}</span>
                    {d <= 2
                      ? <StatusTag tone="held">{d === 0 ? "Due today" : `In ${d} day${d === 1 ? "" : "s"}`}</StatusTag>
                      : <span className="shrink-0 text-body text-[var(--color-text-muted)]">In {d} days</span>}
                  </li>
                );
              })}
            </ul>
          </WidgetCard>
        )}
      </div>
    </div>
  );
}

// Analytics — a real insights peek: headline stats that deep-link, the
// 30-day workspace heartbeat (audit events — the one series that's never
// artificially flat), and the busiest libraries. When a series IS quiet,
// it says so instead of drawing a flat zero line.
function AdminAnalyticsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [totalDocs, totalRevs, openReqs, members, auditDates, docLibs, libNames] = await Promise.all([
      headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("document_versions").select("id", { count: "exact", head: true })
        .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("org_members").select("uid", { count: "exact", head: true })
        .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
      fetchRecentDates("audit_logs", orgId, 30, "timestamp"),
      supabase.from("documents").select("library_id").eq("org_id", orgId).limit(4000),
      supabase.from("libraries").select("id, name").eq("org_id", orgId),
    ]);
    const byLib = new Map<string, number>();
    for (const r of ((docLibs.data ?? []) as Array<{ library_id: string | null }>)) {
      if (r.library_id) byLib.set(r.library_id, (byLib.get(r.library_id) ?? 0) + 1);
    }
    const names = new Map(((libNames.data ?? []) as Array<{ id: string; name: string | null }>).map((l) => [l.id, l.name ?? "Library"]));
    const topLibs = Array.from(byLib.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, count]) => ({ id, name: names.get(id) ?? "Library", count }));
    return { totalDocs, totalRevs, openReqs, members, auditDates, topLibs };
  });
  if (loading) return <Skeleton />;
  const audit = dayBuckets(data?.auditDates ?? [], 30);
  const wk = weekSplit(data?.auditDates ?? []);
  const maxLib = Math.max(1, ...(data?.topLibs ?? []).map((l) => l.count));
  return (
    // FILL + SCROLL: at the 300px mobile floor this body overflows and the
    // whole 'Busiest libraries' block was clipped with no scroll path.
    <div className="-m-4 p-4 flex-1 min-h-0 overflow-y-auto flex flex-col">
      {/* Headline counts: each one opens its tool. */}
      <FactRow className="-mx-4 -mt-4 border-b border-[var(--color-border)] shrink-0" cells={[
        { label: "Documents", value: (data?.totalDocs ?? 0).toLocaleString(), href: "/documents" },
        { label: "Revisions", value: (data?.totalRevs ?? 0).toLocaleString(), href: "/register" },
        { label: "Open requests", value: (data?.openReqs ?? 0).toLocaleString(), href: "/requests" },
        { label: "Members", value: (data?.members ?? 0).toLocaleString(), href: "/admin/users" },
      ]} />

      {/* Workspace activity: 30 days of recorded changes. */}
      <div className="mt-4 shrink-0">
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-body text-[var(--color-text-muted)]">Workspace activity, last 30 days</span>
          <TrendChip current={wk.cur} previous={wk.prev} what="changes" />
        </div>
        {sum(audit.counts) > 0
          ? <MiniBars values={audit.counts} labels={audit.labels} height={36} />
          : <Quiet label="No recorded activity in the last 30 days." />}
      </div>

      {/* Busiest libraries: where the documents live. */}
      {(data?.topLibs?.length ?? 0) > 0 && (
        <div className="mt-4 shrink-0">
          <div className="text-body text-[var(--color-text-muted)] mb-1">Busiest libraries</div>
          <ul className="divide-y divide-[var(--color-border)]">
            {data!.topLibs.map((l, i) => (
              <li key={l.id}>
                <Link href={`/documents/${l.id}`} className="group flex items-center gap-3 py-2 pointer-coarse:min-h-11">
                  <span className="text-reading font-medium text-[var(--color-text)] truncate w-40 group-hover:text-[var(--color-accent-text)]">{l.name}</span>
                  <span className="flex-1 h-2 rounded-sm bg-[var(--color-surface-2)] overflow-hidden">
                    {/* The busiest one in the brand color, the rest gray. */}
                    <span className="block h-full rounded-sm" style={{ width: `${(l.count / maxLib) * 100}%`, background: i === 0 ? "var(--color-current)" : "var(--color-text-faint)" }} />
                  </span>
                  <span className="font-display text-reading tabular-nums text-[var(--color-text)] w-14 text-right">{l.count.toLocaleString()}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Command Deck (bare hero widget) ─────────────────────────────
// The vibrant cockpit band, now a first-class widget. Loads the same personal
// inbox snapshot + the three org-wide pillar counts the /inbox masthead uses and
// renders the SAME <CommandDeck>, so it's pixel-identical — just customizable.
// Marked `bare` in the catalog so the WidgetFrame hosts it edge-to-edge (the
// deck supplies its own hero shell). Every fetch is guarded/best-effort; a
// tasteful skeleton fills the deck's silhouette until first load. All setState
// happens in async callbacks / event handlers — never synchronously in an effect
// body — to satisfy react-hooks/set-state-in-effect.
function CommandDeckBody() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const { count: attentionCount, actionRequiredCount, items: attentionItems, markRead } = useTicketNotifications();
  const { editing } = useWidget();

  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pillars, setPillars] = useState<PillarStats>({ openRequests: 0, lockedDocs: 0, activeProjects: 0, loaded: false });

  // Personal inbox snapshot (left side of the deck). Re-runs on reloadKey bump.
  useEffect(() => {
    let alive = true;
    if (!uid || !activeOrgId) return;
    loadInbox(activeOrgId, uid, userEmail ?? undefined)
      .then((snap) => { if (alive) { setData(snap); setLastLoadedAt(Date.now()); } })
      .catch(() => { /* leave prior data; deck degrades to dashes */ })
      .finally(() => { if (alive) { setLoading(false); setRefreshing(false); } });
    return () => { alive = false; };
  }, [uid, activeOrgId, userEmail, reloadKey]);

  // Org-wide headline counts for the three pillars. Independent + best-effort —
  // a missing table/column degrades that one stat to 0, never blanks the deck.
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void (async () => {
      const head = async (build: () => Promise<{ count: number | null }>) => {
        try { return (await build()).count ?? 0; } catch { return 0; }
      };
      const [openRequests, lockedDocs, activeProjects] = await Promise.all([
        head(() => supabase.from("tickets").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
        head(() => supabase.from("documents").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).not("checked_out_by", "is", null) as unknown as Promise<{ count: number | null }>),
        head(() => supabase.from("projects").select("id", { count: "exact", head: true })
          .eq("org_id", activeOrgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
      ]);
      if (alive) setPillars({ openRequests, lockedDocs, activeProjects, loaded: true });
    })();
    return () => { alive = false; };
  }, [activeOrgId, reloadKey]);

  // First paint, before any data: the section's outline, quietly loading.
  if (loading && !data) {
    return (
      <section aria-label="Needs you" aria-busy="true" className="h-full">
        <SectionHead title="Needs you" />
        <SkeletonRows rows={2} cols={2} what="what needs you" />
      </section>
    );
  }

  const total = attentionCount
    + (data ? data.ticketsWatching.length + data.myCheckouts.length + data.myOpenHolds.length
      + data.markupRequestsToMe.length + data.milestonesUpcoming.length + data.transmittalsAwaitingAck.length : 0);

  return (
    <CommandDeck
      fill={!!editing}
      userEmail={userEmail ?? undefined}
      data={data}
      pillars={pillars}
      attentionCount={attentionCount}
      actionCount={actionRequiredCount}
      items={attentionItems}
      focus={data ? roleFocus(activeRole, data) : null}
      lastLoadedAt={lastLoadedAt}
      refreshing={loading || refreshing}
      canExport={!!data && total > 0}
      onRefresh={() => { setRefreshing(true); setReloadKey((k) => k + 1); }}
      onExport={() => data && exportInboxCsv(data, userEmail ?? undefined)}
      onOpenItem={(id) => { void markRead(id).catch(() => { /* it stays in the list */ }); }}
    />
  );
}

// ─── catalog ─────────────────────────────────────────────────────
export const WIDGET_CATALOG: Record<WidgetType, WidgetMeta> = {
  commandDeck: {
    type: "commandDeck", title: "Needs you", description: "What needs you, as a table, with the three main tools and their counts.",
    icon: LayoutDashboard, tone: "indigo", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 12, defaultH: 3, minW: 6, minH: 2, maxW: 12, bare: true, Body: CommandDeckBody,
  },
  askKnowledge: {
    type: "askKnowledge", title: "Ask Knowledge", description: "Ask a library. The answer first, the proof to the page.",
    icon: Sparkles, tone: "orange", href: "/assistant", cta: "Open the Assistant", category: "Knowledge", isNew: true,
    defaultW: 6, defaultH: 5, minW: 4, minH: 4, multi: true,
    settings: [
      { key: "libraryId", type: "knowledgeLibrary", label: "Library", help: "Which knowledge library this widget asks. You can also switch it inside the widget." },
      { key: "mode", type: "select", label: "Default answer style", default: "auto", options: [
        { value: "auto", label: "Auto - the AI picks" }, { value: "answer", label: "Direct answer" },
        { value: "compliance", label: "Compliance check" }, { value: "explore", label: "Explore" },
      ] },
    ],
    Body: AskKnowledgeBody,
  },
  documentControl: {
    type: "documentControl", title: "Document Control", description: "Browse libraries, folders and documents.",
    icon: FileStack, tone: "blue", href: "/documents", cta: "Open Document Control", category: "Documents",
    // Room for the search, its list, the map and a preview side by side.
    defaultW: 12, defaultH: 5, minW: 6, minH: 5, multi: true,
    settings: [
      { key: "libraryIds", type: "docLibraries", label: "Libraries to show", help: "Leave all unchecked to show every library." },
    ],
    Body: DocBrowserBody,
  },
  draftingRequests: {
    type: "draftingRequests", title: "Drafting Requests", description: "Open requests: yours, assigned to you, unassigned.",
    icon: MailPlus, tone: "orange", href: "/requests", cta: "Open request portal", category: "Work",
    defaultW: 6, defaultH: 5, minW: 4, minH: 3, multi: true,
    settings: [
      { key: "scope", type: "select", label: "Show", default: "all", options: [
        { value: "all", label: "All open requests" }, { value: "assigned", label: "Assigned to me" },
        { value: "mine", label: "Requests I raised" }, { value: "unassigned", label: "Unassigned" },
      ] },
    ],
    Body: DraftingRequestsBody,
  },
  inbox: {
    type: "inbox", title: "Inbox", description: "Everything that needs you.",
    icon: InboxIcon, tone: "indigo", href: "/inbox", cta: "Open inbox", category: "You",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: InboxBody,
  },
  dailyBrief: {
    type: "dailyBrief", title: "Daily brief", description: "Your day in a few lines, and where to start.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 5, minW: 4, minH: 3, Body: DailyBriefBody,
  },
  recentDocs: {
    type: "recentDocs", title: "Recently viewed", description: "Pick up where you left off.",
    icon: History, tone: "blue", href: "/documents", cta: "Open documents", category: "Documents",
    defaultW: 3, defaultH: 5, minW: 2, minH: 3,
    settings: [{ key: "count", type: "number", label: "How many to show", min: 5, max: 50, default: 12 }],
    Body: RecentDocsBody,
  },
  quickLaunch: {
    type: "quickLaunch", title: "Quick launch", description: "Jump straight into common actions.",
    icon: Rocket, tone: "orange", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 3, defaultH: 5, minW: 2, minH: 3, Body: QuickLaunchBody,
  },
  attention: {
    type: "attention", title: "Notifications", description: "Everything waiting on you, with filters.",
    icon: Bell, tone: "rose", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: AttentionBody,
  },
  suggestedActions: {
    type: "suggestedActions", title: "Suggested actions", description: "What to do next, from your open work.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: SuggestedActionsBody,
  },
  outstanding: {
    type: "outstanding", title: "Outstanding", description: "Markups, checkouts, holds, transmittals and milestones.",
    icon: Layers, tone: "indigo", href: "/inbox", cta: "Open command deck", category: "Work",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: OutstandingBody,
  },
  projects: {
    type: "projects", title: "Projects", description: "Yours, all active, due soon, going quiet.",
    icon: Briefcase, tone: "violet", href: "/projects", cta: "Open projects", category: "Work",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, multi: true,
    settings: [
      { key: "scope", type: "select", label: "Show", default: "mine", options: [
        { value: "mine", label: "My projects" }, { value: "active", label: "All active projects" },
        { value: "due", label: "Due within 14 days" }, { value: "quiet", label: "Quiet for 14+ days" },
      ] },
    ],
    Body: ProjectsBody,
  },
  activity: {
    type: "activity", title: "Activity", description: "Who changed what, linked to the item.",
    icon: ActivityIcon, tone: "emerald", href: "/activity", cta: "Open activity", category: "Work",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, multi: true,
    settings: [{ key: "onlyMine", type: "toggle", label: "Only my activity", default: false }],
    Body: ActivityBody,
  },
  equipment: {
    type: "equipment", title: "Equipment", description: "Search the asset registry by tag.",
    icon: Tag, tone: "purple", href: "/admin/assets", cta: "Open equipment", category: "Documents",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: EquipmentBody,
  },
  adminUsers: {
    type: "adminUsers", title: "Users", description: "Members, roles and pending invites.",
    icon: Users, tone: "cyan", href: "/admin/users", cta: "Manage users", category: "Admin",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, adminOnly: true, Body: AdminUsersBody,
  },
  adminAnalytics: {
    type: "adminAnalytics", title: "Analytics", description: "Workspace counts and activity.",
    icon: BarChart3, tone: "violet", href: "/admin/analytics", cta: "Open analytics", category: "Admin",
    defaultW: 6, defaultH: 3, minW: 3, minH: 2, adminOnly: true, Body: AdminAnalyticsBody,
  },
  adminAudit: {
    type: "adminAudit", title: "Audit log", description: "Immutable change history, filterable.",
    icon: ScrollText, tone: "rose", href: "/admin/audit", cta: "Open audit log", category: "Admin",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, adminOnly: true,
    settings: [{ key: "onlyMine", type: "toggle", label: "Only my activity", default: false }],
    Body: AdminAuditBody,
  },
};

export const SETTINGS_ICON = Settings2;
export const OPEN_ICON = ChevronRight;
export const ADD_ICON = Plus;
export const LOADER_ICON = Loader2;
