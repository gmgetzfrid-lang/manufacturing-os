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
import { useRouter } from "next/navigation";
import {
  FileStack, MailPlus, Inbox as InboxIcon, Briefcase, Activity as ActivityIcon,
  Tag, Users, BarChart3, ScrollText, ChevronRight, Settings2,
  Plus, Zap, Rocket, Loader2, Bell, Layers, FileSignature, Send,
  XCircle, AlertTriangle, AlertOctagon, Lock, Flag, Calendar, LayoutDashboard,
  Search,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import NodeCover from "@/components/documents/NodeCover";
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
import { Sparkline, MiniBars, TrendChip, SegmentBar, dayBuckets, vizCat, type Segment } from "./viz";
import type { DashboardWidget, WidgetType, DocControlSettings } from "@/lib/dashboard/types";

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
  Body: React.ComponentType<{ widget: DashboardWidget }>;
}

// ─── small shared bits ───────────────────────────────────────────
// A body root that fills the widget's height so content can flex/scroll.
const FILL = "mt-3 flex-1 min-h-0 flex flex-col";
// NOTE: no `overscroll-contain` here — it turns every widget into a wheel
// trap: page scrolling DIES whenever the cursor happens to be over a card
// (even a non-overflowing one, in Chromium). Let scroll chain naturally.
const SCROLL = "flex-1 min-h-0 overflow-y-auto pr-1 -mr-1";

