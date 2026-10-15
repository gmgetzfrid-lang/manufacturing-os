// lib/estate/folderMarksServer.ts — SERVER-ONLY. Mark what a folder stands
// for, and set up a whole equipment library level by level.
//
// Marks are estate edges a person made (origin "human", applied):
//   area      folder → cbunit:CODE   belongs_to_unit
//   type      folder → eqtype:LABEL  of_type
//   equipment folder → asset:ID      about_asset
// The org graph already carries a folder's unit and equipment down to every
// document filed under it. Marking also files the equipment itself: under
// the nearest marked area (unit_code) and type (asset type, set by a person).

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadResolveContext } from "./resolverServer";
import { unitFromName } from "./resolver";
import { canonicalForm } from "@/lib/fileFinder/tagForms";
import { equipmentFromFolderName, eqtypeId, planStructure, type FolderMarkState, type LevelMeaning, type MarkKind, type PlanRow } from "./folderMarks";

export type FolderMark =
  | { kind: "area"; unitCode: string }
  | { kind: "type"; label: string }
  | { kind: "equipment"; tag: string; name?: string | null }
  | { kind: "clear"; which?: MarkKind };

const EDGE_OF: Record<MarkKind, string> = { area: "belongs_to_unit", type: "of_type", equipment: "about_asset" };
const assetNorm = (tag: string) => tag.toLowerCase().replace(/[^a-z0-9]+/g, "");
type Actor = { userId: string; name: string | null };
type Folder = { id: string; libraryId: string; parentId: string | null; name: string };

async function markEdges(admin: SupabaseClient, orgId: string, folderIds: string[]): Promise<Map<string, FolderMarkState>> {
  const out = new Map<string, FolderMarkState>();
  if (!folderIds.length) return out;
  const { data } = await admin.from("estate_edges").select("a, b, type").eq("org_id", orgId).eq("status", "applied")
    .in("a", folderIds.map((f) => `folder:${f}`)).in("type", Object.values(EDGE_OF));
  const assetIds = new Set<string>();
  const rows = (data as Array<{ a: string; b: string; type: string }> | null) ?? [];
  for (const r of rows) if (r.type === "about_asset") assetIds.add(r.b.slice(6));
  const tags = new Map<string, string>();
  if (assetIds.size) {
    const { data: as } = await admin.from("assets").select("id, tag").in("id", [...assetIds]);
    for (const a of (as as Array<{ id: string; tag: string }> | null) ?? []) tags.set(a.id, a.tag);
  }
  for (const r of rows) {
    const fid = r.a.slice(7);
    const s = out.get(fid) ?? {};
    if (r.type === "belongs_to_unit" && r.b.startsWith("cbunit:")) s.area = { code: r.b.slice(7), label: r.b.slice(7) };
    if (r.type === "of_type" && r.b.startsWith("eqtype:")) s.type = r.b.slice(7);
    if (r.type === "about_asset" && r.b.startsWith("asset:")) s.equipment = { assetId: r.b.slice(6), tag: tags.get(r.b.slice(6)) ?? "?" };
    out.set(fid, s);
  }
  return out;
}

function chainOf(id: string | null, folders: Map<string, Folder>): Folder[] {
  const out: Folder[] = []; const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) { seen.add(cur); const f = folders.get(cur); if (!f) break; out.unshift(f); cur = f.parentId; }
  return out;
}

/** What a folder is marked as, what it inherits from above, and what the
 *  pickers offer. */
