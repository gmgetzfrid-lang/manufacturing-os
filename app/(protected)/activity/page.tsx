"use client";

// /activity — org-wide unified activity stream.
//
// Different from /admin/audit (which is a power-user log with raw
// JSON detail blocks and full audit weight). This is the people-
// facing feed: "what's been happening in the workspace lately?"
// grouped by day, with friendly summaries per event, links to
// the resource, and an actor avatar.
//
// Reads the same audit_logs table — the back-end is shared — but
// renders for humans, not auditors.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity, Loader2, RefreshCw, AlertTriangle,
  FileText, Briefcase, KeyRound, Lock, Unlock, AlertOctagon,
  GitBranch, Sparkles, Pencil, Trash2, FileSignature, Layers, Download,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";

interface ActivityRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  userEmail: string | null;
  userRole: string | null;
  details: Record<string, unknown> | null;
  timestamp: string;
}

const ACTION_VERBS: Record<string, { verb: string; emoji?: string; icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  CHECK_OUT:           { verb: "checked out", icon: Lock, tone: "indigo" },
  CHECK_IN:            { verb: "checked in", icon: Unlock, tone: "emerald" },
  ABANDON:             { verb: "abandoned checkout on", icon: Unlock, tone: "amber" },
  FORCE_RELEASE:       { verb: "force-released the lock on", icon: AlertOctagon, tone: "rose" },
  VIEW:                { verb: "viewed", icon: FileText, tone: "slate" },
  DOWNLOAD:            { verb: "downloaded", icon: Download, tone: "sky" },
  REV_UP:              { verb: "published a new revision of", icon: GitBranch, tone: "blue" },
  REV_BACKFILL:        { verb: "backfilled a revision of", icon: GitBranch, tone: "blue" },
  SUPERSEDE_DOC:       { verb: "superseded", icon: GitBranch, tone: "violet" },
  ARCHIVE_DOC:         { verb: "archived", icon: Trash2, tone: "slate" },
  DOC_SPLIT:           { verb: "split", icon: GitBranch, tone: "fuchsia" },
  DOC_MERGED:          { verb: "merged", icon: GitBranch, tone: "fuchsia" },
  DOC_RENUMBERED:      { verb: "renumbered", icon: Pencil, tone: "amber" },
  HOLD_OPENED:         { verb: "opened a hold on", icon: AlertOctagon, tone: "rose" },
  HOLD_RELEASED:       { verb: "released the hold on", icon: Unlock, tone: "emerald" },
  MILESTONE_CREATED:   { verb: "added a milestone to", icon: Sparkles, tone: "emerald" },
  MILESTONE_COMPLETED: { verb: "completed a milestone for", icon: Sparkles, tone: "emerald" },
  MILESTONE_MISSED:    { verb: "missed a milestone for", icon: AlertOctagon, tone: "amber" },
  MILESTONE_BLOCKED:   { verb: "blocked a milestone for", icon: AlertOctagon, tone: "rose" },
  EQUIPMENT_STATE_CHANGED: { verb: "changed the equipment state of", icon: Layers, tone: "amber" },
  NOTE_CREATED:        { verb: "added a note to", icon: Pencil, tone: "slate" },
  NOTE_DELETED:        { verb: "deleted a note from", icon: Trash2, tone: "rose" },
  PROJECT_CREATED:     { verb: "created project", icon: Briefcase, tone: "indigo" },
  MARKUP_REQUESTED:    { verb: "requested markups on", icon: FileSignature, tone: "violet" },
  DATA_EXPORT:         { verb: "exported data from", icon: Download, tone: "sky" },
};
const TONE_BG: Record<string, string> = {
  slate: "bg-slate-50 text-slate-600 border-slate-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  fuchsia: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
};

const RESOURCE_LABEL: Record<string, string> = {
  document: "document",
  ticket: "drafting request",
  project: "project",
  asset: "asset",
  milestone: "milestone",
  note: "note",
  org: "workspace",
};

