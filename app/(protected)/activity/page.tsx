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
//
// admin-and-org ALOG-5 (P7): the page states its authority rule — only what
// the database enforces today. The org-level authority trail is readable
// only by holders of the admin.audit_view capability (the Audit log
// permission): rows typed org / member / team / capability_policy /
// org_configuration / export_destination, and CAPABILITY_ / MEMBER_ / ROLE_ /
// EXPORT_ / SECURITY_ / TEAM_ / DATA_EXPORT / RESTORE_ / PURGE_ actions
// (audit_logs_admin_trail, 20261063 — DEC-17, SURF-9, ROLE-5).
// admin-and-org ALOG-16 (P13, 20261219): permission (NODE_ACL_CHANGED),
// ownership (OWNER_ASSIGNED / OWNER_CLEARED / OWNER_TEAM_*) and
// recertification (ACCESS_RECERTIFIED) changes made on a library, folder or
// document are readable only by Audit log holders and by those who may
// manage that node (audit_row_node_manageable: its controllers, its effective
// owner, a Manage Permissions / admin grant on it); every member reads the
// rest of the document-level history. Stated from the deploy because the
// P13 deploy is HARD-GATED on the paste (20261142, then 20261219, pasted
// before this app is deployed — 20261219's header and MIGRATION-PASTE-ORDER),
// and a later 20261157 paste is followed by a 20261219 re-paste in the same
// SQL-editor window, so the sentence never runs ahead of the database (this
// header's "only what the database enforces" rule). Project scoping (SEC-20 / SEC-21: a project's rows only to those who
// can see it) lives in 20261142 and 20261157, neither confirmed pasted when
// P7 landed, so the page neither claims nor denies it; add it to the stated
// rule once MIGRATION-PASTE-ORDER.md marks both live. The DATABASE applies the rule
// (audit_logs_org_access plus the RESTRICTIVE overlay), so this page shows
// each reader only the rows they may read; it adds no gate of its own.
// drafting-flow EVID-12: a TICKET_<ACTION> attempt row is read together with
// the _NOT_APPLIED / _HOLDS_NOT_RELEASED row that names it (lib/auditActions.ts
// foldTicketFeed over pairTicketAttempts): the attempt line says the outcome
// and the follow-up line folds into it.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, RefreshCw, AlertTriangle, FileText, Briefcase, Lock, Unlock, AlertOctagon, GitBranch, Zap, Pencil, Trash2, FileSignature, Layers, Download } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import ViewTabs, { ACTIVITY_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { SCOPE_STAMP_ACTIONS, SCOPE_STAMPS_NOT_IN } from "@/lib/timeline";
import { foldTicketFeed, auditActorNote } from "@/lib/auditActions";

