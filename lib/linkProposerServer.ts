// lib/linkProposerServer.ts — the I/O half of link discovery.
//
// Gathers the facts extraction already stored, hands them to the pure logic
// in linkProposalLogic, and writes the results:
//   * provable proposals apply themselves into document_related_resources
//     (origin='system', evidence attached — visible and severable)
//   * everything else queues in proposed_links for review
//
// Service-role only: it reads across the whole org's extracted entities to
// find connections. What a given PERSON may see is enforced when the review
// surface and the graph read those rows back through RLS.
//
// Bounded by design — a run processes at most BATCH source documents and
// reports whether more remain, so the caller can drive it in slices and no
// single invocation approaches the platform's function timeout.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractDrawingRefs } from "@/lib/drawingText";
import { normalizeTag } from "@/lib/codebook";
import {
  proposeOpcContinuity, proposeSharedEquipment, mergeDrafts, filterDrafts,
  splitByAutoApply, refKey, orderPair,
  type ProposalDraft, type OpcOccurrence, type TagOccurrence,
} from "@/lib/linkProposalLogic";

const BATCH = 400;
const CHUNK = 150;

export interface ProposerRun {
  scanned: number;
  proposed: number;
  autoApplied: number;
  skipped: number;
  /** System links whose stated evidence no longer holds (link kept, marked). */
  evidenceLost: number;
  more: boolean;
  notes: string[];
}

/** Page a large `in` filter without blowing the URL length. */
async function inChunks<T>(
  ids: string[],
  run: (slice: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(...await run(ids.slice(i, i + CHUNK)));
  }
  return out;
}

