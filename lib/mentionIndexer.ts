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
import { createHash } from "node:crypto";
import { pageTail } from "@/lib/knowledgeText";
import {
  startMentionRun, finishMentionRun, clearStandingFailure, saveBackfillCursor, clearBackfillCursor,
  BACKFILL_RESUME_MAX_MS, type BackfillState,
} from "@/lib/mentionRunState";

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

/** IRLS-14 (I-23 fix pass): what a rebuild reads WITH — a fingerprint of the
 *  equipment dictionary (every asset id, alias and origin, in a fixed order,
 *  hashed). A stopped rebuild is continued only while the dictionary is the
 *  same: documents read before an asset, tag or alias changed were matched
 *  against the old one, so a press after the change reads every document. */
export function dictionaryFingerprint(dictionary: readonly AliasEntry[]): string {
  const lines = dictionary.map((e) => `${e.assetId}\u0000${e.alias}\u0000${e.origin}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
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

/** Ready documents listed per window, in id order (keyset). */
const DOC_WINDOW = 500;
/** How often a running rebuild saves its place (IRLS-14 / I-23): a rebuild
 *  the platform kills between two saves continues from the last one. */
const PLACE_SAVE_MS = 10_000;

export interface BackfillResult extends IndexResult {
  documents: number;
  incomplete: boolean;
  /** I-23 — set only where the run state is recorded (20261194 pasted):
   *  this stopped rebuild's place is saved, so the next press continues. */
  resumable?: boolean;
  /** This press continued a rebuild that had not finished. */
  continued?: boolean;
  /** With `continued`: documents read by the whole rebuild so far. */
  passDocuments?: number;
  /** A rebuild had not finished, but this press did not continue it — it
   *  read from the first document: the equipment dictionary changed since
   *  that rebuild began ('equipment_changed'), or it began more than
   *  BACKFILL_RESUME_MAX_MS ago ('too_old'). */
  startedOver?: "equipment_changed" | "too_old";
}

/**
 * Re-index every ready document in an org.
 *
 * Used after a bulk alias import, after the registry gains equipment, or the
 * first time this ships — the corpus is already indexed for search, it just
 * was never read for entities. `onProgress` exists so a long backfill can
 * report instead of appearing hung, which is the mistake that made bulk
 * upload feel broken.
 *
 * IRLS-14 (intelligence Round G I-23): every rebuild is recorded in the
 * mention index's run state (lib/mentionRunState.ts, source 'map') — its
 * start, then how it ended: 'succeeded', 'stopped' at its time limit, or
 * 'failed' with the document and the error (in plain words) that stopped
 * it. The documents are read in id order, a window at a time. From its
 * start to its end a rebuild keeps its PLACE on the row: 'running' while it
 * reads (re-saved every PLACE_SAVE_MS with the last document it finished),
 * then 'time_limit' or 'failed' when it stops — with when the rebuild
 * began, how many documents it has read and the fingerprint of the
 * equipment dictionary it reads with (dictionaryFingerprint). The next
 * press continues after that document (a failing document is tried again
 * first) only when the dictionary is the same and the rebuild began less
 * than BACKFILL_RESUME_MAX_MS ago; otherwise it reads from the first
 * document, overwrites the place and says why (`startedOver`). A rebuild
 * that reads to the end clears the place, and the failure that stood when
 * it began. With the run state not installed (20261194 not pasted) nothing
 * is recorded and every press starts at the first document, as before.
 */
export async function backfillOrgMentions(
  orgId: string,
  onProgress?: (done: number, total: number) => void,
  deadline?: number,
): Promise<BackfillResult> {
  const dictionary = await loadAliasDictionary(orgId);
  const fingerprint = dictionaryFingerprint(dictionary);
  const run = await startMentionRun(supabaseAdmin, orgId, "map");
  // A place to continue: a document read, a rebuild begun within the bound
  // (the server's clock — the one that wrote it), the same dictionary.
  const found = run.backfill?.cursor && run.backfill.documents > 0 ? run.backfill : null;
  const began = Date.parse(found?.startedAt ?? "");
  const tooOld = found !== null && !(Number.isFinite(began) && Date.parse(run.startedAt) - began <= BACKFILL_RESUME_MAX_MS);
  const resume = found && !tooOld && found.dictionary === fingerprint ? found : null;
  const startedOver: BackfillResult["startedOver"] = found && !resume ? (tooOld ? "too_old" : "equipment_changed") : undefined;
  const passStartedAt = resume?.startedAt ?? run.startedAt;
  let passDocuments = resume?.documents ?? 0;
  let after: string | null = resume?.cursor ?? null;
  /** The last document this rebuild finished — where its place is saved. */
  let lastDone: string | null = after;
  let current: string | null = null;

  const total: BackfillResult = {
    chunksScanned: 0, mentionsWritten: 0, assetsTouched: 0, lowConfidence: 0,
    documents: 0, incomplete: false,
  };
  const assets = new Set<string>();
  // Progress is counted against what is left to read; asked only when someone listens.
  let toRead = 0;
  if (onProgress) {
    let q = supabaseAdmin.from("knowledge_documents").select("id", { count: "exact", head: true })
      .eq("org_id", orgId).eq("status", "ready");
    if (after) q = q.gt("id", after);
    toRead = (await q).count ?? 0;
  }
  const savePlace = (state: BackfillState) => saveBackfillCursor(supabaseAdmin, run, {
    cursor: lastDone, startedAt: passStartedAt, documents: passDocuments, state, dictionary: fingerprint,
  });
  // The place is this rebuild's from its start: while it reads, the map says
  // a rebuild is running and offers nothing to continue.
  if (run.recorded) await savePlace("running");
  let savedAt = Date.now();

  try {
    reading: for (;;) {
      let q = supabaseAdmin
        .from("knowledge_documents")
        .select("id, status")
        .eq("org_id", orgId)
        .eq("status", "ready")
        .order("id", { ascending: true })
        .limit(DOC_WINDOW);
      if (after) q = q.gt("id", after);
      current = null;
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const docs = (data ?? []) as Array<{ id: string }>;

      for (const d of docs) {
        // A backfill that gets killed mid-flight must leave the rows it already
        // wrote intact and report what's left, not silently truncate.
        if (deadline && Date.now() > deadline) { total.incomplete = true; break reading; }
        current = d.id;
        const r = await indexDocumentMentions(orgId, d.id, dictionary);
        current = null;
        total.chunksScanned += r.chunksScanned;
        total.mentionsWritten += r.mentionsWritten;
        total.lowConfidence += r.lowConfidence;
        total.documents += 1;
        passDocuments += 1;
        lastDone = d.id;
        onProgress?.(total.documents, Math.max(toRead, total.documents));
        // This document's own failure is superseded by this build of it.
        if (run.standingFailure?.documentId === d.id) await clearStandingFailure(supabaseAdmin, run);
        if (run.recorded && Date.now() - savedAt >= PLACE_SAVE_MS) { await savePlace("running"); savedAt = Date.now(); }
      }
      if (docs.length < DOC_WINDOW) break;
      after = docs[docs.length - 1].id;
    }
  } catch (e) {
    // The place stays at the last document finished, marked as a failure:
    // the next press tries the one that failed again. The route answers the
    // error as before.
    await savePlace("failed");
    await finishMentionRun(supabaseAdmin, run, { outcome: "failed", error: e, documentId: current });
    throw e;
  }

  if (total.incomplete) {
    const saved = await savePlace("time_limit");
    await finishMentionRun(supabaseAdmin, run, { outcome: "stopped" });
    if (saved && lastDone) total.resumable = true;
  } else {
    // The whole corpus is read: nothing is left to continue, and a failure
    // that stood before this rebuild began is superseded by it.
    await clearBackfillCursor(supabaseAdmin, run);
    const stood = run.standingFailure;
    if (stood && Date.parse(stood.at) <= Date.parse(passStartedAt)) await clearStandingFailure(supabaseAdmin, run);
    await finishMentionRun(supabaseAdmin, run, { outcome: "succeeded" });
  }
  if (run.recorded && resume) { total.continued = true; total.passDocuments = passDocuments; }
  if (run.recorded && startedOver) total.startedOver = startedOver;
  total.assetsTouched = assets.size || total.assetsTouched;
  return total;
}
