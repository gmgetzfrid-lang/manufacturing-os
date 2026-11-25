// lib/equipmentLibrary.ts - the Equipment Files library: document control
// laid out like the operating areas the site encoding built (a folder per
// unit, then per equipment type, then per piece of equipment), pushed from
// Operating areas and linked both ways so nothing is kept twice:
//
//   the library holds the files (controlled: revisions, status, holds);
//   each unit's page pins its folder, each piece of equipment shows the
//   documents in its folder (plus anything tagged to it), and a file filed
//   to equipment from a work package lands in its folder.
//
// Its own library (the default, so its access can be set on its own) or a
// folder inside an existing one. Pushing again only adds what's new (new
// units, types or equipment); nothing is moved or deleted. The map of
// folders is kept in the workspace's settings with the place for equipment
// files (lib/equipmentFiles reads it). planTree is pure; the rest writes.

export interface EquipmentTree {
  libraryId: string;
  /** The folder it all sits under (a folder in a library); null: the library's top. */
  collectionId: string | null;
  libraryName?: string;
  /** Its own library, or a folder in one. */
  own?: boolean;
  /** unit code → folder; `${unit}|${typeId or "none"}` → folder; asset id → folder. */
  units?: Record<string, string>;
  types?: Record<string, string>;
  assets?: Record<string, string>;
  pushedAt?: string;
  pushedBy?: string;
  /** Last brought in step with the registry and the codebook. */
  syncedAt?: string;
  /** A folder for every unit in the site codebook, not only ones with equipment. */
  allUnits?: boolean;
  /** A folder for each piece of equipment (else files sit in its type's folder). */
  equipmentFolders?: boolean;
}

export interface TreeUnit { code: string; label: string }
/** An equipment type; `code` is its number in the site codebook ("30"). */
export interface TreeType { id: string; name: string; code?: string | null }
export interface TreeAsset { id: string; tag: string; code: string | null; unitCode: string | null; typeId: string | null; description: string | null }

/** One folder to make: where it sits and what it's for. */
export interface PlannedFolder { key: string; level: 1 | 2 | 3; name: string; parentKey: string | null; unit: string; typeKey?: string; assetIds?: string[] }

const tidy = (s: string) => s.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);

/** Equipment with no unit: its own folder, as Operating areas shows it. */
export const NO_UNIT = "__none";
export const unitFolderName = (u: TreeUnit) => u.code === NO_UNIT ? "No operating area" : tidy(u.label && u.label !== u.code ? `${u.code} - ${u.label}` : u.code);
/** Numbered as the site encoding numbers it ("30 - Exchangers"); "No type
 *  yet" for untyped equipment, as Operating areas shows it. */
export const typeFolderName = (t: TreeType | undefined) => tidy(!t ? "No type yet" : t.code ? `${t.code} - ${t.name}` : t.name);
export function assetFolderName(a: TreeAsset): string {
  // As the registry writes it (Operating areas shows it so; "VGO" stays "VGO").
  const desc = a.description ?? "";
  const head = [a.tag, desc].filter(Boolean).join(" ");
  return tidy(a.code && a.code !== a.tag ? `${head} (${a.code})` : head || a.code || "Equipment");
}
export const typeKeyOf = (unit: string, typeId: string | null) => `${unit}|${typeId ?? "none"}`;

/** The folders to make: a unit folder for each unit (with equipment, or all
 *  of them), a type folder for each type in a unit, a folder for each piece
 *  of equipment. Ones the tree already has are left out; two pieces with the
 *  same name in one place share a folder. */
