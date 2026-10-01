// lib/relatedResources.ts — curated "Related" links on a document.
//
// The human-curated layer of the relationship web (the automatic layer is
// document_assets + findRelatedDocuments): pin another controlled document
// or an external URL to any document, with a label and an order. Idea from
// HashiCorp Hermes' related-resources model, rebuilt org-native.

import { supabase } from "@/lib/supabase";

/** LNK-9: the declared provenance values — exactly the set the database's
 *  CHECK admits (20261126) and the Related panel renders:
 *    'human'    a person pinned it on a document;
 *    'system'   the engine applied it as provable (one reference, one owner);
 *    'proposed' a person approved a discovered connection in review;
 *    'shaped'   a person accepted it while shaping the graph from an AI
 *               answer — reviewed by that person, never by the queue. */
export const LINK_ORIGINS = ["human", "system", "proposed", "shaped"] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

/** The chip a non-human link carries, from the declared set. A value the
 *  app does not know renders as unknown — never as "approved". The graph
 *  wizard's legacy 'user' IS 'shaped' (20261126 backfills it; until that
 *  migration is applied, the rows still carry 'user'). */
export function originBadge(origin: string | null | undefined): { label: string; title: string } | null {
  switch (origin ?? "human") {
    case "human": return null;
    case "system": return { label: "auto", title: "Applied automatically — provable connection" };
    case "proposed": return { label: "approved", title: "Approved from a proposal" };
    case "user":
    case "shaped": return { label: "from answer", title: "Linked while shaping the graph from an AI answer — not reviewed in the proposal queue" };
    default: return { label: "origin?", title: `Unrecognised origin “${origin}” — how this link was made is not known` };
  }
}

export interface RelatedResource {
  id: string;
  document_id: string;
  kind: "document" | "url";
  target_document_id: string | null;
  url: string | null;
  label: string;
  sort_order: number;
  created_by_name: string | null;
  /** Provenance — how this link came to exist (LINK_ORIGINS). A string, not
   *  the union: rows written before 20261126 may carry anything. */
  origin?: string | null;
  proposer?: string | null;
  evidence?: { summary?: string; detail?: string; tags?: string[] } | null;
  approved_by_name?: string | null;
  /** Set when a later revision removed the evidence this link was built on.
   *  The link stays; the system just stops pretending nothing changed. */
  evidence_lost_at?: string | null;
  /** LNK-13: 'out' — carried by this document; 'in' — carried by the other
   *  document and pointing here. A document↔document link reads the same
   *  from both ends; only which row carries it differs. */
  direction?: "out" | "in";
  /** The OTHER document of a document link, from this document's side. */
  other_document_id?: string | null;
  /** Hydrated for kind=document — the other document. */
  target?: { document_number: string | null; title: string | null; library_id: string } | null;
}

/** The columns the Related panel renders — never `*` (LNK-4 / LNK-13 fix
 *  pass 4). */
const RELATED_COLS = "id, document_id, kind, target_document_id, url, label, sort_order, created_by_name, origin, proposer, evidence, approved_by_name, evidence_lost_at, created_at";
/** An inbound row before its carrier is known to be readable: which
 *  document carries it, and nothing the link says (no label, no evidence). */
const INBOUND_KEY_COLS = "id, document_id, kind, target_document_id, sort_order, created_at";

type ReadError = { code?: string; message: string } | null;
const missingTable = (e: ReadError) => !!e && (e.code === "42P01" || /does not exist/i.test(e.message));

/** Every curated link on a document — the ones it carries AND the document
 *  links carried by the other end (LNK-13): an approved connection is
 *  carried by one of its two documents, and both documents' Related panels
 *  show it with the same provenance and evidence. A link CARRIED by a
 *  document the viewer cannot read is not listed (as listBacklinks never
 *  listed it): its evidence and its unpin control belong to that document.
 *  So the inbound read fetches only which document carries each link; its
 *  label and evidence are read afterwards, for the carriers the viewer's
 *  own documents read returns (fix pass 4 — the browser never receives
 *  what an unreadable carrier says). Since 20261126 the table's own read
 *  policy says the same (document_related_resources_read_endpoints, IRLS-15):
 *  a link is readable only by someone who can read its carrier and, for a
 *  document link, its target — so a link to a document the viewer cannot
 *  read is not returned at all. On a database without that policy such a
 *  link is listed with no `target` (the panel says "restricted document").
 *  A documents read that FAILS is an error, never an access verdict: it
 *  would otherwise list every linked document as restricted and drop every
 *  inbound link. */
