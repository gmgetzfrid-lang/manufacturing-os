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

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  FileStack, MailPlus, Inbox as InboxIcon, Briefcase, Activity as ActivityIcon,
  Tag, StickyNote, Users, BarChart3, ScrollText, ChevronRight, Settings2,
  Plus, FileText, Zap, Rocket, Loader2,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { NodeIcon } from "@/lib/nodeIcons";
import { loadInbox, type InboxSnapshot } from "@/lib/inbox";
import { computeNudges } from "@/lib/nudges";
import { DailyBrief } from "@/components/cockpit/DailyBrief";
import { QuickLaunch } from "@/components/cockpit/QuickLaunch";
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
  Body: React.ComponentType<{ widget: DashboardWidget }>;
}

// ─── small shared bits ───────────────────────────────────────────
// A body root that fills the widget's height so content can flex/scroll.
const FILL = "mt-3 flex-1 min-h-0 flex flex-col";
const SCROLL = "flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 -mr-1";

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

function libTint(color?: string | null): { backgroundColor: string; color: string } {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return { backgroundColor: `${color}1f`, color };
  return { backgroundColor: "var(--color-surface-2)", color: "var(--color-accent)" };
}

// ─── widget bodies ───────────────────────────────────────────────

interface Lib { id: string; name: string; color?: string | null; icon?: string | null; type?: string | null; count?: number }

