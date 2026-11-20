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
import { Activity, RefreshCw, AlertTriangle, FileText, Briefcase, Lock, Unlock, AlertOctagon, GitBranch, Zap, Pencil, Trash2, FileSignature, Layers, Download } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroQuiet } from "@/components/ui/PageHero";
import LoadingBlock from "@/components/ui/LoadingBlock";
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
  DOC_RENUMBERED:      { verb: "renumbered", icon: Pencil, tone: "slate" },
  HOLD_OPENED:         { verb: "opened a hold on", icon: AlertOctagon, tone: "rose" },
  HOLD_RELEASED:       { verb: "released the hold on", icon: Unlock, tone: "emerald" },
  MILESTONE_CREATED:   { verb: "added a milestone to", icon: Zap, tone: "slate" },
  MILESTONE_COMPLETED: { verb: "completed a milestone for", icon: Zap, tone: "emerald" },
  MILESTONE_MISSED:    { verb: "missed a milestone for", icon: AlertOctagon, tone: "amber" },
  MILESTONE_BLOCKED:   { verb: "blocked a milestone for", icon: AlertOctagon, tone: "rose" },
  EQUIPMENT_STATE_CHANGED: { verb: "changed the equipment state of", icon: Layers, tone: "slate" },
  NOTE_CREATED:        { verb: "added a note to", icon: Pencil, tone: "slate" },
  NOTE_DELETED:        { verb: "deleted a note from", icon: Trash2, tone: "slate" },
  PROJECT_CREATED:     { verb: "created project", icon: Briefcase, tone: "indigo" },
  MARKUP_REQUESTED:    { verb: "requested markups on", icon: FileSignature, tone: "violet" },
  DATA_EXPORT:         { verb: "exported data from", icon: Download, tone: "sky" },
};
const TONE_BG: Record<string, string> = {
  slate: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",
  indigo: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  blue: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  violet: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  fuchsia: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
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
      else if (["CHECK_OUT", "CHECK_IN", "ABANDON", "FORCE_RELEASE", "DOCUMENT_CHECKOUT", "DOCUMENT_CHECKIN"].includes(r.action)) cat.locks++;
      else if (["HOLD_OPENED", "HOLD_RELEASED"].includes(r.action)) cat.holds++;
      else if (r.action.startsWith("MILESTONE_")) cat.milestones++;
      else if (r.action === "EQUIPMENT_STATE_CHANGED") cat.equipment++;
    }
    return { today, actors: actors.size, ...cat };
  }, [rows]);

  // The pulse, said in words: what kinds of change happened in the window.
  const kinds = ([
    [pulse.revisions, "revision", "revisions"],
    [pulse.locks, "checkout", "checkouts"],
    [pulse.holds, "hold", "holds"],
    [pulse.milestones, "milestone update", "milestone updates"],
    [pulse.equipment, "equipment change", "equipment changes"],
  ] as Array<[number, string, string]>).filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const answer = loading && rows.length === 0 ? "Activity"
    : rows.length === 0 ? (error ? "The activity didn't load." : "Nothing has happened yet.")
      : pulse.today === 0 ? "Quiet today." : `${pulse.today} ${pulse.today === 1 ? "change" : "changes"} today.`;

  return (
    <PageShell width="work">
        <PageHero
          kicker="History · Activity"
          title={answer}
          sub={
            <>
              {rows.length > 0
                ? <>{rows.length.toLocaleString()} loaded, {pulse.actors} {pulse.actors === 1 ? "person" : "people"} active{kinds.length ? `: ${kinds.join(", ")}` : ""}. </>
                : null}
              What happened in the workspace, in plain words. The Audit log has the raw detail.
              {error && <span role="alert" className="block mt-1 text-rose-200 font-semibold"><AlertTriangle className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />{error}</span>}
            </>
          }
          tools={
            <button type="button" className={heroQuiet} onClick={refresh} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /><span className="max-sm:hidden">Refresh</span>
            </button>
          }
        >
          <ViewTabs tabs={ACTIVITY_VIEWS} variant="dark" />
        </PageHero>

        <PageBody>
        {loading && rows.length === 0 ? (
          <Card><LoadingBlock what="activity" rows={6} className="border-0 p-0" /></Card>
        ) : rows.length === 0 ? (
          <Card><p className="py-8 text-center text-[14px] text-[var(--color-text-muted)]">No activity recorded yet.</p></Card>
        ) : (
          <>
            {grouped.map((group) => (
              <Card key={group.day} label={group.day}>
                <div className="divide-y divide-[var(--color-border)] -mx-4 sm:-mx-5 border-t border-[var(--color-border)]">
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
                      <div key={r.id} className="flex items-start gap-3 px-4 sm:px-5 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
                        {filePath ? (
                          <DocHoverPreview documentId={r.resourceId} filePath={filePath} label={resourceLabel}>
                            <DocThumb filePath={filePath} width={36} className="mt-0.5" />
                          </DocHoverPreview>
                        ) : (
                          <div className={`shrink-0 w-8 h-8 rounded-[9px] flex items-center justify-center ${tone.replace(/border-\S+/g, "")}`}>
                            <Icon className="w-3.5 h-3.5" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0 text-[13.5px] leading-relaxed pt-1">
                          <span className="font-bold text-[var(--color-text)]">{r.userEmail?.split("@")[0] ?? "Someone"}</span>
                          {" "}<span className="text-[var(--color-text-muted)]">{verb}</span>{" "}
                          {href ? (
                            <Link href={href} className="font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] underline-offset-2 hover:underline transition-colors">
                              {resourceLabel}
                            </Link>
                          ) : (
                            <span className="font-bold text-[var(--color-text)]">{resourceLabel}</span>
                          )}
                          <span className="text-[var(--color-text-muted)] ml-1">· {new Date(r.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}

            {rows.length >= limit && (
              <div className="px-1">
                <button type="button" onClick={() => setLimit((n) => n + 200)} className="text-[13px] font-bold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
                  Show 200 more
                </button>
              </div>
            )}
          </>
        )}
        </PageBody>
    </PageShell>
  );
}
