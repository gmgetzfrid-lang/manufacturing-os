"use client";

// Document Control — browse your libraries without leaving the dashboard.
//
// Libraries → folders → documents, right in the card: a breadcrumb you can
// click back along, an Up button, and the same search as Documents: tags,
// equipment IDs, drawing numbers and words inside the documents, with "E-22
// is on 3 units. Which one?" and a preview. The map sits beside the list at
// full height and shows where you are; tap a unit there to open its folder,
// a piece of equipment to search it. It all stays in the widget; Enter
// never takes you away. "Open here" opens the Documents page at the folder.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronRight, Folder, FileText, ArrowUpRight, Home, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { isControllerRole } from "@/lib/permissions";
import NodeCover from "@/components/documents/NodeCover";
import { useFind } from "@/components/find/useFind";
import FindPanel, { findMapState } from "@/components/find/FindPanel";
import FindMap from "@/components/find/FindMap";
import { folderUnit, folderForUnit } from "@/lib/findEverywhere";
import { TrendChip, MiniBars, dayBuckets } from "../viz";
import {
  useWidget, useSetting, useSessionState, useWidgetData, SearchField, Skeleton, Empty, timeAgo,
  headCount, fetchRecentDates, weekSplit, sum,
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
  const { activeRole, activeOrgId } = useRole();
  const router = useRouter();
  const { expanded } = useWidget();
  const [pinned] = useSetting<string[]>("libraryIds", []);
  // Where you are: a library and a folder path inside it.
  const [libId, setLibId] = useSessionState<string | null>("libId", null);
  const [path, setPath] = useSessionState<FolderRow[]>("path", []);
  const [q, setQ] = useState("");
  const folderId = path.length ? path[path.length - 1].id : null;
  // The unit of the folder you're in: the map follows it and a tag on
  // several units picks this unit's one.
  const [unit, setUnit] = useState<string | null>(null);
  const pathKey = path.map((f) => f.id).join("/");
  useEffect(() => {
    if (!activeOrgId || !path.length) { setUnit(null); return; }
    let alive = true;
    void folderUnit(activeOrgId, path.map((f) => ({ id: f.id, name: f.name }))).then((u) => { if (alive) setUnit(u); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, pathKey]);
  const finder = useFind(activeOrgId, q, unit, { controller: isControllerRole(activeRole) });
  const searching = q.trim().length >= 2;

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

  const libs = top?.libs ?? [];
  const lib = libId ? libs.find((l) => l.id === libId) ?? null : null;
  const go = (id: string | null) => { setLibId(id); setPath([]); setQ(""); };
  const up = () => { if (path.length) setPath((p) => p.slice(0, -1)); else go(null); };
  const openHere = libId ? `/documents/${libId}${folderId ? `?folderId=${folderId}` : ""}` : "/documents";

  if (topLoading) return <Skeleton />;
  if (libs.length === 0) {
    return <Empty><Link href="/admin/libraries" className="font-bold text-[var(--color-accent)] hover:underline">No libraries yet - create your first library →</Link></Empty>;
  }

  // ── The map: always beside the list, showing where you are ────────
  const ms = findMapState(finder);
  const openUnitFolder = async (code: string) => {
    if (!activeOrgId) return;
    const f = await folderForUnit(activeOrgId, code, libId);
    if (!f) return;
    setQ(""); setLibId(f.libraryId); setPath(f.chain.map((c) => ({ id: c.id, name: c.name, parent_id: c.parent_id })));
  };
  const map = activeOrgId ? (
    <FindMap orgId={activeOrgId} unit={searching ? (ms.unit ?? unit) : unit}
      assetId={searching ? ms.assetId : null} docs={searching ? ms.docs : null} candidates={searching ? ms.candidates : undefined}
      onPickAsset={(id, tag) => {
        if (searching && finder.quick?.equipment.some((e) => e.id === id)) finder.pick(id);
        else { setQ(tag); finder.pickWhenFound(id); }
      }}
      onUnit={(code) => void openUnitFolder(code)}
      onDoc={(d) => { if (searching && finder.docs[d.id]) finder.setPreview(d.id); else router.push(d.href); }}
      className="h-full" />
  ) : null;

  const search = (
    <SearchField value={q} onChange={setQ}
      placeholder="Search: tag, equipment ID, drawing number, words"
      title="Results, the map and a preview show right here" />
  );

  // List on the left, map on the right at full height; stacked when narrow.
  const shell = (head: React.ReactNode, left: React.ReactNode) => (
    <div className="mt-3 flex-1 min-h-0 flex flex-col">
      {head}
      <div className="shrink-0">{search}</div>
      <div className="mt-2 flex-1 min-h-0 @container">
        <div className="h-full flex flex-col @min-[34rem]:flex-row gap-3">
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain pr-0.5" data-widget-list>{left}</div>
          <div className="h-56 shrink-0 @min-[34rem]:h-auto @min-[34rem]:w-[44%]">{map}</div>
        </div>
      </div>
    </div>
  );

  const results = searching && activeOrgId ? (
    <div data-widget-find>
      <FindPanel orgId={activeOrgId} f={finder} unit={unit} compact hideMap
        onOpenFolder={(fo) => { setLibId(fo.libraryId); setPath([{ id: fo.id, name: fo.name, parent_id: null }]); setQ(""); }}
        onOpenHref={(href) => router.push(href)} />
    </div>
  ) : null;

  // ── Top level: the libraries, one line each ───────────────────────
  if (!libId) {
    const chosen = pinned.length ? (pinned.map((id) => libs.find((l) => l.id === id)).filter(Boolean) as Lib[]) : libs;
    const buckets = dayBuckets(top?.newDates ?? [], 14);
    const wk = weekSplit(top?.newDates ?? []);
    const head = (
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
    );
    return shell(head, results ?? (
      <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        {chosen.map((l) => (
          <button key={l.id} type="button" onClick={() => go(l.id)} data-widget-lib={l.id}
            className="group w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-surface-2)] transition-colors">
            <NodeCover appearance={{ color: l.color, icon: l.icon, coverImageUrl: l.cover_image_url, coverTint: l.cover_tint }}
              className="w-7 h-7 shrink-0" rounded="rounded-md" iconSize="w-3.5 h-3.5" />
            <span className="min-w-0 flex-1 text-[13px] font-bold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)]">{l.name}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-muted)]">{l.count != null ? `${l.count.toLocaleString()} doc${l.count === 1 ? "" : "s"}` : ""}</span>
            <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-text-faint)] group-hover:text-[var(--color-accent)]" />
          </button>
        ))}
      </div>
    ));
  }

  // ── Inside a library ──────────────────────────────────────────────
  const crumbs = (
    <div className="mb-2 shrink-0 flex items-center gap-1 min-w-0">
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
  );

  return shell(crumbs, results ?? (
    // Never show the previous folder's contents under the new crumb.
    !here || here.at !== `${libId}|${folderId ?? ""}` ? <Skeleton /> : (
      here.folders.length === 0 && here.docs.length === 0 ? (
        <Empty>This folder is empty.</Empty>
      ) : (
        <div className="space-y-2">
          {here.folders.length > 0 && (
            <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              {here.folders.map((f) => (
                <button key={f.id} type="button" onClick={() => { setPath((p) => [...p, f]); setQ(""); }} data-widget-folder={f.id}
                  className="group w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] transition-colors">
                  <Folder className="w-4 h-4 shrink-0 text-amber-500" fill="currentColor" fillOpacity={0.25} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">{f.name}</span>
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
                </button>
              ))}
            </div>
          )}
          {here.docs.length > 0 && (
            <div>
              <div className="px-1 pb-1 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">
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
            </div>
          )}
        </div>
      )
    )
  ));
}
