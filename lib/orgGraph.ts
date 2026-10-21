// lib/orgGraph.ts — the whole org as one graph.
//
// Assembles every entity the system knows into nodes and every persisted
// relationship into edges, for the Obsidian-style org graph page. Nothing
// here is inferred at render time — each edge is a row somewhere:
//
//   document ↔ asset      document_assets (drawing tag extraction + manual)
//   asset    → unit       assets.unit_code (Site Codebook) / assets.unit_id
//   document → unit       documents.unit_id (operational scope)
//   unit     → plant      units.plant_id
//   document → library    documents.library_id (toggled off by default)
//   project  ↔ document   project_documents (checkout + manual)
//   document ↔ document   document_related_resources (curated pins)
//   document ↔ document   document_supersessions (lineage)
//   document ↔ asset      entity_mentions (the text names it — with the quote)
//
// Reads are org-scoped and RLS-enforced (client supabase). Every list is
// capped and the truncation is reported, never silent.

import { supabase } from "@/lib/supabase";
import { loadCodebook } from "@/lib/codebook";
import { fetchAllRows } from "@/lib/fetchAllRows";

export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant" | "plot";

export type GraphEdgeType =
  | "tag"          // document ↔ asset
  | "unit"         // asset/document → unit, unit → plant
  | "library"      // document → library
  | "project"      // project ↔ document
  | "related"      // curated pin
  | "supersession"
  | "proposed"     // discovered, awaiting review — drawn as a ghost
  | "mention"      // the document's text names the equipment, quote attached
  | "flow"         // process flow: from FEEDS to (directional in meaning)
  | "plot";        // the asset is MARKED on this plot plan — spatial truth

export interface GraphNode {
  id: string;            // namespaced: "doc:<id>", "asset:<id>", "cbunit:<code>", …
  type: GraphNodeType;
  label: string;
  sub?: string;          // secondary line for the info card
  /** Equipment: its type as a person or the codebook set it ("Heaters"). */
  category?: string;
  href: string;          // where clicking through lands
  degree: number;        // filled during assembly
}

export interface GraphEdge {
  a: string;             // node id
  b: string;             // node id
  type: GraphEdgeType;
  /** Why the two are linked, in one sentence — shown when a line is
   *  hovered or clicked and in the node's connections list. */
  why?: string;
}

export interface OrgGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Human-readable notes about anything that was capped. */
  truncations: string[];
}

const DOC_CAP = 1500;
const ASSET_CAP = 2000;
const EDGE_PAGE = 1000;
const EDGE_CAP = 8000;

interface DocRow {
  id: string; document_number: string | null; title: string | null;
  library_id: string; unit_id: string | null;
  sheet_number: number | null; sheet_total: number | null;
}
interface AssetRowLite {
  id: string; tag: string; description: string | null;
  unit_code: string | null; unit_id: string | null; type_id?: string | null;
  /** "person" when someone chose the type (a folder mark); the codebook's
   *  automatic guess by tag letters does not group the map. */
  type_set?: string | null;
}

/** Page through a join table until exhausted or capped. */
/** fetchAllRows' result in the { data, error } shape the loaders read. */
async function asResult<T>(p: Promise<{ rows: T[]; error: string | null }>): Promise<{ data: T[]; error: { message: string } | null }> {
  const { rows, error } = await p;
  return { data: rows, error: error ? { message: error } : null };
}

async function pageRows<T>(
  table: string, select: string, orgId: string, cap: number,
): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += EDGE_PAGE) {
    const { data, error } = await supabase
      .from(table).select(select)
      .eq("org_id", orgId)
      .range(from, Math.min(from + EDGE_PAGE, cap) - 1);
    if (error) {
      // Pre-migration tables (curated related) just contribute nothing.
      if (error.code === "42P01" || /does not exist/i.test(error.message)) return { rows, capped: false };
      throw new Error(error.message);
    }
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < EDGE_PAGE) return { rows, capped: false };
  }
  return { rows, capped: true };
}

