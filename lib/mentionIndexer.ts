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
  // is the count a human would give.
  const byPage = new Map<number, string>();
  for (let from = 0; ; from += CHUNK_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_chunks")
      .select("document_id, page, content")
      .eq("org_id", orgId)
      .eq("document_id", knowledgeDocumentId)
      .order("page", { ascending: true })
      .order("seq", { ascending: true })
      .range(from, from + CHUNK_PAGE - 1);
    if (error) throw new Error(`mention index: ${error.message}`);
    const rows = (data ?? []) as ChunkRow[];
    for (const c of rows) {
      byPage.set(c.page, `${byPage.get(c.page) ?? ""}\n${c.content}`);
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
  if (delErr) throw new Error(`mention index cleanup: ${delErr.message}`);

  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    const { error } = await supabaseAdmin
      .from("entity_mentions")
      .upsert(batch, { onConflict: "asset_id,knowledge_document_id,page", ignoreDuplicates: false });
    if (error) throw new Error(`mention index write: ${error.message}`);
    result.mentionsWritten += batch.length;
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
