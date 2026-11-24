"use client";

// /admin/audit: the workspace's audit log.
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
import { ScrollText, AlertTriangle, Filter, ChevronDown, RefreshCw, Eye, Download, Upload, Pencil, Trash2, FileSignature, GitBranch, Lock, Unlock, ArrowUpRight, ShieldOff, AlertOctagon, Zap, FileText, Briefcase, Layers, KeyRound } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import IsoGuidance from "@/components/ui/IsoGuidance";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { tbl, btnRow, link, RowEdge, shortDateTime, type Tone } from "@/components/admin/kit";
import { bandInput, bandInputIcon, bandSelect, plural } from "@/components/admin/band";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";

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
const ACTION_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: Tone }> = {
  VIEW:                  { icon: Eye, tone: "none" },
  DOWNLOAD:              { icon: Download, tone: "none" },
  UPLOAD:                { icon: Upload, tone: "none" },
  CHECK_OUT:             { icon: Lock, tone: "none" },
  CHECK_IN:              { icon: Unlock, tone: "none" },
  ABANDON:               { icon: Unlock, tone: "warn" },
  FORCE_RELEASE:         { icon: AlertOctagon, tone: "bad" },
  JOIN:                  { icon: ArrowUpRight, tone: "none" },
  REV_UP:                { icon: GitBranch, tone: "none" },
  REV_BACKFILL:          { icon: GitBranch, tone: "none" },
  SUPERSEDE_DOC:         { icon: ArrowUpRight, tone: "none" },
  REVERT:                { icon: ArrowUpRight, tone: "warn" },
  ARCHIVE_DOC:           { icon: ShieldOff, tone: "none" },
  DOC_SPLIT:             { icon: GitBranch, tone: "none" },
  CREATED_FROM_SPLIT:    { icon: Zap, tone: "none" },
  DOC_MERGED:            { icon: GitBranch, tone: "none" },
  CREATED_FROM_MERGE:    { icon: Zap, tone: "none" },
  DOC_RENUMBERED:        { icon: Pencil, tone: "warn" },
  SET_REV_UP:            { icon: GitBranch, tone: "none" },
  DOC_SPLIT_REVERSED:    { icon: AlertTriangle, tone: "none" },
  DOC_MERGE_REVERSED:    { icon: AlertTriangle, tone: "none" },
  DOC_RENUMBER_REVERSED: { icon: AlertTriangle, tone: "none" },
  HOLD_OPENED:           { icon: AlertOctagon, tone: "bad" },
  HOLD_RELEASED:         { icon: Unlock, tone: "none" },
  MILESTONE_CREATED:     { icon: Zap, tone: "none" },
  MILESTONE_UPDATED:     { icon: Pencil, tone: "none" },
  MILESTONE_COMPLETED:   { icon: Zap, tone: "none" },
  MILESTONE_MISSED:      { icon: AlertOctagon, tone: "warn" },
  MILESTONE_BLOCKED:     { icon: AlertOctagon, tone: "bad" },
  MILESTONE_DELETED:     { icon: Trash2, tone: "bad" },
  EQUIPMENT_STATE_CHANGED: { icon: Layers, tone: "warn" },
  NOTE_CREATED:          { icon: Pencil, tone: "none" },
  NOTE_DELETED:          { icon: Trash2, tone: "bad" },
  PROJECT_CREATED:       { icon: Briefcase, tone: "none" },
  MARKUP_REQUESTED:      { icon: FileSignature, tone: "none" },
  DATA_EXPORT:           { icon: Download, tone: "none" },
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
  const [error, setError] = useState<unknown>(null);
  const [libraries, setLibraries] = useState<LibraryLite[]>([]);
  const [docMeta, setDocMeta] = useState<Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>>(new Map());

  // Filters
  const [actionFilter, setActionFilter] = useState<string>("ALL");
  const [resourceFilter, setResourceFilter] = useState<string>("ALL");
  const [libraryFilter, setLibraryFilter] = useState<string>("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [limit, setLimit] = useState(200);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

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
    } catch (e) { setError(e); }
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
    const items = new Set(filtered.map((r) => `${r.resourceType}:${r.resourceId}`)).size;
    return { total: filtered.length, topAction, topUser, deletes, people: byUser.size, items };
  }, [filtered]);

  if (!canRead) {
    return (
      <PageShell width="work">
        <PageHero kicker="History · Audit log" title="Admins, managers, supervisors, doc control and auditors only."
          sub={<>Ask your workspace admin if you need access. You&apos;re signed in as {userEmail || "an unknown address"}{activeRole ? ` (${activeRole})` : ""}.</>} />
      </PageShell>
    );
  }

  // The answer: how much happened, and how much of it undid something.
  const when = range === "24h" ? " in the last 24 hours" : range === "7d" ? " in the last 7 days" : range === "30d" ? " in the last 30 days" : "";
  const answer = loading && rows.length === 0 ? "Audit log"
    : error != null && rows.length === 0 ? "Couldn't load the audit log."
    : kpis.total === 0 ? `No events${when}.`
    : `${plural(kpis.total, "event")}${when}.`;

  return (
    <PageShell width="work">
        <PageHero
          kicker="History · Audit log"
          title={answer}
          sub={
            <>
              {kpis.topUser ? <>Most active: {kpis.topUser[0]}, {plural(kpis.topUser[1], "event")}. </> : "Who did what, and when. "}
              <IsoGuidance topic="audit_log" size="md" />
            </>
          }
          facts={kpis.total > 0 ? [
            { label: "Deletes and undos", value: kpis.deletes, tone: kpis.deletes > 0 ? "bad" : undefined, hero: kpis.deletes > 0 },
            { label: "People", value: kpis.people },
            { label: "Items touched", value: kpis.items },
          ] : undefined}
          tools={
            <button type="button" className={heroQuiet} onClick={fetchRows} disabled={loading} aria-label="Check for new events" title="Check for new events">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
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
          {/* Filters steer the whole log, so they sit in the header. */}
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
              { value: "24h", label: "Last 24 hours" },
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
          {error != null && rows.length > 0 && (
            <ErrorNote compact error={error} title="Couldn't refresh the audit log." onRetry={() => void fetchRows()} />
          )}
          {loading && rows.length === 0 ? (
            <SkeletonRows rows={6} cols={3} what="the audit log" />
          ) : error != null && rows.length === 0 ? (
            <ErrorNote error={error} title="The audit log didn't load." onRetry={() => void fetchRows()} />
          ) : filtered.length === 0 ? (
            <div className={`${tbl.wrap} px-4 py-8 text-center`}>
              <p className="text-reading text-[var(--color-text)]">No events match{range !== "all" ? " in this window" : ""}.</p>
              {(range !== "all" || actionFilter !== "ALL" || resourceFilter !== "ALL" || libraryFilter !== "ALL" || userQuery) && (
                <button type="button" className={`${link} mt-1.5 font-medium`}
                  onClick={() => { setRange("all"); setActionFilter("ALL"); setResourceFilter("ALL"); setLibraryFilter("ALL"); setUserQuery(""); }}>
                  Show every event
                </button>
              )}
            </div>
          ) : (
            <div className={tbl.wrap}>
              <table className={tbl.table}>
                <thead className={`${tbl.thead} max-md:hidden`}>
                  <tr>
                    <th className={`${tbl.th} w-[150px]`}>When</th>
                    <th className={tbl.th}>Action</th>
                    <th className={tbl.th}>Item</th>
                    <th className={tbl.th}>Who</th>
                    <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                <tbody className={tbl.tbody}>
                  {filtered.map((r) => (
                    <AuditRowItem key={r.id} row={r} docMeta={docMeta.get(r.resourceId)}
                      onFilterAction={ACTION_STYLE[r.action] ? (a) => { setActionFilter(a); setLimit(200); } : undefined}
                      onFilterResource={RESOURCE_ICON[r.resourceType] ? (t) => { setResourceFilter(t); setLimit(200); } : undefined}
                      onFilterUser={(u) => setUserQuery(u)}
                      open={openIds.has(r.id)} onToggle={() => setOpenIds((prev) => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                  ))}
                </tbody>
              </table>
              {/* The log keeps going: say how much is shown and fetch more. */}
              <div className={tbl.foot}>
                <span className="text-[var(--color-text-muted)] tabular-nums">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} loaded</span>
                {rows.length >= limit && (
                  <button type="button" onClick={() => setLimit((n) => n + 200)} className={link}>
                    Show 200 more
                  </button>
                )}
              </div>
            </div>
          )}
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
/** A filter in the header. */
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
  open: boolean;
  onToggle: () => void;
  /** Tap the action pill, the item's kind or the person: show only those. */
  onFilterAction?: (action: string) => void;
  onFilterResource?: (type: string) => void;
  onFilterUser?: (email: string) => void;
}
function AuditRowItem({ row, docMeta, open, onToggle, onFilterAction, onFilterResource, onFilterUser }: AuditRowItemProps) {
  const style = ACTION_STYLE[row.action] ?? { icon: ScrollText, tone: "none" as Tone };
  const ResIcon = RESOURCE_ICON[row.resourceType] ?? FileText;
  const Icon = style.icon;
  const hasDetails = !!row.details && Object.keys(row.details).length > 0;

  const resourceHref = (() => {
    if (row.resourceType === "document" && docMeta?.libraryId) {
      return `/documents/${docMeta.libraryId}?doc=${row.resourceId}`;
    }
    if (row.resourceType === "project") return `/projects/${row.resourceId}`;
    return null;
  })();
  const itemLabel = docMeta
    ? <><span className="ui-id text-reading">{docMeta.documentNumber ?? ""}</span>{docMeta.title && docMeta.title !== docMeta.documentNumber && <span className="text-[var(--color-text-muted)]"> {docMeta.title}</span>}</>
    : <span className="text-[var(--color-text-muted)] capitalize">{row.resourceType}</span>;
  void Icon; // the action reads as words; color only for deletes and holds
  const actionCls = `text-body font-medium ${style.tone === "bad" ? "text-[var(--state-overdue-text)]" : style.tone === "warn" ? "text-[var(--state-held-text)]" : "text-[var(--color-text)]"}`;

  return (
    <>
      <tr className={`${tbl.tr} max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:py-1.5`}>
        <td className={`${tbl.td} relative max-md:hidden whitespace-nowrap text-body text-[var(--color-text-muted)]`}>
          {style.tone === "bad" && <RowEdge tone="bad" />}
          <time dateTime={row.timestamp} title={shortDateTime(row.timestamp)}>{formatTime(row.timestamp)}</time>
        </td>
        <td className={`${tbl.td} relative max-md:py-1 whitespace-nowrap`}>
          {style.tone === "bad" && <span className="md:hidden"><RowEdge tone="bad" /></span>}
          {/* The action as a pill in its state color; tap it to see only that action. */}
          {onFilterAction ? (
            <button type="button" onClick={() => onFilterAction(row.action)} title={`Show only "${prettyAction(row.action)}"`}
              className={`${actionCls} hover:underline underline-offset-2`}>
              {prettyAction(row.action)}
            </button>
          ) : <span className={actionCls}>{prettyAction(row.action)}</span>}
          <span className="md:hidden ml-2 text-body text-[var(--color-text-muted)]">{formatTime(row.timestamp)}</span>
        </td>
        <td className={`${tbl.td} max-md:col-span-2 max-md:row-start-2 max-md:py-0.5 min-w-0`}>
          <span className="inline-flex items-center gap-2 min-w-0 max-w-[48ch]">
            {onFilterResource ? (
              <button type="button" onClick={() => onFilterResource(row.resourceType)} title={`Show only ${row.resourceType} events`} aria-label={`Show only ${row.resourceType} events`}
                className="shrink-0 w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 -ml-1 grid place-items-center rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"><ResIcon className="w-4 h-4" /></button>
            ) : <span aria-hidden className="shrink-0 text-[var(--color-text-faint)]"><ResIcon className="w-4 h-4" /></span>}
            {resourceHref
              ? <Link href={resourceHref} className="truncate hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{itemLabel}</Link>
              : <span className="truncate">{itemLabel}</span>}
          </span>
        </td>
        <td className={`${tbl.td} max-md:col-span-2 max-md:row-start-3 max-md:pt-0.5 text-body text-[var(--color-text-muted)]`}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {row.userEmail && onFilterUser
              ? <button type="button" onClick={() => onFilterUser(row.userEmail!)} title={`Show only ${row.userEmail}`} className="text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{row.userEmail}</button>
              : <span className="text-[var(--color-text)]">{row.userEmail || row.userId}</span>}
            {row.userRole ? <span className="text-body text-[var(--color-text-muted)]">{row.userRole}</span> : null}
          </span>
        </td>
        <td className={`${tbl.td} max-md:col-start-2 max-md:row-start-1 max-md:py-1 text-right`}>
          {hasDetails && (
            <button type="button" onClick={onToggle} aria-expanded={open} className={btnRow}>
              Details <ChevronDown aria-hidden className={`ui-chevron w-3.5 h-3.5 ${open ? "rotate-180" : ""}`} />
            </button>
          )}
        </td>
      </tr>
      {open && hasDetails && (
        <tr className="bg-[var(--color-surface-2)]">
          <td colSpan={5} className="px-4 py-3">
            <pre className="text-body text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md p-3 overflow-x-auto font-mono">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
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
  const header = ["Timestamp", "Action", "Resource type", "Resource ID", "Resource label", "User email", "User role", "Details JSON"];
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
  const words = action.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return shortDateTime(iso);
  } catch {
    return "";
  }
}
