// lib/knowledge.ts — client-side access to the AI knowledge libraries.
//
// Reads go straight to supabase (RLS scopes them); anything involving the
// PDF pipeline or a provider key goes through the /api routes with a bearer
// token (same contract as lib/storage.ts). The team's stored answers are the
// exception: they were built under the ASKER's ACL, so they are read only
// through /api/knowledge/history, which re-checks every citation for the
// current reader (20261120 narrows the table itself to the asker and
// controllers).

import { supabase } from "@/lib/supabase";
import { uploadToPath, type UploadProgress } from "@/lib/storage";

export interface KnowledgeLibrary {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  /** Standing orders injected into every question asked of this library. */
  aiInstructions: string | null;
  /** Additive AI feature toggles (Library AI setup checkboxes). */
  aiFeatures: KnowledgeAiFeatures;
  createdByName: string | null;
  createdAt: string;
  documentCount?: number;
}

export interface KnowledgeAiFeatures {
  /** Ask which aspects to answer when a question spans several (safety vs
   *  fabrication vs design…) instead of answering everything at once. */
  clarifyFacets?: boolean;
  /** Deep read: attach images of the top-cited pages to the answer so the
   *  model reads tables, typeset formulas, and figures exactly as printed. */
  visionPages?: boolean;
  /** Indexing: read EVERY page with AI vision, not just pages whose text
   *  layer is unreadable. For drawing sets where extraction can't be
   *  trusted at all. Costs per page — on by choice, not by default. */
  visionAllPages?: boolean;
  /** Owner-taught drawing-number scheme ("first two digits = unit: 20 =
   *  Crude Unit…"). Unit pairs are machine-read; the rest goes to the
   *  model verbatim. */
  decoder?: string;
  /** This library is a DRAWING SET — show the Drawing Intelligence panel
   *  (equipment census, reference audit, register export). Off by default:
   *  a standards library mentioning document numbers is not a drawing set,
   *  and unrequested drawing tooling on it reads as the app deciding what
   *  the library is. */
  drawingIntel?: boolean;
  /** Legend / symbols / line-key documents (ids from THIS library) whose
   *  content rides along with every question. Max 3. */
  legendDocIds?: string[];
}

export interface KnowledgeLibraryLink {
  id: string;
  linkedLibraryId: string;
  linkedLibraryName: string;
}

export interface KnowledgeDocument {
  id: string;
  libraryId: string;
  name: string;
  fileKey: string;
  fileSize: number | null;
  pageCount: number | null;
  pagesIndexed: number;
  status: "pending" | "indexing" | "ready" | "stale" | "error";
  error: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Set when this doc mirrors a CONTROLLED document (a knowledge source)
   *  instead of a direct upload — managed by sync, not deletable by hand. */
  sourceId: string | null;
  sourceDocumentId: string | null;
  sourceRev: string | null;
  /** Pages that had no text layer and were read by AI vision instead. */
  visionPages: number;
}

/** Library answers cite (document, page, verbatim quote); internet answers
 *  cite (url, title). */
export interface KnowledgeCitation {
  n: number;
  documentId?: string;
  documentName?: string;
  page?: number;
  /** Section heading in force where the passage sits, e.g. "5.3 Pipe Supports". */
  section?: string | null;
  /** The exact passage text the answer was built from. */
  quote?: string;
  /** Equipment tags from this cited page that the answer talks about — the
   *  viewer points at them on the sheet. Drawings only. */
  tags?: string[];
  /** Which library the passage came from + its precedence tier (when the
   *  asked library has linked reference libraries). */
  libraryName?: string;
  tier?: "governing" | "reference";
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
  /** Saved history row id — the handle a thumbs-up/down rating attaches to. */
  questionId?: string | null;
  /** Documents present in the library whose index is incomplete. */
  partialDocs?: string[];
  /** Documents the answer text NAMES (matched by designation against the
   *  reachable roster) — each becomes a clickable open-the-document chip
   *  inline in the answer, even when no [n] cites it. */
  mentionedDocs?: Array<{ id: string; name: string; fileKey: string; page: number; mention: string }>;
  /** Internet mode only: whether a LIVE web tool ran (vs model knowledge). */
  liveWeb?: boolean;
  /** Documents the passages referenced that no linked library contains —
   *  the "you need this book" list. */
  missingDocs?: string[];
  /** Month spend after this ask vs the asker's cap (governed workspaces). */
  budget?: { spentUsd: number; capUsd: number };
  /** How the passages were found. "keyword" is not a degraded state — it's
   *  what this product has always done, and it's excellent at exact tags.
   *  It's stated so an answer can never IMPLY a meaning-based search that
   *  didn't run. */
  retrieval?: "keyword" | "hybrid";
  /** Meaning-index coverage over the libraries this answer searched, when
   *  the ask route reports it. Absent, the page falls back to the asked
   *  library's own coverage (describeRetrieval). */
  retrievalCoverage?: { embedded: number; total: number };
  /** Clarify round (opt-in feature): no answer yet — the AI found the
   *  question's answer across several distinct aspects and asks which to
   *  cover. Re-ask with `focus` to get the actual answer. */
  clarification?: { question: string; options: string[] };
  /** Structured, clickable equipment register — attached when the question
   *  asks for equipment lists/tables. Deterministic data, never model
   *  output; every sheet reference opens the drawing with the tag ringed. */
  equipmentTable?: EquipmentTable;
}

export interface EquipmentTable {
  total: number;
  truncated: boolean;
  filteredTo: string | null;
  categories: Array<{
    prefix: string;
    label: string;
    count: number;
    items: Array<{
      tag: string;
      note: string | null;
      sheets: Array<{
        documentId: string; documentName: string; page: number;
        /** "SHT 3" when the title block declared it, else "p.N". */
        sheetLabel?: string;
      }>;
    }>;
  }>;
}

