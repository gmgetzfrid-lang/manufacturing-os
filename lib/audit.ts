import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface AuditEntry {
  action: string;
  resourceId: string;
  resourceType: string;
  orgId?: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  details?: any;
  metadata?: any;
  timestamp?: any;
}

/**
 * Logs a system event to the 'audit_logs' collection.
 * This provides a separate, immutable record of critical actions for compliance.
 */
export async function logAuditAction(entry: AuditEntry) {
  try {
    // Sanitize undefined -> null for Firestore
    const safeEntry = JSON.parse(JSON.stringify(entry, (k, v) => (v === undefined ? null : v)));

    await addDoc(collection(db, "audit_logs"), {
      ...safeEntry,
      timestamp: serverTimestamp(),
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
    details: { fileName: params.fileName }
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
    details: { fileName: params.fileName, version: params.version }
  });
}

export async function logCheckoutEvent(params: {
  orgId: string;
  fileId: string;
  userId: string;
  userEmail: string;
  userRole: string;
  type: "CHECK_OUT" | "CHECK_IN" | "ABANDON" | "FORCE_RELEASE" | "JOIN";
  details?: any;
}) {
  return logAuditAction({
    action: params.type,
    resourceId: params.fileId,
    resourceType: "document",
    orgId: params.orgId,
    userId: params.userId,
    userEmail: params.userEmail,
    userRole: params.userRole,
    details: params.details
  });
}
