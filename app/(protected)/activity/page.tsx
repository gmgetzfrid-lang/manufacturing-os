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
          .from("documents").select("id, document_number, title, name, library_id")
          .in("id", docIds);
        const m = new Map<string, { documentNumber: string | null; title: string | null; libraryId: string }>();
        for (const d of (docs as Array<{ id: string; document_number: string | null; title: string | null; name: string | null; library_id: string }>) ?? []) {
          m.set(d.id, { documentNumber: d.document_number, title: d.title || d.name, libraryId: d.library_id });
        }
        setDocMeta(m);
      } else {
        setDocMeta(new Map());
      }
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

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-4xl mx-auto p-6">
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
                    const resourceLabel = dm
                      ? `${dm.documentNumber ?? ""}${dm.documentNumber ? " · " : ""}${dm.title ?? dm.documentNumber ?? r.resourceId.slice(0, 8)}`
                      : `${RESOURCE_LABEL[r.resourceType] || r.resourceType} ${r.resourceId.slice(0, 8)}`;
                    const href = dm?.libraryId ? `/documents/${dm.libraryId}?doc=${r.resourceId}`
                      : r.resourceType === "ticket" ? `/requests/${r.resourceId}`
                      : r.resourceType === "project" ? `/projects/${r.resourceId}`
                      : null;
                    return (
                      <div key={r.id} className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-white">
                        <div className={`shrink-0 w-7 h-7 rounded-md border flex items-center justify-center ${tone}`}>
                          <Icon className="w-3.5 h-3.5" />
                        </div>
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
