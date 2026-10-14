// lib/estate/runJournal.ts — SERVER-ONLY. Every AI run can be undone.
//
// Before a run changes a drawing it takes a snapshot: the drawing's
// equipment column, the bridge's applied list, its links. After, it takes
// another, and the difference is written to estate_run_changes under the
// run's id — along with the registry items the run created or filled in,
// and the page readings it replaced. Undo walks the journal backwards and
// puts each thing back, skipping (and reporting) anything a person changed
// since, so an undo never tramples later work. Without migration 20261021
// nothing is journaled and the run reports that undo is unavailable.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface RunCtx { runId: string; label: string; actor: { userId: string; name: string | null } }

type EdgeRow = Record<string, unknown> & { id: string; b: string };
export interface DocSnapshot { at: string; key: string | null; column: unknown; applied: string[]; edges: EdgeRow[] }

export async function snapshotDoc(admin: SupabaseClient, orgId: string, documentId: string): Promise<DocSnapshot> {
  const [{ data: doc }, { data: sug }, { data: edges }] = await Promise.all([
    admin.from("documents").select("library_id, metadata").eq("id", documentId).eq("org_id", orgId).maybeSingle(),
    admin.from("document_equipment_suggestions").select("applied").eq("org_id", orgId).eq("document_id", documentId).maybeSingle(),
    admin.from("estate_edges").select("*").eq("org_id", orgId).eq("a", `doc:${documentId}`).limit(1000),
  ]);
  let key: string | null = null;
  const d = doc as { library_id?: string; metadata?: Record<string, unknown> } | null;
  if (d?.library_id) {
    const { data: lib } = await admin.from("libraries").select("equipment_bridge").eq("id", d.library_id).maybeSingle();
    key = (lib?.equipment_bridge as { targetColumnKey?: string } | null)?.targetColumnKey ?? null;
  }
  return {
    at: new Date().toISOString(), key,
    column: key ? (d?.metadata?.[key] ?? null) : null,
    applied: Array.isArray(sug?.applied) ? (sug!.applied as string[]) : [],
    edges: ((edges as EdgeRow[] | null) ?? []),
  };
}

/** Write what a run did to one drawing. Returns false when the journal
 *  table is missing (undo unavailable). */
export async function recordDocChange(admin: SupabaseClient, orgId: string, run: RunCtx, documentId: string, before: DocSnapshot, after: DocSnapshot, extra: { assetsUpdated?: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }> } = {}): Promise<boolean> {
  const beforeIds = new Set(before.edges.map((e) => e.id));
  const afterIds = new Set(after.edges.map((e) => e.id));
  const edgesDeleted = before.edges.filter((e) => !afterIds.has(e.id));
  const edgesInserted = after.edges.filter((e) => !beforeIds.has(e.id)).map((e) => e.id);
  const { data: created } = await admin.from("assets").select("id, tag").eq("org_id", orgId).eq("origin", "drawing").eq("discovered_from->>documentId", documentId).gte("created_at", before.at);
  const assetsCreated = ((created as Array<{ id: string; tag: string }> | null) ?? []);
  const nothing = JSON.stringify(before.column) === JSON.stringify(after.column) && JSON.stringify(before.applied) === JSON.stringify(after.applied)
    && !edgesDeleted.length && !edgesInserted.length && !assetsCreated.length && !(extra.assetsUpdated?.length);
  if (nothing) return true;
  const { error } = await admin.from("estate_run_changes").insert({
    org_id: orgId, run_id: run.runId, run_label: run.label, kind: "doc", document_id: documentId,
    change: { key: before.key ?? after.key, column: { before: before.column, after: after.column }, applied: { before: before.applied, after: after.applied }, edgesDeleted, edgesInserted, assetsCreated, assetsUpdated: extra.assetsUpdated ?? [] },
    created_by: run.actor.userId, created_by_name: run.actor.name,
  });
  return !error;
}

/** Write the page reading a run replaced. */
export async function recordReading(admin: SupabaseClient, orgId: string, run: RunCtx, knowledgeDocId: string, documentId: string | null, page: number, before: Array<Record<string, unknown>>): Promise<boolean> {
  const { error } = await admin.from("estate_run_changes").insert({
    org_id: orgId, run_id: run.runId, run_label: run.label, kind: "reading", document_id: documentId,
    change: { knowledgeDocId, page, before: before.map(({ id: _id, ...r }) => r) },
    created_by: run.actor.userId, created_by_name: run.actor.name,
  });
  return !error;
}

export interface RunSummary { runId: string; label: string | null; at: string; by: string | null; drawings: number; undone: boolean }

