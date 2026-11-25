"use client";

// /activity: the workspace's activity, for people.
//
// Different from /admin/audit (a power-user log with raw detail blocks).
// This is "what's been happening lately?": a timeline grouped by day, each
// change in plain words (what was done to which item, when, who as a small
// avatar), linked to the item. A forced release, a hold or a missed
// milestone gets a red dot.
//
// Reads the same audit_logs table (the back-end is shared) but renders
// for humans, not auditors.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroQuiet } from "@/components/ui/PageHero";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { sheet, rowBtn, link, FactLine } from "@/components/cockpit/ui";
import Timeline, { type TimelineItem } from "@/components/ui/Timeline";

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

// What each recorded action reads as, and whether it is bad news (a forced
// release, a hold, a missed or blocked milestone gets a red edge).
const ACTION_VERBS: Record<string, { verb: string; bad?: boolean }> = {
  CHECK_OUT:           { verb: "checked out" },
  CHECK_IN:            { verb: "checked in" },
  ABANDON:             { verb: "abandoned the checkout on" },
  FORCE_RELEASE:       { verb: "force-released the lock on", bad: true },
  VIEW:                { verb: "viewed" },
  DOWNLOAD:            { verb: "downloaded" },
  REV_UP:              { verb: "published a new revision of" },
  REV_BACKFILL:        { verb: "backfilled a revision of" },
  SUPERSEDE_DOC:       { verb: "superseded" },
  ARCHIVE_DOC:         { verb: "archived" },
  DOC_SPLIT:           { verb: "split" },
  DOC_MERGED:          { verb: "merged" },
  DOC_RENUMBERED:      { verb: "renumbered" },
  HOLD_OPENED:         { verb: "opened a hold on", bad: true },
  HOLD_RELEASED:       { verb: "released the hold on" },
  MILESTONE_CREATED:   { verb: "added a milestone to" },
  MILESTONE_COMPLETED: { verb: "completed a milestone for" },
  MILESTONE_MISSED:    { verb: "missed a milestone for", bad: true },
  MILESTONE_BLOCKED:   { verb: "blocked a milestone for", bad: true },
  EQUIPMENT_STATE_CHANGED: { verb: "changed the equipment state of" },
  NOTE_CREATED:        { verb: "added a note to" },
  NOTE_DELETED:        { verb: "deleted a note from" },
  PROJECT_CREATED:     { verb: "created project" },
  MARKUP_REQUESTED:    { verb: "requested markups on" },
  DATA_EXPORT:         { verb: "exported data from" },
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
  const [error, setError] = useState<unknown>(null);
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
    } catch (e) { setError(e ?? "error"); }
    finally { setLoading(false); }
  }, [activeOrgId, limit]);

  useEffect(() => { void refresh(); }, [refresh]);

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

  const answer = loading && rows.length === 0 ? "Activity"
    : rows.length === 0 ? (error ? "The activity didn't load." : "Nothing has happened yet.")
      : pulse.today === 0 ? "Quiet today." : `${pulse.today} ${pulse.today === 1 ? "change" : "changes"} today.`;

  return (
    <PageShell width="work">
        <PageHero
          kicker="History · Activity"
          title={answer}
          // The title says today's count; the rest is one quiet line under
          // it (zeros left out), not a second row of large numbers.
          sub={rows.length > 0
            ? <>The last {rows.length.toLocaleString()} changes, by {pulse.actors} {pulse.actors === 1 ? "person" : "people"}, newest first.
                <FactLine className="mt-2" facts={[
                  { label: "Revisions", value: pulse.revisions },
                  { label: "Checkouts", value: pulse.locks },
                ]} /></>
            : "What happened in the workspace, in plain words."}
          tools={
            <button type="button" className={heroQuiet} onClick={refresh} disabled={loading} aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? "motion-safe:animate-spin" : ""}`} /><span className="max-sm:hidden">Refresh</span>
            </button>
          }
        >
          <ViewTabs tabs={ACTIVITY_VIEWS} variant="dark" />
        </PageHero>

        <PageBody>
        {!!error && <ErrorNote error={error} title="The activity didn't load." onRetry={() => void refresh()} />}
        {loading && rows.length === 0 ? (
          <SkeletonRows rows={6} cols={2} what="activity" />
        ) : rows.length === 0 ? (
          error ? null : (
            <p className={`${sheet} px-4 py-4 text-reading text-[var(--color-text-muted)]`}>
              Changes to documents, requests and projects show here as people make them.{" "}
              <Link href="/documents" className={`font-medium ${link}`}>Open documents</Link>
            </p>
          )
        ) : (
          <>
            {/* A history reads as a timeline: grouped by day, newest first,
                a dot and the words for what happened (red for bad news),
                who as a small avatar, and the document's own first page
                where it has one. */}
            <div className={`${sheet} px-4 py-4 sm:px-5`}>
              <Timeline items={rows.map((r): TimelineItem => {
                const meta = ACTION_VERBS[r.action];
                const verb = meta?.verb ?? r.action.toLowerCase().replace(/_/g, " ");
                const dm = r.resourceType === "document" ? docMeta.get(r.resourceId) : undefined;
                const xm = !dm ? extraMeta.get(`${r.resourceType}:${r.resourceId}`) : undefined;
                const number = dm?.documentNumber ?? null;
                const name = dm ? (dm.title && dm.title !== number ? dm.title : null) : null;
                const resourceLabel = dm ? (number ?? dm.title ?? r.resourceId.slice(0, 8))
                  : xm ? xm.label
                  : `${RESOURCE_LABEL[r.resourceType] || r.resourceType} ${r.resourceId.slice(0, 8)}`;
                const href = dm?.libraryId ? `/documents/${dm.libraryId}?doc=${r.resourceId}` : xm?.href ?? null;
                const filePath = dm ? docFile.get(r.resourceId) : undefined;
                return {
                  id: r.id,
                  at: r.timestamp,
                  kind: verb.charAt(0).toUpperCase() + verb.slice(1),
                  tone: meta?.bad ? "bad" : "muted",
                  title: (
                    <>
                      {filePath && (
                        <span className="inline-flex align-middle mr-2">
                          <DocHoverPreview documentId={r.resourceId} filePath={filePath} label={resourceLabel}>
                            <DocThumb filePath={filePath} width={28} />
                          </DocHoverPreview>
                        </span>
                      )}
                      {href
                        ? <Link href={href} className="ui-id">{resourceLabel}</Link>
                        : <span className="ui-id">{resourceLabel}</span>}
                    </>
                  ),
                  detail: name ?? undefined,
                  who: r.userEmail ? { email: r.userEmail, name: r.userEmail.split("@")[0] } : null,
                };
              })} />
            </div>

            {rows.length >= limit && (
              <div>
                <button type="button" onClick={() => setLimit((n) => n + 200)} className={rowBtn}>
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