function DocumentControlBody({ widget }: { widget: DashboardWidget }) {
  const settings = (widget.settings ?? {}) as DocControlSettings;
  const { data, loading } = useWidgetData(async (orgId) => {
    let libs: Lib[] = [];
    const rich = await supabase.from("libraries").select("id, name, color, icon, type").eq("org_id", orgId).order("name");
    if (rich.error) {
      const min = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
      libs = (min.data ?? []) as Lib[];
    } else {
      libs = (rich.data ?? []) as Lib[];
    }
    const head = libs.slice(0, 24);
    const counted = await Promise.all(head.map(async (l) => ({
      ...l,
      count: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("library_id", l.id) as unknown as Promise<{ count: number | null }>),
    })));
    return { libs: [...counted, ...libs.slice(24)] };
  });

  if (loading) return <Skeleton />;
  const all = data?.libs ?? [];
  if (all.length === 0) {
    return <BodyShell>No libraries yet — open Document Control to set them up.</BodyShell>;
  }
  // When the user has hand-picked libraries, honor that exact set; otherwise
  // show as many as fit — the multi-column grid + internal scroll handle volume.
  const chosen = settings.libraryIds?.length
    ? (settings.libraryIds.map((id) => all.find((l) => l.id === id)).filter(Boolean) as Lib[])
    : all;

  return (
    <div className={FILL}>
      {/* Responsive multi-column grid: cards flow to fill a wide widget instead
          of stretching a single column across empty space. */}
      <div className={`grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 ${SCROLL}`}>
        {chosen.map((lib) => (
          <Link
            key={lib.id}
            href={`/documents/${lib.id}`}
            className="group flex items-center gap-3 p-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] hover:shadow-sm transition-all"
          >
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0" style={libTint(lib.color)}>
              <NodeIcon name={lib.icon} className="w-5 h-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{lib.name}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {lib.count != null ? `${lib.count} document${lib.count === 1 ? "" : "s"}` : (lib.type || "Library")}
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}

interface TicketRow { id: string; ticket_id: string | null; title: string | null; status: string | null; created_at: string | null }

function DraftingRequestsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const openQ = () => supabase.from("tickets").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    const [open, drafting, review, unassigned, recentRes] = await Promise.all([
      headCount(() => openQ().not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
      headCount(() => openQ().eq("status", "DRAFTING") as unknown as Promise<{ count: number | null }>),
      headCount(() => openQ().eq("status", "PENDING_REVIEW") as unknown as Promise<{ count: number | null }>),
      headCount(() => openQ().eq("status", "PENDING_ASSIGNMENT") as unknown as Promise<{ count: number | null }>),
      supabase.from("tickets").select("id, ticket_id, title, status, created_at")
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')
        .order("created_at", { ascending: false }).limit(30),
    ]);
    return { open, drafting, review, unassigned, recent: (recentRes.data ?? []) as TicketRow[] };
  });

  if (loading) return <Skeleton />;
  const open = data?.open ?? 0;
  const recent = data?.recent ?? [];

  return (
    <div className={FILL}>
      <div className="flex flex-wrap gap-1.5">
        <Pill n={open} label="open" accent />
        <Pill n={data?.drafting ?? 0} label="drafting" />
        <Pill n={data?.review ?? 0} label="in review" />
        <Pill n={data?.unassigned ?? 0} label="unassigned" />
      </div>

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
              <Link key={t.id} href={`/requests/${t.id}`} className="group flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)] shrink-0">{t.ticket_id ?? "—"}</span>
                <span className="flex-1 min-w-0 text-[13px] text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{t.title ?? "Untitled request"}</span>
                <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] w-7 text-right">{timeAgo(t.created_at)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InboxBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const [openRequests, lockedDocs, activeProjects] = await Promise.all([
      headCount(() => supabase.from("tickets").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).not("checked_out_by", "is", null) as unknown as Promise<{ count: number | null }>),
      headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>),
    ]);
    return { openRequests, lockedDocs, activeProjects };
  });

  if (loading) return <Skeleton />;
  return (
    <div className={FILL}>
      <div className="grid grid-cols-3 gap-2">
        <Stat value={data?.openRequests ?? 0} label="Requests" />
        <Stat value={data?.lockedDocs ?? 0} label="Checked out" />
        <Stat value={data?.activeProjects ?? 0} label="Projects" />
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

interface ProjRow { id: string; name: string | null; status: string | null }
function ProjectsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const count = await headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>);
    const { data: recent } = await supabase.from("projects")
      .select("id, name, status").eq("org_id", orgId).eq("status", "active")
      .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(16);
    return { count, recent: (recent ?? []) as ProjRow[] };
  });

  if (loading) return <Skeleton />;
  const recent = data?.recent ?? [];
  return (
    <div className={FILL}>
      <Pill n={data?.count ?? 0} label="active projects" accent />
      {recent.length > 0 && (
        <div className={`mt-3 space-y-0.5 ${SCROLL}`}>
          {recent.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="group flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
              <Briefcase className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
              <span className="flex-1 min-w-0 text-[13px] text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{p.name ?? "Untitled project"}</span>
              <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

interface AuditRow { id: string; action: string | null; created_at: string | null }
function ActivityBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const { data } = await supabase.from("audit_logs")
      .select("id, action, created_at").eq("org_id", orgId)
      .order("created_at", { ascending: false }).limit(30);
    return (data ?? []) as AuditRow[];
  });

  if (loading) return <Skeleton />;
  const rows = data ?? [];
  if (rows.length === 0) return <BodyShell>No recent activity yet.</BodyShell>;
  return (
    <div className={FILL}>
      <ul className={`space-y-0.5 ${SCROLL}`}>
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
            <span className="truncate text-[13px] text-[var(--color-text)] capitalize">{(r.action ?? "activity").replace(/_/g, " ")}</span>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{timeAgo(r.created_at)}</span>
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
      <Pill n={data?.count ?? 0} label="assets tracked" accent />
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
    const count = await headCount(() => supabase.from("org_members").select("uid", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>);
    return { count };
  });
  if (loading) return <Skeleton />;
  return <div className="mt-3"><Pill n={data?.count ?? 0} label="active members" accent /></div>;
}

function LinkBody({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
      <Icon className="w-4 h-4 shrink-0" /> {text}
    </div>
  );
}
function ScratchpadBody() { return <LinkBody icon={StickyNote} text="Jot a quick note or pick up open tasks." />; }
function AdminAnalyticsBody() { return <LinkBody icon={BarChart3} text="Throughput, cycle time and workload trends." />; }
function AdminAuditBody() { return <LinkBody icon={FileText} text="Immutable history of every change." />; }

// ─── catalog ─────────────────────────────────────────────────────
export const WIDGET_CATALOG: Record<WidgetType, WidgetMeta> = {
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
    type: "inbox", title: "Command Deck", description: "Everything that needs you.",
    icon: InboxIcon, tone: "indigo", href: "/inbox", cta: "Open command deck",
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
  scratchpad: {
    type: "scratchpad", title: "Scratchpad", description: "Personal notes + open tasks.",
    icon: StickyNote, tone: "amber", href: "/scratchpad", cta: "Open scratchpad",
    defaultW: 6, defaultH: 2, minW: 3, minH: 2, Body: ScratchpadBody,
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
