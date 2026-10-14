// lib/estate/discoveredServer.ts — find, and on a person's word remove,
// registry equipment that was read off a drawing by mistake.
//
// Only items the drawings created (origin "drawing") are considered, and
// never one a person has touched: photos, attached files, notes, a manual
// tag on a document, or an edit to the item itself all keep it. Removal
// re-checks every id on the server, so a stale list can never delete an
// item that has since become real.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCodebookAdmin } from "@/lib/codebookServer";
import { suspectReason, type SuspectReason } from "./discoveredCheck";

export interface SuspectItem { id: string; tag: string; unitCode: string | null; reason: SuspectReason; readFrom: string | null; sheets: number }
export interface SuspectList { items: SuspectItem[]; readingInProgress: boolean; checked: number }

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function ids(admin: SupabaseClient, table: string, among: string[], manualOnly = false): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < among.length; i += 200) {
    const base = admin.from(table).select("asset_id").in("asset_id", among.slice(i, i + 200));
    const { data, error } = await (manualOnly ? base.eq("source", "manual") : base).limit(5000);
    if (error) continue; // a table an older schema lacks keeps nothing
    for (const r of (data as Array<{ asset_id: string }> | null) ?? []) out.add(r.asset_id);
  }
  return out;
}

/** Registry items nobody has touched: no photos, files, notes, manual
 *  document tags or edits. Only these may be removed by a machine. */
export async function untouchedAssetIds(admin: SupabaseClient, orgId: string, among: string[]): Promise<Set<string>> {
  if (!among.length) return new Set();
  const { data } = await admin.from("assets").select("id, updated_by").eq("org_id", orgId).in("id", among);
  const [photos, files, notes, manual] = await Promise.all([ids(admin, "asset_photos", among), ids(admin, "asset_files", among), ids(admin, "notes", among), ids(admin, "document_assets", among, true)]);
  const out = new Set<string>();
  for (const a of (data as Array<{ id: string; updated_by: string | null }> | null) ?? []) {
    if (a.updated_by || photos.has(a.id) || files.has(a.id) || notes.has(a.id) || manual.has(a.id)) continue;
    out.add(a.id);
  }
  return out;
}

export async function findSuspects(admin: SupabaseClient, orgId: string): Promise<SuspectList> {
  const { data: rows, error } = await admin.from("assets").select("id, tag, unit_code, updated_by").eq("org_id", orgId).eq("origin", "drawing").eq("archived", false).limit(5000);
  if (error || !rows?.length) return { items: [], readingInProgress: false, checked: 0 };
  const assets = rows as Array<{ id: string; tag: string; unit_code: string | null; updated_by: string | null }>;
  const book = await loadCodebookAdmin(admin, orgId).catch(() => null);
  const knownPrefixes = (book?.equipmentTypes ?? []).flatMap((t) => t.meta.tagPrefixes ?? []);
  const { count: queued } = await admin.from("knowledge_documents").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("status", ["pending", "stale", "indexing"]);
  const readingInProgress = (queued ?? 0) > 0;

  // The lines each tag was read from, on every sheet that still carries it.
  const tagForms = [...new Set(assets.map((a) => a.tag.toUpperCase()))];
  const raws = new Map<string, string[]>();
  const sheets = new Map<string, Set<string>>();
  for (let i = 0; i < tagForms.length; i += 200) {
    const { data: ents } = await admin.from("knowledge_page_entities").select("tag, raw, document_id").eq("org_id", orgId).eq("kind", "equipment").in("tag", tagForms.slice(i, i + 200)).limit(20000);
    for (const e of (ents as Array<{ tag: string; raw: string | null; document_id: string }> | null) ?? []) {
      const k = norm(e.tag);
      if (e.raw) raws.set(k, [...(raws.get(k) ?? []), e.raw]);
      sheets.set(k, new Set([...(sheets.get(k) ?? []), e.document_id]));
    }
  }

  // A person's hand on an item keeps it, whatever the reader thinks.
  const all = assets.map((a) => a.id);
  const [photos, files, notes, manual] = await Promise.all([
    ids(admin, "asset_photos", all),
    ids(admin, "asset_files", all),
    ids(admin, "notes", all),
    ids(admin, "document_assets", all, true),
  ]);

  const items: SuspectItem[] = [];
  for (const a of assets) {
    if (a.updated_by || photos.has(a.id) || files.has(a.id) || notes.has(a.id) || manual.has(a.id)) continue;
    const k = norm(a.tag);
    const r = raws.get(k) ?? [];
    const reason = suspectReason(a.tag, r, { knownPrefixes, readingInProgress });
    if (!reason) continue;
    items.push({ id: a.id, tag: a.tag, unitCode: a.unit_code, reason, readFrom: r[0] ?? null, sheets: sheets.get(k)?.size ?? 0 });
  }
  items.sort((x, y) => x.tag.localeCompare(y.tag, undefined, { numeric: true }));
  return { items, readingInProgress, checked: assets.length };
}

export async function removeSuspects(admin: SupabaseClient, orgId: string, wanted: string[], actor: { userId: string; name: string | null }): Promise<{ removed: number; columnsCleaned: number }> {
  const current = await findSuspects(admin, orgId);
  const ok = new Map(current.items.map((i) => [i.id, i]));
  const go = wanted.filter((id) => ok.has(id));
  if (!go.length) return { removed: 0, columnsCleaned: 0 };
  const gone = new Set(go.map((id) => norm(ok.get(id)!.tag)));

  // Links that point at them.
  for (let i = 0; i < go.length; i += 200) {
    await admin.from("estate_edges").delete().eq("org_id", orgId).in("b", go.slice(i, i + 200).map((id) => `asset:${id}`)).then(() => undefined, () => undefined);
  }
  // Their tags in each drawing library's equipment column.
  let columnsCleaned = 0;
  const { data: libs } = await admin.from("libraries").select("id, equipment_bridge").eq("org_id", orgId).limit(300);
  for (const l of (libs as Array<{ id: string; equipment_bridge: { targetColumnKey?: string } | null }> | null) ?? []) {
    const key = l.equipment_bridge?.targetColumnKey;
    if (!key) continue;
    const { data: docs } = await admin.from("documents").select("id, metadata").eq("org_id", orgId).eq("library_id", l.id).limit(5000);
    for (const d of (docs as Array<{ id: string; metadata: Record<string, unknown> | null }> | null) ?? []) {
      const cur = d.metadata?.[key];
      const list = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" ? cur.split(",").map((v) => v.trim()).filter(Boolean) : [];
      const kept = list.filter((t) => !gone.has(norm(t)));
      if (kept.length === list.length) continue;
      const { error } = await admin.from("documents").update({ metadata: { ...(d.metadata ?? {}), [key]: kept } }).eq("id", d.id).eq("org_id", orgId);
      if (!error) columnsCleaned++;
    }
  }
  // The items themselves. Photos, files and mention rows cascade; there are
  // none of the first two by construction.
  let removed = 0;
  for (let i = 0; i < go.length; i += 200) {
    const { data, error } = await admin.from("assets").delete().eq("org_id", orgId).eq("origin", "drawing").in("id", go.slice(i, i + 200)).select("id");
    if (!error) removed += ((data as unknown[] | null) ?? []).length;
  }
  await admin.from("audit_logs").insert({
    action: "DISCOVERED_EQUIPMENT_REMOVED", resource_type: "asset", resource_id: null, org_id: orgId, user_id: actor.userId,
    details: { tags: go.map((id) => ok.get(id)!.tag), removed, columnsCleaned, by: actor.name },
  }).then(() => undefined, () => undefined);
  return { removed, columnsCleaned };
}
