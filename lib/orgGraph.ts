// lib/orgGraph.ts — the whole org as one graph.
//
// Assembles every entity the system knows into nodes and every persisted
// relationship into edges, for the Obsidian-style org graph page. Nothing
// here is inferred at render time — each edge is a row somewhere:
//
//   document ↔ asset      document_assets (drawing tag extraction + manual)
//   asset    → unit       assets.unit_code (Site Codebook filing) / assets.unit_id
//   document → unit       documents.unit_code (the drawing-number decode,
//                         written by the unit-identity backfill — 20261138)
//                         / documents.unit_id (operational scope)
//   asset, document → plant, system   *.plant_id / *.system_id
//   system   → unit       systems.unit_id
//   unit     → plant      units.plant_id
//   unit     → library    the codebook unit's meta.links (a library or folder
//                         PINNED to it) and meta.knowledgeLibraryId (the AI
//                         knowledge library BOUND to it)
//   document → library    documents.library_id (toggled off by default)
//   project  ↔ document   project_documents (checkout + manual)
//   document ↔ document   document_related_resources (curated pins)
//   document → document   document_supersessions (lineage — directional)
//   document ↔ asset      entity_mentions (the text names it — with the quote)
//   asset/unit → asset/unit  process_flows (confirmed; directional — FEEDS)
//   plot plan → asset     plot_plans.markers
//
// ONE NODE PER REAL UNIT (GAP-305). A Site Codebook unit is `cbunit:<code>`.
// An operational `units` row MAPPED to it (units.codebook_code — the mapping
// is data, set on /admin/scope) is the same unit: its unit_id edges, its
// plant edge and its systems land on `cbunit:<code>`. A units row with no
// mapping is its own `unit:<uuid>` node — a configured unit the codebook does
// not hold. Systems are folded into the "unit" node class (`system:<uuid>`)
// and a bound knowledge library into the "library" class (`klib:<uuid>`):
// no node type beyond those (decision — DEC-67, provisional number).
//
// HONEST ASSEMBLY (GM-3 / GM-4 / GM-13 / GPV-6). Reads are org-scoped and
// RLS-enforced (client supabase). Every list is ORDERED, so "the first N" is
// a rule and not the planner's whim; every cap is reported with what it
// holds; a read that fails for any reason but a pre-migration missing table
// says so; and a link whose other end is not on the map (beyond a cap,
// archived, or outside the reader's access) is COUNTED — addEdge still never
// draws a dangling edge, but the loss is no longer silent.
// No request asks for more than EDGE_PAGE (1,000) rows: PostgREST cuts every
// response at db-max-rows (1,000 by default) WITHOUT an error (AREA-9), so a
// single `.limit(1501)` could never see past row 1,000 and its cap could
// never be reported. Documents and equipment are read in windows over their
// own order until cap + 1 rows are in hand; the site structure (codebook
// units, operational units, plants, systems) and the link tables page in
// keyset windows to completion or their cap, which is then said with a count.
//
// SCOPE (GAP-306). buildOrgGraph(orgId, { scope }) assembles ONE unit's world
// from the id set lib/scope.ts resolves, so the caps apply to the unit, not to
// an org-wide slice filtered afterwards, and every link that leaves the unit
// is counted on the node it leaves from ("N more this way").

import { supabase } from "@/lib/supabase";
import type { CodebookEntry } from "@/lib/codebook";
import type { ResolvedScope, ScopeRef } from "@/lib/scope";

export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot";

export type GraphEdgeType =
  | "tag"          // document ↔ asset
  | "unit"         // asset/document → unit/system/plant, system → unit, unit → plant
  | "library"      // document → library; unit → pinned library / bound knowledge library
  | "project"      // project ↔ document
  | "related"      // curated pin
  | "supersession" // superseded → replacement (directional)
  | "proposed"     // discovered, awaiting review — drawn as a ghost
  | "mention"      // the document's text names the equipment, quote attached
  | "flow"         // process flow: from FEEDS to (directional)
  | "plot";        // the asset is MARKED on this plot plan — spatial truth

/** Edge types whose meaning has a direction (a → b). Their dedup key keeps
 *  the order, so A→B and B→A are two edges — a two-node recycle loop keeps
 *  both legs (FLOW-8 / GM-8). Every other type is deduped as an unordered pair. */
export const DIRECTED_EDGE_TYPES: ReadonlySet<GraphEdgeType> = new Set<GraphEdgeType>(["flow", "supersession"]);

export interface GraphNode {
  id: string;            // namespaced: "doc:<id>", "asset:<id>", "cbunit:<code>", "system:<id>", "klib:<id>", …
  type: GraphNodeType;
  label: string;
  sub?: string;          // secondary line for the info card
  href: string;          // where clicking through lands
  degree: number;        // filled during assembly
  /** GPV-2 — structural scoping keys, copied from the rows already read
   *  (never inferred). unitCode: the Site Codebook unit (an asset's filing,
   *  a document's decode — else the code its mapped operational unit
   *  carries — or a unit node's own code); unitId: the operational units row;
   *  plantId / systemId: the scope FKs; libraryId: the library a document
   *  (or asset) is filed in; typeId: an asset's equipment type; sheetNumber:
   *  a document's sheet. */
  unitCode?: string | null;
  unitId?: string | null;
  plantId?: string | null;
  systemId?: string | null;
  libraryId?: string | null;
  typeId?: string | null;
  sheetNumber?: number | null;
  /** GAP-306 — in a scoped graph only: how many links from this node lead
   *  outside the scope ("3 more this way"). */
  outside?: number;
}

export interface GraphEdge {
  a: string;             // node id (the source, for a directional type)
  b: string;             // node id (the target, for a directional type)
  type: GraphEdgeType;
  /** GPV-14 — a unit → library edge says which statement it is: a library
   *  (or folder) PINNED to the unit, or the AI knowledge library BOUND to it.
   *  Absent on a document's filing edge. */
  via?: "pinned" | "knowledge";
  /** Human-readable qualifier — the pinned link's label and folder. */
  note?: string;
  /** GPV-14 — a pin of FOLDERS of the library, not the whole of it: the
   *  pinned folders' ids (each with its subtree, as lib/scope.ts resolves
   *  it). One edge per unit and library carries every folder pinned; absent
   *  when the whole library is pinned (a whole-library pin covers its
   *  folders) and on every other edge. Data, so a consumer never parses
   *  `note` to learn the folder. */
  folderIds?: string[];
}

/** IRLS-14 (the lib/orgGraph.ts half): what the mention read found. It tells
 *  "not installed" (installed: false — entity_mentions does not exist) from
 *  "installed, no rows visible to this reader" (installed: true, rows: 0),
 *  and says how many rows were read and drawn. It does NOT tell "never
 *  built" from "built, nothing named" from "built, but every row out of
 *  view": with installed: true and rows: 0 those three look the same here.
 *  Nor does it carry a failed build: the indexer (lib/mentionIndexer.ts)
 *  keeps no run state — a failure is logged and thrown to its caller — so
 *  "see the failure" needs an index-run state this assembly has nowhere to
 *  read (IRLS-14's remainder, I-14's). */
export interface MentionCoverage {
  /** false: entity_mentions does not exist (the mention migration is not applied). */
  installed: boolean;
  /** mention rows read (each a page of a document naming one asset). */
  rows: number;
  /** distinct document ↔ asset mention edges drawn. */
  drawn: number;
  /** rows from library-only knowledge documents (no controlled counterpart). */
  unmapped: number;
  /** the read stopped at the edge cap. */
  capped: boolean;
}

/** GM-6 — the document side of the map is the reader's own (documents RLS);
 *  the equipment side is org-wide. null = not known (pre-migration, or the
 *  count could not be read). */
