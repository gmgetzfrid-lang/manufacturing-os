// lib/estate/connectPlan.ts — SERVER-ONLY. What Connect everything WOULD
// do, before it does anything: read-only.
//
// For every Document Control library: will it be read, is it marked never
// send to AI, how many files. For each file in the libraries to be read:
// already read (reused, nothing sent), new, revised, held back, not current,
// or not a PDF. And plainly what leaves the server: page text never does;
// pages with no usable text go to the caller's model as images; drawings
// read with AI go to the caller's model whole.

import type { SupabaseClient } from "@supabase/supabase-js";
import { excludedLibraryIds } from "@/lib/aiLibraries";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";

export type PlanFileState = "read" | "new" | "revised" | "held_back" | "not_current" | "not_pdf";
export interface PlanFile { id: string; name: string; state: PlanFileState; census: boolean }
export interface PlanLibrary { id: string; name: string; neverAi: boolean; drawings: boolean; selected: boolean; files: number; counts: Record<PlanFileState, number>; toCensus: number; sample: PlanFile[] }
export interface ConnectPlan { libraries: PlanLibrary[]; model: { provider: string | null; model: string | null }; hasKey: boolean }

export function looksLikeDrawings(name: string): boolean { return /draw|p&id|p&amp;id|pid|iso|dwg|diagram|schematic|loop/i.test(name); }

const isPdf = (url: string | null, type: string | null) => (type ?? "").toLowerCase().includes("pdf") || (url ?? "").toLowerCase().endsWith(".pdf");

export async function connectPlan(admin: SupabaseClient, orgId: string, userId: string, onlyLibraryIds?: string[]): Promise<ConnectPlan> {
  const [{ data: libRows }, neverAi, { data: conn }] = await Promise.all([
    admin.from("libraries").select("id, name").eq("org_id", orgId).order("name").limit(300),
    excludedLibraryIds(admin, orgId),
    admin.from("ai_connections").select("provider, model").eq("org_id", orgId).eq("user_id", userId).maybeSingle(),
  ]);
  const libs = (libRows as Array<{ id: string; name: string }> | null) ?? [];
  const drawingIds = libs.filter((l) => looksLikeDrawings(l.name) && !neverAi.has(l.id)).map((l) => l.id);
  const selected = new Set(onlyLibraryIds?.length ? onlyLibraryIds.filter((id) => !neverAi.has(id)) : drawingIds);

  const out: PlanLibrary[] = [];
  for (const l of libs) {
    const blank: Record<PlanFileState, number> = { read: 0, new: 0, revised: 0, held_back: 0, not_current: 0, not_pdf: 0 };
    const row: PlanLibrary = { id: l.id, name: l.name, neverAi: neverAi.has(l.id), drawings: looksLikeDrawings(l.name), selected: selected.has(l.id), files: 0, counts: blank, toCensus: 0, sample: [] };
    if (!row.selected) {
      const { count } = await admin.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("library_id", l.id);
      row.files = count ?? 0; out.push(row); continue;
    }
    type DocRow = { id: string; name: string | null; title: string | null; document_number: string | null; status: string | null; archived_at: string | null; current_version_id: string | null; ai_excluded?: boolean };
    const SEL = "id, name, title, document_number, status, archived_at, current_version_id, ai_excluded";
    const { data: docs } = await admin.from("documents").select(SEL).eq("org_id", orgId).eq("library_id", l.id).limit(5000);
    const list = [...((docs as DocRow[] | null) ?? [])];
    // Files in the library's folders with no library column of their own
    // are read too, so they are listed too.
    const { data: folders } = await admin.from("collections").select("id").eq("org_id", orgId).eq("library_id", l.id).limit(5000);
    const fids = ((folders as Array<{ id: string }> | null) ?? []).map((f) => f.id);
    for (let i = 0; i < fids.length; i += 100) {
      const { data: extra } = await admin.from("documents").select(SEL).eq("org_id", orgId).is("library_id", null).in("collection_id", fids.slice(i, i + 100)).limit(5000);
      list.push(...((extra as DocRow[] | null) ?? []));
    }
    row.files = list.length;
    const versions = new Map<string, { file_url: string | null; file_type: string | null }>();
    const vids = list.map((d) => d.current_version_id).filter((v): v is string => !!v);
    for (let i = 0; i < vids.length; i += 200) {
      const { data } = await admin.from("document_versions").select("id, file_url, file_type").in("id", vids.slice(i, i + 200));
      for (const v of (data as Array<{ id: string; file_url: string | null; file_type: string | null }> | null) ?? []) versions.set(v.id, v);
    }
    const mirrors = new Map<string, { id: string; status: string; source_version_id: string | null }>();
    const ids = list.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from("knowledge_documents").select("id, status, source_document_id, source_version_id").eq("org_id", orgId).in("source_document_id", ids.slice(i, i + 200));
      for (const m of (data as Array<{ id: string; status: string; source_document_id: string; source_version_id: string | null }> | null) ?? []) if (!mirrors.has(m.source_document_id) || m.status === "ready") mirrors.set(m.source_document_id, m);
    }
    const censused = new Set<string>();
    const mids = [...mirrors.values()].map((m) => m.id);
    for (let i = 0; i < mids.length; i += 200) {
      const { data } = await admin.from("knowledge_page_entities").select("document_id").eq("kind", "census").in("document_id", mids.slice(i, i + 200)).limit(20000);
      for (const r of (data as Array<{ document_id: string }> | null) ?? []) censused.add(r.document_id);
    }
    for (const d of list) {
      const name = [d.document_number, d.title ?? d.name].filter(Boolean).join(" — ") || "Document";
      const v = d.current_version_id ? versions.get(d.current_version_id) : undefined;
      const m = mirrors.get(d.id);
      let state: PlanFileState;
      if (d.ai_excluded) state = "held_back";
      else if (d.archived_at || NOT_CURRENT_STATUSES.has(d.status ?? "")) state = "not_current";
      else if (!v || !isPdf(v.file_url, v.file_type)) state = "not_pdf";
      else if (!m) state = "new";
      else if (m.source_version_id && m.source_version_id !== d.current_version_id) state = "revised";
      else state = m.status === "ready" ? "read" : "new";
      row.counts[state]++;
      const census = row.drawings && (state === "new" || state === "revised" || (state === "read" && !!m && !censused.has(m.id)));
      if (census) row.toCensus++;
      if (row.sample.length < 400) row.sample.push({ id: d.id, name, state, census });
    }
    out.push(row);
  }
  const c = conn as { provider?: string; model?: string } | null;
  return { libraries: out, model: { provider: c?.provider ?? null, model: c?.model ?? null }, hasKey: !!c };
}
