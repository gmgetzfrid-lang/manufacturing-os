// lib/find/server.ts — SERVER-ONLY. The one find service.
//
// Every search box calls this. It understands the query once (the finder's
// parser), resolves the entities it names (registry, aliases, codebook,
// projects), then gathers evidence in layers, cheapest first:
//
//   L0  names, folders, metadata, structure      (in memory, free)
//   L1  what the estate already KNOWS: tags filed, tags read off pages with
//       their position, sentences that mention the asset, folders about it,
//       project and unit links                   (indexed rows, free)
//   L2  the text itself, through the knowledge chunks' full-text index
//                                                (one tsvector query, free)
//   L3  meaning, through embeddings — only when L0–L2 are thin and a key is
//       configured                               (phase 7)
//
// Then the work in flight around what was found (tickets, checkouts,
// markups, holds, projects, milestones), and how much of the scope has
// actually been read. Access is enforced per document before anything is
// returned. No model is ever called here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadFinderData } from "@/lib/fileFinder/load";
import { parseQuery, type ParsedQuery } from "@/lib/fileFinder/queryParse";
import { rankEntries } from "@/lib/fileFinder/rank";
import { clusterByHash, type IndexEntry } from "@/lib/fileFinder/fileIndex";
import { canonicalForm, tagVariants } from "@/lib/fileFinder/tagForms";
import { isClose } from "@/lib/fileFinder/fuzzy";
import { words } from "@/lib/fileFinder/tokens";
import type { FinderAlias } from "@/lib/fileFinder/aliasTypes";
import { normalizeTag } from "@/lib/codebook";
import { readableControlledDocIds, type KnowledgePrincipal } from "@/lib/knowledgeAccess";
import { nid } from "@/lib/estate/ids";
import { foldLayers, hideOtherTypes, groupResults, snippetAround, REL_WEIGHT, TEXT_HIT, type LayerAdd } from "./merge";
import type { FindRequest, FindResponse, FindEntity, FindActivity, FindCoverage, FindLayer } from "./types";

type Role = KnowledgePrincipal["role"];

function aliasFromRow(r: Record<string, unknown>): FinderAlias {
  return {
    id: String(r.id), orgId: String(r.org_id), term: String(r.term), termCanonical: String(r.term_canonical),
    means: String(r.means), meansCanonical: String(r.means_canonical), kind: (r.kind as FinderAlias["kind"]) ?? "term",
    origin: (r.origin as FinderAlias["origin"]) ?? "human", hits: Number(r.hits ?? 0), misses: Number(r.misses ?? 0),
    note: (r.note as string | null) ?? null, createdByName: (r.created_by_name as string | null) ?? null, createdAt: String(r.created_at ?? ""),
  };
}

interface AssetLite { id: string; tag: string; description: string | null; unit_code: string | null }

function inScope(e: IndexEntry, scope: FindRequest["scope"]): boolean {
  if (!scope) return true;
  if (scope.libraryId && e.libraryId !== scope.libraryId) return false;
  if (scope.folderId && !e.pathIds.includes(scope.folderId)) return false;
  if (scope.projectId && !e.linkedProjects.includes(scope.projectId)) return false;
  if (scope.assetId && !e.linkedAssets.includes(scope.assetId)) return false;
  if (scope.unitCode && !e.unitCodes.includes(scope.unitCode)) return false;
  return true;
}

