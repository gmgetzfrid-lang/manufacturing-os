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
import type { MarkupRequest, MarkupRequestStatus, Timestamp } from "@/types/schema";
import { postMarkupRef } from "@/lib/activityThread";
import { emit } from "@/lib/notify/dispatch";

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
    createdAt: r.created_at as Timestamp,
    resolvedAt: r.resolved_at as Timestamp,
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

  // PROD-14: the person asked hears about it — a bell row and an email,
  // whether or not the document is on a project (the feed entry above is
  // project-only). They answer it from /inbox ("Markup requests for you").
  // Best-effort: the request is already recorded.
  try {
    const who = input.actorEmail || "A colleague";
    await emit({
      orgId: input.orgId,
      category: "assignment",
      kind: "markup_request",
      title: `${who} asked for your markups`,
      body: input.message.trim(),
      link: "/inbox",
      resource: { type: "document", id: input.documentId },
      actorUserId: input.actorUserId,
      actorName: input.actorEmail || undefined,
      audience: { involved: [input.requestedFromUserId] },
      metadata: { markupRequestId: data.id, requestStatus: "open" },
    });
  } catch (e) { console.warn("[markupRequests] request notice failed (non-blocking)", e); }

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
  const { data: updated, error } = await supabase
    .from("markup_requests")
    .update({
      status: input.status,
      response: input.response?.trim() || null,
      shared_markup_url: input.sharedMarkupUrl || null,
      resolved_at: now,
    })
    .eq("id", input.markupRequestId)
    .select("document_id, requested_by_user_id, requested_from_user_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  // A refused update (RLS) returns no row — never report "shared" for it.
  if (!updated) throw new Error("The markup request could not be updated (not found or not permitted).");

  // LIFE-8: sharing leaves the `markup_ref` row ActivityThread already
  // renders, on the document the request was about — the artifact pointer
  // the UI can back. Best-effort: the resolution itself is already recorded.
  if (input.status === "shared" && (updated as { document_id?: string | null }).document_id) {
    try {
      await postMarkupRef({
        orgId: input.orgId,
        documentId: (updated as { document_id: string }).document_id,
        userId: input.actorUserId,
        userName: input.actorEmail?.split("@")[0] || "Member",
        markupRequestId: input.markupRequestId,
        summary: `Markups shared${input.response?.trim() ? `: ${input.response.trim()}` : ""}${input.sharedMarkupUrl ? ` — ${input.sharedMarkupUrl}` : ""}`,
        metadata: input.sharedMarkupUrl ? { shared_markup_url: input.sharedMarkupUrl } : null,
      });
    } catch (e) { console.warn("[markupRequests] markup_ref post failed (non-blocking)", e); }
  }

  // PROD-14 dw3: the other side of the request hears the answer — the
  // requester when the person asked shares or declines, the person asked
  // when the requester cancels (the actor is dropped by the dispatcher).
  // Best-effort: the resolution is already recorded.
  try {
    const row = updated as { document_id?: string | null; requested_by_user_id?: string | null; requested_from_user_id?: string | null };
    const who = input.actorEmail || "A colleague";
    const verb = input.status === "shared" ? "shared their markups" : input.status === "declined" ? "declined your markup request" : "cancelled their markup request";
    if (row.document_id) {
      // The answer opens the document (a share is noted on its activity
      // thread); without a readable library the row carries no link.
      const { data: doc } = await supabase.from("documents").select("library_id").eq("id", row.document_id).maybeSingle();
      const libraryId = (doc as { library_id?: string | null } | null)?.library_id ?? null;
      await emit({
        orgId: input.orgId,
        category: "status",
        kind: "markup_request",
        title: `${who} ${verb}`,
        body: input.response?.trim() || undefined,
        link: libraryId ? `/documents/${libraryId}?doc=${row.document_id}` : undefined,
        resource: { type: "document", id: row.document_id },
        actorUserId: input.actorUserId,
        actorName: input.actorEmail || undefined,
        audience: { involved: [row.requested_by_user_id, row.requested_from_user_id].filter((u): u is string => !!u) },
        metadata: { markupRequestId: input.markupRequestId, requestStatus: input.status },
      });
    }
  } catch (e) { console.warn("[markupRequests] resolution notice failed (non-blocking)", e); }

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
