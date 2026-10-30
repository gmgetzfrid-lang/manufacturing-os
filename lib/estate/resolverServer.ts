// lib/estate/resolverServer.ts — SERVER-ONLY. Run the resolver and record
// what it found, without ever overwriting a human.
//
// Loads the org's vocabulary once (codebook, aliases, projects, registry),
// walks folders top-down so children inherit what their parents just got,
// then documents, and upserts estate_edges:
//   provable  → status 'applied'
//   strong / inferred → status 'pending' (Review decides)
// Insert-only on conflict: a row that exists (applied, dismissed, or a human's)
// is left exactly as it was. Re-running is free and idempotent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebook, parseDrawingNumber } from "@/lib/codebook";
import { canonicalForm } from "@/lib/fileFinder/tagForms";
import type { FinderAlias } from "@/lib/fileFinder/aliasTypes";
import { resolveTarget, type ResolveContext, type ResolveTarget, type ProposedEdge } from "./resolver";
import { nid } from "./ids";

export interface ResolveRunInput {
  orgId: string;
  /** Resolve these folders (and nothing else) … */
  folderIds?: string[];
  /** … and/or these documents. */
  documentIds?: string[];
  /** Everything in these libraries. */
  libraryIds?: string[];
  /** Everything in the org (folders always; documents up to `docCap`). */
  all?: boolean;
  docCap?: number;
  /** With `all`/`libraryIds`: only documents created at or after this ISO time. */
  since?: string;
  actor?: { userId: string | null; name: string | null };
}

export interface ResolveRunResult {
  folders: number;
  documents: number;
  applied: number;
  pending: number;
  unchanged: number;
  notes: string[];
}

function aliasFromRow(r: Record<string, unknown>): FinderAlias {
  return {
    id: String(r.id), orgId: String(r.org_id), term: String(r.term), termCanonical: String(r.term_canonical),
    means: String(r.means), meansCanonical: String(r.means_canonical), kind: (r.kind as FinderAlias["kind"]) ?? "term",
    origin: (r.origin as FinderAlias["origin"]) ?? "human", hits: Number(r.hits ?? 0), misses: Number(r.misses ?? 0),
    note: (r.note as string | null) ?? null, createdByName: (r.created_by_name as string | null) ?? null, createdAt: String(r.created_at ?? ""),
  };
}

export async function loadResolveContext(admin: SupabaseClient, orgId: string): Promise<ResolveContext & { folders: Map<string, { id: string; libraryId: string; parentId: string | null; name: string }> }> {
  const [book, aliasesRes, projectsRes, assetsRes, foldersRes, edgesRes] = await Promise.all([
    loadCodebook(orgId, admin),
    admin.from("finder_aliases").select("*").eq("org_id", orgId),
    admin.from("projects").select("id, name").eq("org_id", orgId).limit(2000),
    admin.from("assets").select("id, tag").eq("org_id", orgId).limit(20000),
    admin.from("collections").select("*").eq("org_id", orgId),
    admin.from("estate_edges").select("a, b, type").eq("org_id", orgId).eq("status", "applied").in("type", ["belongs_to_unit", "in_project", "about_asset"]).like("a", "folder:%"),
  ]);
  const aliases = ((aliasesRes.data as Record<string, unknown>[] | null) ?? []).map(aliasFromRow);
  const projects = ((projectsRes.data as Array<{ id: string; name: string }> | null) ?? []);
  const assets = new Map<string, { id: string; tag: string }>();
  for (const a of (assetsRes.data as Array<{ id: string; tag: string }> | null) ?? []) assets.set(canonicalForm(a.tag), a);
  const folders = new Map<string, { id: string; libraryId: string; parentId: string | null; name: string }>();
  for (const c of (foldersRes.data as Record<string, unknown>[] | null) ?? []) {
    if (c.deleted_at) continue;
    folders.set(String(c.id), { id: String(c.id), libraryId: String(c.library_id), parentId: (c.parent_id as string | null) ?? null, name: String(c.name ?? "Folder") });
  }
  const folderUnits = new Map<string, string>();
  const folderProjects = new Map<string, string>();
  const folderAssets = new Map<string, string>();
  for (const e of (edgesRes.data as Array<{ a: string; b: string; type: string }> | null) ?? []) {
    const fid = e.a.slice("folder:".length);
    if (e.type === "belongs_to_unit" && e.b.startsWith("cbunit:")) folderUnits.set(fid, e.b.slice("cbunit:".length));
    if (e.type === "in_project" && e.b.startsWith("proj:")) folderProjects.set(fid, e.b.slice("proj:".length));
    if (e.type === "about_asset" && e.b.startsWith("asset:")) folderAssets.set(fid, e.b.slice("asset:".length));
  }
  return {
    units: book.units.map((u) => ({ code: u.code, label: u.label })),
    aliases, projects, assets, folderUnits, folderProjects, folderAssets, folders,
    unitFromDrawingNumber: (raw) => {
      const p = parseDrawingNumber(raw, book);
      return p?.unitCode ?? null;
    },
  };
}

