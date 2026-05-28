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

export type TimelineEventKind = "audit" | "version" | "project_activity";

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

/** Unified per-document timeline. Pulls audit_logs (excluding the actions
 *  that double-count with version rows) and document_versions for the
 *  given document, merges, sorts newest-first. */
export async function getDocumentTimeline(params: DocumentTimelineParams): Promise<TimelineEvent[]> {
  const { documentId, limit = 100 } = params;

  const [auditResult, versionResult] = await Promise.all([
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
  ]);

  if (auditResult.error) throw new Error(auditResult.error.message);
  if (versionResult.error) throw new Error(versionResult.error.message);

  const events: TimelineEvent[] = [
    ...((auditResult.data as AuditRow[]) ?? []).map(auditRowToEvent),
    ...((versionResult.data as VersionRow[]) ?? []).map(versionRowToEvent),
  ];

  events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return events;
}

export interface ProjectTimelineParams {
  projectId: string;
  limit?: number;
}

/** Per-project timeline. Reads project_activity directly. The
 *  document-scoped audit events that touched docs *via* the project
 *  are not joined in — that requires a follow-up indexing pass we
 *  haven't done yet. Surface what project_activity captures. */
export async function getProjectTimeline(params: ProjectTimelineParams): Promise<TimelineEvent[]> {
  const { projectId, limit = 100 } = params;
  const { data, error } = await supabase
    .from("project_activity")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return ((data as ProjectActivityRow[]) ?? []).map(projectActivityRowToEvent);
}