export async function listRelatedResources(documentId: string): Promise<RelatedResource[]> {
  const [outRes, inRes] = await Promise.all([
    supabase.from("document_related_resources").select(RELATED_COLS)
      .eq("document_id", documentId).order("sort_order").order("created_at"),
    supabase.from("document_related_resources").select(INBOUND_KEY_COLS)
      .eq("target_document_id", documentId).eq("kind", "document").order("sort_order").order("created_at"),
  ]);
  for (const res of [outRes, inRes]) {
    if (res.error) {
      if (missingTable(res.error)) return [];
      throw new Error(res.error.message);
    }
  }
  const outbound = ((outRes.data as unknown as RelatedResource[]) ?? [])
    .map((r) => ({ ...r, direction: "out" as const, other_document_id: r.kind === "document" ? r.target_document_id : null }));
  const inbound = ((inRes.data as unknown as RelatedResource[]) ?? [])
    .filter((r) => r.document_id !== documentId);
  const ids = [...new Set([
    ...outbound.filter((r) => r.kind === "document" && r.other_document_id).map((r) => r.other_document_id as string),
    ...inbound.map((r) => r.document_id),
  ])];
  const byId = new Map<string, { document_number: string | null; title: string | null; library_id: string }>();
  if (ids.length > 0) {
    // Read through the viewer's own documents RLS: what does not come back
    // is a document they cannot read — but only when the read answered.
    const { data: docs, error: docsErr } = await supabase
      .from("documents").select("id, document_number, title, library_id").in("id", ids);
    if (docsErr) throw new Error(`The linked documents could not be read (${docsErr.message}).`);
    for (const d of docs ?? []) {
      byId.set((d as { id: string }).id, d as { document_number: string | null; title: string | null; library_id: string });
    }
  }
  // An inbound link from a document the viewer cannot read: not theirs to
  // see — so its words are never read. The rest are read in full.
  const readableIn = inbound.filter((r) => byId.has(r.document_id)).map((r) => r.id);
  let inboundFull: RelatedResource[] = [];
  if (readableIn.length > 0) {
    const { data, error } = await supabase.from("document_related_resources").select(RELATED_COLS).in("id", readableIn);
    if (error) throw new Error(error.message);
    inboundFull = ((data as unknown as RelatedResource[]) ?? [])
      .map((r) => ({ ...r, direction: "in" as const, other_document_id: r.document_id }));
  }
  const candidates: RelatedResource[] = [...outbound, ...inboundFull].sort((a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0)
    || String((a as { created_at?: string }).created_at ?? "").localeCompare(String((b as { created_at?: string }).created_at ?? "")));
  const rows: RelatedResource[] = [];
  const seen = new Set<string>();
  for (const r of candidates) {
    if (r.other_document_id) r.target = byId.get(r.other_document_id) ?? null;
    // One entry per other document: a pair linked both ways (a manual pin
    // made before the carrier rule) is still one relationship.
    if (r.kind === "document" && r.other_document_id) {
      if (seen.has(r.other_document_id)) continue;
      seen.add(r.other_document_id);
    }
    rows.push(r);
  }
  return rows;
}

/** Refusals the database returns without an error are reported (checked
 *  writes — IRLS-10's related-resource limb). */
const REFUSED = "That link was not changed — your role cannot edit related links on this document.";

export async function addRelatedResource(input: {
  orgId: string; documentId: string;
  kind: "document" | "url";
  targetDocumentId?: string; url?: string; label?: string;
  userId: string; userName?: string;
  sortOrder?: number;
}): Promise<void> {
  const { data, error } = await supabase.from("document_related_resources").insert({
    org_id: input.orgId,
    document_id: input.documentId,
    kind: input.kind,
    target_document_id: input.targetDocumentId ?? null,
    url: input.url ?? null,
    label: (input.label ?? "").trim(),
    sort_order: input.sortOrder ?? 0,
    created_by: input.userId,
    created_by_name: input.userName ?? null,
  }).select("id");
  if (error) {
    if (error.code === "23505") throw new Error("Those two documents are already linked.");
    if (error.code === "42501") throw new Error(REFUSED);
    throw new Error(error.message);
  }
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

export async function removeRelatedResource(id: string): Promise<void> {
  const { data, error } = await supabase.from("document_related_resources").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (((data as unknown[] | null) ?? []).length === 0) throw new Error(REFUSED);
}

// ── Backlinks — the other direction of the web ─────────────────────────────
//
// Obsidian's core magic: opening a note shows everything that points AT it,
// not just what it points to. Here that means: documents whose curated pins
// target this one, and projects this document has traveled through.

export interface DocumentBacklinks {
  /** Documents that pinned THIS document as related. */
  docs: Array<{
    id: string; document_number: string | null; title: string | null;
    library_id: string; pinned_by: string | null;
  }>;
  /** Projects this document appears in. */
  projects: Array<{ id: string; name: string }>;
}

export async function listBacklinks(documentId: string): Promise<DocumentBacklinks> {
  const empty: DocumentBacklinks = { docs: [], projects: [] };
  const [pinsRes, projRes] = await Promise.all([
    supabase.from("document_related_resources")
      .select("document_id, created_by_name")
      .eq("target_document_id", documentId).limit(25),
    supabase.from("project_documents")
      .select("project_id")
      .eq("document_id", documentId).limit(10),
  ]);
  // Pre-migration or RLS-hidden — backlinks just don't render.
  const pins = pinsRes.error ? [] :
    ((pinsRes.data as Array<{ document_id: string; created_by_name: string | null }>) ?? []);
  const projLinks = projRes.error ? [] :
    ((projRes.data as Array<{ project_id: string }>) ?? []);

  const out: DocumentBacklinks = { docs: [], projects: [] };
  if (pins.length > 0) {
    const { data } = await supabase
      .from("documents").select("id, document_number, title, library_id")
      .in("id", pins.map((p) => p.document_id));
    const byName = new Map(pins.map((p) => [p.document_id, p.created_by_name]));
    out.docs = ((data as Array<{ id: string; document_number: string | null; title: string | null; library_id: string }>) ?? [])
      .map((d) => ({ ...d, pinned_by: byName.get(d.id) ?? null }));
  }
  if (projLinks.length > 0) {
    const { data } = await supabase
      .from("projects").select("id, name")
      .in("id", [...new Set(projLinks.map((p) => p.project_id))]);
    out.projects = (data as Array<{ id: string; name: string }>) ?? [];
  }
  return out.docs.length === 0 && out.projects.length === 0 ? empty : out;
}
