// lib/mentionIndexer.ts — SERVER-ONLY. Runs the mention engine over the
// indexed corpus and writes the evidence rows the graph reads.
//
// The pure matching lives in lib/mentionIndex.ts and is unit-tested there.
// This file is the plumbing: load the org's equipment dictionary once, stream
// the chunks, match, and upsert one row per (asset, document, page) with the
// sentence that proves it.
//
// Idempotent by construction — re-indexing a page replaces its mentions
// rather than stacking duplicates, so this can be re-run after every ingest,
// after an alias is added, or as a full backfill, without ever corrupting
// the map.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  findMentions, summarizeByAsset, AUTO_LINK_CONFIDENCE,
  type AliasEntry,
} from "@/lib/mentionIndex";
import { pageTail } from "@/lib/knowledgeText";

/** The head chunker 2 gives a page's first chunk when it carries in the
 *  previous page's unfinished sentence (ING-7: carriedTailMarker in
 *  lib/knowledgeText.ts, "[cont. from p. N] "). */
const CARRIED_HEAD_RE = /^\[cont\. from p\. (\d+)\] /;

/** A chunk as the mention engine reads it: without the sentence chunker 2
 *  carried in from page N (ING-7's handoff). Those words are page N's and
 *  are counted on page N; matched here too, a tag named in them would be
 *  counted on this page as well. They are cut exactly — the words carried
 *  are page N's own unfinished sentence, which pageTail reads back from its
 *  last chunk, as the ingest does across a batch boundary — never by a
 *  guess at where the carry ends: when page N's chunk is not at hand, or its
 *  sentence does not match, only the marker goes. A drawing sheet never
 *  carries, so a tag list is never touched. */
