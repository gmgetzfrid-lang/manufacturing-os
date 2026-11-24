"use client";

// The work widgets, at full strength: each one filters, searches or drills in
// place instead of only counting things and sending you elsewhere.

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import { useRole } from "@/components/providers/RoleContext";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { TrendChip, MiniBars, Sparkline, SegmentBar, dayBuckets, type Segment } from "../viz";
import { StatusTag, LateEdge, WorkBar, rowBtn, link, thead, th, humanDate, humanTime } from "@/components/cockpit/ui";
import { useProjectProgress } from "@/components/cockpit/projectProgress";
import {
  useWidget, useSetting, useWidgetData, Tabs, SearchField, useDebounced, Skeleton, Empty, timeAgo,
  headCount, fetchRecentDates, weekSplit, sum, FILL,
} from "../kit";

// ─── Drafting requests ───────────────────────────────────────────

// A request's status as a quiet tag: amber where it waits on a review or an
// approval, plain otherwise.
const TICKET_STATUS: Record<string, { label: string; tone: "held" | "neutral" | "released" | "muted" }> = {
  NEW: { label: "New", tone: "neutral" },
  PENDING_ENG_INITIAL: { label: "Eng review", tone: "held" },
  PENDING_ENG_TEAM: { label: "Eng team", tone: "held" },
  PENDING_ASSIGNMENT: { label: "Unassigned", tone: "held" },
  DRAFTING: { label: "Drafting", tone: "neutral" },
  PENDING_REVIEW: { label: "In review", tone: "held" },
  REVISION_REQ: { label: "Revisions", tone: "held" },
  PENDING_IFC: { label: "Pending IFC", tone: "released" },
  FINAL_DRAFT: { label: "Final draft", tone: "released" },
  PENDING_FINAL_APPROVAL: { label: "Final approval", tone: "held" },
  CLOSED: { label: "Closed", tone: "released" },
  CANCELED: { label: "Canceled", tone: "muted" },
};
const ticketStatus = (s: string | null | undefined) =>
  (s && TICKET_STATUS[s]) || { label: s ?? "–", tone: "neutral" as const };

/** "3d" → "3 days ago"; for the cells that say how long ago. */
const agoWords = (iso: string | null | undefined) => {
  const t = timeAgo(iso);
  if (!t) return "–";
  if (t === "now") return "Just now";
  const n = parseInt(t, 10);
  const unit = t.endsWith("m") ? "min" : t.endsWith("h") ? "h" : "d";
  if (unit === "d" && n >= 14 && iso) return humanDate(iso);
  return unit === "min" ? `${n} min ago` : unit === "h" ? `${n} h ago` : `${n} day${n === 1 ? "" : "s"} ago`;
};

const agoLower = (iso: string | null | undefined) => { const a = agoWords(iso); return a === "Just now" ? "just now" : a; };

