// lib/markupRequests.ts
// Public "can I see your markups" request channel between users.
//
// The whole point: when Alice has P-101 checked out and is marking it up,
// Bob can request to see her current markups WITHOUT disrupting her
// checkout. The request + response are public on the project feed so the
// whole team can follow the collaboration.

import { supabase } from "@/lib/supabase";
import { writeActivity } from "@/lib/projects";
import { logAuditAction } from "@/lib/audit";
import type { MarkupRequest, MarkupRequestStatus } from "@/types/schema";

export function rowToMarkupRequest(r: Record<string, unknown>): MarkupRequest {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    projectId: r.project_id as string | undefined,
    documentId: r.document_id as string,
    checkoutSessionId: r.checkout_session_id as string | undefined,
    requestedByUserId: r.requested_by_user_id as string,
    requestedByName: r.requested_by_name as string | undefined,
    requestedFromUserId: r.requested_from_user_id as string,
    requestedFromName: r.requested_from_name as string | undefined,
    status: r.status as MarkupRequestStatus,
    message: r.message as string | undefined,
    response: r.response as string | undefined,
    sharedMarkupUrl: r.shared_markup_url as string | undefined,
    createdAt: r.created_at as any,
    resolvedAt: r.resolved_at as any,
  };
}

export type CreateMarkupRequestInput = {
  orgId: string;
  documentId: string;
  checkoutSessionId?: string;
  projectId?: string;
  requestedFromUserId: string;
  requestedFromName?: string;
  message: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function createMarkupRequest(input: CreateMarkupRequestInput): Promise<MarkupRequest> {
  if (!input.message.trim()) throw new Error("Message is required");
  const { data, error } = await supabase
    .from("markup_requests")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId || null,
      document_id: input.documentId,
      checkout_session_id: input.checkoutSessionId || null,
      requested_by_user_id: input.actorUserId,
      requested_by_name: input.actorEmail || input.actorUserId,
      requested_from_user_id: input.requestedFromUserId,
      requested_from_name: input.requestedFromName || null,
      status: "open",
      message: input.message.trim(),
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Failed to create markup request");

  // Post to project feed if applicable so the request is visible publicly.
  if (input.projectId) {
    await writeActivity({
      projectId: input.projectId,
      orgId: input.orgId,
      userId: input.actorUserId,
      userName: input.actorEmail,
      type: "markup_requested",
      body: input.message.trim(),
      metadata: {
        markupRequestId: data.id,
        documentId: input.documentId,
        requestedFromUserId: input.requestedFromUserId,
        requestedFromName: input.requestedFromName,
      },
    });
  }

  await logAuditAction({
    action: "MARKUP_REQUESTED",
    resourceId: input.documentId,
    resourceType: "document",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: {
      markupRequestId: data.id,
      requestedFromUserId: input.requestedFromUserId,
      projectId: input.projectId,
      message: input.message,
    },
  });

  return rowToMarkupRequest(data as Record<string, unknown>);
}

export type ResolveMarkupRequestInput = {
  markupRequestId: string;
  status: Extract<MarkupRequestStatus, "shared" | "declined" | "cancelled">;
  response?: string;
  sharedMarkupUrl?: string;
  orgId: string;
  projectId?: string;
  actorUserId: string;
  actorEmail?: string;
  actorRole?: string;
};

export async function resolveMarkupRequest(input: ResolveMarkupRequestInput): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("markup_requests")
    .update({
      status: input.status,
      response: input.response?.trim() || null,
      shared_markup_url: input.sharedMarkupUrl || null,
      resolved_at: now,
    })
    .eq("id", input.markupRequestId);
  if (error) throw new Error(error.message);

  if (input.projectId) {
    await writeActivity({
      projectId: input.projectId,
      orgId: input.orgId,
      userId: input.actorUserId,
      userName: input.actorEmail,
      type: input.status === "shared" ? "markup_shared" : "markup_requested",
      body: input.status === "shared"
        ? `Shared markups${input.response ? `: ${input.response}` : ""}`
        : input.status === "declined"
          ? `Declined the markup request${input.response ? `: ${input.response}` : ""}`
          : "Cancelled the markup request",
      metadata: { markupRequestId: input.markupRequestId, status: input.status },
    });
  }

  await logAuditAction({
    action: `MARKUP_${input.status.toUpperCase()}`,
    resourceId: input.markupRequestId,
    resourceType: "markup_request",
    orgId: input.orgId,
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    userRole: input.actorRole,
    details: { response: input.response, sharedMarkupUrl: input.sharedMarkupUrl },
  });
}

/** Requests currently waiting on the given user to respond. */
export async function listOpenRequestsTo(userId: string): Promise<MarkupRequest[]> {
  const { data } = await supabase
    .from("markup_requests")
    .select("*")
    .eq("requested_from_user_id", userId)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => rowToMarkupRequest(r as Record<string, unknown>));
}

/** Every open request that targets a specific document. */
export async function listOpenRequestsForDocument(documentId: string): Promise<MarkupRequest[]> {
  const { data } = await supabase
    .from("markup_requests")
    .select("*")
    .eq("document_id", documentId)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => rowToMarkupRequest(r as Record<string, unknown>));
}
