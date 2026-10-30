"use client";

// The work widgets, at full strength: each one filters, searches or drills in
// place instead of only counting things and sending you elsewhere.

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus, ChevronRight, Tag, FileText, Briefcase, MailPlus, Users, Shield, User, BookOpen,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { TrendChip, MiniBars, Sparkline, SegmentBar, dayBuckets, type Segment } from "../viz";
import {
  useWidget, useSetting, useWidgetData, Tabs, SearchField, useDebounced, Skeleton, Empty, timeAgo,
  headCount, fetchRecentDates, weekSplit, sum, FILL, SCROLL,
} from "../kit";

// ─── Drafting requests ───────────────────────────────────────────

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
const ticketStatus = (s: string | null | undefined) =>
  (s && TICKET_STATUS[s]) || { label: s ?? "-", cls: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" };

// Pipeline stages in FIXED order (slot ↔ color assignment never shifts).
const STAGES: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "new", label: "New", statuses: ["NEW"] },
  { key: "eng", label: "Eng review", statuses: ["PENDING_ENG_INITIAL", "PENDING_ENG_TEAM"] },
  { key: "unassigned", label: "Unassigned", statuses: ["PENDING_ASSIGNMENT"] },
  { key: "drafting", label: "Drafting", statuses: ["DRAFTING"] },
  { key: "review", label: "In review", statuses: ["PENDING_REVIEW", "REVISION_REQ"] },
  { key: "closing", label: "Closing out", statuses: ["PENDING_IFC", "FINAL_DRAFT", "PENDING_FINAL_APPROVAL"] },
];

interface TicketRow {
  id: string; ticket_id: string | null; title: string | null; status: string | null; priority: number | null;
  created_at: string | null; updated_at: string | null;
  requester_id: string | null; requester_name: string | null;
  assigned_drafter_id: string | null; assigned_drafter_name: string | null;
  assigned_engineer_id: string | null;
}
type ReqScope = "mine" | "assigned" | "unassigned" | "all";

