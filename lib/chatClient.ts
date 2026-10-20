// lib/chatClient.ts — browser side of the chat shell.
//
// Threads and messages are plain org data behind RLS, so reads and the
// small mutations (rename, pin, settle, delete, profile) go straight to
// Supabase. The turn itself — the only thing that spends money — goes
// through /api/chat/ask as a stream, and that route writes the turns.

import { supabase } from "@/lib/supabase";
import { uploadToPath, makeChatAttachmentPath, getSignedUrlForPath, type UploadProgress } from "@/lib/storage";
import type { KnowledgeAnswer, KnowledgeCitation } from "@/lib/knowledge";
import type { OrchestratorReply } from "@/lib/orchestratorClient";

export type ChatScope = "library" | "tools" | "internet";

export interface ChatThread {
  id: string;
  orgId: string;
  scope: ChatScope;
  libraryId: string | null;
  title: string;
  instructions: string | null;
  pinned: boolean;
  settledAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lastMessageAt: string;
}

export interface ChatAttachment {
  id: string;
  kind: "image" | "pdf";
  name: string;
  path: string;
  size: number;
  mediaType: string;
}

/** What an assistant turn carries. `kind` says which engine answered. */
export type AssistantPayload =
  | ({ kind: "library"; question?: string; citedRevs?: Record<string, string> } & KnowledgeAnswer)
  | ({ kind: "tools"; question?: string } & OrchestratorReply);

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  payload: AssistantPayload | { focus?: string[]; inputs?: string } | null;
  attachments: ChatAttachment[];
  userId: string | null;
  userName: string | null;
  status: "pending" | "done" | "error";
  error: string | null;
  createdAt: string;
}

const mapThread = (r: Record<string, unknown>): ChatThread => ({
  id: r.id as string,
  orgId: r.org_id as string,
  scope: (r.scope as ChatScope) ?? "library",
  libraryId: (r.library_id as string | null) ?? null,
  title: (r.title as string) ?? "",
  instructions: (r.instructions as string | null) ?? null,
  pinned: !!r.pinned,
  settledAt: (r.settled_at as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdByName: (r.created_by_name as string | null) ?? null,
  createdAt: r.created_at as string,
  lastMessageAt: (r.last_message_at as string) ?? (r.created_at as string),
});

export const mapMessage = (r: Record<string, unknown>): ChatMessage => ({
  id: r.id as string,
  threadId: r.thread_id as string,
  role: r.role as "user" | "assistant",
  content: (r.content as string) ?? "",
  payload: (r.payload as ChatMessage["payload"]) ?? null,
  attachments: Array.isArray(r.attachments) ? (r.attachments as ChatAttachment[]) : [],
  userId: (r.user_id as string | null) ?? null,
  userName: (r.user_name as string | null) ?? null,
  status: (r.status as ChatMessage["status"]) ?? "done",
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as string,
});

/** A table that isn't there yet (migration not run) reads as empty, and the
 *  shell says so in one place instead of failing everywhere. */
export class ChatTablesMissingError extends Error {
  constructor() {
    super("The chat tables are missing — run migration 20261019_chat_shell.sql in Supabase.");
    this.name = "ChatTablesMissingError";
  }
}
const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist|schema cache/i.test(e.message ?? ""));

// ── Threads ───────────────────────────────────────────────────────────────

