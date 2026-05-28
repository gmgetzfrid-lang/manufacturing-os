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
  timestamp?: string;
}

export async function logAuditAction(entry: AuditEntry) {
  try {
    await supabase.from("audit_logs").insert({
      action: entry.action,
      resource_id: entry.resourceId,
      resource_type: entry.resourceType,
      org_id: entry.orgId || null,
      user_id: entry.userId,
      user_email: entry.userEmail || null,
      user_role: entry.userRole || null,
      details: entry.details || null,
      metadata: entry.metadata || null,
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
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
  type: "REV_UP" | "SUPERSEDE_DOC" | "REVERT" | "ARCHIVE_DOC" | "REV_BACKFILL";
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
