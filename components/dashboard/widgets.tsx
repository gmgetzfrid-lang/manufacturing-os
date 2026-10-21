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
  Plus, Zap, Rocket, Loader2, Bell, Layers, FileSignature, Send,
  XCircle, AlertTriangle, AlertOctagon, Lock, Flag, Calendar, LayoutDashboard,
  Sparkles,
  type LucideIcon, History,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
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
import { MiniBars, TrendChip, dayBuckets, vizCat } from "./viz";
import AskKnowledgeBody from "./bodies/AskKnowledgeBody";
import DocBrowserBody from "./bodies/DocBrowserBody";
import {
  DraftingRequestsBody, ProjectsBody, ActivityBody, EquipmentBody, RecentDocsBody, AdminUsersBody, AdminAuditBody,
} from "./bodies/WorkBodies";
import type { DashboardWidget, WidgetType, WidgetSettingField } from "@/lib/dashboard/types";
import {
  FILL, SCROLL, BodyShell, Skeleton, Quiet, sum, useWidgetData, headCount,
  fetchRecentDates, weekSplit, useWidget,
} from "./kit";

export type Tone =
  | "blue" | "orange" | "indigo" | "violet" | "emerald"
  | "purple" | "amber" | "cyan" | "rose" | "slate";

const CHIP: Record<Tone, string> = {
  blue: "bg-blue-50 text-blue-600",
  orange: "bg-orange-50 text-orange-600",
  indigo: "bg-indigo-50 text-indigo-600",
  violet: "bg-violet-50 text-violet-600",
  emerald: "bg-emerald-50 text-emerald-600",
  purple: "bg-purple-50 text-purple-600",
  amber: "bg-amber-50 text-amber-600",
  cyan: "bg-cyan-50 text-cyan-600",
  rose: "bg-rose-50 text-rose-600",
  slate: "bg-slate-100 text-slate-600",
};

export function toneChip(tone: Tone) {
  return CHIP[tone];
}

// Vivid gradient for the widget header icon badge — the "alive" look the app
// uses across the cockpit, login and library covers.
const TONE_GRADIENT: Record<Tone, string> = {
  blue: "from-blue-500 to-blue-700",
  orange: "from-orange-500 to-orange-700",
  indigo: "from-indigo-500 to-indigo-700",
  violet: "from-violet-500 to-violet-700",
  emerald: "from-emerald-500 to-emerald-700",
  purple: "from-purple-500 to-purple-700",
  amber: "from-amber-400 to-amber-600",
  cyan: "from-cyan-500 to-cyan-700",
  rose: "from-rose-500 to-rose-700",
  slate: "from-slate-600 to-slate-800",
};
export function toneGradient(tone: Tone) {
  return TONE_GRADIENT[tone];
}

// Subtle top-of-card wash so a flat widget reads with a hint of its tone.
const TONE_WASH: Record<Tone, string> = {
  blue: "from-blue-500/10",
  orange: "from-orange-500/10",
  indigo: "from-indigo-500/10",
  violet: "from-violet-500/10",
  emerald: "from-emerald-500/10",
  purple: "from-purple-500/10",
  amber: "from-amber-500/10",
  cyan: "from-cyan-500/10",
  rose: "from-rose-500/10",
  slate: "from-slate-500/10",
};
export function toneWash(tone: Tone) {
  return TONE_WASH[tone];
}