export async function listThreads(orgId: string, opts: {
  libraryId?: string | null;
  scope?: ChatScope;
  /** Only conversations this user started. */
  mine?: string;
  limit?: number;
} = {}): Promise<ChatThread[]> {
  let q = supabase.from("chat_threads").select("*").eq("org_id", orgId)
    .order("pinned", { ascending: false })
    .order("last_message_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.libraryId) q = q.eq("library_id", opts.libraryId);
  if (opts.scope) q = q.eq("scope", opts.scope);
  if (opts.mine) q = q.eq("created_by", opts.mine);
  const { data, error } = await q;
  if (error) {
    if (missing(error)) throw new ChatTablesMissingError();
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => mapThread(r as Record<string, unknown>));
}

export async function getThread(id: string): Promise<ChatThread | null> {
  const { data } = await supabase.from("chat_threads").select("*").eq("id", id).maybeSingle();
  return data ? mapThread(data as Record<string, unknown>) : null;
}

export async function createThread(input: {
  orgId: string; scope: ChatScope; libraryId: string | null; title?: string;
  uid: string; userName: string | null;
}): Promise<ChatThread> {
  const { data, error } = await supabase.from("chat_threads").insert({
    org_id: input.orgId, scope: input.scope,
    library_id: input.scope === "tools" ? null : input.libraryId,
    title: (input.title ?? "").slice(0, 120),
    created_by: input.uid, created_by_name: input.userName,
  }).select("*").single();
  if (error) {
    if (missing(error)) throw new ChatTablesMissingError();
    throw new Error(error.message);
  }
  return mapThread(data as Record<string, unknown>);
}

export async function updateThread(id: string, patch: Partial<{
  title: string; pinned: boolean; settledAt: string | null; instructions: string | null;
}>): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) row.title = patch.title.slice(0, 120);
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  if (patch.settledAt !== undefined) row.settled_at = patch.settledAt;
  if (patch.instructions !== undefined) row.instructions = patch.instructions;
  const { error } = await supabase.from("chat_threads").update(row).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteThread(id: string): Promise<void> {
  const { error } = await supabase.from("chat_threads").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Messages ──────────────────────────────────────────────────────────────

export async function listMessages(threadId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase.from("chat_messages").select("*")
    .eq("thread_id", threadId).order("created_at", { ascending: true }).limit(400);
  if (error) {
    if (missing(error)) throw new ChatTablesMissingError();
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => mapMessage(r as Record<string, unknown>));
}

/** Reuse a past answer in the current conversation — no AI call. The pair
 *  is written as two ordinary turns marked as replayed. */
export async function insertReplayedTurn(input: {
  orgId: string; threadId: string; uid: string; userName: string | null;
  question: string; payload: AssistantPayload; answer: string;
  replayedFrom: { messageId: string; threadId: string; userName: string | null; createdAt: string };
}): Promise<ChatMessage[]> {
  const now = Date.now();
  const rows = [
    {
      org_id: input.orgId, thread_id: input.threadId, role: "user", content: input.question,
      user_id: input.uid, user_name: input.userName, status: "done",
      created_at: new Date(now).toISOString(),
    },
    {
      org_id: input.orgId, thread_id: input.threadId, role: "assistant", content: input.answer,
      payload: { ...input.payload, question: input.question, replayedFrom: input.replayedFrom },
      user_id: input.uid, user_name: input.userName, status: "done",
      created_at: new Date(now + 1).toISOString(),
    },
  ];
  const { data, error } = await supabase.from("chat_messages").insert(rows).select("*");
  if (error) throw new Error(error.message);
  await updateThread(input.threadId, {}).catch(() => undefined);
  await supabase.from("chat_threads").update({ last_message_at: new Date(now + 1).toISOString() }).eq("id", input.threadId);
  return (data ?? []).map((r) => mapMessage(r as Record<string, unknown>));
}

// ── Asked-before memory ───────────────────────────────────────────────────

export interface PastAnswer {
  messageId: string;
  threadId: string;
  threadTitle: string;
  scope: ChatScope;
  libraryId: string | null;
  question: string;
  answer: string;
  payload: AssistantPayload;
  userName: string | null;
  createdAt: string;
  /** 0..1 word overlap with the question being typed. */
  similarity: number;
}

const words = (s: string) => new Set(
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)),
);
const STOP = new Set(["the", "and", "for", "what", "which", "that", "this", "with", "from", "are", "does", "how", "can", "about", "have", "there", "any", "our", "you", "your", "our"]);

/** Search every past answer in the org (all scopes) for a near-twin of the
 *  question being typed. Full-text via the generated search_tsv, then
 *  scored by word overlap so the UI can tell a strong match from a weak one. */
