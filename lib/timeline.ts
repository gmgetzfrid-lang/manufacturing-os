// lib/timeline.ts
//
// Phase 3 — Operational Timelines & Audit Intelligence (read layer).
//
// The platform has historically scattered audit data across four
// tables:
//
//   - audit_logs           (free-form action/resource events)
//   - document_versions    (revision lifecycle — release, supersede)
//   - documents            (archive_at / superseded_at column flags)
//   - project_activity     (project-scoped events)
//
// Every screen that wants "what happened to this drawing" has had to
// invent its own join. This module is the single read seam. It does
// NOT add new audit producers, does NOT mutate any table, and does
// NOT change RLS. It just unifies reads.
//
// Phase 3+ UIs (per-document history drawer, per-project timeline,
// holds/release feed) all consume this. Phase 9 AI scratchpad
// "summarize what happened this week" calls this too.
//
// Return shape: every event has a stable, source-prefixed id
// ("audit:<uuid>" or "version:<uuid>") so a consumer can dedupe or
// link back to the source row. We intentionally do NOT dedupe
// REV_UP audit rows against their corresponding version rows — the
// audit row records the actor + reason, the version row records the
// file payload + signoffs. They're complementary, and a renderer can
// group by timestamp if it wants a single visual entry.

import { supabase } from "@/lib/supabase";

export type TimelineEventKind = "audit" | "version" | "project_activity" | "hold";

/** Scope context attached to events that originate from documents.
 *  Populated by getDocumentTimeline (single doc, single lookup) and
 *  by getProjectTimeline for events whose document is scope-tagged. */
export interface TimelineEventScope {
  plantId: string | null;
  plantName: string | null;
  unitId: string | null;
  unitName: string | null;
  systemId: string | null;
  systemName: string | null;
}

export interface TimelineEvent {
  /** Source-prefixed id: "audit:<uuid>" | "version:<uuid>" | "activity:<uuid>". */
  id: string;
  kind: TimelineEventKind;
  /** Canonical action string. For audit rows, the audit `action` column.
   *  For version rows, "VERSION_CREATED" (or "VERSION_REVERT" if
   *  reverted_from_version_id is set). For project_activity, the
   *  `type` column. */
  action: string;
  resourceType: string;
  resourceId: string;
  /** ISO 8601 string. Sort key. */
  timestamp: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  /** Short human-readable summary derived from the row. */
  summary: string;
  /** Full row details for the renderer. Shape varies by kind. */
  details: Record<string, unknown> | null;
  /** Plant/Unit/System context if the event ties to a scoped document.
   *  Null on project_activity events that don't carry a document ref. */
  scope?: TimelineEventScope | null;
}

