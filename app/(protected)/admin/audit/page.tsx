"use client";

// /admin/audit — org-wide audit log viewer.
//
// Reads the audit_logs table and renders it as a chronological feed
// with filters (action, resource type, user, date range, library).
// Who may open it is the admin.audit_view capability, decided by the admin
// layout's server gate (see below); anyone else sees the layout's denial.
//
// admin-and-org P7: the action and resource filters, the icons' fallback and
// the destructive KPI read ONE registry, lib/auditActions.ts (ALOG-11); the
// export pages through every matching row in the reader's own session, says
// its bounds inside the file and is audited (ALOG-6, lib/auditLogExport.ts);
// each row says whose word its identity is (actor_kind, ALOG-7); a
// TICKET_<ACTION> attempt row is paired with the row that names it
// (drafting-flow EVID-12).
//
// Designed to answer "who did what, when?" — including deletes — in
// one place rather than spreading evidence across the per-document
// timeline.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ScrollText, AlertTriangle, Filter, RefreshCw, Eye, Download, Upload, Pencil, Trash2, FileSignature, GitBranch, Lock, Unlock, ArrowUpRight, ShieldOff, AlertOctagon, Zap, FileText, Briefcase, Layers, KeyRound, Ban } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import IsoGuidance from "@/components/ui/IsoGuidance";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, Select as UiSelect } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { logAuditAction } from "@/lib/audit";
import ExportFilesPanel from "@/components/audit/ExportFilesPanel";
import {
  AUDIT_RESOURCE_TYPES, auditActionFilterOptions, auditActorNote, isDestructiveAuditAction,
  pairTicketAttempts, prettyAuditAction, auditRowLabel, ticketAttemptNote, DESTRUCTIVE_AUDIT_ACTIONS, type TicketAttemptOutcome,
} from "@/lib/auditActions";
import { alreadyRetiredStatus } from "@/lib/timeline";
import {
  applyAuditFilters, buildAuditCsv, fetchAuditRowsForExport, filterByLibrary, AUDIT_EXPORT_ROW_CEILING, AUDIT_CSV_LINES_BEFORE_HEADER,
  type AuditQuery, type AuditRange,
} from "@/lib/auditLogExport";

// Auditor included: the role exists FOR audit review — it was defined with an
// "audit" capability yet locked out of the one page that shows the trail.
// ROLE-5 / SURF-9: admission is the `admin.audit_view` capability (default
// Admin / Manager / Supervisor / DocCtrl / Auditor), decided by the admin
// layout's SERVER gate — role tokens by collection, then a per-person grant
// — and enforced at the database by the audit_logs SELECT overlay, which
// reads the same policy (20261063). The hardcoded set that used to live
// here could not be reconfigured and disagreed with the policy the moment
// an Admin edited it.

interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  orgId: string | null;
  userId: string;
  userEmail: string | null;
  userRole: string | null;
  /** ALOG-7 (20261201): member / server / system; null before that paste. */
  actorKind: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

interface LibraryLite { id: string; name: string }

