// lib/estate/connectServer.ts — "Connect everything", one pass.
//
// The estate used to need seven screens of setup before a search could put
// a unit, its equipment, the sheets and the photos together. This runs the
// same steps server-side with sensible defaults, idempotently, in one call
// bounded by a deadline — the button calls it again until nothing is left
// in flight:
//
//   1. units       — none in the codebook? read them off folder names and
//                    drawing numbers ("Unit 10", "U-20") and add them,
//                    marked imported so they can be renamed.
//   2. read        — a knowledge library that watches the drawing libraries
//                    (created if missing, drawing intelligence on), sources
//                    linked, sync run. Old read copies with no tags are
//                    marked for one re-read.
//   3. index       — drain what the server can (text layer); the rest is
//                    handed back as ids for the browser to read with the
//                    caller's AI key, three at a time.
//   4. registry    — every read drawing: tags → suggestions → applied
//                    (registry items created, filed under their unit).
//   5. links       — the resolver over everything.
//
// Nothing here overwrites a human decision: units are only added when
// there are none, sources only added when missing, suggestions only
// applied where none were applied before, edges insert-only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { syncKnowledgeLibrarySources } from "@/lib/knowledgeSourceSync";
import { drainKnowledgeIngestQueue } from "@/lib/knowledgeIngest";
import { computeForKnowledgeDoc, applyForDocument } from "@/lib/equipmentBridgeServer";
import { resolveEstate } from "./resolverServer";
import { computeReadiness, type EstateReadiness } from "./readinessServer";

export interface ConnectStep { key: "units" | "read" | "index" | "registry" | "links"; title: string; state: "done" | "working" | "waiting" | "blocked"; detail: string }
export interface ConnectStatus {
  steps: ConnectStep[];
  /** Read copies still to be indexed; the browser drives these with the caller's key. */
  queuedIds: string[];
  queued: number;
  /** True while another call is needed to finish. */
  more: boolean;
  readiness: EstateReadiness;
  libraries: Array<{ id: string; name: string }>;
}

const UNIT_IN_NAME = /(?:^|[^A-Z0-9])(?:UNIT|U)[\s\-_]?(\d{1,3})(?![0-9])/i;

async function ensureUnits(admin: SupabaseClient, orgId: string, actor: string | null): Promise<{ had: number; added: string[] }> {
  const book = await loadCodebookAdmin(admin, orgId);
  if (book.units.length) return { had: book.units.length, added: [] };
  const found = new Map<string, number>();
  const { data: folders } = await admin.from("collections").select("name").eq("org_id", orgId).is("deleted_at", null).limit(5000);
  for (const f of (folders as Array<{ name: string }> | null) ?? []) {
    const m = String(f.name ?? "").match(UNIT_IN_NAME);
    if (m) found.set(m[1], (found.get(m[1]) ?? 0) + 3);
  }
  const { data: docs } = await admin.from("documents").select("name, document_number").eq("org_id", orgId).limit(5000);
  for (const d of (docs as Array<{ name: string | null; document_number: string | null }> | null) ?? []) {
    for (const v of [d.name, d.document_number]) {
      const m = String(v ?? "").match(UNIT_IN_NAME);
      if (m) found.set(m[1], (found.get(m[1]) ?? 0) + 1);
    }
  }
  // A unit named once in a file name is noise; twice in folders or a handful of files is a unit.
  const codes = [...found.entries()].filter(([, n]) => n >= 3).map(([c]) => c).sort((a, b) => Number(a) - Number(b)).slice(0, 40);
  if (!codes.length) return { had: 0, added: [] };
  const rows = codes.map((code, i) => ({ org_id: orgId, kind: "unit", code, label: `Unit ${code}`, meta: {}, sort: i, origin: "import", created_by: actor }));
  const { error } = await admin.from("codebook_entries").insert(rows);
  if (error) return { had: 0, added: [] };
  return { had: 0, added: codes };
}

function looksLikeDrawings(name: string): boolean { return /draw|p&id|p&amp;id|pid|iso|dwg|diagram|schematic|loop/i.test(name); }

