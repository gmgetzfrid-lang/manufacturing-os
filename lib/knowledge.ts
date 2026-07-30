// lib/knowledge.ts — client-side access to the AI knowledge libraries.
//
// Reads go straight to supabase (RLS scopes them); anything involving the
// PDF pipeline or a provider key goes through the /api routes with a bearer
// token (same contract as lib/storage.ts).

import { supabase } from "@/lib/supabase";
import { uploadToPath, type UploadProgress } from "@/lib/storage";

export interface KnowledgeLibrary {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  createdByName: string | null;
  createdAt: string;
  documentCount?: number;
}

export interface KnowledgeDocument {
  id: string;
  libraryId: string;
  name: string;
  fileKey: string;
  fileSize: number | null;
  pageCount: number | null;
  pagesIndexed: number;
  status: "pending" | "indexing" | "ready" | "error";
  error: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** Library answers cite (document, page, verbatim quote); internet answers
 *  cite (url, title). */
export interface KnowledgeCitation {
  n: number;
  documentId?: string;
  documentName?: string;
  page?: number;
  /** The exact passage text the answer was built from. */
  quote?: string;
  url?: string;
  title?: string;
}

export type AskMode = "library" | "internet";

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgeCitation[];
  provider: string;
  model: string;
  mode: AskMode;
  /** Internet mode only: whether a LIVE web tool ran (vs model knowledge). */
  liveWeb?: boolean;
}

export interface KnowledgeQuestion {
  id: string;
  question: string;
  answer: string | null;
  citations: KnowledgeCitation[];
  userName: string | null;
  mode: AskMode;
  createdAt: string;
}

export interface AiConnectionInfo {
  provider: string;
  model: string;
  keyLast4: string | null;
  updatedAt: string;
}

async function authToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");
  return session.access_token;
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const token = await authToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ── Libraries ──────────────────────────────────────────────────────────────

const mapLibrary = (r: Record<string, unknown>): KnowledgeLibrary => ({
  id: r.id as string,
  orgId: r.org_id as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  createdByName: (r.created_by_name as string | null) ?? null,
  createdAt: r.created_at as string,
});

export async function listKnowledgeLibraries(orgId: string): Promise<KnowledgeLibrary[]> {
  const { data, error } = await supabase
    .from("knowledge_libraries").select("*").eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) return [];
  const libs = (data ?? []).map(mapLibrary);
  if (libs.length > 0) {
    const { data: docs } = await supabase
      .from("knowledge_documents").select("library_id")
      .in("library_id", libs.map((l) => l.id));
    const counts = new Map<string, number>();
    for (const d of (docs ?? []) as Array<{ library_id: string }>) {
      counts.set(d.library_id, (counts.get(d.library_id) ?? 0) + 1);
    }
    for (const l of libs) l.documentCount = counts.get(l.id) ?? 0;
  }
  return libs;
}

export async function getKnowledgeLibrary(id: string): Promise<KnowledgeLibrary | null> {
  const { data } = await supabase.from("knowledge_libraries").select("*").eq("id", id).maybeSingle();
  return data ? mapLibrary(data as Record<string, unknown>) : null;
}

export async function createKnowledgeLibrary(input: {
  orgId: string; name: string; description?: string; userId: string; userName: string;
}): Promise<KnowledgeLibrary> {
  const { data, error } = await supabase.from("knowledge_libraries").insert({
    org_id: input.orgId, name: input.name.trim(),
    description: input.description?.trim() || null,
    created_by: input.userId, created_by_name: input.userName,
  }).select().single();
  if (error) throw new Error(error.message);
  await supabase.from("audit_logs").insert({
    action: "KNOWLEDGE_LIBRARY_CREATED",
    resource_type: "knowledge_library", resource_id: (data as { id: string }).id,
    org_id: input.orgId, user_id: input.userId,
    details: { name: input.name.trim() },
  });
  return mapLibrary(data as Record<string, unknown>);
}