// Maps an action string to a (icon, tone) for the chip on each row.
const ACTION_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  VIEW:                  { icon: Eye,           tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  DOWNLOAD:              { icon: Download,      tone: "bg-sky-50 text-sky-700 border-sky-200" },
  UPLOAD:                { icon: Upload,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CHECK_OUT:             { icon: Lock,          tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  CHECK_IN:              { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  ABANDON:               { icon: Unlock,        tone: "bg-amber-50 text-amber-700 border-amber-200" },
  FORCE_RELEASE:         { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  // DCK-12: the walkdown attestation and the legacy banner-release action.
  FIELD_VERIFIED:        { icon: FileSignature, tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  CHECKOUT_RELEASED:     { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  JOIN:                  { icon: ArrowUpRight,  tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  REV_UP:                { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  REV_BACKFILL:          { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  SUPERSEDE_DOC:         { icon: ArrowUpRight,  tone: "bg-violet-50 text-violet-700 border-violet-200" },
  REVERT:                { icon: ArrowUpRight,  tone: "bg-amber-50 text-amber-700 border-amber-200" },
  ARCHIVE_DOC:           { icon: ShieldOff,     tone: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border-strong)]" },
  // REV-32 (document-control P34): the metadata editor's void, a retirement.
  VOID_DOC:              { icon: Ban,           tone: "bg-rose-50 text-rose-700 border-rose-200" },
  DOC_SPLIT:             { icon: GitBranch,     tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  CREATED_FROM_SPLIT:    { icon: Zap,      tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  DOC_MERGED:            { icon: GitBranch,     tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  CREATED_FROM_MERGE:    { icon: Zap,      tone: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200" },
  DOC_RENUMBERED:        { icon: Pencil,        tone: "bg-amber-50 text-amber-700 border-amber-200" },
  SET_REV_UP:            { icon: GitBranch,     tone: "bg-blue-50 text-blue-700 border-blue-200" },
  DOC_SPLIT_REVERSED:    { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  DOC_MERGE_REVERSED:    { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  DOC_RENUMBER_REVERSED: { icon: AlertTriangle, tone: "bg-orange-50 text-orange-700 border-orange-200" },
  HOLD_OPENED:           { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  HOLD_RELEASED:         { icon: Unlock,        tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_CREATED:     { icon: Zap,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_UPDATED:     { icon: Pencil,        tone: "bg-blue-50 text-blue-700 border-blue-200" },
  MILESTONE_COMPLETED:   { icon: Zap,      tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  MILESTONE_MISSED:      { icon: AlertOctagon,  tone: "bg-amber-50 text-amber-700 border-amber-200" },
  MILESTONE_BLOCKED:     { icon: AlertOctagon,  tone: "bg-rose-50 text-rose-700 border-rose-200" },
  MILESTONE_DELETED:     { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200" },
  EQUIPMENT_STATE_CHANGED: { icon: Layers,      tone: "bg-amber-50 text-amber-700 border-amber-200" },
  NOTE_CREATED:          { icon: Pencil,        tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" },
  NOTE_DELETED:          { icon: Trash2,        tone: "bg-rose-50 text-rose-700 border-rose-200" },
  PROJECT_CREATED:       { icon: Briefcase,     tone: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  MARKUP_REQUESTED:      { icon: FileSignature, tone: "bg-violet-50 text-violet-700 border-violet-200" },
  DATA_EXPORT:           { icon: Download,      tone: "bg-sky-50 text-sky-700 border-sky-200" },
  WORKSPACE_SELF_HEAL:   { icon: ArrowUpRight,  tone: "bg-amber-50 text-amber-700 border-amber-200" },
};

// REV-34 (d) (P34 final fix pass): a SUPERSEDE_DOC / ARCHIVE_DOC / VOID_DOC
// with `alreadyRetired: true` made no retirement (a bulk door re-ran the
// steps), so its chip is neutral, never the retirement's — as the activity
// feed and the document timeline show it.
const ALREADY_RETIRED_STYLE: { icon: React.ComponentType<{ className?: string }>; tone: string } =
  { icon: RefreshCw, tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" };

const RESOURCE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  project: Briefcase,
  milestone: Zap,
  asset: KeyRound,
  org: Layers,
};

export default function AuditLogPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();

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
  const [range, setRange] = useState<AuditRange>("7d");
  const [limit, setLimit] = useState(200);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

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
      // ALOG-11: the action filter is a registered action (a ticket action
      // brings its EVID-12 follow-up rows) or a family (TICKET_…).
      const base = supabase.from("audit_logs").select("*").eq("org_id", activeOrgId);
      const q = applyAuditFilters(base as unknown as AuditQuery, { range, action: actionFilter, resource: resourceFilter }, Date.now()) as unknown as typeof base;
      const { data, error: qErr } = await q.order("timestamp", { ascending: false }).limit(limit);
      if (qErr) throw qErr;
      const list: AuditRow[] = (data || []).map((r) => ({
        id: r.id, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id,
        orgId: r.org_id, userId: r.user_id, userEmail: r.user_email, userRole: r.user_role,
        actorKind: (r as { actor_kind?: string | null }).actor_kind ?? null,
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

  // ALOG-11 done-when 2: the library filter keeps the library's document rows
  // and the library's own rows, and SAYS how many other rows it leaves out.
  const { filtered, libraryHidden } = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter((r) => (r.userEmail ?? "").toLowerCase().includes(q));
    let hidden = 0;
    if (libraryFilter !== "ALL") {
      const out = filterByLibrary(list, libraryFilter, (id) => docMeta.get(id)?.libraryId);
      list = out.kept;
      hidden = out.hidden;
    }
    return { filtered: list, libraryHidden: hidden };
  }, [rows, userQuery, libraryFilter, docMeta]);

  // drafting-flow EVID-12: an attempt row and the row that names it.
  const pairing = useMemo(() => pairTicketAttempts(filtered), [filtered]);
  const actionOptions = useMemo(() => auditActionFilterOptions(rows.map((r) => r.action)), [rows]);

  // ALOG-6: every row the filters select, paged on the server in the
  // reader's own session; audited BEFORE the file is handed over.
  const exportAll = async () => {
    if (!activeOrgId || exporting) return;
    setExporting(true); setExportNote(null); setError(null);
    try {
      const filters = { range, action: actionFilter, resource: resourceFilter, userQuery };
      const nowMs = Date.now();
      const got = await fetchAuditRowsForExport(
        () => supabase.from("audit_logs").select("*").eq("org_id", activeOrgId) as never,
        filters, nowMs,
      );
      if (!got.ok) throw new Error(`The export could not read the audit log: ${got.error}. No file was made.`);
      // Document labels (and the library filter, which needs each document's library).
      const docIds = Array.from(new Set(got.rows.filter((r) => r.resourceType === "document").map((r) => r.resourceId)));
      const meta = new Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>();
      for (let i = 0; i < docIds.length; i += 200) {
        const { data: docs, error: dErr } = await supabase.from("documents").select("id, document_number, title, name, library_id").in("id", docIds.slice(i, i + 200));
        if (dErr) throw new Error(`The export could not read the documents it names: ${dErr.message}. No file was made.`);
        for (const d of (docs as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string }>) ?? []) {
          meta.set(d.id, { documentNumber: d.document_number, title: d.title || d.name, libraryId: d.library_id });
        }
      }
      let out = got.rows;
      let hidden = 0;
      // Rows dated after the start lead the list (lib/auditLogExport.ts pass 0).
      const datedAfter = new Set(got.rows.slice(0, got.datedAfterStart).map((r) => r.id));
      const library = libraryFilter !== "ALL" ? libraries.find((l) => l.id === libraryFilter) ?? { id: libraryFilter, name: libraryFilter } : null;
      if (library) {
        const f = filterByLibrary(out, library.id, (id) => meta.get(id)?.libraryId);
        out = f.kept; hidden = f.hidden;
      }
      const datedAfterStart = out.filter((r) => datedAfter.has(r.id)).length;
      const exportedAtIso = new Date(nowMs).toISOString();
      const rec = await logAuditAction({
        action: "AUDIT_LOG_EXPORTED", resourceType: "org", resourceId: activeOrgId, orgId: activeOrgId,
        userId: uid ?? "", userEmail: userEmail ?? undefined, userRole: activeRole ?? undefined,
        details: {
          filters: { range, action: actionFilter, resource: resourceFilter, userQuery: userQuery.trim() || null, libraryId: library?.id ?? null },
          rows: out.length, complete: got.complete, ceiling: AUDIT_EXPORT_ROW_CEILING, exportedAt: exportedAtIso,
          datedAfterStart,
        },
      });
      if (!rec.ok) throw new Error(`The export was not handed over: its own audit record could not be written (${rec.error}). Who took a copy of the audit log must be recorded.`);
      const csv = buildAuditCsv(out, meta, {
        orgId: activeOrgId, filters: { ...filters, library }, exportedAtIso, rows: out.length,
        complete: got.complete, ceiling: AUDIT_EXPORT_ROW_CEILING, libraryHidden: hidden,
        datedAfterStart,
      });
      downloadCsv(csv);
      setExportNote((got.complete
        ? `Exported ${out.length} row(s) — every row the filters select.`
        : `Exported the newest ${out.length} row(s): the export stops at ${AUDIT_EXPORT_ROW_CEILING} rows, and the file says so. Narrow the date range or filters for the rest.`)
        + ` ${CSV_SHAPE_NOTE}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

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
    // ALOG-11 done-when 3: a stated list (lib/auditActions.ts), never a regex.
    const deletes = [...byAction.entries()].filter(([k]) => isDestructiveAuditAction(k)).reduce((s, [, n]) => s + n, 0);
    return { total: filtered.length, topAction, topUser, deletes };
  }, [filtered]);

  return (
    <PageShell width="work">
        <ViewTabs title="History" tabs={ACTIVITY_VIEWS} />
        {/* Header */}
        <PageHeaderBar
          icon={ScrollText}
          title="Audit Log"
          subtitle={
            <>
              Every meaningful action across the workspace, with who and when.{" "}
              <IsoGuidance topic="audit_log" size="md" />
            </>
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportAll()}
                disabled={exporting || !activeOrgId}
                title={`Download EVERY row the filters select (not only the rows on screen), up to ${AUDIT_EXPORT_ROW_CEILING.toLocaleString()} — the file states its own bounds. ${CSV_SHAPE_NOTE} The export itself is recorded in the audit log.`}
              >
                <Download className="w-3.5 h-3.5" /> {exporting ? "Exporting…" : "Export CSV"}
              </Button>
              <Button variant="secondary" size="sm" onClick={fetchRows} disabled={loading}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </>
          }
        />

        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <Kpi label="Events" value={kpis.total.toString()} tone="slate" />
          <Kpi label="Destructive / undo / force" value={kpis.deletes.toString()} tone={kpis.deletes > 0 ? "rose" : "slate"}
            title={`Counts these actions (lib/auditActions.ts): ${[...DESTRUCTIVE_AUDIT_ACTIONS].sort().join(", ")}`} />
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
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm p-3 mb-5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">
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
            ...actionOptions,
          ]} />
          <Select value={resourceFilter} onChange={setResourceFilter} options={[
            { value: "ALL", label: "Any resource" },
            ...AUDIT_RESOURCE_TYPES,
          ]} />
          <Select value={libraryFilter} onChange={setLibraryFilter} options={[
            { value: "ALL", label: "Any library" },
            ...libraries.map((l) => ({ value: l.id, label: l.name })),
          ]} />
          <div className="w-56">
            <Input
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="Filter by user email…"
            />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--color-text-faint)]">Showing {filtered.length} of {rows.length}</span>
            <button
              onClick={() => setLimit((n) => n + 200)}
              className="text-[10px] font-bold text-[var(--color-text)] px-2 py-1 rounded-md bg-[var(--color-surface-2)] hover:bg-slate-200 transition-colors"
            >Load 200 more</button>
          </div>
        </div>

        {libraryFilter !== "ALL" && libraryHidden > 0 && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2" role="status">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            The library filter shows this library&apos;s document rows and the library&apos;s own rows: {libraryHidden} other loaded row{libraryHidden === 1 ? "" : "s"} (workspace, permission, project and other events) {libraryHidden === 1 ? "is" : "are"} hidden. Choose &ldquo;Any library&rdquo; to see them.
          </div>
        )}
        {exportNote && (
          <div className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]" role="status">{exportNote}</div>
        )}
        {/* Feed */}
        {error && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm overflow-hidden">
          {loading && rows.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-[var(--color-text-muted)] text-xs">
              <Spinner /> Loading audit log…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-[var(--color-text-faint)] text-sm italic">No matching events.</div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {filtered.map((r) => (
                <AuditRowItem key={r.id} row={r} docMeta={docMeta.get(r.resourceId)}
                  attempt={pairing.attempts.get(r.id)?.outcome} namesAttempt={pairing.followUps.get(r.id)} />
              ))}
            </ul>
          )}
        </div>
    </PageShell>
  );
}

interface KpiProps { label: string; value: string; sub?: string; tone: "slate" | "rose" | "indigo" | "emerald"; title?: string }
function Kpi({ label, value, sub, tone, title }: KpiProps) {
  const ring = {
    slate:   "ring-[var(--color-border)] bg-[var(--color-surface)]",
    rose:    "ring-rose-200 bg-rose-50/40",
    indigo:  "ring-indigo-200 bg-indigo-50/40",
    emerald: "ring-emerald-200 bg-emerald-50/40",
  }[tone];
  return (
    <div className={`rounded-2xl ring-1 shadow-sm p-4 ${ring}`} title={title}>
      <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">{label}</div>
      <div className="mt-1 text-xl font-black text-[var(--color-text)] truncate">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; group?: string }>;
}
function Select({ value, onChange, options }: SelectProps) {
  // Grouped options (the action registry's categories) render as optgroups.
  const ungrouped = options.filter((o) => !o.group);
  const groups = Array.from(new Set(options.filter((o) => o.group).map((o) => o.group as string)));
  return (
    <UiSelect value={value} onChange={(e) => onChange(e.target.value)}>
      {ungrouped.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </UiSelect>
  );
}

/** ALOG-11 hand-off (P13): the file record a DATA_EXPORT row names (DEC-87 §3), or null. */
function exportRecordIdOf(details: Record<string, unknown> | null): string | null {
  const fr = (details?.fileRecord ?? null) as { recordId?: unknown } | null;
  return typeof fr?.recordId === "string" && fr.recordId ? fr.recordId : null;
}

interface AuditRowItemProps {
  row: AuditRow;
  docMeta?: { documentNumber: string | null; title: string | null; libraryId: string };
  /** EVID-12: this row is a ticket attempt; its outcome from the trail. */
  attempt?: TicketAttemptOutcome;
  /** EVID-12: this row names an attempt (its id). */
  namesAttempt?: string;
}
function AuditRowItem({ row, docMeta, attempt, namesAttempt }: AuditRowItemProps) {
  const style = alreadyRetiredStatus(row.action, row.details) ? ALREADY_RETIRED_STYLE : ACTION_STYLE[row.action] ?? { icon: ScrollText, tone: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]" };
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
            {/* document-control P28 (DIST-16, the integrator's fix pass): a recall row's details can make it a withdrawal */}
            {auditRowLabel(row.action, row.details)}
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
            <Link href={resourceHref} className="text-[10px] font-bold text-blue-600 hover:underline inline-flex items-center gap-0.5">
              Open <ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
          {attempt && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${attempt === "applied" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
              {ticketAttemptNote(attempt)}
            </span>
          )}
          {namesAttempt && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-amber-50 text-amber-800 border-amber-200">
              Names the attempt row {namesAttempt.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1 flex items-center flex-wrap gap-x-2 gap-y-0.5">
          <span>{row.userEmail || row.userId || "—"}{row.userRole ? ` (${row.userRole})` : ""}</span>
          <span className={row.actorKind ? "text-[var(--color-text-faint)]" : "text-amber-700"} title="ALOG-7: whose word the email and role on this row are">
            · {auditActorNote(row.actorKind)}
          </span>
          <span className="text-slate-300">·</span>
          <time className="text-[var(--color-text-muted)]" dateTime={row.timestamp}>{formatTime(row.timestamp)}</time>
        </div>
        {/* ALOG-11 hand-off (P13): a DATA_EXPORT row naming its file record — who took which drawing */}
        {row.action === "DATA_EXPORT" && row.orgId && exportRecordIdOf(row.details) && (
          <ExportFilesPanel orgId={row.orgId} recordId={exportRecordIdOf(row.details) as string} />
        )}
        {(row.details && Object.keys(row.details).length > 0) && (
          <details className="mt-1.5">
            <summary className="text-[10px] font-bold text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)] transition-colors">Details</summary>
            <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded p-2 overflow-x-auto">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

// ALOG-6 changed the file's shape (P7 review): the column header is no longer
// line 1. Say so wherever the file is offered, so an import is told.
const CSV_SHAPE_NOTE = `The file opens with ${AUDIT_CSV_LINES_BEFORE_HEADER} lines of bounds before the column header (line ${AUDIT_CSV_LINES_BEFORE_HEADER + 1}); skip them when importing.`;

// ─── CSV download ────────────────────────────────────────────────────
// The file is built by lib/auditLogExport.ts buildAuditCsv (every cell
// through lib/csvSafe, PM-15). UTF-8 BOM so Excel opens it correctly.
function downloadCsv(csv: string) {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const prettyAction = prettyAuditAction;

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
