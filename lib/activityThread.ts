// lib/activityThread.ts
//
// Helpers for the unified per-document checkout activity thread.
//
// The 20260620 migration widened the checkout_messages table from
// "chat only" to a discriminated union (kind = chat | system | handoff |
// proposal | question | answer | markup_ref). This module is the only
// caller of that table that knows about the kinds; the UI just renders
// whatever it gets back.

import { supabase } from "@/lib/supabase";

export type ActivityKind =
  | "chat"
  | "system"
  | "handoff"
  | "proposal"
  | "question"
  | "answer"
  | "markup_ref";

export interface ActivityMessage {
  id: string;
  orgId: string;
  documentId: string;
  lockId: string | null;
  kind: ActivityKind;
  text: string;
  userId: string;
  userName: string;
  metadata: Record<string, unknown> | null;
  parentMessageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

interface PostInput {
  orgId: string;
  documentId: string;
  lockId?: string | null;
  text: string;
  userId: string;
  userName: string;
  kind?: ActivityKind;
  metadata?: Record<string, unknown> | null;
  parentMessageId?: string | null;
}

export async function postActivity(input: PostInput): Promise<ActivityMessage | null> {
  const { data, error } = await supabase.from("checkout_messages").insert({
    org_id: input.orgId,
    document_id: input.documentId,
    lock_id: input.lockId ?? null,
    text: input.text.trim(),
    user_id: input.userId,
    user_name: input.userName,
    kind: input.kind ?? "chat",
    metadata: input.metadata ?? null,
    parent_message_id: input.parentMessageId ?? null,
  }).select("*").single();
  if (error) throw error;
  return data ? rowToActivity(data as Record<string, unknown>) : null;
}

export async function listActivity(orgId: string, documentId: string): Promise<ActivityMessage[]> {
  const { data, error } = await supabase
    .from("checkout_messages")
    .select("*")
    .eq("org_id", orgId)
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => rowToActivity(r as Record<string, unknown>));
}

export async function resolveMessage(messageId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("checkout_messages")
    .update({ resolved_at: new Date().toISOString(), resolved_by_user_id: userId })
    .eq("id", messageId);
  if (error) throw error;
}

// ─── Convenience wrappers per kind ──────────────────────────────────

export const postChat = (i: Omit<PostInput, "kind">) =>
  postActivity({ ...i, kind: "chat" });

export const postSystem = (i: Omit<PostInput, "kind" | "userId" | "userName"> & { userId?: string; userName?: string }) =>
  postActivity({ ...i, userId: i.userId ?? "system", userName: i.userName ?? "System", kind: "system" });

export const postHandoff = (i: Omit<PostInput, "kind">) =>
  postActivity({ ...i, kind: "handoff" });

export const postProposal = (i: Omit<PostInput, "kind"> & { title?: string }) =>
  postActivity({
    ...i,
    kind: "proposal",
    metadata: { ...(i.metadata ?? {}), ...(i.title ? { title: i.title } : {}) },
  });

export const askIsLatest = (i: Omit<PostInput, "kind" | "text"> & { question?: string }) =>
  postActivity({
    ...i,
    kind: "question",
    text: i.question?.trim() || "Is this the latest version?",
    metadata: { ...(i.metadata ?? {}), latest_check: true },
  });

export const answerQuestion = (i: Omit<PostInput, "kind"> & { parentMessageId: string }) =>
  postActivity({ ...i, kind: "answer" });

export const postMarkupRef = (i: Omit<PostInput, "kind" | "text"> & { markupRequestId: string; summary: string }) =>
  postActivity({
    ...i,
    kind: "markup_ref",
    text: i.summary,
    metadata: { ...(i.metadata ?? {}), markup_request_id: i.markupRequestId },
  });

function rowToActivity(r: Record<string, unknown>): ActivityMessage {
  return {
    id: r.id as string,
    orgId: r.org_id as string,
    documentId: r.document_id as string,
    lockId: (r.lock_id as string | null) ?? null,
    kind: (r.kind as ActivityKind) ?? "chat",
    text: (r.text as string) ?? "",
    userId: (r.user_id as string) ?? "",
    userName: (r.user_name as string) ?? "",
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    parentMessageId: (r.parent_message_id as string | null) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    resolvedByUserId: (r.resolved_by_user_id as string | null) ?? null,
  };
}
