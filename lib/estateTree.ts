// lib/estateTree.ts — the estate as the tree people carry in their head.
//
//   Operating area (a codebook unit; a site's plants above them when the
//   org has them)
//     → equipment type ("Vessels / Drums", "Pumps", …)
//         → equipment (V-14)
//             → the drawings and documents about it
//     → documents tied to the area but to no equipment
//   Projects → their documents
//   Equipment with no operating area
//   Not placed yet → grouped by library
//
// A thing has ONE place. A document tied to several pieces of equipment
// sits under the first; its other ties are drawn only when it is picked.
// Small groups are not split further: an area with eight pieces of
// equipment shows them directly, not under eight type headings. Pure.

import { EQUIPMENT_CATEGORIES } from "@/lib/drawingText";

export interface TreeInNode { id: string; type: string; label: string; sub?: string; category?: string }
export interface TreeInEdge { a: string; b: string; type: string }
export interface TreeNode { id: string; label: string; parentId: string | null; kind: "group" | "area" | "category" | "asset" | "project" | "document" | "library"; graphId: string | null }

const SPLIT_AT = 9;

/** What the equipment IS, read from its service name ("CRUDE HEATER"),
 *  before falling back to the tag's letters. Order matters: "REBOILER" is
 *  an exchanger, "PREHEATER" too, a "BOILER FEED PUMP" a pump. */
const BY_NAME: Array<[RegExp, string]> = [
  [/\bPUMPS?\b/, "Pumps"],
  [/\b(COMPRESSORS?|BLOWERS?|FANS?)\b/, "Compressors / Blowers"],
  [/\b(EXCHANGERS?|COOLERS?|CONDENSERS?|REBOILERS?|CHILLERS?|PREHEATERS?|AIR FIN|FIN FAN)\b/, "Exchangers"],
  [/\b(HEATERS?|FURNACES?|FIRED)\b/, "Heaters / Furnaces"],
  [/\bBOILERS?\b/, "Boilers"],
  [/\b(TOWERS?|COLUMNS?|STRIPPERS?|FRACTIONATORS?|ABSORBERS?|SCRUBBERS?|SPLITTERS?)\b/, "Towers / Columns"],
  [/\bTANKS?\b/, "Tanks"],
  [/\b(DRUMS?|VESSELS?|ACCUMULATORS?|SEPARATORS?|KO POT|KNOCK.?OUT|DESALTERS?|SETTLERS?|RECEIVERS?)\b/, "Vessels / Drums"],
  [/\b(FILTERS?|STRAINERS?|COALESCERS?)\b/, "Filters / Strainers"],
  [/\bREACTORS?\b/, "Reactors"],
  [/\b(MIXERS?|AGITATORS?)\b/, "Mixers / Agitators"],
];
/** The tag's letters, where they say one thing. */
const BY_PREFIX: Record<string, string> = {
  H: "Heaters / Furnaces", V: "Vessels / Drums", D: "Vessels / Drums", E: "Exchangers", P: "Pumps",
  K: "Compressors / Blowers", TK: "Tanks", R: "Reactors",
};

export function categoryOf(tag: string, name?: string | null, setType?: string | null): string {
  if (setType?.trim()) return setType.trim();
  const n = (name ?? "").toUpperCase();
  for (const [re, c] of BY_NAME) if (re.test(n)) return c;
  const m = tag.toUpperCase().match(/^([A-Z]{1,4})-?\d/);
  if (!m) return "Other equipment";
  const p = m[1];
  for (let k = p.length; k >= 1; k--) { const c = BY_PREFIX[p.slice(0, k)] ?? EQUIPMENT_CATEGORIES[p.slice(0, k)]; if (c) return c; }
  return "Other equipment";
}

