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
  proposeOpcContinuity, proposeSharedEquipment, proposeCustomReferences,
  proposeCoCitations, compileSkillPatterns, mergeDrafts, filterDrafts,
  splitByAutoApply, refKey, orderPair, BUILTIN_SKILLS,
  type ProposalDraft, type OpcOccurrence, type TagOccurrence,
  type TextOccurrence, type CoCitationRow,
} from "@/lib/linkProposalLogic";

const BATCH = 400;
const CHUNK = 150;
const CHUNK_SCAN_CAP = 2400;

/** What each skill had to work with — so "found nothing" can explain
 *  itself instead of looking broken. Zeroes here ARE the diagnosis. */
export interface ProposerInputs {
  documents: number;
  withNumbers: number;
  mirroredDocs: number;
  extractedRefs: number;
  registryAssets: number;
  equipmentLinks: number;
  citedQuestions: number;
  customSkills: number;
  chunksScanned: number;
  skillsInstalled: boolean;
}

export interface ProposerRun {
  scanned: number;
  proposed: number;
  autoApplied: number;
  skipped: number;
  /** System links whose stated evidence no longer holds (link kept, marked). */
  evidenceLost: number;
  more: boolean;
  notes: string[];
  inputs: ProposerInputs;
}

interface RuleRow {
  id: string;
  builtin_key: string | null;
  name: string;
  kind: string;
  config: { patterns?: string[]; minCoCitations?: number } | null;
  enabled: boolean;
  visibility: string;
}

/** Load the org's Connection Skills, seeding any missing built-ins. Returns
 *  null when the migration hasn't run — the engine then behaves exactly as
 *  it did before skills existed. */
