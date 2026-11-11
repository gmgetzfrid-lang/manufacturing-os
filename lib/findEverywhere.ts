// lib/find.ts - the one search behind Documents, the Document Control widget
// and the top search bar. Reads only.
//
//   equipment   tag, ID or description, each with its unit, ID, description
//               and the documents it is tagged on
//   documents   number, title, words, and the equipment tagged on them
//   folders     by name
//   inside      words inside indexed documents, with the passage and page
//               (the same search the Org graph's Ask runs)
//
// The map under the folders is the estate tree (unit > type > equipment >
// documents) built from the registry, with the picked equipment's documents.

import { supabase } from "@/lib/supabase";
import { folderUnitsFrom } from "@/lib/estate/settle";
import { searchDocuments } from "@/lib/search";
import { findEstate } from "@/lib/find/client";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { loadCodebook } from "@/lib/codebook";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";
import {
  equipScore, rankEquip, tagKey, unitOfChain, unitFromFolderName, equipLabel,
  type FindDoc, type FindEquip, type FindFolder, type FindUnit, type FindWorkOrder,
} from "@/lib/findCore";

export * from "@/lib/findCore";

const DOC_COLS = "id, library_id, document_number, title, name, rev, sheet_number, sheet_meta:metadata->>sheet, status, collection_id";
type DocRowLite = {
  id: string; library_id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null;
  sheet_number: string | number | null; sheet_meta?: string | null; metadata?: { sheet?: unknown } | null;
  status: string | null; collection_id: string | null;
};

const clean = (s: string) => s.replace(/[%_,()*\\"]/g, " ").trim();

// ── Units and types (cached per org) ─────────────────────────────────────
const unitCache = new Map<string, Promise<FindUnit[]>>();
export function findUnits(orgId: string): Promise<FindUnit[]> {
  let p = unitCache.get(orgId);
  if (!p) {
    p = loadCodebook(orgId).then((b) => b.units.map((u) => ({ code: u.code, label: u.label }))).catch(() => []);
    unitCache.set(orgId, p);
  }
  return p;
}
const typeCache = new Map<string, Promise<Map<string, string>>>();
function typeNames(orgId: string): Promise<Map<string, string>> {
  let p = typeCache.get(orgId);
  if (!p) {
    p = (async () => {
      const { data } = await supabase.from("asset_types").select("id, name").eq("org_id", orgId);
      return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]));
    })().catch(() => new Map<string, string>());
    typeCache.set(orgId, p);
  }
  return p;
}

function sheetOf(r: DocRowLite): string | null {
  const v = r.sheet_number ?? r.sheet_meta ?? (r.metadata?.sheet as string | number | null | undefined) ?? null;
  return v == null || v === "" ? null : String(v);
}

function toDoc(r: DocRowLite, folders: Map<string, string>): FindDoc {
  return {
    id: r.id, libraryId: r.library_id, number: r.document_number, title: r.title, name: r.name, rev: r.rev,
    sheet: sheetOf(r), status: r.status,
    folderId: r.collection_id, folderName: r.collection_id ? folders.get(r.collection_id) ?? null : null,
  };
}

async function folderNames(ids: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const want = [...new Set(ids)].slice(0, 200);
  if (!want.length) return m;
  const { data } = await supabase.from("collections").select("id, name").in("id", want);
  for (const f of (data ?? []) as Array<{ id: string; name: string }>) m.set(f.id, f.name);
  return m;
}

/** Documents each piece of equipment is tagged on: hand links and the
 *  equipment sweep's applied links. */
async function docLinks(orgId: string, assetIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!assetIds.length) return out;
  const add = (a: string, d: string) => { const s = out.get(a) ?? new Set<string>(); s.add(d); out.set(a, s); };
  const [hand, sweep] = await Promise.all([
    fetchAllRows<{ document_id: string; asset_id: string }>((from, to) => supabase.from("document_assets").select("document_id, asset_id")
      .in("asset_id", assetIds).order("document_id").order("asset_id").range(from, to), 20_000),
    fetchAllRows<{ a: string; b: string }>((from, to) => supabase.from("estate_edges").select("a, b").eq("org_id", orgId).eq("type", "tagged_to").eq("status", "applied")
      .in("b", assetIds.map((id) => `asset:${id}`)).order("id").range(from, to), 20_000),
  ]);
  for (const r of hand.rows) add(r.asset_id, r.document_id);
  for (const r of sweep.rows) if (r.a.startsWith("doc:")) add(r.b.slice(6), r.a.slice(4));
  return out;
}

