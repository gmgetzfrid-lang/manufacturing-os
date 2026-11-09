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
import { parseDrawingNumber } from "@/lib/codebook";
import { sweepRows, autoReady, decodeId, looksLikeId, type SweepRow, type RegistryAsset, type RowChoice } from "@/lib/equipmentSweep";
import { idKey, nameKey } from "@/lib/equipmentPick";

/** One tag on a drawing, lined up with the registry by its ID
 *  (lib/equipmentSweep). */
export type BridgeSuggestion = SweepRow;

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

/** `autoApply: false` when the caller applies (and journals) itself. */
export async function computeForKnowledgeDoc(admin: SupabaseClient, knowledgeDocId: string, opts: { autoApply?: boolean } = {}): Promise<{
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

  // What each sheet says: the tag, the ID printed beside it, the service.
  const { data: ents } = await admin
    .from("knowledge_page_entities")
    .select("tag, page, kind, raw")
    .eq("document_id", kdoc.id)
    .eq("kind", "equipment")
    .limit(4000);
  const readings = ((ents ?? []) as Array<{ tag: string; page: number; raw: string | null }>).map((e) => ({ tag: String(e.tag), page: Number(e.page), raw: e.raw ?? null }));
  if (readings.length === 0) {
    // Still record an empty computation so the sweep shows "checked, nothing".
    await upsertSuggestions(admin, orgId, documentId, []);
    return { documentId, suggestions: [], autoApplied: false };
  }

  // The unit of a sheet that prints no IDs: the library's pick, else the
  // drawing number by the codebook. A sheet that prints IDs says its own.
  const book = await loadCodebookAdmin(admin, orgId);
  const { data: srcDoc } = await admin
    .from("documents").select("id, library_id, document_number, title, name, metadata")
    .eq("id", documentId).maybeSingle();
  if (!srcDoc) return null;
  const bridge = await loadBridgeConfig(admin, String(srcDoc.library_id ?? ""));
  const numberCandidates = [srcDoc.document_number, kdoc.name, srcDoc.title, srcDoc.name]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  let drawingUnit: string | null = bridge?.defaultUnitCode ?? null;
  if (!drawingUnit) {
    for (const cand of numberCandidates) {
      const parsed = parseDrawingNumber(cand, book);
      if (parsed?.unitCode) { drawingUnit = parsed.unitCode; break; }
    }
  }

  const registry = await loadRegistry(admin, orgId);
  const suggestions = sweepRows({ readings, registry, book, drawingUnit });
  await upsertSuggestions(admin, orgId, documentId, suggestions);
  // A link a machine drew from this drawing to equipment the sheet's own ID
  // says it isn't (the Crude Unit's V-7 for a Transmix V-7) comes off.
  await pruneWrongLinks(admin, orgId, documentId, suggestions, registry).catch(() => undefined);

  // Auto-apply when the library opted in AND a target column is mapped.
  let autoApplied = false;
  if (bridge?.autoApply && opts.autoApply !== false) {
    try {
      // Journaled like any run, so automatic tagging can be undone from
      // Documents › Graph › Connect › Undo, a day at a time.
      const { snapshotDoc, recordDocChange, automaticRun } = await import("@/lib/estate/runJournal");
      const before = await snapshotDoc(admin, orgId, documentId);
      await applyForDocument(admin, { orgId, documentId, userId: null });
      autoApplied = true;
      await recordDocChange(admin, orgId, automaticRun(), documentId, before, await snapshotDoc(admin, orgId, documentId)).catch(() => false);
    } catch { /* stays pending for manual review — never breaks ingest */ }
  }
  return { documentId, suggestions, autoApplied };
}

