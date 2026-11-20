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
import { ScrollText, AlertTriangle, Filter, RefreshCw, Eye, Download, Upload, Pencil, Trash2, FileSignature, GitBranch, Lock, Unlock, ArrowUpRight, ShieldOff, AlertOctagon, Zap, FileText, Briefcase, Layers, KeyRound } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import IsoGuidance from "@/components/ui/IsoGuidance";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { bandInput, bandInputIcon, bandSelect, plural } from "@/components/admin/band";
import LoadingBlock from "@/components/ui/LoadingBlock";

// Auditor included: the role exists FOR audit review — it was defined with an
// "audit" capability yet locked out of the one page that shows the trail.
const ADMIN_ROLES = new Set(["Admin", "Manager", "Supervisor", "DocCtrl", "Auditor"]);

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
  VIEW:                  { icon: Eye,           tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  DOWNLOAD:              { icon: Download,      tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  UPLOAD:                { icon: Upload,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  CHECK_OUT:             { icon: Lock,          tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  CHECK_IN:              { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  ABANDON:               { icon: Unlock,        tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  FORCE_RELEASE:         { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  JOIN:                  { icon: ArrowUpRight,  tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  REV_UP:                { icon: GitBranch,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  REV_BACKFILL:          { icon: GitBranch,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  SUPERSEDE_DOC:         { icon: ArrowUpRight,  tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  REVERT:                { icon: ArrowUpRight,  tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  ARCHIVE_DOC:           { icon: ShieldOff,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)]" },
  DOC_SPLIT:             { icon: GitBranch,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  CREATED_FROM_SPLIT:    { icon: Zap,      tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DOC_MERGED:            { icon: GitBranch,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  CREATED_FROM_MERGE:    { icon: Zap,      tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DOC_RENUMBERED:        { icon: Pencil,        tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  SET_REV_UP:            { icon: GitBranch,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DOC_SPLIT_REVERSED:    { icon: AlertTriangle, tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DOC_MERGE_REVERSED:    { icon: AlertTriangle, tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DOC_RENUMBER_REVERSED: { icon: AlertTriangle, tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  HOLD_OPENED:           { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  HOLD_RELEASED:         { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  MILESTONE_CREATED:     { icon: Zap,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  MILESTONE_UPDATED:     { icon: Pencil,        tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  MILESTONE_COMPLETED:   { icon: Zap,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  MILESTONE_MISSED:      { icon: AlertOctagon,  tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  MILESTONE_BLOCKED:     { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  MILESTONE_DELETED:     { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  EQUIPMENT_STATE_CHANGED: { icon: Layers,      tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  NOTE_CREATED:          { icon: Pencil,        tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  NOTE_DELETED:          { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900" },
  PROJECT_CREATED:       { icon: Briefcase,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  MARKUP_REQUESTED:      { icon: FileSignature, tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
  DATA_EXPORT:           { icon: Download,      tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]" },
};

const RESOURCE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  project: Briefcase,
  milestone: Zap,
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
      <PageShell width="work">
        <PageHero kicker="History · Audit log" title="Admin-class roles only." overlap={false}
          sub={<>Ask your workspace admin if you need access. Signed in as {userEmail || "-"} ({activeRole || "-"}).</>} />
      </PageShell>
    );
  }

  // The answer: how much happened, and how much of it undid something.
  const when = range === "24h" ? " in the last 24 hours" : range === "7d" ? " in the last 7 days" : range === "30d" ? " in the last 30 days" : "";
  const answer = loading && rows.length === 0 ? "Audit log"
    : error && rows.length === 0 ? "Couldn't load the audit log."
    : kpis.total === 0 ? `No events${when}.`
    : `${plural(kpis.total, "event")}${when}.`;

  return (
    <PageShell width="work">
        <PageHero
          kicker="History · Audit log"
          title={answer}
          sub={
            <>
              {kpis.total > 0 && (
                <>
                  <span className={kpis.deletes > 0 ? "font-semibold text-rose-200" : ""}>{kpis.deletes} delete{kpis.deletes === 1 ? "" : "s"}, undo{kpis.deletes === 1 ? "" : "s"} or forced change{kpis.deletes === 1 ? "" : "s"}</span>
                  {kpis.topAction && <> · most common: <b className="text-white">{prettyAction(kpis.topAction[0])}</b> ({kpis.topAction[1]})</>}
                  {kpis.topUser && <> · most active: <b className="text-white">{kpis.topUser[0]}</b> ({kpis.topUser[1]})</>}
                  {" · "}
                </>
              )}
              Who did what, and when. <IsoGuidance topic="audit_log" size="md" />
            </>
          }
          tools={
            <button type="button" className={heroQuiet} onClick={fetchRows} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> <span className="max-sm:hidden">Refresh</span>
            </button>
          }
          primary={
            <button
              type="button"
              className={heroPrimary}
              onClick={() => exportAuditCsv(filtered, docMeta)}
              disabled={filtered.length === 0}
              title="Download the rows shown as a CSV (Excel opens it)."
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          }
        >
          <div className="[&>div]:mb-0">
            <ViewTabs tabs={ACTIVITY_VIEWS} variant="dark" />
          </div>
          {/* Filters steer the whole log, so they sit in the band. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Filter className={bandInputIcon} />
              <input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                aria-label="Filter by user email"
                placeholder="Filter by user email"
                className={bandInput}
              />
            </div>
            <Select label="When" value={range} onChange={(v) => setRange(v as typeof range)} options={[
              { value: "24h", label: "Last 24h" },
              { value: "7d",  label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
              { value: "all", label: "All time" },
            ]} />
            <Select label="Action" value={actionFilter} onChange={setActionFilter} options={[
              { value: "ALL", label: "All actions" },
              ...Object.keys(ACTION_STYLE).sort().map((k) => ({ value: k, label: prettyAction(k) })),
            ]} />
            <Select label="Resource" value={resourceFilter} onChange={setResourceFilter} options={[
              { value: "ALL", label: "Any resource" },
              { value: "document", label: "Documents" },
              { value: "project", label: "Projects" },
              { value: "milestone", label: "Milestones" },
              { value: "asset", label: "Assets" },
            ]} />
            <Select label="Library" value={libraryFilter} onChange={setLibraryFilter} options={[
              { value: "ALL", label: "Any library" },
              ...libraries.map((l) => ({ value: l.id, label: l.name })),
            ]} />
          </div>
        </PageHero>

        <PageBody>
        <Card pad={false} className="overflow-hidden">
          {error && rows.length > 0 && (
            <p role="alert" className="px-4 sm:px-5 pt-4 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Couldn&apos;t load the audit log: {error}{" "}
              <button type="button" onClick={() => void fetchRows()} className="font-bold underline">Try again</button>
            </p>
          )}
          {loading && rows.length === 0 ? (
            <LoadingBlock what="the audit log" className="border-0 rounded-none p-5" />
          ) : error && rows.length === 0 ? (
            <p role="alert" className="py-12 px-5 text-center text-[14px] text-red-700 dark:text-red-400">
              The audit log didn&apos;t load: {error}{" "}
              <button type="button" onClick={() => void fetchRows()} className="font-bold underline">Try again</button>
            </p>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-[14px] text-[var(--color-text-muted)]">No matching events. Widen the dates or clear a filter.</div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {filtered.map((r) => (
                <AuditRowItem key={r.id} row={r} docMeta={docMeta.get(r.resourceId)} />
              ))}
            </ul>
          )}
          {/* The log keeps going: say how much is shown and fetch more. */}
          {rows.length > 0 && (
            <div className="px-4 sm:px-5 py-3 border-t border-[var(--color-border)] flex items-center justify-between gap-3 text-[13px]">
              <span className="text-[var(--color-text-muted)]">{filtered.length} of {rows.length} loaded shown</span>
              {rows.length >= limit && (
                <button type="button" onClick={() => setLimit((n) => n + 200)} className="font-bold text-[var(--color-accent-text)] hover:underline">
                  Show 200 more
                </button>
              )}
            </div>
          )}
        </Card>
        </PageBody>
    </PageShell>
  );
}

interface SelectProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}
/** A filter on the dark band. */
function Select({ label, value, onChange, options }: SelectProps) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${bandSelect} max-w-[12rem]`}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

interface AuditRowItemProps {
  row: AuditRow;
  docMeta?: { documentNumber: string | null; title: string | null; libraryId: string };
}
function AuditRowItem({ row, docMeta }: AuditRowItemProps) {
  const style = ACTION_STYLE[row.action] ?? { icon: ScrollText, tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" };
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
    <li className="px-4 sm:px-5 py-3 hover:bg-[var(--color-surface-2)] transition-colors flex items-start gap-3">
      <div className={`shrink-0 w-8 h-8 rounded-lg border ${style.tone} flex items-center justify-center`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded-md border ${style.tone}`}>
            {prettyAction(row.action)}
          </span>
          <span className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1">
            <ResIcon className="w-3 h-3" /> {row.resourceType}
          </span>
          {docMeta && (
            <span className="text-xs font-mono text-[var(--color-text)] truncate max-w-[40ch]">
              {docMeta.documentNumber ? `${docMeta.documentNumber} · ` : ""}{docMeta.title ?? row.resourceId}
            </span>
          )}
          {!docMeta && (
            <span className="text-xs font-mono text-[var(--color-text-muted)] truncate max-w-[40ch]">{row.resourceId}</span>
          )}
          {resourceHref && (
            <Link href={resourceHref} className="text-[11px] font-bold text-[var(--color-accent-text)] hover:underline inline-flex items-center gap-0.5">
              Open <ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1 flex items-center flex-wrap gap-x-2 gap-y-0.5">
          <span>{row.userEmail || row.userId}{row.userRole ? ` (${row.userRole})` : ""}</span>
          <span className="text-[var(--color-text-faint)]">·</span>
          <time className="text-[var(--color-text-muted)]" dateTime={row.timestamp}>{formatTime(row.timestamp)}</time>
        </div>
        {(row.details && Object.keys(row.details).length > 0) && (
          <details className="mt-1.5">
            <summary className="text-[11px] font-bold text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)] transition-colors">Details</summary>
            <pre className="mt-1 text-[11px] text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded p-2 overflow-x-auto">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

// ─── CSV export ──────────────────────────────────────────────────────
// Dumps the currently-visible audit rows to a single CSV. Hydrates doc
// number + title for document rows so a compliance reviewer sees
// human-readable identifiers instead of UUIDs. UTF-8 BOM so Excel
// opens it correctly.

function exportAuditCsv(
  rows: AuditRow[],
  docMeta: Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>,
) {
  const csvField = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Timestamp", "Action", "Resource Type", "Resource ID", "Resource Label", "User Email", "User Role", "Details JSON"];
  const lines: string[] = [header.map(csvField).join(",")];
  for (const r of rows) {
    const dm = r.resourceType === "document" ? docMeta.get(r.resourceId) : undefined;
    const resourceLabel = dm
      ? [dm.documentNumber, dm.title].filter(Boolean).join(" · ")
      : "";
    lines.push([
      r.timestamp,
      prettyAction(r.action),
      r.resourceType,
      r.resourceId,
      resourceLabel,
      r.userEmail ?? "",
      r.userRole ?? "",
      r.details ? JSON.stringify(r.details) : "",
    ].map(csvField).join(","));
  }
  const csv = lines.join("\n");
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
