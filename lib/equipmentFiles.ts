"use client";

// lib/equipmentFiles.ts - a work order's equipment and its files, so a
// package starts from what the app already knows and builds the system out
// as the work is done.
//
// Where equipment files live: in document control (a library, as controlled
// documents with revisions), never in the equipment registry itself. The
// registry is the index: each piece of equipment lists every document
// tagged to it, by a person or by the drawing reader. Filing a file "to the
// equipment" makes it a controlled document in the workspace's place for
// equipment files (the unit's folder when the library has one) and tags it
// to the equipment, so the asset, the library and the next package all find
// the same document.

import { supabase } from "@/lib/supabase";
import { createDocumentWithFile } from "@/lib/revisions";
import { linkDocumentToAsset } from "@/lib/operationalGraph";
import { linkAssetFile } from "@/lib/assets";
import { docsByIds, equipDocs, folderForUnit, tagKey, type FindDoc } from "@/lib/findEverywhere";
import { ensureAssetFolder, loadTree, saveTree } from "@/lib/equipmentLibraryPush";
import type { EquipmentTree } from "@/lib/equipmentLibrary";
import type { ScopeWO } from "@/lib/woIntake";

export interface PackageAsset { id: string; tag: string; code: string | null; unitCode: string | null; description: string | null; typeId?: string | null }

/** The package's equipment in the registry: by its number, else by its tag
 *  when only one piece has it. Null when the registry doesn't have it (or
 *  the work is on a whole unit, "20 - Crude"). */
export async function findPackageAsset(orgId: string, group: ScopeWO[]): Promise<PackageAsset | null> {
  const first = group.find((x) => x.equipment || x.tag);
  if (!first) return null;
  type Row = { id: string; tag: string; code: string | null; unit_code: string | null; description: string | null; type_id: string | null };
  const pick = (r: Row): PackageAsset => ({ id: r.id, tag: r.tag, code: r.code, unitCode: r.unit_code, description: r.description, typeId: r.type_id });
  const cols = "id, tag, code, unit_code, description, type_id";
  if (first.equipment) {
    const { data } = await supabase.from("assets").select(cols).eq("org_id", orgId).eq("archived", false).eq("code", first.equipment).limit(3);
    const rows = (data ?? []) as Row[];
    if (rows.length) return pick(rows[0]);
  }
  if (first.tag) {
    const key = tagKey(first.tag);
    const { data } = await supabase.from("assets").select(`${cols}, tag_normalized`).eq("org_id", orgId).eq("archived", false).ilike("tag_normalized", key).limit(3);
    const rows = (data ?? []) as Row[];
    if (rows.length === 1) return pick(rows[0]);
  }
  return null;
}

/** "X-1 Middle Naphtha Cooler (2030.01)". */
export const assetWords = (a: PackageAsset) => `${a.tag}${a.description ? ` ${a.description.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())}` : ""}${a.code ? ` (${a.code})` : ""}`;

/** The documents on file for it: tagged by a person or by the drawing
 *  reader, and everything in its Equipment Files folder. */
