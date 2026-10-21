"use client";

// Document Control — browse your libraries without leaving the dashboard.
//
// Libraries → folders → documents, right in the card: a breadcrumb you can
// click back along, an Up button, and a search that looks across the whole
// library you're in (or everything, at the top). Opening a document goes
// straight to it; "Open here" opens the Documents page at the same folder.

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronRight, Folder, FileText, ArrowUpRight, Home, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { isControllerRole } from "@/lib/permissions";
import NodeCover from "@/components/documents/NodeCover";
import { TrendChip, MiniBars, dayBuckets } from "../viz";
import {
  useWidget, useSetting, useSessionState, useWidgetData, SearchField, useDebounced, Skeleton, Empty, timeAgo,
  headCount, fetchRecentDates, weekSplit, sum, SCROLL,
} from "../kit";

interface Lib { id: string; name: string; color?: string | null; icon?: string | null; type?: string | null; cover_image_url?: string | null; cover_tint?: "none" | "brand" | "mono" | null; count?: number }
interface FolderRow { id: string; name: string; parent_id: string | null; deleted_at?: string | null; visibility?: string | null; color?: string | null; icon?: string | null }
interface DocRow { id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; status: string | null; updated_at: string | null; collection_id: string | null; library_id?: string }

const DOC_COLS = "id, document_number, title, name, rev, status, updated_at, collection_id, library_id";

const STATUS_CLS: Record<string, string> = {
  Issued: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
  IFC: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800",
  Draft: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700",
  "In Review": "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800",
  Superseded: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800",
};

function DocLine({ d, folderName }: { d: DocRow; folderName?: string | null }) {
  const href = `/documents/${d.library_id ?? ""}?doc=${d.id}`;
  return (
    <Link href={href} className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
      <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-[11px] font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)]">{d.document_number || d.name || "Document"}</span>
          {d.rev && <span className="shrink-0 text-[9px] font-black text-[var(--color-text-muted)]">R{d.rev}</span>}
        </span>
        <span className="block text-[11px] text-[var(--color-text-muted)] truncate">
          {d.title && d.title !== d.document_number ? d.title : (d.name ?? "")}
          {folderName ? <span className="text-[var(--color-text-faint)]"> · {folderName}</span> : null}
        </span>
      </span>
      {d.status && <span className={`shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded border ${STATUS_CLS[d.status] ?? "bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-[var(--color-border)]"}`}>{d.status}</span>}
      <span className="shrink-0 w-6 text-right text-[10px] text-[var(--color-text-faint)] tabular-nums">{timeAgo(d.updated_at)}</span>
    </Link>
  );
}