export async function folderMarkInfo(admin: SupabaseClient, orgId: string, folderId: string): Promise<{ own: FolderMarkState; inherited: FolderMarkState; units: Array<{ code: string; label: string }>; types: string[]; suggestion: { kind: MarkKind; value: string; ref?: string } | null }> {
  const ctx = await loadResolveContext(admin, orgId);
  const chain = chainOf(folderId, ctx.folders);
  if (!chain.length) throw new Error("That folder is not in this organization.");
  const marks = await markEdges(admin, orgId, chain.map((f) => f.id));
  const label = (code: string) => ctx.units.find((u) => u.code === code)?.label ?? code;
  const own = { ...(marks.get(folderId) ?? {}) };
  if (own.area) own.area.label = label(own.area.code);
  const inherited: FolderMarkState = {};
  for (const f of chain.slice(0, -1).reverse()) {
    const m = marks.get(f.id); if (!m) continue;
    if (!inherited.area && m.area) inherited.area = { code: m.area.code, label: label(m.area.code) };
    if (!inherited.type && m.type) inherited.type = m.type;
    if (!inherited.equipment && m.equipment) inherited.equipment = m.equipment;
  }
  const { data: t } = await admin.from("asset_types").select("name").eq("org_id", orgId).limit(200);
  const name = chain[chain.length - 1].name;
  const u = unitFromName(name, ctx);
  const e = equipmentFromFolderName(name);
  const suggestion = e ? { kind: "equipment" as const, value: e.name ? `${e.tag} · ${e.name}` : e.tag, ref: e.tag }
    : u ? { kind: "area" as const, value: label(u.code), ref: u.code } : null;
  return { own, inherited, units: ctx.units.map((x) => ({ code: x.code, label: x.label })), types: ((t as Array<{ name: string }> | null) ?? []).map((x) => x.name), suggestion };
}

async function upsertMark(admin: SupabaseClient, orgId: string, folderId: string, kind: MarkKind, b: string, summary: string, actor: Actor) {
  await admin.from("estate_edges").delete().eq("org_id", orgId).eq("a", `folder:${folderId}`).eq("type", EDGE_OF[kind]).neq("b", b);
  const { error } = await admin.from("estate_edges").upsert({
    org_id: orgId, a: `folder:${folderId}`, b, type: EDGE_OF[kind], origin: "human", tier: "provable", confidence: 1, status: "applied",
    summary, evidence: { markedBy: actor.name }, created_by: actor.userId, created_by_name: actor.name, decided_by: actor.userId, decided_by_name: actor.name, decided_at: new Date().toISOString(),
  }, { onConflict: "org_id,a,b,type" });
  if (error) throw new Error(error.message);
}

async function ensureTypeId(admin: SupabaseClient, orgId: string, label: string): Promise<string | null> {
  const { data } = await admin.from("asset_types").select("id").eq("org_id", orgId).eq("name", label).maybeSingle();
  if (data) return String((data as { id: string }).id);
  const { data: made } = await admin.from("asset_types").insert({ org_id: orgId, name: label, sort_order: 99 }).select("id").single();
  if (made) return String((made as { id: string }).id);
  const { data: raced } = await admin.from("asset_types").select("id").eq("org_id", orgId).eq("name", label).maybeSingle();
  return raced ? String((raced as { id: string }).id) : null;
}

/** File one marked equipment folder's asset under the nearest marked area
 *  and type above it. A unit already set on the asset is left alone. */
async function fileAsset(admin: SupabaseClient, orgId: string, assetId: string, folderId: string, folders: Map<string, Folder>, marks: Map<string, FolderMarkState>) {
  let area: string | undefined, type: string | undefined;
  for (const f of chainOf(folderId, folders).reverse()) {
    const m = marks.get(f.id); if (!m) continue;
    area = area ?? m.area?.code; type = type ?? m.type;
  }
  const { data: a } = await admin.from("assets").select("unit_code, metadata").eq("id", assetId).maybeSingle();
  const cur = a as { unit_code: string | null; metadata: Record<string, unknown> | null } | null;
  if (!cur) return;
  const patch: Record<string, unknown> = {};
  if (area && !cur.unit_code) patch.unit_code = area;
  if (type) {
    const tid = await ensureTypeId(admin, orgId, type);
    if (tid) { patch.type_id = tid; patch.metadata = { ...(cur.metadata ?? {}), typeSetBy: "person" }; }
  }
  if (Object.keys(patch).length) await admin.from("assets").update(patch).eq("id", assetId).eq("org_id", orgId);
}

