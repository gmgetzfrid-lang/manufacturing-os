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

/** Bump when the tag reader learns to see more: every read copy is read
 *  again once, so sheets read by an older reader catch up on their own. */
export const TAG_READER_VERSION = 2;

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
  /** The caller's AI key, as the reading uses it: vision for pages with no usable text layer. */
  ai: { hasKey: boolean; provider?: string; model?: string; visionAllPages: boolean };
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

async function ensureReadLibrary(admin: SupabaseClient, orgId: string, dcLibs: Array<{ id: string; name: string }>, actor: { userId: string; name: string | null }, opts: { visionAllPages?: boolean; rereadAll?: boolean }): Promise<{ libraryId: string; libraryName: string; created: boolean; removedDuplicate: boolean; sourcesAdded: number; sync: { added: number; refreshed: number; errors: string[] }; rereads: number }> {
  // A knowledge library a person already pointed at these drawings wins —
  // whether it watches the whole library or a folder inside it. A library
  // this button made earlier, when a person's own exists, is removed so
  // every sheet has one read copy, not two.
  const { data: srcRows } = await admin.from("knowledge_sources").select("library_id, source_id, source_type").eq("org_id", orgId).limit(2000);
  const sources = (srcRows as Array<{ library_id: string; source_id: string; source_type: string }> | null) ?? [];
  const dcIds = new Set(dcLibs.map((l) => l.id));
  const folderIds = sources.filter((s) => s.source_type === "folder").map((s) => s.source_id);
  const folderLib = new Map<string, string>();
  if (folderIds.length) {
    const { data: cols } = await admin.from("collections").select("id, library_id").in("id", folderIds);
    for (const c of (cols as Array<{ id: string; library_id: string }> | null) ?? []) folderLib.set(c.id, c.library_id);
  }
  const covers = (s: { source_id: string; source_type: string }) => (s.source_type === "library" ? dcIds.has(s.source_id) : dcIds.has(folderLib.get(s.source_id) ?? ""));
  const { data: existing } = await admin.from("knowledge_libraries").select("id, name, description").eq("org_id", orgId).limit(200);
  const libs = ((existing as Array<{ id: string; name: string; description: string | null }> | null) ?? []);
  const isAuto = (l: { name: string; description: string | null }) => /drawings — read by the estate/i.test(l.name) && /Made by Connect everything/.test(l.description ?? "");
  const covering = [...new Set(sources.filter(covers).map((s) => s.library_id))].map((id) => libs.find((l) => l.id === id)).filter((l): l is { id: string; name: string; description: string | null } => !!l);
  const own = covering.find((l) => !isAuto(l)) ?? null;
  const auto = libs.find(isAuto) ?? null;
  let libraryId: string | null = own?.id ?? auto?.id ?? null;
  let created = false;
  let removedDuplicate = false;
  if (own && auto && own.id !== auto.id) {
    // One read copy per sheet: the person's library stays, the made one goes.
    const { error } = await admin.from("knowledge_libraries").delete().eq("id", auto.id).eq("org_id", orgId);
    removedDuplicate = !error;
    libraryId = own.id;
  }
  if (!libraryId) {
    const { data: made, error } = await admin.from("knowledge_libraries").insert({
      org_id: orgId, name: "Drawings — read by the estate",
      description: "Every drawing library in Document Control, read once so searches can put units, equipment, sheets and photos together. Made by Connect everything.",
      created_by: actor.userId, created_by_name: actor.name, ai_features: { drawingIntel: true },
    }).select("id").single();
    if (error || !made) throw new Error(`Could not make the read library: ${error?.message ?? "unknown"}`);
    libraryId = String((made as { id: string }).id); created = true;
  }
  const libraryName = libs.find((l) => l.id === libraryId)?.name ?? "Drawings — read by the estate";
  // Drawing intelligence on, whichever library it is.
  const { data: libRow } = await admin.from("knowledge_libraries").select("ai_features").eq("id", libraryId).maybeSingle();
  const feats = ((libRow?.ai_features as Record<string, unknown> | null) ?? {});
  if (feats.drawingIntel !== true) await admin.from("knowledge_libraries").update({ ai_features: { ...feats, drawingIntel: true } }).eq("id", libraryId).then(() => undefined, () => undefined);
  // Sources: each drawing library, once.
  const watched = new Set<string>();
  for (const s of sources) {
    if (s.library_id !== libraryId) continue;
    if (s.source_type === "library") watched.add(s.source_id);
    else { const lib = folderLib.get(s.source_id); if (lib) watched.add(lib); }
  }
  let sourcesAdded = 0;
  for (const l of dcLibs) {
    if (watched.has(l.id)) continue;
    const { error } = await admin.from("knowledge_sources").insert({ org_id: orgId, library_id: libraryId, source_type: "library", source_id: l.id, source_name: l.name, created_by: actor.userId, created_by_name: actor.name });
    if (!error) sourcesAdded++;
  }
  const sync = await syncKnowledgeLibrarySources(libraryId);
  // Copies read with no equipment on any page: read before tags were
  // extracted, or read as prose. Each is re-read once (the ids already
  // re-read live on the library, so a sheet that truly has no tags is
  // never re-read in a loop). When the reader itself has improved, or the
  // person turned on reading every page with vision, every copy is read
  // again once.
  let rereads = 0;
  const readerBefore = Number(feats.tagReaderVersion ?? 0);
  const visionTurnedOn = !!opts.visionAllPages && feats.visionAllPages !== true;
  const readEverything = readerBefore < TAG_READER_VERSION || visionTurnedOn || !!opts.rereadAll;
  const already = new Set<string>(readEverything ? [] : (Array.isArray(feats.connectReread) ? (feats.connectReread as string[]) : []));
  const { data: ready } = await admin.from("knowledge_documents").select("id, pages_indexed").eq("library_id", libraryId).eq("status", "ready").gt("pages_indexed", 0).limit(3000);
  const ids = ((ready as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  const nextFeats: Record<string, unknown> = { ...feats, drawingIntel: true, tagReaderVersion: TAG_READER_VERSION };
  if (opts.visionAllPages !== undefined) nextFeats.visionAllPages = !!opts.visionAllPages;
  if (ids.length) {
    const withTags = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ents } = await admin.from("knowledge_page_entities").select("document_id").eq("org_id", orgId).eq("kind", "equipment").in("document_id", ids.slice(i, i + 200)).limit(20000);
      for (const e of (ents as Array<{ document_id: string }> | null) ?? []) withTags.add(e.document_id);
    }
    const stale = readEverything ? ids : ids.filter((id) => !withTags.has(id) && !already.has(id));
    for (let i = 0; i < stale.length; i += 200) {
      const slice = stale.slice(i, i + 200);
      await admin.from("knowledge_chunks").delete().in("document_id", slice).then(() => undefined, () => undefined);
      await admin.from("knowledge_page_entities").delete().in("document_id", slice).then(() => undefined, () => undefined);
      const { error } = await admin.from("knowledge_documents").update({ status: "stale", pages_indexed: 0, page_count: null, last_section: null, error: null }).in("id", slice);
      if (!error) { rereads += slice.length; for (const id of slice) already.add(id); }
    }
    nextFeats.connectReread = [...already].slice(-5000);
  }
  if (JSON.stringify(nextFeats) !== JSON.stringify(feats)) await admin.from("knowledge_libraries").update({ ai_features: nextFeats }).eq("id", libraryId).then(() => undefined, () => undefined);
  return { libraryId, libraryName, created, removedDuplicate, sourcesAdded, sync, rereads };
}

