"use client";

// Dashboard widget catalog + body renderers.
//
// Each catalog entry carries the chrome metadata (title, icon, tone, the tool
// it links to) and a `Body` component that renders light, best-effort
// "insights" for that tool. Every data fetch is guarded so a missing
// table/column degrades the widget to a plain link rather than breaking the
// dashboard.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  FileStack, MailPlus, Inbox as InboxIcon, Briefcase, Activity as ActivityIcon,
  Tag, StickyNote, Users, BarChart3, ScrollText, ChevronRight, Loader2, Settings2,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
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
  /** Where the card header navigates ("open the full tool"). */
  href: string;
  defaultWidth: "full" | "half";
  adminOnly?: boolean;
  hasSettings?: boolean;
  Body: React.ComponentType<{ widget: DashboardWidget }>;
}

// ─── small shared bits ───────────────────────────────────────────
function BodyShell({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-sm text-[var(--color-text-muted)]">{children}</div>;
}

function Stat({ value, label, accent }: { value: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-black leading-none ${accent ? "text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mt-1">{label}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-2 flex items-center gap-2 text-[var(--color-text-muted)]">
      <Loader2 className="w-4 h-4 animate-spin" />
      <span className="text-xs">Loading…</span>
    </div>
  );
}

/** Run a guarded, org-scoped fetch. Never throws; returns null on any error. */
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
    // run is intentionally excluded — each body passes a fresh closure and we
    // only want to refetch when the org changes.
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
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── widget bodies ───────────────────────────────────────────────

function DocumentControlBody({ widget }: { widget: DashboardWidget }) {
  const { activeOrgId } = useRole();
  const settings = (widget.settings ?? {}) as DocControlSettings;
  const { data, loading } = useWidgetData(async (orgId) => {
    const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
    return (data ?? []) as Array<{ id: string; name: string }>;
  });

  if (loading) return <Skeleton />;
  const all = data ?? [];
  const chosen = settings.libraryIds?.length
    ? settings.libraryIds.map((id) => all.find((l) => l.id === id)).filter(Boolean) as Array<{ id: string; name: string }>
    : all.slice(0, 6);

  if (!activeOrgId || all.length === 0) {
    return <BodyShell>No libraries yet — open Document Control to set them up.</BodyShell>;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chosen.map((lib) => (
        <Link
          key={lib.id}
          href={`/documents/${lib.id}`}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
        >
          {lib.name}
        </Link>
      ))}
      {all.length > chosen.length && (
        <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-[var(--color-text-muted)]">
          +{all.length - chosen.length} more
        </span>
      )}
    </div>
  );
}

function DraftingRequestsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const open = await headCount(() => supabase.from("tickets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")') as unknown as Promise<{ count: number | null }>);
    const { data: recent } = await supabase.from("tickets")
      .select("id, ticket_id, title")
      .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')
      .order("created_at", { ascending: false }).limit(3);
    return { open, recent: (recent ?? []) as Array<{ id: string; ticket_id: string | null; title: string | null }> };
  });

  if (loading) return <Skeleton />;
  const open = data?.open ?? 0;
  const recent = data?.recent ?? [];
  return (
    <div className="mt-2">
      <Stat value={open} label="Open requests" accent={open > 0} />
      {recent.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {recent.map((t) => (
            <li key={t.id}>
              <Link href={`/requests/${t.id}`} className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors">
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)]">{t.ticket_id ?? "—"}</span>
                <span className="truncate">{t.title ?? "Untitled request"}</span>
              </Link>
            </li>
          ))}
        </ul>
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
    <div className="mt-3 grid grid-cols-3 gap-2">
      <Stat value={data?.openRequests ?? 0} label="Requests" />
      <Stat value={data?.lockedDocs ?? 0} label="Checked out" />
      <Stat value={data?.activeProjects ?? 0} label="Projects" />
    </div>
  );
}

function ProjectsBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const count = await headCount(() => supabase.from("projects").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "active") as unknown as Promise<{ count: number | null }>);
    const { data: recent } = await supabase.from("projects")
      .select("id, name").eq("org_id", orgId).eq("status", "active")
      .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(3);
    return { count, recent: (recent ?? []) as Array<{ id: string; name: string | null }> };
  });

  if (loading) return <Skeleton />;
  const recent = data?.recent ?? [];
  return (
    <div className="mt-2">
      <Stat value={data?.count ?? 0} label="Active projects" />
      {recent.length > 0 && (
        <ul className="mt-3 space-y-1">
          {recent.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="block truncate text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors">
                {p.name ?? "Untitled project"}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const { data } = await supabase.from("audit_logs")
      .select("id, action, created_at").eq("org_id", orgId)
      .order("created_at", { ascending: false }).limit(4);
    return (data ?? []) as Array<{ id: string; action: string | null; created_at: string | null }>;
  });

  if (loading) return <Skeleton />;
  const rows = data ?? [];
  if (rows.length === 0) return <BodyShell>No recent activity yet.</BodyShell>;
  return (
    <ul className="mt-2 space-y-1.5">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-[var(--color-text)]">{(r.action ?? "Activity").replace(/_/g, " ")}</span>
          <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{timeAgo(r.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function EquipmentBody() {
  const { data, loading } = useWidgetData(async (orgId) => {
    const count = await headCount(() => supabase.from("assets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId) as unknown as Promise<{ count: number | null }>);
    return { count };
  });
  if (loading) return <Skeleton />;
  return (
    <div className="mt-2">
      <Stat value={data?.count ?? 0} label="Assets tracked" />
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
  return (
    <div className="mt-2">
      <Stat value={data?.count ?? 0} label="Active members" />
    </div>
  );
}

/** Plain link-only body — for tools where a quiet entry point is enough. */
function LinkBody({ text }: { text: string }) {
  return <BodyShell>{text}</BodyShell>;
}
function ScratchpadBody() { return <LinkBody text="Jot a quick note or pick up open tasks." />; }
function AdminAnalyticsBody() { return <LinkBody text="Throughput, cycle time and workload trends." />; }
function AdminAuditBody() { return <LinkBody text="Immutable history of every change." />; }

// ─── catalog ─────────────────────────────────────────────────────
export const WIDGET_CATALOG: Record<WidgetType, WidgetMeta> = {
  documentControl: {
    type: "documentControl", title: "Document Control", description: "Your controlled libraries — jump straight to one.",
    icon: FileStack, tone: "blue", href: "/documents", defaultWidth: "full", hasSettings: true, Body: DocumentControlBody,
  },
  draftingRequests: {
    type: "draftingRequests", title: "Drafting Requests", description: "Open drafting & design requests.",
    icon: MailPlus, tone: "orange", href: "/requests", defaultWidth: "half", Body: DraftingRequestsBody,
  },
  inbox: {
    type: "inbox", title: "Command Deck", description: "Everything that needs your attention.",
    icon: InboxIcon, tone: "indigo", href: "/inbox", defaultWidth: "half", Body: InboxBody,
  },
  projects: {
    type: "projects", title: "Projects", description: "Multi-document work packages.",
    icon: Briefcase, tone: "violet", href: "/projects", defaultWidth: "half", Body: ProjectsBody,
  },
  activity: {
    type: "activity", title: "Activity", description: "Recent changes across the workspace.",
    icon: ActivityIcon, tone: "emerald", href: "/activity", defaultWidth: "half", Body: ActivityBody,
  },
  equipment: {
    type: "equipment", title: "Equipment", description: "Asset registry & plot-plan map.",
    icon: Tag, tone: "purple", href: "/admin/assets", defaultWidth: "half", Body: EquipmentBody,
  },
  scratchpad: {
    type: "scratchpad", title: "Scratchpad", description: "Personal notes + open tasks.",
    icon: StickyNote, tone: "amber", href: "/scratchpad", defaultWidth: "half", Body: ScratchpadBody,
  },
  adminUsers: {
    type: "adminUsers", title: "Users", description: "Members & roles.",
    icon: Users, tone: "cyan", href: "/admin/users", defaultWidth: "half", adminOnly: true, Body: AdminUsersBody,
  },
  adminAnalytics: {
    type: "adminAnalytics", title: "Analytics", description: "Workspace metrics & trends.",
    icon: BarChart3, tone: "violet", href: "/admin/analytics", defaultWidth: "half", adminOnly: true, Body: AdminAnalyticsBody,
  },
  adminAudit: {
    type: "adminAudit", title: "Audit Log", description: "Immutable change history.",
    icon: ScrollText, tone: "rose", href: "/admin/audit", defaultWidth: "half", adminOnly: true, Body: AdminAuditBody,
  },
};

export const SETTINGS_ICON = Settings2;
export const OPEN_ICON = ChevronRight;
