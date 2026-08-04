// lib/equipmentBridgeServer.ts — THE BRIDGE: AI-extracted equipment tags on
// P&IDs flow into (1) the equipment registry and (2) the source document's
// own equipment column, automatically.
//
// Pipeline per drawing (runs on ingest completion + on demand for backlogs):
//   gather   — the sheet's extracted equipment entities (knowledge_page_entities)
//   locate   — which operating unit, decoded from the drawing number via the
//              Site Codebook (fallback: the library's configured default unit)
//   translate— tag + unit → full site code (E-22 in 20 → 2030.22)
//   reconcile— match each tag against the registry; unmatched tags become
//              DISCOVERED assets on apply (origin 'drawing', full provenance)
//   populate — merge tags into the mapped tags-column on the source document
//              (metadata arrays; manual entries are never removed)
//
// Invariants:
//   * Idempotent — recompute diffs against what was already applied; re-index
//     never duplicates chips or re-creates assets.
//   * Additive only — the bridge never deletes a tag a human typed.
//   * Honest degradation — no codebook → tags still flow (no codes/units);
//     no column mapping → suggestions wait in review; nothing guesses.
//   * Everything audited — applied runs and discovered assets log who/what/
//     which drawing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { normalizeTag, splitTag, tagToCode, parseDrawingNumber, typeForTag, type Codebook } from "@/lib/codebook";

export interface BridgeSuggestion {
  tag: string;              // normalized display form ("E-22")
  code: string | null;      // site code when derivable ("2030.22")
  pages: number[];          // sheets/pages the tag appears on
  assetId: string | null;   // existing registry match
  assetStatus: "existing" | "new";
}

export interface BridgeConfig {
  targetColumnKey?: string;
  autoApply?: boolean;
  defaultUnitCode?: string;
  /** Discovery mode — create registry assets for unmatched tags on apply.
   *  Defaults ON: the drawings build the registry. */
  createAssets?: boolean;
}

/** assets.tag_normalized convention (lib/assets.ts normalizeTag). */
const assetNorm = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]+/g, "");

// ─── Compute ────────────────────────────────────────────────────────────────