export async function listRuns(admin: SupabaseClient, orgId: string): Promise<{ runs: RunSummary[]; available: boolean }> {
  const { data, error } = await admin.from("estate_run_changes").select("run_id, run_label, created_at, created_by_name, document_id, undone_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(2000);
  if (error) return { runs: [], available: false };
  const by = new Map<string, RunSummary & { docs: Set<string> }>();
  for (const r of (data as Array<{ run_id: string; run_label: string | null; created_at: string; created_by_name: string | null; document_id: string | null; undone_at: string | null }> | null) ?? []) {
    const cur = by.get(r.run_id) ?? { runId: r.run_id, label: r.run_label, at: r.created_at, by: r.created_by_name, drawings: 0, undone: !!r.undone_at, docs: new Set<string>() };
    if (r.document_id) cur.docs.add(r.document_id);
    if (r.created_at < cur.at) cur.at = r.created_at;
    cur.undone = cur.undone && !!r.undone_at;
    by.set(r.run_id, cur);
  }
  return { runs: [...by.values()].map(({ docs, ...r }) => ({ ...r, drawings: docs.size })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15), available: true };
}

/** Undo a run, newest change first. Anything a person changed since the run
 *  is left as it is and reported. */
export async function undoRun(admin: SupabaseClient, orgId: string, runId: string, actor: { userId: string }): Promise<{ drawings: number; columnsRestored: number; edgesRestored: number; edgesRemoved: number; assetsRemoved: number; assetsKept: string[]; readingsRestored: number; skipped: string[] }> {
  const out = { drawings: 0, columnsRestored: 0, edgesRestored: 0, edgesRemoved: 0, assetsRemoved: 0, assetsKept: [] as string[], readingsRestored: 0, skipped: [] as string[] };
  const { data, error } = await admin.from("estate_run_changes").select("*").eq("org_id", orgId).eq("run_id", runId).is("undone_at", null).order("created_at", { ascending: false });
  if (error) throw new Error("Undo needs migration 20261021_ai_boundary_runs.sql.");
  const rows = (data as Array<{ id: string; kind: string; document_id: string | null; change: Record<string, unknown> }> | null) ?? [];
  const docs = new Set<string>();
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  for (const row of rows) {
    const c = row.change;
    if (row.kind === "reading") {
      const kd = String(c.knowledgeDocId), page = Number(c.page);
      await admin.from("knowledge_page_entities").delete().eq("document_id", kd).eq("page", page).in("kind", ["equipment", "instrument", "xref", "census"]);
      const before = (c.before as Array<Record<string, unknown>>) ?? [];
      if (before.length) await admin.from("knowledge_page_entities").insert(before);
      out.readingsRestored++;
    } else if (row.kind === "doc" && row.document_id) {
      const docId = row.document_id; docs.add(docId);
      const key = c.key as string | null;
      const col = c.column as { before: unknown; after: unknown };
      if (key) {
        const { data: d } = await admin.from("documents").select("metadata").eq("id", docId).eq("org_id", orgId).maybeSingle();
        const md = ((d as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>;
        if (norm(md[key]) === norm(col.after)) {
          if (norm(col.before) !== norm(col.after)) { await admin.from("documents").update({ metadata: { ...md, [key]: col.before ?? [] } }).eq("id", docId).eq("org_id", orgId); out.columnsRestored++; }
        } else if (norm(col.before) !== norm(col.after)) out.skipped.push(`${docId}: its equipment column was changed after the run`);
      }
      const ap = c.applied as { before: string[] };
      await admin.from("document_equipment_suggestions").update({ applied: ap.before ?? [], status: "pending" }).eq("org_id", orgId).eq("document_id", docId);
      const inserted = (c.edgesInserted as string[]) ?? [];
      if (inserted.length) { const { data: del } = await admin.from("estate_edges").delete().in("id", inserted).select("id"); out.edgesRemoved += ((del as unknown[] | null) ?? []).length; }
      const deleted = (c.edgesDeleted as Array<Record<string, unknown>>) ?? [];
      if (deleted.length) { const { error: e } = await admin.from("estate_edges").upsert(deleted, { onConflict: "id", ignoreDuplicates: true }); if (!e) out.edgesRestored += deleted.length; }
      for (const u of (c.assetsUpdated as Array<{ id: string; before: Record<string, unknown> }>) ?? []) await admin.from("assets").update(u.before).eq("id", u.id).eq("org_id", orgId);
      const created = (c.assetsCreated as Array<{ id: string; tag: string }>) ?? [];
      if (created.length) {
        const { untouchedAssetIds } = await import("./discoveredServer");
        const free = await untouchedAssetIds(admin, orgId, created.map((a) => a.id));
        const go = created.filter((a) => free.has(a.id));
        out.assetsKept.push(...created.filter((a) => !free.has(a.id)).map((a) => a.tag));
        for (let i = 0; i < go.length; i += 200) {
          const ids = go.slice(i, i + 200).map((a) => a.id);
          await admin.from("estate_edges").delete().eq("org_id", orgId).in("b", ids.map((id) => `asset:${id}`));
          const { data: del } = await admin.from("assets").delete().eq("org_id", orgId).eq("origin", "drawing").in("id", ids).select("id");
          out.assetsRemoved += ((del as unknown[] | null) ?? []).length;
        }
      }
    }
  }
  if (rows.length) await admin.from("estate_run_changes").update({ undone_at: new Date().toISOString(), undone_by: actor.userId }).in("id", rows.map((r) => r.id));
  out.drawings = docs.size;
  await admin.from("audit_logs").insert({ action: "ESTATE_RUN_UNDONE", resource_type: "estate_run", resource_id: null, org_id: orgId, user_id: actor.userId, details: { runId, ...out } }).then(() => undefined, () => undefined);
  return out;
}
