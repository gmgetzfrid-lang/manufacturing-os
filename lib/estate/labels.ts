// lib/estate/labels.ts — turn node ids into things a person can read.
// "folder:8f3…" → "Drawings / P&IDs / 20 - Crude"; "asset:…" → "X-35".

import { supabase } from "@/lib/supabase";
import { loadCodebook } from "@/lib/codebook";
import { parseNid } from "./ids";

export interface NodeLabel { label: string; sub?: string; href?: string }

export async function labelNodes(orgId: string, ids: string[]): Promise<Map<string, NodeLabel>> {
  const out = new Map<string, NodeLabel>();
  const by: Record<string, string[]> = {};
  for (const id of new Set(ids)) { const p = parseNid(id); if (p) (by[p.kind] ??= []).push(p.ref); }
  const tasks: Promise<void>[] = [];
  if (by.folder?.length) tasks.push((async () => {
    const { data } = await supabase.from("collections").select("id, name, path_names, library_id").in("id", by.folder.slice(0, 300));
    for (const r of (data as Array<{ id: string; name: string; path_names: string[] | null; library_id: string }> | null) ?? []) out.set(`folder:${r.id}`, { label: r.name, sub: (r.path_names ?? []).join(" / ") || undefined, href: `/documents/${r.library_id}?folderId=${r.id}` });
  })());
  if (by.doc?.length) tasks.push((async () => {
    const { data } = await supabase.from("documents").select("id, name, document_number, title, library_id, collection_id").in("id", by.doc.slice(0, 300));
    for (const r of (data as Array<{ id: string; name: string | null; document_number: string | null; title: string | null; library_id: string; collection_id: string | null }> | null) ?? []) out.set(`doc:${r.id}`, { label: r.name || r.document_number || r.title || "Document", sub: r.title ?? undefined, href: `/documents/${r.library_id}?${r.collection_id ? `folderId=${r.collection_id}&` : ""}doc=${r.id}` });
  })());
  if (by.asset?.length) tasks.push((async () => {
    const { data } = await supabase.from("assets").select("id, tag, description").in("id", by.asset.slice(0, 300));
    for (const r of (data as Array<{ id: string; tag: string; description: string | null }> | null) ?? []) out.set(`asset:${r.id}`, { label: r.tag, sub: r.description ?? undefined, href: `/assets/${encodeURIComponent(r.tag)}` });
  })());
  if (by.proj?.length) tasks.push((async () => {
    const { data } = await supabase.from("projects").select("id, name, status").in("id", by.proj.slice(0, 300));
    for (const r of (data as Array<{ id: string; name: string; status: string | null }> | null) ?? []) out.set(`proj:${r.id}`, { label: r.name, sub: r.status ?? undefined, href: `/projects/${r.id}` });
  })());
  if (by.cbunit?.length) tasks.push((async () => {
    const book = await loadCodebook(orgId);
    for (const code of by.cbunit) { const u = book.units.find((x) => x.code === code); out.set(`cbunit:${code}`, { label: u ? `${u.label} (${code})` : `Unit ${code}`, href: `/admin/assets?unit=${code}` }); }
  })());
  if (by.term?.length) for (const t of by.term) out.set(`term:${t}`, { label: `"${t.toLowerCase()}"`, sub: "a word people use" });
  if (by.lib?.length) tasks.push((async () => {
    const { data } = await supabase.from("libraries").select("id, name").in("id", by.lib.slice(0, 100));
    for (const r of (data as Array<{ id: string; name: string }> | null) ?? []) out.set(`lib:${r.id}`, { label: r.name, href: `/documents/${r.id}` });
  })());
  await Promise.all(tasks);
  return out;
}