async function upsertSuggestions(
  admin: SupabaseClient, orgId: string, documentId: string,
  suggestions: BridgeSuggestion[],
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
    suggested: suggestions,
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

/** Every piece of equipment in the org, with its ID and unit. */
async function loadRegistry(admin: SupabaseClient, orgId: string): Promise<RegistryAsset[]> {
  const out: RegistryAsset[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await admin.from("assets").select("id, tag, code, unit_code, description").eq("org_id", orgId).order("id").range(from, from + 999);
    if (error) break;
    const rows = (data ?? []) as Array<{ id: string; tag: string; code: string | null; unit_code: string | null; description: string | null }>;
    out.push(...rows.map((a) => ({ id: a.id, tag: a.tag, code: a.code, unitCode: a.unit_code, description: a.description })));
    if (rows.length < 1000) break;
  }
  return out;
}

/** Machine-drawn links from a drawing to equipment that has the same name
 *  as a tag on it but not the ID the sheet prints (another unit's). */
async function pruneWrongLinks(admin: SupabaseClient, orgId: string, documentId: string, rows: BridgeSuggestion[], registry: RegistryAsset[]): Promise<number> {
  const read = rows.filter((r) => r.codeFrom === "sheet" && r.code);
  if (!read.length) return 0;
  const { data: edges } = await admin.from("estate_edges").select("id, b, origin")
    .eq("org_id", orgId).eq("a", `doc:${documentId}`).eq("type", "tagged_to").in("origin", ["vision", "bridge", "resolver"]).limit(1000);
  const byId = new Map(registry.map((a) => [a.id, a]));
  const plain = (t: string) => t.replace(/\s*\(.*$/, "").trim();
  const wrong: string[] = [];
  for (const e of (edges ?? []) as Array<{ id: string; b: string }>) {
    const a = byId.get(e.b.replace(/^asset:/, ""));
    if (!a) continue;
    const r = read.find((x) => nameKey(x.tag) === nameKey(plain(a.tag)));
    if (r && idKey(a.code) !== idKey(r.code) && (a.unitCode ?? null) !== r.unitCode) wrong.push(e.id);
  }
  if (wrong.length) await admin.from("estate_edges").delete().in("id", wrong);
  return wrong.length;
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export async function applyForDocument(admin: SupabaseClient, input: {
  orgId: string;
  documentId: string;
  /** Null = the automatic path (post-ingest auto-apply). */
  userId: string | null;
  /** Restrict to a subset of suggested tags (review UI); omit = all. */
  tags?: string[];
  /** A person pressed Apply after seeing the suggestions. The automatic
   *  paths (after a read, Connect everything, nightly) leave it unset and
   *  only add equipment whose ID is printed plainly on the sheet. */
  byPerson?: boolean;
  /** What a person decided per tag: skip it, its ID, its type. */
  choices?: Record<string, RowChoice>;
  /** False: link only, add nothing (only admins add equipment). */
  mayCreate?: boolean;
}): Promise<{ appliedTags: string[]; createdAssets: number }> {
  const { orgId, documentId } = input;
  const { data: row } = await admin
    .from("document_equipment_suggestions").select("suggested, applied")
    .eq("org_id", orgId).eq("document_id", documentId).maybeSingle();
  if (!row) throw new Error("No computed suggestions for this document - run the sweep first.");
  const suggested = (Array.isArray(row.suggested) ? row.suggested : []) as BridgeSuggestion[];
  const alreadyApplied = new Set<string>(Array.isArray(row.applied) ? (row.applied as string[]) : []);
  const wanted = suggested.filter((s) =>
    (!input.tags || input.tags.includes(s.tag)));
  if (wanted.length === 0) return { appliedTags: [], createdAssets: 0 };

  const { data: doc } = await admin
    .from("documents").select("id, library_id, metadata")
    .eq("id", documentId).eq("org_id", orgId).maybeSingle();
  if (!doc) throw new Error("Document not found");
  const bridge = await loadBridgeConfig(admin, String(doc.library_id ?? ""));
  // A column is optional: without one the registry is still built and the
  // drawing still tagged to it, the column just stays as it was. The old
  // behaviour (refuse without a column) was the single biggest reason a
  // registry stayed empty.
  const targetKey = bridge?.targetColumnKey ?? null;

  // ── The registry, by the equipment ID. A row matched by ID (or by name
  //    inside its unit) is linked; a new one is added only with an ID, a
  //    unit and a type, filed from what the sheet printed. A person's
  //    choices (skip, an ID typed, a type picked) win. The automatic path
  //    only adds what's printed plainly (lib/equipmentSweep autoReady).
  const book = await loadCodebookAdmin(admin, orgId);
  const reviewed = !!input.tags || !!input.byPerson;
  let createdAssets = 0;
  const landedRows: BridgeSuggestion[] = [];
  const typeIds = await ensureAssetTypes(admin, orgId, wanted.map((s) => {
    const code = input.choices?.[s.tag]?.typeCode ?? s.typeCode;
    return book.equipmentTypes.find((t) => t.code === code)?.label ?? null;
  }));
  for (const s0 of wanted) {
    const choice = input.choices?.[s0.tag];
    if (choice?.skip) continue;
    const s: BridgeSuggestion = { ...s0 };
    // An ID a person typed: it decides the unit and type, like a printed one.
    if (choice?.code !== undefined && choice.code !== null && choice.code.trim() && idKey(choice.code) !== idKey(s.code)) {
      const typed = choice.code.trim().toUpperCase();
      if (!looksLikeId(typed)) continue;
      const dec = decodeId(typed, book);
      s.code = typed; s.codeFrom = "sheet";
      if (dec) { s.unitCode = dec.unitCode; if (dec.typeCode) { s.typeCode = dec.typeCode; s.typeLabel = dec.typeLabel; s.typeFrom = "id"; } }
      // It may be equipment already listed under that ID.
      const { data: hit } = await admin.from("assets").select("id").eq("org_id", orgId).eq("code", typed).limit(1);
      s.assetId = (hit as Array<{ id: string }> | null)?.[0]?.id ?? null;
      s.match = s.assetId ? "id" : null;
      s.problem = null;
    }
    if (choice?.typeCode) {
      const t = book.equipmentTypes.find((x) => x.code === choice.typeCode);
      if (t) { s.typeCode = t.code; s.typeLabel = t.label; }
    }
    if (!reviewed && !s.assetId && !autoReady(s)) continue;
    if (!reviewed && s.assetId && s.match !== "id") continue;
    if (s.problem && !choice) continue;

    if (s.assetId) {
      // Matched: fill in what the registry is missing (never overwrite).
      const { data: cur } = await admin.from("assets").select("id, code, unit_code, description, type_id").eq("id", s.assetId).maybeSingle();
      const a = cur as { id: string; code: string | null; unit_code: string | null; description: string | null; type_id: string | null } | null;
      if (a) {
        const patch: Record<string, unknown> = {};
        if (!a.code && s.code) patch.code = s.code;
        if (!a.unit_code && s.unitCode) patch.unit_code = s.unitCode;
        if (!a.description && s.name) patch.description = s.name;
        if (!a.type_id && s.typeLabel && typeIds.get(s.typeLabel)) patch.type_id = typeIds.get(s.typeLabel);
        if (Object.keys(patch).length) await admin.from("assets").update(patch).eq("id", a.id).then(() => undefined, () => undefined);
      }
      landedRows.push(s);
      continue;
    }
    // New: only with an ID and a unit, and only when the library adds equipment.
    if (bridge?.createAssets === false || input.mayCreate === false || !s.code || !s.unitCode) continue;
    const insert = {
      org_id: orgId,
      tag: s.tag,
      tag_normalized: assetNorm(s.tag),
      type_id: s.typeLabel ? typeIds.get(s.typeLabel) ?? null : null,
      description: s.name ?? null,
      unit_code: s.unitCode,
      code: s.code,
      origin: "drawing",
      discovered_from: { documentId, pages: s.pages, idFrom: s.codeFrom },
      created_by: input.userId ?? "00000000-0000-0000-0000-000000000000",
    };
    const { data: created, error } = await admin.from("assets").insert(insert).select("id").single();
    if (error) {
      // Someone added it meanwhile: it's the one with this ID.
      const { data: raced } = await admin.from("assets").select("id").eq("org_id", orgId).eq("code", s.code).limit(1);
      const id = (raced as Array<{ id: string }> | null)?.[0]?.id;
      if (id) { s.assetId = id; landedRows.push(s); }
      continue; // one bad tag never sinks the batch
    }
    if (created) { s.assetId = String(created.id); createdAssets++; landedRows.push(s); }
  }

  // The drawing links to exactly the equipment its IDs name.
  if (landedRows.length) {
    const rows = landedRows.map((s) => ({
      org_id: orgId, a: `doc:${documentId}`, b: `asset:${s.assetId}`, type: "tagged_to", origin: "bridge", tier: "provable", confidence: 1, status: "applied",
      summary: `${s.tag}${s.code ? ` (${s.code})` : ""} is on sheet ${s.pages.join(", ") || "?"}`,
      evidence: { tag: s.tag, code: s.code, idFrom: s.codeFrom, where: "page" },
      created_by: input.userId, created_by_name: null,
    }));
    await admin.from("estate_edges").upsert(rows, { onConflict: "org_id,a,b,type", ignoreDuplicates: true }).then(() => undefined, () => undefined);
  }

  // ── Populate the column: array-union merge, never clobbering manual tags.
  const metadata = (doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>;
  const current = targetKey ? metadata[targetKey] : undefined;
  const existingTags: string[] = Array.isArray(current)
    ? current.map((v) => String(v).trim()).filter(Boolean)
    : typeof current === "string" && current.trim()
      ? current.split(",").map((v) => v.trim()).filter(Boolean)
      : [];
  const existingNorms = new Set(existingTags.map(assetNorm));
  // What actually landed: everything a person picked, or on the automatic
  // path only the tags that resolved to registry equipment. The rest stay
  // suggestions — not written to the column, not marked applied.
  const landed = landedRows;
  const additions = landed.map((s) => s.tag).filter((t) => !existingNorms.has(assetNorm(t)));
  if (targetKey && additions.length > 0) {
    const next = [...existingTags, ...additions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))];
    const { error: updErr } = await admin.from("documents")
      .update({ metadata: { ...metadata, [targetKey]: next }, updated_at: new Date().toISOString() })
      .eq("id", documentId).eq("org_id", orgId);
    if (updErr) throw new Error(updErr.message);
  }

  const appliedNow = landed.map((s) => s.tag);
  const appliedUnion = [...new Set([...alreadyApplied, ...appliedNow])];
  const leftOver = suggested.some((s) => !appliedUnion.includes(s.tag));
  await admin.from("document_equipment_suggestions").update({
    applied: appliedUnion,
    status: leftOver ? "pending" : "applied",
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
  admin: SupabaseClient, orgId: string,
  labels: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const neededLabels = new Set<string>(labels.filter((x): x is string => !!x));
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