export interface GraphAccess {
  /** Documents the reader can see: org-wide, the org's documents under the
   *  reader's RLS (a head count); scoped, the scope's documents the reader's
   *  reads returned. */
  documentsVisible: number | null;
  /** Org-wide only: the org's document count (documents_total_for_org).
   *  null on a SCOPED graph — the scope is resolved from the reader's own
   *  reads, so a restricted document decoded, filed or pinned to the unit
   *  never enters it and nothing can count what the reader cannot see. */
  documentsTotal: number | null;
  /** Org-wide only: documentsTotal − documentsVisible. null when scoped. */
  outsideAccess: number | null;
  /** Documents on this map, after the cap (≤ documentsVisible). */
  documentsDrawn?: number | null;
  /** Set on a scoped graph. */
  scoped?: boolean;
}

export interface OrgGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Human-readable notes about anything capped, unreadable or left out. */
  truncations: string[];
  // The fields below are always set by buildOrgGraph; they are optional only
  // because the page paints a cached snapshot from before they existed.
  mentionCoverage?: MentionCoverage;
  access?: GraphAccess;
  /** GM-3 — link rows read whose other end is not on this map. */
  severed?: number;
  /** GAP-306 — set on a scoped graph. */
  scope?: { ref: ScopeRef; label: string; boundary: number; complete: boolean } | null;
}

const DOC_CAP = 1500;
const ASSET_CAP = 2000;
const LIST_CAP = 300;
const EDGE_PAGE = 1000;
const EDGE_CAP = 8000;
const IN_CHUNK = 150;
const IN_WAVE = 6;
/** Codebook units, operational units, plants and systems: each paged to
 *  completion up to this many rows (a site holds tens to hundreds). */
const STRUCT_CAP = 5000;

export const GRAPH_CAPS = { DOC_CAP, ASSET_CAP, LIST_CAP, EDGE_PAGE, EDGE_CAP, STRUCT_CAP } as const;

/** documents.unit_code is added by 20261138 (GAP-305). It is typed here, not
 *  in types/schema.ts (owned by the document-control packages). */
export interface DocumentRow {
  id: string; document_number: string | null; title: string | null;
  library_id: string; unit_id: string | null; unit_code?: string | null;
  plant_id?: string | null; system_id?: string | null;
  sheet_number: number | null; sheet_total: number | null;
  updated_at?: string | null;
}
export interface AssetRowLite {
  id: string; tag: string; description: string | null;
  unit_code: string | null; unit_id: string | null;
  plant_id?: string | null; system_id?: string | null;
  type_id?: string | null; library_id?: string | null;
}
/** units.codebook_code is added by 20261138 (the codebook ↔ units mapping). */
export interface UnitRowLite { id: string; name: string; code: string | null; plant_id: string; codebook_code?: string | null }
export interface SystemRowLite { id: string; name: string; code: string | null; unit_id: string; plant_id: string }
export interface CodebookUnitLite { code: string; label: string; meta: CodebookEntry["meta"] | null }

export interface GraphRows {
  codebookUnits: CodebookUnitLite[];
  units: UnitRowLite[];
  plants: Array<{ id: string; name: string; code: string | null }>;
  systems: SystemRowLite[];
  libraries: Array<{ id: string; name: string }>;
  knowledgeLibraries: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; status: string | null }>;
  plotPlans: Array<{ id: string; name: string; markers: unknown }>;
  documents: DocumentRow[];
  assets: AssetRowLite[];
  docAssets: Array<{ document_id: string; asset_id: string }>;
  projectDocs: Array<{ project_id: string; document_id: string }>;
  related: Array<{ document_id: string; target_document_id: string | null; kind: string }>;
  supersessions: Array<{ superseded_doc_id: string; replacement_doc_id: string }>;
  mentions: Array<{ asset_id: string; document_id: string | null; knowledge_document_id: string | null }>;
  /** knowledge document id → the controlled document it mirrors (null: a
   *  library-only upload). A missing key means it could not be resolved. */
  mirrorOf: Map<string, string | null>;
  flows: Array<{ from_kind: string; from_ref: string; to_kind: string; to_ref: string; status: string }>;
}

export const emptyGraphRows = (): GraphRows => ({
  codebookUnits: [], units: [], plants: [], systems: [], libraries: [], knowledgeLibraries: [],
  projects: [], plotPlans: [], documents: [], assets: [], docAssets: [], projectDocs: [],
  related: [], supersessions: [], mentions: [], mirrorOf: new Map(), flows: [],
});

// ─── Reads ──────────────────────────────────────────────────────────────────

export type PgErr = { code?: string; message: string };

/** A pre-migration org simply has no such table: it contributes nothing. */
export const isMissingRelation = (e: PgErr | null | undefined): boolean =>
  !!e && (e.code === "42P01" || e.code === "PGRST205"
    || /relation "?[\w.]+"? does not exist/i.test(e.message ?? "")
    || /could not find the table/i.test(e.message ?? ""));

/** A pre-migration database lacks a column a newer select names. */
export const isMissingColumn = (e: PgErr | null | undefined): boolean =>
  !!e && (e.code === "42703" || e.code === "PGRST204" || /column [\w."]+ does not exist/i.test(e.message ?? ""));

/** The subset of the PostgREST builder the paged reads use. */
export interface Filterable extends PromiseLike<{ data: unknown; error: PgErr | null; count?: number | null }> {
  eq(col: string, v: unknown): Filterable;
  in(col: string, v: readonly unknown[]): Filterable;
  gt(col: string, v: unknown): Filterable;
  gte(col: string, v: unknown): Filterable;
  not(col: string, op: string, v: unknown): Filterable;
  contains(col: string, v: readonly unknown[]): Filterable;
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }): Filterable;
  limit(n: number): Filterable;
  range(from: number, to: number): Filterable;
}

export interface PagedRows<T> {
  rows: T[];
  /** more rows exist than were read. */
  capped: boolean;
  /** the table does not exist (pre-migration). */
  missing: boolean;
  /** how many rows match (null: not counted). */
  total: number | null;
  /** any other read error — the caller decides whether it is fatal. */
  error: PgErr | null;
}

/** Page a table to completion or `cap` in KEYSET order (id ascending), so the
 *  windows never overlap or skip and "the first N" is a stable set (GM-3).
 *  When the cap is reached, one head count says how many there are. */
export async function pageRows<T extends { id: string }>(
  table: string, select: string, orgId: string, cap: number,
  narrow?: (q: Filterable) => Filterable,
): Promise<PagedRows<T>> {
  const rows: T[] = [];
  let last: string | null = null;
  const base = (sel: string, opts?: { count: "exact"; head: true }) => {
    let q = (supabase.from(table).select(sel, opts) as unknown as Filterable).eq("org_id", orgId);
    if (narrow) q = narrow(q);
    return q;
  };
  while (rows.length < cap) {
    const want = Math.min(EDGE_PAGE, cap - rows.length);
    let q = base(select);
    if (last !== null) q = q.gt("id", last);
    const { data, error } = await q.order("id", { ascending: true }).limit(want);
    if (error) {
      if (isMissingRelation(error)) return { rows, capped: false, missing: true, total: null, error: null };
      return { rows, capped: false, missing: false, total: null, error };
    }
    const batch = (data as T[] | null) ?? [];
    rows.push(...batch);
    if (batch.length < want) return { rows, capped: false, missing: false, total: rows.length, error: null };
    last = String(batch[batch.length - 1].id);
  }
  const { count, error } = await base("id", { count: "exact", head: true });
  if (error) return { rows, capped: true, missing: false, total: null, error: null };
  const total = count ?? null;
  return { rows, capped: total === null || total > rows.length, missing: false, total, error: null };
}

/** pageRows over `column IN values`, chunked (IN_CHUNK ids per request, up
 *  to IN_WAVE requests in flight); rows de-duplicated by id, ordered by id. */
