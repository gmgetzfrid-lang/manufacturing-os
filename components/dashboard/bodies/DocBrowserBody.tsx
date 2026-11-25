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
import { ArrowUp, ChevronRight, Folder, Library, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { isControllerRole } from "@/lib/permissions";
import { loadDocTop, type DocLib } from "@/lib/dashboard/widgetLoads";
import NodeCover from "@/components/documents/NodeCover";
import { useFind } from "@/components/find/useFind";
import FindPanel, { findMapState } from "@/components/find/FindPanel";
import FindMap from "@/components/find/FindMap";
import { folderUnit, folderForUnit } from "@/lib/findEverywhere";
import { TrendChip, MiniBars, dayBuckets } from "../viz";
import { StatusTag, rowBtn, link, humanDate, type StatusTone } from "@/components/cockpit/ui";
import {
  useWidget, useSetting, useSessionState, useWidgetData, SearchField, Skeleton, Empty,
  weekSplit, sum,
} from "../kit";

type Lib = DocLib;
interface FolderRow { id: string; name: string; parent_id: string | null; deleted_at?: string | null; visibility?: string | null; color?: string | null; icon?: string | null }
interface DocRow { id: string; document_number: string | null; title: string | null; name: string | null; rev: string | null; status: string | null; updated_at: string | null; collection_id: string | null; library_id?: string; sheet_meta?: string | null }

const DOC_COLS = "id, document_number, title, name, rev, status, updated_at, collection_id, library_id, sheet_meta:metadata->>sheet";

// A document's status as a quiet tag: green once issued, amber in review.
const STATUS_TONE: Record<string, StatusTone> = {
  Issued: "released", IFC: "released", "In Review": "held",
};

function DocLine({ d, folderName }: { d: DocRow; folderName?: string | null }) {
  // Its folder opens with it picked, not the top of the library.
  const href = `/documents/${d.library_id ?? ""}?${d.collection_id ? `folderId=${d.collection_id}&` : ""}doc=${d.id}`;
  return (
    <Link href={href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="ui-id text-reading truncate">{d.document_number || d.name || "Document"}</span>
          {d.rev && <span className="shrink-0 inline-flex items-center gap-1 text-body text-[var(--color-text-muted)]">Rev <span className="ui-count is-solid">{d.rev}</span></span>}
        </span>
        <span className="block text-body text-[var(--color-text-muted)] truncate">
          {d.title && d.title !== d.document_number ? d.title : (d.name ?? "")}
          {folderName ? `, in ${folderName}` : null}
        </span>
      </span>
      {d.status && <StatusTag tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</StatusTag>}
      <span className="shrink-0 w-20 text-right text-body text-[var(--color-text-muted)] tabular-nums">{d.updated_at ? humanDate(d.updated_at) : ""}</span>
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
  // Named: sign-in starts it, and Home opened again shows it at once
  // (lib/dashboard/widgetLoads).
  const { data: top, loading: topLoading } = useWidgetData((orgId) => loadDocTop(orgId), [], "docs.top");

  // ── Inside a library: this folder's subfolders + documents ────────
  const { data: here, refreshing } = useWidgetData(async (orgId) => {
    if (!libId) return null;
    const fq = supabase.from("collections").select("*").eq("library_id", libId).order("name");
    const folderRes = await (folderId ? fq.eq("parent_id", folderId) : fq.is("parent_id", null));
    if (folderRes.error) throw new Error(folderRes.error.message);
    const folders = ((folderRes.data ?? []) as FolderRow[])
      .filter((f) => !f.deleted_at && (isControllerRole(activeRole) || (f.visibility ?? "normal") === "normal"));
    let dq2 = supabase.from("documents").select(DOC_COLS, { count: "exact" })
      .eq("org_id", orgId).eq("library_id", libId).neq("status", "Archived");
    dq2 = folderId ? dq2.eq("collection_id", folderId) : dq2.is("collection_id", null);
    const docRes = await dq2.order("updated_at", { ascending: false }).limit(expanded ? 200 : 60);
    if (docRes.error) throw new Error(docRes.error.message);
    return { at: `${libId}|${folderId ?? ""}`, folders, docs: (docRes.data ?? []) as unknown as DocRow[], docCount: docRes.count ?? 0 };
  }, [libId, folderId, expanded]);

  const libs = top?.libs ?? [];
  const lib = libId ? libs.find((l) => l.id === libId) ?? null : null;
  const go = (id: string | null) => { setLibId(id); setPath([]); setQ(""); };
  const up = () => { if (path.length) setPath((p) => p.slice(0, -1)); else go(null); };
  const openHere = libId ? `/documents/${libId}${folderId ? `?folderId=${folderId}` : ""}` : "/documents";

  if (topLoading) return <Skeleton />;
  if (libs.length === 0) {
    return <Empty>No libraries yet. <Link href="/admin/libraries" className={link}>Create your first library</Link></Empty>;
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
      // Browsing a library: the map is the folder the list is in.
      folder={!searching && libId && here && here.at === `${libId}|${folderId ?? ""}` ? {
        id: folderId,
        name: path.length ? path[path.length - 1].name : (lib?.name ?? "Library"),
        subfolders: here.folders.map((f) => ({ id: f.id, name: f.name })),
        docs: here.docs.map((d) => ({ id: d.id, number: d.document_number, title: d.title, name: d.name, sheet: d.sheet_meta ?? null, href: "" })),
        more: Math.max(0, here.docCount - here.docs.length),
        up: path.length ? { id: path.length > 1 ? path[path.length - 2].id : null, name: path.length > 1 ? path[path.length - 2].name : (lib?.name ?? "Library") } : null,
      } : null}
      onFolder={(id) => {
        if (id === null) { setPath([]); return; }
        const at = path.findIndex((f) => f.id === id);
        if (at >= 0) { setPath(path.slice(0, at + 1)); return; }
        const f = here?.folders.find((x) => x.id === id);
        if (f) setPath([...path, f]);
      }}
      className="h-full" />
  ) : null;

  const search = (
    <SearchField value={q} onChange={setQ}
      placeholder="Search: tag, equipment ID, drawing number, words"
      title="Results, the map and a preview show right here" />
  );

  // List on the left, map on the right at full height; stacked when narrow.
  const shell = (head: React.ReactNode, left: React.ReactNode) => (
    <div className="flex-1 min-h-0 flex flex-col">
      {head}
      <div className="shrink-0">{search}</div>
      <div className="mt-3 flex-1 min-h-0 @container">
        <div className="h-full flex flex-col @min-[34rem]:flex-row gap-4">
          {/* On the widget's sheet itself: no second box inside it. */}
          <div className="-mx-4 @min-[34rem]:mr-0 flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain" data-widget-list>{left}</div>
          <div className="h-56 shrink-0 @min-[34rem]:h-auto @min-[34rem]:w-[44%]">{map}</div>
        </div>
      </div>
    </div>
  );

  const results = searching && activeOrgId ? (
    <div className="p-3" data-widget-find>
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
      // On a phone the week's line goes under the count instead of off the
      // edge.
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1 shrink-0">
        <span className="whitespace-nowrap text-body text-[var(--color-text-muted)]">
          {/* A count in words at the detail size: the page has its one big
              thing already, and a zero isn't news. */}
          {(top?.totalDocs ?? 0) === 0 ? "No controlled documents yet" : <><span className="font-semibold tabular-nums text-[var(--color-text)]">{(top?.totalDocs ?? 0).toLocaleString()}</span> controlled documents</>}
        </span>
        <div className="flex items-center gap-3 min-w-0">
          <TrendChip current={wk.cur} previous={wk.prev} what="new" />
          {sum(buckets.counts) > 0 && <div className="w-28 hidden sm:block" title="New documents, last 14 days"><MiniBars values={buckets.counts} labels={buckets.labels} height={24} /></div>}
        </div>
      </div>
    );
    return shell(head, results ?? (
      // A short list (the libraries): spaced, not ruled.
      <ul>
        {chosen.map((l) => (
          <li key={l.id}>
            <button type="button" onClick={() => go(l.id)} data-widget-lib={l.id}
              className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--color-surface-2)] transition-colors">
              {l.cover_image_url || l.color
                ? <NodeCover appearance={{ color: l.color, icon: l.icon, coverImageUrl: l.cover_image_url, coverTint: l.cover_tint }}
                    className="w-9 h-9 shrink-0" rounded="rounded-lg" iconSize="w-4 h-4" />
                : <span className="ui-icon-tile is-solid"><Library className="w-[18px] h-[18px]" /></span>}
              <span className="min-w-0 flex-1 text-reading font-medium text-[var(--color-text)] truncate">{l.name}</span>
              {/* An empty library shows no "0 docs": a zero isn't news. */}
              {l.count != null && l.count > 0 && <span className="shrink-0 inline-flex items-center gap-1.5 text-body text-[var(--color-text-muted)]"><span className="ui-count">{l.count.toLocaleString()}</span> doc{l.count === 1 ? "" : "s"}</span>}
              <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
            </button>
          </li>
        ))}
      </ul>
    ));
  }

  // ── Inside a library ──────────────────────────────────────────────
  const crumbs = (
    <div className="mb-3 shrink-0 flex items-center gap-2 min-w-0">
      <button type="button" onClick={up} title={path.length ? "Up one folder" : "Back to all libraries"} className={rowBtn}>
        <ArrowUp className="w-3.5 h-3.5" /> Up
      </button>
      <nav aria-label="Where you are" className="min-w-0 flex-1 flex items-center gap-1 overflow-x-auto no-scrollbar text-body">
        <button type="button" onClick={() => go(null)} className={`shrink-0 ${link}`}>All libraries</button>
        <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
        {path.length ? (
          <button type="button" onClick={() => { setPath([]); setQ(""); }} className={`shrink-0 truncate max-w-[10rem] ${link}`}>{lib?.name ?? "Library"}</button>
        ) : <span className="shrink-0 truncate max-w-[12rem] font-medium text-[var(--color-text)]" aria-current="location">{lib?.name ?? "Library"}</span>}
        {path.map((f, i) => (
          <React.Fragment key={f.id}>
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-faint)]" />
            {i === path.length - 1
              ? <span className="shrink-0 truncate max-w-[12rem] font-medium text-[var(--color-text)]" aria-current="location">{f.name}</span>
              : <button type="button" onClick={() => { setPath((p) => p.slice(0, i + 1)); setQ(""); }} className={`shrink-0 truncate max-w-[10rem] ${link}`}>{f.name}</button>}
          </React.Fragment>
        ))}
        {refreshing && <Loader2 className="w-3.5 h-3.5 ml-1 shrink-0 animate-spin text-[var(--color-text-faint)]" />}
      </nav>
      <Link href={openHere} title="Open this folder in Documents" className={`shrink-0 text-body ${link}`}>Open in Documents</Link>
    </div>
  );

  return shell(crumbs, results ?? (
    // Never show the previous folder's contents under the new crumb.
    !here || here.at !== `${libId}|${folderId ?? ""}` ? <Skeleton /> : (
      here.folders.length === 0 && here.docs.length === 0 ? (
        <p className="px-4 py-3 text-reading text-[var(--color-text-muted)]">This folder is empty.</p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {here.folders.length > 0 && (
            <ul className="divide-y divide-[var(--color-border)]">
              {here.folders.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => { setPath((p) => [...p, f]); setQ(""); }} data-widget-folder={f.id}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--color-surface-2)] transition-colors">
                    <span className="ui-icon-tile is-sm"><Folder className="w-4 h-4" fill="currentColor" fillOpacity={0.2} /></span>
                    <span className="min-w-0 flex-1 truncate text-reading font-medium text-[var(--color-text)]">{f.name}</span>
                    <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {here.docs.length > 0 && (
            <div>
              <div className="px-4 py-2 bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)]">
                {here.docCount.toLocaleString()} document{here.docCount === 1 ? "" : "s"} here{here.docCount > here.docs.length ? `, newest ${here.docs.length} shown` : ""}
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {here.docs.map((d) => <DocLine key={d.id} d={{ ...d, library_id: d.library_id ?? libId }} />)}
              </div>
              {here.docCount > here.docs.length && (
                <div className="px-4 py-2.5 border-t border-[var(--color-border)]">
                  <Link href={openHere} className={`text-body ${link}`}>See all {here.docCount.toLocaleString()} in Documents</Link>
                </div>
              )}
            </div>
          )}
        </div>
      )
    )
  ));
}