export async function searchPastAnswers(orgId: string, query: string, opts: {
  scope?: ChatScope; libraryId?: string | null; limit?: number;
} = {}): Promise<PastAnswer[]> {
  const q = query.trim();
  if (q.length < 12) return [];
  let sel = supabase.from("chat_messages")
    .select("id, thread_id, content, payload, user_name, created_at, chat_threads!inner(scope, library_id, title)")
    .eq("org_id", orgId).eq("role", "assistant").eq("status", "done")
    .textSearch("search_tsv", q, { type: "websearch", config: "english" })
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 8);
  if (opts.scope) sel = sel.eq("chat_threads.scope", opts.scope);
  if (opts.libraryId) sel = sel.eq("chat_threads.library_id", opts.libraryId);
  const { data, error } = await sel;
  if (error || !data) return [];
  const mine = words(q);
  const out: PastAnswer[] = [];
  for (const r of data as unknown as Array<Record<string, unknown>>) {
    const payload = (r.payload ?? {}) as AssistantPayload;
    const t = (Array.isArray(r.chat_threads) ? r.chat_threads[0] : r.chat_threads) as Record<string, unknown> | undefined;
    const question = String((payload as { question?: string }).question ?? "");
    if (!question || !r.content) continue;
    const theirs = words(question);
    const inter = [...mine].filter((w) => theirs.has(w)).length;
    const union = new Set([...mine, ...theirs]).size || 1;
    out.push({
      messageId: r.id as string,
      threadId: r.thread_id as string,
      threadTitle: String(t?.title ?? ""),
      scope: (t?.scope as ChatScope) ?? "library",
      libraryId: (t?.library_id as string | null) ?? null,
      question,
      answer: r.content as string,
      payload,
      userName: (r.user_name as string | null) ?? null,
      createdAt: r.created_at as string,
      similarity: inter / union,
    });
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

/** Has any cited document moved on since this answer? Compares the
 *  revision recorded at answer time with the document's revision now, and
 *  treats a missing or re-indexing document as changed too. */
export async function citedSourcesChanged(payload: AssistantPayload): Promise<string[]> {
  if (payload.kind !== "library") return [];
  const cites = (payload.citations ?? []) as KnowledgeCitation[];
  const ids = [...new Set(cites.map((c) => c.documentId).filter((x): x is string => !!x))].slice(0, 40);
  if (ids.length === 0) return [];
  const { data } = await supabase.from("knowledge_documents").select("id, name, status, source_rev").in("id", ids);
  const now = new Map(((data ?? []) as Array<{ id: string; name: string; status: string; source_rev: string | null }>).map((d) => [d.id, d]));
  const changed: string[] = [];
  for (const id of ids) {
    const d = now.get(id);
    const name = cites.find((c) => c.documentId === id)?.documentName ?? "a cited document";
    if (!d) { changed.push(`${name} — no longer in the library`); continue; }
    if (d.status !== "ready") { changed.push(`${d.name} — re-indexing`); continue; }
    const then = payload.citedRevs?.[id];
    if (then !== undefined && (d.source_rev ?? "") !== then) changed.push(`${d.name} — now Rev ${d.source_rev ?? "?"}`);
  }
  return changed;
}

// ── Asker profile ─────────────────────────────────────────────────────────

export interface ChatProfile {
  discipline: string;
  units: string;
  defaultLibraryId: string | null;
  notes: string;
}

export async function getProfile(orgId: string, uid: string): Promise<ChatProfile | null> {
  const { data } = await supabase.from("chat_user_profiles").select("*")
    .eq("org_id", orgId).eq("user_id", uid).maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    discipline: (r.discipline as string) ?? "",
    units: (r.units as string) ?? "",
    defaultLibraryId: (r.default_library_id as string | null) ?? null,
    notes: (r.notes as string) ?? "",
  };
}

export async function saveProfile(orgId: string, uid: string, p: ChatProfile): Promise<void> {
  const { error } = await supabase.from("chat_user_profiles").upsert({
    org_id: orgId, user_id: uid,
    discipline: p.discipline.trim().slice(0, 120) || null,
    units: p.units.trim().slice(0, 60) || null,
    default_library_id: p.defaultLibraryId,
    notes: p.notes.trim().slice(0, 600) || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "org_id,user_id" });
  if (error) throw new Error(error.message);
}