export async function pageIn<T extends { id: string }>(
  table: string, select: string, orgId: string, column: string,
  values: readonly string[], cap: number,
): Promise<PagedRows<T>> {
  const seen = new Map<string, T>();
  const uniq = [...new Set(values.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += IN_CHUNK) chunks.push(uniq.slice(i, i + IN_CHUNK));
  const done = (extra: Partial<PagedRows<T>>): PagedRows<T> => {
    const rows = [...seen.values()].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const capped = extra.capped ?? false;
    return { rows: capped ? rows.slice(0, cap) : rows, capped, missing: false, total: capped ? null : rows.length, error: null, ...extra };
  };
  for (let w = 0; w < chunks.length; w += IN_WAVE) {
    const room = cap - seen.size;
    if (room <= 0) return done({ capped: true });
    const wave = await Promise.all(chunks.slice(w, w + IN_WAVE).map((chunk) =>
      pageRows<T>(table, select, orgId, room, (q) => q.in(column, chunk))));
    for (const r of wave) {
      if (r.missing) return { rows: [...seen.values()], capped: false, missing: true, total: null, error: null };
      for (const row of r.rows) seen.set(String(row.id), row);
    }
    const failed = wave.find((r) => r.error);
    if (failed) return done({ error: failed.error });
    if (wave.some((r) => r.capped) || seen.size > cap) return done({ capped: true });
  }
  return done({});
}

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** A capped link table, said with what was read and what exists. */
function cappedNote(what: string, r: PagedRows<unknown>): string | null {
  if (!r.capped) return null;
  return r.total !== null
    ? `${what} capped — ${fmt(r.rows.length)} of ${fmt(r.total)} read; the rest are not drawn.`
    : `${what} capped at ${fmt(r.rows.length)}; the rest are not drawn.`;
}

/** A required link table: a real read error is fatal (GM-4 keeps this
 *  shape — the map would otherwise lie by omission). */
function mustRead<T>(table: string, r: PagedRows<T>): PagedRows<T> {
  if (r.error) throw new Error(`${table}: ${r.error.message}`);
  return r;
}

const UNIT_IDENTITY_NOTE =
  "The unit-identity migration (20261138) is not applied — decoded document units and the Site Codebook ↔ operational-unit mapping are not on this map.";

const DOC_COLS = "id, document_number, title, library_id, unit_id, unit_code, plant_id, system_id, sheet_number, sheet_total, updated_at";
const DOC_COLS_LEGACY = "id, document_number, title, library_id, unit_id, plant_id, system_id, sheet_number, sheet_total, updated_at";
const ASSET_COLS = "id, tag, description, unit_code, unit_id, plant_id, system_id, type_id, library_id";
const UNIT_COLS = "id, name, code, plant_id, codebook_code";
const UNIT_COLS_LEGACY = "id, name, code, plant_id";

type Res = { data: unknown; error: PgErr | null; count?: number | null };

/** GM-4: an optional feature table that FAILED (not a pre-migration missing
 *  table) is a visible note, never a silently smaller graph. */
function optionalRows<T>(res: Res, what: string, notes: string[]): T[] {
  if (!res.error) return ((res.data as T[] | null) ?? []);
  if (isMissingRelation(res.error)) return [];
  notes.push(`${what} could not be loaded (${res.error.message}) — the map is incomplete.`);
  return [];
}

/** Ordered read of up to `cap + 1` rows: the extra row says honestly whether
 *  the cap was reached (GPV-6 — no "the first N" without an ORDER BY). A list
 *  capped above EDGE_PAGE must be read in windows (readByRecency /
 *  readByTag) — one request never returns more than max-rows. */
function capList<T>(rows: T[], cap: number, note: string, notes: string[]): T[] {
  if (rows.length <= cap) return rows;
  notes.push(note);
  return rows.slice(0, cap);
}

type Windowed<T> = { rows: T[]; error: PgErr | null };

/** Up to `want` rows of one fixed ORDER BY, in `.range()` windows of at most
 *  EDGE_PAGE rows, until `want` are in hand or a short window ends the list.
 *  Rows are kept once by id: a row whose sort key changes between two
 *  windows shifts the order by one, and the repeat is dropped. */
async function readByRange<T extends { id: string }>(
  page: (from: number, to: number) => PromiseLike<Res>, want: number,
): Promise<Windowed<T>> {
  const seen = new Map<string, T>();
  let from = 0;
  while (seen.size < want) {
    const size = Math.min(EDGE_PAGE, want - seen.size);
    const { data, error } = await page(from, from + size - 1);
    if (error) return { rows: [...seen.values()], error };
    const batch = (data as T[] | null) ?? [];
    for (const r of batch) if (!seen.has(String(r.id))) seen.set(String(r.id), r);
    if (batch.length < size) break;
    from += batch.length;
  }
  return { rows: [...seen.values()], error: null };
}

/** The org's documents, most recently updated first (`updated_at` desc nulls
 *  last, then `id`), up to `want` — windowed, so DOC_CAP + 1 can be reached. */
async function readDocumentsByRecency(orgId: string, want: number): Promise<Windowed<DocumentRow> & { degraded: boolean }> {
  const page = (cols: string) => (from: number, to: number) =>
    supabase.from("documents").select(cols).eq("org_id", orgId)
      .order("updated_at", { ascending: false, nullsFirst: false }).order("id").range(from, to) as unknown as PromiseLike<Res>;
  const r = await readByRange<DocumentRow>(page(DOC_COLS), want);
  if (r.error && isMissingColumn(r.error)) return { ...(await readByRange<DocumentRow>(page(DOC_COLS_LEGACY), want)), degraded: true };
  return { ...r, degraded: false };
}

/** The org's non-archived equipment in (`tag`, `id`) order, up to `want`, in
 *  KEYSET windows of at most EDGE_PAGE rows: each window starts at the last
 *  tag read (`tag >= last`) and drops the rows already in hand, so a tag
 *  shared by several rows (the org-unique key is tag_normalized) is never
 *  skipped at a window's edge. */
async function readAssetsByTag(orgId: string, want: number): Promise<Windowed<AssetRowLite>> {
  const seen = new Map<string, AssetRowLite>();
  let lastTag: string | null = null;
  while (seen.size < want) {
    // The rows of the last tag come back again; ask for room beyond them.
    const again = lastTag === null ? 0 : [...seen.values()].filter((a) => a.tag === lastTag).length;
    const size = Math.min(EDGE_PAGE, want - seen.size + again);
    let q = (supabase.from("assets").select(ASSET_COLS) as unknown as Filterable).eq("org_id", orgId).eq("archived", false);
    if (lastTag !== null) q = q.gte("tag", lastTag);
    const { data, error } = await q.order("tag").order("id").limit(size);
    if (error) return { rows: [...seen.values()], error };
    const batch = (data as AssetRowLite[] | null) ?? [];
    let fresh = 0;
    for (const a of batch) if (!seen.has(String(a.id))) { seen.set(String(a.id), a); fresh += 1; }
    if (batch.length < size) break;
    if (fresh === 0) {
      return { rows: [...seen.values()], error: { message: `more than ${fmt(EDGE_PAGE)} equipment items share the tag "${lastTag}"` } };
    }
    lastTag = batch[batch.length - 1].tag;
  }
  return { rows: [...seen.values()].slice(0, want), error: null };
}

/** The site structure both assemblies draw from: Site Codebook units,
 *  operational units, plants, systems (non-archived). Each is paged in keyset
 *  windows (pageRows) to completion or STRUCT_CAP — a site with more than
 *  1,000 systems is no longer cut silently at max-rows — then put back in its
 *  display order; a failed read or a cap is a note (GM-4 / GM-13). */
async function readStructure(orgId: string, notes: string[]): Promise<{
  codebookUnits: CodebookUnitLite[]; units: UnitRowLite[];
  plants: GraphRows["plants"]; systems: SystemRowLite[]; degraded: boolean;
}> {
  const live = (q: Filterable) => q.eq("archived", false);
  type CbRow = CodebookUnitLite & { id: string; sort: number | null };
  const [cbR, unitsFirst, plantsR, systemsR] = await Promise.all([
    pageRows<CbRow>("codebook_entries", "id, code, label, meta, sort", orgId, STRUCT_CAP, (q) => q.eq("kind", "unit")),
    pageRows<UnitRowLite>("units", UNIT_COLS, orgId, STRUCT_CAP, live),
    pageRows<GraphRows["plants"][number]>("plants", "id, name, code", orgId, STRUCT_CAP, live),
    pageRows<SystemRowLite>("systems", "id, name, code, unit_id, plant_id", orgId, STRUCT_CAP, live),
  ]);
  let unitsR = unitsFirst;
  const degraded = !!unitsR.error && isMissingColumn(unitsR.error);
  if (degraded) unitsR = await pageRows<UnitRowLite>("units", UNIT_COLS_LEGACY, orgId, STRUCT_CAP, live);
  const take = <T,>(r: PagedRows<T>, what: string, order: (a: T, b: T) => number): T[] => {
    if (r.error) {
      notes.push(`${what} could not be loaded (${r.error.message}) — the map is incomplete.`);
      return [];
    }
    const n = cappedNote(what, r);
    if (n) notes.push(n);
    return [...r.rows].sort(order);
  };
  const text = (x: string | null | undefined, y: string | null | undefined) => {
    const a = x ?? "", b = y ?? "";
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const byName = <T extends { name: string; id: string }>(a: T, b: T) => text(a.name, b.name) || text(a.id, b.id);
  return {
    codebookUnits: take(cbR, "Site Codebook units", (a, b) => ((a.sort ?? 0) - (b.sort ?? 0)) || text(a.code, b.code))
      .map(({ code, label, meta }) => ({ code, label, meta })),
    units: take(unitsR, "Operational units", byName),
    plants: take(plantsR, "Plants", byName),
    systems: take(systemsR, "Systems", byName),
    degraded,
  };
}

/** Resolve the knowledge documents a set of mentions points through. */
async function resolveMirrors(
  orgId: string, kdocIds: readonly string[], notes: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (kdocIds.length === 0) return out;
  const r = await pageIn<{ id: string; source_document_id: string | null }>(
    "knowledge_documents", "id, source_document_id", orgId, "id", kdocIds, kdocIds.length + 1);
  if (r.error) {
    notes.push(`The indexed copies behind ${plural(kdocIds.length, "mention source")} could not be loaded (${r.error.message}) — their mention links are not drawn.`);
    return out;
  }
  for (const k of r.rows) out.set(String(k.id), k.source_document_id ?? null);
  return out;
}

/** GM-6 — how many of the org's documents the reader can see. */
async function readAccess(orgId: string): Promise<GraphAccess> {
  const [visibleRes, totalRes] = await Promise.all([
    supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId) as unknown as PromiseLike<Res>,
    supabase.rpc("documents_total_for_org", { p_org_id: orgId }) as unknown as PromiseLike<Res>,
  ]);
  const documentsVisible = visibleRes.error ? null : (visibleRes.count ?? null);
  const raw = totalRes.error ? null : totalRes.data;
  const documentsTotal = raw === null || raw === undefined || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const outsideAccess = documentsVisible !== null && documentsTotal !== null
    ? Math.max(0, documentsTotal - documentsVisible) : null;
  return { documentsVisible, documentsTotal, outsideAccess };
}

function accessNote(access: GraphAccess): string | null {
  if (!access.outsideAccess) return null;
  return `${plural(access.outsideAccess, "document")} in this org ${access.outsideAccess === 1 ? "is" : "are"} outside your access and not on this map — orphans, hubs and bridges are computed on what you can see.`;
}

async function readOrgRows(orgId: string, notes: string[]): Promise<{ rows: GraphRows; mentions: { installed: boolean; capped: boolean } }> {
  const [
    structure, libsRes, projectsRes, docsR, assetsR, plotRes,
    docAssets, projectDocs, related, supersessions, mentions, flows,
  ] = await Promise.all([
    readStructure(orgId, notes),
    supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name").order("id").limit(LIST_CAP + 1) as unknown as PromiseLike<Res>,
    supabase.from("projects").select("id, name, status").eq("org_id", orgId).order("name").order("id").limit(LIST_CAP + 1) as unknown as PromiseLike<Res>,
    // Windowed (max-rows): DOC_CAP + 1 and ASSET_CAP + 1 rows can arrive,
    // so the cap notes below fire exactly when a cap is exceeded.
    readDocumentsByRecency(orgId, DOC_CAP + 1),
    readAssetsByTag(orgId, ASSET_CAP + 1),
    // Plot plans: spatial maps whose markers pin assets to a place. Each
    // plan is a node; each marker is an edge to the asset it pins.
    supabase.from("plot_plans").select("id, name, markers").eq("org_id", orgId).order("name").order("id").limit(LIST_CAP + 1) as unknown as PromiseLike<Res>,
    pageRows<{ id: string; document_id: string; asset_id: string }>(
      "document_assets", "id, document_id, asset_id", orgId, EDGE_CAP),
    pageRows<{ id: string; project_id: string; document_id: string }>(
      "project_documents", "id, project_id, document_id", orgId, EDGE_CAP),
    pageRows<{ id: string; document_id: string; target_document_id: string | null; kind: string }>(
      "document_related_resources", "id, document_id, target_document_id, kind", orgId, EDGE_CAP),
    pageRows<{ id: string; superseded_doc_id: string; replacement_doc_id: string }>(
      "document_supersessions", "id, superseded_doc_id, replacement_doc_id", orgId, EDGE_CAP),
    // The mention engine. A pre-migration org contributes nothing (pageRows
    // tolerates a missing table), which is exactly the right degradation:
    // fewer edges, never a broken page.
    pageRows<{ id: string; asset_id: string; document_id: string | null; knowledge_document_id: string | null }>(
      "entity_mentions", "id, asset_id, document_id, knowledge_document_id", orgId, EDGE_CAP),
    // Process flows — the plant's topology (confirmed ones are drawn; the
    // proposed ones are counted). A pre-migration org contributes nothing.
    pageRows<{ id: string; from_kind: string; from_ref: string; to_kind: string; to_ref: string; status: string }>(
      "process_flows", "id, from_kind, from_ref, to_kind, to_ref, status", orgId, EDGE_CAP),
  ]);

  // Documents and libraries are the core — a real error there is fatal.
  if (docsR.error) throw new Error(docsR.error.message);
  if (libsRes.error) throw new Error(libsRes.error.message);
  if (docsR.degraded || structure.degraded) notes.push(UNIT_IDENTITY_NOTE);
  const { codebookUnits, units, plants, systems } = structure;

  const documents = capList(docsR.rows, DOC_CAP,
    `Showing the ${fmt(DOC_CAP)} most recently updated documents.`, notes);
  const libraries = capList((libsRes.data as GraphRows["libraries"] | null) ?? [], LIST_CAP,
    `Showing the first ${fmt(LIST_CAP)} libraries by name.`, notes);
  const assets = capList(optionalRows<AssetRowLite>({ data: assetsR.rows, error: assetsR.error }, "Equipment", notes), ASSET_CAP,
    `Showing the first ${fmt(ASSET_CAP)} equipment items by tag.`, notes);
  const projects = capList(optionalRows<GraphRows["projects"][number]>(projectsRes, "Projects", notes), LIST_CAP,
    `Showing the first ${fmt(LIST_CAP)} projects by name.`, notes);
  const plotPlans = capList(optionalRows<GraphRows["plotPlans"][number]>(plotRes, "Plot plans", notes), LIST_CAP,
    `Showing the first ${fmt(LIST_CAP)} plot plans by name.`, notes);

  for (const [what, r] of [
    ["Equipment-tag links", mustRead("document_assets", docAssets)],
    ["Project links", mustRead("project_documents", projectDocs)],
    ["Curated document links", mustRead("document_related_resources", related)],
    ["Supersession (revision lineage) links", mustRead("document_supersessions", supersessions)],
    ["Mention links", mustRead("entity_mentions", mentions)],
    ["Process flows", mustRead("process_flows", flows)],
  ] as const) {
    const n = cappedNote(what, r);
    if (n) notes.push(n);
  }

  // Knowledge documents aren't graph nodes; the CONTROLLED document they
  // mirror is. Only the mirrors the mentions actually point through are
  // read — exactly, never a capped slice (GM-13: a cap there would announce
  // controlled documents as "library-only").
  const kdocIds = [...new Set(mentions.rows.filter((m) => !m.document_id && m.knowledge_document_id)
    .map((m) => String(m.knowledge_document_id)))];
  const mirrorOf = await resolveMirrors(orgId, kdocIds, notes);

  const boundLibraries = [...new Set(codebookUnits.map((u) => (u.meta?.knowledgeLibraryId ?? "").trim()).filter(Boolean))];
  let knowledgeLibraries: GraphRows["knowledgeLibraries"] = [];
  if (boundLibraries.length > 0) {
    const kl = await pageIn<{ id: string; name: string }>("knowledge_libraries", "id, name", orgId, "id", boundLibraries, boundLibraries.length + 1);
    if (kl.error) notes.push(`Knowledge libraries could not be loaded (${kl.error.message}) — the map is incomplete.`);
    knowledgeLibraries = kl.rows;
  }

  return {
    rows: {
      codebookUnits, units, plants, systems, libraries, knowledgeLibraries, projects, plotPlans,
      documents, assets,
      docAssets: docAssets.rows, projectDocs: projectDocs.rows, related: related.rows,
      supersessions: supersessions.rows, mentions: mentions.rows, mirrorOf, flows: flows.rows,
    },
    mentions: { installed: !mentions.missing, capped: mentions.capped },
  };
}

// ─── Scoped reads (GAP-306) ─────────────────────────────────────────────────

const byUpdatedDesc = (a: DocumentRow, b: DocumentRow) => {
  const x = a.updated_at ?? "", y = b.updated_at ?? "";
  if (x !== y) return x === "" ? 1 : y === "" ? -1 : y.localeCompare(x);
  return a.id.localeCompare(b.id);
};

async function readScopeRows(
  orgId: string, scope: ResolvedScope, notes: string[],
): Promise<{ rows: GraphRows; mentions: { installed: boolean; capped: boolean }; requestedDocs: number; fetchedDocs: number; filingLibraries: string[] }> {
  const docIds = scope.documents;
  const assetIds = scope.assets;
  const BIG = Math.max(EDGE_CAP, docIds.length + assetIds.length + 1);

  const [structure, plotRes, flows] = await Promise.all([
    readStructure(orgId, notes),
    supabase.from("plot_plans").select("id, name, markers").eq("org_id", orgId).order("name").order("id").limit(LIST_CAP + 1) as unknown as PromiseLike<Res>,
    pageRows<{ id: string; from_kind: string; from_ref: string; to_kind: string; to_ref: string; status: string }>(
      "process_flows", "id, from_kind, from_ref, to_kind, to_ref, status", orgId, EDGE_CAP),
  ]);
  if (structure.degraded) notes.push(UNIT_IDENTITY_NOTE);

  // The unit's documents, complete up to the resolution cap, then capped
  // like the org-wide map — but over THIS unit's population.
  let docsR = await pageIn<DocumentRow>("documents", DOC_COLS, orgId, "id", docIds, docIds.length + 1);
  if (docsR.error && isMissingColumn(docsR.error)) {
    if (!structure.degraded) notes.push(UNIT_IDENTITY_NOTE);
    docsR = await pageIn<DocumentRow>("documents", DOC_COLS_LEGACY, orgId, "id", docIds, docIds.length + 1);
  }
  if (docsR.error) throw new Error(docsR.error.message);
  const fetchedDocs = docsR.rows.length;
  const documents = [...docsR.rows].sort(byUpdatedDesc);
  if (documents.length > DOC_CAP) {
    notes.push(`This unit holds ${fmt(documents.length)} documents you can see; showing the ${fmt(DOC_CAP)} most recently updated.`);
    documents.length = DOC_CAP;
  }

  const assetsR = await pageIn<AssetRowLite>("assets", ASSET_COLS, orgId, "id", assetIds, assetIds.length + 1);
  if (assetsR.error) notes.push(`Equipment could not be loaded (${assetsR.error.message}) — the map is incomplete.`);
  const assets = [...assetsR.rows].sort((a, b) => a.tag.localeCompare(b.tag) || a.id.localeCompare(b.id));
  if (assets.length > ASSET_CAP) {
    notes.push(`This unit holds ${fmt(assets.length)} equipment items; showing the first ${fmt(ASSET_CAP)} by tag.`);
    assets.length = ASSET_CAP;
  }

  const filingLibraries = [...new Set(documents.map((d) => d.library_id).filter(Boolean))];
  const libIds = [...new Set([...scope.libraries, ...filingLibraries])];
  const [libsR, klR] = await Promise.all([
    pageIn<{ id: string; name: string }>("libraries", "id, name", orgId, "id", libIds, libIds.length + 1),
    pageIn<{ id: string; name: string }>("knowledge_libraries", "id, name", orgId, "id", scope.knowledgeLibraries, scope.knowledgeLibraries.length + 1),
  ]);
  if (libsR.error) throw new Error(libsR.error.message);
  if (klR.error) notes.push(`Knowledge libraries could not be loaded (${klR.error.message}) — the map is incomplete.`);

  const ids = documents.map((d) => d.id);
  const [docAssets, projectDocs, relA, relB, supA, supB, mentByAsset, mentByDoc, mirrorsOfDocs] = await Promise.all([
    pageIn<{ id: string; document_id: string; asset_id: string }>("document_assets", "id, document_id, asset_id", orgId, "document_id", ids, BIG),
    pageIn<{ id: string; project_id: string; document_id: string }>("project_documents", "id, project_id, document_id", orgId, "document_id", ids, BIG),
    pageIn<{ id: string; document_id: string; target_document_id: string | null; kind: string }>(
      "document_related_resources", "id, document_id, target_document_id, kind", orgId, "document_id", ids, BIG),
    pageIn<{ id: string; document_id: string; target_document_id: string | null; kind: string }>(
      "document_related_resources", "id, document_id, target_document_id, kind", orgId, "target_document_id", ids, BIG),
    pageIn<{ id: string; superseded_doc_id: string; replacement_doc_id: string }>(
      "document_supersessions", "id, superseded_doc_id, replacement_doc_id", orgId, "superseded_doc_id", ids, BIG),
    pageIn<{ id: string; superseded_doc_id: string; replacement_doc_id: string }>(
      "document_supersessions", "id, superseded_doc_id, replacement_doc_id", orgId, "replacement_doc_id", ids, BIG),
    pageIn<{ id: string; asset_id: string; document_id: string | null; knowledge_document_id: string | null }>(
      "entity_mentions", "id, asset_id, document_id, knowledge_document_id", orgId, "asset_id", assets.map((a) => a.id), BIG),
    pageIn<{ id: string; asset_id: string; document_id: string | null; knowledge_document_id: string | null }>(
      "entity_mentions", "id, asset_id, document_id, knowledge_document_id", orgId, "document_id", ids, BIG),
    pageIn<{ id: string; source_document_id: string | null }>(
      "knowledge_documents", "id, source_document_id", orgId, "source_document_id", ids, BIG),
  ]);
  const mentByMirror = await pageIn<{ id: string; asset_id: string; document_id: string | null; knowledge_document_id: string | null }>(
    "entity_mentions", "id, asset_id, document_id, knowledge_document_id", orgId, "knowledge_document_id",
    mirrorsOfDocs.rows.map((k) => k.id), BIG);

  const union = <T extends { id: string }>(...parts: Array<PagedRows<T>>) => {
    const m = new Map<string, T>();
    for (const p of parts) for (const r of p.rows) m.set(String(r.id), r);
    return [...m.values()];
  };
  for (const [table, r] of [
    ["document_assets", docAssets], ["project_documents", projectDocs],
    ["document_related_resources", relA], ["document_related_resources", relB],
    ["document_supersessions", supA], ["document_supersessions", supB],
    ["entity_mentions", mentByAsset], ["entity_mentions", mentByDoc], ["entity_mentions", mentByMirror],
    ["process_flows", flows],
  ] as const) mustRead(table, r as PagedRows<{ id: string }>);
  for (const [what, r] of [
    ["Equipment-tag links", docAssets], ["Project links", projectDocs],
    ["Curated document links", relA], ["Curated document links", relB],
    ["Supersession (revision lineage) links", supA], ["Supersession (revision lineage) links", supB],
    ["Mention links", mentByAsset], ["Mention links", mentByDoc], ["Mention links", mentByMirror],
    ["Process flows", flows],
  ] as const) {
    const n = cappedNote(what, r as PagedRows<unknown>);
    if (n && !notes.includes(n)) notes.push(n);
  }
  if (mirrorsOfDocs.error) notes.push(`Indexed copies of this unit's documents could not be loaded (${mirrorsOfDocs.error.message}) — some mention links are not drawn.`);

  const mentions = union(mentByAsset, mentByDoc, mentByMirror);
  const mirrorOf = new Map<string, string | null>();
  for (const k of mirrorsOfDocs.rows) mirrorOf.set(String(k.id), k.source_document_id ?? null);
  const unresolved = [...new Set(mentions.filter((m) => !m.document_id && m.knowledge_document_id && !mirrorOf.has(String(m.knowledge_document_id)))
    .map((m) => String(m.knowledge_document_id)))];
  for (const [k, v] of await resolveMirrors(orgId, unresolved, notes)) mirrorOf.set(k, v);

  return {
    rows: {
      codebookUnits: structure.codebookUnits,
      units: structure.units,
      plants: structure.plants,
      systems: structure.systems,
      libraries: libsR.rows,
      knowledgeLibraries: klR.rows,
      projects: [],
      plotPlans: capList(optionalRows<GraphRows["plotPlans"][number]>(plotRes, "Plot plans", notes), LIST_CAP,
        `Showing the first ${fmt(LIST_CAP)} plot plans by name.`, notes),
      documents, assets,
      docAssets: docAssets.rows, projectDocs: projectDocs.rows,
      related: union(relA, relB), supersessions: union(supA, supB),
      mentions, mirrorOf, flows: flows.rows,
    },
    // A read with no ids issues no request and cannot report a missing
    // table, so the index is installed only if no read found it missing.
    mentions: {
      installed: !(mentByAsset.missing || mentByDoc.missing || mentByMirror.missing),
      capped: mentByAsset.capped || mentByDoc.capped || mentByMirror.capped,
    },
    requestedDocs: docIds.length,
    fetchedDocs,
    filingLibraries,
  };
}

// ─── Assembly (pure) ────────────────────────────────────────────────────────

export interface AssembleOptions {
  /** Notes from the read phase (caps, unreadable lists) — they lead the list. */
  notes?: string[];
  mentions?: { installed: boolean; capped: boolean };
  /** GAP-306 — assemble one scope: nodes are made only for its members
   *  (`inScope` over node ids); a link from a member to a non-member is a
   *  boundary stub on the member; `keep` is never pruned (the scope's unit). */
  scope?: {
    ref: ScopeRef; label: string; complete: boolean;
    inScope: (nodeId: string) => boolean;
    keep: ReadonlySet<string>;
  };
}

const SEVERED_LABEL: Record<GraphEdgeType, string> = {
  tag: "equipment-tag", unit: "unit / plant / system", library: "library", project: "project",
  related: "curated", supersession: "supersession", proposed: "proposed", mention: "mention",
  flow: "process-flow", plot: "plot-plan",
};

/** Build the graph from rows already read. Pure: no I/O, so every rule here —
 *  one node per unit, direction, the boundary, the counted losses — is tested
 *  directly (lib/__tests__/orgGraph.test.ts). */
export function assembleOrgGraph(rows: GraphRows, opts: AssembleOptions = {}): OrgGraph {
  const truncations = [...(opts.notes ?? [])];
  const inScope = opts.scope?.inScope;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  const severedByType = new Map<GraphEdgeType, number>();
  let boundary = 0;

  const put = (n: GraphNode) => { if (!inScope || inScope(n.id)) nodes.set(n.id, n); };

  type Outcome = "added" | "duplicate" | "self" | "severed" | "boundary" | "unrelated";
  const addEdge = (a: string, b: string, type: GraphEdgeType, extra?: Pick<GraphEdge, "via" | "note" | "folderIds">): Outcome => {
    if (a === b) return "self";
    const hasA = nodes.has(a), hasB = nodes.has(b);
    if (!hasA || !hasB) {
      // Verified sound, kept: an edge never dangles. What changed is that
      // the loss is COUNTED (GM-3) — or, in a scope, drawn as a stub.
      if (inScope) {
        const aIn = hasA || inScope(a), bIn = hasB || inScope(b);
        if (!aIn && !bIn) return "unrelated";
        if (hasA !== hasB && !inScope(hasA ? b : a)) {
          const inside = nodes.get(hasA ? a : b)!;
          inside.outside = (inside.outside ?? 0) + 1;
          boundary += 1;
          return "boundary";
        }
      }
      severedByType.set(type, (severedByType.get(type) ?? 0) + 1);
      return "severed";
    }
    const key = DIRECTED_EDGE_TYPES.has(type) || a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
    if (edgeSeen.has(key)) return "duplicate";
    edgeSeen.add(key);
    edges.push(extra ? { a, b, type, ...extra } : { a, b, type });
    nodes.get(a)!.degree += 1;
    nodes.get(b)!.degree += 1;
    return "added";
  };

  // ── One unit identity (GAP-305) ──────────────────────────────────────
  const cbCodes = new Set(rows.codebookUnits.map((u) => u.code));
  const rowOfCode = new Map<string, UnitRowLite>();   // codebook code → its mapped units row
  const unitNodeOf = new Map<string, string>();       // units.id → the node that IS that unit
  for (const u of rows.units) {
    const code = (u.codebook_code ?? "").trim();
    if (code && cbCodes.has(code) && !rowOfCode.has(code)) {
      rowOfCode.set(code, u);
      unitNodeOf.set(u.id, `cbunit:${code}`);
    } else {
      unitNodeOf.set(u.id, `unit:${u.id}`);
    }
  }
  const unitNode = (unitId: string) => unitNodeOf.get(unitId) ?? `unit:${unitId}`;
  const codeOfUnitRow = (unitId: string | null | undefined): string | null => {
    const n = unitId ? unitNodeOf.get(unitId) : undefined;
    return n && n.startsWith("cbunit:") ? n.slice("cbunit:".length) : null;
  };

  // ── Nodes ────────────────────────────────────────────────────────────
  for (const p of rows.plants) {
    put({
      id: `plant:${p.id}`, type: "plant", label: p.name, sub: p.code ?? undefined,
      href: "/admin/scope", degree: 0, plantId: p.id,
    });
  }
  // Site Codebook units are the unit identity the registry browses by
  // ("20" = Crude Unit) — first-class nodes with a real hub page. A mapped
  // operational unit is this same node (its id and plant ride along).
  for (const u of rows.codebookUnits) {
    const mapped = rowOfCode.get(u.code);
    put({
      id: `cbunit:${u.code}`, type: "unit", label: u.label || `Unit ${u.code}`, sub: `Unit ${u.code}`,
      href: `/admin/assets?unit=${encodeURIComponent(u.code)}`, degree: 0,
      unitCode: u.code, unitId: mapped?.id ?? null, plantId: mapped?.plant_id ?? null,
    });
  }
  // An operational unit the codebook does not hold (no mapping): its own node.
  for (const u of rows.units) {
    if (unitNodeOf.get(u.id) !== `unit:${u.id}`) continue;
    put({
      id: `unit:${u.id}`, type: "unit", label: u.name, sub: u.code ?? undefined,
      href: "/admin/scope", degree: 0, unitCode: null, unitId: u.id, plantId: u.plant_id,
    });
  }
  // Systems: folded into the unit class (decision — no new node type).
  for (const s of rows.systems) {
    put({
      id: `system:${s.id}`, type: "unit", label: s.name, sub: s.code ? `System ${s.code}` : "System",
      href: "/admin/scope", degree: 0,
      unitCode: codeOfUnitRow(s.unit_id), unitId: s.unit_id, plantId: s.plant_id, systemId: s.id,
    });
  }
  for (const l of rows.libraries) {
    put({ id: `lib:${l.id}`, type: "library", label: l.name, href: `/documents/${l.id}`, degree: 0, libraryId: l.id });
  }
  // A unit's bound AI knowledge library: folded into the library class.
  for (const k of rows.knowledgeLibraries) {
    put({ id: `klib:${k.id}`, type: "library", label: k.name, sub: "Knowledge library", href: `/knowledge/${k.id}`, degree: 0 });
  }
  for (const p of rows.projects) {
    put({
      id: `proj:${p.id}`, type: "project", label: p.name, sub: p.status ?? undefined,
      href: `/projects/${p.id}`, degree: 0,
    });
  }
  for (const pp of rows.plotPlans) {
    put({ id: `plot:${pp.id}`, type: "plot", label: pp.name, href: `/plot-plans/${pp.id}`, degree: 0 });
  }
  for (const a of rows.assets) {
    put({
      id: `asset:${a.id}`, type: "asset", label: a.tag, sub: a.description ?? undefined,
      href: `/assets/${encodeURIComponent(a.tag)}`, degree: 0,
      unitCode: a.unit_code ?? codeOfUnitRow(a.unit_id),
      unitId: a.unit_id ?? (a.unit_code ? rowOfCode.get(a.unit_code)?.id ?? null : null),
      plantId: a.plant_id ?? null, systemId: a.system_id ?? null,
      libraryId: a.library_id ?? null, typeId: a.type_id ?? null,
    });
  }
  // Multi-sheet drawing sets are one document number across several rows —
  // labelled by number alone the graph shows "PID-1234" five times with no
  // way to tell sheet 2 from sheet 5. When a number repeats, carry the sheet
  // (or, failing that, the title) into the label itself.
  const numberCount = new Map<string, number>();
  for (const d of rows.documents) {
    if (d.document_number) numberCount.set(d.document_number, (numberCount.get(d.document_number) ?? 0) + 1);
  }
  for (const d of rows.documents) {
    const dupes = d.document_number ? (numberCount.get(d.document_number) ?? 0) > 1 : false;
    const sheet = d.sheet_number != null
      ? `Sh ${d.sheet_number}${d.sheet_total ? ` of ${d.sheet_total}` : ""}`
      : null;
    const label = d.document_number
      ? (dupes ? `${d.document_number} · ${sheet ?? (d.title || `…${d.id.slice(0, 4)}`)}` : d.document_number)
      : (d.title || "Document");
    put({
      id: `doc:${d.id}`, type: "document",
      label,
      sub: d.document_number ? (d.title ?? undefined) : undefined,
      href: `/documents/${d.library_id}?doc=${d.id}`, degree: 0,
      unitCode: d.unit_code ?? codeOfUnitRow(d.unit_id),
      unitId: d.unit_id ?? (d.unit_code ? rowOfCode.get(d.unit_code)?.id ?? null : null),
      plantId: d.plant_id ?? null, systemId: d.system_id ?? null,
      libraryId: d.library_id, sheetNumber: d.sheet_number,
    });
  }

  // ── Edges ────────────────────────────────────────────────────────────
  for (const u of rows.units) addEdge(unitNode(u.id), `plant:${u.plant_id}`, "unit");
  for (const s of rows.systems) addEdge(`system:${s.id}`, unitNode(s.unit_id), "unit");

  // GPV-14: what an org states about a unit on its codebook entry — the
  // libraries (or folders) pinned to it and its bound knowledge library.
  // One edge per unit and library (the pair is the edge): every folder of
  // that library pinned to the unit rides on it as folderIds, and a pin of
  // the whole library covers its folders.
  for (const u of rows.codebookUnits) {
    const byLibrary = new Map<string, { whole: boolean; folders: string[]; notes: string[] }>();
    for (const link of u.meta?.links ?? []) {
      if (!link?.libraryId) continue;
      const pin = byLibrary.get(link.libraryId) ?? { whole: false, folders: [], notes: [] };
      if (link.folderId) { if (!pin.folders.includes(link.folderId)) pin.folders.push(link.folderId); }
      else pin.whole = true;
      const where = link.folderId ? `${link.libraryName || "library"} › ${link.folderName || "folder"}` : (link.libraryName || "");
      const note = [link.label, where].filter(Boolean).join(" — ");
      if (note && !pin.notes.includes(note)) pin.notes.push(note);
      byLibrary.set(link.libraryId, pin);
    }
    for (const [libraryId, pin] of byLibrary) {
      addEdge(`cbunit:${u.code}`, `lib:${libraryId}`, "library", {
        via: "pinned", note: pin.notes.join("; ") || undefined,
        ...(pin.whole ? {} : { folderIds: pin.folders }),
      });
    }
    const kl = (u.meta?.knowledgeLibraryId ?? "").trim();
    if (kl) addEdge(`cbunit:${u.code}`, `klib:${kl}`, "library", { via: "knowledge", note: "Knowledge library bound to this operating area" });
  }

  // Filing / decode against the operational unit. They DIFFER only when the
  // operational unit is mapped to a codebook unit and that code is not the
  // filing; an operational unit that is not mapped (or not on this map) cannot
  // be compared — counted apart, as the decode's report and 20261138's
  // inventory keep it (unitIdUnmapped).
  let disagreeDocs = 0, disagreeAssets = 0, unmappedDocs = 0, unmappedAssets = 0;
  const compare = (code: string | null | undefined, unitId: string | null | undefined): "same" | "differ" | "unmapped" | null => {
    if (!code || !unitId) return null;
    const opCode = codeOfUnitRow(unitId);
    if (opCode === null) return "unmapped";
    return opCode === code ? "same" : "differ";
  };
  for (const a of rows.assets) {
    if (a.unit_code) addEdge(`asset:${a.id}`, `cbunit:${a.unit_code}`, "unit");
    if (a.unit_id) addEdge(`asset:${a.id}`, unitNode(a.unit_id), "unit");
    const c = compare(a.unit_code, a.unit_id);
    if (c === "differ") disagreeAssets += 1;
    else if (c === "unmapped") unmappedAssets += 1;
    if (a.system_id) addEdge(`asset:${a.id}`, `system:${a.system_id}`, "unit");
    if (a.plant_id) addEdge(`asset:${a.id}`, `plant:${a.plant_id}`, "unit");
  }
  for (const d of rows.documents) {
    if (d.unit_code) addEdge(`doc:${d.id}`, `cbunit:${d.unit_code}`, "unit");
    if (d.unit_id) addEdge(`doc:${d.id}`, unitNode(d.unit_id), "unit");
    const c = compare(d.unit_code, d.unit_id);
    if (c === "differ") disagreeDocs += 1;
    else if (c === "unmapped") unmappedDocs += 1;
    if (d.system_id) addEdge(`doc:${d.id}`, `system:${d.system_id}`, "unit");
    if (d.plant_id) addEdge(`doc:${d.id}`, `plant:${d.plant_id}`, "unit");
    addEdge(`doc:${d.id}`, `lib:${d.library_id}`, "library");
  }
  for (const r of rows.docAssets) addEdge(`doc:${r.document_id}`, `asset:${r.asset_id}`, "tag");
  for (const r of rows.projectDocs) addEdge(`proj:${r.project_id}`, `doc:${r.document_id}`, "project");
  for (const r of rows.related) {
    if (r.kind === "document" && r.target_document_id) {
      addEdge(`doc:${r.document_id}`, `doc:${r.target_document_id}`, "related");
    }
  }
  for (const r of rows.supersessions) {
    addEdge(`doc:${r.superseded_doc_id}`, `doc:${r.replacement_doc_id}`, "supersession");
  }

  // Plot-plan markers: the spatial layer joins the web — an asset pinned on
  // a plan is an edge you can walk from the map to the place and back.
  for (const pp of rows.plotPlans) {
    const markers = Array.isArray(pp.markers) ? pp.markers : [];
    for (const mk of markers as Array<{ assetId?: string }>) {
      if (mk?.assetId) addEdge(`plot:${pp.id}`, `asset:${mk.assetId}`, "plot");
    }
  }

  // Process flows: asset endpoints are registry uuids; unit endpoints are
  // Site Codebook unit CODES (the cbunit nodes above). Directional: a FEEDS b.
  const flowNodeId = (kind: string, ref: string) =>
    kind === "asset" ? `asset:${ref}` : `cbunit:${ref}`;
  let proposedFlows = 0;
  for (const f of rows.flows) {
    const a = flowNodeId(f.from_kind, f.from_ref), b = flowNodeId(f.to_kind, f.to_ref);
    if (f.status === "confirmed") { addEdge(a, b, "flow"); continue; }
    if (f.status === "proposed" && (!inScope || inScope(a) || inScope(b))) proposedFlows += 1;
  }

  // Mentions. Drawn as their own edge type rather than folded into "tag",
  // because the two mean different things: a tag is a filing decision, a
  // mention is what the document actually says. Seeing them separately is
  // how you notice a standard that governs a vessel nobody ever tagged it to.
  let unmappedMentions = 0, unresolvedMentions = 0, drawnMentions = 0;
  for (const m of rows.mentions) {
    let docId = m.document_id;
    if (!docId && m.knowledge_document_id) {
      if (!rows.mirrorOf.has(m.knowledge_document_id)) { unresolvedMentions += 1; continue; }
      docId = rows.mirrorOf.get(m.knowledge_document_id) ?? null;
    }
    if (!docId) { unmappedMentions += 1; continue; }
    if (addEdge(`doc:${docId}`, `asset:${m.asset_id}`, "mention") === "added") drawnMentions += 1;
  }
  if (unmappedMentions > 0) {
    // Honest about the gap: passages in knowledge-only PDFs have no
    // controlled document to attach to, so they can't be drawn here. The
    // equipment hub still shows them. (Every mirror the mentions point
    // through was resolved, so this count is only ever true — GM-13.)
    truncations.push(
      `${fmt(unmappedMentions)} mention${unmappedMentions === 1 ? "" : "s"} come from library-only ` +
      "documents with no controlled counterpart — see the equipment page for those.",
    );
  }
  if (unresolvedMentions > 0) {
    truncations.push(`${plural(unresolvedMentions, "mention")} name${unresolvedMentions === 1 ? "s" : ""} an indexed document this map could not resolve — not drawn.`);
  }
  if (proposedFlows > 0) {
    truncations.push(`${plural(proposedFlows, "process flow")} ${proposedFlows === 1 ? "is" : "are"} proposed and awaiting review — not drawn (the operating area's flow panel lists ${proposedFlows === 1 ? "it" : "them"}).`);
  }
  if (disagreeDocs > 0) {
    truncations.push(`The decoded unit (drawing number) and the operational unit differ for ${plural(disagreeDocs, "document")} — both ties are drawn.`);
  }
  if (disagreeAssets > 0) {
    truncations.push(`The Site Codebook filing and the operational unit differ for ${plural(disagreeAssets, "equipment item")} — both ties are drawn.`);
  }
  if (unmappedDocs > 0) {
    truncations.push(`${plural(unmappedDocs, "document")} carr${unmappedDocs === 1 ? "ies" : "y"} an operational unit that is not mapped to the Site Codebook (or is not on this map), so its decoded unit and that unit cannot be compared — both ties are drawn.`);
  }
  if (unmappedAssets > 0) {
    truncations.push(`${plural(unmappedAssets, "equipment item")} carr${unmappedAssets === 1 ? "ies" : "y"} an operational unit that is not mapped to the Site Codebook (or is not on this map), so its filing and that unit cannot be compared — both ties are drawn.`);
  }
  const severed = [...severedByType.values()].reduce((s, n) => s + n, 0);
  if (severed > 0) {
    const parts = [...severedByType.entries()].sort((x, y) => y[1] - x[1])
      .map(([t, n]) => `${fmt(n)} ${SEVERED_LABEL[t]}`);
    truncations.push(
      `${plural(severed, "link")} lead${severed === 1 ? "s" : ""} to equipment, documents or units not on this map ` +
      `(beyond a cap above, archived, or outside your access) — ${parts.join(", ")}.`,
    );
  }
  if (opts.scope && boundary > 0) {
    truncations.push(`${plural(boundary, "link")} lead${boundary === 1 ? "s" : ""} out of ${opts.scope.label} — each node shows how many leave from it.`);
  }

  // Drop grouping nodes that connect nothing (a plant with no units, a
  // codebook unit with no equipment yet) — they'd float as noise. Documents,
  // assets and libraries stay even at degree 0: unlinked dots at the edge of
  // the universe are honest ("nothing links here yet"), same as Obsidian.
  for (const [id, n] of nodes) {
    if (n.degree === 0 && (n.type === "plant" || n.type === "unit" || n.type === "project")
        && !opts.scope?.keep.has(id) && !(n.outside && n.outside > 0)) {
      nodes.delete(id);
    }
  }

  return {
    nodes: [...nodes.values()], edges, truncations,
    mentionCoverage: {
      installed: opts.mentions?.installed ?? true,
      rows: rows.mentions.length,
      drawn: drawnMentions,
      unmapped: unmappedMentions,
      capped: opts.mentions?.capped ?? false,
    },
    severed,
    scope: opts.scope
      ? { ref: opts.scope.ref, label: opts.scope.label, boundary, complete: opts.scope.complete }
      : null,
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** The org graph — or, with `scope`, one unit's world (GAP-306). */
export async function buildOrgGraph(
  orgId: string, opts?: { scope?: ScopeRef | ResolvedScope | null },
): Promise<OrgGraph> {
  const notes: string[] = [];
  if (opts?.scope) {
    const { resolveScope, scopeMembership } = await import("@/lib/scope");
    const scope = "assets" in opts.scope ? opts.scope : await resolveScope(orgId, opts.scope);
    notes.push(...scope.truncations);
    const read = await readScopeRows(orgId, scope, notes);
    const hidden = read.requestedDocs > read.fetchedDocs ? read.requestedDocs - read.fetchedDocs : 0;
    if (hidden > 0) {
      // Only the relation can name a document the reader cannot open (the
      // filed / decoded / pinned reads are the reader's own), so this is
      // what the scope KNOWS it leaves out — a floor, never the whole count.
      notes.push(`${plural(hidden, "document")} linked to ${scope.label}'s equipment ${hidden === 1 ? "is" : "are"} outside your access — not drawn.`);
    }
    const g = assembleOrgGraph(read.rows, {
      notes, mentions: read.mentions,
      scope: {
        ref: scope.ref, label: scope.label, complete: scope.complete,
        inScope: scopeMembership(scope, { libraries: read.filingLibraries }),
        keep: new Set(scope.unitCodes.map((c) => `cbunit:${c}`)),
      },
    });
    // GM-6: a scope cannot say how many of ITS documents the reader cannot
    // see (restricted documents decoded, filed or pinned to the unit never
    // enter a reader's resolution), so it makes no total or outside claim.
    return {
      ...g,
      access: {
        documentsVisible: read.fetchedDocs, documentsTotal: null, outsideAccess: null,
        documentsDrawn: read.rows.documents.length, scoped: true,
      },
    };
  }
  const [read, counted] = await Promise.all([readOrgRows(orgId, notes), readAccess(orgId)]);
  const access: GraphAccess = { ...counted, documentsDrawn: read.rows.documents.length, scoped: false };
  const an = accessNote(access);
  if (an) notes.push(an);
  return { ...assembleOrgGraph(read.rows, { notes, mentions: read.mentions }), access };
}