async function findOrCreateAsset(admin: SupabaseClient, orgId: string, tag: string, name: string | null, folderId: string, actor: Actor): Promise<{ id: string; created: boolean }> {
  const norm = assetNorm(tag);
  const { data: hit } = await admin.from("assets").select("id, description").eq("org_id", orgId).eq("tag_normalized", norm).maybeSingle();
  if (hit) {
    const h = hit as { id: string; description: string | null };
    if (name && !h.description) await admin.from("assets").update({ description: name }).eq("id", h.id);
    return { id: h.id, created: false };
  }
  const insert = { org_id: orgId, tag, tag_normalized: norm, description: name, origin: "folder", discovered_from: { folderId }, created_by: actor.userId };
  let { data: made, error } = await admin.from("assets").insert(insert).select("id").single();
  if (error && /origin|discovered_from|column/i.test(error.message)) {
    const { origin: _o, discovered_from: _d, ...base } = insert; void _o; void _d;
    ({ data: made, error } = await admin.from("assets").insert(base).select("id").single());
  }
  if (error || !made) {
    const { data: raced } = await admin.from("assets").select("id").eq("org_id", orgId).eq("tag_normalized", norm).maybeSingle();
    if (raced) return { id: String((raced as { id: string }).id), created: false };
    throw new Error(`Could not add ${tag} to the registry: ${error?.message ?? "unknown error"}`);
  }
  return { id: String((made as { id: string }).id), created: true };
}

/** Re-file the marked equipment under a folder after its area or type mark changed. */
async function refileBelow(admin: SupabaseClient, orgId: string, folderId: string, folders: Map<string, Folder>) {
  const below = [...folders.values()].filter((f) => chainOf(f.id, folders).some((c) => c.id === folderId));
  const all = new Set<string>();
  for (const f of below) for (const c of chainOf(f.id, folders)) all.add(c.id);
  const marks = await markEdges(admin, orgId, [...all]);
  for (const f of below) { const eq = marks.get(f.id)?.equipment; if (eq) await fileAsset(admin, orgId, eq.assetId, f.id, folders, marks); }
}

export async function markFolder(admin: SupabaseClient, input: { orgId: string; folderId: string; mark: FolderMark; actor: Actor }, preloaded?: Awaited<ReturnType<typeof loadResolveContext>>): Promise<FolderMarkState> {
  const ctx = preloaded ?? await loadResolveContext(admin, input.orgId);
  const folders = ctx.folders as Map<string, Folder>;
  const f = folders.get(input.folderId);
  if (!f) throw new Error("That folder is not in this organization.");
  const m = input.mark;
  if (m.kind === "clear") {
    const types = m.which ? [EDGE_OF[m.which]] : Object.values(EDGE_OF);
    await admin.from("estate_edges").delete().eq("org_id", input.orgId).eq("a", `folder:${f.id}`).in("type", types).eq("origin", "human");
  } else if (m.kind === "area") {
    const u = ctx.units.find((x) => x.code === m.unitCode);
    if (!u) throw new Error("Pick an operating area from the Site Codebook.");
    await upsertMark(admin, input.orgId, f.id, "area", `cbunit:${u.code}`, `Folder "${f.name}" is ${u.label} (${u.code}) — marked by ${input.actor.name ?? "a person"}`, input.actor);
    await refileBelow(admin, input.orgId, f.id, folders);
  } else if (m.kind === "type") {
    const label = m.label.trim().slice(0, 60);
    if (!label) throw new Error("Name the equipment type, e.g. Heaters.");
    await upsertMark(admin, input.orgId, f.id, "type", eqtypeId(label), `Equipment under folder "${f.name}" is ${label} — marked by ${input.actor.name ?? "a person"}`, input.actor);
    await refileBelow(admin, input.orgId, f.id, folders);
  } else {
    const parsed = equipmentFromFolderName(m.tag) ?? null;
    const tag = parsed?.tag;
    if (!tag) throw new Error(`"${m.tag}" is not shaped like an equipment tag (like H-2 or P-101A).`);
    const name = m.name?.trim() || parsed?.name || null;
    const a = await findOrCreateAsset(admin, input.orgId, tag, name, f.id, input.actor);
    await upsertMark(admin, input.orgId, f.id, "equipment", `asset:${a.id}`, `Folder "${f.name}" is ${tag}'s folder — marked by ${input.actor.name ?? "a person"}`, input.actor);
    const chainIds = chainOf(f.id, folders).map((c) => c.id);
    await fileAsset(admin, input.orgId, a.id, f.id, folders, await markEdges(admin, input.orgId, chainIds));
  }
  return (await markEdges(admin, input.orgId, [f.id])).get(f.id) ?? {};
}