export interface KnowledgeQuestion {
  id: string;
  /** Conversation this ask belongs to; null for pre-thread history. */
  threadId?: string | null;
  question: string;
  answer: string | null;
  citations: KnowledgeCitation[];
  userName: string | null;
  mode: AskMode;
  createdAt: string;
  /** The reader asked it. Continuing someone else's conversation starts a
   *  new thread seeded with their turns — never appends to theirs. */
  mine?: boolean;
}

/** A page of the team's record as THIS reader may see it. `withheld` counts
 *  answers left out — because they draw on a document the reader cannot open
 *  (or one since removed from the library), or because they are a
 *  teammate's library answer that cites no document (shown to its asker
 *  only), or a later turn of a conversation holding either — said out loud,
 *  never silently, and never as a claim about which of these it was. */
export interface KnowledgeHistoryPage {
  questions: KnowledgeQuestion[];
  withheld: number;
  error?: string;
}

export interface AiConnectionInfo {
  provider: string;
  model: string;
  keyLast4: string | null;
  updatedAt: string;
  /** The SEPARATE embeddings key. Null until someone adds one — Anthropic
   *  makes no embeddings model, so a Claude chat key can't double as this. */
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingKeyLast4: string | null;
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
  if (!res.ok || !data) {
    // A gateway timeout / cold-start failure answers with HTML, not JSON —
    // that's the platform, not the request. Flag it so resumable loops can
    // retry instead of treating an infrastructure hiccup as a dead end.
    const transient = !data && [408, 500, 502, 503, 504].includes(res.status);
    // Carry structured fields (e.g. agreementRequired/agreementText on 428)
    // so callers can react to more than a message string.
    throw Object.assign(
      new Error(data?.error || `HTTP ${res.status}`),
      { transient },
      data && typeof data === "object" ? data : {},
    );
  }
  return data;
}

// ── Libraries ──────────────────────────────────────────────────────────────

const mapLibrary = (r: Record<string, unknown>): KnowledgeLibrary => ({
  id: r.id as string,
  orgId: r.org_id as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  aiInstructions: (r.ai_instructions as string | null) ?? null,
  aiFeatures: (r.ai_features as KnowledgeAiFeatures | null) ?? {},
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

/** Save the library's standing AI instructions (controllers; RLS enforces). */
export async function saveLibraryAiInstructions(libraryId: string, instructions: string): Promise<void> {
  const { error } = await supabase.from("knowledge_libraries")
    .update({ ai_instructions: instructions.trim() || null }).eq("id", libraryId);
  if (error) throw new Error(error.message);
}

/** Save the library's AI feature toggles (controllers; RLS enforces).
 *
 *  The toggles are replaced as a set, but ai_features also carries the
 *  meaning index's background-build marker (`embedBuild` — who pays, and a
 *  standing "keep current" consent, SEM-8), which this save must never
 *  erase: knowledge_library_save_ai_features (20261121) replaces every key
 *  EXCEPT embedBuild in one statement, so a drain writing the marker at the
 *  same moment is not reverted either. Before 20261121 the marker is carried
 *  over by reading it first. A save that changed nothing (no permission, or
 *  no such library) is an error, never a silent success. */
export async function saveLibraryAiFeatures(libraryId: string, features: KnowledgeAiFeatures): Promise<void> {
  const toggles = { ...(features as Record<string, unknown>) };
  delete toggles.embedBuild;
  const fail = (error: { code?: string; message: string }): never => {
    throw new Error(
      error.code === "PGRST204" || /ai_features/.test(error.message)
        ? "AI features need migration 20260918 — run it in Supabase first."
        : error.message,
    );
  };
  const notSaved = "Library AI setup was not saved — only Admin or Doc Control can change it.";

  const rpc = await supabase.rpc("knowledge_library_save_ai_features", { p_library_id: libraryId, p_features: toggles });
  if (!rpc.error) {
    if (rpc.data !== true) throw new Error(notSaved);
    return;
  }
  const missing = rpc.error.code === "PGRST202" || rpc.error.code === "42883"
    || /Could not find the function|does not exist/i.test(rpc.error.message);
  if (!missing) fail(rpc.error);

  // 20261121 not applied: keep the marker by reading it first.
  const { data: cur, error: readErr } = await supabase.from("knowledge_libraries")
    .select("ai_features").eq("id", libraryId).maybeSingle();
  if (readErr) fail(readErr);
  const marker = ((cur as { ai_features?: Record<string, unknown> | null } | null)?.ai_features ?? {}).embedBuild;
  const { data, error } = await supabase.from("knowledge_libraries")
    .update({ ai_features: marker !== undefined ? { ...toggles, embedBuild: marker } : toggles })
    .eq("id", libraryId).select("id");
  if (error) fail(error);
  if (!Array.isArray(data) || data.length === 0) throw new Error(notSaved);
}

export async function listLibraryLinks(libraryId: string): Promise<KnowledgeLibraryLink[]> {
  const { data, error } = await supabase
    .from("knowledge_library_links")
    .select("id, linked_library_id, knowledge_libraries!knowledge_library_links_linked_library_id_fkey(name)")
    .eq("library_id", libraryId);
  if (error) return [];
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    linkedLibraryId: r.linked_library_id as string,
    linkedLibraryName:
      ((r.knowledge_libraries as { name?: string } | null)?.name as string) ?? "Library",
  }));
}

