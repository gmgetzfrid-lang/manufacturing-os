"use client";

// DocumentLinkPicker — pick an EXISTING document in the system to link (e.g. a
// tag → its referenced drawing). Phase 2: browse-by-library + search. (Phase 3
// will add an "upload new" mode with inline folder/library creation.)

import React, { useCallback, useEffect, useState } from "react";
import { Search, Loader2, FileText, Check, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { searchDocuments, type DocumentRow } from "@/lib/search";

export default function DocumentLinkPicker({ orgId, excludeIds = [], onPick, onClose }: {
  orgId: string;
  excludeIds?: string[];
  onPick: (doc: DocumentRow) => void | Promise<void>;
  onClose: () => void;
}) {
  const [libraries, setLibraries] = useState<{ id: string; name: string }[]>([]);
  const [libraryId, setLibraryId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name");
      if (alive) setLibraries((data as { id: string; name: string }[]) ?? []);
    })();
    return () => { alive = false; };
  }, [orgId]);

  const runSearch = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await searchDocuments({ orgId, query: query.trim() || undefined, libraryId: libraryId || undefined, limit: 50 });
      setResults(rows);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [orgId, query, libraryId]);

  useEffect(() => { const t = setTimeout(runSearch, 200); return () => clearTimeout(t); }, [runSearch]);

  const visible = results.filter((r) => !excludeIds.includes(r.id));

  return (
    <div className="fixed inset-0 z-[520] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <FileText className="w-5 h-5 text-orange-600" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-[var(--color-text)]">Link a drawing</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Pick an existing document to reference</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <select value={libraryId} onChange={(e) => setLibraryId(e.target.value)} className="text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-2 py-1.5 shrink-0 max-w-[40%]">
            <option value="">All libraries</option>
            {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5">
            <Search className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number or title…" className="bg-transparent text-xs text-[var(--color-text)] outline-none w-full min-w-0" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-orange-500" /></div>
          ) : visible.length === 0 ? (
            <div className="text-center py-12 text-xs text-[var(--color-text-muted)]">No documents found.</div>
          ) : (
            visible.map((r) => (
              <button
                key={r.id}
                disabled={!!linking}
                onClick={async () => { setLinking(r.id); try { await onPick(r); } finally { setLinking(null); } }}
                className="group w-full text-left px-5 py-2.5 border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-2)] flex items-center gap-3 disabled:opacity-50"
              >
                <FileText className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-[var(--color-text)] truncate">{r.document_number || r.title || r.name || "Document"}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)] truncate">{r.title || r.name || ""}{r.rev ? ` · Rev ${r.rev}` : ""}</div>
                </div>
                {linking === r.id ? <Loader2 className="w-4 h-4 animate-spin text-orange-500 shrink-0" /> : <Check className="w-4 h-4 text-emerald-600 opacity-0 group-hover:opacity-100 shrink-0" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