function BodyShell({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 text-sm text-[var(--color-text-muted)]">{children}</div>;
}

function Stat({ value, label, accent }: { value: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-black leading-none ${accent ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mt-1">{label}</div>
    </div>
  );
}

function Pill({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold border ${
      accent
        ? "bg-[var(--color-accent)] text-white border-transparent"
        : "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]"
    }`}>
      {n}<span className="font-medium opacity-75">{label}</span>
    </span>
  );
}

function Skeleton() {
  return (
    <div className="mt-3 flex-1 min-h-0 space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 rounded-lg bg-[var(--color-surface-2)] animate-pulse" />
      ))}
    </div>
  );
}

/** Honest empty-state for a chart slot. A flat zero line looks broken —
 *  when there's no signal, SAY so instead of drawing it. */
function Quiet({ label }: { label: string }) {
  return <div className="text-[11px] text-[var(--color-text-faint)] italic py-1.5">{label}</div>;
}
const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);

/** Inline quick-jump: type, Enter, land on the target — the "minor mobility"
 *  a widget owes you so you don't have to open the whole tool to navigate. */
function QuickJump({ placeholder, onGo, title }: { placeholder: string; onGo: (q: string) => void; title?: string }) {
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); const v = q.trim(); if (v) onGo(v); }}
      className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 px-2 py-1 focus-within:border-[var(--color-accent)] focus-within:bg-[var(--color-surface)] transition-colors"
      title={title}
    >
      <Search className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none"
      />
    </form>
  );
}

function useWidgetData<T>(run: (orgId: string, uid: string | null) => Promise<T>): { data: T | null; loading: boolean } {
  const { activeOrgId, uid } = useRole();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId) return;
    run(activeOrgId, uid)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setData(null); setLoading(false); } });
    return () => { alive = false; };
    // run is a fresh closure each render; refetch only when the org changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, uid]);
  return { data, loading };
}

async function headCount(build: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await build()).count ?? 0; } catch { return 0; }
}

/** Timestamps from `table.column` in the last `days` days — feeds day-bucket
 *  bars and week-over-week trends. Best-effort: a missing table → []. */
async function fetchRecentDates(table: string, orgId: string, days = 14, column = "created_at"): Promise<string[]> {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data } = await supabase.from(table).select(column).eq("org_id", orgId).gte(column, since).limit(4000);
    return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((r) => r[column]).filter(Boolean) as string[];
  } catch { return []; }
}

/** Split a 14-day date set into this week vs the week before (for TrendChip). */
function weekSplit(dates: string[]): { cur: number; prev: number } {
  const now = Date.now();
  let cur = 0, prev = 0;
  for (const d of dates) {
    const age = now - new Date(d).getTime();
    if (age <= 7 * 86_400_000) cur++;
    else if (age <= 14 * 86_400_000) prev++;
  }
  return { cur, prev };
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Ticket status → short label + badge classes (mirrors the request portal).
const TICKET_STATUS: Record<string, { label: string; cls: string }> = {
  NEW: { label: "New", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  PENDING_ENG_INITIAL: { label: "Eng review", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  PENDING_ENG_TEAM: { label: "Eng team", cls: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  PENDING_ASSIGNMENT: { label: "Unassigned", cls: "bg-purple-50 text-purple-700 border-purple-200" },
  DRAFTING: { label: "Drafting", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  PENDING_REVIEW: { label: "In review", cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  REVISION_REQ: { label: "Revisions", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  PENDING_IFC: { label: "Pending IFC", cls: "bg-teal-50 text-teal-700 border-teal-200" },
  FINAL_DRAFT: { label: "Final draft", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  PENDING_FINAL_APPROVAL: { label: "Final appr.", cls: "bg-lime-50 text-lime-700 border-lime-200" },
  CLOSED: { label: "Closed", cls: "bg-gray-100 text-gray-500 border-gray-200" },
  CANCELED: { label: "Canceled", cls: "bg-gray-100 text-gray-500 border-gray-200" },
};
function ticketStatus(s: string | null | undefined) {
  return (s && TICKET_STATUS[s]) || { label: s ?? "—", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" };
}

// ─── widget bodies ───────────────────────────────────────────────

interface Lib { id: string; name: string; color?: string | null; icon?: string | null; type?: string | null; cover_image_url?: string | null; cover_tint?: "none" | "brand" | "mono" | null; count?: number }

function DocumentControlBody({ widget }: { widget: DashboardWidget }) {
  const settings = (widget.settings ?? {}) as DocControlSettings;
  const { data, loading } = useWidgetData(async (orgId) => {
    let libs: Lib[] = [];
    const rich = await supabase.from("libraries").select("id, name, color, icon, type, cover_image_url, cover_tint").eq("org_id", orgId).order("name");
    if (!rich.error) {
      libs = (rich.data ?? []) as Lib[];
    } else {
      // Cover columns may be absent — keep color/icon for the gradient panel.
      const mid = await supabase.from("libraries").select("id, name, color, icon").eq("org_id", orgId).order("name");
      if (!mid.error) {
        libs = (mid.data ?? []) as Lib[];
      } else {
        const min = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
        libs = (min.data ?? []) as Lib[];
      }
    }
    const head = libs.slice(0, 24);
    const [counted, totalDocs, newDates] = await Promise.all([
      Promise.all(head.map(async (l) => ({
        ...l,
        count: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
          .eq("org_id", orgId).eq("library_id", l.id) as unknown as Promise<{ count: number | null }>),
      }))),
      headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
      fetchRecentDates("documents", orgId, 14),
    ]);
    return { libs: [...counted, ...libs.slice(24)], totalDocs, newDates };
  });

  if (loading) return <Skeleton />;
  const all = data?.libs ?? [];
  if (all.length === 0) {
    return (
      <BodyShell>
        <Link href="/admin/libraries" className="font-bold text-[var(--color-accent)] hover:underline">
          No libraries yet — create your first library →
        </Link>
      </BodyShell>
    );
  }
  // When the user has hand-picked libraries, honor that exact set; otherwise
  // show as many as fit — the multi-column grid + internal scroll handle volume.
  const chosen = settings.libraryIds?.length
    ? (settings.libraryIds.map((id) => all.find((l) => l.id === id)).filter(Boolean) as Lib[])
    : all;
  const buckets = dayBuckets(data?.newDates ?? [], 14);
  const wk = weekSplit(data?.newDates ?? []);

  return (
    <div className={FILL}>
      {/* Pulse strip: how big the controlled set is + 14-day intake rhythm. */}
      <div className="mb-3 flex items-end justify-between gap-4 shrink-0">
        <div className="flex items-end gap-2">
          <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{(data?.totalDocs ?? 0).toLocaleString()}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">controlled documents</span>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          <TrendChip current={wk.cur} previous={wk.prev} />
          {sum(buckets.counts) > 0 && (
            <div className="w-28 hidden sm:block"><MiniBars values={buckets.counts} labels={buckets.labels} height={28} /></div>
          )}
        </div>
      </div>
      {/* Find a drawing without opening the tool — Enter jumps to search. */}
      <div className="mb-3 shrink-0">
        <DocQuickFind />
      </div>
      {/* Responsive multi-column grid: cards flow to fill a wide widget instead
          of stretching a single column across empty space. */}
      <div className={`grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 ${SCROLL}`}>
        {chosen.map((lib) => (
          <Link
            key={lib.id}
            href={`/documents/${lib.id}`}
            className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-accent)] hover:shadow-md transition-[border-color,box-shadow]"
          >
            <NodeCover
              appearance={{ color: lib.color, icon: lib.icon, coverImageUrl: lib.cover_image_url, coverTint: lib.cover_tint }}
              className="w-full h-16"
              rounded="rounded-none"
              iconSize="w-5 h-5"
            />
            <div className="p-2.5 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{lib.name}</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate">
                  {lib.count != null ? `${lib.count.toLocaleString()} document${lib.count === 1 ? "" : "s"}` : (lib.type || "Library")}
                </div>
              </div>
              <span className="shrink-0 w-5 h-5 rounded-md grid place-items-center text-[var(--color-accent)] bg-[var(--color-accent-soft)] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200">
                <ArrowUpRight className="w-3 h-3" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// Router-backed quick-jumps (tiny components so the widget bodies that
// don't need a router don't pay for one).
function DocQuickFind() {
  const router = useRouter();
  return (
    <QuickJump
      placeholder="Find a document — number, title, tag…"
      title="Searches everything; Enter opens results"
      onGo={(q) => router.push(`/search?q=${encodeURIComponent(q)}`)}
    />
  );
}
function AssetQuickJump() {
  const router = useRouter();
  return (
    <QuickJump
      placeholder="Jump to a tag — e.g. P-101…"
      title="Opens that asset's registry page"
      onGo={(q) => router.push(`/assets/${encodeURIComponent(q)}`)}
    />
  );
}

interface TicketRow {
  id: string; ticket_id: string | null; title: string | null; status: string | null;
  created_at: string | null; requester_name: string | null;
  assigned_drafter_name: string | null; updated_at: string | null;
}

function DraftingRequestsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [statusRes, recentRes, newDates] = await Promise.all([
      supabase.from("tickets").select("status")
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")').limit(2000),
      supabase.from("tickets")
        .select("id, ticket_id, title, status, created_at, requester_name, assigned_drafter_name, updated_at")
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')
        .order("created_at", { ascending: false }).limit(30),
      fetchRecentDates("tickets", orgId, 14),
    ]);
    const byStatus = new Map<string, number>();
    for (const r of ((statusRes.data ?? []) as Array<{ status: string | null }>)) {
      const s = r.status ?? "NEW";
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    const open = Array.from(byStatus.values()).reduce((a, b) => a + b, 0);
    return { open, byStatus, recent: (recentRes.data ?? []) as TicketRow[], newDates };
  });

  if (loading) return <Skeleton />;
  const open = data?.open ?? 0;
  const recent = data?.recent ?? [];
  const by = (keys: string[]) => keys.reduce((s, k) => s + (data?.byStatus.get(k) ?? 0), 0);
  // Pipeline stages in FIXED order (slot ↔ color assignment never shifts).
  const pipeline: Segment[] = [
    { label: "New", count: by(["NEW"]) },
    { label: "Eng review", count: by(["PENDING_ENG_INITIAL", "PENDING_ENG_TEAM"]) },
    { label: "Unassigned", count: by(["PENDING_ASSIGNMENT"]) },
    { label: "Drafting", count: by(["DRAFTING"]) },
    { label: "In review", count: by(["PENDING_REVIEW", "REVISION_REQ"]) },
    { label: "Closing out", count: by(["PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL"]) },
  ];
  const wk = weekSplit(data?.newDates ?? []);

  return (
    <div className={FILL}>
      {/* The pipeline at a glance: where every open request sits, plus this
          week's intake vs last. */}
      <div className="flex items-end justify-between gap-3 shrink-0">
        <div className="flex items-end gap-2">
          <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{open}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">open requests</span>
        </div>
        <div className="flex items-center gap-2">
          <TrendChip current={wk.cur} previous={wk.prev} />
          <Link href="/requests/new" className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-[var(--color-accent)] hover:opacity-90 transition-opacity">
            <Plus className="w-3 h-3" /> New
          </Link>
        </div>
      </div>
      {open > 0 && <SegmentBar segments={pipeline} className="mt-2.5 shrink-0" />}

      {recent.length === 0 ? (
        <BodyShell>
          No open requests.{" "}
          <Link href="/requests/new" className="font-semibold text-[var(--color-accent)] hover:underline">Raise one →</Link>
        </BodyShell>
      ) : (
        <div className={`mt-3 space-y-0.5 ${SCROLL}`}>
          {recent.map((t) => {
            const st = ticketStatus(t.status);
            return (
              <Link key={t.id} href={`/requests/${t.id}`} className="group block p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)] shrink-0">{t.ticket_id ?? "—"}</span>
                  <span className="flex-1 min-w-0 text-[13px] font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{t.title ?? "Untitled request"}</span>
                  <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                </div>
                <div className="mt-0.5 pl-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] min-w-0">
                  <span className="truncate">
                    {t.requester_name || "Unknown requester"}
                  </span>
                  <span className="text-[var(--color-text-faint)] shrink-0">→</span>
                  <span className={`truncate ${t.assigned_drafter_name ? "font-semibold text-[var(--color-text)]" : "italic text-amber-700 dark:text-amber-500"}`}>
                    {t.assigned_drafter_name || "unassigned"}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-faint)] tabular-nums">
                    {timeAgo(t.created_at)}{t.updated_at && t.updated_at !== t.created_at ? ` · touched ${timeAgo(t.updated_at)}` : ""}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
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
    <div className={FILL}>
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
  const { activeOrgId, uid, userEmail } = useRole();
  const [snap, setSnap] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId || !uid) return;
    loadInbox(activeOrgId, uid, userEmail ?? undefined)
      .then((s) => { if (alive) { setSnap(s); setLoading(false); } })
      .catch(() => { if (alive) { setSnap(null); setLoading(false); } });
    return () => { alive = false; };
  }, [activeOrgId, uid, userEmail]);

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
  const [snap, setSnap] = useState<InboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!activeOrgId || !uid) return;
    loadInbox(activeOrgId, uid, userEmail ?? undefined)
      .then((s) => { if (alive) { setSnap(s); setLoading(false); } })
      .catch(() => { if (alive) { setSnap(null); setLoading(false); } });
    return () => { alive = false; };
  }, [activeOrgId, uid, userEmail, reloadKey]);
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

interface ProjRow { id: string; name: string | null; status: string | null; last_activity_at: string | null }
function ProjectsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [count, recentRes, activityDates] = await Promise.all([
      headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
      supabase.from("projects")
        .select("id, name, status, last_activity_at").eq("org_id", orgId).eq("status", "active")
        .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(16),
      fetchRecentDates("project_activity", orgId, 14),
    ]);
    // Freshness derived at load time (render must stay pure — no Date.now()).
    const now = Date.now();
    const recent = ((recentRes.data ?? []) as ProjRow[]).map((p) => ({
      ...p,
      quietDays: p.last_activity_at ? Math.floor((now - new Date(p.last_activity_at).getTime()) / 86_400_000) : null,
    }));
    return { count, recent, activityDates };
  });

  if (loading) return <Skeleton />;
  const recent = data?.recent ?? [];
  const buckets = dayBuckets(data?.activityDates ?? [], 14);
  const wk = weekSplit(data?.activityDates ?? []);
  return (
    <div className={FILL}>
      <div className="flex items-center justify-between gap-3 shrink-0">
        <Pill n={data?.count ?? 0} label="active projects" accent />
        <div className="flex items-center gap-2 min-w-0">
          <TrendChip current={wk.cur} previous={wk.prev} />
          {sum(buckets.counts) > 0 && (
            <div className="w-24 hidden sm:block"><MiniBars values={buckets.counts} labels={buckets.labels} height={24} /></div>
          )}
          <Link href="/projects" className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-[var(--color-accent)] hover:opacity-90 transition-opacity">
            <Plus className="w-3 h-3" /> New
          </Link>
        </div>
      </div>
      {recent.length > 0 && (
        <div className={`mt-3 space-y-0.5 ${SCROLL}`}>
          {recent.map((p) => {
            const quietDays = p.quietDays;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
                {/* Freshness dot: green = touched this week, amber = fortnight, grey = idle */}
                <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${quietDays == null ? "bg-slate-300" : quietDays <= 7 ? "bg-emerald-500" : quietDays <= 14 ? "bg-amber-500" : "bg-slate-300"}`} />
                <span className="flex-1 min-w-0 text-[13px] text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{p.name ?? "Untitled project"}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]" title={p.last_activity_at ? `Last activity ${new Date(p.last_activity_at).toLocaleString()}` : "No recorded activity"}>
                  {p.last_activity_at ? timeAgo(p.last_activity_at) : "—"}
                </span>
                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-60 sm:opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface AuditRow { id: string; action: string | null; timestamp: string | null }
function ActivityBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [{ data: rows }, dates] = await Promise.all([
      supabase.from("audit_logs")
        .select("id, action, timestamp").eq("org_id", orgId)
        .order("timestamp", { ascending: false }).limit(30),
      fetchRecentDates("audit_logs", orgId, 14, "timestamp"),
    ]);
    return { rows: (rows ?? []) as AuditRow[], dates };
  });

  if (loading) return <Skeleton />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) return <BodyShell>No recent activity yet.</BodyShell>;
  const buckets = dayBuckets(data?.dates ?? [], 14);
  return (
    <div className={FILL}>
      {/* The workspace heartbeat — 14 days of change volume, then the feed. */}
      {sum(buckets.counts) > 0 && (
        <div className="shrink-0 mb-2">
          <Sparkline values={buckets.counts} labels={buckets.labels} height={34} />
        </div>
      )}
      <ul className={`space-y-0.5 ${SCROLL}`}>
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
            <span className="truncate text-[13px] text-[var(--color-text)] capitalize">{(r.action ?? "activity").replace(/_/g, " ").toLowerCase()}</span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{timeAgo(r.timestamp)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface AssetRow { id: string; tag: string | null }
function EquipmentBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const count = await headCount(() => supabase.from("assets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>);
    const { data: recent } = await supabase.from("assets").select("id, tag").eq("org_id", orgId).limit(24);
    return { count, recent: (recent ?? []) as AssetRow[] };
  });
  if (loading) return <Skeleton />;
  const recent = data?.recent ?? [];
  return (
    <div className={FILL}>
      <div className="flex items-center gap-2 shrink-0">
        <Pill n={data?.count ?? 0} label="assets tracked" accent />
        <div className="flex-1 min-w-0"><AssetQuickJump /></div>
      </div>
      {recent.length > 0 && (
        <div className={`mt-3 flex flex-wrap gap-1.5 content-start ${SCROLL}`}>
          {recent.map((a) => (
            <Link key={a.id} href={`/assets/${encodeURIComponent(a.tag ?? a.id)}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors h-fit">
              <Tag className="w-3 h-3" /> {a.tag ?? "—"}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminUsersBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const { data: rows } = await supabase.from("org_members").select("role")
      .eq("org_id", orgId).eq("status", "active").limit(2000);
    const byRole = new Map<string, number>();
    for (const r of ((rows ?? []) as Array<{ role: string | null }>)) {
      const role = r.role || "Member";
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }
    return { byRole, count: Array.from(byRole.values()).reduce((a, b) => a + b, 0) };
  });
  if (loading) return <Skeleton />;
  // Top 5 roles + "Other" — fixed slot order by size (never more than 6 hues).
  const entries = Array.from((data?.byRole ?? new Map<string, number>()).entries()).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 5).map(([label, count]) => ({ label, count }));
  const other = entries.slice(5).reduce((s, [, c]) => s + c, 0);
  const segments: Segment[] = other > 0 ? [...top, { label: "Other", count: other }] : top;
  return (
    <div className={FILL}>
      <div className="flex items-end gap-2 shrink-0">
        <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{data?.count ?? 0}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">active members</span>
      </div>
      {segments.length > 0 && <SegmentBar segments={segments} className="mt-3 shrink-0" />}
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
    <div className={FILL}>
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

// Audit — the change-volume pulse + total, so the card answers "how busy was
// the log this week" before you even open it.
function AdminAuditBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [dates, total] = await Promise.all([
      fetchRecentDates("audit_logs", orgId, 14, "timestamp"),
      headCount(() => supabase.from("audit_logs").select("id", { count: "exact", head: true })
        .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
    ]);
    return { dates, total };
  });
  if (loading) return <Skeleton />;
  const buckets = dayBuckets(data?.dates ?? [], 14);
  const wk = weekSplit(data?.dates ?? []);
  return (
    <div className={FILL}>
      <div className="flex items-end justify-between gap-3 shrink-0">
        <div className="flex items-end gap-2">
          <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{(data?.total ?? 0).toLocaleString()}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">events on record</span>
        </div>
        <TrendChip current={wk.cur} previous={wk.prev} />
      </div>
      <div className="mt-3 shrink-0">
        {sum(buckets.counts) > 0
          ? <MiniBars values={buckets.counts} labels={buckets.labels} height={34} />
          : <Quiet label="No events recorded in the last 14 days." />}
      </div>
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
    icon: LayoutDashboard, tone: "indigo", href: "/inbox", cta: "Open command deck",
    defaultW: 12, defaultH: 4, minW: 6, minH: 3, maxW: 12, bare: true, Body: CommandDeckBody,
  },
  documentControl: {
    type: "documentControl", title: "Document Control", description: "Your controlled libraries.",
    icon: FileStack, tone: "blue", href: "/documents", cta: "Open Document Control",
    defaultW: 12, defaultH: 3, minW: 4, minH: 2, hasSettings: true, Body: DocumentControlBody,
  },
  draftingRequests: {
    type: "draftingRequests", title: "Drafting Requests", description: "Open drafting & design requests.",
    icon: MailPlus, tone: "orange", href: "/requests", cta: "Open request portal",
    defaultW: 6, defaultH: 4, minW: 4, minH: 3, Body: DraftingRequestsBody,
  },
  inbox: {
    type: "inbox", title: "Inbox", description: "Everything that needs you.",
    icon: InboxIcon, tone: "indigo", href: "/inbox", cta: "Open inbox",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: InboxBody,
  },
  dailyBrief: {
    type: "dailyBrief", title: "Daily Brief", description: "Your day, narrated + what to do next.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck",
    defaultW: 6, defaultH: 5, minW: 4, minH: 3, Body: DailyBriefBody,
  },
  quickLaunch: {
    type: "quickLaunch", title: "Quick Launch", description: "Jump straight into common actions.",
    icon: Rocket, tone: "orange", href: "/inbox", cta: "Open command deck",
    defaultW: 3, defaultH: 5, minW: 2, minH: 3, Body: QuickLaunchBody,
  },
  attention: {
    type: "attention", title: "Needs You", description: "Everything waiting on your attention.",
    icon: Bell, tone: "rose", href: "/inbox", cta: "Open command deck",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: AttentionBody,
  },
  suggestedActions: {
    type: "suggestedActions", title: "Suggested Actions", description: "Proactive nudges — what to do next.",
    icon: Zap, tone: "amber", href: "/inbox", cta: "Open command deck",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: SuggestedActionsBody,
  },
  outstanding: {
    type: "outstanding", title: "Outstanding", description: "Markups, checkouts, holds & milestones.",
    icon: Layers, tone: "indigo", href: "/inbox", cta: "Open command deck",
    defaultW: 6, defaultH: 6, minW: 4, minH: 4, Body: OutstandingBody,
  },
  projects: {
    type: "projects", title: "Projects", description: "Multi-document work packages.",
    icon: Briefcase, tone: "violet", href: "/projects", cta: "Open projects",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: ProjectsBody,
  },
  activity: {
    type: "activity", title: "Activity", description: "Recent changes across the workspace.",
    icon: ActivityIcon, tone: "emerald", href: "/activity", cta: "Open activity",
    defaultW: 6, defaultH: 4, minW: 3, minH: 3, Body: ActivityBody,
  },
  equipment: {
    type: "equipment", title: "Equipment", description: "Asset registry & plot-plan map.",
    icon: Tag, tone: "purple", href: "/admin/assets", cta: "Open equipment",
    defaultW: 6, defaultH: 3, minW: 3, minH: 2, Body: EquipmentBody,
  },
  adminUsers: {
    type: "adminUsers", title: "Users", description: "Members & roles.",
    icon: Users, tone: "cyan", href: "/admin/users", cta: "Manage users",
    defaultW: 6, defaultH: 2, minW: 3, minH: 2, adminOnly: true, Body: AdminUsersBody,
  },
  adminAnalytics: {
    type: "adminAnalytics", title: "Analytics", description: "Workspace metrics & trends.",
    icon: BarChart3, tone: "violet", href: "/admin/analytics", cta: "Open analytics",
    defaultW: 6, defaultH: 2, minW: 3, minH: 2, adminOnly: true, Body: AdminAnalyticsBody,
  },
  adminAudit: {
    type: "adminAudit", title: "Audit Log", description: "Immutable change history.",
    icon: ScrollText, tone: "rose", href: "/admin/audit", cta: "Open audit log",
    defaultW: 6, defaultH: 2, minW: 3, minH: 2, adminOnly: true, Body: AdminAuditBody,
  },
};

export const SETTINGS_ICON = Settings2;
export const OPEN_ICON = ChevronRight;
export const ADD_ICON = Plus;
export const LOADER_ICON = Loader2;