/** Replace the library's reference links with exactly this set. */
export async function setLibraryLinks(input: {
  orgId: string; libraryId: string; linkedLibraryIds: string[];
}): Promise<void> {
  const { error: delErr } = await supabase
    .from("knowledge_library_links").delete().eq("library_id", input.libraryId);
  if (delErr) throw new Error(delErr.message);
  if (input.linkedLibraryIds.length === 0) return;
  const { error } = await supabase.from("knowledge_library_links").insert(
    input.linkedLibraryIds.map((linked) => ({
      org_id: input.orgId, library_id: input.libraryId, linked_library_id: linked,
    })),
  );
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
  sourceId: (r.source_id as string | null) ?? null,
  sourceDocumentId: (r.source_document_id as string | null) ?? null,
  sourceRev: (r.source_rev as string | null) ?? null,
  visionPages: (r.vision_pages as number | null) ?? 0,
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
export interface IngestProgress {
  indexed: number;
  total: number | null;
  /** Pages read by AI vision so far this run (no text layer). */
  visionPages: number;
  /** Set when vision couldn't run (no key / cap reached). */
  visionSkipReason?: string | null;
}

// One driver per document per tab. Two loops POSTing the same document race
// each other over the same page range — the app-shell background driver and
// a library page's own loop must never overlap.
const activeIngests = new Set<string>();

/** True while some loop in THIS tab is already driving the document. */
export function isIngestActive(documentId: string): boolean {
  return activeIngests.has(documentId);
}

export async function ingestKnowledgeDocument(
  documentId: string,
  onIndex?: (indexed: number, total: number | null, progress?: IngestProgress) => void,
): Promise<void> {
  // Another loop in this tab already owns the document — let it finish.
  // Progress lives on the row, so the caller's refreshes still see movement.
  if (activeIngests.has(documentId)) return;
  activeIngests.add(documentId);
  try {
    await ingestLoop(documentId, onIndex);
  } finally {
    activeIngests.delete(documentId);
  }
}

async function ingestLoop(
  documentId: string,
  onIndex?: (indexed: number, total: number | null, progress?: IngestProgress) => void,
): Promise<void> {
  // Bounded loop. Vision-read pages advance in small batches (render +
  // transcribe is seconds per page), so the round budget is generous.
  //
  // Two things make this survivable. The server commits partial progress and
  // returns before the platform's kill timer, so every round moves the mark
  // forward. And a round that dies at the gateway is retried rather than
  // abandoned — progress lives on the document row, so re-POSTing is safe.
  // What we refuse to do is spin: rounds that succeed without indexing a
  // single new page mean something is genuinely wrong, and that gets said.
  let visionPages = 0;
  let lastIndexed = -1;
  let noProgressRounds = 0;
  let transientFailures = 0;
  for (let i = 0; i < 2000; i++) {
    let out: {
      done: boolean; pageCount: number; pagesIndexed: number;
      visionPages?: number; visionSkipReason?: string | null;
    };
    try {
      out = await apiPost("/api/knowledge/ingest", { documentId });
      transientFailures = 0;
    } catch (e) {
      if (!(e as { transient?: boolean }).transient || ++transientFailures > 4) throw e;
      // Back off and pick up where the last committed batch stopped.
      await new Promise((r) => setTimeout(r, 1500 * transientFailures));
      continue;
    }
    visionPages += out.visionPages ?? 0;
    onIndex?.(out.pagesIndexed, out.pageCount, {
      indexed: out.pagesIndexed, total: out.pageCount,
      visionPages, visionSkipReason: out.visionSkipReason ?? null,
    });
    if (out.done) return;

    noProgressRounds = out.pagesIndexed > lastIndexed ? 0 : noProgressRounds + 1;
    lastIndexed = Math.max(lastIndexed, out.pagesIndexed);
    if (noProgressRounds >= 3) {
      throw new Error(
        `Indexing stalled at page ${out.pagesIndexed}${out.pageCount ? ` of ${out.pageCount}` : ""} — ` +
        "that page is taking longer than one server run allows. Turn off \"Index every page with " +
        "AI vision\" in Library AI setup if it's on, then rebuild.",
      );
    }
  }
  throw new Error("Indexing did not finish — reopen the library to resume.");
}

/** Thumbs-up/down on an answer. 1 = useful (its cited pages will seed
 *  retrieval for similar future questions), -1 = wrong/missed, 0 = clear. */
export async function rateKnowledgeAnswer(questionId: string, rating: 1 | -1 | 0): Promise<void> {
  await apiPost("/api/knowledge/feedback", { questionId, rating });
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  const { error } = await supabase.from("knowledge_documents").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Ask + history ─────────────────────────────────────────────────────────

export async function askKnowledgeLibrary(
  orgId: string, libraryId: string, question: string, mode: AskMode = "library",
  focus?: string[], inputs?: string,
  /** Conversation continuation: prior turns + the thread they belong to. */
  thread?: { history: Array<{ question: string; answer: string }>; threadId: string },
): Promise<KnowledgeAnswer> {
  return apiPost<KnowledgeAnswer>("/api/knowledge/ask", {
    orgId, libraryId, question, mode,
    ...(focus && focus.length > 0 ? { focus } : {}),
    ...(inputs ? { inputs } : {}),
    ...(thread ? { history: thread.history, threadId: thread.threadId } : {}),
  });
}

// ── What a follow-up may send back as context (IEDGE-5 / KACL-1) ────────────
//
// A conversation reopened from the saved record — a teammate's thread, one
// holding a turn the reader can no longer see, or a memory-card answer —
// starts a NEW thread, so the follow-up is filed under the reader. Those
// seeded turns were built under someone else's ACL (or an earlier one) and
// the new thread records nothing of them, so the history rule could never
// withhold a follow-up that restated them. They are therefore SHOWN, never
// sent: `seeded` counts the leading turns of the thread that came from the
// saved record, and only the turns after them go back to the model.

/** Turns sent back as context with a follow-up (the latest ones). */
export const ASK_CONTEXT_TURNS = 4;

/** The history a follow-up sends: the turns after the `seeded` ones, the
 *  last ASK_CONTEXT_TURNS of them. An unreadable `seeded` sends nothing. */
export function askContextHistory(
  thread: ReadonlyArray<{ question: string; answer: { answer: string } }>,
  seeded: number,
): Array<{ question: string; answer: string }> {
  const from = Number.isFinite(seeded) ? Math.min(thread.length, Math.max(0, Math.floor(seeded))) : thread.length;
  return thread.slice(from).slice(-ASK_CONTEXT_TURNS).map((t) => ({ question: t.question, answer: t.answer.answer }));
}

/** The active conversation as mirrored to sessionStorage: the last `keep`
 *  turns, with the seeded count re-based onto them. */
export function persistedThread<T>(turns: readonly T[], seeded: number, keep = 6): { turns: T[]; seeded: number } {
  const kept = turns.slice(-keep);
  const safe = Number.isFinite(seeded) ? Math.max(0, Math.floor(seeded)) : turns.length;
  return { turns: kept, seeded: Math.min(kept.length, Math.max(0, safe - (turns.length - kept.length))) };
}

/** The seeded count of a restored conversation. A saved conversation that
 *  does not say (written before this rule) is treated as seeded whole —
 *  shown, nothing of it sent. */
export function restoredSeeded(saved: { turns?: readonly unknown[] | null; seeded?: unknown }): number {
  const n = saved.turns?.length ?? 0;
  return typeof saved.seeded === "number" && Number.isFinite(saved.seeded)
    ? Math.min(n, Math.max(0, Math.floor(saved.seeded)))
    : n;
}

/** SEM-12: what an answer's retrieval flag means, in words, for every reader.
 *  "keyword" is not a degraded state to hide — it is what this product has
 *  always done well — but an answer must never IMPLY a meaning search that
 *  did not run, and a 3%-built index must never read like a 100% one. */
export const MEANING_COVERAGE_NOTE_BELOW = 95;
export function describeRetrieval(
  retrieval: KnowledgeAnswer["retrieval"],
  coverage: { embedded: number; total: number } | null | undefined,
): { label: string; note: string | null; keywordOnly: boolean; emphasize: boolean } | null {
  if (!retrieval) return null;
  const pct = coverage && coverage.total > 0 ? Math.floor((coverage.embedded / coverage.total) * 100) : null;
  if (retrieval === "keyword") {
    return {
      label: "Keyword search only",
      keywordOnly: true,
      // A library that never built a meaning index answers by keyword as it
      // always has: the chip says so; the note box is for a library that HAS
      // an index this answer did not use.
      emphasize: pct !== null && pct > 0,
      note: "Meaning search did not run for this answer"
        + (pct === null ? "" : pct === 0 ? " — this library has no meaning index yet" : ` — the meaning index covers ${pct}% of this library`)
        + ". A passage that says the same thing in other words may be missing.",
    };
  }
  const partial = pct !== null && pct < MEANING_COVERAGE_NOTE_BELOW;
  return {
    label: "Keyword + meaning search",
    keywordOnly: false,
    emphasize: partial,
    note: partial
      ? `Meaning search covers ${pct}% of this library — passages without a meaning vector were found by keyword only.`
      : null,
  };
}

/** ASK-6: the screen for model-written text shown at an input or on a
 *  button — pure, so the ask route can apply the same screen server-side. */
export { screenAssistantRequest, ASSISTANT_REQUEST_MAX } from "@/lib/assistantScreen";

/** A calculation answer that stopped because it needs user-specific values
 *  (test temperature, design pressure…) starts with a **Need:** line —
 *  detect it so the UI can ask instead of showing a dead-end answer. */
export function parseNeedPrompt(answer: string): string | null {
  const m = answer.trim().match(/^\*\*Need:\*\*\s*([\s\S]+)$/);
  return m ? m[1].trim() : null;
}

/** Ask memory: past answers in THIS library that match the question, offered
 *  before a fresh AI call. Served by /api/knowledge/history, which withholds
 *  every answer citing a document the reader cannot open — the card never
 *  replays what the original asker's ACL admitted (ASK-1). Best-effort: a
 *  failure answers [] and the ask goes ahead. */
export interface PastAsk {
  id: string; library_id: string; question: string; answer: string;
  user_name: string | null; created_at: string;
  citations: unknown;
}

/** One row as /api/knowledge/history returns it. */
interface HistoryRowWire {
  id: string; libraryId: string; threadId: string | null; question: string; answer: string | null;
  citations: unknown; userName: string | null; mode: AskMode; createdAt: string; mine: boolean;
}

const toQuestion = (r: HistoryRowWire): KnowledgeQuestion => ({
  id: r.id,
  threadId: r.threadId ?? null,
  question: r.question,
  answer: r.answer ?? null,
  citations: Array.isArray(r.citations) ? (r.citations as KnowledgeCitation[]) : [],
  userName: r.userName ?? null,
  mode: r.mode === "internet" ? "internet" : "library",
  createdAt: r.createdAt,
  mine: r.mine === true,
});

export async function searchAskHistory(
  orgId: string, libraryId: string, query: string, limit = 5,
): Promise<PastAsk[]> {
  const q = query.trim();
  if (q.length < 8) return []; // too short to mean anything
  try {
    const out = await apiPost<{ rows: HistoryRowWire[] }>("/api/knowledge/history", {
      orgId, libraryId, action: "search", query: q, limit,
    });
    // The route reads at least its default for a search (its answer must not
    // depend on the caller's window), and a smaller limit's answer is a prefix
    // of that one — so the caller's own limit is applied here.
    return (out.rows ?? []).filter((r) => typeof r.answer === "string").map((r) => ({
      id: r.id, library_id: r.libraryId, question: r.question, answer: r.answer as string,
      user_name: r.userName ?? null, created_at: r.createdAt, citations: r.citations,
    })).slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/** The library's recent answers as THIS reader may see them. A failure is
 *  reported on the page, never shown as an empty record. */
export async function listKnowledgeQuestions(
  orgId: string, libraryId: string, limit = 25,
): Promise<KnowledgeHistoryPage> {
  try {
    const out = await apiPost<{ rows: HistoryRowWire[]; withheld: number }>("/api/knowledge/history", {
      orgId, libraryId, action: "list", limit,
    });
    return { questions: (out.rows ?? []).map(toQuestion), withheld: Number(out.withheld) || 0 };
  } catch (e) {
    return { questions: [], withheld: 0, error: (e as Error).message };
  }
}

/** Every turn of one conversation this reader may see, oldest first. A turn
 *  after a withheld one is withheld too — it was answered with it as context. */
export async function loadConversation(
  orgId: string, libraryId: string, threadId: string,
): Promise<KnowledgeHistoryPage> {
  const out = await apiPost<{ rows: HistoryRowWire[]; withheld: number }>("/api/knowledge/history", {
    orgId, libraryId, action: "thread", threadId,
  });
  return { questions: (out.rows ?? []).map(toQuestion), withheld: Number(out.withheld) || 0 };
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
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Couldn't load AI settings (HTTP ${res.status})`);
  }
  return data;
}

export async function saveAiConnection(input: {
  orgId: string; scope: "org" | "personal"; provider: string; model: string; apiKey?: string;
}): Promise<void> {
  await apiPost("/api/ai/connection", input);
}

/**
 * Save (or clear) the embeddings key.
 *
 * Deliberately a separate call from the chat key: they are different services
 * with different providers, and collapsing them is what made semantic search
 * unreachable for anyone using Claude.
 */
export async function saveEmbeddingKey(input: {
  orgId: string;
  embeddingProvider: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
}): Promise<void> {
  await apiPost("/api/ai/connection", { action: "embedding", ...input });
}

export async function removeEmbeddingKey(orgId: string): Promise<void> {
  await apiPost("/api/ai/connection", { action: "embedding", orgId, clearEmbedding: true });
}

/** Live 1-word embed call against the pasted key (or the saved one when no
 *  key given) — a bad Voyage/OpenAI key fails here with a clear message. */
export async function testEmbeddingKey(input: {
  orgId: string; embeddingProvider?: string; embeddingModel?: string; embeddingApiKey?: string;
}): Promise<{ ok: boolean }> {
  return apiPost("/api/ai/connection", { action: "embedding-test", ...input });
}

/** Fields the ask API attaches to a 428 when the user hasn't yet signed the
 *  acceptable-use agreement — apiPost carries them onto the thrown Error. */
export interface AgreementRequiredError extends Error {
  agreementRequired?: boolean;
  agreementText?: string;
  agreementVersion?: string;
}

/** Record the current user's acceptance of the AI acceptable-use agreement
 *  (current version) for this workspace. */
export async function acceptAiAgreement(orgId: string): Promise<void> {
  await apiPost("/api/ai/agreement", { orgId });
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

// ── AI usage meter + monthly caps ──────────────────────────────────────────

export interface AiUsageSummary {
  spentUsd: number;
  capUsd: number;
  percent: number;
  inputTokens: number;
  outputTokens: number;
  asks: number;
  avgPromptTokens: number;
  monthLabel: string;
  /** Controllers only — the org-default cap and everyone's month spend. */
  orgCapUsd?: number;
  team?: Array<{
    userId: string; name: string; spentUsd: number; asks: number;
    inputTokens: number; outputTokens: number;
    /** The cap that actually applies to this person (override or default). */
    capUsd: number;
    /** True when this person has their own cap instead of the org default. */
    hasOverride: boolean;
  }>;
}

export async function getAiUsage(orgId: string): Promise<AiUsageSummary> {
  const token = await authToken();
  const res = await fetch(`/api/ai/usage?orgId=${encodeURIComponent(orgId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Couldn't load AI usage (HTTP ${res.status})`);
  }
  return data as AiUsageSummary;
}

/** Controllers: set the org-default monthly cap, or one person's cap when
 *  userId is given. capUsd null (with userId) clears the person's override
 *  so they fall back to the org default. */
export async function setAiCap(orgId: string, capUsd: number | null, userId?: string): Promise<void> {
  await apiPost("/api/ai/usage", { orgId, capUsd, ...(userId ? { userId } : {}) });
}

// ── Knowledge sources: doc-control containers feeding a library ────────────

export interface KnowledgeSource {
  id: string;
  sourceType: "library" | "folder";
  sourceId: string;
  sourceName: string;
  createdByName: string | null;
  createdAt: string;
  documentCount: number;
}

export interface SourceBrowseResult {
  libraries: Array<{ id: string; name: string }>;
  folders: Array<{
    id: string; name: string; libraryId: string; libraryName: string;
    parentId: string | null; pathNames: string[];
  }>;
  canManage: boolean;
}

export interface SourceSyncResult {
  added: number;
  refreshed: number;
  removed: number;
  errors: string[];
}

async function apiGet<T>(url: string): Promise<T> {
  const token = await authToken();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function listKnowledgeSources(orgId: string, libraryId: string): Promise<{
  sources: KnowledgeSource[]; canManage: boolean;
}> {
  return apiGet(`/api/knowledge/sources?orgId=${encodeURIComponent(orgId)}&libraryId=${encodeURIComponent(libraryId)}`);
}

/** Document-control containers the CALLER can read (the picker's options —
 *  the server re-verifies on add, so this filter is convenience, not law). */
export async function browseKnowledgeContainers(orgId: string): Promise<SourceBrowseResult> {
  return apiGet(`/api/knowledge/sources?orgId=${encodeURIComponent(orgId)}&action=browse`);
}

export async function addKnowledgeSources(
  orgId: string,
  libraryId: string,
  add: Array<{ type: "library" | "folder"; id: string }>,
): Promise<SourceSyncResult & { linked: number }> {
  return apiPost("/api/knowledge/sources", { orgId, libraryId, add });
}

export async function syncKnowledgeSources(orgId: string, libraryId: string): Promise<SourceSyncResult> {
  return apiPost("/api/knowledge/sources", { orgId, libraryId, action: "sync" });
}

// ── Drawing intelligence (P&ID census, reference audit, register) ──────────

export interface DrawingIntel {
  sheetCount: number;
  readyCount: number;
  /** Ready documents that produced ZERO text — scanned images. */
  textlessCount?: number;
  census: import("./drawingText").EquipmentCensus;
  audit: import("./drawingText").RefAudit;
  suggestions: string[];
  /** OPC box numbers captured across the set (vision transcripts). */
  opcBoxCount?: number;
  /** Connector boxes whose number never reappears on the continuation
   *  sheet they name — the pairing check engineers do by eye. */
  opcUnreturned?: Array<{ box: string; from: string; to: string; line: string }>;
  /** Connectors with NO drawing number at all — broken by definition:
   *  nothing tells the reader where to continue. */
  opcNoRef?: Array<{ box: string; sheet: string; page: number; line: string }>;
  /** Per-sheet fact table — what each drawing actually produced. */
  sheets?: Array<{
    id: string; name: string; status: string;
    /** Pages the entity index holds NOTHING for — the fingerprint of an
     *  interrupted vision rebuild. Empty when every page produced tags. */
    gapPages?: number[];
    pages: number; pagesIndexed: number;
    chars: number; tags: number; visionPages: number;
    verdict: "text" | "vision" | "text-no-tags" | "empty" | "indexing" | "error";
    /** The identity the sheet's OWN title block declares ("025-PID-0101",
     *  or "025-A-1001 (12 sh)"). Null = no readable DRAWING NO field. */
    declared?: string | null;
    error: string | null;
  }>;
}

export async function getDrawingIntel(orgId: string, libraryId: string): Promise<DrawingIntel> {
  return apiGet(`/api/knowledge/drawing?orgId=${encodeURIComponent(orgId)}&libraryId=${encodeURIComponent(libraryId)}&action=census`);
}

/** Controllers: wipe and re-extract everything (chunks AND entities). The
 *  page's auto-indexer picks the stale docs up immediately. */
/**
 * Hold a document back from the AI, or let it back in.
 *
 * Excluding is destructive by design: the server deletes the document's
 * indexed copy in the same call, so the boundary is true the moment the UI
 * says it is. Un-excluding only clears the flag — the next sync re-mirrors
 * and re-indexes from the CURRENT version, which is the only file the model
 * should ever be shown.
 */
export async function setDocumentAiExclusion(
  orgId: string, documentId: string, excluded: boolean,
): Promise<{ excluded: boolean; purged: number }> {
  return apiPost("/api/knowledge/exclusion", { orgId, documentId, excluded });
}

export interface SemanticProgress {
  /** Passages embedded by THIS call. */
  embedded: number;
  /** Retrievable passages — those of documents that are indexed and
   *  searchable (SEM-5: the same population meaning search returns). */
  total: number;
  coveredNow: number;
  /** Still to embed. Passages the provider refused are NOT counted here —
   *  they are `failed`, and do not hold the library below done (SEM-4). */
  remaining: number;
  done: boolean;
  error: string | null;
  spentThisRun: number;
  /** Provider said "slow down" (free-tier RPM/TPM). Pacing, not failure. */
  rateLimited?: boolean;
  retryAfterMs?: number;
  /** Passages the provider refused every time — skipped, with where they are. */
  failed?: number;
  /** Where they are — for controllers only; other readers get the count. */
  failedSamples?: Array<{ documentName: string; page: number; error: string | null }>;
  /** Passages another run is embedding right now (SEM-7: the queue is a claim). */
  busy?: number;
  /** Passages the provider refused that wait to be offered again (SEM-4) —
   *  nobody is embedding them; the background build retries them. */
  waiting?: number;
  /** Passages the provider refused during THIS call (an attempt recorded). */
  refused?: number;
  /** Vectors per embedding model, and whether the library holds more than
   *  one (then meaning search is off for it until rebuilt — SEM-1). */
  models?: Record<string, number>;
  mixed?: boolean;
  /** The viewer's embedding setup (never the key). */
  connection?: { provider: string; model: string } | null;
  /** Why building with the viewer's setup would mix two vector spaces. */
  conflict?: string | null;
  /** SEM-13: the price, from the ledger's own table, for the viewer's model. */
  estimate?: { model: string; remainingUsd: number; fullUsd: number; placeholderRate: boolean } | null;
  /** The background continuation, and why it is holding off (SEM-11). */
  background?: {
    mine: boolean; standing: boolean; startedAt: string | null; lastDrainAt: string | null;
    blockedUntil: string | null; blockedReason: string | null; lastError: string | null;
  } | null;
  /** The background continuation could not be recorded this time. */
  backgroundNote?: string;
  /** Reset: another member's background build / standing consent was ended
   *  so the rebuild runs on the caller's own key. */
  backgroundCleared?: boolean;
}

/** Coverage only — spends nothing, so it's safe to call on page load. */
/** Tell the knowledge layer a doc-control library's contents changed —
 *  upload, move, restructure — so any AI library watching it re-syncs NOW
 *  instead of at the next cron heartbeat. Fire-and-forget by design: filing
 *  a document must never fail because the mirror hiccuped. */
export function nudgeKnowledgeSources(orgId: string, dcLibraryId: string): void {
  void apiPost("/api/knowledge/sources", { orgId, libraryId: "-", action: "dc-changed", dcLibraryId })
    .catch(() => { /* the cron remains the backstop */ });
}

export async function semanticStatus(orgId: string, libraryId: string): Promise<SemanticProgress> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, action: "status" });
}

/** One nudge per tab per this long: navigating between libraries must not
 *  fan out a 300-second drain per page view (SEM-7). The server skips a
 *  library drained in the last two minutes as well. */
const NUDGE_DEBOUNCE_MS = 10 * 60_000;
let lastNudgeAt = 0;

/** Fire-and-forget: ask the server to continue any pending meaning-index
 *  build in the background (up to ~4 minutes of server-side embedding).
 *  Called on library page load so merely OPENING the app advances a large
 *  build — the browser tab stopped being the engine. Never awaited, never
 *  surfaces errors: the daily cron covers whatever this misses. */
export function nudgeEmbedDrain(): void {
  const now = Date.now();
  let last = lastNudgeAt;
  try { last = Math.max(last, Number(window.sessionStorage.getItem("kl-embed-nudge-at")) || 0); } catch { /* no storage */ }
  if (now - last < NUDGE_DEBOUNCE_MS) return;
  lastNudgeAt = now;
  try { window.sessionStorage.setItem("kl-embed-nudge-at", String(now)); } catch { /* no storage */ }
  void (async () => {
    try {
      const token = await authToken();
      void fetch("/api/cron/embed-drain", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        keepalive: true,
      }).catch(() => undefined);
    } catch { /* signed out — nothing to nudge */ }
  })();
}