export default function ActivityFeedPage() {
  const { activeOrgId } = useRole();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [docMeta, setDocMeta] = useState<Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>>(new Map());
  // Resolve non-document resources (tickets/projects/assets) to real labels +
  // links, keyed by `${type}:${id}`, so the feed never shows a raw id.
  const [extraMeta, setExtraMeta] = useState<Map<string, { label: string; href: string | null }>>(new Map());
  // Map document id → current-version file path, for first-page thumbnails.
  const [docFile, setDocFile] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const { data, error: qErr } = await supabase.from("audit_logs")
        .select("*").eq("org_id", activeOrgId)
        .order("timestamp", { ascending: false }).limit(limit);
      if (qErr) throw qErr;
      const list: ActivityRow[] = ((data || []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        action: String(r.action),
        resourceType: String(r.resource_type),
        resourceId: String(r.resource_id),
        userEmail: (r.user_email as string | null) ?? null,
        userRole: (r.user_role as string | null) ?? null,
        details: (r.details as Record<string, unknown> | null) ?? null,
        timestamp: String(r.timestamp),
      }));
      setRows(list);

      // Hydrate doc display info
      const docIds = Array.from(new Set(list.filter((r) => r.resourceType === "document").map((r) => r.resourceId)));
      if (docIds.length > 0) {
        const { data: docs } = await supabase
          .from("documents").select("id, document_number, title, name, library_id, current_version_id")
          .in("id", docIds);
        const m = new Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>();
        const versionByDoc = new Map<string, string>();
        for (const d of (docs as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string; current_version_id: string | null }>) ?? []) {
          m.set(d.id, { documentNumber: d.document_number, title: d.title || d.name, libraryId: d.library_id });
          if (d.current_version_id) versionByDoc.set(d.id, d.current_version_id);
        }
        setDocMeta(m);
        // Resolve the current version's file path for thumbnails.
        const verIds = Array.from(new Set(versionByDoc.values()));
        if (verIds.length > 0) {
          const { data: vers } = await supabase.from("document_versions").select("id, file_url").in("id", verIds);
          const fileByVer = new Map<string, string>();
          for (const v of (vers as Array<{ id: string; file_url: string | null }>) ?? []) if (v.file_url) fileByVer.set(v.id, v.file_url);
          const df = new Map<string, string>();
          for (const [docId, verId] of versionByDoc) { const f = fileByVer.get(verId); if (f) df.set(docId, f); }
          setDocFile(df);
        } else setDocFile(new Map());
      } else {
        setDocMeta(new Map());
        setDocFile(new Map());
      }

      // Hydrate ticket / project / asset labels so non-document rows read
      // "request RFI-0042" instead of "drafting request a1b2c3".
      const em = new Map<string, { label: string; href: string | null }>();
      const idsOf = (t: string) => Array.from(new Set(list.filter((r) => r.resourceType === t).map((r) => r.resourceId)));
      const [tIds, pIds, aIds] = [idsOf("ticket"), idsOf("project"), idsOf("asset")];
      await Promise.all([
        tIds.length ? supabase.from("tickets").select("id, ticket_id, title").in("id", tIds).then(({ data }) => {
          for (const t of (data as Array<{ id: string; ticket_id: string | null; title: string | null }>) ?? []) em.set(`ticket:${t.id}`, { label: t.ticket_id || t.title || t.id.slice(0, 8), href: `/requests/${t.id}` });
        }) : Promise.resolve(),
        pIds.length ? supabase.from("projects").select("id, name").in("id", pIds).then(({ data }) => {
          for (const p of (data as Array<{ id: string; name: string | null }>) ?? []) em.set(`project:${p.id}`, { label: p.name || p.id.slice(0, 8), href: `/projects/${p.id}` });
        }) : Promise.resolve(),
        aIds.length ? supabase.from("assets").select("id, tag").in("id", aIds).then(({ data }) => {
          for (const a of (data as Array<{ id: string; tag: string | null }>) ?? []) em.set(`asset:${a.id}`, { label: a.tag || a.id.slice(0, 8), href: a.tag ? `/assets/${encodeURIComponent(a.tag)}` : null });
        }) : Promise.resolve(),
      ]);
      setExtraMeta(em);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId, limit]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Group rows by day for the timeline
  const grouped = useMemo(() => {
    const out: Array<{ day: string; rows: ActivityRow[] }> = [];
    const map = new Map<string, ActivityRow[]>();
    for (const r of rows) {
      const day = new Date(r.timestamp).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const list = map.get(day) || [];
      list.push(r);
      map.set(day, list);
    }
    for (const [day, list] of map) out.push({ day, rows: list });
    return out;
  }, [rows]);

  // Top-of-feed "pulse" widget: at-a-glance counts so Activity reads like a
  // dashboard, not a raw log. Buckets the loaded window by category + today.
  const pulse = useMemo(() => {
    const todayStr = new Date().toDateString();
    let today = 0;
    const cat = { revisions: 0, locks: 0, holds: 0, milestones: 0, equipment: 0 };
    const actors = new Set<string>();
    for (const r of rows) {
      if (new Date(r.timestamp).toDateString() === todayStr) today++;
      if (r.userEmail) actors.add(r.userEmail);
      if (["REV_UP", "REV_BACKFILL", "SUPERSEDE_DOC", "DOC_SPLIT", "DOC_MERGED", "DOC_RENUMBERED"].includes(r.action)) cat.revisions++;
      else if (["CHECK_OUT", "CHECK_IN", "ABANDON", "FORCE_RELEASE"].includes(r.action)) cat.locks++;
      else if (["HOLD_OPENED", "HOLD_RELEASED"].includes(r.action)) cat.holds++;
      else if (r.action.startsWith("MILESTONE_")) cat.milestones++;
      else if (r.action === "EQUIPMENT_STATE_CHANGED") cat.equipment++;
    }
    return { today, actors: actors.size, ...cat };
  }, [rows]);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-4xl mx-auto p-6">
        <ViewTabs title="History" tabs={ACTIVITY_VIEWS} />
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
              <Activity className="w-7 h-7 text-emerald-600" /> Activity Feed
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              What&apos;s been happening in the workspace, in plain language. For raw event detail, see the Audit Log.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Pulse widget — at-a-glance summary of the loaded window. */}
        {rows.length > 0 && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
            <div className="text-sm font-bold text-slate-800 mb-3">
              {pulse.today} event{pulse.today === 1 ? "" : "s"} today
              <span className="text-slate-400 font-medium"> · {rows.length} loaded · {pulse.actors} {pulse.actors === 1 ? "person" : "people"} active</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {([
                ["Revisions", pulse.revisions, GitBranch, "text-blue-600 bg-blue-50"],
                ["Checkouts", pulse.locks, Lock, "text-indigo-600 bg-indigo-50"],
                ["Holds", pulse.holds, AlertOctagon, "text-rose-600 bg-rose-50"],
                ["Milestones", pulse.milestones, Sparkles, "text-emerald-600 bg-emerald-50"],
                ["Equipment", pulse.equipment, Layers, "text-amber-600 bg-amber-50"],
              ] as const).map(([label, n, Icon, cls]) => (
                <div key={label} className="rounded-xl border border-slate-100 p-2.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center mb-1.5 ${cls}`}><Icon className="w-3.5 h-3.5" /></div>
                  <div className="text-lg font-black text-slate-900 leading-none">{n}</div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1">{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm italic text-slate-400">No activity recorded yet.</div>
        ) : (
          <div className="space-y-6">
            {grouped.map((group) => (
              <div key={group.day}>
                <div className="sticky top-0 bg-slate-50/80 backdrop-blur z-10 py-2 mb-2 text-xs font-black text-slate-500 uppercase tracking-widest border-b border-slate-200">
                  {group.day}
                </div>
                <div className="space-y-1.5">
                  {group.rows.map((r) => {
                    const meta = ACTION_VERBS[r.action];
                    const Icon = meta?.icon ?? Activity;
                    const tone = TONE_BG[meta?.tone ?? "slate"];
                    const verb = meta?.verb ?? r.action.toLowerCase().replace(/_/g, " ");
                    const dm = r.resourceType === "document" ? docMeta.get(r.resourceId) : undefined;
                    const xm = !dm ? extraMeta.get(`${r.resourceType}:${r.resourceId}`) : undefined;
                    const resourceLabel = dm
                      ? `${dm.documentNumber ?? ""}${dm.documentNumber ? " · " : ""}${dm.title ?? dm.documentNumber ?? r.resourceId.slice(0, 8)}`
                      : xm
                      ? xm.label
                      : `${RESOURCE_LABEL[r.resourceType] || r.resourceType} ${r.resourceId.slice(0, 8)}`;
                    const href = dm?.libraryId ? `/documents/${dm.libraryId}?doc=${r.resourceId}`
                      : xm?.href ?? null;
                    const filePath = dm ? docFile.get(r.resourceId) : undefined;
                    return (
                      <div key={r.id} className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-white">
                        {filePath ? (
                          <DocHoverPreview documentId={r.resourceId} filePath={filePath} label={resourceLabel}>
                            <DocThumb filePath={filePath} width={36} className="mt-0.5" />
                          </DocHoverPreview>
                        ) : (
                          <div className={`shrink-0 w-7 h-7 rounded-md border flex items-center justify-center ${tone}`}>
                            <Icon className="w-3.5 h-3.5" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0 text-xs leading-relaxed">
                          <span className="font-bold text-slate-900">{r.userEmail?.split("@")[0] ?? "Someone"}</span>
                          {" "}<span className="text-slate-600">{verb}</span>{" "}
                          {href ? (
                            <Link href={href} className="font-bold text-slate-900 hover:text-blue-700 underline-offset-2 hover:underline">
                              {resourceLabel}
                            </Link>
                          ) : (
                            <span className="font-bold text-slate-700">{resourceLabel}</span>
                          )}
                          <span className="text-slate-400 ml-1">· {new Date(r.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {rows.length >= limit && (
              <div className="text-center">
                <button
                  onClick={() => setLimit((n) => n + 200)}
                  className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-xs font-bold text-slate-700"
                >
                  Load 200 more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
