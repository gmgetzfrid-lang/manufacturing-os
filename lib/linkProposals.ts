// lib/linkProposals.ts — client-side reads and decisions on proposed links.
//
// Approving a proposal writes a real curated link carrying its provenance
// (which proposer found it, the evidence, who approved it), so the applied
// web can always explain itself. Dismissing keeps the row — that's the
// memory that stops the engine re-proposing the same pair forever.

import { supabase } from "@/lib/supabase";

export type ProposerKind = "opc" | "tag" | "alias" | "semantic";
export type ProposalTier = "provable" | "strong" | "inferred";

export interface ProposalEvidence {
  summary?: string;
  detail?: string;
  tags?: string[];
  page?: number;
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

export const PROPOSER_LABELS: Record<ProposerKind, string> = {
  opc: "Off-page connector",
  tag: "Shared equipment",
  alias: "Equipment alias",
  semantic: "Similar content",
};

export const TIER_LABELS: Record<ProposalTier, string> = {
  provable: "Provable",
  strong: "Strong",
  inferred: "Inferred",
};

export async function listProposals(orgId: string, opts?: {
  status?: LinkProposal["status"];
  limit?: number;
}): Promise<LinkProposal[]> {
  const { data, error } = await supabase
    .from("proposed_links").select("*")
    .eq("org_id", orgId)
    .eq("status", opts?.status ?? "pending")
    .order("tier", { ascending: true })
    .order("confidence", { ascending: false })
    .limit(opts?.limit ?? 200);
  if (error) {
    if (missing(error)) return [];
    throw new Error(error.message);
  }
  const rows = (data as LinkProposal[]) ?? [];
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
 *  decision. If the link already exists the proposal still resolves. */
export async function approveProposal(p: LinkProposal, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const { error: linkErr } = await supabase.from("document_related_resources").insert({
    org_id: p.org_id,
    document_id: p.document_id,
    target_document_id: p.target_document_id,
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

  const { error } = await supabase.from("proposed_links").update({
    status: "approved",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", p.id);
  if (error) throw new Error(error.message);
}

/** Dismiss → the row stays as memory so this pair is never proposed again. */
export async function dismissProposal(id: string, actor: {
  userId: string; userName?: string;
}): Promise<void> {
  const { error } = await supabase.from("proposed_links").update({
    status: "dismissed",
    decided_by: actor.userId,
    decided_by_name: actor.userName ?? null,
    decided_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw new Error(error.message);
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

/** Publish-time: retire pending proposals that were derived from the
 *  revision this publish replaces. Their evidence was read off text that is
 *  no longer current, so acting on them would be acting on a ghost.
 *
 *  Proposals with no recorded source revision are left alone — unknown is
 *  not the same as outdated. */
export async function staleProposalsForDocument(
  documentId: string, newRev: string | null,
): Promise<number> {
  const { data, error } = await supabase
    .from("proposed_links")
    .update({ status: "stale" })
    .or(`document_id.eq.${documentId},target_document_id.eq.${documentId}`)
    .eq("status", "pending")
    .not("source_rev", "is", null)
    .neq("source_rev", newRev ?? "")
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}

/** Every pending pair, for drawing ghost edges on the graph. */
export async function listPendingPairs(orgId: string): Promise<Array<{
  a: string; b: string; proposer: ProposerKind;
}>> {
  const { data, error } = await supabase
    .from("proposed_links").select("document_id, target_document_id, proposer")
    .eq("org_id", orgId).eq("status", "pending").limit(4000);
  if (error) return [];
  return ((data as Array<{ document_id: string; target_document_id: string; proposer: ProposerKind }>) ?? [])
    .map((r) => ({ a: r.document_id, b: r.target_document_id, proposer: r.proposer }));
}