/** Clear every vector in a library so the next build re-embeds from scratch.
 *
 *  Needed whenever the thing that PRODUCED the vectors changes — better
 *  chunking at ingestion, a different embedding model. The build only fills
 *  passages whose vector is null, so without this an upgrade reaches only
 *  documents added afterwards and the library sits half-indexed under two
 *  regimes at once. */
export async function resetSemanticIndex(orgId: string, libraryId: string): Promise<SemanticProgress> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, action: "reset" });
}

/** Give the passages the provider refused another chance (controllers). */
export async function retryFailedPassages(orgId: string, libraryId: string): Promise<{ requeued: number }> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, action: "retry-failed" });
}

/** SEM-8: the standing consent — keep this library's meaning index current
 *  as documents are added, on the caller's own key and monthly cap. */
export async function setKeepIndexCurrent(orgId: string, libraryId: string, on: boolean): Promise<{ standing: boolean }> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, action: "keep-current", on });
}

/** Stop the background build (its payer, or a controller). */
export async function releaseBackgroundBuild(orgId: string, libraryId: string): Promise<{ released: boolean }> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, action: "release" });
}

/** What the panel says after a background-build control, decided by what the
 *  route ANSWERED — never by the call merely returning (SEM-8 / SEM-11): a
 *  Stop that found nothing running stopped nothing, and a consent flag that
 *  came back other than the one asked for was not recorded. (A refused or
 *  failed write is a non-2xx, which apiPost throws.) */
