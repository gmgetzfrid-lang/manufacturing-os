"use client";

// lib/equipmentLibraryPush.ts - making (and growing) the Equipment Files
// library from the operating areas (the plan is lib/equipmentLibrary).
// The library is made once (or an existing one by that name is used, so
// pushing twice never makes two); folders go in level by level in batches,
// reusing any folder already there with the same name in the same place;
// the map is saved with the workspace's place for equipment files; each
// unit's page gets its folder pinned ("Equipment files").

import { supabase } from "@/lib/supabase";
import { createFolder, moveFolderServer, renameFolderAndDescendants } from "@/lib/libraryCollections";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { createAsset, createAssetType, invalidateAssetCache, listAssets, listAssetTypes } from "@/lib/assets";
import { loadCodebook, saveUnitLinks, upsertEntry, type UnitResourceLink } from "@/lib/codebook";
import { mutateConfig, readConfig } from "@/lib/woPackages";
import { NO_UNIT, planSync, planTree, syncCount, typeKeyOf, type EquipmentTree, type FolderFact, type PlannedFolder, type SyncPlan, type TreeAsset, type TreeType } from "@/lib/equipmentLibrary";
import { eqtypeId } from "@/lib/estate/folderMarks";
import { defaultLibraryAccess } from "@/lib/libraryAccess";

export const TREE_KEY = "equipment_files_place";

export async function loadTree(orgId: string): Promise<EquipmentTree | null> {
  const { data } = await readConfig<EquipmentTree>(orgId, TREE_KEY);
  return data?.libraryId ? data : null;
}
export function saveTree(orgId: string, tree: EquipmentTree): Promise<EquipmentTree> {
  return mutateConfig<EquipmentTree | null>(orgId, TREE_KEY, null, () => tree).then(() => tree);
}

/** Equipment types with their site codebook number, matched by name the way
 *  Operating areas matches them ("Exchangers" is code 30). */
export function numberTypes(types: Array<{ id: string; name: string }>, codebookTypes: Array<{ code: string; label: string }>): TreeType[] {
  const codeOf = new Map(codebookTypes.map((t) => [t.label.trim().toLowerCase(), t.code]));
  return types.map((t) => ({ id: t.id, name: t.name, code: codeOf.get(t.name.trim().toLowerCase()) ?? null }));
}

/** What the site encoding and the registry hold, for planning. */
export async function treeInputs(orgId: string) {
  const [cb, types, assets] = await Promise.all([loadCodebook(orgId), listAssetTypes(orgId), listAssets({ orgId, archived: false })]);
  return {
    units: cb.units.map((u) => ({ code: u.code, label: u.label })),
    types: numberTypes(types, cb.equipmentTypes),
    assets: assets.map((a): TreeAsset => ({ id: a.id, tag: a.tag, code: a.code ?? null, unitCode: a.unit_code ?? null, typeId: a.type_id, description: a.description })),
  };
}

type Col = { id: string; name: string; parent_id: string | null; path_names: string[] | null; path_ids: string[] | null };

/** The tree without folders that are gone or in the trash (a controller
 *  deleted one): those are made again, never filed into. */
export async function liveTree(tree: EquipmentTree): Promise<EquipmentTree> {
  const ids = [...new Set([...Object.values(tree.units ?? {}), ...Object.values(tree.types ?? {}), ...Object.values(tree.assets ?? {}), ...(tree.collectionId ? [tree.collectionId] : [])])];
  if (!ids.length) return tree;
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("collections").select("id").in("id", ids.slice(i, i + 200)).is("deleted_at", null);
    if (error) return tree; // Can't tell: keep the map as it is.
    for (const r of (data ?? []) as Array<{ id: string }>) live.add(r.id);
  }
  if (live.size === ids.length) return tree;
  const keep = (m?: Record<string, string>) => m ? Object.fromEntries(Object.entries(m).filter(([, id]) => live.has(id))) : m;
  return { ...tree, units: keep(tree.units), types: keep(tree.types), assets: keep(tree.assets), collectionId: tree.collectionId && !live.has(tree.collectionId) ? null : tree.collectionId };
}

/** The columns that carry a library's access (and its look), copied as one;
 *  only these, by name (never its id or name). */
const ACCESS_KEYS = ["type", "custom_columns", "write_access", "admin_access", "read_access", "visible_to", "folder_security", "default_new_visibility", "default_new_acl", "acl", "acl_index"] as const;
const ACCESS_COLS = ACCESS_KEYS.join(", ");

