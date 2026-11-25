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
}

export interface TreeUnit { code: string; label: string }
export interface TreeType { id: string; name: string }
export interface TreeAsset { id: string; tag: string; code: string | null; unitCode: string | null; typeId: string | null; description: string | null }

/** One folder to make: where it sits and what it's for. */
export interface PlannedFolder { key: string; level: 1 | 2 | 3; name: string; parentKey: string | null; unit: string; typeKey?: string; assetIds?: string[] }

const tidy = (s: string) => s.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);

/** Equipment with no unit: its own folder, as Operating areas shows it. */
export const NO_UNIT = "__none";
export const unitFolderName = (u: TreeUnit) => u.code === NO_UNIT ? "No operating area" : tidy(u.label && u.label !== u.code ? `${u.code} - ${u.label}` : u.code);
/** Named as Operating areas names the groups ("No type yet" for untyped equipment). */
export const typeFolderName = (t: TreeType | undefined) => tidy(t?.name ?? "No type yet");
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
}): { folders: PlannedFolder[]; counts: { units: number; types: number; equipment: number }; example: string[] | null } {
  const have = input.existing ?? null;
  const typeName = new Map(input.types.map((t) => [t.id, t]));
  const label = new Map(input.units.map((u) => [u.code, u]));
  const unitOf = (a: TreeAsset) => a.unitCode || NO_UNIT;
  const withEquipment = new Set(input.assets.map(unitOf));
  const unitCodes = [...new Set([...(input.allUnits ? input.units.map((u) => u.code) : []), ...withEquipment])]
    .sort((a, b) => (a === NO_UNIT ? 1 : 0) - (b === NO_UNIT ? 1 : 0) || a.localeCompare(b, undefined, { numeric: true }));
  const folders: PlannedFolder[] = [];
  const counts = { units: 0, types: 0, equipment: 0 };
  for (const code of unitCodes) {
    const uKey = `u:${code}`;
    if (!have?.units?.[code]) { folders.push({ key: uKey, level: 1, name: unitFolderName(label.get(code) ?? { code, label: code }), parentKey: null, unit: code }); counts.units++; }
    const here = input.assets.filter((a) => unitOf(a) === code);
    const typeIds = [...new Set(here.map((a) => a.typeId))].sort((a, b) => typeFolderName(a ? typeName.get(a) : undefined).localeCompare(typeFolderName(b ? typeName.get(b) : undefined)));
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