// Ambient corner-glow pair per tone — the Command Deck's "console aura", tinted
// to each widget. Two blurred radial blooms (a dominant + a complementary) that
// the frame brightens on hover, so every card reads as alive as the deck.
const TONE_GLOW: Record<Tone, [string, string]> = {
  blue:    ["bg-blue-500/25",    "bg-indigo-500/20"],
  orange:  ["bg-orange-500/25",  "bg-amber-500/20"],
  indigo:  ["bg-indigo-500/25",  "bg-violet-500/20"],
  violet:  ["bg-violet-500/25",  "bg-fuchsia-500/20"],
  emerald: ["bg-emerald-500/25", "bg-teal-500/20"],
  purple:  ["bg-purple-500/25",  "bg-fuchsia-500/20"],
  amber:   ["bg-amber-400/25",   "bg-orange-500/20"],
  cyan:    ["bg-cyan-500/25",    "bg-blue-500/20"],
  rose:    ["bg-rose-500/25",    "bg-pink-500/20"],
  slate:   ["bg-slate-500/20",   "bg-slate-400/15"],
};
export function toneGlow(tone: Tone): [string, string] {
  return TONE_GLOW[tone];
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
function Stat({ value, label, accent }: { value: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-black leading-none ${accent ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mt-1">{label}</div>
    </div>
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
    // FILL + SCROLL: on phones the card height is fixed, and without the
    // scroll chain overflow-hidden clipped the last DeckLink unreachable.
    <div className={`${FILL} ${SCROLL}`}>
      <div className="grid grid-cols-3 gap-2 shrink-0">
        <Stat value={data?.openRequests ?? 0} label="Requests" />
        <Stat value={data?.lockedDocs ?? 0} label="Checked out" />
        <Stat value={data?.activeProjects ?? 0} label="Projects" />
      </div>
      {/* Your notification pulse — is this week louder than last? */}
      <div className="mt-4 shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Your notifications · 14 days</span>
          <TrendChip current={wk.cur} previous={wk.prev} />
        </div>
        {sum(buckets.counts) > 0
          ? <MiniBars values={buckets.counts} labels={buckets.labels} height={36} />
          : <Quiet label="Nothing has pinged you in 14 days — enjoy it." />}
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <DeckLink href="/requests" label="Requests" sub="Open portal" />
        <DeckLink href="/documents" label="Documents" sub="Browse & lock" />
        <DeckLink href="/projects" label="Projects" sub="Work packages" />
      </div>
    </div>
  );
}

function DeckLink({ href, label, sub }: { href: string; label: string; sub: string }) {
  return (
    <Link href={href} className="group flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] transition-colors">
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{label}</div>
        <div className="text-[11px] text-[var(--color-text-muted)] truncate">{sub}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
    </Link>
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
        <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50/40 p-4">
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
      )}
    </div>
  );
}

// ── Quick Launch widget — the shared cockpit launcher.
function QuickLaunchBody() {
  return (
    <div className={`${FILL} ${SCROLL}`}>
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
    try { await markAllRead(); } catch { /* best-effort */ } finally { setMarkingAll(false); }
  }, [markAllRead]);

  if (loading && items.length === 0) return <Skeleton />;

  return (
    <div className={`${FILL} ${SCROLL}`}>
      <AttentionFeed
        items={filtered}
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        onMarkRead={(id) => { void markRead(id); }}
        onMarkAll={handleMarkAll}
        markingAll={markingAll}
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
    return <BodyShell>Nothing to suggest — you&apos;re ahead of the work. Nice.</BodyShell>;
  }
  return (
    <div className={`${FILL}`}>
      <div className={`rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50/40 p-4 ${SCROLL}`}>
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
    </div>
  );
}

