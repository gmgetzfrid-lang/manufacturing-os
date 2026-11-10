"use client";

// /search?q=...&pick=... - the same search as Documents and the Document
// Control widget: equipment with its unit, ID and description ("E-22 is on 3
// units. Which one?"), its documents with what else is on each, the map and
// a preview. Below it, requests, projects, notes and transmittals that match.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Hash, Briefcase, StickyNote, Send, X } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { isControllerRole } from "@/lib/permissions";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { globalSearch, type GlobalHit, type GlobalHitKind } from "@/lib/globalSearch";
import { useFind } from "@/components/find/useFind";
import FindPanel from "@/components/find/FindPanel";
import { folderForUnit } from "@/lib/findEverywhere";

const OTHER_ICON: Partial<Record<GlobalHitKind, React.ComponentType<{ className?: string }>>> = {
  ticket: Hash, project: Briefcase, note: StickyNote, transmittal: Send,
};
const OTHER_LABEL: Partial<Record<GlobalHitKind, string>> = {
  ticket: "Drafting request", project: "Project", note: "Note", transmittal: "Transmittal",
};

export default function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const { activeOrgId, activeRole } = useRole();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const finder = useFind(activeOrgId, query, null, { controller: isControllerRole(activeRole) });

  // ?pick= from the top search bar: that piece of equipment, once found.
  const wantPick = useRef(params.get("pick"));
  useEffect(() => {
    if (wantPick.current) { finder.pickWhenFound(wantPick.current); wantPick.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Requests, projects, notes and transmittals that match.
  const [otherFind, setOtherFind] = useState<{ q: string; hits: GlobalHit[] } | null>(null);
  const q = finder.q;
  useEffect(() => {
    if (!activeOrgId || q.length < 2) return;
    let alive = true;
    void globalSearch({ orgId: activeOrgId, query: q, perKindLimit: 10 })
      .then((h) => { if (alive) setOtherFind({ q, hits: h.filter((x) => OTHER_ICON[x.kind]) }); })
      .catch(() => { if (alive) setOtherFind({ q, hits: [] }); });
    return () => { alive = false; };
  }, [activeOrgId, q]);
  const others = otherFind && otherFind.q === q && q.length >= 2 ? otherFind.hits : [];

  // Keep the address bar in step so a link or Back lands on the same search.
  useEffect(() => {
    if (q.length < 2) return;
    const cur = new URLSearchParams(window.location.search).get("q") ?? "";
    if (cur !== q) router.replace(`/search?q=${encodeURIComponent(q)}`);
  }, [q, router]);

  return (
    <PageShell width="work">
      <div className="mb-4">
        <PageHeaderBar icon={Search} title="Search" />
        <form onSubmit={(e) => e.preventDefault()} className="relative" role="search">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search: tag, equipment ID, drawing number, words from the drawing"
            aria-label="Search"
            data-find-input
            className="w-full pl-11 pr-10 py-3 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-base sm:text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] shadow-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-[var(--color-accent-ring)] outline-none transition-colors"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(""); router.replace("/search"); }} title="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)] rounded transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </form>
      </div>

      {activeOrgId && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm p-3 lg:p-4">
          <FindPanel orgId={activeOrgId} f={finder} unit={null}
            onSearchAsset={(id, tag) => { setQuery(tag); finder.pickWhenFound(id); }}
            onUnit={(code) => void folderForUnit(activeOrgId, code, null).then((f) => { if (f) router.push(`/documents/${f.libraryId}?folderId=${f.chain[f.chain.length - 1].id}`); })}
            onOpenFolder={(fo) => router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`)}
            onOpenHref={(href) => router.push(href)} />
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-4">
          <div className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">Requests, projects, notes</div>
          <ul className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm divide-y divide-[var(--color-border)] overflow-hidden">
            {others.map((h) => {
              const Icon = OTHER_ICON[h.kind] ?? Search;
              return (
                <li key={`${h.kind}-${h.id}`}>
                  <Link href={h.href} className="px-4 py-3 flex items-start gap-3 hover:bg-[var(--color-surface-2)] transition-colors">
                    <span className="shrink-0 w-9 h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-center"><Icon className="w-4 h-4" /></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-bold text-[var(--color-text)] truncate">{h.title}</span>
                      {h.subtitle && <span className="block text-xs text-[var(--color-text-muted)] truncate mt-0.5">{h.subtitle}</span>}
                      <span className="block text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider mt-1">{OTHER_LABEL[h.kind]}</span>
                    </span>
                    {h.badge && <span className="text-[10px] font-bold uppercase text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded shrink-0">{h.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </PageShell>
  );
}
