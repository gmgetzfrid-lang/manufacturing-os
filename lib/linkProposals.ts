// lib/linkProposals.ts — client-side reads and decisions on proposed links.
//
// Approving a proposal writes a real curated link carrying its provenance
// (which proposer found it, the evidence, who approved it), so the applied
// web can always explain itself. Dismissing keeps the row — that's the
// memory that stops the engine re-proposing the same pair forever.

import { supabase } from "@/lib/supabase";
import { carrierOrder, orderPair, TIER_RANK } from "@/lib/linkProposalLogic";
import { isMissingRelation } from "@/lib/orgGraph";

/** Built-in keys plus `rule:<id>` for org-authored Connection Skills.
 *  LNK-11: no similarity proposer runs, so none is named. */
export type ProposerKind = "opc" | "tag" | "alias" | "co_citation" | (string & {});
export type ProposalTier = "provable" | "strong" | "inferred";

export interface ProposalEvidence {
  summary?: string;
  detail?: string;
  tags?: string[];
  page?: number;
  /** Name of the Connection Skill that found it, for display. */
  rule?: string;
}

export interface LinkProposal {
  id: string;
  org_id: string;
  document_id: string;
  target_document_id: string;
  proposer: ProposerKind;
  tier: ProposalTier;
  confidence: number;
  evidence: ProposalEvidence;
  status: "pending" | "approved" | "dismissed" | "stale";
  source_rev: string | null;
  created_at: string;
  /** Hydrated for display. */
  doc?: DocStub | null;
  target?: DocStub | null;
}

export interface DocStub {
  id: string; document_number: string | null; title: string | null; library_id: string;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist/i.test(e.message ?? ""));

/** One label per detector that actually emits proposals (LNK-11). */
export const PROPOSER_LABELS: Record<string, string> = {
  opc: "Drawing cross-reference",
  tag: "Shared equipment",
  alias: "Equipment alias",
  co_citation: "Answered together",
};

/** Display name for whichever skill found a proposal — built-in key or an
 *  org-authored Connection Skill (whose name rides in the evidence). */
export function proposerLabel(proposer: string, evidence?: ProposalEvidence | null): string {
  return PROPOSER_LABELS[proposer] ?? evidence?.rule ?? "Custom skill";
}

export const TIER_LABELS: Record<ProposalTier, string> = {
  provable: "Provable",
  strong: "Strong",
  inferred: "Inferred",
};

/** A proposal decision RLS refused affects zero rows without an error —
 *  say so instead of reporting a decision that never happened. */
const REFUSED = "This proposal was not changed — it may already be decided, or your role cannot decide proposals.";

/** The queue, strongest first by tier RANK (provable, strong, inferred),
 *  then confidence (LNK-10: the tier text sorts 'inferred' first, so the
 *  ordering is by rank, one tier at a time, never by the column). Endpoints
 *  are read under the caller's RLS; since 20261126 so are the rows. */
export async function listProposals(orgId: string, opts?: {
  status?: LinkProposal["status"];
  limit?: number;
}): Promise<LinkProposal[]> {
  const limit = opts?.limit ?? 200;
  const tiers = (Object.keys(TIER_RANK) as ProposalTier[]).sort((a, b) => TIER_RANK[b] - TIER_RANK[a]);
  const rows: LinkProposal[] = [];
  for (const tier of tiers) {
    if (rows.length >= limit) break;
    const { data, error } = await supabase
      .from("proposed_links").select("*")
      .eq("org_id", orgId)
      .eq("status", opts?.status ?? "pending")
      .eq("tier", tier)
      .order("confidence", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit - rows.length);
    if (error) {
      if (missing(error)) return [];
      throw new Error(error.message);
    }
    rows.push(...((data as LinkProposal[]) ?? []));
  }
  if (rows.length === 0) return rows;

  const ids = [...new Set(rows.flatMap((r) => [r.document_id, r.target_document_id]))];
  const { data: docs } = await supabase
    .from("documents").select("id, document_number, title, library_id").in("id", ids);
  const byId = new Map(((docs as DocStub[]) ?? []).map((d) => [d.id, d]));
  for (const r of rows) {
    r.doc = byId.get(r.document_id) ?? null;
    r.target = byId.get(r.target_document_id) ?? null;
  }
  // A proposal whose endpoints this person can't read shouldn't be shown at
  // all — RLS hides the documents, so hide the proposal with them.
  return rows.filter((r) => r.doc && r.target);
}

export async function countPendingProposals(orgId: string): Promise<number> {
  const { count, error } = await supabase
    .from("proposed_links").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("status", "pending");
  if (error) return 0;
  return count ?? 0;
}

/** Approve → write the curated link with full provenance, then record the
 *  decision. If the pair is already linked — in EITHER direction — the
 *  proposal still resolves and no second row is written (LNK-13). The row
 *  is carried by the lower document number (DEC-62); both documents'
 *  Related panels render it. */
