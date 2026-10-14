import { supabase } from "@/lib/supabase";

export interface AuditEntry {
  action: string;
  resourceId: string;
  resourceType: string;
  orgId?: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** The STORED row's time, for readers that build an AuditEntry from a row
   *  (HistoryDrawer, InspectorPanel). It is never the writer's: logAuditAction
   *  does not send it (the insert below names no timestamp), so the database
   *  clocks every row — DEFAULT now(), and for a signed-in caller's own row
   *  20261201's audit_logs_stamp_identity (admin-and-org ALOG-7). A value a
   *  writer puts here is not written. The exported signature is kept
   *  (logAuditAction(entry: AuditEntry), the P7 brief: every writer unchanged). */
  timestamp?: string;
  /** admin-and-org ALOG-7 (P13): the STORED row's audit_logs.actor_kind
   *  (20261201: member / server / system; null on a row written before that
   *  paste), for the readers that build an AuditEntry from a row
   *  (HistoryDrawer, InspectorPanel) and label whose word the identity is
   *  (lib/auditActions.ts auditActorNote). Never written: the database sets
   *  it, and logAuditAction's insert names no actor_kind. */
  actorKind?: string | null;
}

/** The stand-ins call sites pass when there is no member to name (a cron
 *  pass, a signed-out page): never a uid, so never sent into the UUID column. */
const AUDIT_ACTOR_SENTINELS: ReadonlySet<string> = new Set(["", "unknown", "system"]);

/** Writes one audit row. Never throws; the result says whether the row
 *  landed — supabase-js reports a refused insert (policy, transport) in the
 *  returned `error`, not by throwing, so a caller that must know (a
 *  force-release, DCK-5) reads `error` instead of assuming.
 *
 *  drafting-flow EVID-6 / PERS-7 (DF-P1): `ok` says the same thing as a
 *  boolean, and the failure is logged with the action it lost. A userId that
 *  is one of the "" / "unknown" / "system" sentinels system paths and a
 *  signed-out page pass is never sent into the UUID column (a 22P02 the
 *  caller never saw): the row is written with user_id NULL and the actor
 *  recorded as system in its metadata. Under the service role (the cron,
 *  the routes) that row lands; under a browser session the insert policy
 *  (user_id = auth.uid()) refuses it, and the refusal is returned, not
 *  swallowed. */
export async function logAuditAction(entry: AuditEntry): Promise<{ error: string | null; ok: boolean }> {
  try {
    // ALOG-10 (admin-and-org P7): a row with no workspace is readable by no
    // signed-in reader (every SELECT policy and both viewers read org_id), so
    // it is refused here rather than written — 20261202 makes the database
    // refuse it too. The refusal is returned and logged, never thrown.
    const orgId = typeof entry.orgId === "string" ? entry.orgId.trim() : "";
    if (!orgId) {
      const msg = `no workspace named — the ${entry.action} audit row was not written (an audit row must name its workspace)`;
      console.error(`Failed to write audit log (${entry.action}):`, msg);
      return { error: msg, ok: false };
    }
    const raw = typeof entry.userId === "string" ? entry.userId.trim() : "";
    const uid = AUDIT_ACTOR_SENTINELS.has(raw.toLowerCase()) ? null : raw;
    const metadata = uid === null
      ? { ...(entry.metadata ?? {}), actor_kind: "system", ...(entry.userId ? { actor_label: String(entry.userId) } : {}) }
      : (entry.metadata || null);
    const { error } = await supabase.from("audit_logs").insert({
      action: entry.action,
      resource_id: entry.resourceId,
      resource_type: entry.resourceType,
      org_id: orgId,
      user_id: uid,
      user_email: entry.userEmail || null,
      user_role: entry.userRole || null,
      details: entry.details || null,
      metadata,
    });
    if (error) {
      console.error(`Failed to write audit log (${entry.action}):`, error.message);
      return { error: error.message || "audit insert refused", ok: false };
    }
    return { error: null, ok: true };
  } catch (error) {
    console.error(`Failed to write audit log (${entry?.action}):`, error);
    return { error: (error as Error)?.message ?? String(error), ok: false };
  }
}