/** A new library for equipment files, with the same access as `accessFrom`
 *  (your Drawings library, say), else the library wizard's default.
 *  Never made with no rules: that would let every member add and change. */
async function makeLibrary(orgId: string, name: string, uid: string, accessFrom?: string | null): Promise<{ id: string; name: string }> {
  let access: Record<string, unknown> | null = null;
  if (accessFrom) {
    const { data } = await supabase.from("libraries").select(ACCESS_COLS).eq("id", accessFrom).eq("org_id", orgId).maybeSingle();
    const row = data as Record<string, unknown> | null;
    if (row && row.acl) access = Object.fromEntries(ACCESS_KEYS.filter((k) => k in row).map((k) => [k, row[k]]));
  }
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("libraries").insert({
    ...(access ?? defaultLibraryAccess(orgId)),
    name, description: "Equipment drawings and files, filed by operating area, equipment type and equipment.",
    org_id: orgId, created_at: now, created_by: uid, updated_at: now, updated_by: uid,
  }).select("id, name").single();
  if (error || !data) throw new Error(error?.message || "Couldn't make the library.");
  return data as { id: string; name: string };
}

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

export type Where =
  /** Its own library; `accessFrom` is the library whose access it copies. */
  | { own: true; name: string; accessFrom?: string | null }
  | { own: false; libraryId: string; folderName: string };

/** The tree's folders as they are now: name and parent (gone or in the
 *  trash: absent). */
export async function folderFacts(tree: EquipmentTree): Promise<Map<string, FolderFact>> {
  const ids = [...new Set([...Object.values(tree.units ?? {}), ...Object.values(tree.types ?? {}), ...Object.values(tree.assets ?? {})])];
  const out = new Map<string, FolderFact>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("collections").select("id, name, parent_id").in("id", ids.slice(i, i + 200)).is("deleted_at", null);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; name: string; parent_id: string | null }>) out.set(r.id, { name: r.name, parentId: r.parent_id ?? null });
  }
  return out;
}

/** What it takes to bring the library in step with the registry and the
 *  site codebook (nothing written). Null when there's no Equipment Files. */
export async function syncPlanFor(orgId: string, tree?: EquipmentTree | null, extra?: { units?: string[]; typeKeys?: string[] }): Promise<{ tree: EquipmentTree; plan: SyncPlan; inputs: Awaited<ReturnType<typeof treeInputs>> } | null> {
  const stored = tree === undefined ? await loadTree(orgId) : tree;
  if (!stored?.assets) return null;
  const live = await liveTree(stored);
  const [inputs, facts] = await Promise.all([treeInputs(orgId), folderFacts(live)]);
  return { tree: live, plan: planSync({ ...inputs, tree: live, folders: facts, extra }), inputs };
}

export interface SyncResult { tree: EquipmentTree; made: number; renamed: number; moved: number; pinned: number; marked: number }

/** Make, rename and move as the plan says; save the map; pin each unit's
 *  folder on its page; mark the new folders in the graph (or all of them). */
async function applySync(orgId: string, uid: string, email: string | undefined, base: EquipmentTree, plan: SyncPlan, say: (w: string) => void, wireAll: boolean): Promise<SyncResult> {
  const { tree: grown, made } = await applyPlan(orgId, base, plan.make, uid, (d, of) => say(`Making folders: ${d} of ${of}`));
  let renamed = 0;
  for (const [i, r] of plan.rename.entries()) {
    say(`Numbering and renaming folders: ${i + 1} of ${plan.rename.length}`);
    await renameFolderAndDescendants(r.id, r.to);
    renamed++;
  }
  let moved = 0;
  for (const [i, m] of plan.move.entries()) {
    const to = grown.types?.[m.toTypeKey];
    if (!to) continue;
    say(`Moving equipment folders to their type: ${i + 1} of ${plan.move.length}`);
    await moveFolderServer({ orgId, collectionId: m.id, newParentId: to });
    moved++;
  }
  const saved = await saveTree(orgId, { ...grown, pushedAt: base.pushedAt ?? new Date().toISOString(), pushedBy: base.pushedBy ?? email, syncedAt: new Date().toISOString() });

  // Each unit's page: its folder pinned (and its name kept current).
  let pinned = 0;
  const cb = await loadCodebook(orgId);
  const unitIds = Object.values(saved.units ?? {});
  const nameOf = new Map<string, string>();
  for (let i = 0; i < unitIds.length; i += 200) {
    const { data } = await supabase.from("collections").select("id, name").in("id", unitIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; name: string }>) nameOf.set(c.id, c.name);
  }
  for (const u of cb.units) {
    const folderId = saved.units?.[u.code];
    if (!folderId) continue;
    const links = (u.meta.links ?? []) as UnitResourceLink[];
    const have = links.find((l) => l.folderId === folderId);
    if (have && have.folderName === (nameOf.get(folderId) ?? have.folderName) && have.libraryName === saved.libraryName) continue;
    const link: UnitResourceLink = { id: have?.id ?? crypto.randomUUID(), label: "Equipment files", libraryId: saved.libraryId, libraryName: saved.libraryName ?? "Equipment Files", folderId, folderName: nameOf.get(folderId) ?? null };
    await saveUnitLinks(orgId, u.code, [...links.filter((l) => l.folderId !== folderId && l.label !== "Equipment files"), link]).then(() => { pinned++; }, () => undefined);
  }
  // The graph: every new folder marked for its unit, type or equipment.
  const before = new Set([...Object.values(base.units ?? {}), ...Object.values(base.types ?? {}), ...Object.values(base.assets ?? {})]);
  const fresh = new Set([...Object.values(saved.units ?? {}), ...Object.values(saved.types ?? {}), ...Object.values(saved.assets ?? {})].filter((f) => wireAll || !before.has(f)));
  const marked = fresh.size ? await wireGraph(orgId, saved, { userId: uid, name: email ?? null }, fresh) : 0;
  return { tree: saved, made, renamed, moved, pinned, marked };
}