async function ensureReadLibrary(admin: SupabaseClient, orgId: string, dcLibs: Array<{ id: string; name: string }>, actor: { userId: string; name: string | null }): Promise<{ libraryId: string; created: boolean; sourcesAdded: number; sync: { added: number; refreshed: number; errors: string[] }; rereads: number }> {
  // A knowledge library already watching any of these DC libraries wins;
  // else one is made for the purpose.
  const { data: srcRows } = await admin.from("knowledge_sources").select("library_id, source_id, source_type").eq("org_id", orgId).limit(2000);
  const sources = (srcRows as Array<{ library_id: string; source_id: string; source_type: string }> | null) ?? [];
  const dcIds = new Set(dcLibs.map((l) => l.id));
  let libraryId = sources.find((s) => s.source_type === "library" && dcIds.has(s.source_id))?.library_id ?? null;
  let created = false;
  if (!libraryId) {
    const { data: existing } = await admin.from("knowledge_libraries").select("id, name").eq("org_id", orgId).limit(100);
    const named = ((existing as Array<{ id: string; name: string }> | null) ?? []).find((l) => /drawings — read by the estate/i.test(l.name));
    if (named) libraryId = named.id;
    else {
      const { data: made, error } = await admin.from("knowledge_libraries").insert({
        org_id: orgId, name: "Drawings — read by the estate",
        description: "Every drawing library in Document Control, read once so searches can put units, equipment, sheets and photos together. Made by Connect everything.",
        created_by: actor.userId, created_by_name: actor.name, ai_features: { drawingIntel: true },
      }).select("id").single();
      if (error || !made) throw new Error(`Could not make the read library: ${error?.message ?? "unknown"}`);
      libraryId = String((made as { id: string }).id); created = true;
    }
  }
  // Drawing intelligence on, whichever library it is.
  const { data: libRow } = await admin.from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const feats = ((libRow?.ai_features as Record<string, unknown> | null) ?? {});
  if (feats.drawingIntel !== true) await admin.from("knowledge_libraries").update({ ai_features: { ...feats, drawingIntel: true } }).eq("id", libraryId).then(() => undefined, () => undefined);
  // Sources: each drawing library, once.
  const have = new Set(sources.filter((s) => s.library_id === libraryId).map((s) => s.source_id));
  let sourcesAdded = 0;
  for (const l of dcLibs) {
    if (have.has(l.id)) continue;
    const { error } = await admin.from("knowledge_sources").insert({ org_id: orgId, library_id: libraryId, source_type: "library", source_id: l.id, source_name: l.name, created_by: actor.userId, created_by_name: actor.name });
    if (!error) sourcesAdded++;
  }
  const sync = await syncKnowledgeLibrarySources(libraryId);
  // Copies read with no equipment on any page: read before tags were
  // extracted, or read as prose. Each is re-read once (the ids already
  // re-read live on the library, so a sheet that truly has no tags is
  // never re-read in a loop).
  let rereads = 0;
  const already = new Set<string>(Array.isArray(feats.connectReread) ? (feats.connectReread as string[]) : []);
  const { data: ready } = await admin.from("knowledge_documents").select("id, pages_indexed").eq("library_id", libraryId).eq("status", "ready").gt("pages_indexed", 0).limit(3000);
  const ids = ((ready as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  if (ids.length) {
    const withTags = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ents } = await admin.from("knowledge_page_entities").select("document_id").eq("org_id", orgId).eq("kind", "equipment").in("document_id", ids.slice(i, i + 200)).limit(20000);
      for (const e of (ents as Array<{ document_id: string }> | null) ?? []) withTags.add(e.document_id);
    }
    const stale = ids.filter((id) => !withTags.has(id) && !already.has(id));
    for (let i = 0; i < stale.length; i += 200) {
      const slice = stale.slice(i, i + 200);
      await admin.from("knowledge_chunks").delete().in("document_id", slice).then(() => undefined, () => undefined);
      await admin.from("knowledge_page_entities").delete().in("document_id", slice).then(() => undefined, () => undefined);
      const { error } = await admin.from("knowledge_documents").update({ status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null }).in("id", slice);
      if (!error) { rereads += slice.length; for (const id of slice) already.add(id); }
    }
    if (stale.length) await admin.from("knowledge_libraries").update({ ai_features: { ...feats, drawingIntel: true, connectReread: [...already].slice(-5000) } }).eq("id", libraryId).then(() => undefined, () => undefined);
  }
  return { libraryId, created, sourcesAdded, sync, rereads };
}