export async function assetDocs(orgId: string, assetId: string): Promise<FindDoc[]> {
  const [tagged, tree] = await Promise.all([equipDocs(orgId, assetId), loadTree(orgId).catch(() => null)]);
  const folder = tree?.assets?.[assetId];
  if (!folder) return tagged;
  const { data } = await supabase.from("documents").select("id").eq("collection_id", folder).neq("status", "Archived").limit(200);
  const more = ((data ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => !tagged.some((d) => d.id === id));
  return more.length ? [...tagged, ...(await docsByIds(more))] : tagged;
}

// ── The workspace's place for equipment files ───────────────────────────

/** The place for equipment files: the Equipment Files library pushed
 *  from Operating areas (with a folder for each piece of equipment), or
 *  a library picked for now. */
export type EquipmentFilesPlace = EquipmentTree;
export const loadEquipmentPlace = loadTree;
export const saveEquipmentPlace = (orgId: string, place: EquipmentFilesPlace) => saveTree(orgId, place);
/** The place has the operating areas' folders (pushed from Operating areas). */
export const hasTree = (p: EquipmentFilesPlace | null | undefined) => !!p?.assets;

export interface LibraryLite { id: string; name: string }
export async function listLibraries(orgId: string): Promise<LibraryLite[]> {
  const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
  return (data ?? []) as LibraryLite[];
}
/** A first suggestion for where equipment files go: a library named for
 *  drawings or equipment. */
export function suggestLibrary(libs: LibraryLite[]): LibraryLite | null {
  return libs.find((l) => /equipment/i.test(l.name)) ?? libs.find((l) => /drawing/i.test(l.name)) ?? null;
}

/** Where a file for this equipment goes: the unit's folder in the place's
 *  library when it has one, else the place's own folder. */
export async function folderFor(orgId: string, place: EquipmentFilesPlace, asset: PackageAsset, uid?: string | null): Promise<{ collectionId: string | null; folderPath: string[]; words: string }> {
  const { data: lib } = await supabase.from("libraries").select("name").eq("id", place.libraryId).maybeSingle();
  const libName = String((lib as { name?: string } | null)?.name ?? "the library");
  // The equipment's own folder in Equipment Files (made when it's new since the push).
  if (hasTree(place)) {
    const known = place.assets?.[asset.id];
    const f = known || uid
      ? await ensureAssetFolder(orgId, uid ?? "", { id: asset.id, tag: asset.tag, code: asset.code, unitCode: asset.unitCode, typeId: asset.typeId ?? null, description: asset.description }).catch(() => null)
      : null;
    if (f) return { collectionId: f.id, folderPath: f.path, words: [libName, ...f.path].join(" › ") };
  }
  if (asset.unitCode) {
    const unit = await folderForUnit(orgId, asset.unitCode, place.libraryId).catch(() => null);
    if (unit && unit.libraryId === place.libraryId) {
      const names = unit.chain.map((c) => c.name);
      return { collectionId: unit.chain[unit.chain.length - 1].id, folderPath: names, words: [libName, ...names].join(" › ") };
    }
  }
  if (place.collectionId) {
    const { data: col } = await supabase.from("collections").select("name").eq("id", place.collectionId).maybeSingle();
    const name = String((col as { name?: string } | null)?.name ?? "");
    return { collectionId: place.collectionId, folderPath: name ? [name] : [], words: [libName, name].filter(Boolean).join(" › ") };
  }
  return { collectionId: null, folderPath: [], words: libName };
}

/** A document number from a file's name ("X-1 Bundle Drawing.pdf" → "X-1 Bundle Drawing"). */
export const numberFromName = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** A document already numbered so in the workspace (to add instead of a copy). */
export async function existingDoc(orgId: string, number: string): Promise<{ id: string; libraryId: string; currentVersionId: string | null; rev: string | null } | null> {
  const { data } = await supabase.from("documents").select("id, library_id, current_version_id, rev").eq("org_id", orgId).eq("document_number", number).neq("status", "Archived").limit(1);
  const r = ((data ?? []) as Array<{ id: string; library_id: string; current_version_id: string | null; rev: string | null }>)[0];
  return r ? { id: r.id, libraryId: r.library_id, currentVersionId: r.current_version_id, rev: r.rev } : null;
}

/** File it to the equipment for good: a controlled document in the place,
 *  tagged to the equipment and on its list of files. */
export async function fileToAsset(input: {
  orgId: string; place: EquipmentFilesPlace; asset: PackageAsset; file: File; number: string; title?: string;
  /** What it came from, kept on the document ("WO 300939 package"). */
  from: string;
  /** The project whose work package it came from: listed there too. */
  projectId?: string;
  actorUserId: string; actorEmail?: string;
}): Promise<{ documentId: string; libraryId: string; versionId: string | null; words: string }> {
  const where = await folderFor(input.orgId, input.place, input.asset, input.actorUserId);
  const { documentId } = await createDocumentWithFile({
    orgId: input.orgId, libraryId: input.place.libraryId, collectionId: where.collectionId, folderPath: where.folderPath,
    documentNumber: input.number, title: input.title || input.number, file: input.file,
    actorUserId: input.actorUserId, actorEmail: input.actorEmail,
  });
  // Where it came from, so document control can see it was filed from the
  // field; and tagged with the equipment the way every document is (its
  // page, search and the drawing reader all read the tag).
  await supabase.from("documents").update({ metadata: { filed_from: input.from, filed_for: input.asset.tag }, asset_tags: [{ tag: input.asset.tag }] }).eq("id", documentId).then(() => undefined, () => undefined);
  await linkDocumentToAsset(input.orgId, documentId, input.asset.id);
  // On the project's Documents tab and in the graph with the project.
  if (input.projectId) await supabase.from("project_documents").upsert(
    { org_id: input.orgId, project_id: input.projectId, document_id: documentId, source: "manual", last_seen_at: new Date().toISOString() },
    { onConflict: "project_id,document_id", ignoreDuplicates: false },
  ).then(() => undefined, () => undefined);
  if (input.actorUserId) await linkAssetFile({ orgId: input.orgId, assetId: input.asset.id, documentId, createdBy: input.actorUserId }).catch(() => undefined);
  const { data: d } = await supabase.from("documents").select("current_version_id").eq("id", documentId).maybeSingle();
  return { documentId, libraryId: input.place.libraryId, versionId: (d as { current_version_id?: string | null } | null)?.current_version_id ?? null, words: where.words };
}