export function buildEstateTree(nodes: TreeInNode[], edges: TreeInEdge[]): TreeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: TreeNode[] = [];
  const placed = new Set<string>();
  const put = (n: TreeNode) => { out.push(n); if (n.graphId) placed.add(n.graphId); };

  // ── Operating areas: codebook units; a legacy unit with the same code or
  //    name is the same area. Plants above them when present.
  const areaOf = new Map<string, string>();               // any unit node id → area node id
  const cb = nodes.filter((n) => n.id.startsWith("cbunit:"));
  const legacy = nodes.filter((n) => n.type === "unit" && n.id.startsWith("unit:"));
  const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const c of cb) areaOf.set(c.id, c.id);
  for (const u of legacy) {
    const same = cb.find((c) => norm(c.id.slice(7)) === norm(u.sub) || norm(c.label) === norm(u.label));
    areaOf.set(u.id, same ? same.id : u.id);
  }
  const plantOf = new Map<string, string>();
  for (const e of edges) if (e.type === "unit" && e.a.startsWith("unit:") && e.b.startsWith("plant:")) plantOf.set(areaOf.get(e.a) ?? e.a, e.b);
  const plants = nodes.filter((n) => n.type === "plant" && [...plantOf.values()].includes(n.id));
  for (const p of plants) put({ id: p.id, label: p.label, parentId: null, kind: "group", graphId: p.id });
  const areas = [...new Set(areaOf.values())].map((id) => byId.get(id)).filter((n): n is TreeInNode => !!n);
  for (const a of areas) put({ id: a.id, label: a.label, parentId: plantOf.get(a.id) ?? null, kind: "area", graphId: a.id });

  // ── Equipment → its area.
  const assets = nodes.filter((n) => n.type === "asset");
  const assetArea = new Map<string, string>();
  for (const e of edges) if (e.type === "unit" && e.a.startsWith("asset:")) { const ar = areaOf.get(e.b); if (ar && !assetArea.has(e.a)) assetArea.set(e.a, ar); }

  // ── Documents → one place: equipment, then area, then project, then library.
  const docAsset = new Map<string, string>(), docArea = new Map<string, string>(), docProject = new Map<string, string>(), docLib = new Map<string, string>();
  for (const e of edges) {
    const [d, o] = byId.get(e.a)?.type === "document" ? [e.a, e.b] : byId.get(e.b)?.type === "document" ? [e.b, e.a] : [null, null];
    if (!d || !o) continue;
    const ot = byId.get(o)?.type;
    if ((e.type === "tag" || e.type === "mention") && ot === "asset" && !docAsset.has(d)) docAsset.set(d, o);
    else if (e.type === "unit" && areaOf.has(o) && !docArea.has(d)) docArea.set(d, areaOf.get(o)!);
    else if (e.type === "project" && ot === "project" && !docProject.has(d)) docProject.set(d, o);
    else if (e.type === "library" && ot === "library" && !docLib.has(d)) docLib.set(d, o);
  }
  const docsUnder = new Map<string, string[]>();
  const under = (parent: string, d: string) => docsUnder.set(parent, [...(docsUnder.get(parent) ?? []), d]);
  const docs = nodes.filter((n) => n.type === "document");
  const ORPHAN = "__unplaced__", LOOSE = "__loose_equipment__", PROJ = "__projects__";
  for (const d of docs) {
    const a = docAsset.get(d.id);
    if (a) { under(a, d.id); continue; }
    const ar = docArea.get(d.id);
    if (ar) { under(`areadocs:${ar}`, d.id); continue; }
    const p = docProject.get(d.id);
    if (p) { under(p, d.id); continue; }
    under(docLib.get(d.id) ? `orphan:${docLib.get(d.id)}` : ORPHAN, d.id);
  }

  // ── Inside each area: equipment by type (split only when large), then
  //    the area's own documents.
  const assetsBy = new Map<string, TreeInNode[]>();
  for (const a of assets) { const ar = assetArea.get(a.id) ?? LOOSE; assetsBy.set(ar, [...(assetsBy.get(ar) ?? []), a]); }
  const placeAssets = (parent: string, list: TreeInNode[]) => {
    if (list.length < SPLIT_AT) { for (const a of list) put({ id: a.id, label: a.label, parentId: parent, kind: "asset", graphId: a.id }); return; }
    const cats = new Map<string, TreeInNode[]>();
    for (const a of list) { const c = categoryOf(a.label, a.sub, a.category); cats.set(c, [...(cats.get(c) ?? []), a]); }
    for (const [c, l] of [...cats.entries()].sort((x, y) => y[1].length - x[1].length)) {
      const cid = `cat:${parent}:${c}`;
      put({ id: cid, label: `${c} (${l.length})`, parentId: parent, kind: "category", graphId: null });
      for (const a of l.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }))) put({ id: a.id, label: a.label, parentId: cid, kind: "asset", graphId: a.id });
    }
  };
  const placeDocs = (parent: string, list: string[], groupLabel: string | null) => {
    if (!list.length) return;
    let at = parent;
    if (groupLabel && list.length >= SPLIT_AT) { at = `docs:${parent}`; put({ id: at, label: `${groupLabel} (${list.length})`, parentId: parent, kind: "group", graphId: null }); }
    for (const d of list) { const n = byId.get(d)!; put({ id: d, label: n.label, parentId: at, kind: "document", graphId: d }); }
  };
  for (const a of areas) {
    placeAssets(a.id, assetsBy.get(a.id) ?? []);
    placeDocs(a.id, docsUnder.get(`areadocs:${a.id}`) ?? [], "Documents");
  }
  if ((assetsBy.get(LOOSE) ?? []).length) {
    put({ id: LOOSE, label: `Equipment with no operating area (${assetsBy.get(LOOSE)!.length})`, parentId: null, kind: "group", graphId: null });
    placeAssets(LOOSE, assetsBy.get(LOOSE)!);
  }
  for (const a of assets) placeDocs(a.id, docsUnder.get(a.id) ?? [], null);

  // ── Projects.
  const projects = nodes.filter((n) => n.type === "project");
  if (projects.length) {
    put({ id: PROJ, label: `Projects (${projects.length})`, parentId: null, kind: "group", graphId: null });
    for (const p of projects) { put({ id: p.id, label: p.label, parentId: PROJ, kind: "project", graphId: p.id }); placeDocs(p.id, docsUnder.get(p.id) ?? [], null); }
  }

  // ── Not placed yet, by library.
  const orphanLibs = [...docsUnder.keys()].filter((k) => k.startsWith("orphan:"));
  const looseDocs = docsUnder.get(ORPHAN) ?? [];
  const orphanTotal = orphanLibs.reduce((s, k) => s + (docsUnder.get(k)?.length ?? 0), 0) + looseDocs.length;
  if (orphanTotal) {
    put({ id: ORPHAN, label: `Not placed yet (${orphanTotal})`, parentId: null, kind: "group", graphId: null });
    for (const k of orphanLibs) {
      const lib = byId.get(k.slice(7));
      const gid = `orphanlib:${k.slice(7).replace(/^lib:/, "")}`;
      put({ id: gid, label: lib?.label ?? "Library", parentId: ORPHAN, kind: "library", graphId: null });
      placeDocs(gid, docsUnder.get(k) ?? [], null);
    }
    for (const d of looseDocs) put({ id: d, label: byId.get(d)!.label, parentId: ORPHAN, kind: "document", graphId: d });
  }
  return out;
}