export interface QuickFind {
  q: string;
  equipment: FindEquip[];
  docs: Record<string, FindDoc>;
  /** Documents found directly (number, title, words, tag), best first. */
  docOrder: string[];
  folders: FindFolder[];
}

/** Everything that answers the query, fast enough to run as you type. */
export async function findQuick(orgId: string, q: string, opts: { controller?: boolean } = {}): Promise<QuickFind> {
  const t = q.trim();
  const empty: QuickFind = { q: t, equipment: [], docs: {}, docOrder: [], folders: [] };
  if (t.length < 2) return empty;
  const safe = clean(t);
  const norm = t.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const key = tagKey(t);
  const words = safe.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);

  const ors = [
    norm.length >= 2 ? `tag_normalized.ilike.%${norm}%` : null,
    key && key !== norm ? `tag_normalized.ilike.%${key}%` : null,
    safe ? `code.ilike.${safe}%` : null,
    words[0] ? `description.ilike.%${words[0]}%` : null,
  ].filter(Boolean).join(",");

  const [units, types, assetsRes, docRows, folderRes] = await Promise.all([
    findUnits(orgId),
    typeNames(orgId),
    ors ? supabase.from("assets").select("id, tag, code, unit_code, description, type_id").eq("org_id", orgId).eq("archived", false).or(ors).limit(80)
      : Promise.resolve({ data: [] as unknown[] }),
    searchDocuments({ orgId, query: t, limit: 25 }).catch(() => []),
    safe.length >= 2
      ? supabase.from("collections").select("id, name, library_id, parent_id, deleted_at, visibility").eq("org_id", orgId).ilike("name", `%${safe}%`).limit(12)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const unitLabel = new Map(units.map((u) => [u.code, u.label]));
  const scored = ((assetsRes.data ?? []) as Array<{ id: string; tag: string; code: string | null; unit_code: string | null; description: string | null; type_id: string | null }>)
    .map((a): FindEquip => {
      const e: FindEquip = {
        id: a.id, tag: a.tag, code: a.code, unitCode: a.unit_code, unitLabel: a.unit_code ? unitLabel.get(a.unit_code) ?? null : null,
        description: a.description, typeName: a.type_id ? types.get(a.type_id) ?? null : null, docIds: [], score: 0,
      };
      e.score = equipScore(t, e);
      return e;
    })
    .filter((e) => e.score > 0);
  const equipment = rankEquip(scored).slice(0, 12);

  const links = await docLinks(orgId, equipment.map((e) => e.id));
  const directRows = (docRows as unknown as DocRowLite[]).filter((d) => d.status !== "Archived");
  const linkIds = [...new Set(equipment.flatMap((e) => [...(links.get(e.id) ?? [])]))].filter((id) => !directRows.some((d) => d.id === id));
  const { data: linkedRows } = linkIds.length
    ? await supabase.from("documents").select(DOC_COLS).in("id", linkIds.slice(0, 300)).neq("status", "Archived")
    : { data: [] as unknown[] };
  const allRows = [...directRows, ...((linkedRows ?? []) as DocRowLite[])];
  const fnames = await folderNames(allRows.map((r) => r.collection_id).filter((x): x is string => !!x));
  const docs: Record<string, FindDoc> = {};
  for (const r of allRows) docs[r.id] = toDoc(r, fnames);
  for (const e of equipment) e.docIds = [...(links.get(e.id) ?? [])].filter((id) => !!docs[id]);

  // Which of the found equipment each document carries: "Has E-22 (5530.29)".
  for (const e of equipment) for (const id of e.docIds) {
    const d = docs[id];
    d.tags = [...new Set([...(d.tags ?? []), equipLabel(e)])];
  }

  const folderRows = ((folderRes.data ?? []) as Array<{ id: string; name: string; library_id: string; parent_id: string | null; deleted_at: string | null; visibility: string | null }>)
    .filter((f) => !f.deleted_at && (opts.controller || (f.visibility ?? "normal") === "normal"));
  const parents = await folderNames(folderRows.map((f) => f.parent_id).filter((x): x is string => !!x));
  const folders: FindFolder[] = folderRows.slice(0, 8).map((f) => ({ id: f.id, libraryId: f.library_id, name: f.name, parentName: f.parent_id ? parents.get(f.parent_id) ?? null : null }));

  return { q: t, equipment, docs, docOrder: directRows.map((r) => r.id), folders };
}

export interface EquipDetail {
  /** Other equipment on each of its documents: docId -> labels. */
  onSheet: Record<string, string[]>;
  workOrders: FindWorkOrder[];
}

/** For the picked equipment: what else is on its documents, and the work
 *  orders for it. A work order counts when its Equipment field is this ID;
 *  by name only when no other equipment shares the tag. */
export async function equipDetail(orgId: string, e: FindEquip, tagIsUnique: boolean): Promise<EquipDetail> {
  const onSheet: Record<string, string[]> = {};
  if (e.docIds.length) {
    const ids = e.docIds.slice(0, 60);
    const [hand, sweep] = await Promise.all([
      fetchAllRows<{ document_id: string; asset_id: string }>((from, to) => supabase.from("document_assets").select("document_id, asset_id")
        .in("document_id", ids).order("document_id").order("asset_id").range(from, to), 20_000),
      fetchAllRows<{ a: string; b: string }>((from, to) => supabase.from("estate_edges").select("a, b").eq("org_id", orgId).eq("type", "tagged_to").eq("status", "applied")
        .in("a", ids.map((id) => `doc:${id}`)).order("id").range(from, to), 20_000),
    ]);
    const pairs: Array<[string, string]> = [];
    for (const r of hand.rows) pairs.push([r.document_id, r.asset_id]);
    for (const r of sweep.rows) if (r.b.startsWith("asset:")) pairs.push([r.a.slice(4), r.b.slice(6)]);
    const others = [...new Set(pairs.map((p) => p[1]).filter((a) => a !== e.id))].slice(0, 400);
    const { data: as } = others.length ? await supabase.from("assets").select("id, tag").in("id", others) : { data: [] as unknown[] };
    const tagOf = new Map(((as ?? []) as Array<{ id: string; tag: string }>).map((a) => [a.id, a.tag]));
    for (const [d, a] of pairs) {
      if (a === e.id || !tagOf.has(a)) continue;
      onSheet[d] = [...new Set([...(onSheet[d] ?? []), tagOf.get(a)!])];
    }
    for (const d of Object.keys(onSheet)) onSheet[d].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  }

  const rows: Array<{ id: string; name: string; project_id: string; parent_id: string | null; attributes: Record<string, unknown> | null }> = [];
  const sel = "id, name, project_id, parent_id, attributes";
  if (e.code) {
    const { data } = await supabase.from("milestones").select(sel).eq("org_id", orgId).eq("attributes->>Equipment", e.code).limit(40);
    rows.push(...((data ?? []) as typeof rows));
  }
  if (tagIsUnique) {
    const { data } = await supabase.from("milestones").select(sel).eq("org_id", orgId).ilike("name", `%${clean(e.tag)}%`).limit(40);
    for (const r of (data ?? []) as typeof rows) if (!rows.some((x) => x.id === r.id)) rows.push(r);
  }
  // A work order, not each of its steps: drop rows whose parent also matched.
  const ids = new Set(rows.map((r) => r.id));
  const heads = rows.filter((r) => !r.parent_id || !ids.has(r.parent_id)).slice(0, 8);
  let workOrders: FindWorkOrder[] = [];
  if (heads.length) {
    const [kids, projects] = await Promise.all([
      fetchAllRows<{ parent_id: string; status: string }>((from, to) => supabase.from("milestones").select("id, parent_id, status")
        .in("parent_id", heads.map((h) => h.id)).order("id").range(from, to), 20_000),
      supabase.from("projects").select("id, name").in("id", [...new Set(heads.map((h) => h.project_id))]),
    ]);
    const pname = new Map(((projects.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
    workOrders = heads.filter((h) => pname.has(h.project_id)).map((h) => {
      const k = kids.rows.filter((x) => x.parent_id === h.id);
      const wo = h.attributes?.["Work Order"] ?? h.attributes?.["WO"] ?? null;
      return {
        id: h.id, projectId: h.project_id, projectName: pname.get(h.project_id)!, name: h.name,
        wo: wo == null ? null : String(wo), done: k.filter((x) => x.status === "completed").length, total: k.length,
      };
    });
  }
  return { onSheet, workOrders };
}

/** The equipment tagged on each of these documents: hand links and the
 *  equipment sweep's applied links. For the map of a folder. */
export async function equipOnDocs(orgId: string, docIds: string[]): Promise<Map<string, Array<{ id: string; tag: string; sub: string | null }>>> {
  const out = new Map<string, Array<{ id: string; tag: string; sub: string | null }>>();
  const ids = [...new Set(docIds)];
  if (!ids.length) return out;
  const on = new Map<string, Set<string>>();
  const add = (d: string, a: string) => { const s = on.get(d) ?? new Set<string>(); s.add(a); on.set(d, s); };
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const [hand, sweep] = await Promise.all([
      fetchAllRows<{ document_id: string; asset_id: string }>((from, to) => supabase.from("document_assets").select("document_id, asset_id")
        .in("document_id", slice).order("document_id").order("asset_id").range(from, to), 20_000),
      fetchAllRows<{ a: string; b: string }>((from, to) => supabase.from("estate_edges").select("a, b").eq("org_id", orgId).eq("type", "tagged_to").eq("status", "applied")
        .in("a", slice.map((id) => `doc:${id}`)).order("id").range(from, to), 20_000),
    ]);
    for (const r of hand.rows) add(r.document_id, r.asset_id);
    for (const r of sweep.rows) if (r.b.startsWith("asset:")) add(r.a.slice(4), r.b.slice(6));
  }
  const assetIds = [...new Set([...on.values()].flatMap((s) => [...s]))];
  const assets = new Map<string, { id: string; tag: string; sub: string | null }>();
  for (let i = 0; i < assetIds.length; i += 200) {
    const { data } = await supabase.from("assets").select("id, tag, code, description").in("id", assetIds.slice(i, i + 200)).eq("archived", false);
    for (const a of (data ?? []) as Array<{ id: string; tag: string; code: string | null; description: string | null }>) {
      assets.set(a.id, { id: a.id, tag: a.tag, sub: [a.code, a.description].filter(Boolean).join(" · ") || null });
    }
  }
  for (const [d, set] of on) {
    const list = [...set].map((id) => assets.get(id)).filter((a): a is { id: string; tag: string; sub: string | null } => !!a);
    if (list.length) out.set(d, list);
  }
  return out;
}

/** Documents by id, with their folder names. */
export async function docsByIds(ids: string[]): Promise<FindDoc[]> {
  const want = [...new Set(ids)].slice(0, 100);
  if (!want.length) return [];
  const { data } = await supabase.from("documents").select(DOC_COLS).in("id", want).neq("status", "Archived");
  const rows = (data ?? []) as DocRowLite[];
  const fnames = await folderNames(rows.map((r) => r.collection_id).filter((x): x is string => !!x));
  return rows.map((r) => toDoc(r, fnames));
}

/** The documents one piece of equipment is tagged on (for the map). */
export async function equipDocs(orgId: string, assetId: string): Promise<FindDoc[]> {
  const links = await docLinks(orgId, [assetId]);
  return docsByIds([...(links.get(assetId) ?? [])]);
}

export interface DeepFind { order: string[]; docs: Record<string, FindDoc> }

/** The find service every search box shares: names and numbers, what the
 *  estate knows (tags filed, tags read off the sheets, sentences that
 *  mention equipment) and the words inside the pages. No AI is called. */
export async function findDeep(orgId: string, q: string): Promise<DeepFind> {
  const t = q.trim();
  if (t.length < 2) return { order: [], docs: {} };
  const res = await findEstate({ orgId, query: t, limit: 30, activity: false, semantic: false });
  const docs: Record<string, FindDoc> = {};
  const order: string[] = [];
  for (const r of res.results) {
    if (docs[r.documentId]) continue;
    order.push(r.documentId);
    const page = r.pages[0];
    docs[r.documentId] = {
      id: r.documentId, libraryId: r.libraryId, number: r.number, title: r.title, name: r.name, rev: r.rev,
      sheet: r.sheet != null ? String(r.sheet) : null, status: r.status, folderId: r.folderId,
      folderName: r.path.length ? r.path[r.path.length - 1] : null,
      rels: r.relations.filter((x) => x.rel === "tagged_to" || x.rel === "drawn_on" || x.rel === "mentioned_in")
        .map((x) => ({ rel: x.rel, node: x.node, label: x.label, page: x.page })),
      hit: page ? { page: page.page, text: page.snippet } : undefined,
    };
  }
  return { order, docs };
}

/** The unit of the folder you're in: a unit mark on it or above it, then
 *  its name ("55 - Transmix"). */
export async function folderUnit(orgId: string, chain: Array<{ id: string; name: string }>): Promise<string | null> {
  if (!chain.length) return null;
  const units = await findUnits(orgId);
  const marks = new Map<string, string>();
  try {
    const { data } = await supabase.from("estate_edges").select("a, b, type, origin").eq("org_id", orgId).eq("type", "belongs_to_unit").eq("status", "applied")
      .in("a", chain.map((f) => `folder:${f.id}`));
    // A person's link on a folder wins over one worked out from its name.
    for (const [fid, code] of folderUnitsFrom((data ?? []) as Array<{ a: string; b: string; type: string; origin: string | null }>).units) marks.set(fid, code);
  } catch { /* names still work */ }
  return unitOfChain(chain, marks, units);
}

export interface UnitFolder { libraryId: string; chain: Array<{ id: string; name: string; parent_id: string | null }> }

/** The folder a unit's documents live in, for "tap a unit on the map, open
 *  its folder": a folder marked with the unit, else one named for it
 *  ("55 - Transmix"). The library you're in wins, then the one with the most
 *  documents directly in it. Null when no folder belongs to the unit. */
export async function folderForUnit(orgId: string, unitCode: string, preferLibraryId?: string | null): Promise<UnitFolder | null> {
  const units = await findUnits(orgId);
  const { data: marks } = await supabase.from("estate_edges").select("a").eq("org_id", orgId).eq("type", "belongs_to_unit")
    .eq("status", "applied").eq("b", `cbunit:${unitCode}`).limit(200);
  let ids = ((marks ?? []) as Array<{ a: string }>).map((m) => m.a).filter((a) => a.startsWith("folder:")).map((a) => a.slice(7));
  type Col = { id: string; name: string; parent_id: string | null; library_id: string; deleted_at: string | null };
  let cands: Col[] = [];
  if (ids.length) {
    const { data } = await supabase.from("collections").select("id, name, parent_id, library_id, deleted_at").in("id", ids.slice(0, 200));
    cands = ((data ?? []) as Col[]).filter((c) => !c.deleted_at);
  }
  if (!cands.length) {
    const { data } = await supabase.from("collections").select("id, name, parent_id, library_id, deleted_at").eq("org_id", orgId).ilike("name", `${unitCode}%`).limit(50);
    cands = ((data ?? []) as Col[]).filter((c) => !c.deleted_at && unitFromFolderName(c.name, units) === unitCode);
  }
  if (!cands.length) return null;
  // A marked folder can sit inside another marked one: the outermost is the unit's home.
  ids = cands.map((c) => c.id);
  const outer = cands.filter((c) => !c.parent_id || !ids.includes(c.parent_id));
  const pool = outer.length ? outer : cands;
  const here = preferLibraryId ? pool.filter((c) => c.library_id === preferLibraryId) : [];
  let pick = here[0] ?? null;
  if (!pick) {
    const counts = await Promise.all(pool.slice(0, 12).map(async (c) => {
      const { count } = await supabase.from("documents").select("id", { count: "exact", head: true }).eq("collection_id", c.id).neq("status", "Archived");
      return [c, count ?? 0] as const;
    }));
    pick = counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? pool[0];
  }
  // Walk up to the library root for the crumbs.
  const chain: UnitFolder["chain"] = [{ id: pick.id, name: pick.name, parent_id: pick.parent_id }];
  let parent = pick.parent_id;
  for (let i = 0; parent && i < 12; i++) {
    const { data } = await supabase.from("collections").select("id, name, parent_id").eq("id", parent).maybeSingle();
    const row = data as { id: string; name: string; parent_id: string | null } | null;
    if (!row) break;
    chain.unshift(row);
    parent = row.parent_id;
  }
  return { libraryId: pick.library_id, chain };
}

// ── The map: unit > type > equipment > documents ─────────────────────────
export interface MapBase { nodes: GraphNode[]; edges: GraphEdge[] }
const mapCache = new Map<string, Promise<MapBase>>();

export function findMapBase(orgId: string): Promise<MapBase> {
  let p = mapCache.get(orgId);
  if (!p) {
    p = (async () => {
      const [units, types] = await Promise.all([findUnits(orgId), typeNames(orgId)]);
      const assets: Array<{ id: string; tag: string; code: string | null; description: string | null; unit_code: string | null; type_id: string | null }> = [];
      for (let from = 0; from < 6000; from += 1000) {
        const { data, error } = await supabase.from("assets").select("id, tag, code, description, unit_code, type_id")
          .eq("org_id", orgId).eq("archived", false).order("id").range(from, from + 999);
        if (error) break;
        assets.push(...((data ?? []) as typeof assets));
        if ((data ?? []).length < 1000) break;
      }
      const used = new Set(assets.map((a) => a.unit_code).filter(Boolean));
      const nodes: GraphNode[] = units.filter((u) => used.has(u.code)).map((u) => ({
        // "55 Transmix Unit", not "55 Transmix Unit (Old Solvent Unit)": it has to fit under a dot.
        id: `cbunit:${u.code}`, type: "unit", label: `${u.code} ${u.label.replace(/\s*\([^)]*\)\s*$/, "").trim() || u.label}`, sub: `Unit ${u.code}`, href: `/admin/assets?unit=${encodeURIComponent(u.code)}`, degree: 0,
      }));
      const edges: GraphEdge[] = [];
      for (const a of assets) {
        nodes.push({
          id: `asset:${a.id}`, type: "asset", label: a.tag, sub: [a.code, a.description].filter(Boolean).join(" · ") || undefined,
          // The registry's type, the same one the results beside the map show.
          category: a.type_id ? types.get(a.type_id) : undefined,
          href: `/admin/assets?tag=${encodeURIComponent(a.tag)}`, degree: 0,
        });
        if (a.unit_code && used.has(a.unit_code)) edges.push({ a: `asset:${a.id}`, b: `cbunit:${a.unit_code}`, type: "unit" });
      }
      return { nodes, edges };
    })().catch(() => ({ nodes: [], edges: [] }));
    mapCache.set(orgId, p);
  }
  return p;
}

/** The map with the picked equipment's documents hung under it. */
export function mapWithDocs(base: MapBase, assetId: string | null, docs: FindDoc[]): MapBase {
  if (!assetId || !docs.length) return base;
  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const count = new Map<string, number>();
  for (const d of docs) if (d.number) count.set(d.number, (count.get(d.number) ?? 0) + 1);
  for (const d of docs) {
    const dup = d.number ? (count.get(d.number) ?? 0) > 1 : false;
    const label = d.number ? (dup && d.sheet ? `${d.number} · Sh ${d.sheet}` : d.number) : (d.title || d.name || "Document");
    nodes.push({ id: `doc:${d.id}`, type: "document", label, sub: d.title ?? undefined, href: `/documents/${d.libraryId}?doc=${d.id}`, degree: 0 });
    edges.push({ a: `doc:${d.id}`, b: `asset:${assetId}`, type: "tag" });
  }
  return { nodes, edges };
}