async function ensureBridge(admin: SupabaseClient, orgId: string, dcLibs: Array<{ id: string; name: string }>): Promise<void> {
  // Create assets on apply; a tags column is used when the library has one.
  const { data: rows } = await admin.from("libraries").select("id, equipment_bridge, custom_columns").in("id", dcLibs.map((l) => l.id));
  for (const r of (rows as Array<{ id: string; equipment_bridge: Record<string, unknown> | null; custom_columns: Array<{ key: string; type?: string; isPill?: boolean }> | null }> | null) ?? []) {
    const cur = r.equipment_bridge ?? {};
    const col = (r.custom_columns ?? []).find((c) => c.type === "tags" || c.type === "multi" || c.isPill);
    const next = { ...cur, createAssets: cur.createAssets ?? true, autoApply: cur.autoApply ?? true, targetColumnKey: cur.targetColumnKey ?? col?.key };
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

export async function connectEverything(admin: SupabaseClient, input: { orgId: string; libraryIds?: string[]; actor: { userId: string; name: string | null }; budgetMs?: number; visionAllPages?: boolean; rereadAll?: boolean }): Promise<ConnectStatus> {
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
  const r = await ensureReadLibrary(admin, orgId, dcLibs, input.actor, { visionAllPages: input.visionAllPages, rereadAll: input.rereadAll });
  const readBits = [`"${r.libraryName}" in Intelligence watches ${dcLibs.map((l) => l.name).join(", ")}`];
  if (r.created) readBits.push("read library made");
  if (r.removedDuplicate) readBits.push("a duplicate read library this button made earlier was removed");
  if (r.sourcesAdded) readBits.push(`${r.sourcesAdded} source${r.sourcesAdded === 1 ? "" : "s"} linked`);
  if (r.sync.added) readBits.push(`${r.sync.added} new to read`);
  if (r.sync.refreshed) readBits.push(`${r.sync.refreshed} revised, re-reading`);
  if (r.rereads) readBits.push(`${r.rereads} being read again (the tag reader improved, or vision was turned on)`);
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
  // The caller's AI key: the browser reads scanned or line-work pages with it.
  const { data: conn } = await admin.from("ai_connections").select("provider, model").eq("org_id", orgId).eq("user_id", input.actor.userId).maybeSingle();
  const { data: libNow } = await admin.from("knowledge_libraries").select("ai_features").eq("id", r.libraryId).maybeSingle();
  const ai = { hasKey: !!conn, provider: (conn as { provider?: string } | null)?.provider, model: (conn as { model?: string } | null)?.model, visionAllPages: ((libNow?.ai_features as Record<string, unknown> | null) ?? {}).visionAllPages === true };
  steps.push({
    key: "links", title: "Links", state: readiness.estateMissing ? "blocked" : "done",
    detail: readiness.estateMissing ? "migration 20261020 is not applied" : `${links.applied} new · ${links.pending} for Review · ${readiness.edges.applied} in place (${readiness.docsWithAsset} documents to equipment, ${readiness.docsWithUnit} to a unit)`,
  });

  return { steps, queuedIds: queued.slice(0, 30).map((q) => q.id), queued: queued.length, more: queued.length > 0 || reg.left > 0, readiness, libraries: dcLibs, ai };
}

/** The nightly pass: every drawing-set library's freshly read copies feed
 *  the registry, bounded by a deadline. New sheets label themselves without
 *  anyone pressing anything. */
export async function registryAllOrgs(admin: SupabaseClient, opts: { deadlineMs: number }): Promise<{ libraries: number; applied: number; assets: number; errors: string[] }> {
  const out = { libraries: 0, applied: 0, assets: 0, errors: [] as string[] };
  const { data: libs, error } = await admin.from("knowledge_libraries").select("id, org_id, ai_features").limit(500);
  if (error) { out.errors.push(error.message); return out; }
  for (const l of (libs as Array<{ id: string; org_id: string; ai_features: Record<string, unknown> | null }> | null) ?? []) {
    if (Date.now() > opts.deadlineMs) break;
    if ((l.ai_features ?? {}).drawingIntel !== true) continue;
    try {
      const r = await buildRegistry(admin, l.org_id, l.id, "00000000-0000-0000-0000-000000000000", opts.deadlineMs);
      out.libraries++; out.applied += r.applied; out.assets += r.assets;
    } catch (e) { out.errors.push(`${l.id}: ${(e as Error).message}`); }
  }
  return out;
}
