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
  Search, X, Loader2, Waypoints, FolderOpen, HardDrive, Sparkles, Plus, Trash2,
  ExternalLink, ChevronRight, Info, AlertTriangle, Tag, Minus, Maximize2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import FileGraph, { type FileGraphNode, type FileGraphLight, type FileGraphHandle } from "@/components/documents/FileGraph";
import { FileTypeIcon } from "@/components/documents/fileGraphIcons";
import { fileTypeOf, CONTAINER_TYPES } from "@/lib/fileFinder/fileTypes";
import {
  parseQuery, fromChips, rankEntries, clusterByHash, entriesFromListing, parseDirectoryListing,
  aliasConfidence, tagVariants,
  type ParsedQuery, type QueryChip, type RankedHit, type IndexEntry, type FinderAlias, type FinderAliasKind,
} from "@/lib/fileFinder";
import { loadFinderData, type FinderData } from "@/lib/fileFinder/load";
import {
  listFinderAliases, addFinderAlias, removeFinderAlias, bumpFinderAlias,
  listFinderListings, saveFinderListing, deleteFinderListing, storeState, type FinderListing,
} from "@/lib/fileFinder/stores";

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
};

const LIT_CAP = 150;
const AUTO_EXPAND_TOP = 25;

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      setExpanded((prev) => (prev.size ? prev : new Set(d.libraries.map((x) => `lib:${x.id}`))));
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
    for (const f of data.folders.values()) out.push({ id: `folder:${f.id}`, kind: "folder", label: f.name, parentId: folderParent(f), childCount: counts.get(`folder:${f.id}`) ?? 0, type: CONTAINER_TYPES.folder });
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
    if (!trimmed) { setParsed(null); return; }
    setParsed(parseQuery(trimmed, { units: data?.units ?? [], aliases }));
  }, [data, aliases]);

  const hits = useMemo<RankedHit[]>(() => {
    if (!parsed || !parsed.chips.length) return [];
    return rankEntries(entries, parsed, { units: data?.units ?? [], sameBytes: sameBytesByHash });
  }, [parsed, entries, data, sameBytesByHash]);

  const lit = useMemo(() => {
    const m = new Map<string, FileGraphLight>();
    for (const h of hits.slice(0, LIT_CAP)) m.set(h.entry.id, { verdict: h.verdict, score: h.score });
    return m;
  }, [hits]);

  const ancestorsOf = useCallback((id: string) => {
    const out: string[] = [];
    let p = nodeById.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (p && !seen.has(p)) { seen.add(p); out.push(p); p = nodeById.get(p)?.parentId ?? null; }
    return out;
  }, [nodeById]);

  // When results change, open the folders the best ones live in.
  const lastAuto = useRef<string>("");
  useEffect(() => {
    const key = hits.slice(0, AUTO_EXPAND_TOP).map((h) => h.entry.id).join("|");
    if (!key || key === lastAuto.current) return;
    lastAuto.current = key;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const h of hits.slice(0, AUTO_EXPAND_TOP)) for (const a of ancestorsOf(h.entry.id)) next.add(a);
      return next;
    });
  }, [hits, ancestorsOf]);

  // ?q= runs once data is in.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current || !data) return;
    ranInitial.current = true;
    if (query.trim()) runSearch(query);
  }, [data, query, runSearch]);

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
  const reveal = (id: string) => {
    setSelectedId(id);
    setExpanded((prev) => { const n = new Set(prev); for (const a of ancestorsOf(id)) n.add(a); return n; });
    // Let the layout settle on the new expansion before the camera moves.
    window.setTimeout(() => graphRef.current?.focus(id), 60);
  };
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const collapseAll = () => setExpanded(new Set(data?.libraries.map((l) => `lib:${l.id}`) ?? []));

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
                      <button type="button" onClick={() => { setParsed(null); setQuery(""); }} className="rounded-lg border border-[var(--color-border)] px-3 text-sm"><X className="w-4 h-4" /></button>
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
                          <span className="opacity-60">{c.kind === "identifier" ? "#" : c.kind === "unit" ? "unit" : c.kind === "year" ? "yr" : c.kind === "phrase" ? "“”" : ""}</span>
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
              <DrivesPanel orgId={activeOrgId} controller={controller} listings={listings} uid={uid} userEmail={userEmail}
                onChange={setListings} onReveal={(id) => { setExpanded((p) => new Set(p).add(id)); setSelectedId(id); }} />
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
            <FileGraph ref={graphRef} nodes={nodes} expanded={expanded} sameBytes={sameBytesById} lit={lit} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggle} />
          )}
          <div className="absolute top-3 left-3 flex items-center gap-2 text-[11px]">
            <span className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-2">
              <Waypoints className="w-3.5 h-3.5" />
              {data ? `${data.libraries.length} libraries · ${data.folders.size} folders · ${data.entries.length} files` : "…"}
              {listingEntries.length > 0 && ` · ${listingEntries.length} on drives`}
            </span>
            <button onClick={() => graphRef.current?.fit()} className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1"><Maximize2 className="w-3 h-3" /> Fit</button>
            <button onClick={collapseAll} className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1"><Minus className="w-3 h-3" /> Collapse</button>
            <button onClick={() => { setExpanded(new Set(nodes.filter((n) => n.kind !== "file" && n.kind !== "extfile").map((n) => n.id))); window.setTimeout(() => graphRef.current?.fit(), 80); }} className="rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-2 py-1 inline-flex items-center gap-1"><FolderOpen className="w-3 h-3" /> Expand all</button>
          </div>
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 text-[11px]">
            {[CONTAINER_TYPES.library, CONTAINER_TYPES.folder, CONTAINER_TYPES.drive, fileTypeOf("x.pdf"), fileTypeOf("x.dwg"), fileTypeOf("x.xlsx"), fileTypeOf("x.docx"), fileTypeOf("x.xml"), fileTypeOf("x.png")].map((t) => (
              <span key={t.key + t.ext} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><FileTypeIcon type={t} className="w-3.5 h-3.5" /> {t.label}</span>
            ))}
            {([["#16a34a", "Strong"], ["#eab308", "Possible"], ["#94a3b8", "Weak"], ["#ef4444", "Ditch"]] as const).map(([c, l]) => (
              <span key={l} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: c }} /> {l}</span>
            ))}
            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface)]/90 border border-[var(--color-border)] px-1.5 py-0.5"><span className="w-4 border-t-2 border-dashed border-red-600" /> Same bytes</span>
          </div>
          <div className="absolute bottom-3 right-3 text-[11px] text-[var(--color-text-muted)]">Click a folder to open it · drag to pan · scroll to zoom</div>
        </main>

        {/* ── Right: results / selection ──────────────────────────────── */}
        <aside className="border-l border-[var(--color-border)] bg-[var(--color-surface)] min-h-0 overflow-y-auto">
          {selectedEntry && (
            <SelectedCard entry={selectedEntry} hit={selectedHit} sameBytes={(sameBytesById.get(selectedEntry.id) ?? []).map((id) => entryById.get(id)).filter((x): x is IndexEntry => !!x)}
              onClose={() => setSelectedId(null)} onReveal={reveal} onOpen={onOpenHit} />
          )}
          {!selectedEntry && selectedId && nodeById.get(selectedId) && (
            <div className="p-3 border-b border-[var(--color-border)] text-sm">
              <div className="font-bold flex items-center gap-1.5"><FolderOpen className="w-4 h-4 text-amber-500" /> {nodeById.get(selectedId)!.label}</div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">{nodeById.get(selectedId)!.childCount} items inside. Click again to {expanded.has(selectedId) ? "close" : "open"}.</div>
            </div>
          )}
          <div className="p-3">
            {parsed ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
                    {hits.length} candidate{hits.length === 1 ? "" : "s"}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {hits.filter((h) => h.verdict === "strong").length} strong · {hits.filter((h) => h.verdict === "possible").length} possible
                  </div>
                </div>
                {hits.length === 0 && (
                  <div className="text-sm text-[var(--color-text-muted)]">
                    Nothing in the system or on any pasted drive listing matched. Try fewer words, or teach an alias if people call this something else.
                  </div>
                )}
                <div className="space-y-2">
                  {hits.slice(0, 80).map((h) => (
                    <HitCard key={h.entry.id} hit={h} active={selectedId === h.entry.id} onReveal={() => reveal(h.entry.id)} onOpen={onOpenHit} />
                  ))}
                  {hits.length > 80 && <div className="text-[11px] text-[var(--color-text-muted)]">…and {hits.length - 80} weaker candidates.</div>}
                </div>
              </>
            ) : (
              <div className="text-sm text-[var(--color-text-muted)] space-y-2">
                <div className="font-bold text-[var(--color-text)]">Nothing searched yet</div>
                <div>Type what you would ask a colleague. Tags in any spelling, the words on the drawing, the unit as people call it, the year.</div>
                <div>Click libraries and folders on the map to walk the estate without searching.</div>
              </div>
            )}
          </div>
        </aside>
      </div>
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

