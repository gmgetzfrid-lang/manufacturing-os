"use client";

// /documents/graph — find a file the way a person would, and see where it is.
//
// The whole document estate as a map (libraries → folders → files), plus any
// drive listings document control has pasted in. Type what you'd say out
// loud — "U1-A for the born heater pilot valve in 2018" — and the finder
// turns it into chips you can check, scores every file against them with
// its reasons written down, and lights the map where the candidates sit.
//
// Nothing here is a hard filter but empty bytes and OS junk. A file in the
// wrong unit's folder, a year off, or superseded is ranked down and TOLD,
// never hidden — the point is to find things people filed badly.

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Search, X, Loader2, Waypoints, HardDrive, Sparkles, Plus, Trash2,
  ExternalLink, ChevronRight, ChevronLeft, Info, AlertTriangle, Tag, Minus, Maximize2, Crosshair, Link2, Eye, Activity, Globe,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import FileGraph, { type FileGraphNode, type FileGraphLight, type FileGraphHandle, type FileGraphSatellite } from "@/components/documents/FileGraph";
import { globalGraphHref } from "@/lib/estate/lenses";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf, CONTAINER_TYPES } from "@/lib/fileFinder/fileTypes";
import {
  parseQuery, fromChips, rankEntries, clusterByHash, entriesFromListing, parseDirectoryListing,
  aliasConfidence, tagVariants,
  type ParsedQuery, type QueryChip, type RankedHit, type IndexEntry, type FinderAlias, type FinderAliasKind,
} from "@/lib/fileFinder";
import { loadFinderData, type FinderData } from "@/lib/fileFinder/load";
import { supabase } from "@/lib/supabase";
import { docRowToDocumentRecord } from "@/lib/documentRows";
import { rowToVersion } from "@/lib/revisions";
import type { DocumentRecord, DocumentVersion } from "@/types/schema";

// The drawing viewer is heavy (pdf.js); it only downloads when a file is opened.
const FullScreenViewer = React.lazy(() => import("@/components/viewers/FullScreenViewer"));
// Landing on a page with the tag ringed reuses the citation viewer.
const CitedPageViewer = React.lazy(() => import("@/components/knowledge/CitedPageViewer"));
import { listKnowledgeLibraries, type KnowledgeLibrary } from "@/lib/knowledge";
import type { FindCoverage } from "@/lib/find/types";
import {
  listFinderAliases, addFinderAlias, removeFinderAlias, bumpFinderAlias,
  listFinderListings, saveFinderListing, deleteFinderListing, storeState, type FinderListing,
} from "@/lib/fileFinder/stores";
import { estatePost } from "@/lib/estate/client";
import { triageListing } from "@/lib/fileFinder/triage";
import { findEstate } from "@/lib/find/client";
import type { FindResponse, FindRelation } from "@/lib/find/types";
import { EntityStrip, RelationChips, PageHits, ActivityPanel, CoverageLine } from "@/components/find/FindPanels";

const VERDICT_STYLE: Record<RankedHit["verdict"], string> = {
  strong: "bg-green-100 text-green-800 border-green-200",
  possible: "bg-yellow-100 text-yellow-800 border-yellow-200",
  weak: "bg-slate-100 text-slate-600 border-slate-200",
  rejected: "bg-red-100 text-red-700 border-red-200",
};
const VERDICT_LABEL: Record<RankedHit["verdict"], string> = {
  strong: "Strong", possible: "Possible", weak: "Weak", rejected: "Ditch",
};
const CHIP_STYLE: Record<QueryChip["kind"], string> = {
  identifier: "bg-blue-50 text-blue-800 border-blue-200",
  word: "bg-slate-50 text-slate-700 border-slate-200",
  phrase: "bg-slate-50 text-slate-800 border-slate-300",
  year: "bg-amber-50 text-amber-800 border-amber-200",
  unit: "bg-purple-50 text-purple-800 border-purple-200",
  sheet: "bg-teal-50 text-teal-800 border-teal-200",
  rev: "bg-teal-50 text-teal-800 border-teal-200",
  doctype: "bg-orange-50 text-orange-800 border-orange-200",
};

const LIT_CAP = 150;
const AUTO_EXPAND_TOP = 25;
/** How many nodes a drilled-in view fans out before deeper folders close. */
const AUTO_NODES = 90;

