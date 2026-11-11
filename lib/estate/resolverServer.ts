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
//
// One exception, and only for links the machine applied by itself: each run
// checks them again (lib/estate/settle). One the rules no longer prove steps
// down to pending or is taken away. A person's link is never touched.

import { readCallout, decodeId } from "@/lib/equipmentSweep";
import { idKey } from "@/lib/equipmentPick";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebook, parseDrawingNumber } from "@/lib/codebook";
import { canonicalForm } from "@/lib/fileFinder/tagForms";
import type { FinderAlias } from "@/lib/fileFinder/aliasTypes";
import { resolveTarget, type ResolveContext, type ResolveTarget, type ProposedEdge } from "./resolver";
import { nid } from "./ids";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { folderUnitsFrom, settleStored, type StoredEdge } from "./settle";

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
  /** What the machine recorded earlier, checked again (lib/estate/settle):
   *  applied links stepped down to pending (demoted); links and questions
   *  with nothing behind them any more, or on folders and files that no
   *  longer exist, taken away (removed). */
  demoted: number;
  removed: number;
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

export async function loadResolveContext(admin: SupabaseClient, orgId: string): Promise<ResolveContext & { folders: Map<string, { id: string; libraryId: string; parentId: string | null; name: string }>; folderUnitByPerson: Set<string> }> {
  const [book, aliasesRes, projectsRes, assetsRes, foldersRes, edgesRes] = await Promise.all([
    loadCodebook(orgId, admin),
    admin.from("finder_aliases").select("*").eq("org_id", orgId),
    admin.from("projects").select("id, name").eq("org_id", orgId).limit(2000),
    admin.from("assets").select("id, tag, code, unit_code").eq("org_id", orgId).limit(20000),
    admin.from("collections").select("*").eq("org_id", orgId),
    // Every applied folder link, paged: a single read stops at 1,000 rows without saying so.
    fetchAllRows<{ a: string; b: string; type: string; origin: string | null }>((from, to) => admin.from("estate_edges").select("a, b, type, origin").eq("org_id", orgId).eq("status", "applied")
      .in("type", ["belongs_to_unit", "in_project", "about_asset"]).like("a", "folder:%").order("id").range(from, to)),
  ]);
  const aliases = ((aliasesRes.data as Record<string, unknown>[] | null) ?? []).map(aliasFromRow);
  const projects = ((projectsRes.data as Array<{ id: string; name: string }> | null) ?? []);
  const assets = new Map<string, { id: string; tag: string }>();
  const assetsByCode = new Map<string, { id: string; tag: string }>();
  const assetsByName = new Map<string, Array<{ id: string; tag: string; unitCode: string | null }>>();
  for (const a of (assetsRes.data as Array<{ id: string; tag: string; code: string | null; unit_code: string | null }> | null) ?? []) {
    assets.set(canonicalForm(a.tag), a);
    if (a.code && idKey(a.code)) assetsByCode.set(idKey(a.code), a);
    const k = canonicalForm(a.tag.replace(/\s*\(.*$/, ""));
    assetsByName.set(k, [...(assetsByName.get(k) ?? []), { id: a.id, tag: a.tag, unitCode: a.unit_code }]);
  }
  const folders = new Map<string, { id: string; libraryId: string; parentId: string | null; name: string }>();
  for (const c of (foldersRes.data as Record<string, unknown>[] | null) ?? []) {
    if (c.deleted_at) continue;
    folders.set(String(c.id), { id: String(c.id), libraryId: String(c.library_id), parentId: (c.parent_id as string | null) ?? null, name: String(c.name ?? "Folder") });
  }
  const edgeRows = edgesRes.rows;
  // A folder's unit: a person's link first, never whichever row came last.
  const { units: folderUnits, byPerson: folderUnitByPerson } = folderUnitsFrom(edgeRows);
  const folderProjects = new Map<string, string>();
  const folderAssets = new Map<string, string>();
  for (const e of edgeRows) {
    const fid = e.a.slice("folder:".length);
    if (e.type === "in_project" && e.b.startsWith("proj:")) folderProjects.set(fid, e.b.slice("proj:".length));
    if (e.type === "about_asset" && e.b.startsWith("asset:")) folderAssets.set(fid, e.b.slice("asset:".length));
  }
  return {
    units: book.units.map((u) => ({ code: u.code, label: u.label })),
    aliases, projects, assets, assetsByCode, assetsByName, book, folderUnits, folderProjects, folderAssets, folders, folderUnitByPerson,
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
  const res: ResolveRunResult = { folders: 0, documents: 0, applied: 0, pending: 0, unchanged: 0, demoted: 0, removed: 0, notes: [] };
  const ctx = await loadResolveContext(admin, input.orgId);
  if (!ctx.units.length) res.notes.push("No units in the Site Codebook - unit links need one.");

  const proposals: ProposedEdge[] = [];

  // ── Folders, parents before children ───────────────────────────────────
  // Every folder is worked through, so what passes down to a child is what
  // stands today: a person's link, or one the rules prove now. Only the
  // folders asked for are recorded.
  let inRun: Set<string> | null = null; // null: every folder
  if (input.folderIds?.length) inRun = new Set(input.folderIds);
  else if (input.libraryIds?.length) { const libs = new Set(input.libraryIds); inRun = new Set([...ctx.folders.values()].filter((f) => libs.has(f.libraryId)).map((f) => f.id)); }
  else if (!input.all) inRun = new Set();
  const resolved = new Set<string>();
  const folderList = [...ctx.folders.values()];
  const depth = (f: { id: string }) => chainOf(f.id, ctx.folders).ids.length;
  folderList.sort((a, b) => depth(a) - depth(b));
  for (const f of folderList) {
    const chain = chainOf(f.parentId, ctx.folders);
    const t: ResolveTarget = { kind: "folder", id: f.id, name: f.name, path: chain.names, pathIds: chain.ids };
    const edges = resolveTarget(t, ctx);
    const record = !inRun || inRun.has(f.id);
    const self = nid.folder(f.id);
    if (record) { proposals.push(...edges); resolved.add(self); res.folders++; }
    // What this folder passes down: a person's link stands; otherwise only
    // what is proven now (a link worked out earlier and no longer proven
    // passes nothing down).
    if (!ctx.folderUnitByPerson.has(f.id)) {
      const proven = edges.find((e) => e.a === self && e.type === "belongs_to_unit" && e.tier === "provable");
      if (proven) ctx.folderUnits!.set(f.id, proven.b.slice("cbunit:".length)); else ctx.folderUnits!.delete(f.id);
    }
    const proj = edges.find((e) => e.a === self && e.type === "in_project" && e.tier === "provable");
    if (proj && record) ctx.folderProjects!.set(f.id, proj.b.slice("proj:".length));
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
  // The ID printed beside each tag, and the unit those IDs say.
  const pageCodes = new Map<string, Record<string, string>>();
  const pageUnits = new Map<string, Map<string, number>>();
  if (docs.length) {
    const ids = docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data: mirrors } = await admin.from("knowledge_documents").select("id, source_document_id").eq("org_id", input.orgId).in("source_document_id", ids.slice(i, i + 200));
      const m = (mirrors as Array<{ id: string; source_document_id: string }> | null) ?? [];
      if (!m.length) continue;
      const { data: ents } = await admin.from("knowledge_page_entities").select("document_id, tag, raw").eq("org_id", input.orgId).eq("kind", "equipment").in("document_id", m.map((x) => x.id)).limit(20000);
      const byMirror = new Map(m.map((x) => [x.id, x.source_document_id]));
      for (const e of (ents as Array<{ document_id: string; tag: string; raw: string | null }> | null) ?? []) {
        const docId = byMirror.get(e.document_id);
        if (!docId) continue;
        const set = pageTags.get(docId) ?? new Set<string>();
        set.add(e.tag);
        pageTags.set(docId, set);
        const code = readCallout(e.tag, e.raw).code;
        if (code) {
          pageCodes.set(docId, { ...(pageCodes.get(docId) ?? {}), [e.tag]: idKey(code) });
          const u = decodeId(code, ctx.book!)?.unitCode;
          if (u) { const c = pageUnits.get(docId) ?? new Map<string, number>(); c.set(u, (c.get(u) ?? 0) + 1); pageUnits.set(docId, c); }
        }
      }
    }
  }
  for (const d of docs) {
    const chain = chainOf(d.collection_id, ctx.folders);
    const t: ResolveTarget = {
      kind: "document", id: d.id, name: d.name || d.document_number || d.title || "Untitled",
      path: chain.names, pathIds: chain.ids, documentNumber: d.document_number,
      pageTags: [...(pageTags.get(d.id) ?? [])], versionId: d.current_version_id,
      pageCodes: pageCodes.get(d.id), pageUnit: [...(pageUnits.get(d.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    };
    proposals.push(...resolveTarget(t, ctx));
    resolved.add(nid.doc(d.id));
    res.documents++;
  }

  // ── What the machine recorded earlier, checked again ────────────────────
  // Before recording: one that steps down must not block today's proposal.
  type Row = { id: string; a: string; b: string; type: string; origin: string | null; status: string; decided_by: string | null; evidence: Record<string, unknown> | null };
  const toStored = (r: Row): StoredEdge => ({ id: r.id, a: r.a, b: r.b, type: r.type, origin: r.origin ?? "resolver", status: r.status, decidedBy: r.decided_by, evidence: r.evidence });
  const stored: StoredEdge[] = [];
  const gone = new Set<string>();
  let readOk = true;
  const cols = "id, a, b, type, origin, status, decided_by, evidence";
  if (input.all) {
    // The whole organization: every recorded link, so the ones on folders
    // and files that no longer exist are found too.
    const all = await fetchAllRows<Row>((from, to) => admin.from("estate_edges").select(cols).eq("org_id", input.orgId).in("status", ["applied", "pending"]).order("id").range(from, to));
    if (all.error) { res.notes.push(`estate_edges: ${all.error}`); readOk = false; }
    else stored.push(...all.rows.map(toStored));
    if (readOk) {
      const docIds = new Set<string>();
      for (const e of stored) for (const n of [e.a, e.b, typeof e.evidence?.folder === "string" ? e.evidence.folder : ""]) {
        if (n.startsWith("folder:") && !ctx.folders.has(n.slice(7))) gone.add(n);
        if (n.startsWith("doc:") && !resolved.has(n)) docIds.add(n.slice(4));
      }
      // A file this run did not load (older than `since`, past the cap) is
      // asked for by id: only one the database no longer has is gone.
      const ids = [...docIds], found = new Set<string>();
      for (let i = 0; i < ids.length && readOk; i += 150) {
        const { data, error } = await admin.from("documents").select("id").eq("org_id", input.orgId).in("id", ids.slice(i, i + 150));
        if (error) { res.notes.push(`documents: ${error.message}`); readOk = false; break; }
        for (const d of (data as Array<{ id: string }> | null) ?? []) found.add(d.id);
      }
      if (readOk) for (const id of ids) if (!found.has(id)) gone.add(`doc:${id}`); else gone.delete(`doc:${id}`);
      else gone.clear();
    }
  } else {
    const targets = [...resolved];
    for (let i = 0; i < targets.length; i += 80) {
      const { data, error } = await admin.from("estate_edges").select(cols).eq("org_id", input.orgId)
        .eq("type", "belongs_to_unit").in("status", ["applied", "pending"]).in("a", targets.slice(i, i + 80));
      if (error) { res.notes.push(`estate_edges: ${error.message}`); readOk = false; break; }
      stored.push(...((data as Row[] | null) ?? []).map(toStored));
    }
  }
  // Nothing is stepped down or taken away on a partial read.
  const settle = readOk ? settleStored(stored, proposals, resolved, gone) : { demote: [], promote: [], remove: [], gone: [] };
  for (const d of settle.demote) {
    const { error } = await admin.from("estate_edges").update({ status: "pending", tier: d.tier, confidence: d.confidence, summary: d.summary, origin: d.origin, evidence: d.evidence }).eq("id", d.id).eq("org_id", input.orgId);
    if (error) { res.notes.push(`estate_edges: ${error.message}`); break; }
    res.demoted++;
  }
  for (const d of settle.promote) {
    const { error } = await admin.from("estate_edges").update({ status: "applied", tier: "provable", confidence: 1, summary: d.summary, origin: d.origin, evidence: d.evidence }).eq("id", d.id).eq("org_id", input.orgId);
    if (error) { res.notes.push(`estate_edges: ${error.message}`); break; }
    res.applied++;
  }
  const drop = [...settle.remove, ...settle.gone];
  for (let i = 0; i < drop.length; i += 80) {
    const { error } = await admin.from("estate_edges").delete().eq("org_id", input.orgId).in("id", drop.slice(i, i + 80));
    if (error) { res.notes.push(`estate_edges: ${error.message}`); break; }
    res.removed += drop.slice(i, i + 80).length;
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
