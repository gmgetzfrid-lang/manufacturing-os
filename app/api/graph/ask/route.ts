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
// Two answer modes, and it is always honest about which one you got:
//   EVIDENCE  — ranked passages with citations. No AI key needed, never wrong,
//               always available.
//   ANSWERED  — the same evidence, plus a written answer grounded in it, when
//               the org has a key configured. Citations are the evidence rows;
//               nothing is asserted that isn't in them.
//
// Security: org membership is checked here, and the corpus RPC runs
// SECURITY INVOKER under the caller's own RLS, so this can never widen what
// the person is allowed to read.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Passages pulled before ranking down to what we show. */
const RETRIEVE = 40;
/** Documents surfaced. More than this is a list, not an answer. */
const MAX_DOCS = 8;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
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
  mode: "evidence" | "answered";
  question: string;
  answer: string | null;
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

  const hits: GraphAskHit[] = ((rawHits ?? []) as Array<{
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

  if (hits.length === 0) {
    return NextResponse.json<GraphAskResponse>({
      mode: "evidence", question, answer: null, hits: [], nodeIds: [], assets: [],
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

  const { data: mentions } = await supabaseAdmin
    .from("entity_mentions")
    .select("asset_id, context_snippet, mention_count, document_id, assets(tag)")
    .eq("org_id", orgId)
    .in("knowledge_document_id", kdocIds)
    .order("confidence", { ascending: false })
    .limit(200);

  // PostgREST types an embedded relation as an array; at runtime a to-one
  // join is an object. Normalise rather than trusting either shape.
  for (const m of (mentions ?? []) as unknown as Array<{
    asset_id: string; context_snippet: string; mention_count: number;
    document_id: string | null; assets: { tag: string } | { tag: string }[] | null;
  }>) {
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
  // document node directly.
  const { data: mirrors } = await supabaseAdmin
    .from("knowledge_documents")
    .select("id, source_document_id")
    .in("id", kdocIds);
  for (const r of (mirrors ?? []) as Array<{ id: string; source_document_id: string | null }>) {
    if (r.source_document_id) nodeIds.add(`doc:${r.source_document_id}`);
  }

  const payload: GraphAskResponse = {
    mode: "evidence",
    question,
    answer: null,
    hits: shown,
    nodeIds: [...nodeIds],
    assets: [...assets.values()].sort((a, b) => b.count - a.count).slice(0, 12),
  };

  if (payload.nodeIds.length === 0) {
    payload.note = "Found passages, but none of these documents are linked to equipment yet — run the mention indexer to place them on the map.";
  }

  return NextResponse.json(payload);
}