export async function runLinkProposers(
  admin: SupabaseClient,
  orgId: string,
): Promise<ProposerRun> {
  const notes: string[] = [];

  // ── Controlled documents: identity index + revision, excluding anything
  // carved out of AI reading. ai_excluded is a young column; if it isn't
  // there yet the select would fail wholesale, so fall back gracefully.
  let docRows: Array<{ id: string; document_number: string | null; rev: string | null }> = [];
  const withFlag = await admin
    .from("documents")
    .select("id, document_number, rev, ai_excluded")
    .eq("org_id", orgId)
    .eq("ai_excluded", false)
    .limit(5000);
  if (withFlag.error) {
    const plain = await admin
      .from("documents").select("id, document_number, rev")
      .eq("org_id", orgId).limit(5000);
    if (plain.error) throw new Error(plain.error.message);
    docRows = (plain.data as typeof docRows) ?? [];
    notes.push("Per-document AI exclusions not applied — run the link-proposal migration.");
  } else {
    docRows = ((withFlag.data as Array<{ id: string; document_number: string | null; rev: string | null; ai_excluded: boolean }>) ?? [])
      .map(({ id, document_number, rev }) => ({ id, document_number, rev }));
  }
  if (docRows.length === 0) {
    return { scanned: 0, proposed: 0, autoApplied: 0, skipped: 0, evidenceLost: 0, more: false, notes };
  }

  const revById = new Map(docRows.map((d) => [d.id, d.rev]));
  const identityIndex = new Map<string, string[]>();
  for (const d of docRows) {
    if (!d.document_number) continue;
    const key = refKey(d.document_number);
    if (!key) continue;
    (identityIndex.get(key) ?? identityIndex.set(key, []).get(key)!).push(d.id);
  }
  const allowed = new Set(docRows.map((d) => d.id));

  // ── Off-page connector occurrences. Entities hang off knowledge_documents,
  // which mirror controlled documents via source_document_id.
  const opcOccurrences: OpcOccurrence[] = [];
  const kdocs = await admin
    .from("knowledge_documents")
    .select("id, source_document_id")
    .eq("org_id", orgId)
    .not("source_document_id", "is", null)
    .limit(BATCH * 2);
  const mirrorRows = (kdocs.data as Array<{ id: string; source_document_id: string }> | null) ?? [];
  const sourceByKdoc = new Map(mirrorRows.map((k) => [k.id, k.source_document_id]));

  if (kdocs.error) {
    notes.push("Drawing entities unavailable — off-page continuity skipped.");
  } else if (mirrorRows.length > 0) {
    const entities = await inChunks<{ document_id: string; kind: string; tag: string; raw: string | null; page: number }>(
      mirrorRows.map((k) => k.id),
      async (slice) => {
        const { data, error } = await admin
          .from("knowledge_page_entities")
          .select("document_id, kind, tag, raw, page")
          .in("document_id", slice)
          .in("kind", ["opc", "ref"]);
        if (error) return [];
        return (data as Array<{ document_id: string; kind: string; tag: string; raw: string | null; page: number }>) ?? [];
      },
    );
    for (const e of entities) {
      const sourceDoc = sourceByKdoc.get(e.document_id);
      if (!sourceDoc || !allowed.has(sourceDoc)) continue;
      // 'opc' rows carry the box number in tag and the drawing number in the
      // surrounding text; 'ref' rows are already a drawing number.
      const refs = e.kind === "opc"
        ? extractDrawingRefs(e.raw ?? "")
        : [e.tag];
      if (refs.length === 0) continue;
      opcOccurrences.push({
        documentId: sourceDoc,
        refs,
        box: e.kind === "opc" ? e.tag : undefined,
        page: e.page,
        sourceRev: revById.get(sourceDoc) ?? null,
      });
    }
  }

  // ── Shared equipment. document_assets is the already-normalized bridge
  // between controlled documents and the registry; aliases widen it.
  const tagOccurrences: TagOccurrence[] = [];
  const { data: linkRows } = await admin
    .from("document_assets")
    .select("document_id, asset_id, tag_text")
    .eq("org_id", orgId)
    .limit(20000);
  const links = (linkRows as Array<{ document_id: string; asset_id: string; tag_text: string | null }> | null) ?? [];

  // Canonical tag per asset, plus every alias pointing at it.
  const assetIds = [...new Set(links.map((l) => l.asset_id))];
  const assetTag = new Map<string, string>();
  if (assetIds.length > 0) {
    const rows = await inChunks<{ id: string; tag: string }>(assetIds, async (slice) => {
      const { data } = await admin.from("assets").select("id, tag").in("id", slice);
      return (data as Array<{ id: string; tag: string }>) ?? [];
    });
    for (const a of rows) assetTag.set(a.id, normalizeTag(a.tag));
  }
  const aliasByAsset = new Map<string, string[]>();
  const { data: aliasRows, error: aliasErr } = await admin
    .from("asset_aliases").select("asset_id, alias").eq("org_id", orgId).limit(5000);
  if (aliasErr) {
    notes.push("Aliases unavailable — run the link-proposal migration to widen matching.");
  } else {
    for (const r of (aliasRows as Array<{ asset_id: string; alias: string }>) ?? []) {
      (aliasByAsset.get(r.asset_id) ?? aliasByAsset.set(r.asset_id, []).get(r.asset_id)!).push(r.alias);
    }
  }

  for (const l of links) {
    if (!allowed.has(l.document_id)) continue;
    const canonical = assetTag.get(l.asset_id);
    if (!canonical) continue;
    // Did this document reach the asset by its canonical tag, or only
    // because someone taught the system a nickname?
    const viaTag = normalizeTag(l.tag_text ?? "");
    const aliases = aliasByAsset.get(l.asset_id) ?? [];
    const matchedAlias = viaTag && viaTag !== canonical
      ? aliases.find((a) => normalizeTag(a) === viaTag)
      : undefined;
    tagOccurrences.push({
      documentId: l.document_id,
      tag: canonical,
      viaAlias: matchedAlias,
      sourceRev: revById.get(l.document_id) ?? null,
    });
  }

  // ── Reason ────────────────────────────────────────────────────────────
  const drafts = mergeDrafts([
    ...proposeOpcContinuity(opcOccurrences, identityIndex),
    ...proposeSharedEquipment(tagOccurrences),
  ]);

  // Already linked, or already decided (including dismissals — a rejected
  // pair must never come back to nag).
  const linked = new Set<string>();
  const { data: existing } = await admin
    .from("document_related_resources")
    .select("document_id, target_document_id")
    .eq("org_id", orgId).not("target_document_id", "is", null).limit(20000);
  for (const r of (existing as Array<{ document_id: string; target_document_id: string }>) ?? []) {
    const [a, b] = orderPair(r.document_id, r.target_document_id);
    linked.add(`${a}|${b}`);
  }
  const decided = new Set<string>();
  const { data: priors } = await admin
    .from("proposed_links")
    .select("document_id, target_document_id, status")
    .eq("org_id", orgId).limit(20000);
  for (const r of (priors as Array<{ document_id: string; target_document_id: string; status: string }>) ?? []) {
    if (r.status === "pending") continue; // refreshed below, not blocked
    decided.add(`${r.document_id}|${r.target_document_id}`);
  }

  const fresh = filterDrafts(drafts, { linked, decided });
  const capped = fresh.slice(0, BATCH);
  const { autoApply, queue } = splitByAutoApply(capped);

  // ── Write ─────────────────────────────────────────────────────────────
  let autoApplied = 0;
  if (autoApply.length > 0) {
    const rows = autoApply.map((d) => ({
      org_id: orgId,
      document_id: d.documentId,
      target_document_id: d.targetDocumentId,
      kind: "document",
      label: d.evidence.summary.slice(0, 120),
      origin: "system",
      proposer: d.proposer,
      evidence: d.evidence,
      sort_order: 0,
    }));
    const { error } = await admin
      .from("document_related_resources")
      .upsert(rows, { onConflict: "document_id,target_document_id", ignoreDuplicates: true });
    if (error) notes.push(`Auto-apply skipped: ${error.message}`);
    else autoApplied = rows.length;
  }

  let proposed = 0;
  if (queue.length > 0) {
    const rows = queue.map((d) => ({
      org_id: orgId,
      document_id: d.documentId,
      target_document_id: d.targetDocumentId,
      proposer: d.proposer,
      tier: d.tier,
      confidence: d.confidence,
      evidence: d.evidence,
      source_rev: d.sourceRev ?? null,
      status: "pending",
    }));
    const { error } = await admin
      .from("proposed_links")
      .upsert(rows, { onConflict: "document_id,target_document_id,proposer", ignoreDuplicates: false });
    if (error) notes.push(`Queue write failed: ${error.message}`);
    else proposed = rows.length;
  }

  // Evidence audit against the facts as they stand right now.
  const currentTagsByDoc = new Map<string, Set<string>>();
  for (const o of tagOccurrences) {
    (currentTagsByDoc.get(o.documentId) ?? currentTagsByDoc.set(o.documentId, new Set()).get(o.documentId)!)
      .add(o.tag);
  }
  const evidenceLost = await flagLostEvidence(admin, orgId, currentTagsByDoc);

  return {
    scanned: docRows.length,
    proposed,
    autoApplied,
    skipped: drafts.length - fresh.length,
    evidenceLost,
    more: fresh.length > capped.length,
    notes,
  };
}