export type EmbedControlOutcome = { type: "success" | "info" | "error"; title: string };
export function releaseOutcome(out: { released?: unknown } | null | undefined): EmbedControlOutcome {
  if (out?.released === true) return { type: "success", title: "Background build stopped." };
  if (out?.released === false) return { type: "info", title: "No background build was running any more — nothing was stopped." };
  return { type: "error", title: "The server didn't say whether the background build stopped — look at it again." };
}
export function retryOutcome(out: { requeued?: unknown } | null | undefined): EmbedControlOutcome {
  const n = typeof out?.requeued === "number" ? out.requeued : null;
  if (n === null) return { type: "error", title: "The server didn't say whether the refused passages were queued — look at them again." };
  if (n === 0) return { type: "info", title: "No refused passages were waiting any more — nothing was queued." };
  return { type: "success", title: `Queued ${n.toLocaleString()} refused passage${n === 1 ? "" : "s"} for another try.` };
}
export function keepCurrentOutcome(out: { standing?: unknown } | null | undefined, asked: boolean): EmbedControlOutcome {
  if (out?.standing === asked) {
    return { type: "success", title: asked ? "This library's meaning index will be kept current." : "No longer kept current in the background." };
  }
  return {
    type: "error",
    title: asked
      ? "The standing consent was not recorded — look at it again."
      : "The standing consent was not withdrawn — it may still be spending; look at it again.",
  };
}

