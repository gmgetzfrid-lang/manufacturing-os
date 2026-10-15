"use client";

// /search?q=... — full results page for cross-resource search.
//
// The Cmd+K palette shows the top 5 per kind to keep you flying.
// When you actually want every match (skimming for the exact
// document, ranking ties, etc.), this page returns up to 25 per
// kind, grouped by resource type, with kind filters in the header.
// THOR (the NAS index) is searched alongside: what is not in the system but
// is on THOR shows up here, and "See all" continues in the finder.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search, AlertTriangle, FileText, Briefcase, KeyRound, Hash,
  StickyNote, X, RefreshCw, Send, HardDrive, ChevronRight,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { globalSearch, type GlobalHit, type GlobalHitKind } from "@/lib/globalSearch";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf } from "@/lib/fileFinder/fileTypes";
import { parseThorQuery, formatBytes, unitName, countLabel } from "@/lib/thor/query";
import { buildArgs, thorOverview, thorSearch, EMPTY_FILTERS, type ThorFile, type ThorOverview } from "@/lib/thor/client";

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
  note: "text-[var(--color-text)] bg-[var(--color-surface-2)] border-[var(--color-border)]",
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
  const [kindFilter, setKindFilter] = useState<GlobalHitKind | "all" | "thor">("all");
  const [thorInfo, setThorInfo] = useState<ThorOverview | null>(null);
  const [thor, setThor] = useState<{ q: string; rows: ThorFile[]; total: number; capped: boolean } | null>(null);
  const thorSeq = useRef(0);

  useEffect(() => {
    if (!activeOrgId) return;
    let live = true;
    thorOverview(activeOrgId).then((o) => { if (live) setThorInfo(o); }).catch(() => undefined);
    return () => { live = false; };
  }, [activeOrgId]);

  const run = useCallback(async (q: string) => {
    if (!activeOrgId || q.trim().length < 2) { setHits([]); setThor(null); return; }
    setLoading(true); setError(null);
    // THOR runs beside the system search and never holds it up.
    if (thorInfo) {
      const seq = ++thorSeq.current;
      const units = thorInfo.units.filter((u) => u.code).map((u) => ({ code: u.code!, folder: u.folder }));
      thorSearch(buildArgs(activeOrgId, parseThorQuery(q, units), EMPTY_FILTERS, { limit: 10, offset: 0 }))
        .then((p) => { if (seq === thorSeq.current) setThor({ q, rows: p.rows, total: p.total, capped: p.capped }); })
        .catch(() => { if (seq === thorSeq.current) setThor(null); });
    }
    try {
      const list = await globalSearch({ orgId: activeOrgId, query: q, perKindLimit: 25 });
      setHits(list);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId, thorInfo]);

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

  const visible = kindFilter === "all" ? hits : kindFilter === "thor" ? [] : hits.filter((h) => h.kind === kindFilter);
  const thorTotal = thor?.total ?? 0;
  const thorHref = `/documents/graph?src=thor&q=${encodeURIComponent(thor?.q ?? query)}`;
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
    <PageShell width="work">
        <div className="mb-6">
          <PageHeaderBar icon={Search} title="Search" />
          <form onSubmit={submit} className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across documents, drafting requests, projects, assets, notes…"
              className="w-full pl-11 pr-10 py-3 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] shadow-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] focus:border-[var(--color-accent-ring)] outline-none transition-colors"
            />
            {query && (
              <button type="button" onClick={() => { setQuery(""); setHits([]); router.replace("/search"); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)] rounded transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </form>
          <div className="mt-2 text-[10px] text-[var(--color-text-faint)]">Press <kbd className="px-1 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] font-mono">⌘K</kbd> from anywhere for the quick palette.</div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <FilterTab label={`All · ${total}`} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
          {(Object.keys(KIND_LABEL) as GlobalHitKind[]).filter((k) => counts[k] > 0).map((k) => (
            <FilterTab key={k} label={`${KIND_LABEL[k]} · ${counts[k]}`} active={kindFilter === k} onClick={() => setKindFilter(k)} />
          ))}
          {thorTotal > 0 && <FilterTab label={`THOR · ${countLabel(thorTotal, thor?.capped)}`} active={kindFilter === "thor"} onClick={() => setKindFilter("thor")} />}
          <Button variant="secondary" size="sm" onClick={() => void run(query)} disabled={loading} className="ml-auto">
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {(kindFilter === "thor" || (kindFilter === "all" && thorTotal > 0 && !loading && hits.length === 0)) && thor ? (
          <ThorSection rows={thor.rows} total={countLabel(thorTotal, thor.capped)} href={thorHref} notInSystem={hits.length === 0} />
        ) : loading && hits.length === 0 ? (
          <div className="py-12 flex justify-center"><Spinner /></div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-12 text-center text-sm italic text-[var(--color-text-faint)]">
            {query.trim().length < 2 ? "Type at least 2 characters" : "No matches"}
          </div>
        ) : (
          <ul className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-sm divide-y divide-[var(--color-border)] overflow-hidden">
            {visible.map((h) => {
              const Icon = KIND_ICON[h.kind];
              const tone = KIND_TONE[h.kind];
              return (
                <li key={`${h.kind}-${h.id}`}>
                  <Link href={h.href} className="px-4 py-3 flex items-start gap-3 hover:bg-[var(--color-surface-2)] transition-colors">
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
                      <div className="text-sm font-bold text-[var(--color-text)] truncate">{h.title}</div>
                      {h.subtitle && <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{h.subtitle}</div>}
                      <div className="text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider mt-1">{KIND_LABEL[h.kind]}</div>
                    </div>
                    {h.badge && <span className="text-[10px] font-bold uppercase text-[var(--color-text-muted)] bg-[var(--color-surface-2)] px-1.5 py-0.5 rounded shrink-0">{h.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {kindFilter === "all" && hits.length > 0 && thor && thorTotal > 0 && (
          <div className="mt-6"><ThorSection rows={thor.rows.slice(0, 5)} total={countLabel(thorTotal, thor.capped)} href={thorHref} notInSystem={false} /></div>
        )}
    </PageShell>
  );
}

/** Files on THOR (the NAS index) for the same words: name, where, unit, size, date. */
function ThorSection({ rows, total, href, notInSystem }: { rows: ThorFile[]; total: string; href: string; notInSystem: boolean }) {
  return (
    <div className={`rounded-2xl border shadow-sm overflow-hidden ${notInSystem ? "border-teal-300" : "border-[var(--color-border)]"} bg-[var(--color-surface)]`}>
      <div className={`px-4 py-2.5 flex items-center gap-2 text-sm font-bold ${notInSystem ? "bg-teal-50 text-teal-900" : "text-[var(--color-text)]"}`}>
        <HardDrive className="w-4 h-4 text-teal-700" />
        {notInSystem ? `Not in the system — found ${total} on THOR` : `Also on THOR · ${total}`}
        <Link href={href} className="ml-auto text-xs font-bold text-teal-800 hover:underline inline-flex items-center gap-0.5">See all, with filters <ChevronRight className="w-3.5 h-3.5" /></Link>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {rows.map((f) => (
          <li key={f.file_id}>
            <Link href={`${href}&thorFolder=${encodeURIComponent(f.folder_rel)}`} className="px-4 py-2.5 flex items-start gap-3 hover:bg-[var(--color-surface-2)] transition-colors" title={f.unc_path}>
              <div className="shrink-0 w-9 h-9 rounded-md border border-teal-200 bg-teal-50 grid place-items-center"><FileTypeIcon type={fileTypeOf(f.filename)} className="w-4 h-4" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-[var(--color-text)] truncate">{f.filename}</div>
                <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{f.folder_rel.replace(/\//g, " › ") || "Equipment Files"}</div>
                <div className="text-[10px] text-[var(--color-text-faint)] uppercase tracking-wider mt-1">
                  THOR{f.unit_folder ? ` · ${unitName(f.unit_folder)}` : ""} · {formatBytes(f.size_bytes)}{f.modified_at ? ` · ${new Date(f.modified_at).toLocaleDateString()}` : ""}
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
        active
          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-[var(--color-accent)]"
          : "bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
      }`}
    >
      {label}
    </button>
  );
}