export default function DocBrowserBody() {
  const { activeRole } = useRole();
  const router = useRouter();
  const { expanded } = useWidget();
  const [pinned] = useSetting<string[]>("libraryIds", []);
  // Where you are: a library and a folder path inside it.
  const [libId, setLibId] = useSessionState<string | null>("libId", null);
  const [path, setPath] = useSessionState<FolderRow[]>("path", []);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const folderId = path.length ? path[path.length - 1].id : null;

  // ── Top level: libraries ──────────────────────────────────────────
  const { data: top, loading: topLoading } = useWidgetData(async (orgId) => {
    let libs: Lib[] = [];
    const rich = await supabase.from("libraries").select("id, name, color, icon, type, cover_image_url, cover_tint").eq("org_id", orgId).order("name");
    if (!rich.error) libs = (rich.data ?? []) as Lib[];
    else libs = ((await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")).data ?? []) as Lib[];
    const head = libs.slice(0, 24);
    const [counted, totalDocs, newDates] = await Promise.all([
      Promise.all(head.map(async (l) => ({
        ...l,
        count: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
          .eq("org_id", orgId).eq("library_id", l.id) as unknown as Promise<{ count: number | null }>),
      }))),
      headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
      fetchRecentDates("documents", orgId, 14),
    ]);
    return { libs: [...counted, ...libs.slice(24)], totalDocs, newDates };
  });

  // ── Inside a library: this folder's subfolders + documents ────────
  const { data: here, refreshing } = useWidgetData(async (orgId) => {
    if (!libId) return null;
    const fq = supabase.from("collections").select("*").eq("library_id", libId).order("name");
    const folderRes = await (folderId ? fq.eq("parent_id", folderId) : fq.is("parent_id", null));
    const folders = ((folderRes.data ?? []) as FolderRow[])
      .filter((f) => !f.deleted_at && (isControllerRole(activeRole) || (f.visibility ?? "normal") === "normal"));
    let dq2 = supabase.from("documents").select(DOC_COLS, { count: "exact" })
      .eq("org_id", orgId).eq("library_id", libId).neq("status", "Archived");
    dq2 = folderId ? dq2.eq("collection_id", folderId) : dq2.is("collection_id", null);
    const docRes = await dq2.order("updated_at", { ascending: false }).limit(expanded ? 200 : 60);
    return { at: `${libId}|${folderId ?? ""}`, folders, docs: (docRes.data ?? []) as unknown as DocRow[], docCount: docRes.count ?? 0 };
  }, [libId, folderId, expanded]);

  // ── Search: the library you're in, or everything ──────────────────
  const { data: hits, refreshing: searching } = useWidgetData(async (orgId) => {
    if (dq.length < 2) return null;
    const term = dq.replace(/[%_,()]/g, " ").trim();
    let s = supabase.from("documents").select(DOC_COLS).eq("org_id", orgId).neq("status", "Archived")
      .or(`document_number.ilike.%${term}%,title.ilike.%${term}%,name.ilike.%${term}%`);
    if (libId) s = s.eq("library_id", libId);
    const { data } = await s.order("updated_at", { ascending: false }).limit(40);
    const rows = (data ?? []) as unknown as DocRow[];
    const fids = [...new Set(rows.map((r) => r.collection_id).filter((x): x is string => !!x))].slice(0, 100);
    const names = new Map<string, string>();
    if (fids.length) {
      const { data: fs } = await supabase.from("collections").select("id, name").in("id", fids);
      for (const f of (fs ?? []) as Array<{ id: string; name: string }>) names.set(f.id, f.name);
    }
    return { rows, names };
  }, [dq, libId]);

  const libs = top?.libs ?? [];
  const lib = libId ? libs.find((l) => l.id === libId) ?? null : null;
  const go = (id: string | null) => { setLibId(id); setPath([]); setQ(""); };
  const up = () => { if (path.length) setPath((p) => p.slice(0, -1)); else go(null); };
  const openHere = libId ? `/documents/${libId}${folderId ? `?folderId=${folderId}` : ""}` : "/documents";

  if (topLoading) return <Skeleton />;
  if (libs.length === 0) {
    return <Empty><Link href="/admin/libraries" className="font-bold text-[var(--color-accent)] hover:underline">No libraries yet — create your first library →</Link></Empty>;
  }

  const search = (
    <SearchField value={q} onChange={setQ}
      onSubmit={(v) => router.push(`/search?q=${encodeURIComponent(v)}`)}
      placeholder={lib ? `Search ${lib.name} — number, title…` : "Search every library — number, title…"}
      title="Results appear as you type; Enter opens full search" />
  );

  // ── Search results replace the listing while there's a query ──────
  const results = dq.length >= 2 ? (
    <div className={`${SCROLL} mt-2 space-y-0.5`}>
      {searching && !hits ? <Skeleton rows={2} />
        : (hits?.rows.length ?? 0) === 0 ? <Empty>No documents match “{dq}”{lib ? ` in ${lib.name}` : ""}.</Empty>
        : hits!.rows.map((d) => <DocLine key={d.id} d={d} folderName={d.collection_id ? hits!.names.get(d.collection_id) : (libId ? "top level" : libs.find((l) => l.id === d.library_id)?.name)} />)}
    </div>
  ) : null;

  // ── Top level ─────────────────────────────────────────────────────
  if (!libId) {
    const chosen = pinned.length ? (pinned.map((id) => libs.find((l) => l.id === id)).filter(Boolean) as Lib[]) : libs;
    const buckets = dayBuckets(top?.newDates ?? [], 14);
    const wk = weekSplit(top?.newDates ?? []);
    return (
      <div className="mt-3 flex-1 min-h-0 flex flex-col">
        <div className="mb-2 flex items-end justify-between gap-4 shrink-0">
          <div className="flex items-end gap-2">
            <span className="text-2xl font-black leading-none text-[var(--color-text)] tabular-nums">{(top?.totalDocs ?? 0).toLocaleString()}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] pb-0.5">controlled documents</span>
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <TrendChip current={wk.cur} previous={wk.prev} />
            {sum(buckets.counts) > 0 && <div className="w-28 hidden sm:block"><MiniBars values={buckets.counts} labels={buckets.labels} height={28} /></div>}
          </div>
        </div>
        <div className="shrink-0">{search}</div>
        {results ?? (
          <div className={`mt-2 grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-2 content-start ${SCROLL}`}>
            {chosen.map((l) => (
              <button key={l.id} type="button" onClick={() => go(l.id)}
                className="group text-left rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden hover:border-[var(--color-accent)] hover:shadow-md transition-[border-color,box-shadow]">
                <NodeCover appearance={{ color: l.color, icon: l.icon, coverImageUrl: l.cover_image_url, coverTint: l.cover_tint }}
                  className="w-full h-14" rounded="rounded-none" iconSize="w-5 h-5" />
                <div className="p-2.5 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{l.name}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate">
                      {l.count != null ? `${l.count.toLocaleString()} document${l.count === 1 ? "" : "s"}` : (l.type || "Library")}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)] group-hover:translate-x-0.5 transition-all" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Inside a library ──────────────────────────────────────────────
  return (
    <div className="mt-3 flex-1 min-h-0 flex flex-col">
      {/* Where you are — every crumb is a way back. */}
      <div className="shrink-0 flex items-center gap-1 min-w-0">
        <button type="button" onClick={up} title={path.length ? "Up one folder" : "Back to all libraries"}
          className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-lg border border-[var(--color-border)] text-[11px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]">
          <ArrowUp className="w-3.5 h-3.5" /> Up
        </button>
        <nav className="min-w-0 flex-1 flex items-center gap-0.5 overflow-x-auto no-scrollbar text-[11px] font-bold">
          <button type="button" onClick={() => go(null)} className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" title="All libraries">
            <Home className="w-3.5 h-3.5" />
          </button>
          <ChevronRight className="w-3 h-3 shrink-0 text-[var(--color-text-faint)]" />
          <button type="button" onClick={() => { setPath([]); setQ(""); }}
            className={`shrink-0 px-1 rounded truncate max-w-[10rem] ${path.length ? "text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" : "text-[var(--color-text)]"}`}>
            {lib?.name ?? "Library"}
          </button>
          {path.map((f, i) => (
            <React.Fragment key={f.id}>
              <ChevronRight className="w-3 h-3 shrink-0 text-[var(--color-text-faint)]" />
              <button type="button" onClick={() => { setPath((p) => p.slice(0, i + 1)); setQ(""); }}
                className={`shrink-0 px-1 rounded truncate max-w-[10rem] ${i === path.length - 1 ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"}`}>
                {f.name}
              </button>
            </React.Fragment>
          ))}
          {refreshing && <Loader2 className="w-3 h-3 ml-1 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
        </nav>
        <Link href={openHere} title="Open this folder in Documents"
          className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-bold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
          Open here <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>
      <div className="mt-2 shrink-0">{search}</div>

      {results ?? (
        // Never show the previous folder's contents under the new crumb.
        !here || here.at !== `${libId}|${folderId ?? ""}` ? <Skeleton /> : (
          <div className={`${SCROLL} mt-2`}>
            {here.folders.length === 0 && here.docs.length === 0 ? (
              <Empty>This folder is empty.</Empty>
            ) : (
              <>
                {here.folders.length > 0 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 mb-2">
                    {here.folders.map((f) => (
                      <button key={f.id} type="button" onClick={() => { setPath((p) => [...p, f]); setQ(""); }}
                        className="group flex items-center gap-2 px-2.5 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-accent)] text-left transition-colors">
                        <Folder className="w-4 h-4 shrink-0 text-amber-500" fill="currentColor" fillOpacity={0.25} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{f.name}</span>
                        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
                      </button>
                    ))}
                  </div>
                )}
                {here.docs.length > 0 && (
                  <>
                    <div className="px-2 pb-1 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">
                      {here.docCount.toLocaleString()} document{here.docCount === 1 ? "" : "s"} here{here.docCount > here.docs.length ? ` · newest ${here.docs.length}` : ""}
                    </div>
                    <div className="space-y-0.5">
                      {here.docs.map((d) => <DocLine key={d.id} d={{ ...d, library_id: d.library_id ?? libId }} />)}
                    </div>
                    {here.docCount > here.docs.length && (
                      <Link href={openHere} className="mt-1 block px-2 py-1.5 text-[11px] font-bold text-[var(--color-accent)] hover:underline">
                        See all {here.docCount.toLocaleString()} in Documents →
                      </Link>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
