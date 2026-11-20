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
import { sheet, thead, th } from "@/components/cockpit/ui";
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

/** "PENDING_IFC" → "Pending IFC". */
function badgeWords(b: string): string {
  if (!/^[A-Z0-9_]+$/.test(b)) return b;
  return b.split("_").map((w, i) => (["IFC", "ENG", "MOC"].includes(w) ? w : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
}

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
    : `For “${q}”.`;
  const searchFacts = q.length >= 2 && found ? [
    { label: "Documents", value: nDocs.toLocaleString() },
    { label: "Equipment", value: nEq.toLocaleString() },
    { label: "Requests, projects, notes", value: others.length.toLocaleString() },
  ] : undefined;

  return (
    <PageShell width="work">
      <PageHero kicker="Search" title={answer} sub={answerSub} facts={searchFacts}>
        <form onSubmit={(e) => e.preventDefault()} className="relative" role="search">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)] pointer-events-none" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tag, equipment ID, drawing number, words from the drawing"
            aria-label="Search"
            data-find-input
            className="w-full h-12 pl-11 pr-11 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] text-base sm:text-[15px] focus:outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 transition-colors"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(""); router.replace("/search"); }} title="Clear the search" aria-label="Clear the search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
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
          <p role="alert" className="text-[15px] text-[var(--state-overdue)]">
            Couldn&apos;t search requests, projects and notes. Change the search to try again.
          </p>
        </Card>
      )}
      {others.length > 0 && (
        <section aria-label="Requests, projects, notes">
          <div className="flex items-center gap-2 mb-2.5 min-h-9">
            <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)]">Requests, projects, notes</h2>
            <span className="text-[15px] text-[var(--color-text-muted)] tabular-nums">{others.length}</span>
          </div>
          <div className={sheet}>
            <table className="w-full text-[15px]">
              <thead className={thead}>
                <tr>
                  <th className={th}>Match</th>
                  <th className={`${th} hidden sm:table-cell`}>Kind</th>
                  <th className={`${th} hidden md:table-cell`}>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {others.map((h) => {
                  const Icon = OTHER_ICON[h.kind] ?? Search;
                  return (
                    <tr key={`${h.kind}-${h.id}`} className="hover:bg-[var(--color-surface-2)] cursor-pointer" onClick={() => router.push(h.href)}>
                      <td className="px-4 py-2.5 max-w-0 w-full">
                        <span className="flex items-start gap-3 min-w-0">
                          <Icon className="w-4 h-4 mt-1 shrink-0 text-[var(--color-text-muted)]" />
                          <span className="min-w-0">
                            <Link href={h.href} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{h.title}</Link>
                            {h.subtitle && <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{h.subtitle}</span>}
                            <span className="sm:hidden block text-[13px] text-[var(--color-text-muted)]">{OTHER_LABEL[h.kind]}{h.badge ? `, ${badgeWords(h.badge)}` : ""}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 hidden sm:table-cell whitespace-nowrap text-[var(--color-text-muted)]">{OTHER_LABEL[h.kind]}</td>
                      <td className="px-4 py-2.5 hidden md:table-cell whitespace-nowrap text-[14px] text-[var(--color-text)]">{h.badge ? badgeWords(h.badge) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      </PageBody>
    </PageShell>
  );
}