function GraphPageInner() {
  const { activeOrgId, activeRole, hasAnyRole, uid, userEmail } = useRole();
  const params = useSearchParams();
  const controller = hasAnyRole(["Admin", "DocCtrl"]);

  const [data, setData] = useState<FinderData | null>(null);
  const [aliases, setAliases] = useState<FinderAlias[]>([]);
  const [listings, setListings] = useState<FinderListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState(params.get("q") ?? "");
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  /** The container the view is rooted at; null = the whole estate. */
  const [focusId, setFocusId] = useState<string | null>(params.get("focus"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which result the map is honed in on. */
  const [activeIdx, setActiveIdx] = useState(0);
  /** A file opened in place: the viewer sits over the map, no navigation. */
  const [viewer, setViewer] = useState<{ doc: DocumentRecord; version: DocumentVersion } | null>(null);
  const [viewerLoading, setViewerLoading] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  /** The server's answer (tags, drawn-on, mentions, text, activity). The
   *  browser's own name/folder ranking shows instantly; this replaces it. */
  const [serverFind, setServerFind] = useState<FindResponse | null>(null);
  /** A sheet opened AT a page, with the tag ringed. */
  const [pageView, setPageView] = useState<{ fileKey: string; page: number; title: string; knowledgeDocId: string; tags: string[] } | null>(null);
  /** The "read these" chooser: which knowledge library should read a folder. */
  const [readAsk, setReadAsk] = useState<{ folder: FindCoverage["unreadFolders"][number]; libs: KnowledgeLibrary[]; pick: string; busy: boolean; note: string | null } | null>(null);
  const [finding, setFinding] = useState(false);
  const findSeq = useRef(0);

  /** Document control runs the resolver over the whole estate on demand. */
  const runResolver = async () => {
    if (!activeOrgId) return;
    setResolving(true); setResolveNote(null);
    try {
      const r = await estatePost<{ folders: number; documents: number; applied: number; pending: number; unchanged: number; notes: string[] }>("/api/estate/resolve", { orgId: activeOrgId, all: true });
      setResolveNote(`${r.folders} folders, ${r.documents} documents looked at — ${r.applied} links applied, ${r.pending} waiting in Review, ${r.unchanged} already known.${r.notes.length ? " " + r.notes.join(" ") : ""}`);
      await refresh();
    } catch (e) { setResolveNote((e as Error).message); }
    finally { setResolving(false); }
  };
  const [panel, setPanel] = useState<"search" | "drives" | "aliases">("search");
  const graphRef = useRef<FileGraphHandle | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const [d, a, l] = await Promise.all([
        loadFinderData(activeOrgId, activeRole, controller),
        listFinderAliases(activeOrgId),
        listFinderListings(activeOrgId),
      ]);
      setData(d); setAliases(a); setListings(l);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId, activeRole, controller]);
  useEffect(() => { void refresh(); }, [refresh]);

  // ── The index: system entries + every listing's entries ───────────────
  const listingEntries = useMemo(
    () => listings.flatMap((l) => entriesFromListing({ id: l.id, name: l.name, files: l.files })),
    [listings],
  );
  const entries = useMemo(() => [...(data?.entries ?? []), ...listingEntries], [data, listingEntries]);
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const sameBytesByHash = useMemo(() => clusterByHash(entries), [entries]);
  const systemHashes = useMemo(() => new Set((data?.entries ?? []).map((e) => e.hash).filter((h): h is string => !!h)), [data]);
  const sameBytesById = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const group of sameBytesByHash.values()) for (const e of group) m.set(e.id, group.filter((x) => x.id !== e.id).map((x) => x.id));
    return m;
  }, [sameBytesByHash]);

  // ── The map: libraries, folders, files, drives ────────────────────────
  const nodes = useMemo<FileGraphNode[]>(() => {
    if (!data) return [];
    const out: FileGraphNode[] = [];
    const counts = new Map<string, number>();
    const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    const folderParent = (f: { parentId: string | null; libraryId: string }) => (f.parentId && data.folders.has(f.parentId) ? `folder:${f.parentId}` : `lib:${f.libraryId}`);
    for (const f of data.folders.values()) bump(folderParent(f));
    for (const e of data.entries) bump(e.folderId && data.folders.has(e.folderId) ? `folder:${e.folderId}` : `lib:${e.libraryId}`);
    for (const l of data.libraries) out.push({ id: `lib:${l.id}`, kind: "library", label: l.name, parentId: null, childCount: counts.get(`lib:${l.id}`) ?? 0, type: CONTAINER_TYPES.library });
    const unitLabel = (code?: string) => { const u = data.units.find((x) => x.code === code); return u ? ` · ${u.label}` : ""; };
    for (const f of data.folders.values()) out.push({ id: `folder:${f.id}`, kind: "folder", label: f.name, parentId: folderParent(f), childCount: counts.get(`folder:${f.id}`) ?? 0, type: f.unitCode ? { ...CONTAINER_TYPES.folder, label: `Folder${unitLabel(f.unitCode)}` } : CONTAINER_TYPES.folder });
    for (const e of data.entries) {
      out.push({ id: e.id, kind: "file", label: e.name, parentId: e.folderId && data.folders.has(e.folderId) ? `folder:${e.folderId}` : `lib:${e.libraryId}`, childCount: 0, type: fileTypeOf(e.name) });
    }
    for (const l of listings) {
      const drive = `drive:${l.id}`;
      const folderIds = new Set<string>();
      const le = listingEntries.filter((e) => e.listingId === l.id);
      for (const e of le) {
        for (let i = 0; i < e.pathIds.length; i++) folderIds.add(e.pathIds[i]);
      }
      for (const p of l.folders ?? []) folderIds.add(`extf:${l.id}:${p}`);
      const fcount = new Map<string, number>();
      const parentOf = (fid: string) => {
        const rel = fid.slice(`extf:${l.id}:`.length);
        const segs = rel.split("/");
        return segs.length > 1 ? `extf:${l.id}:${segs.slice(0, -1).join("/")}` : drive;
      };
      for (const fid of folderIds) { const p = parentOf(fid); fcount.set(p, (fcount.get(p) ?? 0) + 1); }
      for (const e of le) { const p = e.pathIds.length ? e.pathIds[e.pathIds.length - 1] : drive; fcount.set(p, (fcount.get(p) ?? 0) + 1); }
      out.push({ id: drive, kind: "drive", label: l.name, parentId: null, childCount: fcount.get(drive) ?? 0, type: CONTAINER_TYPES.drive });
      for (const fid of folderIds) {
        const rel = fid.slice(`extf:${l.id}:`.length);
        out.push({ id: fid, kind: "extfolder", label: rel.split("/").pop() ?? rel, parentId: parentOf(fid), childCount: fcount.get(fid) ?? 0, type: { ...CONTAINER_TYPES.folder, color: "#0d9488" } });
      }
      for (const e of le) out.push({ id: e.id, kind: "extfile", label: e.name, parentId: e.pathIds.length ? e.pathIds[e.pathIds.length - 1] : drive, childCount: 0, type: fileTypeOf(e.name) });
    }
    return out;
  }, [data, listings, listingEntries]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ── Search ────────────────────────────────────────────────────────────
  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) { setParsed(null); setServerFind(null); return; }
    setParsed(parseQuery(trimmed, { units: data?.units ?? [], aliases }));
    if (!activeOrgId) return;
    const seq = ++findSeq.current;
    setFinding(true);
    findEstate({ orgId: activeOrgId, query: trimmed, limit: 200 })
      .then((r) => { if (seq === findSeq.current) setServerFind(r); })
      .catch(() => { if (seq === findSeq.current) setServerFind(null); })
      .finally(() => { if (seq === findSeq.current) setFinding(false); });
  }, [data, aliases, activeOrgId]);

  const ancestorsOf = useCallback((id: string) => {
    const out: string[] = [];
    let p = nodeById.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) { seen.add(p); out.push(p); p = nodeById.get(p)?.parentId ?? null; }
    return out;
  }, [nodeById]);

  const localHits = useMemo<RankedHit[]>(() => {
    if (!parsed || !parsed.chips.length) return [];
    return rankEntries(entries, parsed, { units: data?.units ?? [], sameBytes: sameBytesByHash });
  }, [parsed, entries, data, sameBytesByHash]);
  // Server results, mapped onto the entries this browser holds (listing hits
  // the server does not know about are kept from the local ranking).
  const serverById = useMemo(() => new Map((serverFind?.results ?? []).map((r) => [r.id, r])), [serverFind]);
  const allHits = useMemo<RankedHit[]>(() => {
    if (!serverFind) return localHits;
    const out: RankedHit[] = [];
    for (const r of serverFind.results) {
      const entry = entryById.get(r.id);
      if (!entry) continue;
      const same = (entry.hash && sameBytesByHash.get(entry.hash)?.filter((x) => x.id !== entry.id)) || [];
      out.push({ entry, score: r.score, verdict: r.verdict, evidence: r.evidence, sameBytes: same });
    }
    for (const h of localHits) if (h.entry.source === "listing") out.push(h);
    return out;
  }, [serverFind, localHits, entryById, sameBytesByHash]);

  // Exploring a folder narrows the results to what is inside it.
  const hits = useMemo(() => (focusId ? allHits.filter((h) => ancestorsOf(h.entry.id).includes(focusId)) : allHits), [allHits, focusId, ancestorsOf]);
  const hiddenHits = allHits.length - hits.length;

  const lit = useMemo(() => {
    const m = new Map<string, FileGraphLight>();
    for (const h of hits.slice(0, LIT_CAP)) m.set(h.entry.id, { verdict: h.verdict, score: h.score });
    return m;
  }, [hits]);

  // ── What is in view ───────────────────────────────────────────────────
  // Rooted at the focus (or at the libraries and drives), the subtree fans
  // out level by level until the view would get crowded; folders past that
  // point are shown closed with a count, and a click explores them. The
  // folders on the way to the best search hits are always opened.
  const childrenOf = useMemo(() => {
    const m = new Map<string, FileGraphNode[]>();
    for (const n of nodes) if (n.parentId) { const arr = m.get(n.parentId) ?? []; arr.push(n); m.set(n.parentId, arr); }
    return m;
  }, [nodes]);
  const { visible, collapsed, upNode } = useMemo(() => {
    const vis = new Map<string, FileGraphNode>();
    const roots = focusId && nodeById.has(focusId) ? [nodeById.get(focusId)!] : nodes.filter((n) => !n.parentId);
    for (const r of roots) vis.set(r.id, r);
    if (focusId) {
      let frontier = roots, count = roots.length, first = true;
      while (frontier.length) {
        const kids = frontier.flatMap((n) => childrenOf.get(n.id) ?? []);
        if (!kids.length) break;
        if (!first && count + kids.length > AUTO_NODES) break;
        for (const k of kids) vis.set(k.id, k);
        count += kids.length; first = false;
        frontier = kids.filter((k) => k.kind !== "file" && k.kind !== "extfile");
      }
    }
    // The way to the best hits — and to the one being looked at — is always
    // open, inside the focus or across the estate.
    const wanted = hits.slice(0, AUTO_EXPAND_TOP);
    if (hits[activeIdx] && !wanted.includes(hits[activeIdx])) wanted.push(hits[activeIdx]);
    for (const h of wanted) {
      const chain = ancestorsOf(h.entry.id);
      const cut = focusId ? chain.indexOf(focusId) : chain.length;
      if (focusId && cut < 0) continue;
      for (const id of chain.slice(0, cut)) { const n = nodeById.get(id); if (n) vis.set(id, n); }
      const n = nodeById.get(h.entry.id); if (n) vis.set(n.id, n);
    }
    const collapsed = new Set<string>();
    for (const n of vis.values()) {
      if (n.kind === "file" || n.kind === "extfile") continue;
      const kids = childrenOf.get(n.id) ?? [];
      if (kids.some((k) => !vis.has(k.id))) collapsed.add(n.id);
    }
    const focusNode = focusId ? nodeById.get(focusId) : null;
    const upNode = focusNode ? (focusNode.parentId ? nodeById.get(focusNode.parentId) ?? null : { id: "__all__", kind: "library" as const, label: "Whole estate", parentId: null, childCount: 0, type: { ...CONTAINER_TYPES.library, color: "#475569" } }) : null;
    return { visible: [...vis.values()], collapsed, upNode };
  }, [nodes, nodeById, childrenOf, focusId, hits, activeIdx, ancestorsOf]);

  // Entities the search resolved, drawn beside the files they relate to.
  const satellites = useMemo<FileGraphSatellite[]>(() => {
    if (!serverFind) return [];
    const out: FileGraphSatellite[] = [];
    for (const ent of serverFind.entities) {
      const links: FileGraphSatellite["links"] = [];
      for (const r of serverFind.results) for (const rel of r.relations) if (rel.node === ent.node && nodeById.has(r.id)) links.push({ to: r.id, kind: rel.rel });
      if (ent.kind === "unit") for (const r of serverFind.results) if (nodeById.has(r.id) && entryById.get(r.id)?.unitCodes.includes(ent.node.slice(7))) links.push({ to: r.id, kind: "linked_unit" });
      if (!links.length) continue;
      out.push({ id: ent.node, label: ent.label, sub: ent.kind === "asset" ? `Equipment${ent.sub ? ` · ${ent.sub}` : ""}` : ent.kind === "unit" ? "Unit" : "Project",
        color: ent.kind === "asset" ? "#059669" : ent.kind === "unit" ? "#7c3aed" : "#d97706", iconKey: ent.kind === "asset" ? "file" : ent.kind === "unit" ? "library" : "folder", href: ent.href, links });
    }
    return out;
  }, [serverFind, nodeById, entryById]);

  // Symbolic links ("also filed under") between files and folders on the map.
  const filedLinks = useMemo<Array<[string, string]>>(() => {
    if (!data) return [];
    return data.edges.filter((e) => e.type === "filed_under" && e.a.startsWith("doc:") && e.b.startsWith("folder:")).map((e) => [e.a, e.b] as [string, string]);
  }, [data]);

  const ranks = useMemo(() => {
    const m = new Map<string, number>();
    hits.slice(0, 9).forEach((h, i) => m.set(h.entry.id, i + 1));
    return m;
  }, [hits]);
  const activeHit = hits[activeIdx] ?? null;

  // A new result set hones the map in on its best hit; stepping does the same
  // for the next one. The camera moves after the layout has the node.
  const jumpTo = useCallback((i: number) => {
    if (!hits.length) return;
    const idx = ((i % hits.length) + hits.length) % hits.length;
    setActiveIdx(idx);
    setSelectedId(hits[idx].entry.id);
    window.setTimeout(() => graphRef.current?.focus(hits[idx].entry.id, 1.6), 90);
  }, [hits]);
  const lastHitsKey = useRef("");
  useEffect(() => {
    const key = hits.slice(0, 5).map((h) => h.entry.id).join("|");
    if (key === lastHitsKey.current) return;
    lastHitsKey.current = key;
    if (hits.length) jumpTo(0); else { setActiveIdx(0); }
  }, [hits, jumpTo]);

  // The query and the folder being explored live in the URL, so leaving and
  // coming back (browser Back, a refresh, "go to it in the library") lands on
  // the same view with the same results — never on an empty map.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (parsed?.raw) sp.set("q", parsed.raw); else sp.delete("q");
    if (focusId) sp.set("focus", focusId); else sp.delete("focus");
    const next = `${window.location.pathname}${sp.toString() ? `?${sp}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [parsed, focusId]);

  const crumbs = useMemo(() => {
    if (!focusId) return [];
    const chain = [focusId, ...ancestorsOf(focusId)].reverse();
    return chain.map((id) => nodeById.get(id)).filter((n): n is FileGraphNode => !!n);
  }, [focusId, ancestorsOf, nodeById]);

  // ?q= runs once data is in; ?reveal=<node id> lands on that node.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current || !data) return;
    ranInitial.current = true;
    if (query.trim()) runSearch(query);
    const rv = params.get("reveal");
    if (rv && nodeById.has(rv)) {
      const n = nodeById.get(rv)!;
      if (n.kind === "file" || n.kind === "extfile") { if (n.parentId) setFocusId(n.parentId); setSelectedId(rv); window.setTimeout(() => graphRef.current?.focus(rv, 1.6), 120); }
      else setFocusId(rv);
    }
  }, [data, query, runSearch, params, nodeById]);

  const removeChip = (chip: QueryChip) => {
    if (!parsed) return;
    const rest = parsed.chips.filter((c) => c !== chip);
    setParsed(fromChips(parsed.raw, rest));
    if (chip.via === "alias" && chip.aliasId && activeOrgId) void bumpFinderAlias(activeOrgId, chip.aliasId, "miss");
  };
  const onOpenHit = () => {
    if (!parsed || !activeOrgId) return;
    // Every alias chip that contributed evidence to this hit gets credit.
    const usedAliasIds = new Set(parsed.chips.filter((c) => c.via === "alias" && c.aliasId).map((c) => c.aliasId!));
    for (const id of usedAliasIds) void bumpFinderAlias(activeOrgId, id, "hit");
  };
  const drill = useCallback((id: string | null) => { setFocusId(id); setSelectedId(null); }, []);
  const up = useCallback(() => {
    const cur = focusId ? nodeById.get(focusId) : null;
    drill(cur?.parentId ?? null);
  }, [focusId, nodeById, drill]);
  /** Show a file: explore its folder, select it, fly to it. */
  const reveal = (id: string) => {
    const n = nodeById.get(id);
    if (n?.parentId && n.parentId !== focusId) setFocusId(n.parentId);
    setSelectedId(id);
    window.setTimeout(() => graphRef.current?.focus(id), 80);
  };
  /** Open ON the page: the read copy's file at that sheet, with the tag
   *  ringed where it was read. Falls back to the plain viewer for a file
   *  whose contents have not been read. */
  const openAtPage = (id: string, page: number, tag?: string) => {
    const r = serverById.get(id);
    const entry = entryById.get(id);
    if (r?.read?.fileKey) {
      onOpenHit();
      setPageView({ fileKey: r.read.fileKey, page, title: entry?.name ?? r.name, knowledgeDocId: r.read.knowledgeDocId, tags: tag ? [tag] : [] });
      return;
    }
    void openEntry(id);
  };
  const askToRead = async (f: FindCoverage["unreadFolders"][number]) => {
    if (!activeOrgId) return;
    const libs = await listKnowledgeLibraries(activeOrgId).catch(() => [] as KnowledgeLibrary[]);
    setReadAsk({ folder: f, libs, pick: libs[0]?.id ?? "", busy: false, note: libs.length ? null : "No knowledge library yet — create one under Intelligence › Knowledge first." });
  };
  const linkAndRead = async () => {
    if (!readAsk || !activeOrgId || !readAsk.pick) return;
    setReadAsk({ ...readAsk, busy: true, note: null });
    try {
      await estatePost("/api/knowledge/sources", { orgId: activeOrgId, libraryId: readAsk.pick, add: [{ type: readAsk.folder.folderId ? "folder" : "library", id: readAsk.folder.folderId ?? readAsk.folder.libraryId }] });
      setReadAsk({ ...readAsk, busy: false, note: `Linked. Text pages read for free; pages with no text use vision on the cheap tier within your cap. Indexing runs in the background — or open the knowledge library to watch it.` });
    } catch (e) { setReadAsk({ ...readAsk, busy: false, note: (e as Error).message }); }
  };

  /** Open a system document right here: fetch its row and current version,
   *  then put the viewer over the map. The library page is never loaded. */
  const openEntry = useCallback(async (id: string) => {
    const e = entryById.get(id);
    if (!e || e.source !== "system") return;
    const docId = id.replace(/^doc:/, "");
    onOpenHit();
    setViewerError(null);
    setViewerLoading(id);
    try {
      const { data: row, error } = await supabase.from("documents").select("*").eq("id", docId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) throw new Error("That document is no longer available.");
      const doc = docRowToDocumentRecord(row as Record<string, unknown>);
      let vrow: Record<string, unknown> | null = null;
      if (doc.currentVersionId) {
        const { data } = await supabase.from("document_versions").select("*").eq("id", doc.currentVersionId).maybeSingle();
        vrow = (data as Record<string, unknown> | null) ?? null;
      }
      if (!vrow) {
        const { data } = await supabase.from("document_versions").select("*").eq("record_id", docId)
          .or("review_state.is.null,review_state.eq.approved").order("created_at", { ascending: false }).limit(1);
        vrow = ((data as Record<string, unknown>[] | null) ?? [])[0] ?? null;
      }
      if (!vrow) throw new Error("This document has no file to open yet.");
      setViewer({ doc, version: rowToVersion(vrow) });
    } catch (err) {
      setViewerError((err as Error).message);
    } finally {
      setViewerLoading(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryById, parsed, activeOrgId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.key === "ArrowRight" || e.key === "n") { if (hits.length) { e.preventDefault(); jumpTo(activeIdx + 1); } return; }
      if (e.key === "ArrowLeft" || e.key === "p") { if (hits.length) { e.preventDefault(); jumpTo(activeIdx - 1); } return; }
      if (e.key === "Enter") { const id = selectedId ?? hits[activeIdx]?.entry.id; if (id) { e.preventDefault(); openEntry(id); } return; }
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      if (selectedId) { setSelectedId(null); return; }
      if (focusId) { e.preventDefault(); up(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectedEntry = selectedId ? entryById.get(selectedId) : undefined;
  const selectedHit = selectedId ? hits.find((h) => h.entry.id === selectedId) : undefined;

  if (!activeOrgId) return null;

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}
      <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr_380px]">
        {/* ── Left: search, drives, aliases ───────────────────────────── */}
        <aside className="border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col min-h-0">
          <div className="flex border-b border-[var(--color-border)] text-xs font-bold">
            {([["search", "Find", Search], ["drives", "Drives", HardDrive], ["aliases", "Aliases", Tag]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setPanel(k)}
                className={`flex-1 px-2 py-2 inline-flex items-center justify-center gap-1 border-b-2 ${panel === k ? "border-[var(--color-accent)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)]"}`}>
                <Icon className="w-3.5 h-3.5" /> {label}
                {k === "drives" && listings.length > 0 && <span className="ml-1 px-1.5 rounded-full bg-teal-100 text-teal-800">{listings.length}</span>}
                {k === "aliases" && aliases.length > 0 && <span className="ml-1 px-1.5 rounded-full bg-purple-100 text-purple-800">{aliases.length}</span>}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {panel === "search" && (
              <>
                <form onSubmit={(e) => { e.preventDefault(); runSearch(query); }} className="space-y-2">
                  <label className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Say what you&apos;re after</label>
                  <textarea
                    value={query} onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSearch(query); } }}
                    rows={3} placeholder="U1-A for the born heater pilot valve in 2018"
                    className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-ring)]"
                  />
                  <div className="flex gap-2">
                    <button type="submit" disabled={loading} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-bold px-3 py-2 disabled:opacity-50">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Find
                    </button>
                    {parsed && (
                      <button type="button" onClick={() => { setParsed(null); setServerFind(null); setQuery(""); }} className="rounded-lg border border-[var(--color-border)] px-3 text-sm"><X className="w-4 h-4" /></button>
                    )}
                  </div>
                </form>

                {parsed && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] flex items-center gap-1">
                      What I understood <Info className="w-3 h-3" />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {parsed.chips.map((c, i) => (
                        <span key={i} title={c.via === "alias" ? `Through a taught alias (${Math.round(c.confidence * 100)}% trusted)` : c.via === "codebook" ? "From the Site Codebook" : "Typed"}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${CHIP_STYLE[c.kind]}`}>
                          <span className="opacity-60">{c.kind === "identifier" ? "#" : c.kind === "unit" ? "unit" : c.kind === "year" ? "yr" : c.kind === "phrase" ? "“”" : c.kind === "doctype" ? "type" : ""}</span>
                          {c.label}
                          {c.via !== "typed" && <span className="opacity-60">· {c.via}</span>}
                          <button onClick={() => removeChip(c)} className="opacity-50 hover:opacity-100"><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                      {parsed.chips.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">Nothing to search on — add a tag, a word or a year.</span>}
                    </div>
                    {parsed.identifiers.length > 0 && (
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        Also matching {parsed.identifiers.map((c) => tagVariants(c.value).filter((v) => v !== c.label).join(", ")).join("; ")}
                      </div>
                    )}
                  </div>
                )}

                <div className="text-xs text-[var(--color-text-muted)] space-y-1 pt-2 border-t border-[var(--color-border)]">
                  <div className="font-bold text-[var(--color-text)]">How it ranks</div>
                  <div>Codes, words and phrases in the name count most; the folder chain counts less.</div>
                  <div>Exact beats contained beats close: &ldquo;10-1-15&rdquo; still finds EP10-1-15 and says the EP was missing; a typo finds the real one and says how far off it was.</div>
                  <div>A folder naming a <em>different</em> codebook unit is ranked down. A year off is a nudge, not a wall. Empty files and OS junk are ditched.</div>
                </div>
                {data?.truncations.map((t, i) => <div key={i} className="text-[11px] text-amber-700">{t}</div>)}
              </>
            )}

            {panel === "drives" && (
              <DrivesPanel orgId={activeOrgId} controller={controller} listings={listings} uid={uid} userEmail={userEmail} systemHashes={systemHashes}
                onChange={setListings} onReveal={(id) => drill(id)} />
            )}
            {panel === "aliases" && (
              <AliasesPanel orgId={activeOrgId} controller={controller} aliases={aliases} uid={uid} userEmail={userEmail} units={data?.units ?? []} onChange={setAliases} />
            )}
          </div>
        </aside>

        {/* ── Centre: the map ─────────────────────────────────────────── */}
        <main className="relative min-h-0 bg-[var(--color-canvas)]">
          {loading && !data ? (
            <div className="absolute inset-0 grid place-items-center text-sm text-[var(--color-text-muted)]">
              <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Reading the estate…</span>
            </div>
          ) : (
            <FileGraph ref={graphRef} visible={visible} collapsed={collapsed} upNode={upNode} sameBytes={sameBytesById} lit={lit} ranks={ranks} activeId={activeHit?.entry.id ?? null} selectedId={selectedId} onSelect={setSelectedId} onDrill={drill} onUp={up} onOpen={openEntry}
              satellites={satellites} onSatellite={(sat) => { if (sat.href) window.location.assign(sat.href); else window.location.assign(globalGraphHref(sat.id)); }} filedLinks={filedLinks} />
          )}
          <div className="absolute top-3 left-3 right-3 flex items-start justify-between gap-2 text-[11px] pointer-events-none">
            <div className="flex flex-wrap items-center gap-1 pointer-events-auto">
              <button onClick={() => drill(null)} className={`rounded-md border px-2 py-1 inline-flex items-center gap-1 font-semibold ${focusId ? "bg-[var(--color-surface)]/90 border-[var(--color-border)]" : "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-transparent"}`}>
                <Waypoints className="w-3.5 h-3.5" /> Whole estate
              </button>
              {crumbs.map((c, i) => (
                <React.Fragment key={c.id}>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                  <button onClick={() => drill(c.id)} className={`rounded-md border px-2 py-1 inline-flex items-center gap-1 font-semibold max-w-[220px] bg-[var(--color-surface)]/95 ${i === crumbs.length - 1 ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent-ring)]" : "border-[var(--color-border)]"}`}>
                    <FileTypeIcon type={c.type} className="w-3.5 h-3.5" /> <span className="truncate">{c.label}</span>
                  </button>
                </React.Fragment>
              ))}
              {focusId && (
                <span className="ml-1 text-[var(--color-text-muted)]">
                  {(childrenOf.get(focusId) ?? []).filter((n) => n.kind === "file" || n.kind === "extfile").length} files · {(childrenOf.get(focusId) ?? []).filter((n) => n.kind !== "file" && n.kind !== "extfile").length} folders inside
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 pointer-events-auto">
              {controller && (
                <button onClick={runResolver} disabled={resolving || data?.estateMissing} title={data?.estateMissing ? "Apply migration 20261020 first" : "Link every folder and file to its unit, project and equipment from names and ancestry"}
                  className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50">
                  {resolving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} Resolve links
                </button>
              )}
              {focusId && <button onClick={up} className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1"><Minus className="w-3 h-3" /> Up</button>}
              <button onClick={() => graphRef.current?.fit()} className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1"><Maximize2 className="w-3 h-3" /> Fit</button>
              <Link href={globalGraphHref(selectedId ?? focusId ?? "")} title="The same node on the Intelligence graph — equipment, units, projects and documents in one web"
                className={`rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1 ${selectedId || focusId ? "" : "opacity-50 pointer-events-none"}`}><Globe className="w-3 h-3" /> Global view</Link>
              <span className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1">
                {data ? `${data.libraries.length} libraries · ${data.folders.size} folders · ${data.entries.length} files` : "…"}
                {listingEntries.length > 0 && ` · ${listingEntries.length} on drives`}
              </span>
            </div>
          </div>
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 text-[11px]">
            {[CONTAINER_TYPES.library, CONTAINER_TYPES.folder, CONTAINER_TYPES.drive, fileTypeOf("x.pdf"), fileTypeOf("x.dwg"), fileTypeOf("x.xlsx"), fileTypeOf("x.docx"), fileTypeOf("x.xml"), fileTypeOf("x.png")].map((t) => (
              <span key={t.key + t.ext} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><FileTypeIcon type={t} className="w-3.5 h-3.5" /> {t.label}</span>
            ))}
            {([["#16a34a", "Strong"], ["#eab308", "Possible"], ["#94a3b8", "Weak"], ["#ef4444", "Ditch"]] as const).map(([c, l]) => (
              <span key={l} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: c }} /> {l}</span>
            ))}
            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><span className="w-4 border-t-2 border-dashed border-red-600" /> Same bytes</span>
            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><span className="w-4 border-t-2 border-dashed border-amber-600" /> Also filed under</span>
          </div>
          {activeHit && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-12 flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 shadow-md px-2 py-1.5 text-xs">
              <button onClick={() => jumpTo(activeIdx - 1)} className="rounded-md border border-[var(--color-border)] p-1 hover:bg-[var(--color-canvas)]" title="Previous result (←)"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => jumpTo(activeIdx)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-[var(--color-canvas)]" title="Centre on this result">
                <Crosshair className="w-3.5 h-3.5 text-sky-600" />
                <span className="font-bold tabular-nums">{activeIdx + 1}</span><span className="text-[var(--color-text-muted)]">/ {hits.length}</span>
                <span className={`rounded-full border px-1.5 py-px text-[10px] font-bold ${VERDICT_STYLE[activeHit.verdict]}`}>{VERDICT_LABEL[activeHit.verdict]} · {activeHit.score}</span>
                <FileTypeIcon type={fileTypeOf(activeHit.entry.name)} className="w-3.5 h-3.5" />
                <span className="font-semibold max-w-[260px] truncate">{activeHit.entry.name}</span>
              </button>
              <button onClick={() => jumpTo(activeIdx + 1)} className="rounded-md border border-[var(--color-border)] p-1 hover:bg-[var(--color-canvas)]" title="Next result (→)"><ChevronRight className="w-4 h-4" /></button>
              {activeHit.entry.href && (
                <button onClick={() => openEntry(activeHit.entry.id)} disabled={viewerLoading === activeHit.entry.id} className="ml-1 inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-2 py-1 font-bold disabled:opacity-60" title="Open (Enter)">
                  {viewerLoading === activeHit.entry.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />} Open
                </button>
              )}
            </div>
          )}
          {resolveNote && (
            <div className="absolute top-12 right-3 max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-3 py-2 text-xs shadow-md flex items-start gap-2">
              <Link2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>{resolveNote}</span>
              <button onClick={() => setResolveNote(null)} className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          <div className="absolute bottom-3 right-3 text-[11px] text-[var(--color-text-muted)]">Click a folder to explore it · click a file for details · double-click to open · ← → step results · Esc goes up</div>
        </main>

        {/* ── Right: results / selection ──────────────────────────────── */}
        <aside className="border-l border-[var(--color-border)] bg-[var(--color-surface)] min-h-0 overflow-y-auto">
          {selectedEntry && (
            <SelectedCard entry={selectedEntry} hit={selectedHit} sameBytes={(sameBytesById.get(selectedEntry.id) ?? []).map((id) => entryById.get(id)).filter((x): x is IndexEntry => !!x)}
              onClose={() => setSelectedId(null)} onReveal={reveal} onOpen={() => openEntry(selectedEntry.id)} />
          )}
          <div className="p-3">
            {parsed ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
                    {hits.length} candidate{hits.length === 1 ? "" : "s"}{focusId ? " here" : ""}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {hits.filter((h) => h.verdict === "strong").length} strong · {hits.filter((h) => h.verdict === "possible").length} possible
                  </div>
                </div>
                {hiddenHits > 0 && (
                  <button onClick={() => drill(null)} className="mb-2 w-full text-left rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                    {hiddenHits} more candidate{hiddenHits === 1 ? "" : "s"} outside {crumbs[crumbs.length - 1]?.label ?? "this folder"} — show the whole estate
                  </button>
                )}
                {serverFind && serverFind.entities.length > 0 && <div className="mb-2"><EntityStrip entities={serverFind.entities} /></div>}
                {finding && <div className="mb-2 text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking tags, drawings, text and work in flight…</div>}
                {serverFind && serverFind.hidden.count > 0 && (
                  <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">
                    {serverFind.hidden.count} hidden because you asked for a different type: {Object.entries(serverFind.hidden.byType).map(([t, n]) => `${n} ${t}`).join(", ")}.
                  </div>
                )}
                {hits.length === 0 && hiddenHits === 0 && !finding && (
                  <div className="text-sm text-[var(--color-text-muted)]">
                    Nothing in the system or on any pasted drive listing matched. Try fewer words, or teach an alias if people call this something else.
                  </div>
                )}
                <div className="space-y-2">
                  {(() => {
                    const idx = new Map(hits.map((h, i) => [h.entry.id, i]));
                    const card = (h: RankedHit) => (
                      <HitCard key={h.entry.id} hit={h} rank={(idx.get(h.entry.id) ?? 0) + 1} active={activeHit?.entry.id === h.entry.id}
                        relations={serverById.get(h.entry.id)?.relations} pages={serverById.get(h.entry.id)?.pages}
                        onReveal={() => jumpTo(idx.get(h.entry.id) ?? 0)} onOpen={() => openEntry(h.entry.id)} onPage={(r) => openAtPage(h.entry.id, r.page!, r.rel === "drawn_on" || r.rel === "mentioned_in" ? r.label : undefined)} onPageHit={(p) => openAtPage(h.entry.id, p)} />
                    );
                    if (serverFind && serverFind.groups.length > 1) {
                      const hitById = new Map(hits.map((h) => [h.entry.id, h]));
                      return serverFind.groups.map((g) => {
                        const list = g.ids.map((id) => hitById.get(id)).filter((x): x is RankedHit => !!x).slice(0, 40);
                        if (!list.length) return null;
                        return (
                          <div key={g.key}>
                            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] mt-2 mb-1">{g.label} · {g.ids.length}</div>
                            <div className="space-y-2">{list.map(card)}</div>
                          </div>
                        );
                      });
                    }
                    return hits.slice(0, 80).map(card);
                  })()}
                  {hits.length > 80 && !(serverFind && serverFind.groups.length > 1) && <div className="text-[11px] text-[var(--color-text-muted)]">…and {hits.length - 80} weaker candidates.</div>}
                </div>
                {serverFind && (
                  <div className="mt-4 space-y-3 border-t border-[var(--color-border)] pt-3">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1 inline-flex items-center gap-1"><Activity className="w-3 h-3" /> Happening now</div>
                      <ActivityPanel activity={serverFind.activity} compact />
                    </div>
                    <CoverageLine coverage={serverFind.coverage} onReadFolder={controller ? askToRead : undefined} />
                    {serverFind.notes.map((n, i) => <div key={i} className="text-[11px] text-amber-700">{n}</div>)}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-[var(--color-text-muted)] space-y-2">
                <div className="font-bold text-[var(--color-text)]">Nothing searched yet</div>
                <div>Type what you would ask a colleague. Tags in any spelling, the words on the drawing, the unit as people call it, the year.</div>
                <div>Or just explore: click a library or folder on the map and it becomes the whole view. Esc climbs back out.</div>
              </div>
            )}
          </div>
        </aside>
      </div>
      {viewerError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2 shadow-lg flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {viewerError}
          <button onClick={() => setViewerError(null)} className="ml-2 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}
      {pageView && activeOrgId && (
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 text-white text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Opening sheet {pageView.page}…</div>}>
          <CitedPageViewer fileKey={pageView.fileKey} page={pageView.page} quote={null} title={pageView.title} orgId={activeOrgId} documentId={pageView.knowledgeDocId} tags={pageView.tags} onClose={() => setPageView(null)} />
        </Suspense>
      )}
      {readAsk && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onClick={() => !readAsk.busy && setReadAsk(null)}>
          <div className="w-[28rem] max-w-[92vw] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-black inline-flex items-center gap-2"><Eye className="w-4 h-4 text-emerald-600" /> Read the contents of {readAsk.folder.path || "this library"}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{readAsk.folder.count} file{readAsk.folder.count === 1 ? "" : "s"} here have never been read. Linking the folder as a source of a knowledge library reads them: text pages cost nothing, scanned or SHX pages use vision on the cheap tier within your monthly cap, and every tag read becomes a link. Nothing outside the folder is touched.</div>
            {readAsk.libs.length > 0 && (
              <select value={readAsk.pick} onChange={(e) => setReadAsk({ ...readAsk, pick: e.target.value })} className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5">
                {readAsk.libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            {readAsk.note && <div className="text-xs text-[var(--color-text)]">{readAsk.note}{readAsk.pick && readAsk.note.startsWith("Linked") && <> <Link href={`/knowledge/${readAsk.pick}`} className="font-bold text-[var(--color-accent)] hover:underline">Open the library →</Link></>}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setReadAsk(null)} disabled={readAsk.busy} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm">Close</button>
              {!readAsk.note?.startsWith("Linked") && readAsk.libs.length > 0 && (
                <button onClick={linkAndRead} disabled={readAsk.busy || !readAsk.pick} className="inline-flex items-center gap-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-3 py-1.5 text-sm font-bold disabled:opacity-60">{readAsk.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Link and read</button>
              )}
            </div>
          </div>
        </div>
      )}
      {viewer && (
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 text-white text-sm"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Opening…</div>}>
          <FullScreenViewer
            isOpen
            onClose={() => setViewer(null)}
            url={viewer.version.fileUrl}
            title={viewer.doc.title || viewer.doc.name || "Document"}
            docNumber={viewer.doc.documentNumber || ""}
            rev={viewer.version.revisionLabel || ""}
            document={viewer.doc}
            userRole={activeRole}
            currentUserId={uid || undefined}
            currentUserEmail={userEmail || undefined}
            orgId={activeOrgId ?? undefined}
          />
        </Suspense>
      )}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function PathCrumbs({ entry }: { entry: IndexEntry }) {
  const parts = entry.source === "listing" ? [entry.listingName ?? "Drive", ...entry.path] : [entry.libraryName ?? "Library", ...entry.path];
  return (
    <div className="flex flex-wrap items-center gap-0.5 text-[11px] text-[var(--color-text-muted)]">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="w-3 h-3 opacity-50" />}
          <span className={i === 0 ? (entry.source === "listing" ? "text-teal-700 font-semibold" : "text-purple-700 font-semibold") : ""}>{p}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function EvidenceList({ hit }: { hit: RankedHit }) {
  return (
    <ul className="mt-1.5 space-y-0.5 text-[11px]">
      {hit.evidence.map((e, i) => (
        <li key={i} className={`flex items-start gap-1.5 ${e.delta > 0 ? "text-green-800" : e.delta < 0 ? "text-red-700" : "text-[var(--color-text-muted)]"}`}>
          <span className="w-8 shrink-0 text-right font-mono tabular-nums">{e.delta > 0 ? `+${Math.round(e.delta)}` : e.delta < 0 ? Math.round(e.delta) : "·"}</span>
          <span>{e.label}</span>
        </li>
      ))}
    </ul>
  );
}

function HitCard({ hit, rank, active, relations, pages, onReveal, onOpen, onPage, onPageHit }: {
  hit: RankedHit; rank: number; active: boolean; relations?: FindRelation[]; pages?: Array<{ page: number; snippet: string; knowledgeDocId: string }>;
  onReveal: () => void; onOpen: () => void; onPage?: (r: FindRelation) => void; onPageHit?: (page: number) => void;
}) {
  const e = hit.entry;
  return (
    <div className={`rounded-lg border p-2.5 ${active ? "border-sky-400 bg-sky-50/40" : "border-[var(--color-border)] bg-[var(--color-canvas)]"}`}>
      <div className="flex items-start gap-2">
        <button onClick={onReveal} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`shrink-0 w-5 h-5 rounded-full grid place-items-center text-[10px] font-extrabold text-white ${active ? "bg-sky-500" : "bg-slate-800"}`}>{rank}</span>
            <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold ${VERDICT_STYLE[hit.verdict]}`}>{VERDICT_LABEL[hit.verdict]} · {hit.score}</span>
            <FileTypeIcon type={fileTypeOf(e.name)} className="w-4 h-4 shrink-0" />
            <span className="text-sm font-semibold truncate">{e.name}</span>
            {e.read?.status === "ready" && <span title={`Content read by AI (${e.read.pages} pages)`} className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 px-1.5 text-[10px] font-bold"><Eye className="w-3 h-3" /> read</span>}
          </div>
          {e.title && e.title !== e.name && <div className="text-[11px] text-[var(--color-text-muted)] truncate">{e.title}</div>}
          <PathCrumbs entry={e} />
          {relations && <RelationChips relations={relations} onPage={onPage} />}
          {pages && <PageHits pages={pages} onPage={(p) => onPageHit?.(p)} />}
        </button>
        {e.href && (
          <button onClick={onOpen} className="shrink-0 rounded-md border border-[var(--color-border)] p-1 hover:bg-[var(--color-surface)]" title="Open the drawing here">
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <EvidenceList hit={hit} />
    </div>
  );
}

function SelectedCard({ entry, hit, sameBytes, onClose, onReveal, onOpen }: {
  entry: IndexEntry; hit?: RankedHit; sameBytes: IndexEntry[]; onClose: () => void; onReveal: (id: string) => void; onOpen: () => void;
}) {
  return (
    <div className="p-3 border-b border-[var(--color-border)] bg-sky-50/30">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold truncate flex items-center gap-1.5"><FileTypeIcon type={fileTypeOf(entry.name)} className="w-4 h-4 shrink-0" /> <span className="truncate">{entry.name}</span></div>
          <div className="text-[11px] text-[var(--color-text-muted)]">{fileTypeOf(entry.name).label}</div>
          {entry.title && entry.title !== entry.name && <div className="text-xs text-[var(--color-text-muted)] truncate">{entry.title}</div>}
          <PathCrumbs entry={entry} />
          <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-[var(--color-text-muted)]">
            {entry.number && <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1">{entry.number}{entry.rev ? ` rev ${entry.rev}` : ""}</span>}
            {entry.status && <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1">{entry.status}</span>}
            {entry.years.length > 0 && <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border)] px-1">dated {entry.years.join(", ")}</span>}
            {entry.read && <span className={`rounded border px-1 ${entry.read.status === "ready" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>{entry.read.status === "ready" ? `read by AI · ${entry.read.pages} pages` : `AI read: ${entry.read.status}`}</span>}
            {entry.unitCodes.map((c) => <span key={c} className="rounded bg-purple-50 border border-purple-200 text-purple-800 px-1">unit {c}</span>)}
            {entry.sizeBytes != null && <span className={`rounded border px-1 ${entry.sizeBytes === 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-[var(--color-surface)] border-[var(--color-border)]"}`}>{entry.sizeBytes === 0 ? "0 KB" : `${Math.max(1, Math.round(entry.sizeBytes / 1024))} KB`}</span>}
            {entry.idents.map((t) => <span key={t} className="rounded bg-blue-50 border border-blue-200 text-blue-800 px-1">{tagVariants(t)[1] ?? t}</span>)}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
      </div>
      {entry.href && (
        <div className="mt-2 flex items-center gap-3">
          <button onClick={onOpen} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-2 py-1 text-xs font-bold"><ExternalLink className="w-3.5 h-3.5" /> Open</button>
          <Link href={entry.href} className="text-xs font-semibold text-[var(--color-text-muted)] hover:underline">Go to it in the library</Link>
          <Link href={globalGraphHref(entry.id)} className="text-xs font-semibold text-[var(--color-text-muted)] hover:underline inline-flex items-center gap-1"><Globe className="w-3 h-3" /> Global view</Link>
        </div>
      )}
      {entry.source === "listing" && (
        <div className="mt-2 text-xs text-teal-800 inline-flex items-center gap-1"><HardDrive className="w-3.5 h-3.5" /> On {entry.listingName}, not in the system. Upload it to bring it under control.</div>
      )}
      {sameBytes.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-bold text-red-700">Same bytes in {sameBytes.length + 1} places</div>
          <ul className="text-[11px] space-y-0.5">
            {sameBytes.map((s) => (
              <li key={s.id}><button onClick={() => onReveal(s.id)} className="text-left hover:underline">{[s.libraryName, ...s.path, s.name].filter(Boolean).join(" / ")}</button></li>
            ))}
          </ul>
        </div>
      )}
      {hit && <EvidenceList hit={hit} />}
    </div>
  );
}

function DrivesPanel({ orgId, controller, listings, uid, userEmail, systemHashes, onChange, onReveal }: {
  orgId: string; controller: boolean; listings: FinderListing[]; uid: string | null; userEmail: string | null;
  systemHashes: Set<string>;
  onChange: (l: FinderListing[]) => void; onReveal: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const preview = useMemo(() => (text.trim() ? parseDirectoryListing(text) : null), [text]);

  const save = async () => {
    if (!preview || !preview.files.length) return;
    setBusy(true); setErr(null);
    try {
      const l = await saveFinderListing({ orgId, name: name || "Pasted listing", format: preview.format, files: preview.files, folders: preview.folders, userId: uid, userName: userEmail });
      onChange([...listings, l]); setName(""); setText("");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (l: FinderListing) => {
    if (!window.confirm(`Remove the "${l.name}" listing?`)) return;
    await deleteFinderListing(orgId, l.id);
    onChange(listings.filter((x) => x.id !== l.id));
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--color-text-muted)]">
        A drive the system doesn&apos;t hold. Paste the output of <code>tree /f</code>, <code>dir /s</code>, <code>tree</code>, one path per line — or the JSON from <code>node scripts/thor-scan.mjs</code>, which adds sizes, dates and hashes so files already in the system are identified by their bytes. Names and paths only — nothing is copied.
      </div>
      {storeState.listingsLocal && <div className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Saved in this browser only until the finder migration is applied.</div>}
      {listings.map((l) => (
        <div key={l.id} className="rounded-lg border border-[var(--color-border)] p-2 text-xs flex items-start gap-2">
          <button onClick={() => onReveal(`drive:${l.id}`)} className="flex-1 text-left">
            <div className="font-bold flex items-center gap-1"><HardDrive className="w-3.5 h-3.5 text-teal-700" /> {l.name}</div>
            <div className="text-[var(--color-text-muted)]">{l.fileCount} files · {l.folders.length} folders{l.format ? ` · ${l.format}` : ""}</div>
          </button>
          {controller && <button onClick={() => remove(l)} className="opacity-50 hover:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      ))}
      {controller ? (
        <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Drive name, e.g. Thor drive"
            className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={"T:\\Crude\\Heaters\\born-u1a.pdf\nT:\\Transmix\\U1A.pdf"}
            className="w-full text-[11px] font-mono rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5" />
          {preview && (
            <div className="text-[11px] text-[var(--color-text-muted)] space-y-1">
              <div>Read as <b>{preview.format}</b>: {preview.files.length} files, {preview.folders.length} folders.</div>
              {preview.warnings.map((w, i) => <div key={i} className="text-amber-700">{w}</div>)}
              {preview.files.length > 0 && (() => {
                const t = triageListing(preview.files, preview.folders, systemHashes);
                return (
                  <ul className="rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 space-y-0.5">
                    {t.hashed > 0 && <li><b>{t.knownInSystem}</b> already in the system by bytes · <b>{t.duplicateFiles}</b> are copies of another file on the drive ({t.duplicateGroups} groups)</li>}
                    {t.hashed === 0 && <li className="text-amber-700">No hashes — paste the scanner&apos;s JSON (<code>node scripts/thor-scan.mjs</code>) to see what is already in the system and what is a copy.</li>}
                    <li><b>{t.drawingLike}</b> look like drawings by name · <b>{t.copierLike}</b> are copier-named (worth reading first) · <b>{t.empty}</b> empty</li>
                    {t.personalFolders.length > 0 && <li>{t.personalFolders.length} folder{t.personalFolders.length === 1 ? "" : "s"} look personal or temporary: {t.personalFolders.slice(0, 4).join(", ")}{t.personalFolders.length > 4 ? "…" : ""}</li>}
                    <li>Busiest: {t.topFolders.slice(0, 3).map((f) => `${f.path} (${f.count})`).join(" · ")}</li>
                  </ul>
                );
              })()}
            </div>
          )}
          {err && <div className="text-[11px] text-red-700">{err}</div>}
          <button onClick={save} disabled={busy || !preview?.files.length} className="w-full inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-bold px-3 py-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add listing
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-[var(--color-text-muted)]">Only Admin and Document Control can add drive listings.</div>
      )}
    </div>
  );
}

function AliasesPanel({ orgId, controller, aliases, uid, userEmail, units, onChange }: {
  orgId: string; controller: boolean; aliases: FinderAlias[]; uid: string | null; userEmail: string | null;
  units: Array<{ code: string; label: string }>; onChange: (a: FinderAlias[]) => void;
}) {
  const [term, setTerm] = useState("");
  const [means, setMeans] = useState("");
  const [kind, setKind] = useState<FinderAliasKind>("term");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const a = await addFinderAlias({ orgId, term, means, kind, userId: uid, userName: userEmail });
      onChange([...aliases, a]); setTerm(""); setMeans("");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (a: FinderAlias) => {
    await removeFinderAlias(orgId, a.id);
    onChange(aliases.filter((x) => x.id !== a.id));
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--color-text-muted)]">
        What people say versus what the files say. &ldquo;born&rdquo; means the crude unit. &ldquo;the north furnace&rdquo; is F-101. Teaching one makes it work in every search; opening results through it raises its trust.
      </div>
      {storeState.aliasesLocal && <div className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Saved in this browser only until the finder migration is applied.</div>}
      {aliases.map((a) => (
        <div key={a.id} className="rounded-lg border border-[var(--color-border)] p-2 text-xs flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-bold">&ldquo;{a.term}&rdquo; <span className="font-normal text-[var(--color-text-muted)]">means</span> {a.means}</div>
            <div className="text-[var(--color-text-muted)]">{a.kind} · {Math.round(aliasConfidence(a) * 100)}% trusted · {a.hits} opened{a.misses ? ` · ${a.misses} removed` : ""}{a.createdByName ? ` · ${a.createdByName}` : ""}</div>
          </div>
          {controller && <button onClick={() => remove(a)} className="opacity-50 hover:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      ))}
      {aliases.length === 0 && <div className="text-[11px] text-[var(--color-text-muted)]">No aliases taught yet.</div>}
      {controller ? (
        <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="What people say — born"
            className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5" />
          <select value={kind} onChange={(e) => setKind(e.target.value as FinderAliasKind)} className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5">
            <option value="unit">…is a unit</option>
            <option value="equipment">…is a piece of equipment (tag)</option>
            <option value="term">…is another word for</option>
          </select>
          {kind === "unit" && units.length > 0 ? (
            <select value={means} onChange={(e) => setMeans(e.target.value)} className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5">
              <option value="">Pick the codebook unit…</option>
              {units.map((u) => <option key={u.code} value={u.label}>{u.label} ({u.code})</option>)}
            </select>
          ) : (
            <input value={means} onChange={(e) => setMeans(e.target.value)} placeholder={kind === "equipment" ? "The tag — F-101" : "What the files say — crude"}
              className="w-full text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5" />
          )}
          {err && <div className="text-[11px] text-red-700">{err}</div>}
          <button onClick={add} disabled={busy || !term.trim() || !means.trim()} className="w-full inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-sm font-bold px-3 py-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Teach alias
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-[var(--color-text-muted)]">Only Admin and Document Control can teach aliases.</div>
      )}
    </div>
  );
}

export default function DocumentsGraphPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>}>
      <GraphPageInner />
    </Suspense>
  );
}