export async function deleteKnowledgeLibrary(id: string): Promise<void> {
  const { error } = await supabase.from("knowledge_libraries").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Documents + ingestion ─────────────────────────────────────────────────

const mapDocument = (r: Record<string, unknown>): KnowledgeDocument => ({
  id: r.id as string,
  libraryId: r.library_id as string,
  name: r.name as string,
  fileKey: r.file_key as string,
  fileSize: (r.file_size as number | null) ?? null,
  pageCount: (r.page_count as number | null) ?? null,
  pagesIndexed: (r.pages_indexed as number) ?? 0,
  status: (r.status as KnowledgeDocument["status"]) ?? "pending",
  error: (r.error as string | null) ?? null,
  createdByName: (r.created_by_name as string | null) ?? null,
  createdAt: r.created_at as string,
});

export async function listKnowledgeDocuments(libraryId: string): Promise<KnowledgeDocument[]> {
  const { data, error } = await supabase
    .from("knowledge_documents").select("*").eq("library_id", libraryId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? []).map(mapDocument);
}

/** Upload the PDF to R2, register the document row, and drive the ingest
 *  loop until every page is indexed. onProgress reports both phases. */
export async function addKnowledgeDocument(input: {
  orgId: string; libraryId: string; file: File; userId: string; userName: string;
  onUpload?: (p: UploadProgress) => void;
  onIndex?: (indexed: number, total: number | null) => void;
}): Promise<KnowledgeDocument> {
  const safe = input.file.name.replace(/[^\w.\- ]+/g, "_");
  const fileKey = `orgs/${input.orgId}/knowledge/${input.libraryId}/${Date.now()}-${safe}`;
  await uploadToPath(input.file, fileKey, {
    contentType: input.file.type || "application/pdf",
    onProgress: input.onUpload,
  });

  const { data, error } = await supabase.from("knowledge_documents").insert({
    org_id: input.orgId, library_id: input.libraryId,
    name: input.file.name, file_key: fileKey, file_size: input.file.size,
    created_by: input.userId, created_by_name: input.userName,
  }).select().single();
  if (error) throw new Error(error.message);
  const doc = mapDocument(data as Record<string, unknown>);

  await ingestKnowledgeDocument(doc.id, input.onIndex);
  return doc;
}

/** Drive (or resume) the batch ingest loop for a document. */
export async function ingestKnowledgeDocument(
  documentId: string,
  onIndex?: (indexed: number, total: number | null) => void,
): Promise<void> {
  // Bounded loop: a 10k-page monster still terminates (10000/50 = 200 rounds).
  for (let i = 0; i < 400; i++) {
    const out = await apiPost<{ done: boolean; pageCount: number; pagesIndexed: number }>(
      "/api/knowledge/ingest", { documentId },
    );
    onIndex?.(out.pagesIndexed, out.pageCount);
    if (out.done) return;
  }
  throw new Error("Indexing did not finish — reopen the library to resume.");
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  const { error } = await supabase.from("knowledge_documents").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Ask + history ─────────────────────────────────────────────────────────

export async function askKnowledgeLibrary(
  orgId: string, libraryId: string, question: string, mode: AskMode = "library",
): Promise<KnowledgeAnswer> {
  return apiPost<KnowledgeAnswer>("/api/knowledge/ask", { orgId, libraryId, question, mode });
}

export async function listKnowledgeQuestions(
  libraryId: string, limit = 25,
): Promise<KnowledgeQuestion[]> {
  const { data, error } = await supabase
    .from("knowledge_questions").select("*").eq("library_id", libraryId)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    question: r.question as string,
    answer: (r.answer as string | null) ?? null,
    citations: Array.isArray(r.citations) ? (r.citations as KnowledgeCitation[]) : [],
    userName: (r.user_name as string | null) ?? null,
    mode: (r.mode as AskMode) === "internet" ? "internet" as const : "library" as const,
    createdAt: r.created_at as string,
  }));
}

// ── AI connection (BYO keys — always via the API, never direct) ───────────

export async function getAiConnections(orgId: string): Promise<{
  org: AiConnectionInfo | null;
  personal: AiConnectionInfo | null;
  effective: AiConnectionInfo | null;
  canManageOrg: boolean;
}> {
  const token = await authToken();
  const res = await fetch(`/api/ai/connection?orgId=${encodeURIComponent(orgId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Couldn't load AI settings");
  return res.json();
}

export async function saveAiConnection(input: {
  orgId: string; scope: "org" | "personal"; provider: string; model: string; apiKey?: string;
}): Promise<void> {
  await apiPost("/api/ai/connection", input);
}

export async function testAiConnection(input: {
  orgId: string; scope: "org" | "personal"; provider?: string; model?: string; apiKey?: string;
}): Promise<{ ok: boolean; reply?: string }> {
  return apiPost("/api/ai/connection", { ...input, action: "test" });
}

export async function removeAiConnection(orgId: string, scope: "org" | "personal"): Promise<void> {
  const token = await authToken();
  const res = await fetch("/api/ai/connection", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId, scope }),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
}