export function planTree(input: {
  units: TreeUnit[]; types: TreeType[]; assets: TreeAsset[];
  existing?: EquipmentTree | null;
  /** Units with no equipment yet get a folder too. */
  allUnits?: boolean;
  /** A folder for each piece of equipment (else files go in its type's folder). */
  equipmentFolders?: boolean;
  /** Made though nothing is in them yet: a unit or a type added from the library. */
  extra?: { units?: string[]; typeKeys?: string[] };
}): { folders: PlannedFolder[]; counts: { units: number; types: number; equipment: number }; example: string[] | null } {
  const have = input.existing ?? null;
  const typeName = new Map(input.types.map((t) => [t.id, t]));
  const label = new Map(input.units.map((u) => [u.code, u]));
  const unitOf = (a: TreeAsset) => a.unitCode || NO_UNIT;
  const withEquipment = new Set(input.assets.map(unitOf));
  const extraTypes = input.extra?.typeKeys ?? [];
  const unitCodes = [...new Set([...(input.allUnits ? input.units.map((u) => u.code) : []), ...withEquipment, ...(input.extra?.units ?? []), ...extraTypes.map((k) => k.split("|")[0])])]
    .sort((a, b) => (a === NO_UNIT ? 1 : 0) - (b === NO_UNIT ? 1 : 0) || a.localeCompare(b, undefined, { numeric: true }));
  const folders: PlannedFolder[] = [];
  const counts = { units: 0, types: 0, equipment: 0 };
  for (const code of unitCodes) {
    const uKey = `u:${code}`;
    if (!have?.units?.[code]) { folders.push({ key: uKey, level: 1, name: unitFolderName(label.get(code) ?? { code, label: code }), parentKey: null, unit: code }); counts.units++; }
    const here = input.assets.filter((a) => unitOf(a) === code);
    const typeIds = [...new Set([...here.map((a) => a.typeId), ...extraTypes.filter((k) => k.split("|")[0] === code).map((k) => { const t = k.split("|")[1]; return t === "none" ? null : t; })])].sort((a, b) => typeFolderName(a ? typeName.get(a) : undefined).localeCompare(typeFolderName(b ? typeName.get(b) : undefined)));
    for (const t of typeIds) {
      const tk = typeKeyOf(code, t);
      if (!have?.types?.[tk]) { folders.push({ key: `t:${tk}`, level: 2, name: typeFolderName(t ? typeName.get(t) : undefined), parentKey: uKey, unit: code, typeKey: tk }); counts.types++; }
      if (input.equipmentFolders === false) continue;
      const byName = new Map<string, string[]>();
      for (const a of here.filter((x) => x.typeId === t)) {
        if (have?.assets?.[a.id]) continue;
        const n = assetFolderName(a);
        byName.set(n, [...(byName.get(n) ?? []), a.id]);
      }
      for (const [n, ids] of [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        folders.push({ key: `a:${ids[0]}`, level: 3, name: n, parentKey: `t:${tk}`, unit: code, typeKey: tk, assetIds: ids });
        counts.equipment++;
      }
    }
  }
  const sample = input.assets.find((a) => a.unitCode && a.tag) ?? input.assets[0] ?? null;
  const example = sample ? [unitFolderName(label.get(unitOf(sample)) ?? { code: unitOf(sample), label: unitOf(sample) }), typeFolderName(sample.typeId ? typeName.get(sample.typeId) : undefined), ...(input.equipmentFolders === false ? [] : [assetFolderName(sample)])] : null;
  return { folders, counts, example };
}

// ── Keeping it in step ───────────────────────────────────────────────────
// The registry and the site codebook are the source; the library follows.
// What's missing is made, what's named differently is renamed, equipment
// whose type or unit changed has its folder (and its documents) moved.
// Nothing is deleted: equipment taken out of the registry keeps its folder
// and its controlled documents.

export interface FolderFact { name: string; parentId: string | null }
export interface SyncPlan {
  make: PlannedFolder[];
  rename: Array<{ id: string; from: string; to: string }>;
  /** An equipment folder to move under its (maybe new) type folder. */
  move: Array<{ id: string; assetId: string; toTypeKey: string }>;
}

export function planSync(input: {
  units: TreeUnit[]; types: TreeType[]; assets: TreeAsset[];
  tree: EquipmentTree;
  /** The tree's folders as they are now (gone or in the trash: absent). */
  folders: Map<string, FolderFact>;
  extra?: { units?: string[]; typeKeys?: string[] };
}): SyncPlan {
  const { tree, folders } = input;
  const allUnits = tree.allUnits ?? true;
  const equipmentFolders = tree.equipmentFolders ?? true;
  const make = planTree({ units: input.units, types: input.types, assets: input.assets, existing: tree, allUnits, equipmentFolders, extra: input.extra }).folders;
  const label = new Map(input.units.map((u) => [u.code, u]));
  const typeOf = new Map(input.types.map((t) => [t.id, t]));
  const assetOf = new Map(input.assets.map((a) => [a.id, a]));
  const rename: SyncPlan["rename"] = [];
  const want = (id: string, to: string) => { const f = folders.get(id); if (f && f.name !== to) rename.push({ id, from: f.name, to }); };
  for (const [code, id] of Object.entries(tree.units ?? {})) {
    if (code === NO_UNIT) want(id, unitFolderName({ code, label: code }));
    else if (label.has(code)) want(id, unitFolderName(label.get(code)!));
  }
  for (const [tk, id] of Object.entries(tree.types ?? {})) {
    const tid = tk.split("|")[1];
    if (tid === "none") want(id, typeFolderName(undefined));
    else if (typeOf.has(tid)) want(id, typeFolderName(typeOf.get(tid)));
  }
  // Equipment folders: one name per folder (two pieces sharing one keep it).
  const byFolder = new Map<string, TreeAsset[]>();
  for (const [aid, fid] of Object.entries(tree.assets ?? {})) { const a = assetOf.get(aid); if (a) byFolder.set(fid, [...(byFolder.get(fid) ?? []), a]); }
  const move: SyncPlan["move"] = [];
  for (const [fid, list] of byFolder) {
    const names = new Set(list.map(assetFolderName));
    if (names.size === 1) want(fid, [...names][0]);
    const keys = new Set(list.map((a) => typeKeyOf(a.unitCode || NO_UNIT, a.typeId)));
    const f = folders.get(fid);
    if (!f || keys.size !== 1 || !equipmentFolders) continue;
    const toTypeKey = [...keys][0];
    if (tree.types?.[toTypeKey] !== f.parentId) move.push({ id: fid, assetId: list[0].id, toTypeKey });
  }
  return { make, rename, move };
}

export const syncCount = (p: SyncPlan) => p.make.length + p.rename.length + p.move.length;