async function loadRules(
  admin: SupabaseClient, orgId: string, notes: string[],
): Promise<RuleRow[] | null> {
  const res = await admin
    .from("link_rules")
    .select("id, builtin_key, name, kind, config, enabled, visibility")
    .eq("org_id", orgId)
    .limit(200);
  if (res.error) {
    notes.push("Connection Skills not installed — run the connection-skills migration to author your own detectors. Built-in detectors ran with defaults.");
    return null;
  }
  const rows = (res.data as RuleRow[]) ?? [];
  const have = new Set(rows.filter((r) => r.builtin_key).map((r) => r.builtin_key));
  const toSeed = BUILTIN_SKILLS.filter((b) => !have.has(b.builtin_key));
  if (toSeed.length > 0) {
    const { error } = await admin.from("link_rules").upsert(
      toSeed.map((b) => ({
        org_id: orgId,
        builtin_key: b.builtin_key,
        name: b.name,
        description: b.description,
        kind: b.kind,
        config: b.config,
        enabled: true,
        visibility: "org",
      })),
      { onConflict: "org_id,builtin_key", ignoreDuplicates: true },
    );
    if (!error) {
      for (const b of toSeed) {
        rows.push({
          id: `seed:${b.builtin_key}`, builtin_key: b.builtin_key, name: b.name,
          kind: b.kind, config: b.config, enabled: true, visibility: "org",
        });
      }
    }
  }
  return rows;
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

  // ── The org's rulebook. Built-ins seed themselves; a disabled skill is
  // simply skipped. Pre-migration orgs run the classic defaults.
  const rules = await loadRules(admin, orgId, notes);
  const builtinEnabled = (key: string): boolean =>
    rules === null ? true : (rules.find((r) => r.builtin_key === key)?.enabled ?? true);
  const customRules = (rules ?? []).filter((r) =>
    !r.builtin_key && r.kind === "reference" && r.enabled &&
    (r.config?.patterns?.length ?? 0) > 0);

  const inputs: ProposerInputs = {
    documents: 0, withNumbers: 0, mirroredDocs: 0, extractedRefs: 0,
    registryAssets: 0, equipmentLinks: 0, citedQuestions: 0,
    customSkills: customRules.length, chunksScanned: 0,
    skillsInstalled: rules !== null,
  };

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
  inputs.documents = docRows.length;
  if (docRows.length === 0) {
    return { scanned: 0, proposed: 0, autoApplied: 0, skipped: 0, evidenceLost: 0, more: false, notes, inputs };
  }

  const revById = new Map(docRows.map((d) => [d.id, d.rev]));
  const identityIndex = new Map<string, string[]>();
  for (const d of docRows) {
    if (!d.document_number) continue;
    const key = refKey(d.document_number);
    if (!key) continue;
    (identityIndex.get(key) ?? identityIndex.set(key, []).get(key)!).push(d.id);
  }
  inputs.withNumbers = identityIndex.size;
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
  inputs.mirroredDocs = mirrorRows.length;

  if (kdocs.error) {
    notes.push("Drawing entities unavailable — off-page continuity skipped.");
  } else if (mirrorRows.length > 0 && builtinEnabled("opc_continuity")) {
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
  inputs.equipmentLinks = links.length;
  {
    const { count } = await admin
      .from("assets").select("id", { count: "exact", head: true }).eq("org_id", orgId);
    inputs.registryAssets = count ?? 0;
  }

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

  inputs.extractedRefs = opcOccurrences.length;

  // ── Custom cross-reference skills: scan indexed text ──────────────────
  // The generalization of drawing continuity: ANY identifier convention the
  // org authored as a skill, matched against the indexed text of controlled
  // documents. Bounded per pass, and only fetched when a skill needs it.
  const textOccurrences: TextOccurrence[] = [];
  if (customRules.length > 0 && mirrorRows.length > 0) {
    let capped = false;
    for (let i = 0; i < mirrorRows.length && !capped; i += 25) {
      const slice = mirrorRows.slice(i, i + 25);
      const { data, error } = await admin
        .from("knowledge_chunks")
        .select("document_id, page, content")
        .in("document_id", slice.map((k) => k.id))
        .limit(CHUNK_SCAN_CAP - inputs.chunksScanned);
      if (error) { notes.push("Indexed text unavailable — custom skills skipped this pass."); break; }
      for (const c of (data as Array<{ document_id: string; page: number; content: string }>) ?? []) {
        const src = sourceByKdoc.get(c.document_id);
        if (!src || !allowed.has(src)) continue;
        textOccurrences.push({
          documentId: src, text: c.content, page: c.page,
          sourceRev: revById.get(src) ?? null,
        });
      }
      inputs.chunksScanned += (data ?? []).length;
      if (inputs.chunksScanned >= CHUNK_SCAN_CAP) capped = true;
    }
    if (capped) notes.push(`Custom skills scanned the first ${CHUNK_SCAN_CAP} indexed pages this pass.`);
  }
  const customDrafts: ProposalDraft[] = [];
  for (const rule of customRules) {
    const { regexes, errors } = compileSkillPatterns(rule.config?.patterns ?? []);
    if (errors.length > 0) notes.push(`Skill “${rule.name}”: ${errors[0]}`);
    if (regexes.length === 0) continue;
    customDrafts.push(...proposeCustomReferences(
      { id: rule.id, name: rule.name, regexes }, textOccurrences, identityIndex));
  }

  // ── Co-citation: the team's own questions as evidence ─────────────────
  let coDrafts: ProposalDraft[] = [];
  if (builtinEnabled("co_citation")) {
    const coRule = (rules ?? []).find((r) => r.builtin_key === "co_citation");
    const minCo = coRule?.config?.minCoCitations ?? 2;
    const { data: qs } = await admin
      .from("knowledge_questions")
      .select("question, citations")
      .eq("org_id", orgId)
      .not("citations", "is", null)
      .order("created_at", { ascending: false })
      .limit(400);
    const coRows: CoCitationRow[] = [];
    for (const q of (qs as Array<{ question: string | null; citations: unknown }>) ?? []) {
      const cites = Array.isArray(q.citations) ? q.citations : [];
      const ids = new Set<string>();
      for (const c of cites) {
        const kd = (c as { documentId?: string }).documentId;
        if (!kd) continue;
        const src = sourceByKdoc.get(kd);
        if (src && allowed.has(src)) ids.add(src);
      }
      if (ids.size >= 2) coRows.push({ question: q.question ?? "", docIds: [...ids] });
    }
    inputs.citedQuestions = coRows.length;
    coDrafts = proposeCoCitations(coRows, { minCoCitations: minCo });
  }

  // ── Reason ────────────────────────────────────────────────────────────
  const drafts = mergeDrafts([
    ...proposeOpcContinuity(opcOccurrences, identityIndex),
    ...(builtinEnabled("shared_equipment") ? proposeSharedEquipment(tagOccurrences) : []),
    ...customDrafts,
    ...coDrafts,
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
    inputs,
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