/** SEM-8: the one-line drift statement every reader sees on the library page
 *  — null when the index is complete, not built at all, or unknown. It says
 *  what is true either way — passages added since a build, or a build that
 *  was stopped part-way — without claiming which. */
export function meaningIndexDrift(status: Pick<SemanticProgress, "total" | "coveredNow" | "remaining"> | null): string | null {
  if (!status || status.total <= 0) return null;
  const covered = status.coveredNow ?? 0;
  if (covered <= 0 || status.remaining <= 0) return null;
  const pct = Math.floor((covered / status.total) * 100);
  const one = status.remaining === 1;
  return `Meaning search covers ${pct}% of this library — ${status.remaining.toLocaleString()} passage${one ? "" : "s"} ${one ? "doesn't" : "don't"} carry a meaning vector yet and ${one ? "is" : "are"} found by keyword only.`;
}

/** Embed one batch. The server stops on a time budget rather than trying to
 *  finish, so callers LOOP until `done` — every committed batch is permanent,
 *  which is what makes this survivable on a platform that can kill a request
 *  at 60 seconds. */
export async function embedBatch(orgId: string, libraryId: string, batch?: number): Promise<SemanticProgress> {
  return apiPost("/api/knowledge/embed", { orgId, libraryId, ...(batch ? { batch } : {}) });
}

