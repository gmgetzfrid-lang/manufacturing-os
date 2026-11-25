"use client";

// lib/equipmentLibraryPush.ts - making (and growing) the Equipment Files
// library from the operating areas (the plan is lib/equipmentLibrary).
// The library is made once (or an existing one by that name is used, so
// pushing twice never makes two); folders go in level by level in batches,
// reusing any folder already there with the same name in the same place;
// the map is saved with the workspace's place for equipment files; each
// unit's page gets its folder pinned ("Equipment files").

import { supabase } from "@/lib/supabase";
import { createFolder, createLibrary } from "@/lib/libraryCollections";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { listAssets, listAssetTypes } from "@/lib/assets";
import { loadCodebook, saveUnitLinks, type UnitResourceLink } from "@/lib/codebook";
import { mutateConfig, readConfig } from "@/lib/woPackages";
import { NO_UNIT, planTree, typeKeyOf, type EquipmentTree, type PlannedFolder, type TreeAsset } from "@/lib/equipmentLibrary";
import { eqtypeId } from "@/lib/estate/folderMarks";

export const TREE_KEY = "equipment_files_place";

export async function loadTree(orgId: string): Promise<EquipmentTree | null> {
  const { data } = await readConfig<EquipmentTree>(orgId, TREE_KEY);
  return data?.libraryId ? data : null;
}
export function saveTree(orgId: string, tree: EquipmentTree): Promise<EquipmentTree> {
  return mutateConfig<EquipmentTree | null>(orgId, TREE_KEY, null, () => tree).then(() => tree);
}

/** What the site encoding and the registry hold, for planning. */
export async function treeInputs(orgId: string) {
  const [cb, types, assets] = await Promise.all([loadCodebook(orgId), listAssetTypes(orgId), listAssets({ orgId, archived: false })]);
  return {
    units: cb.units.map((u) => ({ code: u.code, label: u.label })),
    types: types.map((t) => ({ id: t.id, name: t.name })),
    assets: assets.map((a): TreeAsset => ({ id: a.id, tag: a.tag, code: a.code ?? null, unitCode: a.unit_code ?? null, typeId: a.type_id, description: a.description })),
  };
}

type Col = { id: string; name: string; parent_id: string | null; path_names: string[] | null; path_ids: string[] | null };

/** Make the folders in `plan` that aren't there, level by level; returns
 *  the tree with every folder mapped. */
async function applyPlan(orgId: string, tree: EquipmentTree, folders: PlannedFolder[], uid: string, onStep?: (done: number, of: number) => void): Promise<{ tree: EquipmentTree; made: number }> {
  const next: EquipmentTree = { ...tree, units: { ...(tree.units ?? {}) }, types: { ...(tree.types ?? {}) }, assets: { ...(tree.assets ?? {}) } };
  if (!folders.length) return { tree: next, made: 0 };
  const { rows } = await fetchAllRows<Col>((from, to) => supabase.from("collections").select("id, name, parent_id, path_names, path_ids")
    .eq("library_id", tree.libraryId).is("deleted_at", null).order("id").range(from, to), 50_000);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const at = (parent: string | null, name: string) => rows.find((c) => (c.parent_id ?? null) === parent && c.name.toLowerCase() === name.toLowerCase());
  const idOf = new Map<string, string>();
  // Folders the tree already has stand in for their keys.
  for (const [code, id] of Object.entries(next.units ?? {})) idOf.set(`u:${code}`, id);
  for (const [tk, id] of Object.entries(next.types ?? {})) idOf.set(`t:${tk}`, id);
  let made = 0, done = 0;
  for (const level of [1, 2, 3] as const) {
    const here = folders.filter((f) => f.level === level);
    const toMake: Array<{ f: PlannedFolder; parent: string | null }> = [];
    for (const f of here) {
      const parent = f.parentKey ? idOf.get(f.parentKey) ?? null : tree.collectionId;
      if (f.parentKey && !parent) continue;
      const there = at(parent, f.name);
      if (there) idOf.set(f.key, there.id); else toMake.push({ f, parent });
    }
    for (let i = 0; i < toMake.length; i += 100) {
      const slice = toMake.slice(i, i + 100);
      const ins = slice.map(({ f, parent }) => {
        const p = parent ? byId.get(parent) : null;
        const names = [...(p ? (p.path_names ?? []) : []), f.name];
        const ids = parent ? [...(p?.path_ids ?? []), parent] : [];
        return { org_id: orgId, library_id: tree.libraryId, parent_id: parent, name: f.name, path: names, path_names: names, path_ids: ids, visibility: "normal", acl: null, acl_index: null, created_by: uid };
      });
      const { data, error } = await supabase.from("collections").insert(ins).select("id, name, parent_id, path_names, path_ids");
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as Col[]) {
        rows.push(c); byId.set(c.id, c);
        const hit = slice.find((s) => (s.parent ?? null) === (c.parent_id ?? null) && s.f.name === c.name);
        if (hit) idOf.set(hit.f.key, c.id);
      }
      made += (data ?? []).length;
      done += slice.length;
      onStep?.(done, folders.length);
    }
    done += here.length - toMake.length;
    onStep?.(done, folders.length);
  }
  for (const f of folders) {
    const id = idOf.get(f.key);
    if (!id) continue;
    if (f.level === 1) next.units![f.unit] = id;
    else if (f.level === 2 && f.typeKey) next.types![f.typeKey] = id;
    else for (const a of f.assetIds ?? []) next.assets![a] = id;
  }
  return { tree: next, made };
}