export async function findEstate(admin: SupabaseClient, principal: KnowledgePrincipal, req: FindRequest): Promise<FindResponse> {
  const t0 = Date.now();
  const notes: string[] = [];
  const layers: FindLayer[] = ["L0"];
  const orgId = req.orgId;

  const [data, aliasesRes, assetsRes, projectsRes] = await Promise.all([
    loadFinderData(orgId, principal.role as Role, principal.isController, admin),
    admin.from("finder_aliases").select("*").eq("org_id", orgId),
    admin.from("assets").select("id, tag, description, unit_code").eq("org_id", orgId).limit(20000),
    admin.from("projects").select("id, name, status").eq("org_id", orgId).limit(2000),
  ]);
  const aliases = ((aliasesRes.data as Record<string, unknown>[] | null) ?? []).map(aliasFromRow);
  const assets = ((assetsRes.data as AssetLite[] | null) ?? []);
  const projects = ((projectsRes.data as Array<{ id: string; name: string; status: string | null }> | null) ?? []);
  const assetByCanon = new Map<string, AssetLite>();
  for (const a of assets) assetByCanon.set(canonicalForm(a.tag), a);

  const q: ParsedQuery = parseQuery(req.query, { units: data.units, aliases });
  const entries = data.entries.filter((e) => inScope(e, req.scope));

  // ── Entities the query names ───────────────────────────────────────────
  const entities: FindEntity[] = [];
  const assetHits = new Map<string, { asset: AssetLite; via: string }>();
  const unitLabel = (code: string) => data.units.find((u) => u.code === code)?.label ?? code;
  for (const c of q.identifiers) {
    const exact = assetByCanon.get(c.value);
    if (exact) { assetHits.set(exact.id, { asset: exact, via: c.via === "alias" ? `alias` : "typed" }); continue; }
    // Close spelling: one or two characters off.
    for (const [canon, a] of assetByCanon) {
      const cl = isClose(c.value, canon);
      if (cl.close) { assetHits.set(a.id, { asset: a, via: `close to ${c.label} (${cl.edits} off)` }); break; }
    }
  }
  // Nicknames taught on the asset itself ("north furnace").
  const phraseKeys = [...q.phrases.map((c) => c.value), ...q.words.map((c) => c.value)].map(normalizeTag).filter((k) => k.length >= 3);
  if (phraseKeys.length) {
    const { data: al } = await admin.from("asset_aliases").select("asset_id, alias").eq("org_id", orgId).in("alias_normalized", phraseKeys.slice(0, 50));
    for (const r of (al as Array<{ asset_id: string; alias: string }> | null) ?? []) {
      const a = assets.find((x) => x.id === r.asset_id);
      if (a && !assetHits.has(a.id)) assetHits.set(a.id, { asset: a, via: `nickname "${r.alias}"` });
    }
  }
  if (req.scope?.assetId) {
    const a = assets.find((x) => x.id === req.scope!.assetId);
    if (a && !assetHits.has(a.id)) assetHits.set(a.id, { asset: a, via: "this page" });
  }
  for (const { asset, via } of assetHits.values()) {
    entities.push({ node: nid.asset(asset.id), kind: "asset", label: asset.tag, sub: [asset.description, asset.unit_code ? unitLabel(asset.unit_code) : null].filter(Boolean).join(" · ") || undefined, via, href: `/assets/${encodeURIComponent(asset.tag)}` });
  }
  for (const c of q.units) entities.push({ node: nid.cbunit(c.value), kind: "unit", label: unitLabel(c.value), sub: `unit ${c.value}`, via: c.via });
  const projectHits = new Map<string, { id: string; name: string; status: string | null; via: string }>();
  for (const c of q.identifiers) {
    for (const p of projects) {
      const codes = words(p.name).map(canonicalForm);
      const hasCode = codes.includes(c.value) || canonicalForm(p.name).includes(c.value) && c.value.length >= 5;
      if (hasCode) projectHits.set(p.id, { ...p, via: `names ${c.label}` });
    }
  }
  if (req.scope?.projectId) { const p = projects.find((x) => x.id === req.scope!.projectId); if (p) projectHits.set(p.id, { ...p, via: "this page" }); }
  for (const p of projectHits.values()) entities.push({ node: nid.proj(p.id), kind: "project", label: p.name, sub: p.status ?? undefined, via: p.via, href: `/projects/${p.id}` });

  // ── L0 ─────────────────────────────────────────────────────────────────
  const sameBytes = clusterByHash(entries);
  const l0 = q.chips.length ? rankEntries(entries, q, { units: data.units, sameBytes }) : [];
  const entryByDoc = new Map(entries.map((e) => [e.id.replace(/^doc:/, ""), e]));
  const adds: LayerAdd[] = [];
  const add = (docId: string, a: Omit<LayerAdd, "entryId">) => { if (entryByDoc.has(docId)) adds.push({ entryId: `doc:${docId}`, ...a }); };

  // ── L1: what the estate knows ──────────────────────────────────────────
  const assetIds = [...assetHits.keys()];
  const mirrorToDoc = new Map<string, string>();
  if (assetIds.length) {
    layers.push("L1");
    const assetNodes = assetIds.map(nid.asset);
    const tagForms = new Set<string>();
    for (const { asset } of assetHits.values()) { tagForms.add(normalizeTag(asset.tag)); for (const v of tagVariants(canonicalForm(asset.tag))) tagForms.add(v); tagForms.add(canonicalForm(asset.tag)); }
    const [da, edges, mentions, ents] = await Promise.all([
      admin.from("document_assets").select("document_id, asset_id, tag_text, source").eq("org_id", orgId).in("asset_id", assetIds).limit(2000),
      admin.from("estate_edges").select("a, b, type, summary").eq("org_id", orgId).eq("status", "applied").in("b", assetNodes).limit(2000),
      admin.from("entity_mentions").select("asset_id, document_id, knowledge_document_id, page, context_snippet").eq("org_id", orgId).in("asset_id", assetIds).limit(2000),
      admin.from("knowledge_page_entities").select("document_id, page, tag, x, y").eq("org_id", orgId).eq("kind", "equipment").in("tag", [...tagForms].slice(0, 40)).limit(2000),
    ]);
    const label = (assetId: string) => assetHits.get(assetId)?.asset.tag ?? "it";
    for (const r of (da.data as Array<{ document_id: string; asset_id: string; tag_text: string | null; source: string | null }> | null) ?? []) {
      add(r.document_id, { evidence: [{ kind: "identifier", label: `Tagged to ${label(r.asset_id)}${r.source ? ` (${r.source})` : ""}`, delta: REL_WEIGHT.tagged_to, layer: "L1", tier: "exact" }],
        relations: [{ rel: "tagged_to", node: nid.asset(r.asset_id), label: label(r.asset_id), detail: r.source === "manual" ? "tagged by hand" : "tagged from the drawing" }], pages: [] });
    }
    const aboutFolders: Array<{ folderId: string; assetId: string }> = [];
    for (const e of (edges.data as Array<{ a: string; b: string; type: string; summary: string }> | null) ?? []) {
      const assetId = e.b.slice("asset:".length);
      if (e.type === "tagged_to" && e.a.startsWith("doc:")) {
        add(e.a.slice(4), { evidence: [{ kind: "identifier", label: e.summary, delta: REL_WEIGHT.tagged_to, layer: "L1", tier: "exact" }],
          relations: [{ rel: "tagged_to", node: e.b, label: label(assetId), detail: e.summary }], pages: [] });
      } else if (e.type === "about_asset" && e.a.startsWith("folder:")) aboutFolders.push({ folderId: e.a.slice(7), assetId });
    }
    for (const f of aboutFolders) {
      for (const e of entries) {
        if (!e.pathIds.includes(f.folderId)) continue;
        add(e.id.replace(/^doc:/, ""), { evidence: [{ kind: "word", label: `Filed in ${label(f.assetId)}'s folder (${[e.libraryName, ...e.path].filter(Boolean).join(" / ")})`, delta: REL_WEIGHT.filed_under, layer: "L1", tier: "exact" }],
          relations: [{ rel: "filed_under", node: nid.asset(f.assetId), label: label(f.assetId), detail: [e.libraryName, ...e.path].filter(Boolean).join(" / ") }], pages: [] });
      }
    }
    // Mentions: the sentence is the evidence.
    const mentionRows = (mentions.data as Array<{ asset_id: string; document_id: string | null; knowledge_document_id: string | null; page: number; context_snippet: string | null }> | null) ?? [];
    const kids = new Set<string>();
    for (const m of mentionRows) if (!m.document_id && m.knowledge_document_id) kids.add(m.knowledge_document_id);
    for (const r of (ents.data as Array<{ document_id: string }> | null) ?? []) kids.add(r.document_id);
    if (kids.size) {
      const { data: km } = await admin.from("knowledge_documents").select("id, source_document_id").eq("org_id", orgId).in("id", [...kids].slice(0, 500));
      for (const r of (km as Array<{ id: string; source_document_id: string | null }> | null) ?? []) if (r.source_document_id) mirrorToDoc.set(r.id, r.source_document_id);
    }
    const mentionedPerDoc = new Map<string, number>();
    for (const m of mentionRows) {
      const docId = m.document_id ?? (m.knowledge_document_id ? mirrorToDoc.get(m.knowledge_document_id) : undefined);
      if (!docId) continue;
      const n = (mentionedPerDoc.get(docId) ?? 0) + 1;
      mentionedPerDoc.set(docId, n);
      add(docId, {
        evidence: n === 1 ? [{ kind: "phrase", label: `Page ${m.page} mentions ${label(m.asset_id)}: "${(m.context_snippet ?? "").slice(0, 120)}"`, delta: REL_WEIGHT.mentioned_in, layer: "L1", tier: "exact" }] : [],
        relations: [{ rel: "mentioned_in", node: nid.asset(m.asset_id), label: label(m.asset_id), detail: `page ${m.page}`, page: m.page, snippet: m.context_snippet ?? undefined, knowledgeDocId: m.knowledge_document_id ?? undefined }],
        pages: m.context_snippet && m.knowledge_document_id ? [{ page: m.page, snippet: m.context_snippet, knowledgeDocId: m.knowledge_document_id }] : [],
      });
    }
    // Drawn on: tag read off the sheet, with where it sits.
    const drawnPerDoc = new Map<string, number>();
    for (const r of (ents.data as Array<{ document_id: string; page: number; tag: string; x: number | null; y: number | null }> | null) ?? []) {
      const docId = mirrorToDoc.get(r.document_id);
      if (!docId) continue;
      const assetId = [...assetHits.values()].find(({ asset }) => canonicalForm(asset.tag) === canonicalForm(r.tag))?.asset.id;
      const n = (drawnPerDoc.get(docId) ?? 0) + 1;
      drawnPerDoc.set(docId, n);
      const where = r.x != null && r.y != null ? `${r.y < 0.5 ? "upper" : "lower"} ${r.x < 0.5 ? "left" : "right"}` : "";
      add(docId, {
        evidence: n === 1 ? [{ kind: "identifier", label: `${r.tag} is drawn on sheet ${r.page}${where ? `, ${where}` : ""}`, delta: REL_WEIGHT.drawn_on, layer: "L1", tier: "exact" }] : [],
        relations: [{ rel: "drawn_on", node: assetId ? nid.asset(assetId) : `tag:${r.tag}`, label: r.tag, detail: `sheet ${r.page}${where ? `, ${where}` : ""}`, page: r.page, x: r.x ?? undefined, y: r.y ?? undefined, knowledgeDocId: r.document_id }],
        pages: [],
      });
    }
  }
  // Projects named: everything linked to them.
  if (projectHits.size) {
    layers.push("L1");
    const projNodes = [...projectHits.keys()].map(nid.proj);
    const [edges, pdocs] = await Promise.all([
      admin.from("estate_edges").select("a, b, type, summary").eq("org_id", orgId).eq("status", "applied").in("b", projNodes).limit(2000),
      admin.from("project_documents").select("project_id, document_id").eq("org_id", orgId).in("project_id", [...projectHits.keys()]).limit(2000),
    ]);
    const pname = (id: string) => projectHits.get(id)?.name ?? "project";
    for (const e of (edges.data as Array<{ a: string; b: string; type: string; summary: string }> | null) ?? []) {
      const pid = e.b.slice(5);
      if (e.type === "in_project" && e.a.startsWith("doc:")) add(e.a.slice(4), { evidence: [{ kind: "word", label: e.summary, delta: REL_WEIGHT.in_project, layer: "L1", tier: "exact" }], relations: [{ rel: "in_project", node: e.b, label: pname(pid), detail: e.summary }], pages: [] });
      if (e.type === "in_project" && e.a.startsWith("folder:")) {
        const fid = e.a.slice(7);
        for (const en of entries) if (en.pathIds.includes(fid)) add(en.id.slice(4), { evidence: [{ kind: "word", label: `Filed under a folder linked to project "${pname(pid)}"`, delta: REL_WEIGHT.in_project, layer: "L1", tier: "exact" }], relations: [{ rel: "in_project", node: e.b, label: pname(pid), detail: "project folder" }], pages: [] });
      }
    }
    for (const r of (pdocs.data as Array<{ project_id: string; document_id: string }> | null) ?? []) {
      add(r.document_id, { evidence: [{ kind: "word", label: `Worked on under project "${pname(r.project_id)}" (checkout)`, delta: REL_WEIGHT.in_project, layer: "L1", tier: "exact" }], relations: [{ rel: "in_project", node: nid.proj(r.project_id), label: pname(r.project_id), detail: "checked out under it" }], pages: [] });
    }
  }

  // ── L2: the text itself ────────────────────────────────────────────────
  const terms: string[] = [];
  for (const c of q.identifiers) { terms.push(c.label); for (const v of tagVariants(c.value)) if (!terms.includes(v)) terms.push(v); }
  for (const c of q.phrases) terms.push(c.value);
  for (const c of q.words) if (c.value.length >= 3) terms.push(c.value);
  if (terms.length) {
    const ws = terms.slice(0, 12).map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(" OR ");
    const { data: chunks, error } = await admin.from("knowledge_chunks").select("document_id, page, content").eq("org_id", orgId)
      .textSearch("tsv", ws, { type: "websearch", config: "english" }).limit(300);
    if (!error && chunks?.length) {
      layers.push("L2");
      const kids = [...new Set((chunks as Array<{ document_id: string }>).map((c) => c.document_id))].filter((k) => !mirrorToDoc.has(k));
      for (let i = 0; i < kids.length; i += 200) {
        const { data: km } = await admin.from("knowledge_documents").select("id, source_document_id").eq("org_id", orgId).in("id", kids.slice(i, i + 200));
        for (const r of (km as Array<{ id: string; source_document_id: string | null }> | null) ?? []) if (r.source_document_id) mirrorToDoc.set(r.id, r.source_document_id);
      }
      const perDoc = new Map<string, number>();
      for (const c of chunks as Array<{ document_id: string; page: number; content: string }>) {
        const docId = mirrorToDoc.get(c.document_id);
        if (!docId) continue;
        const n = (perDoc.get(docId) ?? 0) + 1;
        perDoc.set(docId, n);
        if (n > 4) continue;
        const snippet = snippetAround(c.content, terms);
        add(docId, {
          evidence: n === 1 ? [{ kind: "phrase", label: `Page ${c.page} says: "${snippet.slice(0, 140)}"`, delta: TEXT_HIT, layer: "L2", tier: "exact" }] : n <= 3 ? [{ kind: "phrase", label: `Also on page ${c.page}`, delta: 5, layer: "L2", tier: "exact" }] : [],
          relations: [], pages: [{ page: c.page, snippet, knowledgeDocId: c.document_id }],
        });
      }
    } else if (error && !/does not exist|schema cache/i.test(error.message)) notes.push(`text layer: ${error.message}`);
  }

  // ── L3: meaning — only when the cheap layers came back thin ───────────
  // "what holds the pump down" matches no name and no tag; a standard that
  // says "anchor bolt design" does. Runs once per query on the caller's own
  // embedding key, in the space the corpus was built in, and never on a
  // workspace without one.
  const strongSoFar = l0.filter((h) => h.verdict !== "weak" && h.verdict !== "rejected").length + adds.length;
  const meaningWords = q.words.length + q.phrases.length;
  if (req.semantic !== false && strongSoFar < 5 && meaningWords > 0) {
    try {
      const { data: conn } = await admin.from("ai_connections").select("provider, api_key, embedding_provider, embedding_model, embedding_api_key").eq("org_id", orgId).eq("user_id", principal.uid).maybeSingle();
      const { embeddingConnectionFrom, embedQuery, toVectorLiteral } = await import("@/lib/ai/embeddings");
      const embedding = embeddingConnectionFrom(conn as Parameters<typeof embeddingConnectionFrom>[0]);
      if (embedding) {
        const { data: stamped } = await admin.from("knowledge_chunks").select("embedding_model").eq("org_id", orgId).not("embedding", "is", null).not("embedding_model", "is", null).limit(1).maybeSingle();
        const corpusModel = ((stamped as { embedding_model?: string | null } | null)?.embedding_model) ?? embedding.model;
        const literal = toVectorLiteral(await embedQuery(embedding.provider, corpusModel, embedding.apiKey, req.query));
        const { data: libs } = await admin.from("knowledge_libraries").select("id").eq("org_id", orgId).limit(50);
        const perDoc = new Map<string, number>();
        for (const lib of (libs as Array<{ id: string }> | null) ?? []) {
          const { data: hits } = await admin.rpc("semantic_search", { p_org_id: orgId, p_library_id: lib.id, p_embedding: literal, p_limit: 12, p_model: corpusModel });
          for (const h of (hits as Array<{ chunk_id: string; document_id: string; page: number; content: string; similarity?: number }> | null) ?? []) {
            if (!mirrorToDoc.has(h.document_id)) {
              const { data: km } = await admin.from("knowledge_documents").select("id, source_document_id").eq("id", h.document_id).maybeSingle();
              const src = (km as { source_document_id?: string | null } | null)?.source_document_id;
              if (src) mirrorToDoc.set(h.document_id, src);
            }
            const docId = mirrorToDoc.get(h.document_id);
            if (!docId) continue;
            const n = (perDoc.get(docId) ?? 0) + 1;
            perDoc.set(docId, n);
            if (n > 2) continue;
            const snippet = snippetAround(h.content, terms);
            add(docId, { evidence: n === 1 ? [{ kind: "phrase", label: `Page ${h.page} means the same thing: "${snippet.slice(0, 120)}"`, delta: 18, layer: "L3", tier: "close" }] : [], relations: [], pages: [{ page: h.page, snippet, knowledgeDocId: h.document_id }] });
            if (!layers.includes("L3")) layers.push("L3");
          }
        }
      } else notes.push("Meaning search is off: no embedding key on this account (Intelligence › Setup).");
    } catch (e) { notes.push(`meaning search: ${(e as Error).message}`); }
  }

  // ── Fold, enforce access, hide, group ──────────────────────────────────
  let results = foldLayers(entries, l0, adds, (e) => (e.hash ? (sameBytes.get(e.hash)?.length ?? 1) - 1 : 0));
  const readable = await readableControlledDocIds(principal, results.slice(0, 400).map((r) => r.documentId));
  results = results.filter((r) => readable.has(r.documentId));
  const hid = hideOtherTypes(results, q);
  results = hid.kept.slice(0, req.limit ?? 150);
  const groups = groupResults(results);

  // ── Activity: what is going on around this ─────────────────────────────
  const activity: FindActivity = { tickets: [], checkouts: [], markups: [], holds: [], projects: [], milestones: [] };
  const wantActivity = req.activity !== false && (entities.length > 0 || results.length > 0);
  if (wantActivity) {
    const docIds = results.slice(0, 120).map((r) => r.documentId);
    const docName = (id: string) => entryByDoc.get(id)?.name ?? "document";
    const docHref = (id: string) => entryByDoc.get(id)?.href ?? "/documents";
    const unitCodes = entities.filter((e) => e.kind === "unit").map((e) => e.node.slice(7));
    const unitNames = unitCodes.map(unitLabel);
    const tagTerms = [...assetHits.values()].flatMap(({ asset }) => [asset.tag, ...tagVariants(canonicalForm(asset.tag))]);
    const [tk1, tk2, co, mu, ho, pe, pd] = await Promise.all([
      unitCodes.length || unitNames.length
        ? admin.from("tickets").select("id, ticket_id, title, status, unit, requester_name, assigned_drafter_name, created_at").eq("org_id", orgId).is("closed_at", null).or([...unitCodes, ...unitNames].map((u) => `unit.ilike.%${u.replace(/[%,]/g, "")}%`).join(",")).limit(25)
        : Promise.resolve({ data: [] as unknown[] }),
      tagTerms.length
        ? admin.from("tickets").select("id, ticket_id, title, status, unit, requester_name, assigned_drafter_name, created_at").eq("org_id", orgId).is("closed_at", null).textSearch("search_tsv", tagTerms.slice(0, 8).map((t) => `"${t}"`).join(" OR "), { type: "websearch", config: "english" }).limit(25)
        : Promise.resolve({ data: [] as unknown[] }),
      docIds.length ? admin.from("checkout_sessions").select("id, document_id, user_name, started_at, project_id, mode").eq("org_id", orgId).in("document_id", docIds).is("ended_at", null).is("released_at", null).limit(50) : Promise.resolve({ data: [] as unknown[] }),
      docIds.length ? admin.from("markup_requests").select("id, document_id, requested_by_name, requested_from_name, status, created_at").eq("org_id", orgId).in("document_id", docIds).is("resolved_at", null).limit(50) : Promise.resolve({ data: [] as unknown[] }),
      docIds.length ? admin.from("holds").select("id, document_id, reason, opened_by_name, opened_at").eq("org_id", orgId).in("document_id", docIds).is("released_at", null).limit(50) : Promise.resolve({ data: [] as unknown[] }),
      entities.length ? admin.from("estate_edges").select("a, b, type, summary").eq("org_id", orgId).eq("status", "applied").eq("type", "project_scope").in("b", entities.map((e) => e.node)).limit(200) : Promise.resolve({ data: [] as unknown[] }),
      docIds.length ? admin.from("project_documents").select("project_id, document_id").eq("org_id", orgId).in("document_id", docIds).limit(500) : Promise.resolve({ data: [] as unknown[] }),
    ]);
    type TicketRow = { id: string; ticket_id: string; title: string; status: string; unit: string | null; requester_name: string | null; assigned_drafter_name: string | null; created_at: string };
    const seenT = new Set<string>();
    for (const [rows, why] of [[tk1.data as TicketRow[], "in this unit"], [tk2.data as TicketRow[], "names this equipment"]] as const) {
      for (const t of rows ?? []) { if (seenT.has(t.id)) continue; seenT.add(t.id); activity.tickets.push({ id: t.id, ticketId: t.ticket_id, title: t.title, status: t.status, unit: t.unit, requester: t.requester_name, drafter: t.assigned_drafter_name, createdAt: t.created_at, href: `/requests/${t.id}`, why }); }
    }
    const projIds = new Set<string>();
    for (const e of (pe.data as Array<{ a: string; b: string; summary: string }>) ?? []) if (e.a.startsWith("proj:")) projIds.add(e.a.slice(5));
    for (const r of (pd.data as Array<{ project_id: string; document_id: string }>) ?? []) projIds.add(r.project_id);
    for (const c of (co.data as Array<{ id: string; document_id: string; user_name: string | null; started_at: string; project_id: string | null; mode: string | null }>) ?? []) { if (c.project_id) projIds.add(c.project_id); }
    const projById = new Map(projects.map((p) => [p.id, p]));
    for (const c of (co.data as Array<{ id: string; document_id: string; user_name: string | null; started_at: string; project_id: string | null; mode: string | null }>) ?? []) {
      activity.checkouts.push({ id: c.id, documentId: c.document_id, documentName: docName(c.document_id), user: c.user_name, since: c.started_at, projectId: c.project_id, projectName: c.project_id ? projById.get(c.project_id)?.name ?? null : null, mode: c.mode, href: docHref(c.document_id) });
    }
    for (const m of (mu.data as Array<{ id: string; document_id: string; requested_by_name: string | null; requested_from_name: string | null; status: string; created_at: string }>) ?? []) {
      activity.markups.push({ id: m.id, documentId: m.document_id, documentName: docName(m.document_id), requestedBy: m.requested_by_name, requestedFrom: m.requested_from_name, status: m.status, createdAt: m.created_at, href: docHref(m.document_id) });
    }
    for (const h of (ho.data as Array<{ id: string; document_id: string; reason: string | null; opened_by_name: string | null; opened_at: string }>) ?? []) {
      activity.holds.push({ id: h.id, documentId: h.document_id, documentName: docName(h.document_id), reason: h.reason, openedBy: h.opened_by_name, openedAt: h.opened_at, href: docHref(h.document_id) });
    }
    const scopeWhy = new Map<string, string>();
    for (const e of (pe.data as Array<{ a: string; b: string; summary: string }>) ?? []) if (e.a.startsWith("proj:")) scopeWhy.set(e.a.slice(5), e.summary);
    for (const id of projIds) {
      const p = projById.get(id);
      if (!p) continue;
      activity.projects.push({ id, name: p.name, status: p.status, why: scopeWhy.get(id) ?? "has these documents checked out", href: `/projects/${id}` });
    }
    if (projIds.size) {
      const { data: ms } = await admin.from("milestones").select("id, name, planned_at, status, project_id").eq("org_id", orgId).in("project_id", [...projIds].slice(0, 50)).neq("status", "done").order("planned_at", { ascending: true, nullsFirst: false }).limit(10);
      for (const m of (ms as Array<{ id: string; name: string; planned_at: string | null; status: string | null; project_id: string | null }> | null) ?? []) {
        activity.milestones.push({ id: m.id, name: m.name, plannedAt: m.planned_at, status: m.status, projectId: m.project_id, projectName: m.project_id ? projById.get(m.project_id)?.name ?? null : null, href: m.project_id ? `/projects/${m.project_id}?tab=schedule` : "/projects" });
      }
    }
  }

  // ── Coverage: how much of this scope has been read ─────────────────────
  const readCount = entries.filter((e) => e.read?.status === "ready").length;
  const unreadByFolder = new Map<string, { folderId: string | null; libraryId: string; path: string; count: number }>();
  for (const e of entries) {
    if (e.read?.status === "ready") continue;
    const key = e.folderId ?? `lib:${e.libraryId}`;
    const cur = unreadByFolder.get(key) ?? { folderId: e.folderId ?? null, libraryId: e.libraryId ?? "", path: [e.libraryName, ...e.path].filter(Boolean).join(" / "), count: 0 };
    cur.count++; unreadByFolder.set(key, cur);
  }
  const coverage: FindCoverage = {
    inScope: entries.length, read: readCount, unread: entries.length - readCount,
    unreadFolders: [...unreadByFolder.values()].sort((a, b) => b.count - a.count).slice(0, 5),
  };
  if (data.estateMissing) notes.push("Estate links are off until migration 20261020 is applied.");

  return { chips: q.chips, entities, results, hidden: hid.hidden, groups, activity, coverage, layers: [...new Set(layers)], notes, tookMs: Date.now() - t0 };
}