export async function buildOrgGraph(orgId: string): Promise<OrgGraph> {
  const truncations: string[] = [];

  const [
    codebook,
    unitsRes, plantsRes, libsRes, projectsRes, docsRes, assetsRes,
    docAssets, projectDocs, related, supersessions, mentions, flows, plotPlansRes, kdocMirrors,
  ] = await Promise.all([
    loadCodebook(orgId).catch(() => null),
    supabase.from("units").select("id, name, code, plant_id").eq("org_id", orgId).eq("archived", false),
    supabase.from("plants").select("id, name, code").eq("org_id", orgId).eq("archived", false),
    supabase.from("libraries").select("id, name").eq("org_id", orgId).limit(300),
    supabase.from("projects").select("id, name, status").eq("org_id", orgId).limit(300),
    // Paged up to DOC_CAP (one read stops at 1,000 rows, silently). Archived
    // documents are out of the library's view, so out of the graph's too.
    asResult(fetchAllRows<DocRow>((from, to) => supabase.from("documents")
      .select("id, document_number, title, library_id, unit_id, sheet_number, sheet_total")
      .eq("org_id", orgId).neq("status", "Archived")
      .order("updated_at", { ascending: false, nullsFirst: false }).order("id")
      .range(from, Math.min(to, DOC_CAP - 1)), DOC_CAP)),
    supabase.from("assets")
      .select("id, tag, description, unit_code, unit_id, type_id, type_set:metadata->>typeSetBy")
      .eq("org_id", orgId).eq("archived", false)
      .limit(ASSET_CAP),
    pageRows<{ document_id: string; asset_id: string }>(
      "document_assets", "document_id, asset_id", orgId, EDGE_CAP),
    pageRows<{ project_id: string; document_id: string }>(
      "project_documents", "project_id, document_id", orgId, EDGE_CAP),
    pageRows<{ document_id: string; target_document_id: string | null; kind: string }>(
      "document_related_resources", "document_id, target_document_id, kind", orgId, EDGE_CAP),
    pageRows<{ superseded_doc_id: string; replacement_doc_id: string }>(
      "document_supersessions", "superseded_doc_id, replacement_doc_id", orgId, EDGE_CAP),
    // The mention engine. A pre-migration org contributes nothing (pageRows
    // tolerates a missing table), which is exactly the right degradation:
    // fewer edges, never a broken page.
    pageRows<{ asset_id: string; document_id: string | null; knowledge_document_id: string | null }>(
      "entity_mentions", "asset_id, document_id, knowledge_document_id", orgId, EDGE_CAP),
    // Confirmed process flows — the plant's topology. A pre-migration org
    // contributes nothing (pageRows tolerates the missing table).
    pageRows<{ from_kind: string; from_ref: string; to_kind: string; to_ref: string; status: string }>(
      "process_flows", "from_kind, from_ref, to_kind, to_ref, status", orgId, EDGE_CAP),
    // Plot plans: spatial maps whose markers pin assets to a place. Each
    // plan is a node; each marker is an edge to the asset it pins.
    supabase.from("plot_plans").select("id, name, markers").eq("org_id", orgId).limit(300),
    // Knowledge documents aren't graph nodes; the CONTROLLED document they
    // mirror is. Without this map every mention found in an indexed PDF would
    // be dropped on the floor.
    // Set-aside (retired) entries belong to documents that left the library.
    asResult(fetchAllRows<{ id: string; source_document_id: string | null }>((from, to) => supabase.from("knowledge_documents")
      .select("id, source_document_id").eq("org_id", orgId)
      .not("source_document_id", "is", null).neq("status", "retired").order("id").range(from, to), 50_000)),
  ]);

  // Documents and libraries are the core — a real error there is fatal. The
  // rest are optional feature areas: an org that never ran that feature's
  // migration gets a smaller graph, not a broken page.
  for (const r of [docsRes, libsRes]) {
    if (r.error) throw new Error(r.error.message);
  }
  const optional = <T,>(res: { data: unknown; error: { message: string } | null }): T[] => {
    if (res.error) return [];
    return (res.data as T[]) ?? [];
  };

  const docs = (docsRes.data as DocRow[]) ?? [];
  const libs = (libsRes.data as Array<{ id: string; name: string }>) ?? [];
  const assets = optional<AssetRowLite>(assetsRes);
  const typeNames = new Map<string, string>();
  if (assets.some((a) => a.type_id && a.type_set === "person")) {
    const { data: types } = await supabase.from("asset_types").select("id, name").eq("org_id", orgId);
    for (const t of (types as Array<{ id: string; name: string }> | null) ?? []) typeNames.set(t.id, t.name);
  }
  const units = optional<{ id: string; name: string; code: string | null; plant_id: string }>(unitsRes);
  const plants = optional<{ id: string; name: string; code: string | null }>(plantsRes);
  const projects = optional<{ id: string; name: string; status: string | null }>(projectsRes);

  if (docs.length === DOC_CAP) truncations.push(`Showing the ${DOC_CAP} most recently updated documents.`);
  if (assets.length === ASSET_CAP) truncations.push(`Showing the first ${ASSET_CAP} equipment items.`);
  if (docAssets.capped) truncations.push("Equipment-tag links capped — densest web shown.");
  if (projectDocs.capped) truncations.push("Project links capped.");

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();

  const L = (id: string) => nodes.get(id)?.label ?? id;
  const addEdge = (a: string, b: string, type: GraphEdgeType, why?: string) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return;
    const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push(why ? { a, b, type, why } : { a, b, type });
    nodes.get(a)!.degree += 1;
    nodes.get(b)!.degree += 1;
  };

  // ── Nodes ──────────────────────────────────────────────────────────────
  for (const p of plants) {
    nodes.set(`plant:${p.id}`, {
      id: `plant:${p.id}`, type: "plant", label: p.name, sub: p.code ?? undefined,
      href: "/admin/scope", degree: 0,
    });
  }
  for (const u of units) {
    nodes.set(`unit:${u.id}`, {
      id: `unit:${u.id}`, type: "unit", label: u.name, sub: u.code ?? undefined,
      href: "/admin/assets", degree: 0,
    });
  }
  // Site Codebook units are the unit identity the registry actually browses
  // by ("20" = Crude Unit) — first-class nodes with a real hub page.
  for (const u of codebook?.units ?? []) {
    nodes.set(`cbunit:${u.code}`, {
      id: `cbunit:${u.code}`, type: "unit", label: u.label || `Unit ${u.code}`, sub: `Unit ${u.code}`,
      href: `/admin/assets?unit=${encodeURIComponent(u.code)}`, degree: 0,
    });
  }
  for (const l of libs) {
    nodes.set(`lib:${l.id}`, {
      id: `lib:${l.id}`, type: "library", label: l.name,
      href: `/documents/${l.id}`, degree: 0,
    });
  }
  for (const p of projects) {
    nodes.set(`proj:${p.id}`, {
      id: `proj:${p.id}`, type: "project", label: p.name, sub: p.status ?? undefined,
      href: `/projects/${p.id}`, degree: 0,
    });
  }
  for (const pp of optional<{ id: string; name: string; markers: unknown }>(plotPlansRes)) {
    nodes.set(`plot:${pp.id}`, {
      id: `plot:${pp.id}`, type: "plot", label: pp.name,
      href: `/plot-plans/${pp.id}`, degree: 0,
    });
  }
  for (const a of assets) {
    nodes.set(`asset:${a.id}`, {
      id: `asset:${a.id}`, type: "asset", label: a.tag, sub: a.description ?? undefined,
      category: a.type_id && a.type_set === "person" ? typeNames.get(a.type_id) : undefined,
      href: `/assets/${encodeURIComponent(a.tag)}`, degree: 0,
    });
  }
  // Multi-sheet drawing sets are one document number across several rows —
  // labelled by number alone the graph shows "PID-1234" five times with no
  // way to tell sheet 2 from sheet 5. When a number repeats, carry the sheet
  // (or, failing that, the title) into the label itself.
  const numberCount = new Map<string, number>();
  for (const d of docs) {
    if (d.document_number) numberCount.set(d.document_number, (numberCount.get(d.document_number) ?? 0) + 1);
  }
  for (const d of docs) {
    const dupes = d.document_number ? (numberCount.get(d.document_number) ?? 0) > 1 : false;
    const sheet = d.sheet_number != null
      ? `Sh ${d.sheet_number}${d.sheet_total ? ` of ${d.sheet_total}` : ""}`
      : null;
    const label = d.document_number
      ? (dupes ? `${d.document_number} · ${sheet ?? (d.title || `…${d.id.slice(0, 4)}`)}` : d.document_number)
      : (d.title || "Document");
    nodes.set(`doc:${d.id}`, {
      id: `doc:${d.id}`, type: "document",
      label,
      sub: d.document_number ? (d.title ?? undefined) : undefined,
      href: `/documents/${d.library_id}?doc=${d.id}`, degree: 0,
    });
  }

  // ── Edges ──────────────────────────────────────────────────────────────
  for (const u of units) addEdge(`unit:${u.id}`, `plant:${u.plant_id}`, "unit", `${u.name} is part of ${L(`plant:${u.plant_id}`)}`);
  for (const a of assets) {
    if (a.unit_code) addEdge(`asset:${a.id}`, `cbunit:${a.unit_code}`, "unit", `The equipment registry files ${a.tag} under ${L(`cbunit:${a.unit_code}`)} (unit ${a.unit_code})`);
    if (a.unit_id) addEdge(`asset:${a.id}`, `unit:${a.unit_id}`, "unit", `The equipment registry files ${a.tag} under ${L(`unit:${a.unit_id}`)}`);
  }
  for (const d of docs) {
    if (d.unit_id) addEdge(`doc:${d.id}`, `unit:${d.unit_id}`, "unit", `The document's unit field says ${L(`unit:${d.unit_id}`)}`);
    addEdge(`doc:${d.id}`, `lib:${d.library_id}`, "library", `Filed in the ${L(`lib:${d.library_id}`)} library`);
  }
  for (const r of docAssets.rows) addEdge(`doc:${r.document_id}`, `asset:${r.asset_id}`, "tag", `${L(`asset:${r.asset_id}`)} is tagged on ${L(`doc:${r.document_id}`)}`);
  for (const r of projectDocs.rows) addEdge(`proj:${r.project_id}`, `doc:${r.document_id}`, "project", `${L(`doc:${r.document_id}`)} is listed in project ${L(`proj:${r.project_id}`)}`);

  // ── One Estate edges ──────────────────────────────────────────────────
  // Declared and resolved relationships with provenance (estate_edges):
  // project scope (project → unit / asset / document), documents in
  // projects, documents and folders linked to units. A folder's unit flows
  // to every document filed under it, so the graph draws a drawing in the
  // crude unit because its folder is, not only when a person set unit_id.
  // A pre-20261020 org contributes nothing.
  try {
    const [edgesRes, foldersRes, docFoldersRes] = await Promise.all([
      supabase.from("estate_edges").select("a, b, type, summary").eq("org_id", orgId).eq("status", "applied")
        .in("type", ["project_scope", "in_project", "belongs_to_unit", "about_asset", "tagged_to"]).limit(8000),
      asResult(fetchAllRows<{ id: string; parent_id: string | null }>((from, to) => supabase.from("collections")
        .select("id, parent_id").eq("org_id", orgId).order("id").range(from, to), 20_000)),
      asResult(fetchAllRows<{ id: string; collection_id: string }>((from, to) => supabase.from("documents")
        .select("id, collection_id").eq("org_id", orgId).not("collection_id", "is", null).order("id").range(from, to), 50_000)),
    ]);
    const estate = ((edgesRes.data as Array<{ a: string; b: string; type: string; summary?: string | null }> | null) ?? []);
    const parentOf = new Map<string, string | null>();
    for (const c of (foldersRes.data as Array<{ id: string; parent_id: string | null }> | null) ?? []) parentOf.set(c.id, c.parent_id);
    const folderUnit = new Map<string, string>();
    const folderProject = new Map<string, string>();
    const folderAsset = new Map<string, string>();
    for (const e of estate) {
      if (e.a.startsWith("folder:")) {
        const fid = e.a.slice(7);
        if (e.type === "belongs_to_unit" && e.b.startsWith("cbunit:")) folderUnit.set(fid, e.b);
        if (e.type === "in_project" && e.b.startsWith("proj:")) folderProject.set(fid, e.b);
        if (e.type === "about_asset" && e.b.startsWith("asset:")) folderAsset.set(fid, e.b);
        continue;
      }
      if (!nodes.has(e.a) || !nodes.has(e.b)) continue;
      const why = e.summary ?? undefined;
      if (e.type === "project_scope" || e.type === "in_project") addEdge(e.a.startsWith("proj:") ? e.a : e.b, e.a.startsWith("proj:") ? e.b : e.a, "project", why);
      else if (e.type === "belongs_to_unit") addEdge(e.a, e.b, "unit", why);
      else if (e.type === "tagged_to") addEdge(e.a, e.b, "tag", why);
    }
    if (folderUnit.size || folderProject.size || folderAsset.size) {
      const nearest = (fid: string | null, map: Map<string, string>): string | null => {
        const seen = new Set<string>();
        let cur = fid;
        while (cur && !seen.has(cur)) { seen.add(cur); const hit = map.get(cur); if (hit) return hit; cur = parentOf.get(cur) ?? null; }
        return null;
      };
      for (const d of (docFoldersRes.data as Array<{ id: string; collection_id: string | null }> | null) ?? []) {
        const id = `doc:${d.id}`;
        if (!nodes.has(id)) continue;
        const u = nearest(d.collection_id, folderUnit); if (u && nodes.has(u)) addEdge(id, u, "unit", `${L(id)} is filed under a folder linked to ${L(u)}`);
        const p = nearest(d.collection_id, folderProject); if (p && nodes.has(p)) addEdge(p, id, "project", `${L(id)} is filed under a folder linked to project ${L(p)}`);
        const a = nearest(d.collection_id, folderAsset); if (a && nodes.has(a)) addEdge(id, a, "tag", `${L(id)} is filed in ${L(a)}'s folder`);
      }
    }
  } catch { /* estate edges are optional */ }
  for (const r of related.rows) {
    if (r.kind === "document" && r.target_document_id) {
      addEdge(`doc:${r.document_id}`, `doc:${r.target_document_id}`, "related", `Someone pinned ${L(`doc:${r.target_document_id}`)} as related to ${L(`doc:${r.document_id}`)}`);
    }
  }
  for (const r of supersessions.rows) {
    addEdge(`doc:${r.superseded_doc_id}`, `doc:${r.replacement_doc_id}`, "supersession", `${L(`doc:${r.superseded_doc_id}`)} is superseded by ${L(`doc:${r.replacement_doc_id}`)}`);
  }

  // Plot-plan markers: the spatial layer joins the web — an asset pinned on
  // a plan is an edge you can walk from the map to the place and back.
  for (const pp of optional<{ id: string; name: string; markers: unknown }>(plotPlansRes)) {
    const markers = Array.isArray(pp.markers) ? pp.markers : [];
    for (const mk of markers as Array<{ assetId?: string }>) {
      if (mk?.assetId) addEdge(`plot:${pp.id}`, `asset:${mk.assetId}`, "plot", `${L(`asset:${mk.assetId}`)} is pinned on plot plan ${pp.name}`);
    }
  }

  // Process flows: asset endpoints are registry uuids; unit endpoints are
  // Site Codebook unit CODES (the cbunit nodes above).
  const flowNodeId = (kind: string, ref: string) =>
    kind === "asset" ? `asset:${ref}` : `cbunit:${ref}`;
  for (const f of flows.rows) {
    if (f.status !== "confirmed") continue;
    addEdge(flowNodeId(f.from_kind, f.from_ref), flowNodeId(f.to_kind, f.to_ref), "flow", `${L(flowNodeId(f.from_kind, f.from_ref))} feeds ${L(flowNodeId(f.to_kind, f.to_ref))} (a confirmed process flow)`);
  }

  // Mentions. Drawn as their own edge type rather than folded into "tag",
  // because the two mean different things: a tag is a filing decision, a
  // mention is what the document actually says. Seeing them separately is
  // how you notice a standard that governs a vessel nobody ever tagged it to.
  const mirrorOf = new Map<string, string>();
  for (const k of optional<{ id: string; source_document_id: string | null }>(kdocMirrors)) {
    if (k.source_document_id) mirrorOf.set(k.id, k.source_document_id);
  }
  let unmappedMentions = 0;
  for (const m of mentions.rows) {
    const docId = m.document_id
      ?? (m.knowledge_document_id ? mirrorOf.get(m.knowledge_document_id) : undefined);
    if (!docId) { unmappedMentions += 1; continue; }
    addEdge(`doc:${docId}`, `asset:${m.asset_id}`, "mention", `${L(`doc:${docId}`)} mentions ${L(`asset:${m.asset_id}`)} in its text`);
  }
  if (mentions.capped) truncations.push("Mention links capped — densest web shown.");
  if (unmappedMentions > 0) {
    // Honest about the gap: passages in knowledge-only PDFs have no
    // controlled document to attach to, so they can't be drawn here. The
    // equipment hub still shows them.
    truncations.push(
      `${unmappedMentions} mention${unmappedMentions === 1 ? "" : "s"} come from library-only ` +
      "documents with no controlled counterpart — see the equipment page for those.",
    );
  }

  // Drop grouping nodes that connect nothing (a plant with no units, a
  // codebook unit with no equipment yet) — they'd float as noise. Documents,
  // assets and libraries stay even at degree 0: unlinked dots at the edge of
  // the universe are honest ("nothing links here yet"), same as Obsidian.
  for (const [id, n] of nodes) {
    if (n.degree === 0 && (n.type === "plant" || n.type === "unit" || n.type === "project")) {
      nodes.delete(id);
    }
  }

  return { nodes: [...nodes.values()], edges, truncations };
}