export async function computeForKnowledgeDoc(admin: SupabaseClient, knowledgeDocId: string): Promise<{
  documentId: string | null;
  suggestions: BridgeSuggestion[];
  autoApplied: boolean;
} | null> {
  const { data: kdoc } = await admin
    .from("knowledge_documents")
    .select("id, org_id, library_id, name, source_document_id")
    .eq("id", knowledgeDocId).maybeSingle();
  if (!kdoc?.source_document_id) return null; // upload-origin docs have no column to feed

  const orgId = String((kdoc as Record<string, unknown>).org_id);
  const documentId = String(kdoc.source_document_id);

  // Equipment entities, aggregated per tag with the pages they appear on.
  const { data: ents } = await admin
    .from("knowledge_page_entities")
    .select("tag, page, kind")
    .eq("document_id", kdoc.id)
    .eq("kind", "equipment")
    .limit(4000);
  const byTag = new Map<string, Set<number>>();
  for (const e of (ents ?? []) as Array<{ tag: string; page: number }>) {
    const norm = normalizeTag(String(e.tag));
    if (!splitTag(norm)) continue; // only things shaped like real tags cross the bridge
    const pages = byTag.get(norm) ?? new Set<number>();
    if (Number.isFinite(e.page)) pages.add(Number(e.page));
    byTag.set(norm, pages);
  }
  if (byTag.size === 0) {
    // Still record an empty computation so the sweep shows "checked, nothing".
    await upsertSuggestions(admin, orgId, documentId, [], null);
    return { documentId, suggestions: [], autoApplied: false };
  }

  // Which unit is this drawing? Codebook decode of the drawing number first,
  // then the library's configured default. Never guessed.
  const book = await loadCodebookAdmin(admin, orgId);
  const { data: srcDoc } = await admin
    .from("documents").select("id, library_id, document_number, title, name, metadata")
    .eq("id", documentId).maybeSingle();
  if (!srcDoc) return null;
  const bridge = await loadBridgeConfig(admin, String(srcDoc.library_id ?? ""));
  const numberCandidates = [srcDoc.document_number, kdoc.name, srcDoc.title, srcDoc.name]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  let unitCode: string | null = null;
  for (const cand of numberCandidates) {
    const parsed = parseDrawingNumber(cand, book);
    if (parsed?.unitCode) { unitCode = parsed.unitCode; break; }
  }
  if (!unitCode && bridge?.defaultUnitCode) unitCode = bridge.defaultUnitCode;

  // Registry matches in one query per batch.
  const norms = [...byTag.keys()].map(assetNorm);
  const found = new Map<string, string>(); // tag_normalized -> asset id
  for (let i = 0; i < norms.length; i += 100) {
    const { data } = await admin
      .from("assets").select("id, tag_normalized")
      .eq("org_id", orgId).in("tag_normalized", norms.slice(i, i + 100));
    for (const a of (data ?? []) as Array<{ id: string; tag_normalized: string }>) {
      found.set(a.tag_normalized, a.id);
    }
  }

  const suggestions: BridgeSuggestion[] = [...byTag.entries()]
    .map(([tag, pages]) => ({
      tag,
      code: tagToCode(tag, unitCode, book),
      pages: [...pages].sort((a, b) => a - b),
      assetId: found.get(assetNorm(tag)) ?? null,
      assetStatus: (found.has(assetNorm(tag)) ? "existing" : "new") as "existing" | "new",
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));

  await upsertSuggestions(admin, orgId, documentId, suggestions, unitCode);

  // Auto-apply when the library opted in AND a target column is mapped.
  let autoApplied = false;
  if (bridge?.autoApply && bridge.targetColumnKey) {
    try {
      await applyForDocument(admin, { orgId, documentId, userId: null });
      autoApplied = true;
    } catch { /* stays pending for manual review — never breaks ingest */ }
  }
  return { documentId, suggestions, autoApplied };
}

async function upsertSuggestions(
  admin: SupabaseClient, orgId: string, documentId: string,
  suggestions: BridgeSuggestion[], unitCode: string | null,
): Promise<void> {
  // Preserve the applied history (the idempotence base) across recomputes.
  const { data: existing } = await admin
    .from("document_equipment_suggestions").select("applied, status")
    .eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  const applied: string[] = Array.isArray(existing?.applied) ? (existing?.applied as string[]) : [];
  const newTags = suggestions.map((s) => s.tag).filter((t) => !applied.includes(t));
  await admin.from("document_equipment_suggestions").upsert({
    org_id: orgId,
    document_id: documentId,
    suggested: suggestions.map((s) => ({ ...s, unitCode })),
    applied,
    status: newTags.length === 0 && applied.length > 0 ? "applied" : "pending",
    computed_at: new Date().toISOString(),
  }, { onConflict: "org_id,document_id" });
}

async function loadBridgeConfig(admin: SupabaseClient, libraryId: string): Promise<BridgeConfig | null> {
  if (!libraryId) return null;
  const { data } = await admin.from("libraries").select("equipment_bridge").eq("id", libraryId).maybeSingle();
  const raw = data?.equipment_bridge as BridgeConfig | null | undefined;
  return raw && typeof raw === "object" ? raw : null;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export async function applyForDocument(admin: SupabaseClient, input: {
  orgId: string;
  documentId: string;
  /** Null = the automatic path (post-ingest auto-apply). */
  userId: string | null;
  /** Restrict to a subset of suggested tags (review UI); omit = all. */
  tags?: string[];
}): Promise<{ appliedTags: string[]; createdAssets: number }> {
  const { orgId, documentId } = input;
  const { data: row } = await admin
    .from("document_equipment_suggestions").select("suggested, applied")
    .eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  if (!row) throw new Error("No computed suggestions for this document — run the sweep first.");
  const suggested = (Array.isArray(row.suggested) ? row.suggested : []) as Array<BridgeSuggestion & { unitCode?: string | null }>;
  const alreadyApplied = new Set<string>(Array.isArray(row.applied) ? (row.applied as string[]) : []);
  const wanted = suggested.filter((s) =>
    (!input.tags || input.tags.includes(s.tag)));
  if (wanted.length === 0) return { appliedTags: [], createdAssets: 0 };

  const { data: doc } = await admin
    .from("documents").select("id, library_id, metadata")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) throw new Error("Document not found");
  const bridge = await loadBridgeConfig(admin, String(doc.library_id ?? ""));
  const targetKey = bridge?.targetColumnKey;
  if (!targetKey) {
    throw new Error("No equipment column mapped for this library — pick one in the sweep dialog first.");
  }

  // ── Registry reconcile with DISCOVERY: unmatched tags become real assets,
  //    filed under the right unit + type, provenance attached. The drawings
  //    build the registry.
  const book = await loadCodebookAdmin(admin, orgId);
  let createdAssets = 0;
  if (bridge?.createAssets !== false) {
    const typeIdByLabel = await ensureAssetTypes(admin, orgId, book, wanted);
    for (const s of wanted) {
      if (s.assetId) continue;
      const t = typeForTag(s.tag, book);
      const insert = {
        org_id: orgId,
        tag: s.tag,
        tag_normalized: assetNorm(s.tag),
        type_id: t ? typeIdByLabel.get(t.label) ?? null : null,
        description: null,
        unit_code: s.unitCode ?? null,
        code: s.code,
        origin: "drawing",
        discovered_from: { documentId, pages: s.pages },
        created_by: input.userId ?? "00000000-0000-0000-0000-000000000000",
      };
      // Unique (org, tag_normalized) makes concurrent discovery safe: the
      // loser of a race just resolves to the winner's row.
      let { data: created, error } = await admin.from("assets").insert(insert).select("id").single();
      if (error && /unit_code|origin|discovered_from|column/i.test(error.message)) {
        // Pre-migration DB: retry with the base columns only.
        const { unit_code: _u, code: _c, origin: _o, discovered_from: _d, ...base } = insert;
        void _u; void _c; void _o; void _d;
        ({ data: created, error } = await admin.from("assets").insert(base).select("id").single());
      }
      if (error) {
        const { data: raced } = await admin.from("assets").select("id")
          .eq("org_id", orgId).eq("tag_normalized", assetNorm(s.tag)).maybeSingle();
        if (raced) { s.assetId = String(raced.id); continue; }
        continue; // one bad tag never sinks the batch
      }
      if (created) { s.assetId = String(created.id); createdAssets++; }
    }
  }

  // ── Unit backfill for MATCHED assets: a hand-made asset often ships with
  //    blanks, but the drawing it appears on knows exactly which unit it
  //    belongs to. Fill the blank on apply — never overwrite a human's
  //    assignment (only rows whose unit_code is NULL are touched).
  try {
    const backfills = wanted.filter((s) => s.assetId && s.unitCode);
    if (backfills.length > 0) {
      const ids = [...new Set(backfills.map((s) => String(s.assetId)))];
      const { data: blankRows } = await admin.from("assets")
        .select("id, code").in("id", ids).is("unit_code", null);
      const blank = new Map(((blankRows ?? []) as Array<{ id: string; code: string | null }>)
        .map((b) => [b.id, b.code]));
      for (const s of backfills) {
        const id = String(s.assetId);
        if (!blank.has(id)) continue;
        const patch: Record<string, unknown> = { unit_code: s.unitCode };
        if (!blank.get(id) && s.code) patch.code = s.code;
        await admin.from("assets").update(patch).eq("id", id).is("unit_code", null)
          .then(() => undefined, () => undefined);
        blank.delete(id); // one write per asset even if it appears under several tags
      }
    }
  } catch { /* pre-migration DB (no unit_code column) — nothing to backfill */ }

  // ── Populate the column: array-union merge, never clobbering manual tags.
  const metadata = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
  const current = metadata[targetKey];
  const existingTags: string[] = Array.isArray(current)
    ? current.map((v) => String(v).trim()).filter(Boolean)
    : typeof current === "string" && current.trim()
      ? current.split(",").map((v) => v.trim()).filter(Boolean)
      : [];
  const existingNorms = new Set(existingTags.map(assetNorm));
  const additions = wanted.map((s) => s.tag).filter((t) => !existingNorms.has(assetNorm(t)));
  if (additions.length > 0) {
    const next = [...existingTags, ...additions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
    const { error: updErr } = await admin.from("documents")
      .update({ metadata: { ...metadata, [targetKey]: next }, updated_at: new Date().toISOString() })
      .eq("id", documentId).eq("org_id", orgId);
    if (updErr) throw new Error(updErr.message);
  }

  const appliedNow = wanted.map((s) => s.tag);
  const appliedUnion = [...new Set([...alreadyApplied, ...appliedNow])];
  await admin.from("document_equipment_suggestions").update({
    applied: appliedUnion,
    status: "applied",
    applied_at: new Date().toISOString(),
    applied_by: input.userId,
  }).eq("org_id", orgId).eq("document_id", documentId);

  await admin.from("audit_logs").insert({
    action: "EQUIPMENT_BRIDGE_APPLIED",
    resource_type: "document",
    resource_id: documentId,
    org_id: orgId,
    user_id: input.userId,
    details: { tags: appliedNow, createdAssets, column: targetKey, auto: input.userId === null },
  }).then(() => undefined, () => undefined);

  return { appliedTags: appliedNow, createdAssets };
}

/** Find-or-create asset_types matching the codebook equipment-type labels
 *  needed by this batch — discovery builds the type list too. */
async function ensureAssetTypes(
  admin: SupabaseClient, orgId: string, book: Codebook,
  wanted: Array<{ tag: string }>,
): Promise<Map<string, string>> {
  const neededLabels = new Set<string>();
  for (const s of wanted) {
    const t = typeForTag(s.tag, book);
    if (t) neededLabels.add(t.label);
  }
  const map = new Map<string, string>();
  if (neededLabels.size === 0) return map;
  const { data: existing } = await admin.from("asset_types").select("id, name").eq("org_id", orgId);
  for (const t of (existing ?? []) as Array<{ id: string; name: string }>) map.set(t.name, String(t.id));
  for (const label of neededLabels) {
    if (map.has(label)) continue;
    const { data: created } = await admin.from("asset_types")
      .insert({ org_id: orgId, name: label, sort_order: 99 }).select("id").single();
    if (created) map.set(label, String(created.id));
    else {
      // Unique(org,name) race: someone else created it between our read and write.
      const { data: raced } = await admin.from("asset_types").select("id")
        .eq("org_id", orgId).eq("name", label).maybeSingle();
      if (raced) map.set(label, String(raced.id));
    }
  }
  return map;
}