interface AuditRow {
  id: string;
  action: string;
  resource_id: string;
  resource_type: string;
  org_id: string | null;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

interface VersionRow {
  id: string;
  org_id: string | null;
  record_id: string;
  revision_label: string;
  issue_type: string | null;
  change_type: string | null;
  change_log: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  released_at: string | null;
  superseded_at: string | null;
  moc_reference: string | null;
  supersedes_version_id: string | null;
  reverted_from_version_id: string | null;
  drawn_by_name: string | null;
  checked_by_name: string | null;
  approved_by_name: string | null;
  file_hash: string | null;
  source_file_name: string | null;
}

interface HoldRow {
  id: string;
  org_id: string;
  document_id: string;
  reason: string;
  notes: string | null;
  expected_release_at: string | null;
  opened_by: string;
  opened_by_name: string | null;
  opened_at: string;
  released_by: string | null;
  released_by_name: string | null;
  released_at: string | null;
  released_reason: string | null;
}

function holdRowsToEvents(rows: HoldRow[]): TimelineEvent[] {
  // Each hold row emits up to two events: one on open, one on
  // release. Audit events with action HOLD_OPENED/HOLD_RELEASED
  // also exist (fired by lib/holds.ts), but those carry the actor
  // metadata; the version emitted here carries the duration and
  // reason fields denormalized for the renderer.
  const out: TimelineEvent[] = [];
  for (const r of rows) {
    out.push({
      id: `hold-open:${r.id}`,
      kind: "hold",
      action: "HOLD_OPENED",
      resourceType: "document",
      resourceId: r.document_id,
      timestamp: r.opened_at,
      userId: r.opened_by,
      userName: r.opened_by_name,
      userEmail: null,
      summary: `Hold opened — ${r.reason}`,
      details: {
        holdId: r.id, reason: r.reason, notes: r.notes,
        expectedReleaseAt: r.expected_release_at,
      },
    });
    if (r.released_at) {
      const durationDays = Math.max(0, Math.round((new Date(r.released_at).getTime() - new Date(r.opened_at).getTime()) / 86400_000));
      out.push({
        id: `hold-release:${r.id}`,
        kind: "hold",
        action: "HOLD_RELEASED",
        resourceType: "document",
        resourceId: r.document_id,
        timestamp: r.released_at,
        userId: r.released_by,
        userName: r.released_by_name,
        userEmail: null,
        summary: `Hold released — ${r.reason} (${durationDays}d)`,
        details: {
          holdId: r.id, reason: r.reason,
          releasedReason: r.released_reason, durationDays,
        },
      });
    }
  }
  return out;
}

interface ProjectActivityRow {
  id: string;
  project_id: string;
  org_id: string;
  user_id: string | null;
  user_name: string | null;
  type: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function auditRowToEvent(r: AuditRow): TimelineEvent {
  const summary = summarizeAudit(r);
  return {
    id: `audit:${r.id}`,
    kind: "audit",
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    timestamp: r.timestamp,
    userId: r.user_id,
    userName: null,
    userEmail: r.user_email,
    summary,
    details: r.details,
  };
}

function versionRowToEvent(r: VersionRow): TimelineEvent {
  const isRevert = !!r.reverted_from_version_id;
  const action = isRevert ? "VERSION_REVERT" : "VERSION_CREATED";
  const summary = isRevert
    ? `Reverted to rev ${r.revision_label}`
    : `Rev ${r.revision_label} created${r.change_type ? ` (${r.change_type})` : ""}`;
  return {
    id: `version:${r.id}`,
    kind: "version",
    action,
    resourceType: "document",
    resourceId: r.record_id,
    // Prefer released_at if set (matches operational "when did this go out")
    timestamp: r.released_at || r.created_at,
    userId: r.created_by,
    userName: r.created_by_name,
    userEmail: null,
    summary,
    details: {
      versionId: r.id,
      revisionLabel: r.revision_label,
      changeType: r.change_type,
      issueType: r.issue_type,
      changeLog: r.change_log,
      mocReference: r.moc_reference,
      supersedesVersionId: r.supersedes_version_id,
      revertedFromVersionId: r.reverted_from_version_id,
      drawnBy: r.drawn_by_name,
      checkedBy: r.checked_by_name,
      approvedBy: r.approved_by_name,
      fileHash: r.file_hash,
      sourceFileName: r.source_file_name,
      supersededAt: r.superseded_at,
    },
  };
}

function projectActivityRowToEvent(r: ProjectActivityRow): TimelineEvent {
  return {
    id: `activity:${r.id}`,
    kind: "project_activity",
    action: r.type,
    resourceType: "project",
    resourceId: r.project_id,
    timestamp: r.created_at,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: null,
    summary: r.body || humanizeActivityType(r.type),
    details: r.metadata,
  };
}

/** Best-effort human summary for an audit row. Mirrors the action vocabulary
 *  used by lib/audit.ts so renderers don't reinvent strings. */
function summarizeAudit(r: AuditRow): string {
  const d = r.details || {};
  switch (r.action) {
    case "VIEW":         return `Viewed${d.fileName ? ` ${d.fileName}` : ""}`;
    case "DOWNLOAD":     return `Downloaded${d.fileName ? ` ${d.fileName}` : ""}`;
    case "CHECK_OUT":    return "Checked out";
    case "CHECK_IN":     return "Checked in";
    case "ABANDON":      return "Checkout abandoned";
    case "JOIN":         return "Joined collaborative session";
    case "FORCE_RELEASE":return "Checkout force-released";
    case "REV_UP":       return `Rev-up${d.newRev ? ` → ${d.newRev}` : ""}`;
    case "REVERT":       return `Reverted${d.revertedFromRev ? ` from ${d.revertedFromRev}` : ""}`;
    case "SUPERSEDE_DOC":return "Document superseded";
    case "ARCHIVE_DOC":  return d.action === "unarchive" ? "Restored from archive" : "Archived";
    default:             return r.action.replace(/_/g, " ").toLowerCase();
  }
}

function humanizeActivityType(t: string): string {
  return t.replace(/_/g, " ");
}

export interface DocumentTimelineParams {
  documentId: string;
  /** Maximum events to return per source. Default 100. */
  limit?: number;
}

/** Unified per-document timeline. Pulls audit_logs and document_versions
 *  for the given document, attaches Plant/Unit/System context from the
 *  document row itself (single denormalization read, no per-event join),
 *  merges, sorts newest-first. */
export async function getDocumentTimeline(params: DocumentTimelineParams): Promise<TimelineEvent[]> {
  const { documentId, limit = 100 } = params;

  const [auditResult, versionResult, holdResult, scope] = await Promise.all([
    supabase
      .from("audit_logs")
      .select("*")
      .eq("resource_type", "document")
      .eq("resource_id", documentId)
      .order("timestamp", { ascending: false })
      .limit(limit),
    supabase
      .from("document_versions")
      .select("*")
      .eq("record_id", documentId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("document_holds")
      .select("*")
      .eq("document_id", documentId)
      .order("opened_at", { ascending: false })
      .limit(limit),
    loadDocumentScope(documentId),
  ]);

  if (auditResult.error) throw new Error(auditResult.error.message);
  if (versionResult.error) throw new Error(versionResult.error.message);
  if (holdResult.error) throw new Error(holdResult.error.message);

  // Holds and the matching HOLD_OPENED / HOLD_RELEASED audit rows
  // describe the same fact pair. To avoid double-rendering, drop the
  // audit rows whose action is one of the hold-event kinds — the
  // hold rows themselves carry richer detail (duration, reason).
  const auditEvents = ((auditResult.data as AuditRow[]) ?? [])
    .filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED")
    .map(auditRowToEvent);

  const events: TimelineEvent[] = [
    ...auditEvents,
    ...((versionResult.data as VersionRow[]) ?? []).map(versionRowToEvent),
    ...holdRowsToEvents((holdResult.data as HoldRow[]) ?? []),
  ];

  // Apply the per-document scope to every event. Constant per call,
  // so this is a cheap fan-out, not a per-row join.
  if (scope) for (const e of events) e.scope = scope;

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return events;
}

/** Resolve plant/unit/system FKs on a document into their human names.
 *  Returns null if the document has no scope attached. One query for
 *  the document, one for each non-null scope FK. */
async function loadDocumentScope(documentId: string): Promise<TimelineEventScope | null> {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("plant_id, unit_id, system_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error || !doc) return null;
  const d = doc as { plant_id: string | null; unit_id: string | null; system_id: string | null };
  if (!d.plant_id && !d.unit_id && !d.system_id) return null;

  const [plant, unit, system] = await Promise.all([
    d.plant_id ? supabase.from("plants").select("id, name").eq("id", d.plant_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    d.unit_id ? supabase.from("units").select("id, name").eq("id", d.unit_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    d.system_id ? supabase.from("systems").select("id, name").eq("id", d.system_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);

  return {
    plantId: d.plant_id,
    plantName: (plant.data as { name?: string } | null)?.name ?? null,
    unitId: d.unit_id,
    unitName: (unit.data as { name?: string } | null)?.name ?? null,
    systemId: d.system_id,
    systemName: (system.data as { name?: string } | null)?.name ?? null,
  };
}

export interface ProjectTimelineParams {
  projectId: string;
  limit?: number;
}

/** Per-project timeline. Merges:
 *   - project_activity rows (the project's own event log)
 *   - audit_logs and document_versions for documents linked to the
 *     project via the Phase 1 project_documents join table
 *
 *  The directive's "linked scope visibility" requirement is what
 *  drives the cross-table pull — without it, a project timeline
 *  showed only manual activity entries and missed the actual
 *  document work the project produced. */
export async function getProjectTimeline(params: ProjectTimelineParams): Promise<TimelineEvent[]> {
  const { projectId, limit = 100 } = params;

  // 1. project_activity (manual + system events tied to the project)
  // 2. Resolve linked document IDs via project_documents
  const [activityResult, linkedDocsResult] = await Promise.all([
    supabase
      .from("project_activity")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("project_documents")
      .select("document_id")
      .eq("project_id", projectId),
  ]);
  if (activityResult.error) throw new Error(activityResult.error.message);
  if (linkedDocsResult.error) throw new Error(linkedDocsResult.error.message);

  const events: TimelineEvent[] = ((activityResult.data as ProjectActivityRow[]) ?? []).map(projectActivityRowToEvent);

  const linkedDocIds = ((linkedDocsResult.data as Array<{ document_id: string }>) ?? []).map((r) => r.document_id);
  if (linkedDocIds.length > 0) {
    // 3. Audit + version + hold events for the linked documents.
    // Each source capped to `limit` so a project with many docs
    // doesn't return 10,000 rows; the merged sort + final slice
    // still respects the overall limit.
    const [docAudit, docVersions, docHolds] = await Promise.all([
      supabase
        .from("audit_logs")
        .select("*")
        .eq("resource_type", "document")
        .in("resource_id", linkedDocIds)
        .order("timestamp", { ascending: false })
        .limit(limit),
      supabase
        .from("document_versions")
        .select("*")
        .in("record_id", linkedDocIds)
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("document_holds")
        .select("*")
        .in("document_id", linkedDocIds)
        .order("opened_at", { ascending: false })
        .limit(limit),
    ]);
    if (docAudit.error) throw new Error(docAudit.error.message);
    if (docVersions.error) throw new Error(docVersions.error.message);
    if (docHolds.error) throw new Error(docHolds.error.message);

    // Same dedup as getDocumentTimeline — drop the HOLD_* audit rows
    // since the holds themselves carry richer detail.
    const auditEvents = ((docAudit.data as AuditRow[]) ?? [])
      .filter((r) => r.action !== "HOLD_OPENED" && r.action !== "HOLD_RELEASED")
      .map(auditRowToEvent);

    events.push(
      ...auditEvents,
      ...((docVersions.data as VersionRow[]) ?? []).map(versionRowToEvent),
      ...holdRowsToEvents((docHolds.data as HoldRow[]) ?? []),
    );
  }

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return events.slice(0, limit);
}

// ─── Revision chain ───────────────────────────────────────────
//
// The "revision chain visualization" requirement asks for the
// supersedes lineage to be inspectable. document_versions already
// carries supersedes_version_id; this helper walks the chain in
// release order so a renderer can draw it as a connected list.

export interface RevisionChainNode {
  versionId: string;
  revisionLabel: string;
  releasedAt: string | null;
  createdAt: string;
  createdByName: string | null;
  changeType: string | null;
  changeLog: string | null;
  mocReference: string | null;
  supersedesVersionId: string | null;
  revertedFromVersionId: string | null;
  isCurrent: boolean;
}

export async function getRevisionChain(documentId: string): Promise<RevisionChainNode[]> {
  const [docResult, versionsResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, current_version_id")
      .eq("id", documentId)
      .maybeSingle(),
    supabase
      .from("document_versions")
      .select("id, revision_label, released_at, created_at, created_by_name, change_type, change_log, moc_reference, supersedes_version_id, reverted_from_version_id")
      .eq("record_id", documentId)
      .order("released_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true }),
  ]);
  if (docResult.error) throw new Error(docResult.error.message);
  if (versionsResult.error) throw new Error(versionsResult.error.message);

  const currentVersionId = (docResult.data as { current_version_id: string | null } | null)?.current_version_id ?? null;
  return ((versionsResult.data as Array<{
    id: string; revision_label: string; released_at: string | null; created_at: string;
    created_by_name: string | null; change_type: string | null; change_log: string | null;
    moc_reference: string | null; supersedes_version_id: string | null;
    reverted_from_version_id: string | null;
  }>) ?? []).map((r) => ({
    versionId: r.id,
    revisionLabel: r.revision_label,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    createdByName: r.created_by_name,
    changeType: r.change_type,
    changeLog: r.change_log,
    mocReference: r.moc_reference,
    supersedesVersionId: r.supersedes_version_id,
    revertedFromVersionId: r.reverted_from_version_id,
    isCurrent: r.id === currentVersionId,
  }));
}