function HitCard({ hit, active, onReveal, onOpen }: { hit: RankedHit; active: boolean; onReveal: () => void; onOpen: () => void }) {
  const e = hit.entry;
  return (
    <div className={`rounded-lg border p-2.5 ${active ? "border-sky-400 bg-sky-50/40" : "border-[var(--color-border)] bg-[var(--color-canvas)]"}`}>
      <div className="flex items-start gap-2">
        <button onClick={onReveal} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-bold ${VERDICT_STYLE[hit.verdict]}`}>{VERDICT_LABEL[hit.verdict]} · {hit.score}</span>
            <FileTypeIcon type={fileTypeOf(e.name)} className="w-4 h-4 shrink-0" />
            <span className="text-sm font-semibold truncate">{e.name}</span>
          </div>
          {e.title && e.title !== e.name && <div className="text-[11px] text-[var(--color-text-muted)] truncate">{e.title}</div>}
          <PathCrumbs entry={e} />
        </button>
        {e.href && (
          <Link href={e.href} onClick={onOpen} className="shrink-0 rounded-md border border-[var(--color-border)] p-1 hover:bg-[var(--color-surface)]" title="Open document">
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
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
            {entry.sizeBytes != null && <span className={`rounded border px-1 ${entry.sizeBytes === 0 ? "bg-red-50 border-red-200 text-red-700" : "bg-[var(--color-surface)] border-[var(--color-border)]"}`}>{entry.sizeBytes === 0 ? "0 KB" : `${Math.max(1, Math.round(entry.sizeBytes / 1024))} KB`}</span>}
            {entry.idents.map((t) => <span key={t} className="rounded bg-blue-50 border border-blue-200 text-blue-800 px-1">{tagVariants(t)[1] ?? t}</span>)}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
      </div>
      {entry.href && (
        <Link href={entry.href} onClick={onOpen} className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent)]"><ExternalLink className="w-3.5 h-3.5" /> Open in library</Link>
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

function DrivesPanel({ orgId, controller, listings, uid, userEmail, onChange, onReveal }: {
  orgId: string; controller: boolean; listings: FinderListing[]; uid: string | null; userEmail: string | null;
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
        A drive the system doesn&apos;t hold. Paste the output of <code>tree /f</code>, <code>dir /s</code>, <code>tree</code>, or one path per line. Names and paths only — nothing is copied.
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
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Read as <b>{preview.format}</b>: {preview.files.length} files, {preview.folders.length} folders.
              {preview.warnings.map((w, i) => <div key={i} className="text-amber-700">{w}</div>)}
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
