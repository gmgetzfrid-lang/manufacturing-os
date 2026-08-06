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

export type GraphNodeType = "document" | "asset" | "unit" | "library" | "project" | "plant";

export type GraphEdgeType =
  | "tag"          // document ↔ asset
  | "unit"         // asset/document → unit, unit → plant
  | "library"      // document → library
  | "project"      // project ↔ document
  | "related"      // curated pin
  | "supersession"
  | "proposed"     // discovered, awaiting review — drawn as a ghost
  | "mention";     // the document's text names the equipment, quote attached

export interface GraphNode {
  id: string;            // namespaced: "doc:<id>", "asset:<id>", "cbunit:<code>", …
  type: GraphNodeType;
  label: string;
  sub?: string;          // secondary line for the info card
  href: string;          // where clicking through lands
  degree: number;        // filled during assembly
}

export interface GraphEdge {
  a: string;             // node id
  b: string;             // node id
  type: GraphEdgeType;
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
  unit_code: string | null; unit_id: string | null;
}

/** Page through a join table until exhausted or capped. */
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
    docAssets, projectDocs, related, supersessions, mentions, kdocMirrors,
  ] = await Promise.all([
    loadCodebook(orgId).catch(() => null),
    supabase.from("units").select("id, name, code, plant_id").eq("org_id", orgId).eq("archived", false),
    supabase.from("plants").select("id, name, code").eq("org_id", orgId).eq("archived", false),
    supabase.from("libraries").select("id, name").eq("org_id", orgId).limit(300),
    supabase.from("projects").select("id, name, status").eq("org_id", orgId).limit(300),
    supabase.from("documents")
      .select("id, document_number, title, library_id, unit_id, sheet_number, sheet_total")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(DOC_CAP),
    supabase.from("assets")
      .select("id, tag, description, unit_code, unit_id")
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
    // Knowledge documents aren't graph nodes; the CONTROLLED document they
    // mirror is. Without this map every mention found in an indexed PDF would
    // be dropped on the floor.
    supabase.from("knowledge_documents")
      .select("id, source_document_id").eq("org_id", orgId)
      .not("source_document_id", "is", null).limit(5000),
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

  const addEdge = (a: string, b: string, type: GraphEdgeType) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return;
    const key = a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ a, b, type });
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
  for (const a of assets) {
    nodes.set(`asset:${a.id}`, {
      id: `asset:${a.id}`, type: "asset", label: a.tag, sub: a.description ?? undefined,
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
  for (const u of units) addEdge(`unit:${u.id}`, `plant:${u.plant_id}`, "unit");
  for (const a of assets) {
    if (a.unit_code) addEdge(`asset:${a.id}`, `cbunit:${a.unit_code}`, "unit");
    if (a.unit_id) addEdge(`asset:${a.id}`, `unit:${a.unit_id}`, "unit");
  }
  for (const d of docs) {
    if (d.unit_id) addEdge(`doc:${d.id}`, `unit:${d.unit_id}`, "unit");
    addEdge(`doc:${d.id}`, `lib:${d.library_id}`, "library");
  }
  for (const r of docAssets.rows) addEdge(`doc:${r.document_id}`, `asset:${r.asset_id}`, "tag");
  for (const r of projectDocs.rows) addEdge(`proj:${r.project_id}`, `doc:${r.document_id}`, "project");
  for (const r of related.rows) {
    if (r.kind === "document" && r.target_document_id) {
      addEdge(`doc:${r.document_id}`, `doc:${r.target_document_id}`, "related");
    }
  }
  for (const r of supersessions.rows) {
    addEdge(`doc:${r.superseded_doc_id}`, `doc:${r.replacement_doc_id}`, "supersession");
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
    addEdge(`doc:${docId}`, `asset:${m.asset_id}`, "mention");
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