/** Publish-time housekeeping: a pending proposal was derived from text on a
 *  revision that no longer is the current one — a ghost of a drawing that
 *  no longer says that. Stale it so review never acts on stale evidence.
 *
 *  Deliberately does NOT touch approved links: at publish time the new
 *  revision hasn't been re-extracted yet, so "did the evidence survive?"
 *  is unanswerable. That check runs in flagLostEvidence() after extraction. */
export async function invalidateProposalsForRevision(
  admin: SupabaseClient,
  input: { orgId: string; documentId: string; newRev: string | null },
): Promise<{ staled: number }> {
  const { data, error } = await admin
    .from("proposed_links")
    .update({ status: "stale" })
    .eq("org_id", input.orgId)
    .eq("status", "pending")
    .or(`document_id.eq.${input.documentId},target_document_id.eq.${input.documentId}`)
    .not("source_rev", "is", null)
    .neq("source_rev", input.newRev ?? "")
    .select("id");
  if (error) return { staled: 0 };
  return { staled: (data ?? []).length };
}

/** After re-extraction: system-applied links whose stated evidence no longer
 *  holds. The link STAYS — a human may still want it — but it's marked, so
 *  "this connection was based on E-101 appearing on both sheets; the current
 *  revision dropped it" becomes visible instead of silently rotting.
 *
 *  Only links carrying tag evidence can be checked this way; OPC continuity
 *  evidence is re-verified by the next proposer pass. */
async function flagLostEvidence(
  admin: SupabaseClient,
  orgId: string,
  currentTagsByDoc: Map<string, Set<string>>,
): Promise<number> {
  const { data, error } = await admin
    .from("document_related_resources")
    .select("id, document_id, target_document_id, evidence, origin, evidence_lost_at")
    .eq("org_id", orgId).eq("origin", "system").is("evidence_lost_at", null)
    .limit(5000);
  if (error) return 0;

  const lost: string[] = [];
  for (const r of (data as Array<{
    id: string; document_id: string; target_document_id: string | null;
    evidence: { tags?: string[] } | null;
  }>) ?? []) {
    const tags = r.evidence?.tags;
    if (!tags || tags.length === 0 || !r.target_document_id) continue;
    const a = currentTagsByDoc.get(r.document_id);
    const b = currentTagsByDoc.get(r.target_document_id);
    // Never flag on missing data — a document that hasn't been extracted
    // yet is unknown, not changed.
    if (!a || !b) continue;
    if (!tags.some((t) => a.has(t) && b.has(t))) lost.push(r.id);
  }
  if (lost.length === 0) return 0;

  const stamp = new Date().toISOString();
  for (let i = 0; i < lost.length; i += CHUNK) {
    await admin.from("document_related_resources")
      .update({ evidence_lost_at: stamp })
      .in("id", lost.slice(i, i + CHUNK));
  }
  return lost.length;
}

export type { ProposalDraft };