/** The graph: each folder marked for what it is, the way a person marks a
 *  folder by hand (a unit's folder belongs to the unit, a type's folder is
 *  that equipment type, an equipment folder is that piece's folder). The org
 *  graph, find and the unit-folder lookup all read these marks, so every
 *  document filed under them is drawn to its unit and equipment. Only the
 *  folders given (or all the tree has). */
export async function wireGraph(orgId: string, tree: EquipmentTree, actor: { userId: string; name: string | null }, only?: Set<string>): Promise<number> {
  const [cb, types] = await Promise.all([loadCodebook(orgId).catch(() => null), listAssetTypes(orgId).catch(() => [])]);
  const unitLabel = new Map((cb?.units ?? []).map((u) => [u.code, u.label]));
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const at = new Date().toISOString();
  const base = { org_id: orgId, origin: "human", tier: "provable", confidence: 1, status: "applied", evidence: { madeBy: "Equipment Files", markedBy: actor.name },
    created_by: actor.userId, created_by_name: actor.name, decided_by: actor.userId, decided_by_name: actor.name, decided_at: at };
  const rows: Array<Record<string, unknown>> = [];
  const want = (fid: string) => !only || only.has(fid);
  for (const [code, fid] of Object.entries(tree.units ?? {})) {
    if (code === NO_UNIT || !want(fid)) continue;
    rows.push({ ...base, a: `folder:${fid}`, b: `cbunit:${code}`, type: "belongs_to_unit", summary: `Equipment Files folder for ${unitLabel.get(code) ?? `unit ${code}`} (${code})` });
  }
  for (const [tk, fid] of Object.entries(tree.types ?? {})) {
    const tid = tk.split("|")[1];
    const name = tid && tid !== "none" ? typeName.get(tid) : null;
    if (!name || !want(fid)) continue;
    rows.push({ ...base, a: `folder:${fid}`, b: eqtypeId(name), type: "of_type", summary: `Equipment under this Equipment Files folder is ${name}` });
  }
  for (const [assetId, fid] of Object.entries(tree.assets ?? {})) {
    if (!want(fid)) continue;
    rows.push({ ...base, a: `folder:${fid}`, b: `asset:${assetId}`, type: "about_asset", summary: "This Equipment Files folder is the equipment's own folder" });
  }
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("estate_edges").upsert(rows.slice(i, i + 200), { onConflict: "org_id,a,b,type" });
    if (error) throw new Error(error.message);
    n += Math.min(200, rows.length - i);
  }
  return n;
}

export type Where = { own: true; name: string } | { own: false; libraryId: string; folderName: string };