/**
 * Build the whole meaning index, batch by batch.
 *
 * Stops on the first server-reported error rather than looping into a
 * rejected key or an exhausted quota, and reports progress so the caller can
 * show something truthful while it runs.
 */
/** Small batch used once a free-tier TPM limit shows itself — sized so one
 *  call fits inside Voyage's no-card 10K tokens/minute window. */
const RATE_LIMITED_BATCH = 6;

export async function buildSemanticIndex(
  orgId: string, libraryId: string,
  onProgress?: (p: SemanticProgress) => void,
  shouldStop?: () => boolean,
): Promise<SemanticProgress> {
  // Once rate-limited, stay in paced mode for the rest of the build — the
  // provider's window doesn't grow back mid-run, and flapping between full
  // and tiny batches just burns the budget re-discovering the limit.
  let paced = false;
  const sleepUnlessStopped = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !shouldStop?.()) {
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  // Gateway hiccups (a 504 from an invocation the platform killed, a cold
  // start answering 502) are the WEATHER on serverless, not the build
  // failing — every committed batch is already permanent, so the only
  // correct response is to wait a moment and call again.
  let transientFailures = 0;
  const embedBatchWithRetry = async (batch?: number): Promise<SemanticProgress> => {
    for (;;) {
      try {
        const out = await embedBatch(orgId, libraryId, batch);
        transientFailures = 0;
        return out;
      } catch (e) {
        const transient = (e as { transient?: boolean }).transient;
        if (!transient || ++transientFailures > 5 || shouldStop?.()) throw e;
        await sleepUnlessStopped(3_000 * transientFailures);
      }
    }
  };

  let last = await embedBatchWithRetry();
  onProgress?.(last);
  // Rounds in a row where every remaining passage was claimed by another
  // run (the background drain): wait for it rather than calling that stuck.
  let busyRounds = 0;
  for (;;) {
    if (last.done || last.error || shouldStop?.()) break;
    if (last.rateLimited) {
      // Pacing, not failure: wait out the provider's per-minute window and
      // continue with a batch small enough to fit inside it.
      paced = true;
      busyRounds = 0;
      await sleepUnlessStopped(last.retryAfterMs ?? 65_000);
      if (shouldStop?.()) break;
    } else if (last.embedded === 0 && (last.busy ?? 0) > 0 && (last.busy ?? 0) + (last.waiting ?? 0) >= last.remaining) {
      // Another run holds the rest (SEM-7): the passages are being embedded,
      // just not by this tab. Give it a moment, a bounded number of times.
      if (++busyRounds > 6) break;
      await sleepUnlessStopped(20_000);
      if (shouldStop?.()) break;
    } else if ((last.busy ?? 0) === 0 && (last.waiting ?? 0) > 0 && (last.waiting ?? 0) >= last.remaining) {
      // Everything left was refused by the provider and waits to be offered
      // again (SEM-4): nobody is embedding it, and this tab has nothing to
      // do until then. Say so rather than wait on a build that isn't running.
      break;
    } else if (last.embedded === 0 && (last.refused ?? 0) === 0) {
      // Embedded nothing, refused nothing, not done, not rate-limited —
      // stuck. Hand back what happened rather than spinning forever.
      break;
    } else {
      busyRounds = 0;
    }
    last = await embedBatchWithRetry(paced ? RATE_LIMITED_BATCH : undefined);
    onProgress?.(last);
  }
  return last;
}