/** What every folder of a library becomes when its levels mean `levels`. */
export async function planLibrary(admin: SupabaseClient, orgId: string, libraryId: string, levels: LevelMeaning[]): Promise<PlanRow[]> {
  const ctx = await loadResolveContext(admin, orgId);
  const folders = [...ctx.folders.values()].filter((f) => f.libraryId === libraryId);
  return planStructure(folders, levels, {
    unit: (name) => { const u = unitFromName(name, ctx); const x = u ? ctx.units.find((v) => v.code === u.code) : null; return x ? { code: x.code, label: x.label } : null; },
    asset: (tag) => { const a = ctx.assets.get(canonicalForm(tag)); return a ? { id: a.id } : null; },
  });
}

/** Apply a library plan: areas first, then types, then equipment, so each
 *  piece of equipment is filed under the marks above it. */
export async function applyLibrary(admin: SupabaseClient, input: { orgId: string; libraryId: string; levels: LevelMeaning[]; actor: Actor; deadlineMs: number }): Promise<{ marked: number; created: number; skipped: number; more: boolean }> {
  const ctx = await loadResolveContext(admin, input.orgId);
  const rows = await planLibrary(admin, input.orgId, input.libraryId, input.levels);
  // Already marked the same way: nothing to do, so a second call carries on
  // where the first stopped.
  const done = await markEdges(admin, input.orgId, rows.map((r) => r.folderId));
  const out = { marked: 0, created: 0, skipped: 0, more: false };
  const order: MarkKind[] = ["area", "type", "equipment"];
  for (const kind of order) {
    for (const r of rows.filter((x) => x.kind === kind)) {
      if (r.status === "unmatched" || !r.value) { out.skipped++; continue; }
      const have = done.get(r.folderId);
      if ((kind === "area" && have?.area?.code === r.ref) || (kind === "type" && have?.type === r.value) || (kind === "equipment" && have?.equipment && r.ref && have.equipment.assetId === r.ref)) { out.marked++; continue; }
      if (Date.now() > input.deadlineMs) { out.more = true; return out; }
      try {
        if (kind === "area") await markFolder(admin, { orgId: input.orgId, folderId: r.folderId, mark: { kind: "area", unitCode: r.ref! }, actor: input.actor }, ctx);
        else if (kind === "type") await markFolder(admin, { orgId: input.orgId, folderId: r.folderId, mark: { kind: "type", label: r.value }, actor: input.actor }, ctx);
        else { await markFolder(admin, { orgId: input.orgId, folderId: r.folderId, mark: { kind: "equipment", tag: r.value.split(" · ")[0], name: r.value.split(" · ")[1] ?? null }, actor: input.actor }, ctx); if (r.status === "new") out.created++; }
        out.marked++;
      } catch { out.skipped++; }
    }
  }
  return out;
}