/** Bring Equipment Files in step with the registry and the site codebook:
 *  new units, types and equipment get folders, renamed or renumbered ones
 *  are renamed, equipment whose type or unit changed moves (with its
 *  documents). Admin and Document Control only (the database makes and
 *  moves folders for them alone). Null when there's no Equipment Files. */
export async function syncTree(orgId: string, uid: string, email?: string, onStep?: (words: string) => void, extra?: { units?: string[]; typeKeys?: string[] }): Promise<SyncResult | null> {
  const p = await syncPlanFor(orgId, undefined, extra);
  if (!p) return null;
  if (!syncCount(p.plan)) return { tree: p.tree, made: 0, renamed: 0, moved: 0, pinned: 0, marked: 0 };
  return applySync(orgId, uid, email, p.tree, p.plan, onStep ?? (() => undefined), false);
}

/** Make or grow the Equipment Files library. */
export async function pushTree(input: {
  orgId: string; uid: string; email?: string; where: Where;
  allUnits: boolean; equipmentFolders: boolean;
  onStep?: (words: string) => void;
}): Promise<SyncResult> {
  const say = input.onStep ?? (() => undefined);
  const stored = await loadTree(input.orgId);
  const before = stored ? await liveTree(stored) : null;
  // Where it goes: the library (made once, or the one already named so).
  let libraryId: string, libraryName: string, collectionId: string | null = null;
  if (input.where.own) {
    const name = input.where.name.trim() || "Equipment Files";
    if (before?.own && before.libraryName?.toLowerCase() === name.toLowerCase()) { libraryId = before.libraryId; libraryName = before.libraryName; }
    else {
      const { data } = await supabase.from("libraries").select("id, name").eq("org_id", input.orgId);
      const same = ((data ?? []) as Array<{ id: string; name: string }>).find((l) => l.name.trim().toLowerCase() === name.toLowerCase());
      if (same) { libraryId = same.id; libraryName = same.name; }
      else { say(`Making the ${name} library`); const l = await makeLibrary(input.orgId, name, input.uid, input.where.accessFrom); libraryId = l.id; libraryName = l.name; }
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
  const base: EquipmentTree = { units: {}, types: {}, assets: {}, ...(samePlace ? before! : {}), libraryId, libraryName, collectionId, own: input.where.own,
    allUnits: input.allUnits, equipmentFolders: input.equipmentFolders, pushedAt: new Date().toISOString(), pushedBy: input.email };

  say("Reading the operating areas");
  const [inputs, facts] = await Promise.all([treeInputs(input.orgId), folderFacts(base)]);
  const plan = planSync({ ...inputs, tree: base, folders: facts });
  return applySync(input.orgId, input.uid, input.email, base, plan, say, true);
}

/** Where a piece of equipment's files go in Equipment Files: its own
 *  folder, made when it's new since the push (its unit and type folders too)
 *  by someone who may make folders (Admin, Document Control: the database
 *  holds the same rule). Anyone else files into the nearest folder there is
 *  (its type's, its unit's, the top) and `own` is false; the next update
 *  of the library gives it its own folder. Null when there's no tree. */
export async function ensureAssetFolder(orgId: string, uid: string, asset: TreeAsset, opts: { canMake: boolean } = { canMake: true }): Promise<{ id: string | null; path: string[]; own: boolean } | null> {
  const stored = await loadTree(orgId);
  if (!stored?.assets) return null;
  const tree = await liveTree(stored);
  let id: string | null = tree.assets?.[asset.id] ?? null;
  let own = !!id;
  if (!id && !opts.canMake) {
    const near = tree.types?.[typeKeyOf(asset.unitCode || NO_UNIT, asset.typeId)] ?? tree.units?.[asset.unitCode || NO_UNIT] ?? tree.collectionId ?? null;
    if (!near) return { id: null, path: [], own: false };
    const { data } = await supabase.from("collections").select("path_names").eq("id", near).maybeSingle();
    return { id: near, path: ((data as { path_names?: string[] } | null)?.path_names ?? []), own: false };
  }
  if (!id) {
    const cb = await loadCodebook(orgId);
    const types = await listAssetTypes(orgId).then((t) => numberTypes(t, cb.equipmentTypes), () => []);
    const plan = planTree({ units: cb.units.map((u) => ({ code: u.code, label: u.label })), types, assets: [asset], existing: tree, equipmentFolders: true });
    const { tree: grown } = await applyPlan(orgId, tree, plan.folders, uid);
    await saveTree(orgId, grown);
    // Its new folders in the graph too.
    const before = new Set([...Object.values(tree.units ?? {}), ...Object.values(tree.types ?? {}), ...Object.values(tree.assets ?? {})]);
    const fresh = new Set([...Object.values(grown.units ?? {}), ...Object.values(grown.types ?? {}), ...Object.values(grown.assets ?? {})].filter((f) => !before.has(f)));
    if (fresh.size) await wireGraph(orgId, grown, { userId: uid, name: null }, fresh).catch(() => undefined);
    own = !!grown.assets?.[asset.id];
    id = grown.assets?.[asset.id] ?? grown.types?.[typeKeyOf(asset.unitCode || NO_UNIT, asset.typeId)] ?? null;
  }
  if (!id) return null;
  const { data } = await supabase.from("collections").select("path_names").eq("id", id).maybeSingle();
  return { id, path: ((data as { path_names?: string[] } | null)?.path_names ?? []), own };
}

// ── From the library into the registry ─────────────────────────────────
// A folder made in the Equipment Files chain is a unit, a type or a piece of
// equipment: it goes into the site codebook or the registry first, and its
// folder follows from there (one source, never two lists to keep alike).

/** A new operating area: into the site codebook, then its folder. */
export async function addUnitFromLibrary(orgId: string, uid: string, email: string | undefined, unit: { code: string; label: string }): Promise<string | null> {
  const code = unit.code.trim(), label = unit.label.trim();
  await upsertEntry(orgId, { kind: "unit", code, label, meta: {} } as Parameters<typeof upsertEntry>[1], uid);
  const r = await syncTree(orgId, uid, email, undefined, { units: [code] });
  return r?.tree.units?.[code] ?? null;
}

/** An equipment type in a unit: the type from the site codebook (made in
 *  the registry's list of types if it isn't there yet), then its folder. */
export async function addTypeFromLibrary(orgId: string, uid: string, email: string | undefined, unitCode: string, type: { code: string; label: string }): Promise<string | null> {
  const types = await listAssetTypes(orgId);
  const have = types.find((t) => t.name.trim().toLowerCase() === type.label.trim().toLowerCase());
  const typeId = have?.id ?? (await createAssetType({ orgId, name: type.label.trim(), sortOrder: 99 })).id;
  const key = typeKeyOf(unitCode, typeId);
  const r = await syncTree(orgId, uid, email, undefined, { typeKeys: [key] });
  return r?.tree.types?.[key] ?? null;
}

/** A piece of equipment: into the registry in that unit and type, then its folder. */
export async function addEquipmentFromLibrary(orgId: string, uid: string, email: string | undefined, eq: { unitCode: string | null; typeId: string | null; tag: string; code: string; description: string }): Promise<string | null> {
  const a = await createAsset({ orgId, tag: eq.tag.trim(), code: eq.code.trim() || undefined, description: eq.description.trim() || undefined, unitCode: eq.unitCode && eq.unitCode !== NO_UNIT ? eq.unitCode : undefined, typeId: eq.typeId ?? undefined, createdBy: uid });
  invalidateAssetCache();
  const r = await syncTree(orgId, uid, email);
  return r?.tree.assets?.[a.id] ?? null;
}

