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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card } from "@/components/ui/PageHero";
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
  const [otherFind, setOtherFind] = useState<{ q: string; hits: GlobalHit[]; failed?: boolean } | null>(null);
  const q = finder.q;
  useEffect(() => {
    if (!activeOrgId || q.length < 2) return;
    let alive = true;
    void globalSearch({ orgId: activeOrgId, query: q, perKindLimit: 10 })
      .then((h) => { if (alive) setOtherFind({ q, hits: h.filter((x) => OTHER_ICON[x.kind]) }); })
      .catch(() => { if (alive) setOtherFind({ q, hits: [], failed: true }); });
    return () => { alive = false; };
  }, [activeOrgId, q]);
  const others = otherFind && otherFind.q === q && q.length >= 2 ? otherFind.hits : [];
  const othersFailed = !!(otherFind && otherFind.q === q && otherFind.failed);

  // Keep the address bar in step so a link or Back lands on the same search.
  useEffect(() => {
    if (q.length < 2) return;
    const cur = new URLSearchParams(window.location.search).get("q") ?? "";
    if (cur !== q) router.replace(`/search?q=${encodeURIComponent(q)}`);
  }, [q, router]);

  // The answer: what the search found, counted from what came back.
  const found = finder.quick && finder.quick.q === q ? finder.quick : null;
  const nDocs = finder.docOrder.length;
  const nEq = found?.equipment.length ?? 0;
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const answer = q.length < 2 ? "Search everything."
    : !found && finder.loading ? "Searching…"
    : nDocs + nEq + others.length === 0 ? (finder.loading || finder.deepLoading ? "Searching…" : "Nothing found.")
    : [nDocs > 0 ? plural(nDocs, "document", "documents") : null, nEq > 0 ? plural(nEq, "piece of equipment", "pieces of equipment") : null]
        .filter(Boolean).join(", ") + (nDocs + nEq === 0 ? plural(others.length, "match", "matches") : "") + ".";
  const answerSub = q.length < 2
    ? "Tags, equipment IDs, drawing numbers, words from the drawings, and the requests, projects and notes that mention them."
    : `For “${q}”.${others.length > 0 ? ` ${plural(others.length, "request, project or note", "requests, projects and notes")} too.` : ""}`;

  return (
    <PageShell width="work">
      <PageHero kicker="Search" title={answer} sub={answerSub}>
        <form onSubmit={(e) => e.preventDefault()} className="relative" role="search">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-ink-muted)] pointer-events-none" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tag, equipment ID, drawing number, words from the drawing"
            aria-label="Search"
            data-find-input
            className="w-full h-12 pl-11 pr-11 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white placeholder:text-[var(--color-ink-muted)] text-base sm:text-[15px] focus:outline-none focus:border-[var(--color-ink-muted)] focus:ring-2 focus:ring-[var(--color-accent)]/40 transition-colors"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(""); router.replace("/search"); }} title="Clear the search" aria-label="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-lg text-[var(--color-ink-muted)] hover:text-white hover:bg-[var(--color-ink-line)] transition-colors">
              <X className="w-4 h-4" />
            </button>
          )}
        </form>
      </PageHero>

      <PageBody>
      {activeOrgId && (
        <Card>
          <FindPanel orgId={activeOrgId} f={finder} unit={null}
            onSearchAsset={(id, tag) => { setQuery(tag); finder.pickWhenFound(id); }}
            onUnit={(code) => void folderForUnit(activeOrgId, code, null).then((f) => { if (f) router.push(`/documents/${f.libraryId}?folderId=${f.chain[f.chain.length - 1].id}`); })}
            onOpenFolder={(fo) => router.push(`/documents/${fo.libraryId}?folderId=${fo.id}`)}
            onOpenHref={(href) => router.push(href)} />
        </Card>
      )}

      {othersFailed && (
        <Card>
          <p role="alert" className="text-[14px] text-rose-700 dark:text-rose-300">
            Couldn&apos;t search requests, projects and notes. Change the search to try again.
          </p>
        </Card>
      )}
      {others.length > 0 && (
        <Card label="Requests, projects, notes" pad={false} className="overflow-hidden">
          <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {others.map((h) => {
              const Icon = OTHER_ICON[h.kind] ?? Search;
              return (
                <li key={`${h.kind}-${h.id}`}>
                  <Link href={h.href} className="px-4 sm:px-5 py-3 flex items-start gap-3 hover:bg-[var(--color-surface-2)] transition-colors">
                    <span className="shrink-0 w-9 h-9 rounded-[9px] bg-[var(--color-surface-2)] text-[var(--color-text-muted)] flex items-center justify-center"><Icon className="w-4 h-4" /></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14px] font-bold text-[var(--color-text)] truncate">{h.title}</span>
                      {h.subtitle && <span className="block text-[13px] text-[var(--color-text-muted)] truncate mt-0.5">{h.subtitle}</span>}
                      <span className="block text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.12em] mt-1">{OTHER_LABEL[h.kind]}</span>
                    </span>
                    {h.badge && <span className="text-[11px] font-bold uppercase text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded shrink-0">{h.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      </PageBody>
    </PageShell>
  );
}