export async function logFileView(params: {
  orgId: string;
  fileId: string;
  fileName: string;
  userId: string;
  userEmail: string;
  userRole: string;
}) {
  return logAuditAction({
    action: "VIEW",
    resourceId: params.fileId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { fileName: params.fileName },
  });
}

export async function logFileDownload(params: {
  orgId: string;
  fileId: string;
  fileName: string;
  userId: string;
  userEmail: string;
  userRole: string;
  version?: string;
}) {
  return logAuditAction({
    action: "DOWNLOAD",
    resourceId: params.fileId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { fileName: params.fileName, version: params.version },
  });
}

/** The workspace self-heal moved someone to a different org than the one
 *  their device/profile pointed at (audit finding ORGSEL-4). org_id MUST be
 *  the DESTINATION org — the user is an active member there, so the insert
 *  passes RLS; the stale origin org may no longer admit them, so it rides in
 *  details instead. */
export async function logWorkspaceRelocation(params: {
  toOrgId: string;
  fromOrgId: string | null;
  candidateCount: number;
  userId: string;
  userEmail?: string;
  userRole?: string;
}) {
  return logAuditAction({
    action: "WORKSPACE_SELF_HEAL",
    resourceId: params.toOrgId,
    resourceType: "org",
    orgId: params.toOrgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { fromOrgId: params.fromOrgId, candidateCount: params.candidateCount },
  });
}

export async function logCheckoutEvent(params: {
  orgId: string;
  fileId: string;
  userId: string;
  userEmail: string;
  userRole: string;
  type: "CHECK_OUT" | "CHECK_IN" | "ABANDON" | "FORCE_RELEASE" | "JOIN";
  details?: Record<string, unknown>;
}) {
  return logAuditAction({
    action: params.type,
    resourceId: params.fileId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: params.details,
  });
}

export async function logMilestoneEvent(params: {
  orgId: string;
  milestoneId: string;
  /** Resource the milestone is anchored to. Use 'document' when the
   *  milestone has a document_id, 'project' when only a project_id
   *  is set, or 'milestone' for ad-hoc/org-level. */
  resourceType: "document" | "project" | "milestone";
  resourceId: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  type:
    | "MILESTONE_CREATED"
    | "MILESTONE_UPDATED"
    | "MILESTONE_COMPLETED"
    | "MILESTONE_MISSED"
    | "MILESTONE_BLOCKED"
    | "MILESTONE_DELETED";
  name: string;
  details?: Record<string, unknown>;
}) {
  return logAuditAction({
    action: params.type,
    resourceId: params.resourceId,
    resourceType: params.resourceType,
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { ...(params.details ?? {}), milestoneId: params.milestoneId, name: params.name },
  });
}

export async function logHoldEvent(params: {
  orgId: string;
  documentId: string;
  holdId: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  type: "HOLD_OPENED" | "HOLD_RELEASED";
  reason: string;
  details?: Record<string, unknown>;
}) {
  return logAuditAction({
    action: params.type,
    resourceId: params.documentId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { ...(params.details ?? {}), holdId: params.holdId, reason: params.reason },
  });
}

export async function logRevisionEvent(params: {
  orgId: string;
  documentId: string;
  versionId: string;
  userId: string;
  userEmail: string;
  userRole: string;
  type: "REV_UP" | "REV_BRANCH" | "SUPERSEDE_DOC" | "REVERT" | "ARCHIVE_DOC" | "REV_BACKFILL"
      | "DOC_SPLIT" | "CREATED_FROM_SPLIT"
      | "DOC_MERGED" | "CREATED_FROM_MERGE"
      | "DOC_RENUMBERED" | "SET_REV_UP"
      | "DOC_SPLIT_REVERSED" | "DOC_MERGE_REVERSED" | "DOC_RENUMBER_REVERSED"
      | "EQUIPMENT_STATE_CHANGED" | "SUBMIT_FOR_REVIEW" | "REV_LABEL_CORRECTED"
      | "DISTRIBUTION_RECALL";
  details?: Record<string, unknown>;
}) {
  return logAuditAction({
    action: params.type,
    resourceId: params.documentId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: { ...(params.details ?? {}), versionId: params.versionId },
  });
}