async function ensureBridge(admin: SupabaseClient, orgId: string, dcLibs: Array<{ id: string; name: string }>): Promise<void> {
  // Create assets on apply; a tags column is used when the library has one.
  const { data: rows } = await admin.from("libraries").select("id, equipment_bridge, custom_columns").in("id", dcLibs.map((l) => l.id));
  for (const r of (rows as Array<{ id: string; equipment_bridge: Record<string, unknown> | null; custom_columns: Array<{ key: string; type?: string; isPill?: boolean }> | null }> | null) ?? []) {
    const cur = r.equipment_bridge ?? {};
    const col = (r.custom_columns ?? []).find((c) => c.type === "tags" || c.type === "multi" || c.isPill);
    const next = { ...cur, createAssets: cur.createAssets ?? true, targetColumnKey: cur.targetColumnKey ?? col?.key };
    if (JSON.stringify(next) !== JSON.stringify(cur)) await admin.from("libraries").update({ equipment_bridge: next }).eq("id", r.id).then(() => undefined, () => undefined);
  }
}

async function buildRegistry(admin: SupabaseClient, orgId: string, libraryId: string, actor: string, deadline: number): Promise<{ drawings: number; applied: number; assets: number; left: number }> {
  const out = { drawings: 0, applied: 0, assets: 0, left: 0 };
  const { data: ready } = await admin.from("knowledge_documents").select("id, source_document_id").eq("library_id", libraryId).eq("status", "ready").not("source_document_id", "is", null).limit(3000);
  const mirrors = (ready as Array<{ id: string; source_document_id: string }> | null) ?? [];
  if (!mirrors.length) return out;
  const docIds = mirrors.map((m) => m.source_document_id);
  const done = new Set<string>();
  for (let i = 0; i < docIds.length; i += 200) {
    const { data: sug } = await admin.from("document_equipment_suggestions").select("document_id, status").eq("org_id", orgId).in("document_id", docIds.slice(i, i + 200));
    for (const s of (sug as Array<{ document_id: string; status: string }> | null) ?? []) if (s.status === "applied") done.add(s.document_id);
  }
  const todo = mirrors.filter((m) => !done.has(m.source_document_id));
  for (const m of todo) {
    if (Date.now() > deadline) break;
    try {
      const c = await computeForKnowledgeDoc(admin, m.id);
      out.drawings++;
      if (!c || !c.suggestions.length) { done.add(m.source_document_id); continue; }
      const r = await applyForDocument(admin, { orgId, documentId: m.source_document_id, userId: actor });
      out.applied++; out.assets += r.createdAssets; done.add(m.source_document_id);
    } catch { /* one bad drawing never stops the pass */ }
  }
  out.left = mirrors.filter((m) => !done.has(m.source_document_id)).length;
  return out;
}