interface ActivityRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  userEmail: string | null;
  userRole: string | null;
  /** ALOG-7 (P13): audit_logs.actor_kind (20261201) — null before that paste. */
  actorKind: string | null;
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
  MILESTONE_CREATED:   { verb: "added a milestone to", icon: Zap, tone: "emerald" },
  MILESTONE_COMPLETED: { verb: "completed a milestone for", icon: Zap, tone: "emerald" },
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
  slate: "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]",
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
      // SEC-21: the database's scope stamp is left out IN the query, before
      // the row limit, so a window of `limit` rows holds `limit` events (the
      // memos below still skip it — the same set, re-applied).
      const { data, error: qErr } = await supabase.from("audit_logs")
        .select("*").eq("org_id", activeOrgId)
        .not("action", "in", SCOPE_STAMPS_NOT_IN)
        .order("timestamp", { ascending: false }).limit(limit);
      if (qErr) throw qErr;
      const list: ActivityRow[] = ((data || []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        action: String(r.action),
        resourceType: String(r.resource_type),
        resourceId: String(r.resource_id),
        userEmail: (r.user_email as string | null) ?? null,
        userRole: (r.user_role as string | null) ?? null,
        actorKind: (r.actor_kind as string | null | undefined) ?? null,
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
      if (SCOPE_STAMP_ACTIONS.has(r.action)) continue; // SEC-21: the database's stamp, not an event (its MILESTONE_DELETED row is)
      const day = new Date(r.timestamp).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const list = map.get(day) || [];
      list.push(r);
      map.set(day, list);
    }
    for (const [day, list] of map) out.push({ day, rows: list });
    return out;
  }, [rows]);

  const feed = useMemo(() => foldTicketFeed(rows, grouped), [rows, grouped]); // EVID-12

  // Top-of-feed "pulse" widget: at-a-glance counts so Activity reads like a
  // dashboard, not a raw log. Buckets the loaded window by category + today.
  const pulse = useMemo(() => {
    const todayStr = new Date().toDateString();
    let today = 0;
    const cat = { revisions: 0, locks: 0, holds: 0, milestones: 0, equipment: 0 };
    const actors = new Set<string>();
    for (const r of rows) {
      if (SCOPE_STAMP_ACTIONS.has(r.action)) continue; // SEC-21: one milestone delete counts once
      if (new Date(r.timestamp).toDateString() === todayStr) today++;
      if (r.userEmail) actors.add(r.userEmail);
      if (["REV_UP", "REV_BACKFILL", "SUPERSEDE_DOC", "DOC_SPLIT", "DOC_MERGED", "DOC_RENUMBERED"].includes(r.action)) cat.revisions++;
      else if (["CHECK_OUT", "CHECK_IN", "ABANDON", "FORCE_RELEASE", "DOCUMENT_CHECKOUT", "DOCUMENT_CHECKIN", "FIELD_VERIFIED", "CHECKOUT_RELEASED"].includes(r.action)) cat.locks++;
      else if (["HOLD_OPENED", "HOLD_RELEASED"].includes(r.action)) cat.holds++;
      else if (r.action.startsWith("MILESTONE_")) cat.milestones++;
      else if (r.action === "EQUIPMENT_STATE_CHANGED") cat.equipment++;
    }
    return { today, actors: actors.size, ...cat };
  }, [rows]);

  return (
    <PageShell width="work">
        <ViewTabs title="History" tabs={ACTIVITY_VIEWS} />
        <PageHeaderBar
          icon={Activity}
          title="Activity Feed"
          subtitle={<>What&apos;s been happening in the workspace, in plain language. For raw event detail, see the Audit Log.{" "}
            <span className="block mt-1 text-[11px] text-[var(--color-text-faint)]">
              Who can read this feed: workspace-level authority events (capability policy and workspace settings, members and roles, teams, export destinations and exports, security events, and workspace restores and purges) are shown only to people with the Audit log permission. Permission (access list), ownership and recertification changes made on a library, folder or document are shown only to people with the Audit log permission and to those who may manage that library, folder or document (its document controllers, its owner, and anyone granted Manage Permissions on it). Every member reads the rest of the workspace&apos;s document-level history. The database applies this rule, not this page.
            </span></>}
          actions={
            <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          }
        />

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Pulse widget — at-a-glance summary of the loaded window. */}
        {rows.length > 0 && (
          <div className="mb-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm p-4">
            <div className="text-sm font-bold text-[var(--color-text)] mb-3">
              {pulse.today} event{pulse.today === 1 ? "" : "s"} today
              <span className="text-[var(--color-text-faint)] font-medium"> · {rows.length} loaded · {pulse.actors} {pulse.actors === 1 ? "person" : "people"} active</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {([
                ["Revisions", pulse.revisions, GitBranch, "text-blue-600 bg-blue-50"],
                ["Checkouts", pulse.locks, Lock, "text-indigo-600 bg-indigo-50"],
                ["Holds", pulse.holds, AlertOctagon, "text-rose-600 bg-rose-50"],
                ["Milestones", pulse.milestones, Zap, "text-emerald-600 bg-emerald-50"],
                ["Equipment", pulse.equipment, Layers, "text-amber-600 bg-amber-50"],
              ] as const).map(([label, n, Icon, cls]) => (
                <div key={label} className="rounded-xl border border-[var(--color-border)] p-2.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center mb-1.5 ${cls}`}><Icon className="w-3.5 h-3.5" /></div>
                  <div className="text-lg font-black text-[var(--color-text)] leading-none">{n}</div>
                  <div className="text-[10px] font-bold text-[var(--color-text-faint)] uppercase tracking-wider mt-1">{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="py-16 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-12 text-center text-sm italic text-[var(--color-text-faint)]">No activity recorded yet.</div>
        ) : (
          <div className="space-y-6">
            {feed.groups.map((group) => (
              <div key={group.day}>
                <div className="sticky top-0 bg-[var(--color-canvas)]/80 backdrop-blur z-10 py-2 mb-2 text-xs font-black text-[var(--color-text-muted)] uppercase tracking-widest border-b border-[var(--color-border)]">
                  {group.day}
                </div>
                <div className="space-y-1.5">
                  {group.rows.map((r) => {
                    const meta = ACTION_VERBS[r.action];
                    const Icon = meta?.icon ?? Activity;
                    const tone = TONE_BG[meta?.tone ?? "slate"];
                    const verb = (meta?.verb ?? r.action.toLowerCase().replace(/_/g, " ")) + feed.verbSuffix(r.id);
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
                      <div key={r.id} className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-surface)] transition-colors">
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
                          <span className="font-bold text-[var(--color-text)]">{r.userEmail?.split("@")[0] ?? "Someone"}</span>
                          <span className={`ml-1 text-[10px] ${r.actorKind ? "text-[var(--color-text-faint)]" : "text-amber-700"}`} title="ALOG-7: whose word the name on this row is">({auditActorNote(r.actorKind)})</span>
                          {" "}<span className="text-[var(--color-text-muted)]">{verb}</span>{" "}
                          {href ? (
                            <Link href={href} className="font-bold text-[var(--color-text)] hover:text-[var(--color-accent)] underline-offset-2 hover:underline transition-colors">
                              {resourceLabel}
                            </Link>
                          ) : (
                            <span className="font-bold text-[var(--color-text)]">{resourceLabel}</span>
                          )}
                          <span className="text-[var(--color-text-faint)] ml-1">· {new Date(r.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {rows.length >= limit && (
              <div className="text-center">
                <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + 200)}>
                  Load 200 more
                </Button>
              </div>
            )}
          </div>
        )}
    </PageShell>
  );
}