// ── Outstanding widget — the cockpit's "key open work" sections in one place:
// markup requests (with the live respond actions), my checkouts (with the
// stale warning), holds I opened, transmittals awaiting receipt, and milestones
// due this week. Interactive markup respond is preserved via resolveMarkupRequest.
function WidgetCard({
  icon: Icon, title, count, tone, children,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  tone: "indigo" | "orange" | "amber" | "rose" | "blue" | "emerald" | "violet" | "slate";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    indigo: "border-indigo-200 bg-indigo-50/40",
    orange: "border-orange-200 bg-orange-50/40",
    amber:  "border-amber-200 bg-amber-50/40",
    rose:   "border-rose-200 bg-rose-50/40",
    blue:   "border-blue-200 bg-blue-50/40",
    emerald:"border-emerald-200 bg-emerald-50/40",
    violet: "border-violet-200 bg-violet-50/40",
    slate:  "border-[var(--color-border)] bg-[var(--color-canvas)]",
  };
  const iconTones: Record<string, string> = {
    indigo: "text-indigo-700", orange: "text-orange-700", amber: "text-amber-700",
    rose: "text-rose-700", blue: "text-blue-700", emerald: "text-emerald-700",
    violet: "text-violet-700", slate: "text-[var(--color-text-faint)]",
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

function OutstandingBody() {
  const { uid, userEmail, activeRole, activeOrgId } = useRole();
  const { snap, loading, refresh } = useInboxSnapshot();
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const respondToMarkup = useCallback(async (
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
      refresh();
    } catch { /* surfaced as no-op; the list stays as-is */ } finally {
      setResolvingId(null);
    }
  }, [uid, activeOrgId, userEmail, activeRole, resolvingId, refresh]);

  if (loading) return <Skeleton />;
  if (!snap) return <BodyShell>Couldn&apos;t load your outstanding work right now.</BodyShell>;

  const total = snap.markupRequestsToMe.length + snap.myCheckouts.length
    + snap.myOpenHolds.length + snap.transmittalsAwaitingAck.length + snap.milestonesUpcoming.length;

  if (total === 0) {
    return <BodyShell>Nothing outstanding — no markups, checkouts, holds, transmittals or milestones pending.</BodyShell>;
  }

  return (
    <div className={FILL}>
      <div className={`space-y-3 ${SCROLL}`}>
        {snap.markupRequestsToMe.length > 0 && (
          <WidgetCard icon={FileSignature} tone="violet" title="Markup requests for you" count={snap.markupRequestsToMe.length}>
            <ul className="space-y-1.5">
              {snap.markupRequestsToMe.slice(0, 6).map((mr) => (
                <li key={mr.id} className="text-xs">
                  <Link href="/documents" className="text-violet-700 hover:underline font-bold">
                    {mr.documentNumber || mr.documentTitle || mr.documentId.slice(0, 8)}
                  </Link>
                  {mr.requestedByName && <span className="text-[var(--color-text-muted)]"> · from {mr.requestedByName}</span>}
                  {mr.message && <div className="text-[var(--color-text-faint)] truncate mt-0.5 italic">&quot;{mr.message}&quot;</div>}
                  <div className="mt-1 flex items-center gap-2.5 sm:gap-1.5">
                    <button
                      onClick={() => respondToMarkup(mr, "shared")}
                      disabled={resolvingId === mr.id}
                      className="inline-flex items-center gap-1 px-2.5 py-2 sm:py-1 rounded-md bg-violet-600 hover:bg-violet-500 text-[var(--color-text)] text-[11px] font-bold disabled:opacity-50"
                    >
                      <Send className="w-3 h-3" /> Mark shared
                    </button>
                    <button
                      onClick={() => respondToMarkup(mr, "declined")}
                      disabled={resolvingId === mr.id}
                      className="inline-flex items-center gap-1 px-2.5 py-2 sm:py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-canvas)] text-[var(--color-text-faint)] text-[11px] font-bold disabled:opacity-50"
                    >
                      <XCircle className="w-3 h-3" /> Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </WidgetCard>
        )}

        {snap.myCheckouts.length > 0 && (
          <WidgetCard icon={Lock} tone={snap.myStaleCheckouts.length > 0 ? "rose" : "blue"} title="Your active checkouts" count={snap.myCheckouts.length}>
            {snap.myStaleCheckouts.length > 0 && (
              <div className="mb-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                <AlertTriangle className="inline w-3 h-3 mr-1" />
                {snap.myStaleCheckouts.length} past expected release — please check in or extend
              </div>
            )}
            <ul className="space-y-1.5">
              {snap.myCheckouts.slice(0, 6).map((s) => (
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
          </WidgetCard>
        )}

        {snap.myOpenHolds.length > 0 && (
          <WidgetCard icon={AlertOctagon} tone="rose" title="Holds you opened" count={snap.myOpenHolds.length}>
            <ul className="space-y-1.5">
              {snap.myOpenHolds.slice(0, 6).map((h) => (
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
          </WidgetCard>
        )}

        {snap.transmittalsAwaitingAck.length > 0 && (
          <WidgetCard icon={Send} tone="blue" title="Transmittals awaiting receipt" count={snap.transmittalsAwaitingAck.length}>
            <ul className="space-y-1.5">
              {snap.transmittalsAwaitingAck.slice(0, 6).map((t) => (
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
          </WidgetCard>
        )}

        {snap.milestonesUpcoming.length > 0 && (
          <WidgetCard icon={Flag} tone="emerald" title="Milestones due this week" count={snap.milestonesUpcoming.length}>
            <ul className="space-y-1.5">
              {snap.milestonesUpcoming.slice(0, 8).map((m) => (
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
    <div className={`${FILL} ${SCROLL}`}>
      {/* Headline stats — each one is a doorway into its tool. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0">
        {([
          { label: "Documents", value: data?.totalDocs ?? 0, href: "/documents" },
          { label: "Revisions", value: data?.totalRevs ?? 0, href: "/register" },
          { label: "Open requests", value: data?.openReqs ?? 0, href: "/requests" },
          { label: "Members", value: data?.members ?? 0, href: "/admin/users" },
        ] as const).map((s) => (
          <Link key={s.label} href={s.href} className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 hover:border-[var(--color-accent)] transition-colors">
            <div className="text-lg font-black leading-none text-[var(--color-text)] tabular-nums group-hover:text-[var(--color-accent)] transition-colors">{s.value.toLocaleString()}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mt-1 truncate">{s.label}</div>
          </Link>
        ))}
      </div>

      {/* Workspace heartbeat — 30 days of change volume. */}
      <div className="mt-3 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Workspace activity · 30d</span>
          <TrendChip current={wk.cur} previous={wk.prev} />
        </div>
        {sum(audit.counts) > 0
          ? <MiniBars values={audit.counts} labels={audit.labels} height={36} />
          : <Quiet label="No recorded activity in the last 30 days." />}
      </div>

      {/* Busiest libraries — where the documents actually live. */}
      {(data?.topLibs?.length ?? 0) > 0 && (
        <div className="mt-3 shrink-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-1.5">Busiest libraries</div>
          <div className="space-y-1.5">
            {data!.topLibs.map((l, i) => (
              <Link key={l.id} href={`/documents/${l.id}`} className="group flex items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-text)] truncate w-32 group-hover:text-[var(--color-accent)] transition-colors">{l.name}</span>
                <span className="flex-1 h-2 rounded-full bg-[var(--viz-track)] overflow-hidden">
                  <span className="block h-full rounded-full transition-all" style={{ width: `${(l.count / maxLib) * 100}%`, background: vizCat(i) }} />
                </span>
                <span className="text-[11px] tabular-nums text-[var(--color-text-muted)] w-10 text-right">{l.count.toLocaleString()}</span>
              </Link>
            ))}
          </div>
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
  const { count: attentionCount, actionRequiredCount } = useTicketNotifications();

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

  // First paint, before any data: a tasteful skeleton in the deck's silhouette.
  if (loading && !data) {
    return (
      <div className="relative h-full overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-canvas)] shadow-2xl shadow-slate-900/30 p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="w-2 h-2 rounded-full bg-emerald-500/70 animate-pulse" />
          <div className="h-3 w-40 rounded bg-[var(--color-surface-2)] animate-pulse" />
        </div>
        <div className="h-7 w-64 rounded bg-[var(--color-surface-2)] animate-pulse mb-2" />
        <div className="h-4 w-80 rounded bg-[var(--color-surface-2)] animate-pulse mb-5" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 rounded-2xl bg-[var(--color-surface-2)] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const total = attentionCount
    + (data ? data.ticketsWatching.length + data.myCheckouts.length + data.myOpenHolds.length
      + data.markupRequestsToMe.length + data.milestonesUpcoming.length + data.transmittalsAwaitingAck.length : 0);

  return (
    <CommandDeck
      fill
      userEmail={userEmail ?? undefined}
      data={data}
      pillars={pillars}
      attentionCount={attentionCount}
      actionCount={actionRequiredCount}
      focus={data ? roleFocus(activeRole, data) : null}
      lastLoadedAt={lastLoadedAt}
      refreshing={loading || refreshing}
      canExport={!!data && total > 0}
      onRefresh={() => { setRefreshing(true); setReloadKey((k) => k + 1); }}
      onExport={() => data && exportInboxCsv(data, userEmail ?? undefined)}
    />
  );
}

// ─── catalog ─────────────────────────────────────────────────────
export const WIDGET_CATALOG: Record<WidgetType, WidgetMeta> = {
  commandDeck: {
    type: "commandDeck", title: "Command Deck", description: "Mission-control hero — greeting, live status & the three pillars.",
    icon: LayoutDashboard, tone: "indigo", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 12, defaultH: 4, minW: 6, minH: 3, maxW: 12, bare: true, Body: CommandDeckBody,
  },
  askKnowledge: {
    type: "askKnowledge", title: "Ask Knowledge", description: "Ask a library — answer first, proof to the page.",
    icon: Sparkles, tone: "orange", href: "/assistant", cta: "Open the Assistant", category: "Knowledge", isNew: true,
    defaultW: 6, defaultH: 5, minW: 4, minH: 4, multi: true,
    settings: [
      { key: "libraryId", type: "knowledgeLibrary", label: "Library", help: "Which knowledge library this widget asks. You can also switch it inside the widget." },
      { key: "mode", type: "select", label: "Default answer style", default: "auto", options: [
        { value: "auto", label: "Auto — the AI picks" }, { value: "answer", label: "Direct answer" },
        { value: "compliance", label: "Compliance check" }, { value: "explore", label: "Explore" },
      ] },
    ],
    Body: AskKnowledgeBody,
  },
  documentControl: {
    type: "documentControl", title: "Document Control", description: "Browse libraries, folders and documents.",
    icon: FileStack, tone: "blue", href: "/documents", cta: "Open Document Control", category: "Documents",
    defaultW: 12, defaultH: 4, minW: 4, minH: 3, multi: true,
    settings: [
      { key: "libraryIds", type: "docLibraries", label: "Libraries to show", help: "Leave all unchecked to show every library." },
    ],
    Body: DocBrowserBody,
  },
  draftingRequests: {
    type: "draftingRequests", title: "Drafting Requests", description: "Open requests — yours, assigned, unassigned.",
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
    type: "dailyBrief", title: "Daily Brief", description: "Your day, narrated + what to do next.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 5, minW: 4, minH: 3, Body: DailyBriefBody,
  },
  recentDocs: {
    type: "recentDocs", title: "Recently Viewed", description: "Pick up where you left off.",
    icon: History, tone: "blue", href: "/documents", cta: "Open documents", category: "Documents",
    defaultW: 3, defaultH: 5, minW: 2, minH: 3,
    settings: [{ key: "count", type: "number", label: "How many to show", min: 5, max: 50, default: 12 }],
    Body: RecentDocsBody,
  },
  quickLaunch: {
    type: "quickLaunch", title: "Quick Launch", description: "Jump straight into common actions.",
    icon: Rocket, tone: "orange", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 3, defaultH: 5, minW: 2, minH: 3, Body: QuickLaunchBody,
  },
  attention: {
    type: "attention", title: "Needs You", description: "Everything waiting on your attention.",
    icon: Bell, tone: "rose", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: AttentionBody,
  },
  suggestedActions: {
    type: "suggestedActions", title: "Suggested Actions", description: "Proactive nudges — what to do next.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck", category: "You",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: SuggestedActionsBody,
  },
  outstanding: {
    type: "outstanding", title: "Outstanding", description: "Markups, checkouts, holds & milestones.",
    icon: Layers, tone: "indigo", href: "/inbox", cta: "Open command deck", category: "Work",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: OutstandingBody,
  },
  projects: {
    type: "projects", title: "Projects", description: "Active, mine, due soon, going quiet.",
    icon: Briefcase, tone: "violet", href: "/projects", cta: "Open projects", category: "Work",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, multi: true,
    settings: [
      { key: "scope", type: "select", label: "Show", default: "active", options: [
        { value: "active", label: "All active projects" }, { value: "mine", label: "My projects" },
        { value: "due", label: "Due within 14 days" }, { value: "quiet", label: "Quiet for 14+ days" },
      ] },
    ],
    Body: ProjectsBody,
  },
  activity: {
    type: "activity", title: "Activity", description: "Who changed what — linked to the item.",
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
    type: "adminUsers", title: "Users", description: "Members, roles & pending invites.",
    icon: Users, tone: "cyan", href: "/admin/users", cta: "Manage users", category: "Admin",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, adminOnly: true, Body: AdminUsersBody,
  },
  adminAnalytics: {
    type: "adminAnalytics", title: "Analytics", description: "Workspace metrics & trends.",
    icon: BarChart3, tone: "violet", href: "/admin/analytics", cta: "Open analytics", category: "Admin",
    defaultW: 6, defaultH: 3, minW: 3, minH: 2, adminOnly: true, Body: AdminAnalyticsBody,
  },
  adminAudit: {
    type: "adminAudit", title: "Audit Log", description: "Immutable change history, filterable.",
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