export async function connectEverything(admin: SupabaseClient, input: { orgId: string; libraryIds?: string[]; actor: { userId: string; name: string | null }; budgetMs?: number }): Promise<ConnectStatus> {
  const deadline = Date.now() + (input.budgetMs ?? 40_000);
  const steps: ConnectStep[] = [];
  const { orgId } = input;

  // Which Document Control libraries hold drawings.
  const { data: libRows } = await admin.from("libraries").select("id, name").eq("org_id", orgId).limit(200);
  const all = ((libRows as Array<{ id: string; name: string }> | null) ?? []);
  let dcLibs = input.libraryIds?.length ? all.filter((l) => input.libraryIds!.includes(l.id)) : all.filter((l) => looksLikeDrawings(l.name));
  if (!dcLibs.length) dcLibs = all;

  // 1. Units.
  const u = await ensureUnits(admin, orgId, input.actor.userId);
  steps.push(u.had > 0
    ? { key: "units", title: "Units", state: "done", detail: `${u.had} in the codebook` }
    : u.added.length
      ? { key: "units", title: "Units", state: "done", detail: `none were taught, so ${u.added.length} were read off your folder and drawing names: ${u.added.map((c) => `Unit ${c}`).join(", ")}. Rename them any time in the Site codebook.` }
      : { key: "units", title: "Units", state: "blocked", detail: "none in the codebook and none readable from folder or drawing names. Add one in Admin › Site codebook › Units and press the button again." });

  // 2. Read library + sources + sync.
  const r = await ensureReadLibrary(admin, orgId, dcLibs, input.actor);
  const readBits = [`watching ${dcLibs.map((l) => l.name).join(", ")}`];
  if (r.created) readBits.push("read library made");
  if (r.sourcesAdded) readBits.push(`${r.sourcesAdded} source${r.sourcesAdded === 1 ? "" : "s"} linked`);
  if (r.sync.added) readBits.push(`${r.sync.added} new to read`);
  if (r.sync.refreshed) readBits.push(`${r.sync.refreshed} revised, re-reading`);
  if (r.rereads) readBits.push(`${r.rereads} read before tags existed, re-reading`);
  if (r.sync.errors.length) readBits.push(r.sync.errors[0]);
  steps.push({ key: "read", title: "Drawings watched", state: "done", detail: readBits.join(" · ") });

  // 3. Index: server drains the text layer within the budget; the rest goes to the browser.
  const drained = Date.now() < deadline ? await drainKnowledgeIngestQueue({ maxPages: 150, deadlineMs: Math.min(deadline, Date.now() + 20_000) }).catch(() => ({ docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] as string[] })) : { docsTouched: 0, pagesIndexed: 0, completed: 0, errors: [] as string[] };
  const { data: queuedRows } = await admin.from("knowledge_documents").select("id, status").eq("library_id", r.libraryId).in("status", ["pending", "stale", "indexing"]).order("created_at", { ascending: true }).limit(500);
  const queued = (queuedRows as Array<{ id: string }> | null) ?? [];
  const { count: readyCount } = await admin.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("library_id", r.libraryId).eq("status", "ready");
  const { count: errCount } = await admin.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("library_id", r.libraryId).eq("status", "error");
  // How many read copies actually carry equipment tags — the number the
  // registry step lives on.
  const { data: readyIds } = await admin.from("knowledge_documents").select("id").eq("library_id", r.libraryId).eq("status", "ready").limit(3000);
  const rids = ((readyIds as Array<{ id: string }> | null) ?? []).map((x) => x.id);
  const tagged = new Set<string>();
  for (let i = 0; i < rids.length; i += 200) {
    const { data: ents } = await admin.from("knowledge_page_entities").select("document_id").eq("org_id", orgId).eq("kind", "equipment").in("document_id", rids.slice(i, i + 200)).limit(20000);
    for (const e of (ents as Array<{ document_id: string }> | null) ?? []) tagged.add(e.document_id);
  }
  const untagged = rids.length - tagged.size;
  steps.push({
    key: "index", title: "Drawings read", state: queued.length ? "working" : untagged > 0 && tagged.size === 0 ? "blocked" : "done",
    detail: `${readyCount ?? 0} read · ${tagged.size} with equipment tags on their pages${untagged ? ` · ${untagged} with none${queued.length ? "" : " (scanned images need your AI key under AI settings to be read)"}` : ""}${queued.length ? ` · ${queued.length} still to read${drained.pagesIndexed ? ` (${drained.pagesIndexed} pages just now)` : ""}` : ""}${errCount ? ` · ${errCount} could not be read` : ""}`,
  });

  // 4. Registry from the read drawings.
  await ensureBridge(admin, orgId, dcLibs);
  const reg = Date.now() < deadline ? await buildRegistry(admin, orgId, r.libraryId, input.actor.userId, deadline) : { drawings: 0, applied: 0, assets: 0, left: 0 };
  steps.push({
    key: "registry", title: "Equipment registry", state: reg.left ? "working" : queued.length ? "waiting" : "done",
    detail: `${reg.applied} drawing${reg.applied === 1 ? "" : "s"} tagged just now · ${reg.assets} new item${reg.assets === 1 ? "" : "s"}${reg.left ? ` · ${reg.left} drawings to go` : ""}${queued.length ? " · more once the reading finishes" : ""}`,
  });

  // 5. Links.
  let links = { applied: 0, pending: 0, unchanged: 0 };
  if (Date.now() < deadline) {
    try { const l = await resolveEstate(admin, { orgId, all: true, actor: input.actor }); links = { applied: l.applied, pending: l.pending, unchanged: l.unchanged }; } catch { /* reported by readiness */ }
  }
  const readiness = await computeReadiness(admin, orgId);
  steps.push({
    key: "links", title: "Links", state: readiness.estateMissing ? "blocked" : "done",
    detail: readiness.estateMissing ? "migration 20261020 is not applied" : `${links.applied} new · ${links.pending} for Review · ${readiness.edges.applied} in place (${readiness.docsWithAsset} documents to equipment, ${readiness.docsWithUnit} to a unit)`,
  });

  return { steps, queuedIds: queued.slice(0, 30).map((q) => q.id), queued: queued.length, more: queued.length > 0 || reg.left > 0, readiness, libraries: dcLibs };
}