/** Make or grow the Equipment Files library. */
export async function pushTree(input: {
  orgId: string; uid: string; email?: string; where: Where;
  allUnits: boolean; equipmentFolders: boolean;
  onStep?: (words: string) => void;
}): Promise<{ tree: EquipmentTree; made: number; pinned: number; marked: number }> {
  const say = input.onStep ?? (() => undefined);
  const before = await loadTree(input.orgId);
  // Where it goes: the library (made once, or the one already named so).
  let libraryId: string, libraryName: string, collectionId: string | null = null;
  if (input.where.own) {
    const name = input.where.name.trim() || "Equipment Files";
    if (before?.own && before.libraryName?.toLowerCase() === name.toLowerCase()) { libraryId = before.libraryId; libraryName = before.libraryName; }
    else {
      const { data } = await supabase.from("libraries").select("id, name").eq("org_id", input.orgId);
      const same = ((data ?? []) as Array<{ id: string; name: string }>).find((l) => l.name.trim().toLowerCase() === name.toLowerCase());
      if (same) { libraryId = same.id; libraryName = same.name; }
      else { say(`Making the ${name} library`); const l = await createLibrary({ orgId: input.orgId, name, createdBy: input.uid }); libraryId = l.id; libraryName = l.name; }
    }
  } else {
    libraryId = input.where.libraryId;
    const { data: lib } = await supabase.from("libraries").select("name").eq("id", libraryId).maybeSingle();
    libraryName = String((lib as { name?: string } | null)?.name ?? "the library");
    const name = input.where.folderName.trim() || "Equipment Files";
    if (before && !before.own && before.libraryId === libraryId && before.collectionId) collectionId = before.collectionId;
    else {
      const { data } = await supabase.from("collections").select("id, name").eq("library_id", libraryId).is("parent_id", null).is("deleted_at", null);
      const same = ((data ?? []) as Array<{ id: string; name: string }>).find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
      collectionId = same?.id ?? await createFolder({ orgId: input.orgId, libraryId, parentId: null, name, createdBy: input.uid });
    }
  }
  // A new place starts a new map; the same place keeps its folders.
  const samePlace = !!before && before.libraryId === libraryId && (before.collectionId ?? null) === collectionId;
  const base: EquipmentTree = { ...(samePlace ? before! : {}), libraryId, libraryName, collectionId, own: input.where.own };

  say("Reading the operating areas");
  const inputs = await treeInputs(input.orgId);
  const plan = planTree({ ...inputs, existing: samePlace ? before : null, allUnits: input.allUnits, equipmentFolders: input.equipmentFolders });
  const { tree, made } = await applyPlan(input.orgId, base, plan.folders, input.uid, (d, of) => say(`Making folders: ${d} of ${of}`));
  const saved = await saveTree(input.orgId, { ...tree, pushedAt: new Date().toISOString(), pushedBy: input.email });

  // Each unit's page: its folder pinned.
  say("Pinning each unit's folder");
  let pinned = 0;
  const cb = await loadCodebook(input.orgId);
  const { data: names } = await supabase.from("collections").select("id, name").in("id", Object.values(saved.units ?? {}).slice(0, 500));
  const nameOf = new Map(((names ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  for (const u of cb.units) {
    const folderId = saved.units?.[u.code];
    if (!folderId) continue;
    const links = (u.meta.links ?? []) as UnitResourceLink[];
    if (links.some((l) => l.folderId === folderId)) continue;
    const link: UnitResourceLink = { id: crypto.randomUUID(), label: "Equipment files", libraryId, libraryName, folderId, folderName: nameOf.get(folderId) ?? null };
    await saveUnitLinks(input.orgId, u.code, [...links.filter((l) => l.label !== "Equipment files"), link]).then(() => { pinned++; }, () => undefined);
  }
  // The graph: every folder marked for its unit, type or equipment.
  say("Linking the folders in the graph");
  const marked = await wireGraph(input.orgId, saved, { userId: input.uid, name: input.email ?? null });
  return { tree: saved, made, pinned, marked };
}

/** A piece of equipment's folder, made when it's new since the push (its
 *  unit and type folders too). Null when there's no Equipment Files tree. */
export async function ensureAssetFolder(orgId: string, uid: string, asset: TreeAsset): Promise<{ id: string; path: string[] } | null> {
  const tree = await loadTree(orgId);
  if (!tree?.assets) return null;
  let id: string | null = tree.assets[asset.id] ?? null;
  if (!id) {
    const types = await listAssetTypes(orgId).then((t) => t.map((x) => ({ id: x.id, name: x.name })), () => []);
    const cb = await loadCodebook(orgId);
    const plan = planTree({ units: cb.units.map((u) => ({ code: u.code, label: u.label })), types, assets: [asset], existing: tree, equipmentFolders: true });
    const { tree: grown } = await applyPlan(orgId, tree, plan.folders, uid);
    await saveTree(orgId, grown);
    // Its new folders in the graph too.
    const before = new Set([...Object.values(tree.units ?? {}), ...Object.values(tree.types ?? {}), ...Object.values(tree.assets ?? {})]);
    const fresh = new Set([...Object.values(grown.units ?? {}), ...Object.values(grown.types ?? {}), ...Object.values(grown.assets ?? {})].filter((f) => !before.has(f)));
    if (fresh.size) await wireGraph(orgId, grown, { userId: uid, name: null }, fresh).catch(() => undefined);
    id = grown.assets?.[asset.id] ?? grown.types?.[typeKeyOf(asset.unitCode || NO_UNIT, asset.typeId)] ?? null;
  }
  if (!id) return null;
  const { data } = await supabase.from("collections").select("path_names").eq("id", id).maybeSingle();
  return { id, path: ((data as { path_names?: string[] } | null)?.path_names ?? []) };
}