function chainOf(folderId: string | null, folders: Map<string, { id: string; parentId: string | null; name: string }>): { names: string[]; ids: string[] } {
  const names: string[] = [], ids: string[] = [];
  const seen = new Set<string>();
  let cur = folderId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = folders.get(cur);
    if (!f) break;
    names.unshift(f.name); ids.unshift(f.id);
    cur = f.parentId;
  }
  return { names, ids };
}

export async function resolveEstate(admin: SupabaseClient, input: ResolveRunInput): Promise<ResolveRunResult> {
  const res: ResolveRunResult = { folders: 0, documents: 0, applied: 0, pending: 0, unchanged: 0, notes: [] };
  const ctx = await loadResolveContext(admin, input.orgId);
  if (!ctx.units.length) res.notes.push("No units in the Site Codebook - unit links need one.");

  const proposals: ProposedEdge[] = [];

  // ── Folders, parents before children ───────────────────────────────────
  let folderList = [...ctx.folders.values()];
  if (input.folderIds?.length) {
    const want = new Set(input.folderIds);
    folderList = folderList.filter((f) => want.has(f.id));
  } else if (input.libraryIds?.length) {
    const libs = new Set(input.libraryIds);
    folderList = folderList.filter((f) => libs.has(f.libraryId));
  } else if (!input.all && !input.documentIds?.length) {
    folderList = [];
  }
  const depth = (f: { id: string }) => chainOf(f.id, ctx.folders).ids.length;
  folderList.sort((a, b) => depth(a) - depth(b));
  for (const f of folderList) {
    const chain = chainOf(f.parentId, ctx.folders);
    const t: ResolveTarget = { kind: "folder", id: f.id, name: f.name, path: chain.names, pathIds: chain.ids };
    const edges = resolveTarget(t, ctx);
    for (const e of edges) {
      proposals.push(e);
      // Children in this same run inherit what their parent just got.
      if (e.tier === "provable" && e.a === nid.folder(f.id)) {
        if (e.type === "belongs_to_unit") ctx.folderUnits!.set(f.id, e.b.slice("cbunit:".length));
        if (e.type === "in_project") ctx.folderProjects!.set(f.id, e.b.slice("proj:".length));
      }
    }
    res.folders++;
  }

  // ── Documents ───────────────────────────────────────────────────────────
  type DocRow = { id: string; library_id: string; collection_id: string | null; name: string | null; title: string | null; document_number: string | null; current_version_id: string | null };
  let docs: DocRow[] = [];
  const sel = "id, library_id, collection_id, name, title, document_number, current_version_id";
  if (input.documentIds?.length) {
    for (let i = 0; i < input.documentIds.length; i += 200) {
      const { data } = await admin.from("documents").select(sel).eq("org_id", input.orgId).in("id", input.documentIds.slice(i, i + 200));
      docs.push(...((data as DocRow[] | null) ?? []));
    }
  } else if (input.libraryIds?.length || input.all) {
    let q = admin.from("documents").select(sel).eq("org_id", input.orgId).order("created_at", { ascending: false }).limit(input.docCap ?? 3000);
    if (input.libraryIds?.length) q = q.in("library_id", input.libraryIds);
    if (input.since) q = q.gte("created_at", input.since);
    const { data } = await q;
    docs = (data as DocRow[] | null) ?? [];
  }
  // Tags read off pages, through the knowledge mirror, for the docs we have.
  const pageTags = new Map<string, Set<string>>();
  if (docs.length) {
    const ids = docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: mirrors } = await admin.from("knowledge_documents").select("id, source_document_id").eq("org_id", input.orgId).in("source_document_id", ids.slice(i, i + 200));
      const m = (mirrors as Array<{ id: string; source_document_id: string }> | null) ?? [];
      if (!m.length) continue;
      const { data: ents } = await admin.from("knowledge_page_entities").select("document_id, tag").eq("org_id", input.orgId).eq("kind", "equipment").in("document_id", m.map((x) => x.id)).limit(20000);
      const byMirror = new Map(m.map((x) => [x.id, x.source_document_id]));
      for (const e of (ents as Array<{ document_id: string; tag: string }> | null) ?? []) {
        const docId = byMirror.get(e.document_id);
        if (!docId) continue;
        const set = pageTags.get(docId) ?? new Set<string>();
        set.add(e.tag);
        pageTags.set(docId, set);
      }
    }
  }
  for (const d of docs) {
    const chain = chainOf(d.collection_id, ctx.folders);
    const t: ResolveTarget = {
      kind: "document", id: d.id, name: d.name || d.document_number || d.title || "Untitled",
      path: chain.names, pathIds: chain.ids, documentNumber: d.document_number,
      pageTags: [...(pageTags.get(d.id) ?? [])], versionId: d.current_version_id,
    };
    proposals.push(...resolveTarget(t, ctx));
    res.documents++;
  }

  // ── Record, never overwrite ─────────────────────────────────────────────
  for (let i = 0; i < proposals.length; i += 200) {
    const rows = proposals.slice(i, i + 200).map((e) => ({
      org_id: input.orgId, a: e.a, b: e.b, type: e.type, origin: e.origin, tier: e.tier,
      confidence: e.confidence, status: e.tier === "provable" ? "applied" : "pending",
      summary: e.summary, evidence: e.evidence, version_id: e.versionId ?? null,
      created_by: input.actor?.userId ?? null, created_by_name: input.actor?.name ?? null,
    }));
    const { data, error } = await admin.from("estate_edges").upsert(rows, { onConflict: "org_id,a,b,type", ignoreDuplicates: true }).select("id, status");
    if (error) { res.notes.push(`estate_edges: ${error.message}`); break; }
    const inserted = (data as Array<{ status: string }> | null) ?? [];
    for (const r of inserted) { if (r.status === "applied") res.applied++; else res.pending++; }
    res.unchanged += rows.length - inserted.length;
  }
  return res;
}

/** The nightly heartbeat: every org's folders, plus documents from the last
 *  two days, bounded by a deadline so it can never eat the cron. */
export async function resolveAllOrgs(admin: SupabaseClient, opts: { deadlineMs: number }): Promise<{ orgs: number; applied: number; pending: number; errors: string[] }> {
  const out = { orgs: 0, applied: 0, pending: 0, errors: [] as string[] };
  const { data: orgs, error } = await admin.from("orgs").select("id").limit(500);
  if (error) { out.errors.push(error.message); return out; }
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  for (const o of (orgs as Array<{ id: string }> | null) ?? []) {
    if (Date.now() > opts.deadlineMs) { out.errors.push("deadline reached before every org was resolved"); break; }
    try {
      const r = await resolveEstate(admin, { orgId: o.id, all: true, since, docCap: 500 });
      out.orgs++; out.applied += r.applied; out.pending += r.pending;
    } catch (e) { out.errors.push(`${o.id}: ${(e as Error).message}`); }
  }
  return out;
}
