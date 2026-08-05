// lib/mentions.ts — reading the evidence behind a link, from the browser.
//
// Every function here answers one question: "why are these two things
// connected?" — and answers it with the sentence from the document, not with
// a row id. That's the whole difference between a graph you trust and a
// graph you close.

import { supabase } from "@/lib/supabase";

export interface MentionEvidence {
  assetId: string;
  assetTag: string;
  knowledgeDocumentId: string | null;
  documentId: string | null;
  documentName: string;
  page: number;
  snippet: string;
  matchedText: string;
  count: number;
  confidence: number;
  origin: string;
}

interface Row {
  asset_id: string;
  knowledge_document_id: string | null;
  document_id: string | null;
  page: number;
  context_snippet: string;
  matched_text: string;
  mention_count: number;
  confidence: number;
  origin: string;
  assets: { tag: string } | null;
  knowledge_documents: { name: string } | null;
}

const SELECT =
  "asset_id, knowledge_document_id, document_id, page, context_snippet, matched_text, " +
  "mention_count, confidence, origin, assets(tag), knowledge_documents(name)";

function shape(rows: Row[]): MentionEvidence[] {
  return rows.map((r) => ({
    assetId: r.asset_id,
    assetTag: r.assets?.tag ?? "equipment",
    knowledgeDocumentId: r.knowledge_document_id,
    documentId: r.document_id,
    documentName: r.knowledge_documents?.name ?? "document",
    page: r.page,
    snippet: r.context_snippet,
    matchedText: r.matched_text,
    count: r.mention_count,
    confidence: r.confidence,
    origin: r.origin,
  }));
}

/** Missing table = the migration hasn't run. That's a setup state, not an
 *  error to throw in someone's face while they're looking at a map. */
function tolerate(error: { code?: string; message: string } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || /does not exist/i.test(error.message);
}

/**
 * Every document that mentions this equipment — the backlinks panel.
 *
 * Ordered by mention count: the drawing that names E-101 forty times is more
 * about E-101 than the standard that names it once, and the panel should say
 * so without the reader doing arithmetic.
 */
export async function mentionsForAsset(orgId: string, assetId: string, limit = 60): Promise<MentionEvidence[]> {
  const { data, error } = await supabase
    .from("entity_mentions").select(SELECT)
    .eq("org_id", orgId).eq("asset_id", assetId)
    .order("mention_count", { ascending: false })
    .limit(limit);
  if (tolerate(error)) return [];
  if (error) throw new Error(error.message);
  return shape((data ?? []) as unknown as Row[]);
}

/** Every piece of equipment a document talks about, with proof. */
export async function mentionsForDocument(orgId: string, documentId: string, limit = 60): Promise<MentionEvidence[]> {
  const { data, error } = await supabase
    .from("entity_mentions").select(SELECT)
    .eq("org_id", orgId).eq("document_id", documentId)
    .order("mention_count", { ascending: false })
    .limit(limit);
  if (tolerate(error)) return [];
  if (error) throw new Error(error.message);
  return shape((data ?? []) as unknown as Row[]);
}

/** Same, for a knowledge-library document. */
export async function mentionsForKnowledgeDocument(orgId: string, knowledgeDocumentId: string, limit = 60): Promise<MentionEvidence[]> {
  const { data, error } = await supabase
    .from("entity_mentions").select(SELECT)
    .eq("org_id", orgId).eq("knowledge_document_id", knowledgeDocumentId)
    .order("mention_count", { ascending: false })
    .limit(limit);
  if (tolerate(error)) return [];
  if (error) throw new Error(error.message);
  return shape((data ?? []) as unknown as Row[]);
}

/**
 * Why is THIS edge here?
 *
 * Clicking a line between a document and a vessel should quote the sentence
 * that drew it. Returns the strongest evidence first — the defining sentence
 * beats the fortieth table row.
 */
export async function evidenceForEdge(
  orgId: string, assetId: string, documentId: string, isKnowledgeDoc: boolean,
): Promise<MentionEvidence[]> {
  const column = isKnowledgeDoc ? "knowledge_document_id" : "document_id";
  const { data, error } = await supabase
    .from("entity_mentions").select(SELECT)
    .eq("org_id", orgId).eq("asset_id", assetId).eq(column, documentId)
    .order("confidence", { ascending: false })
    .order("mention_count", { ascending: false })
    .limit(10);
  if (tolerate(error)) return [];
  if (error) throw new Error(error.message);
  return shape((data ?? []) as unknown as Row[]);
}

/** Is the mention engine installed and populated for this org? Drives the
 *  "run the indexer" prompt instead of an empty panel that looks broken. */
export async function mentionCoverage(orgId: string): Promise<{ installed: boolean; total: number }> {
  const { count, error } = await supabase
    .from("entity_mentions").select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if (tolerate(error)) return { installed: false, total: 0 };
  if (error) return { installed: true, total: 0 };
  return { installed: true, total: count ?? 0 };
}
