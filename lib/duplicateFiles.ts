// lib/duplicateFiles.ts — "this exact file is already here."
//
// Before an upload, each file is hashed in the browser (SHA-256, the same
// key every copy carries) and looked up. Same bytes means the same file,
// whatever it is called. The lookup runs as the person, so they only ever
// hear about copies they can already see.

import { supabase } from "@/lib/supabase";

/** Above this, hashing in the browser costs more than the warning is worth. */
const MAX_HASH_BYTES = 300 * 1024 * 1024;

export async function hashFile(file: File): Promise<string | null> {
  if (file.size > MAX_HASH_BYTES) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export interface ExistingCopy {
  /** Where it lives, in words: "P&IDs › 2002-D 2001 rev 42". */
  where: string;
  /** Link to open it. */
  href: string;
}

/** Where each hash already lives. Missing hashes are new files. */
export async function findExistingCopies(orgId: string, hashes: string[]): Promise<Map<string, ExistingCopy[]>> {
  const out = new Map<string, ExistingCopy[]>();
  const wanted = [...new Set(hashes.filter(Boolean))];
  if (!wanted.length) return out;
  const add = (h: string, c: ExistingCopy) => {
    const list = out.get(h) ?? [];
    if (!list.some((x) => x.href === c.href) && list.length < 3) list.push(c);
    out.set(h, list);
  };
  try {
    const versions: Array<{ file_hash: string; record_id: string }> = [];
    const knowledge: Array<{ file_hash: string; name: string; library_id: string; source_document_id: string | null }> = [];
    for (let i = 0; i < wanted.length; i += 100) {
      const part = wanted.slice(i, i + 100);
      const [v, k] = await Promise.all([
        supabase.from("document_versions").select("file_hash, record_id").eq("org_id", orgId).in("file_hash", part).limit(500),
        supabase.from("knowledge_documents").select("file_hash, name, library_id, source_document_id").eq("org_id", orgId).in("file_hash", part).limit(500),
      ]);
      versions.push(...((v.data as typeof versions | null) ?? []));
      knowledge.push(...((k.data as typeof knowledge | null) ?? []));
    }
    const docIds = [...new Set([...versions.map((v) => v.record_id), ...knowledge.map((k) => k.source_document_id).filter((x): x is string => !!x)])];
    const docs = new Map<string, { name: string; document_number: string | null; rev: string | null; library_id: string; status: string | null }>();
    for (let i = 0; i < docIds.length; i += 100) {
      const { data } = await supabase.from("documents").select("id, name, document_number, rev, library_id, status").in("id", docIds.slice(i, i + 100));
      for (const d of (data as Array<{ id: string; name: string; document_number: string | null; rev: string | null; library_id: string; status: string | null }> | null) ?? []) docs.set(d.id, d);
    }
    const libIds = [...new Set([...docs.values()].map((d) => d.library_id))];
    const libs = new Map<string, string>();
    if (libIds.length) {
      const { data } = await supabase.from("libraries").select("id, name").in("id", libIds);
      for (const l of (data as Array<{ id: string; name: string }> | null) ?? []) libs.set(l.id, l.name);
    }
    const kLibIds = [...new Set(knowledge.filter((k) => !k.source_document_id).map((k) => k.library_id))];
    const kLibs = new Map<string, string>();
    if (kLibIds.length) {
      const { data } = await supabase.from("knowledge_libraries").select("id, name").in("id", kLibIds);
      for (const l of (data as Array<{ id: string; name: string }> | null) ?? []) kLibs.set(l.id, l.name);
    }
    const docCopy = (id: string): ExistingCopy | null => {
      const d = docs.get(id);
      if (!d) return null;                       // not visible to this person
      const label = d.document_number || d.name;
      const archived = d.status === "Archived" || d.status === "Superseded" ? ` (${d.status.toLowerCase()})` : "";
      return { where: `${libs.get(d.library_id) ?? "Documents"} › ${label}${d.rev ? ` rev ${d.rev}` : ""}${archived}`, href: `/documents/${d.library_id}?doc=${id}` };
    };
    for (const v of versions) {
      const c = docCopy(v.record_id);
      if (c) add(v.file_hash, c);
    }
    for (const k of knowledge) {
      if (k.source_document_id) {
        const c = docCopy(k.source_document_id);
        if (c) add(k.file_hash, c);
      } else if (kLibs.has(k.library_id)) {
        add(k.file_hash, { where: `Intelligence › ${kLibs.get(k.library_id)} › ${k.name}`, href: `/knowledge/${k.library_id}` });
      }
    }
  } catch {
    // A failed lookup must never block an upload; it just stays quiet.
  }
  return out;
}
