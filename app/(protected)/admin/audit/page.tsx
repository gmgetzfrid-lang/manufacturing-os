"use client";

// /admin/audit — org-wide audit log viewer.
//
// Reads the audit_logs table and renders it as a chronological feed
// with filters (action, resource type, user, date range, library).
// Admin-class only; non-admins see a permission notice.
//
// Designed to answer "who did what, when?" — including deletes — in
// one place rather than spreading evidence across the per-document
// timeline.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ScrollText, Loader2, AlertTriangle, Filter, RefreshCw,
  ChevronDown, Eye, Download, Upload, Pencil, Trash2, FileSignature,
  GitBranch, Lock, Unlock, ArrowUpRight, ShieldOff, AlertOctagon,
  Sparkles, FileText, Briefcase, Layers, KeyRound,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import IsoGuidance from "@/components/ui/IsoGuidance";

const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl"]);

interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  orgId: string | null;
  userId: string;
  userEmail: string | null;
  userRole: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

interface LibraryLite { id: string; name: string }

// Maps an action string to a (icon, tone) for the chip on each row.
const ACTION_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  VIEW:                  { icon: Eye,           tone: "bg-slate-50 text-slate-600 border-slate-200" },
  DOWNLOAD:              { icon: Download,      tone: "bg-sky-50 text-sky-700 border-sky-200" },
  UPLOAD:                { icon: Upload,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CHECK_OUT:             { icon: Lock,          tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  CHECK_IN:              { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  ABANDON:               { icon: Unlock,        tone: "bg-amber-50 text-amber-700 border-amber-200" },
  FORCE_RELEASE:         { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  JOIN:                  { icon: ArrowUpRight,  tone: "bg-slate-50 text-slate-600 border-slate-200" },
  REV_UP:                { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  REV_BACKFILL:          { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  SUPERSEDE_DOC:         { icon: ArrowUpRight,  tone: "bg-violet-50 text-violet-700 border-violet-200" },
  REVERT:                { icon: ArrowUpRight,  tone: "bg-amber-50 text-amber-700 border-amber-200" },
  ARCHIVE_DOC:           { icon: ShieldOff,     tone: "bg-slate-100 text-slate-700 border-slate-300" },
  DOC_SPLIT:             { icon: GitBranch,     tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  CREATED_FROM_SPLIT:    { icon: Sparkles,      tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  DOC_MERGED:            { icon: GitBranch,     tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  CREATED_FROM_MERGE:    { icon: Sparkles,      tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  DOC_RENUMBERED:        { icon: Pencil,        tone: "bg-amber-50 text-amber-700 border-amber-200" },
  SET_REV_UP:            { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  DOC_SPLIT_REVERSED:    { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  DOC_MERGE_REVERSED:    { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  DOC_RENUMBER_REVERSED: { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  HOLD_OPENED:           { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  HOLD_RELEASED:         { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_CREATED:     { icon: Sparkles,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_UPDATED:     { icon: Pencil,        tone: "bg-blue-50 text-blue-700 border-blue-200" },
  MILESTONE_COMPLETED:   { icon: Sparkles,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_MISSED:      { icon: AlertOctagon,  tone: "bg-amber-50 text-amber-700 border-amber-200" },
  MILESTONE_BLOCKED:     { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  MILESTONE_DELETED:     { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200" },
  EQUIPMENT_STATE_CHANGED: { icon: Layers,      tone: "bg-amber-50 text-amber-700 border-amber-200" },
  NOTE_CREATED:          { icon: Pencil,        tone: "bg-slate-50 text-slate-600 border-slate-200" },
  NOTE_DELETED:          { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200" },
  PROJECT_CREATED:       { icon: Briefcase,     tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  MARKUP_REQUESTED:      { icon: FileSignature, tone: "bg-violet-50 text-violet-700 border-violet-200" },
  DATA_EXPORT:           { icon: Download,      tone: "bg-sky-50 text-sky-700 border-sky-200" },
};

const RESOURCE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  project: Briefcase,
  milestone: Sparkles,
  asset: KeyRound,
};

export default function AuditLogPage() {
  const { activeOrgId, activeRole, userEmail } = useRole();
  const canRead = !!activeRole && ADMIN_ROLES.has(activeRole);

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<LibraryLite[]>([]);
  const [docMeta, setDocMeta] = useState<Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>>(new Map());

  // Filters
  const [actionFilter, setActionFilter] = useState<string>("ALL");
  const [resourceFilter, setResourceFilter] = useState<string>("ALL");
  const [libraryFilter, setLibraryFilter] = useState<string>("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    if (!activeOrgId) return;
    (async () => {
      const { data } = await supabase
        .from("libraries")
        .select("id,name")
        .eq("org_id", activeOrgId)
        .order("name");
      setLibraries((data || []) as LibraryLite[]);
    })();
  }, [activeOrgId]);

  const fetchRows = async () => {
    if (!activeOrgId) return;
    setLoading(true);
    setError(null);
    try {
      let q = supabase.from("audit_logs")
        .select("*")
        .eq("org_id", activeOrgId)
        .order("timestamp", { ascending: false })
        .limit(limit);
      if (range !== "all") {
        const ms = range === "24h" ? 86_400_000 : range === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
        q = q.gte("timestamp", new Date(Date.now() - ms).toISOString());
      }
      if (actionFilter !== "ALL") q = q.eq("action", actionFilter);
      if (resourceFilter !== "ALL") q = q.eq("resource_type", resourceFilter);
      const { data, error: qErr } = await q;
      if (qErr) throw qErr;
      const list: AuditRow[] = (data || []).map((r) => ({
        id: r.id, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id,
        orgId: r.org_id, userId: r.user_id, userEmail: r.user_email, userRole: r.user_role,
        details: r.details, metadata: r.metadata, timestamp: r.timestamp,
      }));
      setRows(list);

      // Hydrate documents referenced by these rows so we can show
      // doc-number + title + library link, not raw UUIDs.
      const docIds = Array.from(new Set(list.filter((r) => r.resourceType === "document").map((r) => r.resourceId)));
      if (docIds.length > 0) {
        const { data: docs } = await supabase
          .from("documents").select("id, document_number, title, name, library_id")
          .in("id", docIds);
        const map = new Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>();
        for (const d of (docs as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string }>) ?? []) {
          map.set(d.id, { documentNumber: d.document_number, title: d.title || d.name, libraryId: d.library_id });
        }
        setDocMeta(map);
      } else {
        setDocMeta(new Map());
      }
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchRows(); }, [activeOrgId, actionFilter, resourceFilter, range, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter((r) => (r.userEmail ?? "").toLowerCase().includes(q));
    if (libraryFilter !== "ALL") {
      list = list.filter((r) => {
        if (r.resourceType !== "document") return false;
        const meta = docMeta.get(r.resourceId);
        return meta?.libraryId === libraryFilter;
      });
    }
    return list;
  }, [rows, userQuery, libraryFilter, docMeta]);

  const kpis = useMemo(() => {
    const byAction = new Map<string, number>();
    const byUser = new Map<string, number>();
    for (const r of filtered) {
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
      const u = r.userEmail || r.userId;
      byUser.set(u, (byUser.get(u) ?? 0) + 1);
    }
    const topAction = [...byAction.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const topUser = [...byUser.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    const deletes = [...byAction.entries()].filter(([k]) => /DELET|ARCHIVE|REVERS|FORCE/.test(k)).reduce((s, [, n]) => s + n, 0);
    return { total: filtered.length, topAction, topUser, deletes };
  }, [filtered]);

  if (!canRead) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center gap-3">
          <div className="p-3 bg-slate-900 rounded-xl"><ScrollText className="w-6 h-6 text-white" /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Audit Log</h1>
            <p className="text-sm text-slate-600 mt-1">Admin-class roles only. Ask your workspace admin if you need access.</p>
            <div className="text-xs text-slate-400 mt-2">Signed in as {userEmail || "—"} ({activeRole || "—"})</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 pb-20">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-slate-900 rounded-xl shadow-lg shadow-slate-900/10">
              <ScrollText className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-900 tracking-tight inline-flex items-center gap-2">
                Audit Log
                <IsoGuidance topic="audit_log" size="md" />
              </h1>
              <p className="text-xs text-slate-500">Every meaningful action across the workspace, with who and when.</p>
            </div>
          </div>
          <button
            onClick={fetchRows}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Kpi label="Events" value={kpis.total.toString()} tone="slate" />
          <Kpi label="Deletes / undo / force" value={kpis.deletes.toString()} tone={kpis.deletes > 0 ? "rose" : "slate"} />
          <Kpi
            label="Top action"
            value={kpis.topAction ? prettyAction(kpis.topAction[0]) : "—"}
            sub={kpis.topAction ? `${kpis.topAction[1]} occurrence${kpis.topAction[1] === 1 ? "" : "s"}` : undefined}
            tone="indigo"
          />
          <Kpi
            label="Top user"
            value={kpis.topUser ? kpis.topUser[0] : "—"}
            sub={kpis.topUser ? `${kpis.topUser[1]} event${kpis.topUser[1] === 1 ? "" : "s"}` : undefined}
            tone="emerald"
          />
        </div>

        {/* Filters */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 mb-5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-500 uppercase tracking-widest">
            <Filter className="w-3 h-3" /> Filter:
          </div>
          <Select value={range} onChange={(v) => setRange(v as typeof range)} options={[
            { value: "24h", label: "Last 24h" },
            { value: "7d",  label: "Last 7 days" },
            { value: "30d", label: "Last 30 days" },
            { value: "all", label: "All time" },
          ]} />
          <Select value={actionFilter} onChange={setActionFilter} options={[
            { value: "ALL", label: "All actions" },
            ...Object.keys(ACTION_STYLE).sort().map((k) => ({ value: k, label: prettyAction(k) })),
          ]} />
          <Select value={resourceFilter} onChange={setResourceFilter} options={[
            { value: "ALL", label: "Any resource" },
            { value: "document", label: "Documents" },
            { value: "project", label: "Projects" },
            { value: "milestone", label: "Milestones" },
            { value: "asset", label: "Assets" },
          ]} />
          <Select value={libraryFilter} onChange={setLibraryFilter} options={[
            { value: "ALL", label: "Any library" },
            ...libraries.map((l) => ({ value: l.id, label: l.name })),
          ]} />
          <input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="Filter by user email…"
            className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-xs w-56 focus:ring-2 focus:ring-slate-900/10"
          />
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400">Showing {filtered.length} of {rows.length}</span>
            <button
              onClick={() => setLimit((n) => n + 200)}
              className="text-[10px] font-bold text-slate-700 px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200"
            >Load 200 more</button>
          </div>
        </div>

        {/* Feed */}
        {error && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          {loading && rows.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-slate-500 text-xs">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading audit log…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm italic">No matching events.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((r) => (
                <AuditRowItem key={r.id} row={r} docMeta={docMeta.get(r.resourceId)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface KpiProps { label: string; value: string; sub?: string; tone: "slate" | "rose" | "indigo" | "emerald" }
function Kpi({ label, value, sub, tone }: KpiProps) {
  const ring = {
    slate:   "ring-slate-200 bg-white",
    rose:    "ring-rose-200 bg-rose-50/40",
    indigo:  "ring-indigo-200 bg-indigo-50/40",
    emerald: "ring-emerald-200 bg-emerald-50/40",
  }[tone];
  return (
    <div className={`rounded-2xl ring-1 shadow-sm p-4 ${ring}`}>
      <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{label}</div>
      <div className="mt-1 text-xl font-black text-slate-900 truncate">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}
function Select({ value, onChange, options }: SelectProps) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none pl-3 pr-7 py-1 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:ring-2 focus:ring-slate-900/10"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
    </div>
  );
}

interface AuditRowItemProps {
  row: AuditRow;
  docMeta?: { documentNumber: string | null; title: string | null; libraryId: string };
}
function AuditRowItem({ row, docMeta }: AuditRowItemProps) {
  const style = ACTION_STYLE[row.action] ?? { icon: ScrollText, tone: "bg-slate-50 text-slate-600 border-slate-200" };
  const ResIcon = RESOURCE_ICON[row.resourceType] ?? FileText;
  const Icon = style.icon;

  const resourceHref = (() => {
    if (row.resourceType === "document" && docMeta?.libraryId) {
      return `/documents/${docMeta.libraryId}?doc=${row.resourceId}`;
    }
    if (row.resourceType === "project") return `/projects/${row.resourceId}`;
    return null;
  })();

  return (
    <li className="px-4 py-3 hover:bg-slate-50/60 transition-colors flex items-start gap-3">
      <div className={`shrink-0 w-8 h-8 rounded-lg border ${style.tone} flex items-center justify-center`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md border ${style.tone}`}>
            {prettyAction(row.action)}
          </span>
          <span className="text-[11px] text-slate-500 inline-flex items-center gap-1">
            <ResIcon className="w-3 h-3" /> {row.resourceType}
          </span>
          {docMeta && (
            <span className="text-xs font-mono text-slate-700 truncate max-w-[40ch]">
              {docMeta.documentNumber ? `${docMeta.documentNumber} · ` : ""}{docMeta.title ?? row.resourceId}
            </span>
          )}
          {!docMeta && (
            <span className="text-xs font-mono text-slate-500 truncate max-w-[40ch]">{row.resourceId}</span>
          )}
          {resourceHref && (
            <Link href={resourceHref} className="text-[10px] font-bold text-blue-600 hover:underline inline-flex items-center gap-0.5">
              Open <ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
        </div>
        <div className="text-[11px] text-slate-600 mt-1 flex items-center flex-wrap gap-x-2 gap-y-0.5">
          <span>{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}</span>
          <span className="text-slate-300">·</span>
          <time className="text-slate-500" dateTime={row.timestamp}>{formatTime(row.timestamp)}</time>
        </div>
        {(row.details && Object.keys(row.details).length > 0) && (
          <details className="mt-1.5">
            <summary className="text-[10px] font-bold text-slate-500 cursor-pointer hover:text-slate-700">Details</summary>
            <pre className="mt-1 text-[10px] text-slate-600 bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

function prettyAction(action: string): string {
  return action.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleString();
  } catch {
    return "";
  }
}
