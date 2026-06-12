"use client";

// /search?q=... — full results page for cross-resource search.
//
// The Cmd+K palette shows the top 5 per kind to keep you flying.
// When you actually want every match (skimming for the exact
// document, ranking ties, etc.), this page returns up to 25 per
// kind, grouped by resource type, with kind filters in the header.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search, Loader2, AlertTriangle, FileText, Briefcase, KeyRound, Hash,
  StickyNote, X, RefreshCw, Send,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { globalSearch, type GlobalHit, type GlobalHitKind } from "@/lib/globalSearch";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";

const KIND_ICON: Record<GlobalHitKind, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  ticket: Hash,
  project: Briefcase,
  asset: KeyRound,
  note: StickyNote,
  transmittal: Send,
};
const KIND_TONE: Record<GlobalHitKind, string> = {
  document: "text-blue-700 bg-blue-50 border-blue-200",
  ticket: "text-orange-700 bg-orange-50 border-orange-200",
  project: "text-indigo-700 bg-indigo-50 border-indigo-200",
  asset: "text-purple-700 bg-purple-50 border-purple-200",
  note: "text-slate-700 bg-slate-50 border-slate-200",
  transmittal: "text-emerald-700 bg-emerald-50 border-emerald-200",
};
const KIND_LABEL: Record<GlobalHitKind, string> = {
  document: "Documents",
  ticket: "Drafting Requests",
  project: "Projects",
  asset: "Assets",
  note: "Notes",
  transmittal: "Transmittals",
};

export default function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const { activeOrgId } = useRole();

  const [query, setQuery] = useState(params.get("q") ?? "");
  const [hits, setHits] = useState<GlobalHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<GlobalHitKind | "all">("all");

  const run = useCallback(async (q: string) => {
    if (!activeOrgId || q.trim().length < 2) { setHits([]); return; }
    setLoading(true); setError(null);
    try {
      const list = await globalSearch({ orgId: activeOrgId, query: q, perKindLimit: 25 });
      setHits(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  // Initial search uses the query the page LOADED with (?q=...). Typing
  // doesn't re-search until submit — captured in a ref so the effect only
  // refires on org change, with the lint contract intact.
  const initialQuery = useRef(query);
  initialQuery.current = query;
  useEffect(() => { void run(initialQuery.current); }, [activeOrgId, run]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = `/search?q=${encodeURIComponent(query)}`;
    router.replace(url);
    void run(query);
  };

  const grouped: Record<GlobalHitKind, GlobalHit[]> = {
    document: [], ticket: [], project: [], asset: [], note: [], transmittal: [],
  };
  for (const h of hits) (grouped[h.kind] ??= []).push(h);

  const visible = kindFilter === "all" ? hits : hits.filter((h) => h.kind === kindFilter);
  const counts: Record<GlobalHitKind, number> = {
    document: grouped.document.length,
    ticket: grouped.ticket.length,
    project: grouped.project.length,
    asset: grouped.asset.length,
    note: grouped.note.length,
    transmittal: grouped.transmittal.length,
  };
  const total = hits.length;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-slate-900 inline-flex items-center gap-3 mb-3">
            <Search className="w-6 h-6 text-slate-500" /> Search
          </h1>
          <form onSubmit={submit} className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across documents, drafting requests, projects, assets, notes…"
              className="w-full pl-11 pr-10 py-3 rounded-xl border border-slate-300 bg-white text-sm shadow-sm focus:ring-2 focus:ring-slate-900/10 outline-none"
            />
            {query && (
              <button type="button" onClick={() => { setQuery(""); setHits([]); router.replace("/search"); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-700 rounded">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </form>
          <div className="mt-2 text-[10px] text-slate-400">Press <kbd className="px-1 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono">⌘K</kbd> from anywhere for the quick palette.</div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <FilterTab label={`All · ${total}`} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          {(Object.keys(KIND_LABEL) as GlobalHitKind[]).filter((k) => counts[k] > 0).map((k) => (
            <FilterTab key={k} label={`${KIND_LABEL[k]} · ${counts[k]}`} active={kindFilter === k} onClick={() => setKindFilter(k)} />
          ))}
          <button onClick={() => void run(query)} disabled={loading} className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50">
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {loading && hits.length === 0 ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-sm italic text-slate-400">
            {query.trim().length < 2 ? "Type at least 2 characters" : "No matches"}
          </div>
        ) : (
          <ul className="bg-white border border-slate-200 rounded-2xl shadow-sm divide-y divide-slate-100 overflow-hidden">
            {visible.map((h) => {
              const Icon = KIND_ICON[h.kind];
              const tone = KIND_TONE[h.kind];
              return (
                <li key={`${h.kind}-${h.id}`}>
                  <Link href={h.href} className="px-4 py-3 flex items-start gap-3 hover:bg-slate-50">
                    {h.kind === "document" ? (
                      <DocHoverPreview documentId={h.id} label={h.title}>
                        <DocThumb documentId={h.id} width={36} />
                      </DocHoverPreview>
                    ) : (
                      <div className={`shrink-0 w-9 h-9 rounded-md border flex items-center justify-center ${tone}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-slate-900 truncate">{h.title}</div>
                      {h.subtitle && <div className="text-xs text-slate-500 truncate mt-0.5">{h.subtitle}</div>}
                      <div className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">{KIND_LABEL[h.kind]}</div>
                    </div>
                    {h.badge && <span className="text-[10px] font-bold uppercase text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">{h.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
        active ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );
}
