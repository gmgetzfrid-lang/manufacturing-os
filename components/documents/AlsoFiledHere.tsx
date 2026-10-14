"use client";

// AlsoFiledHere — the symbolic links into this folder: documents that live
// elsewhere but were filed here too (filed_under edges). Each shows where
// it really is and opens there.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Link2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { nid, edgeFromRow } from "@/lib/estate/ids";

interface Row { docId: string; name: string; number: string | null; libraryId: string; folderId: string | null; path: string; summary: string }

export default function AlsoFiledHere({ orgId, folderId }: { orgId: string; folderId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from("estate_edges").select("*").eq("org_id", orgId).eq("status", "applied").eq("type", "filed_under").eq("b", nid.folder(folderId)).limit(200);
      if (error || !data?.length) { if (alive) setRows([]); return; }
      const edges = (data as Record<string, unknown>[]).map(edgeFromRow).filter((e) => e.a.startsWith("doc:"));
      const ids = edges.map((e) => e.a.slice(4));
      const { data: docs } = await supabase.from("documents").select("id, name, document_number, library_id, collection_id").in("id", ids);
      const folderIds = [...new Set(((docs as Array<{ collection_id: string | null }> | null) ?? []).map((d) => d.collection_id).filter((x): x is string => !!x))];
      const { data: folders } = folderIds.length ? await supabase.from("collections").select("id, name, path_names").in("id", folderIds) : { data: [] };
      const pathOf = new Map(((folders as Array<{ id: string; name: string; path_names: string[] | null }> | null) ?? []).map((f) => [f.id, [...(f.path_names ?? []), f.name].join(" / ")]));
      const out: Row[] = [];
      for (const d of (docs as Array<{ id: string; name: string | null; document_number: string | null; library_id: string; collection_id: string | null }> | null) ?? []) {
        const e = edges.find((x) => x.a === `doc:${d.id}`);
        out.push({ docId: d.id, name: d.name || d.document_number || "Document", number: d.document_number, libraryId: d.library_id, folderId: d.collection_id, path: d.collection_id ? pathOf.get(d.collection_id) ?? "" : "Library root", summary: e?.summary ?? "" });
      }
      if (alive) setRows(out);
    })();
    return () => { alive = false; };
  }, [orgId, folderId]);
  if (!rows.length) return null;
  return (
    <div className="mb-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
      <div className="px-4 py-2 border-b border-[var(--color-border)] text-xs font-black inline-flex items-center gap-2"><Link2 className="w-3.5 h-3.5 text-amber-600" /> Also filed here · {rows.length}</div>
      <ul className="divide-y divide-[var(--color-border)]">
        {rows.map((r) => (
          <li key={r.docId} className="px-4 py-1.5 text-xs flex items-center gap-2">
            <Link href={`/documents/${r.libraryId}?${r.folderId ? `folderId=${r.folderId}&` : ""}doc=${r.docId}`} className="font-semibold hover:underline truncate">{r.name}</Link>
            <span className="text-[var(--color-text-muted)] truncate">lives in {r.path}</span>
            {r.summary && <span className="text-[var(--color-text-faint)] truncate hidden md:inline">· {r.summary}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