/** A widget's table: ruled rows, edge to edge in the sheet. */
const wTable = "w-full text-body";
const wRow = "hover:bg-[var(--color-surface-2)] cursor-pointer transition-colors";
const td = "px-4 py-2.5";

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
  const router = useRouter();
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
  const stagesOn = stageCounts.filter((s) => s.count > 0);

  return (
    <div className={FILL}>
      <div className="flex items-end justify-between gap-x-4 gap-y-2 flex-wrap shrink-0">
        <Tabs<ReqScope> value={scope} onChange={(v) => { setScope(v); setStage(null); }} className="min-w-0"
          options={[
            { value: "all", label: "All open", count: counts.all },
            { value: "assigned", label: "Assigned to me", count: counts.assigned },
            { value: "mine", label: "I asked", count: counts.mine },
            { value: "unassigned", label: "Unassigned", count: counts.unassigned },
          ]} />
        <div className="flex items-center gap-3 pb-1">
          <TrendChip current={wk.cur} previous={wk.prev} what="new" />
          <Link href="/requests/new" className={rowBtn}><Plus className="w-3.5 h-3.5" /> New request</Link>
        </div>
      </div>
      {(stagesOn.length > 1 || inScope.length > 4) && (
        <div className="mt-3 shrink-0 flex items-center gap-2 flex-wrap">
          {/* The pipeline: tap a stage to see just those, tap again for all. */}
          {stagesOn.length > 1 && (
            <div role="group" aria-label="Stage" className="flex flex-wrap items-center gap-1.5">
              {stagesOn.map((s) => {
                const on = stage === s.key;
                return (
                  <button key={s.key} type="button" aria-pressed={on} onClick={() => setStage(on ? null : s.key)}
                    className={`ui-tag ${on ? "!bg-[var(--color-surface)] !border-[var(--color-current)] !text-[var(--color-text)]" : ""}`}>
                    {s.label} <span className="font-sans font-normal tabular-nums text-[var(--color-text-muted)]">{s.count}</span>
                  </button>
                );
              })}
            </div>
          )}
          {inScope.length > 4 && <div className="flex-1 min-w-[12rem]"><SearchField value={q} onChange={setQ} placeholder="Filter by number, title, person" /></div>}
        </div>
      )}

      {shown.length === 0 ? (
        <Empty>
          {inScope.length === 0
            ? scope === "assigned" ? "Nothing assigned to you right now." : scope === "mine" ? "You have no open requests." : "No open requests."
            : "Nothing matches that filter."}{" "}
          <Link href="/requests/new" className={link}>Raise one</Link>
        </Empty>
      ) : (
        <div className="@container -mx-4 -mb-4 mt-3 flex-1 min-h-0 overflow-y-auto border-t border-[var(--color-border)]">
          <table className={`hidden @[40rem]:table ${wTable}`}>
            <thead className={`${thead} sticky top-0 z-[1]`}>
              <tr>
                <th className={th}>Request</th>
                <th className={th}>Title</th>
                <th className={th}>Requester</th>
                <th className={th}>Drafter</th>
                <th className={th}>Status</th>
                <th className={th}>Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {shown.slice(0, expanded ? 200 : 40).map((t) => {
                const st = ticketStatus(t.status);
                return (
                  <tr key={t.id} className={wRow} onClick={() => router.push(`/requests/${t.id}`)}>
                    <td className={`${td} relative whitespace-nowrap`}>
                      {t.priority === 1 && <LateEdge />}
                      <Link href={`/requests/${t.id}`} onClick={(e) => e.stopPropagation()} className="ui-id">{t.ticket_id ?? "–"}</Link>
                    </td>
                    <td className={`${td} max-w-0 w-full`}>
                      <span className="block truncate text-[var(--color-text)]">{t.title ?? "Untitled request"}</span>
                    </td>
                    <td className={`${td} whitespace-nowrap text-[var(--color-text-muted)]`}>{t.requester_id === uid ? "You" : t.requester_name || "Unknown"}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {t.assigned_drafter_name || t.assigned_drafter_id
                        ? <span className="text-[var(--color-text)]">{t.assigned_drafter_id === uid ? "You" : t.assigned_drafter_name}</span>
                        : <StatusTag tone="held">Unassigned</StatusTag>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {t.priority === 1 ? <StatusTag tone="overdue">Urgent, {st.label.toLowerCase()}</StatusTag> : <StatusTag tone={st.tone}>{st.label}</StatusTag>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-[var(--color-text-muted)] tabular-nums`} title={t.updated_at && t.updated_at !== t.created_at ? `Last change ${agoLower(t.updated_at)}` : undefined}>{agoWords(t.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="@[40rem]:hidden divide-y divide-[var(--color-border)]">
            {shown.slice(0, expanded ? 200 : 40).map((t) => {
              const st = ticketStatus(t.status);
              return (
                <li key={t.id} className="relative">
                  {t.priority === 1 && <LateEdge />}
                  <Link href={`/requests/${t.id}`} className="block px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-reading">
                        <span className="ui-id mr-2">{t.ticket_id ?? "–"}</span>{t.title ?? "Untitled request"}
                      </span>
                      <StatusTag tone={t.priority === 1 ? "overdue" : st.tone}>{st.label}</StatusTag>
                    </span>
                    <span className="mt-0.5 block text-body text-[var(--color-text-muted)] truncate">
                      {t.requester_id === uid ? "You" : t.requester_name || "Unknown"} to {t.assigned_drafter_id === uid ? "you" : t.assigned_drafter_name || "nobody yet"}, opened {agoLower(t.created_at)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Projects ────────────────────────────────────────────────────

interface ProjRow {
  id: string; name: string | null; status: string | null; last_activity_at: string | null;
  owner_user_id: string | null; owner_user_name: string | null; target_completion_date: string | null; moc_reference: string | null;
  timezone?: string | null; phases?: unknown; st_phases?: unknown;
}
type ProjScope = "active" | "mine" | "quiet" | "due";

export function ProjectsBody() {
  const { uid } = useRole();
  // Yours first: the whole workspace is a tab away.
  const [scope, setScope] = useSetting<ProjScope>("scope", "mine");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim().toLowerCase(), 150);
  const { data, loading } = useWidgetData(async (orgId, me) => {
    const [res, activityDates, memberOf] = await Promise.all([
      supabase.from("projects")
        // The phases as saved in the project's settings, without the rest of them (a letterhead is large).
        .select("id, name, status, last_activity_at, owner_user_id, owner_user_name, target_completion_date, moc_reference, timezone, phases, st_phases:shift_times->phases")
        .eq("org_id", orgId).eq("status", "active")
        .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(300),
      fetchRecentDates("project_activity", orgId, 14),
      me ? supabase.from("project_members").select("project_id").eq("user_id", me).limit(1000) : Promise.resolve({ data: [] }),
    ]);
    const now = Date.now();
    const rows = ((res.data ?? []) as ProjRow[]).map((p) => ({
      ...p,
      quietDays: p.last_activity_at ? Math.floor((now - new Date(p.last_activity_at).getTime()) / 86_400_000) : null,
      // Its dates: the phase running today on a project in phases, else the
      // typed target. A target date is never held against a project in phases.
      due: projectDue(phasesOfRow({ phases: p.phases, shift_times: p.st_phases != null ? { phases: p.st_phases } : null }), p.target_completion_date, dayKey(now, p.timezone || "America/Los_Angeles")),
    }));
    const mine = new Set(((memberOf.data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id));
    return { rows, activityDates, mine };
  });
  return <ProjectsTable data={data} loading={loading} scope={scope} setScope={setScope} q={q} setQ={setQ} dq={dq} uid={uid} />;
}

type ProjData = { rows: Array<ProjRow & { quietDays: number | null; due: ReturnType<typeof projectDue> }>; activityDates: string[]; mine: Set<string> };

function ProjectsTable({ data, loading, scope, setScope, q, setQ, dq, uid }: {
  data: ProjData | null; loading: boolean; scope: ProjScope; setScope: (v: ProjScope) => void;
  q: string; setQ: (v: string) => void; dq: string; uid: string | null | undefined;
}) {
  const { activeOrgId } = useRole();
  const router = useRouter();
  const progress = useProjectProgress(activeOrgId, (data?.rows ?? []).map((p) => ({ id: p.id, timezone: p.timezone })), 12);
  if (loading) return <Skeleton />;
  const rows = data?.rows ?? [];
  const isMine = (p: ProjRow) => p.owner_user_id === uid || !!data?.mine.has(p.id);
  const filters: Record<ProjScope, (p: (typeof rows)[number]) => boolean> = {
    active: () => true,
    mine: isMine,
    quiet: (p) => (p.quietDays ?? 99) > 14,
    due: (p) => !!p.due && (p.due.kind === "ends" || p.due.kind === "target" || p.due.kind === "past target") && (p.due.kind === "past target" || p.due.days <= 14),
  };
  const shown = rows.filter(filters[scope]).filter((p) => !dq || `${p.name ?? ""} ${p.moc_reference ?? ""} ${p.owner_user_name ?? ""}`.toLowerCase().includes(dq));
  const buckets = dayBuckets(data?.activityDates ?? [], 14);
  const wk = weekSplit(data?.activityDates ?? []);
  const dueTag = (p: (typeof rows)[number]) => {
    if (!p.due) return <span className="text-[var(--color-text-muted)]">–</span>;
    const words = projectDueWords(p.due);
    if (p.due.kind === "past target") return <StatusTag tone="overdue">{words}</StatusTag>;
    if ((p.due.kind === "ends" || p.due.kind === "target") && p.due.days <= 7) return <StatusTag tone="held">{words}</StatusTag>;
    return <span className="text-[var(--color-text)]">{words}</span>;
  };
  // Only a project going quiet gets a mark; activity itself isn't news.
  const quiet = (p: (typeof rows)[number]) => p.quietDays != null && p.quietDays > 7;
  const projState = (p: (typeof rows)[number]) => {
    const pr = progress.get(p.id);
    if (p.due?.kind === "past target" && !(pr && pr.pct >= 100)) return <StatusTag tone="overdue">Late</StatusTag>;
    if (pr && pr.pct >= 100) return <StatusTag tone="released">Work done</StatusTag>;
    if (pr && pr.overdue > 0) return <StatusTag tone="held">{pr.overdue} late step{pr.overdue === 1 ? "" : "s"}</StatusTag>;
    return <StatusTag tone="neutral">Active</StatusTag>;
  };
  const workCell = (p: (typeof rows)[number]) => {
    const pr = progress.get(p.id);
    if (pr) return <WorkBar pct={pr.pct} late={p.due?.kind === "past target" && pr.pct < 100} width="w-20" title={`${pr.done} of ${pr.steps} steps done`} />;
    if (pr === null) return <span className="text-body text-[var(--color-text-muted)]">No schedule</span>;
    return <span className="text-[var(--color-text-faint)]">–</span>;
  };
  return (
    <div className={FILL}>
      <div className="flex items-end justify-between gap-x-4 gap-y-2 flex-wrap shrink-0">
        <Tabs<ProjScope> value={scope} onChange={setScope} className="min-w-0" options={[
          { value: "mine", label: "Mine", count: rows.filter(isMine).length },
          { value: "active", label: "All active", count: rows.length },
          { value: "due", label: "Due soon", count: rows.filter(filters.due).length },
          { value: "quiet", label: "Going quiet", count: rows.filter(filters.quiet).length },
        ]} />
        <div className="flex items-center gap-3 pb-1">
          <TrendChip current={wk.cur} previous={wk.prev} what="updates" />
          {sum(buckets.counts) > 0 && <div className="w-24 hidden lg:block"><MiniBars values={buckets.counts} labels={buckets.labels} height={22} /></div>}
          <Link href="/projects" className={rowBtn}><Plus className="w-3.5 h-3.5" /> New</Link>
        </div>
      </div>
      {rows.length > 5 && <div className="mt-3 shrink-0"><SearchField value={q} onChange={setQ} placeholder="Filter projects by name, MOC, owner" /></div>}
      {shown.length === 0 ? (
        <Empty>{rows.length === 0 ? "No active projects." : scope === "mine" && !q ? "You're not on any active project. All active shows the workspace." : "No projects match."}</Empty>
      ) : (
        <div className="@container -mx-4 -mb-4 mt-3 flex-1 min-h-0 overflow-y-auto border-t border-[var(--color-border)]">
          <table className={`hidden @[40rem]:table ${wTable}`}>
            <thead className={`${thead} sticky top-0 z-[1]`}>
              <tr>
                <th className={th}>Project</th>
                <th className={th}>Status</th>
                <th className={th}>Work done</th>
                <th className={`${th} hidden @[56rem]:table-cell`}>Owner</th>
                <th className={`${th} hidden @[48rem]:table-cell`}>MOC</th>
                <th className={th}>Dates</th>
                <th className={`${th} hidden @[52rem]:table-cell`}>Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {shown.map((p) => (
                <tr key={p.id} className={wRow} onClick={() => router.push(`/projects/${p.id}`)}>
                  <td className={`${td} relative max-w-0 w-full`}>
                    {p.due?.kind === "past target" && <LateEdge />}
                    <Link href={`/projects/${p.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{p.name ?? "Untitled project"}</Link>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{projState(p)}</td>
                  <td className={`${td} whitespace-nowrap`}>{workCell(p)}</td>
                  <td className={`${td} hidden @[56rem]:table-cell whitespace-nowrap text-[var(--color-text-muted)]`}>{p.owner_user_id === uid ? "You" : p.owner_user_name ?? "–"}</td>
                  <td className={`${td} hidden @[48rem]:table-cell whitespace-nowrap`}>{p.moc_reference ? <span className="ui-id">{p.moc_reference}</span> : <span className="text-[var(--color-text-faint)]">–</span>}</td>
                  <td className={`${td} whitespace-nowrap`} data-project-due>{dueTag(p)}</td>
                  <td className={`${td} hidden @[52rem]:table-cell whitespace-nowrap`}>
                    {quiet(p) && p.quietDays! <= 14
                      ? <StatusTag tone="held">{agoWords(p.last_activity_at)}</StatusTag>
                      : <span className="text-[var(--color-text-muted)]">{agoWords(p.last_activity_at)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="@[40rem]:hidden divide-y divide-[var(--color-border)]">
            {shown.map((p) => (
              <li key={p.id} className="relative">
                {p.due?.kind === "past target" && <LateEdge />}
                <Link href={`/projects/${p.id}`} className="block px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                  <span className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium text-reading text-[var(--color-text)]">{p.name ?? "Untitled project"}</span>
                    {projState(p)}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body">
                    {progress.get(p.id) && workCell(p)}
                    <span data-project-due>{dueTag(p)}</span>
                  </span>
                  <span className="mt-0.5 block text-body text-[var(--color-text-muted)] truncate">
                    {[p.owner_user_id === uid ? "You" : p.owner_user_name, p.moc_reference ? `MOC ${p.moc_reference}` : null, p.last_activity_at ? `last activity ${agoLower(p.last_activity_at)}` : null].filter(Boolean).join(", ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
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

const KIND_WORD: Record<Exclude<ActKind, "all">, string> = {
  documents: "Document", requests: "Request", projects: "Project", knowledge: "Knowledge", admin: "Admin",
};

/** "DOCUMENT_REV_UP" → "Document rev up". */
const humanize = (a: string | null) => {
  const s = (a ?? "activity").replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function ActivityFeed({ adminView }: { adminView: boolean }) {
  const { uid } = useRole();
  const router = useRouter();
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
  const when = (iso: string | null) => {
    if (!iso) return "–";
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? humanTime(iso) : `${humanDate(iso)}, ${humanTime(iso)}`;
  };
  return (
    <div className={FILL}>
      <div className="shrink-0 flex items-end gap-x-4 gap-y-2 flex-wrap">
        <Tabs<ActKind> value={kind} onChange={setKind} className="min-w-0" options={[
          { value: "all", label: "All" },
          { value: "documents", label: "Documents", count: count("documents") },
          { value: "requests", label: "Requests", count: count("requests") },
          { value: "projects", label: "Projects", count: count("projects") },
          { value: "knowledge", label: "Knowledge", count: count("knowledge") },
          { value: "admin", label: "Admin", count: count("admin") },
        ]} />
        <label className="ml-auto pb-2 shrink-0 inline-flex items-center gap-2 text-body text-[var(--color-text)] cursor-pointer select-none">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} className="w-4 h-4 accent-[var(--color-main)]" />
          Only mine
        </label>
      </div>
      {sum(buckets.counts) > 0 && (
        <div className="shrink-0 mt-3 flex items-center gap-3">
          <span className="shrink-0 text-body text-[var(--color-text-muted)]">Last 14 days</span>
          <div className="flex-1"><Sparkline values={buckets.counts} labels={buckets.labels} height={28} /></div>
          {adminView && <span className="shrink-0 text-body text-[var(--color-text-muted)]"><span className="font-display font-semibold text-[var(--color-text)] tabular-nums">{(data?.total ?? 0).toLocaleString()}</span> events on record</span>}
        </div>
      )}
      {shown.length === 0 ? (
        <Empty>No {kind === "all" ? "" : `${kind} `}activity{onlyMine ? " of yours" : ""} yet.</Empty>
      ) : (
        <div className="@container -mx-4 -mb-4 mt-3 flex-1 min-h-0 overflow-y-auto border-t border-[var(--color-border)]">
          <table className={`hidden @[40rem]:table ${wTable}`}>
            <thead className={`${thead} sticky top-0 z-[1]`}>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Who</th>
                <th className={th}>What</th>
                <th className={th}>Item</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {shown.map((r) => {
                const { href, label } = linkFor(r);
                const who = r.user_id === uid ? "You" : (r.user_email ?? "").split("@")[0] || "Someone";
                return (
                  <tr key={r.id} className={href ? wRow : ""} onClick={href ? () => router.push(href) : undefined}>
                    <td className={`${td} whitespace-nowrap text-[var(--color-text-muted)] tabular-nums`} title={r.timestamp ? new Date(r.timestamp).toLocaleString("en-US") : undefined}>{when(r.timestamp)}</td>
                    <td className={`${td} whitespace-nowrap text-[var(--color-text)]`}>{who}</td>
                    <td className={`${td} whitespace-nowrap text-[var(--color-text)]`}>
                      <span className="inline-flex items-center gap-2"><span className="ui-tag is-more !h-6 !text-caption">{KIND_WORD[KIND_OF(r)]}</span>{humanize(r.action)}</span>
                    </td>
                    <td className={`${td} max-w-0 w-full`}>
                      {href
                        ? <Link href={href} onClick={(e) => e.stopPropagation()} className="ui-id block truncate">{label ?? "Open"}</Link>
                        : <span className="block truncate text-[var(--color-text-muted)]">{label ?? "–"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ul className="@[40rem]:hidden divide-y divide-[var(--color-border)]">
            {shown.map((r) => {
              const { href, label } = linkFor(r);
              const who = r.user_id === uid ? "You" : (r.user_email ?? "").split("@")[0] || "Someone";
              const inner = (
                <>
                  <span className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-reading text-[var(--color-text)]">
                      {humanize(r.action)}{label ? <span className="ui-id"> {label}</span> : null}
                    </span>
                    <span className="shrink-0 text-body text-[var(--color-text-muted)] tabular-nums">{when(r.timestamp)}</span>
                  </span>
                  <span className="mt-0.5 block text-body text-[var(--color-text-muted)]">{who}</span>
                </>
              );
              return (
                <li key={r.id}>
                  {href
                    ? <Link href={href} className="block px-4 py-2.5 hover:bg-[var(--color-surface-2)]">{inner}</Link>
                    : <div className="px-4 py-2.5">{inner}</div>}
                </li>
              );
            })}
          </ul>
        </div>
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
  const router = useRouter();
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
      <div className="flex items-center gap-3 shrink-0">
        <span className="shrink-0 text-body text-[var(--color-text-muted)]">
          <span className="ui-count is-solid">{(data?.count ?? 0).toLocaleString()}</span> in the registry
        </span>
        <div className="flex-1 min-w-0">
          <SearchField value={q} onChange={setQ} placeholder="Find a tag, description or location, like P-101"
            onSubmit={(v) => { const hit = rows.find((r) => r.tag.toLowerCase() === v.toLowerCase()) ?? rows[0]; if (hit) window.location.href = `/assets/${encodeURIComponent(hit.tag)}`; }} />
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>{dq ? `No equipment matches “${dq}”.` : "No equipment in the registry yet."}</Empty>
      ) : (
        <div className="-mx-4 -mb-4 mt-3 flex-1 min-h-0 overflow-y-auto border-t border-[var(--color-border)]">
          <table className={wTable} aria-label={dq ? "Matching equipment" : "Newest in the registry"}>
            <thead className={`${thead} sticky top-0 z-[1]`}>
              <tr>
                <th className={th}>Tag</th>
                <th className={th}>Description</th>
                <th className={`${th} hidden sm:table-cell`}>Location</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {rows.map((a) => (
                <tr key={a.id} className={wRow} onClick={() => router.push(`/assets/${encodeURIComponent(a.tag)}`)}>
                  <td className={`${td} whitespace-nowrap`}>
                    <Link href={`/assets/${encodeURIComponent(a.tag)}`} onClick={(e) => e.stopPropagation()} className="ui-tag">{a.tag}</Link>
                  </td>
                  <td className={`${td} max-w-0 w-full`}><span className="block truncate text-[var(--color-text-muted)]">{a.description ?? "–"}</span></td>
                  <td className={`${td} hidden sm:table-cell whitespace-nowrap text-[var(--color-text-muted)]`}>{a.location ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  if (rows.length === 0) return <Empty>Nothing viewed yet. Open a document and it shows here.</Empty>;
  return (
    <ul className="-m-4 flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--color-border)]">
      {rows.map((r) => (
        <li key={r.documentId}>
          <Link href={`/documents/${r.libraryId}?doc=${r.documentId}`}
            className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
            <DocHoverPreview documentId={r.documentId}>
              <DocThumb documentId={r.documentId} width={28} />
            </DocHoverPreview>
            <span className="min-w-0 flex-1">
              <span className="ui-id block text-reading truncate">{r.documentNumber || r.title || "Document"}</span>
              {r.title && r.title !== r.documentNumber && <span className="block text-body text-[var(--color-text-muted)] truncate">{r.title}</span>}
            </span>
            {r.rev && <span className="shrink-0 ui-tag">Rev {r.rev}</span>}
            <span className="shrink-0 w-24 text-right text-body text-[var(--color-text-muted)] tabular-nums">{agoWords(r.viewedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
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
      <div className="flex items-baseline justify-between gap-3 shrink-0">
        <span className="text-body text-[var(--color-text-muted)]">
          <span className="ui-count is-solid">{active.length}</span> active members
        </span>
        {pending.length > 0 && (
          <Link href="/admin/users" className={`text-body ${link}`}><span className="ui-count is-warn">{pending.length}</span> invite{pending.length === 1 ? "" : "s"} pending</Link>
        )}
      </div>
      {segments.length > 0 && <SegmentBar segments={segments} className="mt-2 shrink-0" />}
      <div className="mt-3 shrink-0 flex items-center gap-2">
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Role"
          className="shrink-0 h-9 pointer-coarse:h-11 px-2.5 rounded-md border border-[var(--color-border-control)] bg-[var(--color-surface)] text-body pointer-coarse:text-reading text-[var(--color-text)]">
          <option value="all">All roles</option>
          {entries.map(([r]) => <option key={r} value={r}>{r}</option>)}
        </select>
        <div className="flex-1 min-w-0"><SearchField value={q} onChange={setQ} placeholder="Find a member" /></div>
      </div>
      {shown.length === 0 ? <Empty>No members match.</Empty> : (
        <ul className="-mx-4 -mb-4 mt-3 flex-1 min-h-0 overflow-y-auto border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {shown.map((m) => (
            <li key={m.uid} className="flex items-center gap-3 pr-4 hover:bg-[var(--color-surface-2)]">
              <Link href="/admin/users" className="min-w-0 flex-1 truncate px-4 py-2.5 text-reading text-[var(--color-text)]">{m.display_name || m.email || m.uid.slice(0, 8)}</Link>
              <span className="shrink-0 flex items-center gap-1.5">
                <button type="button" onClick={() => setRoleFilter(m.role || "Member")} aria-pressed={roleFilter === (m.role || "Member")} title={`Show only ${m.role || "Member"}`} className="ui-tag">{m.role || "Member"}</button>
                {(m.roles ?? []).filter((r) => r !== m.role).slice(0, 2).map((r) => (
                  <span key={r} className="ui-tag is-more">{r}</span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
