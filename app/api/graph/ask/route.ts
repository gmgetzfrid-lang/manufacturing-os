// /api/graph/ask — ask the graph a question in English.
//
// The graph's search box used to be a label filter: it matched the letters
// you typed against node NAMES and dimmed everything else. That cannot answer
// "do I have any standards about pipe supports", because the answer lives in
// the text of a document called PIP-STE-05121 and the word "pipe support"
// appears nowhere in its name.
//
// This searches the indexed corpus, then does the thing that makes it a GRAPH
// feature rather than a search box: it maps every hit back to node ids, so the
// caller can light up the exact region of the map that holds your answer. You
// see where the knowledge lives, not just a list.
//
// One answer mode, EVIDENCE: ranked passages with citations. No AI key
// needed, no model call, always available. This route never writes an
// answer (IEDGE-11): a written, cited answer is the knowledge ask route's
// job (/api/knowledge/ask), behind the governed key / agreement / cap gates
// every AI surface uses. The contract below says only what this returns.
//
// Security (GPV-1 / IEDGE-1): org membership is checked here, and then the
// asker's own document ACL is applied, because the corpus RPC does NOT run
// under the asker's RLS — it is called on the service-role key, which
// bypasses RLS entirely. A knowledge document that MIRRORS a controlled
// document (source_document_id set) is shown only when this asker may read
// that controlled document: loadPrincipal + readableControlledDocIds, the
// same seam /api/knowledge/ask uses, evaluated over the hits BEFORE ranking.
// Upload-origin knowledge documents (no source) stay org-readable. The
// equipment mentions and the mirror's document node are filtered the same
// way, so a hidden document cannot leak through nodeIds or an asset snippet.
// Fails CLOSED: if the mirror lookup cannot be read, no hit is returned; if
// the readable set cannot be computed, every source-linked hit is withheld.
// A withheld hit is never counted or named — the answer reads exactly as if
// nothing had matched.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadPrincipal, readableControlledDocIds, type KnowledgePrincipal } from "@/lib/knowledgeAccess";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Passages pulled before ranking down to what we show. */
const RETRIEVE = 40;
/** Documents surfaced. More than this is a list, not an answer. */
const MAX_DOCS = 8;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

/** Ids per `.in()` list. */
const IN_SLICE = 200;

/**
 * The asker's view of the knowledge documents behind a set of hits
 * (GPV-1 / IEDGE-1). `sourceOf` maps every MIRROR among them to its
 * controlled document; `hidden` is the mirrors this asker may not read.
 * `known` is false when the mirror lookup itself failed — then nobody can
 * say which hits are mirrors, and the caller withholds them all. A principal
 * or readable set that cannot be built hides every mirror (fail closed);
 * upload-origin documents are never hidden here.
 */
async function askerView(orgId: string, uid: string, kdocIds: string[]): Promise<{
  known: boolean;
  sourceOf: Map<string, string>;
  hidden: Set<string>;
  readable: Set<string>;
  principal: KnowledgePrincipal | null;
}> {
  const sourceOf = new Map<string, string>();
  for (let i = 0; i < kdocIds.length; i += IN_SLICE) {
    const { data, error } = await supabaseAdmin
      .from("knowledge_documents").select("id, source_document_id")
      .eq("org_id", orgId).in("id", kdocIds.slice(i, i + IN_SLICE))
      .not("source_document_id", "is", null);
    if (error) return { known: false, sourceOf, hidden: new Set(kdocIds), readable: new Set(), principal: null };
    for (const r of (data ?? []) as Array<{ id: string; source_document_id: string | null }>) {
      if (r.source_document_id) sourceOf.set(r.id, r.source_document_id);
    }
  }
  let principal: KnowledgePrincipal | null = null;
  let readable = new Set<string>();
  try {
    principal = await loadPrincipal(orgId, uid);
    if (principal && sourceOf.size > 0) {
      readable = await readableControlledDocIds(principal, [...new Set(sourceOf.values())]);
    }
  } catch {
    principal = null;
    readable = new Set();
  }
  const hidden = new Set([...sourceOf].filter(([, src]) => !principal || !readable.has(src)).map(([k]) => k));
  return { known: true, sourceOf, hidden, readable, principal };
}

export interface GraphAskHit {
  knowledgeDocumentId: string;
  documentName: string;
  libraryId: string;
  page: number;
  snippet: string;
  rank: number;
}

export interface GraphAskResponse {
  /** Always "evidence": passages, never a written answer (IEDGE-11). */
  mode: "evidence";
  question: string;
  hits: GraphAskHit[];
  /** Graph node ids to spotlight — documents AND the equipment they mention. */
  nodeIds: string[];
  /** Equipment the answering passages talk about, with proof. */
  assets: Array<{ assetId: string; tag: string; snippet: string; count: number }>;
  note?: string;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return bad("Unauthorized", 401);
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(authHeader.slice(7));
  if (authError || !user) return bad("Unauthorized", 401);

  let body: { orgId?: string; question?: string };
  try { body = await req.json(); } catch { return bad("Invalid JSON"); }
  const orgId = body.orgId?.trim();
  const question = body.question?.trim();
  if (!orgId || !question) return bad("orgId and question are required");
  if (question.length > 500) return bad("Question is too long");

  const { data: member } = await supabaseAdmin
    .from("org_members").select("uid")
    .eq("org_id", orgId).eq("uid", user.id).eq("status", "active").maybeSingle();
  if (!member) return bad("Forbidden", 403);