export async function rebuildDrawingIndex(orgId: string, libraryId: string): Promise<{ docs: number }> {
  return apiPost("/api/knowledge/drawing", { orgId, libraryId, action: "rebuild" });
}

export interface RecordedAuditSheet {
  sheetNumber: string;
  revision: string;
  status: "passed" | "broken_connectors" | "flagged" | "skipped";
  findings: string[];
}

/** Commit the reference audit to the permanent record — one verdict per
 *  sheet, filed under the revision that was read. The server recomputes it;
 *  a verdict the browser could dictate would be worthless. */
export async function recordDrawingAudit(orgId: string, libraryId: string): Promise<{
  recorded: number;
  counts: Partial<Record<RecordedAuditSheet["status"], number>>;
  sheets: RecordedAuditSheet[];
}> {
  return apiPost("/api/knowledge/drawing", { orgId, libraryId, action: "record-audit" });
}

export interface TagPosition {
  tag: string;
  /** 0..1 from the left edge / from the TOP edge. */
  nx: number;
  ny: number;
  /** "text" = exact, from the PDF's coordinates. "vision" = the model
   *  looked at the page and pointed — close, not surveyed. */
  source: "text" | "vision";
}

/** A tag that isn't on the open page, with where it actually lives — the
 *  viewer turns these into jump buttons. */
export interface TagElsewhere {
  tag: string;
  documentId: string;
  documentName: string;
  fileKey: string;
  page: number;
  sameDocument: boolean;
}

/** Where these tags sit on a drawing sheet, so the viewer can point at them.
 *  Cheap and cached; the first ask on an AI-read sheet costs one small call. */
export async function locateTagsOnPage(input: {
  orgId: string; documentId: string; page: number; tags: string[];
}): Promise<{
  positions: TagPosition[];
  notOnPage?: string[];
  notVisible?: string[];
  elsewhere?: TagElsewhere[];
  skipped?: string;
}> {
  return apiPost("/api/knowledge/locate", input);
}


/** Download the equipment register as CSV (opens straight into Excel). */
export async function downloadEquipmentRegister(orgId: string, libraryId: string): Promise<void> {
  const token = await authToken();
  const res = await fetch(
    `/api/knowledge/drawing?orgId=${encodeURIComponent(orgId)}&libraryId=${encodeURIComponent(libraryId)}&action=export`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "equipment-register.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export async function removeKnowledgeSource(orgId: string, sourceId: string): Promise<void> {
  const token = await authToken();
  const res = await fetch("/api/knowledge/sources", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ orgId, sourceId }),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
}