export function DraftingRequestsBody() {
  const { uid } = useRole();
  const { expanded } = useWidget();
  const [scope, setScope] = useSetting<ReqScope>("scope", "all");
  const [stage, setStage] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim().toLowerCase(), 150);

  const { data, loading } = useWidgetData(async (orgId) => {
    const [rows, newDates] = await Promise.all([
      supabase.from("tickets")
        .select("id, ticket_id, title, status, priority, created_at, updated_at, requester_id, requester_name, assigned_drafter_id, assigned_drafter_name, assigned_engineer_id")
        .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')
        .order("created_at", { ascending: false }).limit(500),
      fetchRecentDates("tickets", orgId, 14),
    ]);
    return { rows: (rows.data ?? []) as TicketRow[], newDates };
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const inScope = useMemo(() => rows.filter((t) => {
    if (scope === "mine") return t.requester_id === uid;
    if (scope === "assigned") return t.assigned_drafter_id === uid || t.assigned_engineer_id === uid;
    if (scope === "unassigned") return !t.assigned_drafter_id;
    return true;
  }), [rows, scope, uid]);
  const counts = {
    mine: rows.filter((t) => t.requester_id === uid).length,
    assigned: rows.filter((t) => t.assigned_drafter_id === uid || t.assigned_engineer_id === uid).length,
    unassigned: rows.filter((t) => !t.assigned_drafter_id).length,
    all: rows.length,
  };
  const stageCounts = STAGES.map((s) => ({ ...s, count: inScope.filter((t) => s.statuses.includes(t.status ?? "NEW")).length }));
  const shown = inScope.filter((t) => {
    if (stage && !STAGES.find((s) => s.key === stage)!.statuses.includes(t.status ?? "NEW")) return false;
    if (dq && !`${t.ticket_id ?? ""} ${t.title ?? ""} ${t.requester_name ?? ""} ${t.assigned_drafter_name ?? ""}`.toLowerCase().includes(dq)) return false;
    return true;
  });

  if (loading) return <Skeleton />;
  const wk = weekSplit(data?.newDates ?? []);

  return (
    <div className={FILL}>
      <div className="flex items-center justify-between gap-2 shrink-0">
        <Tabs<ReqScope> value={scope} onChange={(v) => { setScope(v); setStage(null); }}
          options={[
            { value: "all", label: "All open", count: counts.all },
            { value: "assigned", label: "Assigned to me", count: counts.assigned },
            { value: "mine", label: "I asked", count: counts.mine },
            { value: "unassigned", label: "Unassigned", count: counts.unassigned },
          ]} />
        <div className="flex items-center gap-2 shrink-0">
          <TrendChip current={wk.cur} previous={wk.prev} />
          <Link href="/requests/new" className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-[var(--color-accent)] hover:opacity-90">
            <Plus className="w-3 h-3" /> New
          </Link>
        </div>
      </div>
      {/* The pipeline — tap a stage to see just those. */}
      {inScope.length > 0 && (
        <div className="mt-2 shrink-0 flex flex-wrap gap-1">
          {stageCounts.filter((s) => s.count > 0).map((s) => (
            <button key={s.key} type="button" onClick={() => setStage(stage === s.key ? null : s.key)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold border transition-colors ${
                stage === s.key ? "bg-[var(--color-accent)] text-white border-transparent" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]"}`}>
              {s.label} <span className="tabular-nums">{s.count}</span>
            </button>
          ))}
        </div>
      )}
      {inScope.length > 4 && <div className="mt-2 shrink-0"><SearchField value={q} onChange={setQ} placeholder="Filter by number, title, person…" /></div>}

      {shown.length === 0 ? (
        <Empty>
          {inScope.length === 0
            ? scope === "assigned" ? "Nothing assigned to you right now." : scope === "mine" ? "You have no open requests." : "No open requests."
            : "Nothing matches that filter."}{" "}
          <Link href="/requests/new" className="font-semibold text-[var(--color-accent)] hover:underline">Raise one →</Link>
        </Empty>
      ) : (
        <div className={`mt-2 space-y-0.5 ${SCROLL}`}>
          {shown.slice(0, expanded ? 200 : 40).map((t) => {
            const st = ticketStatus(t.status);
            return (
              <Link key={t.id} href={`/requests/${t.id}`} className="group block p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)] shrink-0">{t.ticket_id ?? "-"}</span>
                  <span className="flex-1 min-w-0 text-[13px] font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)]">{t.title ?? "Untitled request"}</span>
                  {(t.priority ?? 0) >= 3 && <span className="shrink-0 text-[9px] font-black px-1 rounded bg-rose-600 text-white">P{t.priority}</span>}
                  <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                </div>
                <div className="mt-0.5 pl-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] min-w-0">
                  <span className="truncate">{t.requester_id === uid ? "You" : t.requester_name || "Unknown requester"}</span>
                  <span className="text-[var(--color-text-faint)] shrink-0">→</span>
                  <span className={`truncate ${t.assigned_drafter_name ? "font-semibold text-[var(--color-text)]" : "italic text-amber-700 dark:text-amber-500"}`}>
                    {t.assigned_drafter_id === uid ? "you" : t.assigned_drafter_name || "unassigned"}
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

// ─── Projects ────────────────────────────────────────────────────

interface ProjRow {
  id: string; name: string | null; status: string | null; last_activity_at: string | null;
  owner_user_id: string | null; owner_user_name: string | null; target_completion_date: string | null; moc_reference: string | null;
}
type ProjScope = "active" | "mine" | "quiet" | "due";

export function ProjectsBody() {
  const { uid } = useRole();
  const [scope, setScope] = useSetting<ProjScope>("scope", "active");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim().toLowerCase(), 150);
  const { data, loading } = useWidgetData(async (orgId, me) => {
    const [res, activityDates, memberOf] = await Promise.all([
      supabase.from("projects")
        .select("id, name, status, last_activity_at, owner_user_id, owner_user_name, target_completion_date, moc_reference")
        .eq("org_id", orgId).eq("status", "active")
        .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(300),
      fetchRecentDates("project_activity", orgId, 14),
      me ? supabase.from("project_members").select("project_id").eq("user_id", me).limit(1000) : Promise.resolve({ data: [] }),
    ]);
    const now = Date.now();
    const rows = ((res.data ?? []) as ProjRow[]).map((p) => ({
      ...p,
      quietDays: p.last_activity_at ? Math.floor((now - new Date(p.last_activity_at).getTime()) / 86_400_000) : null,
      dueInDays: p.target_completion_date ? Math.ceil((new Date(p.target_completion_date).getTime() - now) / 86_400_000) : null,
    }));
    const mine = new Set(((memberOf.data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id));
    return { rows, activityDates, mine };
  });
  if (loading) return <Skeleton />;
  const rows = data?.rows ?? [];
  const isMine = (p: ProjRow) => p.owner_user_id === uid || !!data?.mine.has(p.id);
  const filters: Record<ProjScope, (p: (typeof rows)[number]) => boolean> = {
    active: () => true,
    mine: isMine,
    quiet: (p) => (p.quietDays ?? 99) > 14,
    due: (p) => p.dueInDays !== null && p.dueInDays <= 14,
  };
  const shown = rows.filter(filters[scope]).filter((p) => !dq || `${p.name ?? ""} ${p.moc_reference ?? ""} ${p.owner_user_name ?? ""}`.toLowerCase().includes(dq));
  const buckets = dayBuckets(data?.activityDates ?? [], 14);
  const wk = weekSplit(data?.activityDates ?? []);
  return (
    <div className={FILL}>
      <div className="flex items-center justify-between gap-2 shrink-0">
        <Tabs<ProjScope> value={scope} onChange={setScope} options={[
          { value: "active", label: "Active", count: rows.length },
          { value: "mine", label: "Mine", count: rows.filter(isMine).length },
          { value: "due", label: "Due soon", count: rows.filter(filters.due).length },
          { value: "quiet", label: "Going quiet", count: rows.filter(filters.quiet).length },
        ]} />
        <div className="flex items-center gap-2 shrink-0">
          <TrendChip current={wk.cur} previous={wk.prev} />
          {sum(buckets.counts) > 0 && <div className="w-20 hidden lg:block"><MiniBars values={buckets.counts} labels={buckets.labels} height={22} /></div>}
          <Link href="/projects" className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold text-white bg-[var(--color-accent)] hover:opacity-90">
            <Plus className="w-3 h-3" /> New
          </Link>
        </div>
      </div>
      {rows.length > 5 && <div className="mt-2 shrink-0"><SearchField value={q} onChange={setQ} placeholder="Filter projects - name, MOC, owner…" /></div>}
      {shown.length === 0 ? (
        <Empty>{rows.length === 0 ? "No active projects." : "No projects match."}</Empty>
      ) : (
        <div className={`mt-2 space-y-0.5 ${SCROLL}`}>
          {shown.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="group flex items-center gap-2 p-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
              <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${p.quietDays == null ? "bg-slate-300" : p.quietDays <= 7 ? "bg-emerald-500" : p.quietDays <= 14 ? "bg-amber-500" : "bg-slate-300"}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)]">{p.name ?? "Untitled project"}</span>
                <span className="block text-[10px] text-[var(--color-text-muted)] truncate">
                  {p.owner_user_id === uid ? "You" : p.owner_user_name ?? "-"}{p.moc_reference ? ` · MOC ${p.moc_reference}` : ""}
                  {p.last_activity_at ? ` · active ${timeAgo(p.last_activity_at)} ago` : ""}
                </span>
              </span>
              {p.dueInDays !== null && (
                <span className={`shrink-0 text-[10px] font-black px-1.5 py-0.5 rounded ${
                  p.dueInDays < 0 ? "bg-rose-600 text-white" : p.dueInDays <= 7 ? "bg-amber-100 text-amber-800" : "bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"}`}>
                  {p.dueInDays < 0 ? `${-p.dueInDays}d late` : p.dueInDays === 0 ? "due today" : `due ${p.dueInDays}d`}
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-60 sm:opacity-0 group-hover:opacity-100 shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────

interface AuditRow {
  id: string; action: string | null; timestamp: string | null; user_id: string | null; user_email: string | null;
  resource_type: string | null; resource_id: string | null; details: Record<string, unknown> | null;
}
type ActKind = "all" | "documents" | "requests" | "projects" | "knowledge" | "admin";
const KIND_OF = (r: AuditRow): Exclude<ActKind, "all"> => {
  const t = (r.resource_type ?? "").toLowerCase();
  const a = (r.action ?? "").toUpperCase();
  if (t.includes("knowledge") || a.startsWith("KNOWLEDGE")) return "knowledge";
  if (t.includes("ticket") || t.includes("request") || a.includes("TICKET")) return "requests";
  if (t.includes("project") || a.includes("PROJECT") || a.includes("MILESTONE")) return "projects";
  if (t.includes("document") || t.includes("collection") || t.includes("library") || t.includes("version") || a.includes("DOCUMENT") || a.includes("FOLDER")) return "documents";
  return "admin";
};
const KIND_ICON: Record<Exclude<ActKind, "all">, typeof FileText> = {
  documents: FileText, requests: MailPlus, projects: Briefcase, knowledge: BookOpen, admin: Shield,
};

/** "DOCUMENT_REV_UP" → "Document rev up". */
const humanize = (a: string | null) => {
  const s = (a ?? "activity").replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function ActivityFeed({ adminView }: { adminView: boolean }) {
  const { uid } = useRole();
  const { expanded } = useWidget();
  const [kind, setKind] = useState<ActKind>("all");
  const [onlyMine, setOnlyMine] = useSetting<boolean>("onlyMine", false);
  const { data, loading } = useWidgetData(async (orgId, me) => {
    let q = supabase.from("audit_logs")
      .select("id, action, timestamp, user_id, user_email, resource_type, resource_id, details").eq("org_id", orgId);
    if (onlyMine && me) q = q.eq("user_id", me);
    const [{ data: rows }, dates, total] = await Promise.all([
      q.order("timestamp", { ascending: false }).limit(expanded ? 300 : 80),
      fetchRecentDates("audit_logs", orgId, 14, "timestamp"),
      adminView ? headCount(() => supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("org_id", orgId) as unknown as Promise<{ count: number | null }>) : Promise.resolve(0),
    ]);
    const list = (rows ?? []) as AuditRow[];
    // Resolve what each entry is ABOUT, so rows read "EP 5-2-1 rev up" and open it.
    const docIds = [...new Set(list.filter((r) => KIND_OF(r) === "documents" && /document/i.test(r.resource_type ?? "")).map((r) => r.resource_id).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 100);
    const docs = new Map<string, { label: string; libraryId: string }>();
    if (docIds.length) {
      const { data: ds } = await supabase.from("documents").select("id, document_number, title, library_id").in("id", docIds);
      for (const d of (ds ?? []) as Array<{ id: string; document_number: string | null; title: string | null; library_id: string }>) {
        docs.set(d.id, { label: d.document_number || d.title || "Document", libraryId: d.library_id });
      }
    }
    return { rows: list, dates, docs, total };
  }, [onlyMine, expanded]);
  if (loading) return <Skeleton />;
  const rows = data?.rows ?? [];
  const shown = kind === "all" ? rows : rows.filter((r) => KIND_OF(r) === kind);
  const buckets = dayBuckets(data?.dates ?? [], 14);
  const count = (k: Exclude<ActKind, "all">) => rows.filter((r) => KIND_OF(r) === k).length;
  const linkFor = (r: AuditRow): { href: string | null; label: string | null } => {
    const id = r.resource_id ?? "";
    const t = (r.resource_type ?? "").toLowerCase();
    const d = data?.docs.get(id);
    if (d) return { href: `/documents/${d.libraryId}?doc=${id}`, label: d.label };
    const name = (r.details?.name ?? r.details?.title ?? r.details?.library ?? r.details?.document_number) as string | undefined;
    if (t.includes("ticket")) return { href: `/requests/${id}`, label: name ?? null };
    if (t.includes("project")) return { href: `/projects/${id}`, label: name ?? null };
    if (t === "knowledge_library") return { href: `/knowledge/${id}`, label: name ?? null };
    if (t === "library") return { href: `/documents/${id}`, label: name ?? null };
    return { href: null, label: name ?? null };
  };
  return (
    <div className={FILL}>
      <div className="shrink-0 flex items-center gap-2">
        <Tabs<ActKind> value={kind} onChange={setKind} className="min-w-0 flex-1" options={[
          { value: "all", label: "All" },
          { value: "documents", label: "Documents", count: count("documents") },
          { value: "requests", label: "Requests", count: count("requests") },
          { value: "projects", label: "Projects", count: count("projects") },
          { value: "knowledge", label: "Knowledge", count: count("knowledge") },
          { value: "admin", label: "Admin", count: count("admin") },
        ]} />
        <label className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-muted)] cursor-pointer select-none">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} className="accent-[var(--color-accent)]" />
          Only mine
        </label>
      </div>
      {sum(buckets.counts) > 0 && (
        <div className="shrink-0 mt-2 flex items-center gap-2">
          <div className="flex-1"><Sparkline values={buckets.counts} labels={buckets.labels} height={28} /></div>
          {adminView && <span className="shrink-0 text-[10px] font-bold text-[var(--color-text-muted)] tabular-nums">{(data?.total ?? 0).toLocaleString()} events on record</span>}
        </div>
      )}
      {shown.length === 0 ? (
        <Empty>No {kind === "all" ? "" : `${kind} `}activity{onlyMine ? " of yours" : ""} yet.</Empty>
      ) : (
        <ul className={`mt-1 space-y-0.5 ${SCROLL}`}>
          {shown.map((r) => {
            const k = KIND_OF(r);
            const Icon = KIND_ICON[k];
            const { href, label } = linkFor(r);
            const who = r.user_id === uid ? "You" : (r.user_email ?? "").split("@")[0] || "Someone";
            const inner = (
              <>
                <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-[var(--color-text)]">
                    <span className="font-semibold">{humanize(r.action)}</span>
                    {label ? <span className="text-[var(--color-text-muted)]"> · <span className="font-mono">{label}</span></span> : null}
                  </span>
                  <span className="block text-[10px] text-[var(--color-text-faint)] truncate">{who}</span>
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] tabular-nums" title={r.timestamp ? new Date(r.timestamp).toLocaleString() : undefined}>{timeAgo(r.timestamp)}</span>
              </>
            );
            return (
              <li key={r.id}>
                {href ? (
                  <Link href={href} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)]">{inner}</Link>
                ) : (
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ActivityBody() {
  return <ActivityFeed adminView={false} />;
}

export function AdminAuditBody() {
  return <ActivityFeed adminView />;
}

// ─── Equipment ───────────────────────────────────────────────────

interface AssetRow { id: string; tag: string; description: string | null; location: string | null; updated_at?: string | null }

export function EquipmentBody() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 200);
  const { data, loading } = useWidgetData(async (orgId) => {
    const count = await headCount(() => supabase.from("assets").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("archived", false) as unknown as Promise<{ count: number | null }>);
    let s = supabase.from("assets").select("id, tag, description, location").eq("org_id", orgId).eq("archived", false);
    if (dq) {
      const term = dq.replace(/[%_,()]/g, " ").trim();
      s = s.or(`tag.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%`).order("tag");
    } else {
      s = s.order("created_at", { ascending: false });
    }
    const { data: rows } = await s.limit(60);
    return { count, rows: (rows ?? []) as AssetRow[] };
  }, [dq]);
  if (loading) return <Skeleton />;
  const rows = data?.rows ?? [];
  return (
    <div className={FILL}>
      <div className="flex items-center gap-2 shrink-0">
        <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold bg-[var(--color-accent)] text-white">
          {(data?.count ?? 0).toLocaleString()}<span className="font-medium opacity-80">assets</span>
        </span>
        <div className="flex-1 min-w-0">
          <SearchField value={q} onChange={setQ} placeholder="Find a tag, description or location - e.g. P-101"
            onSubmit={(v) => { const hit = rows.find((r) => r.tag.toLowerCase() === v.toLowerCase()) ?? rows[0]; if (hit) window.location.href = `/assets/${encodeURIComponent(hit.tag)}`; }} />
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>{dq ? `No assets match “${dq}”.` : "No assets in the registry yet."}</Empty>
      ) : (
        <div className={`mt-2 space-y-0.5 ${SCROLL}`}>
          {!dq && <div className="px-2 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">Newest in the registry</div>}
          {rows.map((a) => (
            <Link key={a.id} href={`/assets/${encodeURIComponent(a.tag)}`}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)]">
              <Tag className="w-3.5 h-3.5 shrink-0 text-purple-500" />
              <span className="shrink-0 font-mono text-[12px] font-black text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{a.tag}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]">
                {a.description ?? ""}{a.location ? <span className="text-[var(--color-text-faint)]"> · {a.location}</span> : null}
              </span>
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Recently viewed ─────────────────────────────────────────────

export function RecentDocsBody() {
  const { expanded } = useWidget();
  const [count] = useSetting<number>("count", 12);
  const { data, loading } = useWidgetData(async (_orgId, me) => {
    if (!me) return [];
    const m = await import("@/lib/recentDocs");
    return m.listRecentDocs(me, expanded ? 50 : Math.max(5, Math.min(50, count)));
  }, [expanded, count]);
  if (loading) return <Skeleton />;
  const rows = data ?? [];
  if (rows.length === 0) return <Empty>Nothing viewed yet - open a document and it lands here.</Empty>;
  return (
    <div className={`mt-3 space-y-0.5 ${SCROLL}`}>
      {rows.map((r) => (
        <Link key={r.documentId} href={`/documents/${r.libraryId}?doc=${r.documentId}`}
          className="group flex items-center gap-2 p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
          <DocHoverPreview documentId={r.documentId}>
            <DocThumb documentId={r.documentId} width={28} />
          </DocHoverPreview>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)]">{r.documentNumber || r.title || "Document"}</span>
            {r.title && r.title !== r.documentNumber && <span className="block text-[10px] text-[var(--color-text-muted)] truncate">{r.title}</span>}
          </span>
          {r.rev && <span className="shrink-0 text-[10px] font-bold text-[var(--color-text-muted)]">Rev {r.rev}</span>}
          <span className="shrink-0 text-[10px] text-[var(--color-text-faint)] tabular-nums">{timeAgo(r.viewedAt)}</span>
        </Link>
      ))}
    </div>
  );
}

// ─── Admin: members ──────────────────────────────────────────────

interface MemberRow { uid: string; role: string | null; roles: string[] | null; status: string | null; email: string | null; display_name: string | null }

export function AdminUsersBody() {
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim().toLowerCase(), 150);
  const { data, loading } = useWidgetData(async (orgId) => {
    const { data: rows, error } = await supabase.from("org_members").select("*").eq("org_id", orgId).limit(2000);
    if (error) return { members: [] as MemberRow[] };
    return { members: (rows ?? []) as MemberRow[] };
  });
  if (loading) return <Skeleton />;
  const members = data?.members ?? [];
  const active = members.filter((m) => (m.status ?? "active") === "active");
  const pending = members.filter((m) => m.status === "invited");
  const byRole = new Map<string, number>();
  for (const m of active) byRole.set(m.role || "Member", (byRole.get(m.role || "Member") ?? 0) + 1);
  const entries = [...byRole.entries()].sort((a, b) => b[1] - a[1]);
  const segments: Segment[] = entries.slice(0, 5).map(([label, count]) => ({ label, count }));
  const other = entries.slice(5).reduce((s, [, c]) => s + c, 0);
  if (other > 0) segments.push({ label: "Other", count: other });
  const shown = active
    .filter((m) => roleFilter === "all" || (m.role || "Member") === roleFilter)
    .filter((m) => !dq || `${m.email ?? ""} ${m.display_name ?? ""} ${m.role ?? ""}`.toLowerCase().includes(dq));
  return (
    <div className={FILL}>
      <div className="flex items-end justify-between gap-2 shrink-0">
        <div className="flex items-end gap-2">
          <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{active.length}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">active members</span>
        </div>
        {pending.length > 0 && (
          <Link href="/admin/users" className="text-[11px] font-bold text-amber-700 dark:text-amber-400 hover:underline">{pending.length} pending →</Link>
        )}
      </div>
      {segments.length > 0 && <SegmentBar segments={segments} className="mt-2 shrink-0" />}
      <div className="mt-2 shrink-0 flex items-center gap-2">
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          className="shrink-0 text-[11px] font-bold bg-transparent border border-[var(--color-border)] rounded-lg px-1.5 py-1 text-[var(--color-text)]">
          <option value="all">All roles</option>
          {entries.map(([r]) => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex-1 min-w-0"><SearchField value={q} onChange={setQ} placeholder="Find a member…" /></div>
      </div>
      <ul className={`mt-2 space-y-0.5 ${SCROLL}`}>
        {shown.map((m) => (
          <li key={m.uid}>
            <Link href="/admin/users" className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)]">
              <User className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--color-text)]">{m.display_name || m.email || m.uid.slice(0, 8)}</span>
              <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">{m.role || "Member"}</span>
              {(m.roles ?? []).filter((r) => r !== m.role).slice(0, 2).map((r) => (
                <span key={r} className="shrink-0 text-[10px] font-bold px-1 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-faint)]">+{r}</span>
              ))}
            </Link>
          </li>
        ))}
        {shown.length === 0 && <Empty><Users className="w-4 h-4 mx-auto mb-1" />No members match.</Empty>}
      </ul>
    </div>
  );
}

