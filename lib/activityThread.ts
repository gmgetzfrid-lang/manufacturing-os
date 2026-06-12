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
import { notifyMany } from "@/lib/inAppNotifications";
import { getActiveEpisode, isMissingEpisodeSchema } from "@/lib/checkoutEpisodes";

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
  /** Checkout episode this message belongs to. NULL = pre-episode legacy row. */
  episodeId: string | null;
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
  /** Episode to attach to. Omit to auto-resolve the document's ACTIVE
   *  episode — every post made during a live checkout lands in its record. */
  episodeId?: string | null;
  text: string;
  userId: string;
  userName: string;
  kind?: ActivityKind;
  metadata?: Record<string, unknown> | null;
  parentMessageId?: string | null;
}

export async function postActivity(input: PostInput): Promise<ActivityMessage | null> {
  // Episode scoping: explicit id wins; otherwise attach to whatever episode
  // is live right now (null when the document is idle or pre-migration).
  let episodeId: string | null;
  if (input.episodeId !== undefined) {
    episodeId = input.episodeId;
  } else {
    try {
      episodeId = (await getActiveEpisode(input.documentId))?.id ?? null;
    } catch {
      episodeId = null;
    }
  }

  const base: Record<string, unknown> = {
    org_id: input.orgId,
    document_id: input.documentId,
    lock_id: input.lockId ?? null,
    text: input.text.trim(),
    user_id: input.userId,
    user_name: input.userName,
    kind: input.kind ?? "chat",
    metadata: input.metadata ?? null,
    parent_message_id: input.parentMessageId ?? null,
  };
  const row: Record<string, unknown> = episodeId ? { ...base, episode_id: episodeId } : base;

  let { data, error } = await supabase
    .from("checkout_messages")
    .insert(row)
    .select("*")
    .single();
  if (error && episodeId && isMissingEpisodeSchema(error)) {
    // Pre-migration env: retry without the episode column.
    ({ data, error } = await supabase.from("checkout_messages").insert(base).select("*").single());
  }
  if (error) throw error;

  // Persistent, targeted notifications (not just the ephemeral toast). Skip
  // auto-generated 'system' events. Fire-and-forget — never block the post.
  if (data && (input.kind ?? "chat") !== "system" && input.userId && input.userId !== "system") {
    void notifyCheckoutActivity({ ...input, episodeId });
  }

  return data ? rowToActivity(data as Record<string, unknown>) : null;
}

/**
 * Notify everyone with a stake in THIS checkout's thread when someone posts:
 * the episode's participants (not people from long-closed checkouts), every
 * active session holder, and anyone watching the document — minus the author.
 * Writes durable rows to the notifications inbox (bell + feed), so a
 * recipient who wasn't online still sees it.
 */
async function notifyCheckoutActivity(input: PostInput): Promise<void> {
  try {
    const actor = input.userId;
    const recipients = new Set<string>();

    // Thread participants: scoped to the live episode when there is one —
    // a new checkout is a clean slate, so checkout #1's commenters don't get
    // pinged about checkout #7. (Watchers below cover persistent interest.)
    let partsQuery = supabase
      .from("checkout_messages")
      .select("user_id")
      .eq("document_id", input.documentId);
    if (input.episodeId) partsQuery = partsQuery.eq("episode_id", input.episodeId);

    const [partsRes, sessRes, subsRes, docRes] = await Promise.all([
      partsQuery,
      supabase.from("checkout_sessions").select("user_id").eq("document_id", input.documentId).eq("status", "active"),
      supabase.from("subscriptions").select("user_id").eq("resource_type", "document").eq("resource_id", input.documentId),
      supabase.from("documents").select("library_id, document_number, title").eq("id", input.documentId).maybeSingle(),
    ]);

    ((partsRes.data as Array<{ user_id: string }> | null) ?? []).forEach((r) => recipients.add(r.user_id));
    ((sessRes.data as Array<{ user_id: string }> | null) ?? []).forEach((r) => recipients.add(r.user_id));
    ((subsRes.data as Array<{ user_id: string }> | null) ?? []).forEach((r) => recipients.add(r.user_id));

    recipients.delete(actor);
    recipients.delete("system");
    const userIds = Array.from(recipients).filter((u): u is string => !!u);
    if (userIds.length === 0) return;

    const doc = docRes.data as { library_id?: string; document_number?: string; title?: string } | null;
    const label = doc?.document_number || doc?.title || "a document";
    const link = `/documents/${doc?.library_id ?? ""}?doc=${input.documentId}`;
    const snippet = input.text.length > 140 ? input.text.slice(0, 137) + "…" : input.text;
    const kindWord =
      input.kind === "question" ? "asked about" :
      input.kind === "proposal" ? "proposed on" :
      input.kind === "handoff" ? "left a handoff on" :
      input.kind === "answer" ? "replied on" :
      input.kind === "markup_ref" ? "requested markup on" :
      "posted to";

    await notifyMany({
      orgId: input.orgId,
      userIds,
      actorUserId: actor,
      actorName: input.userName,
      kind: "checkout_message",
      title: `${input.userName} ${kindWord} ${label}`,
      body: snippet,
      link,
      resourceType: "document",
      resourceId: input.documentId,
    });
  } catch (e) {
    console.warn("[activityThread] checkout notify failed (non-blocking)", e);
  }
}

/**
 * List a document's activity.
 *
 *   episodeId: string  → that episode's thread only (live thread + history)
 *   episodeId: null    → legacy rows that predate episodes ("Earlier activity")
 *   episodeId omitted  → everything (legacy/pre-migration behavior)
 */
export async function listActivity(
  orgId: string,
  documentId: string,
  opts?: { episodeId?: string | null },
): Promise<ActivityMessage[]> {
  let query = supabase
    .from("checkout_messages")
    .select("*")
    .eq("org_id", orgId)
    .eq("document_id", documentId);
  if (opts && opts.episodeId !== undefined) {
    query = opts.episodeId === null
      ? query.is("episode_id", null)
      : query.eq("episode_id", opts.episodeId);
  }
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) {
    // Pre-migration env: no episode_id column → fall back to the whole feed.
    if (opts && opts.episodeId !== undefined && isMissingEpisodeSchema(error)) {
      return listActivity(orgId, documentId);
    }
    throw error;
  }
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
    episodeId: (r.episode_id as string | null) ?? null,
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
