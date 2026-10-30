// lib/estate/folderMarks.ts — "this folder IS the crude unit / the heaters /
// H-1." A person marks what a folder stands for; everything filed under it
// inherits: documents land on that operating area or that piece of
// equipment, equipment folders under an area belong to it, equipment under
// a type folder is that type. An equipment-files library laid out
// area / equipment / documents is set up in one pass, level by level. Pure.

export type MarkKind = "area" | "type" | "equipment";
export type LevelMeaning = MarkKind | "skip";

export interface FolderMarkState {
  area?: { code: string; label: string };
  type?: string;
  equipment?: { assetId: string; tag: string };
}

/** The type-mark node id: folder → `eqtype:Heaters`. */
export const eqtypeId = (label: string) => `eqtype:${label.trim()}`;

/** "H-1 Crude Heater", "H-1 - Crude heater", "P101A", "Crude Heater (H-1)"
 *  → tag and name. A word and a number with a space between ("Unit 20",
 *  "Area 3") is not a tag. */
export function equipmentFromFolderName(name: string): { tag: string; name: string | null } | null {
  const s = name.trim();
  const re = /(?:^|[^A-Za-z0-9])([A-Za-z]{1,5})-?(\d{1,6}[A-Za-z]{0,3})(?![A-Za-z0-9])/;
  const m = s.match(re);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  if (["REV", "SHT", "SH", "DWG", "PG", "NO", "VOL", "PART", "ISO", "API", "ASME", "IFC", "IFR"].includes(prefix)) return null;
  const tag = `${prefix}-${m[2].toUpperCase()}`;
  const rest = (s.slice(0, m.index ?? 0) + " " + s.slice((m.index ?? 0) + m[0].length))
    .replace(/[()[\]]/g, " ").replace(/^[\s\-–:_.]+|[\s\-–:_.]+$/g, "").replace(/\s{2,}/g, " ").trim();
  return { tag, name: rest || null };
}

export interface PlanFolder { id: string; parentId: string | null; name: string }
export interface PlanRow {
  folderId: string;
  path: string;
  depth: number;
  kind: MarkKind;
  /** What it becomes: a unit label, a type label, an equipment tag. */
  value: string | null;
  /** The unit code or asset id it matched, when it did. */
  ref: string | null;
  status: "match" | "new" | "unmatched";
  note?: string;
}

/** What each folder of a library becomes when its levels mean `levels`
 *  (level 1 = the library's top folders). */
export function planStructure(
  folders: PlanFolder[],
  levels: LevelMeaning[],
  find: { unit: (name: string) => { code: string; label: string } | null; asset: (tag: string) => { id: string } | null },
): PlanRow[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain = (f: PlanFolder): PlanFolder[] => {
    const out: PlanFolder[] = []; const seen = new Set<string>();
    let cur: PlanFolder | undefined = f;
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  };
  const rows: PlanRow[] = [];
  for (const f of folders) {
    const c = chain(f);
    const depth = c.length;
    const meaning = levels[depth - 1];
    if (!meaning || meaning === "skip") continue;
    const path = c.map((x) => x.name).join(" / ");
    if (meaning === "area") {
      const u = find.unit(f.name);
      rows.push(u ? { folderId: f.id, path, depth, kind: "area", value: u.label, ref: u.code, status: "match" }
        : { folderId: f.id, path, depth, kind: "area", value: null, ref: null, status: "unmatched", note: "No Site Codebook unit matches this name - add it under Intelligence › Setup, or mark it by hand." });
    } else if (meaning === "type") {
      rows.push({ folderId: f.id, path, depth, kind: "type", value: f.name.trim(), ref: null, status: "match" });
    } else {
      const e = equipmentFromFolderName(f.name);
      if (!e) { rows.push({ folderId: f.id, path, depth, kind: "equipment", value: null, ref: null, status: "unmatched", note: "No equipment tag in this name." }); continue; }
      const a = find.asset(e.tag);
      rows.push({ folderId: f.id, path, depth, kind: "equipment", value: e.name ? `${e.tag} · ${e.name}` : e.tag, ref: a?.id ?? null, status: a ? "match" : "new" });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}