export function withoutCarriedSentence(content: string, lastChunkOfPage: (page: number) => string | undefined): string {
  const head = CARRIED_HEAD_RE.exec(content);
  if (!head) return content;
  const rest = content.slice(head[0].length);
  const words = pageTail(lastChunkOfPage(Number(head[1])) ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return rest;
  const carried = new RegExp(`^${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}`);
  const m = carried.exec(rest);
  return m ? rest.slice(m[0].length) : rest;
}

/** How many chunks we pull per round. Chunks are ~paragraph sized. */
const CHUNK_PAGE = 500;
/** Upsert batch — Supabase rejects unbounded payloads. */
const WRITE_BATCH = 500;

export interface IndexResult {
  chunksScanned: number;
  mentionsWritten: number;
  assetsTouched: number;
  /** Mentions below the auto-link line — evidence, not yet an edge. */
  lowConfidence: number;
}

/**
 * The org's equipment dictionary: every tag, plus every human alias.
 *
 * Tags come from the registry and are the highest-trust identity. Aliases
 * are the nicknames a normalizer can never derive ("the north exchanger",
 * a pre-renumber tag, a vendor's name for the same skid) and carry their
 * own origin so a vision guess never scores like a typed fact.
 */
export async function loadAliasDictionary(orgId: string): Promise<AliasEntry[]> {
  const [assets, aliases] = await Promise.all([
    supabaseAdmin.from("assets").select("id, tag").eq("org_id", orgId).eq("archived", false),
    supabaseAdmin.from("asset_aliases").select("asset_id, alias, origin").eq("org_id", orgId),
  ]);

  const dict: AliasEntry[] = [];
  for (const a of (assets.data ?? []) as Array<{ id: string; tag: string }>) {
    if (a.tag) dict.push({ assetId: a.id, alias: a.tag, origin: "tag" });
  }
  for (const r of (aliases.data ?? []) as Array<{ asset_id: string; alias: string; origin: string }>) {
    const origin = r.origin === "extraction" || r.origin === "vision" ? r.origin : "human";
    dict.push({ assetId: r.asset_id, alias: r.alias, origin });
  }
  return dict;
}

/** WIRE-2: a mention-index failure is logged where it happens, so a caller
 *  that treats mention edges as a bonus (the ingest route) cannot make it
 *  invisible — and then thrown to the caller. */
function fail(message: string, knowledgeDocumentId: string): never {
  console.error("[mentionIndexer]", message, { knowledgeDocumentId });
  throw new Error(message);
}

interface ChunkRow {
  document_id: string;
  page: number;
  content: string;
}

/**
 * Index one knowledge document.
 *
 * `mirrorDocumentId` is the controlled document this knowledge doc mirrors,
 * when there is one — carrying it means a mention can navigate to the
 * document-control surface, not just the knowledge viewer.
 */
export async function indexDocumentMentions(
  orgId: string,
  knowledgeDocumentId: string,
  dictionary: AliasEntry[],
  mirrorDocumentId?: string | null,
): Promise<IndexResult> {
  const result: IndexResult = { chunksScanned: 0, mentionsWritten: 0, assetsTouched: 0, lowConfidence: 0 };
  if (dictionary.length === 0) return result;

  // Page → concatenated text. Matching per PAGE rather than per chunk means
  // a tag split across a chunk boundary still lands, and the mention count
  // is the count a human would give. A sentence chunker 2 carried in from the
  // page before is read on its own page only (withoutCarriedSentence).
  const byPage = new Map<number, string>();
  const lastChunk = new Map<number, string>();
  for (let from = 0; ; from += CHUNK_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_chunks")
      .select("document_id, page, content")
      .eq("org_id", orgId)
      .eq("document_id", knowledgeDocumentId)
      .order("page", { ascending: true })
      .order("seq", { ascending: true })
      .range(from, from + CHUNK_PAGE - 1);
    if (error) fail(`mention index: ${error.message}`, knowledgeDocumentId);
    const rows = (data ?? []) as ChunkRow[];
    for (const c of rows) {
      const own = withoutCarriedSentence(c.content, (page) => lastChunk.get(page));
      byPage.set(c.page, `${byPage.get(c.page) ?? ""}\n${own}`);
      lastChunk.set(c.page, c.content);
    }
    result.chunksScanned += rows.length;
    if (rows.length < CHUNK_PAGE) break;
  }

  const touched = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const [page, text] of byPage) {
    for (const s of summarizeByAsset(findMentions(text, dictionary))) {
      touched.add(s.assetId);
      if (s.confidence < AUTO_LINK_CONFIDENCE) result.lowConfidence += 1;
      rows.push({
        org_id: orgId,
        asset_id: s.assetId,
        knowledge_document_id: knowledgeDocumentId,
        document_id: mirrorDocumentId ?? null,
        page,
        context_snippet: s.snippet,
        matched_text: s.matchedText,
        mention_count: s.count,
        origin: s.origin,
        confidence: s.confidence,
        is_explicit: false,
      });
    }
  }

  // Replace this document's machine-derived mentions wholesale. Explicit
  // human pins survive — someone decided those, and a re-index is not a
  // decision.
  const { error: delErr } = await supabaseAdmin
    .from("entity_mentions")
    .delete()
    .eq("org_id", orgId)
    .eq("knowledge_document_id", knowledgeDocumentId)
    .eq("is_explicit", false);
  if (delErr) fail(`mention index cleanup: ${delErr.message}`, knowledgeDocumentId);

  // IRLS-4 / WIRE-2: the conflict target is the PLAIN unique index
  // (asset_id, knowledge_document_id, page) 20261126 creates — the old
  // COALESCE expression index could never be inferred (42P10 on every
  // batch). After the delete above the only rows left for this document are
  // explicit pins, so a conflict means a person's pin already holds that
  // (asset, page): DO NOTHING keeps it (an update would have overwritten a
  // human decision with machine text). A database without the plain index
  // yet answers 42P10: the batch is written with plain inserts instead, a
  // pinned (asset, page) skipped row by row. The count is rows actually
  // written; a failure is logged here and thrown — never swallowed.
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    const { data, error } = await supabaseAdmin
      .from("entity_mentions")
      .upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: true })
      .select("id");
    if (!error) { result.mentionsWritten += ((data as unknown[] | null) ?? []).length; continue; }
    if (error.code !== "42P10") fail(`mention index write: ${error.message}`, knowledgeDocumentId);
    const plain = await supabaseAdmin.from("entity_mentions").insert(batch).select("id");
    if (!plain.error) { result.mentionsWritten += ((plain.data as unknown[] | null) ?? []).length; continue; }
    if (plain.error.code !== "23505") fail(`mention index write: ${plain.error.message}`, knowledgeDocumentId);
    for (const row of batch) {
      const one = await supabaseAdmin.from("entity_mentions").insert(row).select("id");
      if (!one.error) { result.mentionsWritten += ((one.data as unknown[] | null) ?? []).length; continue; }
      if (one.error.code !== "23505") fail(`mention index write: ${one.error.message}`, knowledgeDocumentId);
    }
  }

  result.assetsTouched = touched.size;
  return result;
}

/**
 * Re-index every ready document in an org.
 *
 * Used after a bulk alias import, after the registry gains equipment, or the
 * first time this ships — the corpus is already indexed for search, it just
 * was never read for entities. `onProgress` exists so a long backfill can
 * report instead of appearing hung, which is the mistake that made bulk
 * upload feel broken.
 */
export async function backfillOrgMentions(
  orgId: string,
  onProgress?: (done: number, total: number) => void,
  deadline?: number,
): Promise<IndexResult & { documents: number; incomplete: boolean }> {
  const dictionary = await loadAliasDictionary(orgId);
  const { data, error } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("status", "ready");
  if (error) throw new Error(error.message);

  const docs = (data ?? []) as Array<{ id: string }>;
  const total: IndexResult & { documents: number; incomplete: boolean } = {
    chunksScanned: 0, mentionsWritten: 0, assetsTouched: 0, lowConfidence: 0,
    documents: 0, incomplete: false,
  };
  const assets = new Set<string>();

  for (const [i, d] of docs.entries()) {
    // A backfill that gets killed mid-flight must leave the rows it already
    // wrote intact and report what's left, not silently truncate.
    if (deadline && Date.now() > deadline) { total.incomplete = true; break; }
    const r = await indexDocumentMentions(orgId, d.id, dictionary);
    total.chunksScanned += r.chunksScanned;
    total.mentionsWritten += r.mentionsWritten;
    total.lowConfidence += r.lowConfidence;
    total.documents += 1;
    onProgress?.(i + 1, docs.length);
  }
  total.assetsTouched = assets.size || total.assetsTouched;
  return total;
}