export async function approveProposal(p: LinkProposal, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const [a, b] = orderPair(p.document_id, p.target_document_id);
  const { data: already, error: readErr } = await supabase
    .from("document_related_resources").select("id")
    .or(`and(document_id.eq.${a},target_document_id.eq.${b}),and(document_id.eq.${b},target_document_id.eq.${a})`)
    .limit(1);
  if (readErr && !missing(readErr)) throw new Error(readErr.message);
  let numbers = new Map<string, string | null>();
  for (const d of [p.doc, p.target]) if (d) numbers.set(d.id, d.document_number);
  if (!numbers.has(p.document_id) || !numbers.has(p.target_document_id)) {
    const { data: docs } = await supabase
      .from("documents").select("id, document_number").in("id", [p.document_id, p.target_document_id]);
    numbers = new Map(((docs as Array<{ id: string; document_number: string | null }>) ?? []).map((d) => [d.id, d.document_number]));
  }
  const [carrier, other] = carrierOrder(
    { id: p.document_id, document_number: numbers.get(p.document_id) },
    { id: p.target_document_id, document_number: numbers.get(p.target_document_id) },
  );
  const { error: linkErr } = ((already as unknown[] | null) ?? []).length > 0
    ? { error: null }
    : await supabase.from("document_related_resources").insert({
    org_id: p.org_id,
    document_id: carrier,
    target_document_id: other,
    kind: "document",
    label: (p.evidence?.summary ?? "").slice(0, 120),
    origin: "proposed",
    proposer: p.proposer,
    evidence: p.evidence,
    created_by: actor.userId,
    created_by_name: actor.userName ?? null,
    approved_by: actor.userId,
    approved_by_name: actor.userName ?? null,
    sort_order: 0,
  });
  // 23505 = the pair is already linked; the decision below still stands.
  if (linkErr && linkErr.code !== "23505") throw new Error(linkErr.message);

  const { data, error } = await supabase.from("proposed_links").update({
    status: "approved",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", p.id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

/** Dismiss → the row stays as memory so the SAME skill never proposes this
 *  pair again (LNK-8: a different skill's different evidence still can). */
export async function dismissProposal(id: string, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const { data, error } = await supabase.from("proposed_links").update({
    status: "dismissed",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

/** LNK-8: a dismissal can be revisited — the proposal goes back to the
 *  queue as it was, and the decision that dismissed it is cleared. */
export async function reopenProposal(id: string): Promise<void> {
  const { data, error } = await supabase.from("proposed_links").update({
    status: "pending",
    decided_by: null,
    decided_by_name: null,
    decided_at: null,
  }).eq("id", id).eq("status", "dismissed").select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

/** Pending proposals touching one document — for the inspector's Related
 *  panel, so review can happen where the document is, not only in a queue. */
export async function listProposalsForDocument(documentId: string): Promise<LinkProposal[]> {
  const { data, error } = await supabase
    .from("proposed_links").select("*")
    .or(`document_id.eq.${documentId},target_document_id.eq.${documentId}`)
    .eq("status", "pending")
    .order("confidence", { ascending: false })
    .limit(12);
  if (error) return [];
  const rows = (data as LinkProposal[]) ?? [];
  if (rows.length === 0) return rows;
  const others = rows.map((r) => (r.document_id === documentId ? r.target_document_id : r.document_id));
  const { data: docs } = await supabase
    .from("documents").select("id, document_number, title, library_id").in("id", others);
  const byId = new Map(((docs as DocStub[]) ?? []).map((d) => [d.id, d]));
  for (const r of rows) {
    const otherId = r.document_id === documentId ? r.target_document_id : r.document_id;
    r.target = byId.get(otherId) ?? null;
    r.doc = null;
  }
  return rows.filter((r) => r.target);
}

/** Publish-time: ask the server to retire pending proposals derived from
 *  the revision this publish replaced (LNK-11). The sweep runs on the
 *  service role, org-scoped, against the document's CURRENT revision — it no
 *  longer depends on whether the publisher's role may write proposals (a
 *  library-granted or owner publisher used to stale nothing, silently). A
 *  stale proposal re-enters the queue when the next run re-derives it from
 *  the new text (LNK-1). Returns the count, or the reason it did not run. */
export async function requestProposalInvalidation(documentId: string): Promise<{ staled: number; error: string | null }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/links/invalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
      body: JSON.stringify({ documentId }),
    });
    const json = (await res.json().catch(() => ({}))) as { staled?: number; error?: string };
    if (!res.ok) return { staled: 0, error: json.error ?? `HTTP ${res.status}` };
    return { staled: json.staled ?? 0, error: null };
  } catch (e) {
    return { staled: 0, error: (e as Error).message };
  }
}

/** Every pending pair, for drawing ghost edges on the graph. Kept for any
 *  caller that only wants the pairs: an error reads as none here. The graph
 *  reads readPendingProposalPairs, which says which (GM-7). */
export async function listPendingPairs(orgId: string): Promise<Array<{
  a: string; b: string; proposer: ProposerKind;
}>> {
  const r = await readPendingProposalPairs(orgId);
  return r.pairs.map((p) => ({ a: p.documentId, b: p.targetDocumentId, proposer: p.proposer }));
}

/** How many pending pairs the graph draws at most. */
export const PENDING_PAIRS_CAP = 4000;
/** PostgREST cuts every response at db-max-rows (1,000 by default) without
 *  an error, so the pairs are read in windows no larger than that. */
const PAIR_WINDOW = 1000;

export interface PendingPairsRead {
  /** Both ends are documents: proposed_links.document_id and
   *  target_document_id are NOT NULL references to documents (20260807), so
   *  the kind is a fact of the schema, carried as data (`nodeA` / `nodeB`
   *  are the graph node ids). */
  pairs: Array<{
    documentId: string; targetDocumentId: string; proposer: ProposerKind;
    nodeA: string; nodeB: string;
  }>;
  /** Pending proposals this reader can see (proposed_links RLS: both
   *  documents readable — LNK-4). null when it could not be counted. */
  total: number | null;
  /** More are pending than were read (the cap). */
  capped: boolean;
  /** The read failed — never the same as "none pending". */
  error: string | null;
}

/** A PostgREST filter value inside an `or` tree, double-quoted: a
 *  timestamptz carries `.`, `:` and `+`, which the tree syntax reserves. */
const orValue = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** GM-7 — the pending pairs for the graph, telling a failed read and a
 *  capped one apart from an empty queue. A database without proposed_links
 *  (before 20260807 — Postgres 42P01, PostgREST PGRST205, lib/orgGraph.ts
 *  isMissingRelation) has none pending, which is not an error; any other
 *  failure, a missing column included, is.
 *
 *  The read is cheap (I-14 fix pass 3): newest first, in KEYSET windows on
 *  (created_at desc, id desc) — the order of proposed_links_org_status_idx
 *  (org_id, status, created_at DESC), so each window is an index range with
 *  a LIMIT, never a sort of the whole queue, and every row the RESTRICTIVE
 *  proposed_links_read_endpoints policy is evaluated on is a row the read
 *  returns. It stops at an EMPTY window, never a short one (a project whose
 *  db-max-rows is below the window returns short windows that are not the
 *  end; the keyset makes the extra request safe), or at the cap. The queue
 *  is counted only when the cap is reached — one head count; below the cap
 *  the read itself is the count. */
export async function readPendingProposalPairs(orgId: string, cap = PENDING_PAIRS_CAP): Promise<PendingPairsRead> {
  type Row = { id: string; document_id: string; target_document_id: string; proposer: ProposerKind; created_at: string };
  const pairs: PendingPairsRead["pairs"] = [];
  let last: { created_at: string; id: string } | null = null;
  while (pairs.length < cap) {
    const want = Math.min(PAIR_WINDOW, cap - pairs.length);
    let q = supabase.from("proposed_links")
      .select("id, document_id, target_document_id, proposer, created_at")
      .eq("org_id", orgId).eq("status", "pending");
    // "After" the last row in (created_at desc, id desc) order.
    if (last) q = q.or(`created_at.lt.${orValue(last.created_at)},and(created_at.eq.${orValue(last.created_at)},id.lt.${last.id})`);
    const { data, error } = await q
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(want);
    if (error) {
      if (!last && isMissingRelation(error)) {
        return { pairs: [], total: 0, capped: false, error: null };
      }
      return { pairs, total: null, capped: false, error: error.message || "the read failed" };
    }
    const rows = (data as Row[] | null) ?? [];
    if (rows.length === 0) return { pairs, total: pairs.length, capped: false, error: null };
    for (const r of rows) {
      pairs.push({
        documentId: r.document_id, targetDocumentId: r.target_document_id, proposer: r.proposer,
        nodeA: `doc:${r.document_id}`, nodeB: `doc:${r.target_document_id}`,
      });
    }
    const tail = rows[rows.length - 1];
    if (typeof tail.created_at !== "string" || !tail.created_at || !tail.id
      || (last && tail.created_at === last.created_at && tail.id === last.id)) {
      // No usable key on the last row: refuse to page on rather than loop.
      return { pairs, total: null, capped: false, error: "the read cannot page past its last row" };
    }
    last = { created_at: tail.created_at, id: tail.id };
  }
  // At the cap: one head count says how many are pending.
  const { count, error } = await supabase.from("proposed_links")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("status", "pending");
  const total = !error && typeof count === "number" ? count : null;
  return { pairs, total, capped: total === null || total > pairs.length, error: null };
}