  // ── Retrieve ────────────────────────────────────────────────────────────
  // websearch_to_tsquery handles quoted phrases and OR/-, so "pipe support"
  // as a phrase works, and a bare question degrades to its content words
  // rather than returning nothing.
  const { data: rawHits, error: askErr } = await supabaseAdmin.rpc("graph_ask", {
    p_org_id: orgId,
    p_query: question,
    p_limit: RETRIEVE,
  });
  if (askErr) {
    // Pre-migration orgs get a clear instruction, not a stack trace.
    if (/does not exist/i.test(askErr.message)) {
      return bad("Search isn't installed yet — run migration 20260929_mention_engine.sql.", 503);
    }
    return bad(askErr.message, 500);
  }

  const allHits: GraphAskHit[] = ((rawHits ?? []) as Array<{
    knowledge_document_id: string; document_name: string; library_id: string;
    page: number; snippet: string; rank: number;
  }>).map((r) => ({
    knowledgeDocumentId: r.knowledge_document_id,
    documentName: r.document_name,
    libraryId: r.library_id,
    page: r.page,
    snippet: r.snippet,
    rank: r.rank,
  }));

  // ── Per-asker ACL, before ranking (GPV-1 / IEDGE-1) ──────────────────────
  // The RPC returned every org passage. Drop the mirrors of controlled
  // documents this asker may not read; if the mirror lookup failed, nothing
  // can be shown safely.
  const view = allHits.length > 0
    ? await askerView(orgId, user.id, [...new Set(allHits.map((h) => h.knowledgeDocumentId))])
    : null;
  const hits = view?.known ? allHits.filter((h) => !view.hidden.has(h.knowledgeDocumentId)) : [];

  if (!view || hits.length === 0) {
    return NextResponse.json<GraphAskResponse>({
      mode: "evidence", question, hits: [], nodeIds: [], assets: [],
      note: "Nothing in the indexed libraries matches that. Only documents toggled for indexing are searchable.",
    });
  }

  // Best passages per document, best documents first — one strong page beats
  // four weak ones from the same file.
  const byDoc = new Map<string, GraphAskHit[]>();
  for (const h of hits) {
    const list = byDoc.get(h.knowledgeDocumentId) ?? [];
    if (list.length < 3) list.push(h);
    byDoc.set(h.knowledgeDocumentId, list);
  }
  const topDocs = [...byDoc.entries()]
    .sort((a, b) => (b[1][0]?.rank ?? 0) - (a[1][0]?.rank ?? 0))
    .slice(0, MAX_DOCS);
  const shown = topDocs.flatMap(([, list]) => list);

  // ── Map the answer onto the map ─────────────────────────────────────────
  // This is the part a search box can't do. Every answering document is
  // resolved to its graph node, and so is every piece of equipment those
  // documents mention — so the map lights up the region that holds your
  // answer and you can see, spatially, where this knowledge lives.
  const kdocIds = topDocs.map(([id]) => id);
  const nodeIds = new Set<string>();
  const assets = new Map<string, { assetId: string; tag: string; snippet: string; count: number }>();

  // Only the surviving (readable) knowledge documents are fanned out.
  const { data: mentions } = await supabaseAdmin
    .from("entity_mentions")
    .select("asset_id, context_snippet, mention_count, document_id, assets(tag)")
    .eq("org_id", orgId)
    .in("knowledge_document_id", kdocIds)
    .order("confidence", { ascending: false })
    .limit(200);

  // PostgREST types an embedded relation as an array; at runtime a to-one
  // join is an object. Normalise rather than trusting either shape.
  type MentionRow = {
    asset_id: string; context_snippet: string; mention_count: number;
    document_id: string | null; assets: { tag: string } | { tag: string }[] | null;
  };
  const mentionRows = (mentions ?? []) as unknown as MentionRow[];
  // A mention row can name a controlled document directly (document_id),
  // whatever knowledge document it was read from: it is content of THAT
  // document, so it needs the same readability. Fails closed — a row whose
  // document cannot be confirmed readable is dropped.
  const directIds = [...new Set(mentionRows.map((m) => m.document_id).filter((d): d is string => !!d))]
    .filter((d) => !view.readable.has(d));
  const directReadable = new Set<string>();
  if (directIds.length > 0 && view.principal) {
    try {
      for (const d of await readableControlledDocIds(view.principal, directIds)) directReadable.add(d);
    } catch { /* fail closed: none confirmed */ }
  }
  const readableDoc = (d: string | null) => !d || view.readable.has(d) || directReadable.has(d);
  for (const m of mentionRows.filter((r) => readableDoc(r.document_id))) {
    const tagOf = Array.isArray(m.assets) ? m.assets[0]?.tag : m.assets?.tag;
    nodeIds.add(`asset:${m.asset_id}`);
    if (m.document_id) nodeIds.add(`doc:${m.document_id}`);
    const prior = assets.get(m.asset_id);
    if (prior) { prior.count += m.mention_count; continue; }
    assets.set(m.asset_id, {
      assetId: m.asset_id,
      tag: tagOf ?? "equipment",
      snippet: m.context_snippet,
      count: m.mention_count,
    });
  }

  // Knowledge documents that mirror a controlled document also light up their
  // document node directly — only the surviving ones, which this asker may
  // read (the mirror map was read once, above).
  for (const k of kdocIds) {
    const src = view.sourceOf.get(k);
    if (src) nodeIds.add(`doc:${src}`);
  }

  const payload: GraphAskResponse = {
    mode: "evidence",
    question,
    hits: shown,
    nodeIds: [...nodeIds],
    assets: [...assets.values()].sort((a, b) => b.count - a.count).slice(0, 12),
  };

  if (payload.nodeIds.length === 0) {
    payload.note = "Found passages, but none of these documents are linked to equipment yet — run the mention indexer to place them on the map.";
  }

  return NextResponse.json(payload);
}