// ── Attachments ───────────────────────────────────────────────────────────

export const ATTACHMENT_LIMITS = {
  maxFiles: 4,
  imageBytes: 6 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  imageTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

export function classifyAttachment(file: File): { kind: "image" | "pdf" } | { error: string } {
  if (ATTACHMENT_LIMITS.imageTypes.includes(file.type)) {
    if (file.size > ATTACHMENT_LIMITS.imageBytes) return { error: `${file.name}: images up to 6 MB.` };
    return { kind: "image" };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    if (file.size > ATTACHMENT_LIMITS.pdfBytes) return { error: `${file.name}: PDFs up to 20 MB (the first 3 pages are read).` };
    return { kind: "pdf" };
  }
  return { error: `${file.name}: attach an image (PNG, JPG, WebP) or a PDF.` };
}

export async function uploadChatAttachment(input: {
  orgId: string; threadId: string | null; uid: string; file: File;
  kind: "image" | "pdf";
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<ChatAttachment> {
  const path = makeChatAttachmentPath({
    orgId: input.orgId, threadId: input.threadId, uid: input.uid, filename: input.file.name,
  });
  await uploadToPath(input.file, path, {
    contentType: input.file.type || (input.kind === "pdf" ? "application/pdf" : "application/octet-stream"),
    onProgress: input.onProgress, signal: input.signal,
  });
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: input.kind, name: input.file.name, path,
    size: input.file.size, mediaType: input.file.type || (input.kind === "pdf" ? "application/pdf" : ""),
  };
}

export function attachmentUrl(path: string): Promise<string> {
  return getSignedUrlForPath(path, 3600);
}

// ── The turn ──────────────────────────────────────────────────────────────

export type ChatStreamEvent =
  | { t: "thread"; thread: Record<string, unknown> }
  | { t: "user"; message: Record<string, unknown> }
  | { t: "status"; text: string }
  | { t: "delta"; text: string }
  | { t: "reset" }
  | { t: "ping" }
  | { t: "result"; message: Record<string, unknown> | null; reply: Record<string, unknown>; threadId: string }
  | { t: "error"; status: number; error?: string; threadId?: string; withdrawn?: boolean; [k: string]: unknown };

export interface AskTurnInput {
  orgId: string;
  scope: ChatScope;
  libraryId: string | null;
  threadId: string | null;
  question: string;
  focus?: string[];
  inputs?: string;
  approved?: string[];
  attachments?: ChatAttachment[];
  /** How the library answer is shaped: a direct answer, a compliance check
   *  against the standard, or a broader exploration. Unset = the AI picks. */
  answerMode?: "answer" | "compliance" | "explore" | "deviation";
}

/** Send one turn and read the stream. Resolves when the stream ends; every
 *  event (including the terminal result/error) is delivered to `onEvent`.
 *  Throws only on transport failure (no connection, non-stream response). */
export async function askTurn(
  input: AskTurnInput,
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  const res = await fetch("/api/chat/ask", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    onEvent({ t: "error", status: res.status, ...(data ?? {}), error: String(data?.error ?? `HTTP ${res.status}`) });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      try { onEvent(JSON.parse(raw) as ChatStreamEvent); } catch { /* partial garbage — skip */ }
    }
  }
  if (buf.trim()) {
    try { onEvent(JSON.parse(buf.trim()) as ChatStreamEvent); } catch { /* ignore */ }
  }
}

/** Merge fields into an assistant turn's payload (e.g. the outcome of a
 *  confirmed action), so reopening the conversation shows what was done. */
export async function mergeMessagePayload(id: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await supabase.from("chat_messages").select("payload").eq("id", id).maybeSingle();
  const current = ((data?.payload as Record<string, unknown> | null) ?? {});
  const { error } = await supabase.from("chat_messages").update({ payload: { ...current, ...patch } }).eq("id", id);
  if (error) throw new Error(error.message);
}
