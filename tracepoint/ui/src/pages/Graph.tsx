import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Boxes, ExternalLink, FileText, Folder, FolderOpen, Home, Layers, Maximize2, Network, Route, Search, Shapes, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";
import type { Facet } from "../lib/types";
import { Button, IconButton, cx, useToast } from "../components/ui";
import { catColor, n } from "../lib/format";
import { useTheme } from "../lib/theme";
import type { Nav } from "../Shell";

// ── Data ───────────────────────────────────────────────────────────────────
interface GNode { id: string; kind: string; label: string; sub?: string; count?: number; file_id?: number; equip_id?: number; year?: number; ext?: string; category?: string; latest?: boolean; folder?: string; relief?: boolean; unit?: string; group?: string }
interface GEdge { from: string; to: string; kind: string; why: string; dashed?: boolean }
interface Walk { center: string; nodes: GNode[]; edges: GEdge[]; truncated: boolean }
interface SimNode extends GNode { x: number; y: number; vx: number; vy: number; r: number; fixed?: boolean; born: number; expanded?: boolean }

const KIND_LABEL: Record<string, string> = { root: "THOR", unit: "Unit", group: "Equipment type", equipment: "Equipment", hub: "Document type", file: "File", folder: "Folder", family: "Drawing family" };
const BASE_R: Record<string, number> = { root: 15, unit: 11, group: 9, equipment: 9, hub: 7, folder: 6, family: 6.5, file: 4.5 };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
function colorOf(nd: GNode): string {
  switch (nd.kind) {
    case "root": return "--color-text";
    case "unit": return "--color-violet";
    case "group": return "--color-info";
    case "equipment": return nd.relief ? "--color-warn" : "--color-accent";
    case "family": return "--cat-drawings";
    case "folder": return "--color-text-muted";
    default: return "";
  }
}
function resolveColor(nd: GNode): string {
  const v = colorOf(nd);
  if (v) return cssVar(v);
  const c = catColor(nd.category ?? "General");
  const m = c.match(/var\((--[^)]+)\)/);
  return m ? cssVar(m[1]) : c;
}
function radius(nd: GNode): number {
  return (BASE_R[nd.kind] ?? 5) + Math.min(9, Math.sqrt(nd.count ?? 0) * 0.55);
}

// ── Page ───────────────────────────────────────────────────────────────────
export function GraphPage({ nav }: { nav: Nav }) {
  const toast = useToast();
  const { mode, palette } = useTheme();
  const resolved = `${mode}-${palette}`;
  const nodes = useRef(new Map<string, SimNode>());
  const edges = useRef(new Map<string, GEdge>());
  const [version, setVersion] = useState(0); // bump to re-render panels
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState<{ id: string; depth: number } | null>(null);
  const [pathMode, setPathMode] = useState(false);
  const [pathEnds, setPathEnds] = useState<{ from?: string; to?: string }>({});
  const [q, setQ] = useState("");
  const [sugg, setSugg] = useState<Facet[]>([]);
  const fly = useRef<{ ids: string[]; nonce: number }>({ ids: [], nonce: 0 });
  const alpha = useRef(1);

  const merge = useCallback((w: Walk) => {
    const origin = nodes.current.get(w.center);
    const ox = origin?.x ?? 0, oy = origin?.y ?? 0;
    let added = 0;
    for (const nd of w.nodes) {
      const cur = nodes.current.get(nd.id);
      if (cur) { Object.assign(cur, nd, { r: radius(nd) }); continue; }
      const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 60;
      nodes.current.set(nd.id, { ...nd, x: ox + Math.cos(a) * d, y: oy + Math.sin(a) * d, vx: 0, vy: 0, r: radius(nd), born: performance.now() });
      added++;
    }
    for (const e of w.edges) {
      const k = e.from < e.to ? `${e.from}~${e.to}` : `${e.to}~${e.from}`;
      if (!edges.current.has(k)) edges.current.set(k, e);
    }
    const c = nodes.current.get(w.center);
    if (c) c.expanded = true;
    if (added) alpha.current = Math.max(alpha.current, 0.9);
    setVersion((v) => v + 1);
    if (w.truncated) toast("info", "Large neighbourhood — showing the first few hundred items.");
  }, [toast]);

  const expand = useCallback(async (id: string, depth = 1) => {
    setLoading(true);
    try { merge(await api<Walk>("graph.walk", { id, depth })); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setLoading(false); }
  }, [merge, toast]);

  const go = useCallback(async (id: string, opts: { fresh?: boolean; noTrail?: boolean } = {}) => {
    if (opts.fresh) { nodes.current.clear(); edges.current.clear(); setTrail([]); setFocus(null); }
    if (!opts.noTrail) setSelected((prev) => { if (prev && prev !== id && !opts.fresh) setTrail((t) => [...t.slice(-24), prev]); return id; });
    else setSelected(id);
    await expand(id);
    fly.current = { ids: [id], nonce: fly.current.nonce + 1 };
  }, [expand]);

  // Entry: ?eq=123 or ?node=… or the whole of THOR.
  useEffect(() => {
    const start = nav.params.node ?? (nav.params.eq ? `e${nav.params.eq}` : "root");
    go(start, { fresh: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.params.eq, nav.params.node]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setSugg([]); return; }
      api<Facet[]>("suggest", { q }).then((s) => setSugg(s.filter((x) => x.key.startsWith("equip:")).slice(0, 8))).catch(() => setSugg([]));
    }, 100);
    return () => clearTimeout(t);
  }, [q]);

  // Adjacency over everything loaded.
  const adj = useMemo(() => {
    const m = new Map<string, { id: string; e: GEdge }[]>();
    for (const e of edges.current.values()) {
      if (!m.has(e.from)) m.set(e.from, []);
      if (!m.has(e.to)) m.set(e.to, []);
      m.get(e.from)!.push({ id: e.to, e });
      m.get(e.to)!.push({ id: e.from, e });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // "Go in": only what's within N steps of the focus node.
  const visible = useMemo(() => {
    if (!focus) return null;
    const seen = new Set([focus.id]);
    let frontier = [focus.id];
    for (let d = 0; d < focus.depth; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!seen.has(nb.id)) { seen.add(nb.id); next.push(nb.id); }
      frontier = next;
    }
    return seen;
  }, [focus, adj]);

  // Shortest path between two loaded nodes (breadth-first).
  const path = useMemo(() => {
    if (!pathEnds.from || !pathEnds.to) return null;
    const prev = new Map<string, { id: string; e: GEdge } | null>([[pathEnds.from, null]]);
    const queue = [pathEnds.from];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === pathEnds.to) break;
      for (const nb of adj.get(cur) ?? []) if (!prev.has(nb.id)) { prev.set(nb.id, { id: cur, e: nb.e }); queue.push(nb.id); }
    }
    if (!prev.has(pathEnds.to)) return { ids: [] as string[], hops: [] as { from: string; to: string; why: string }[] };
    const ids: string[] = [];
    const hops: { from: string; to: string; why: string }[] = [];
    let cur: string | undefined = pathEnds.to;
    while (cur) { ids.unshift(cur); const p = prev.get(cur); if (p) hops.unshift({ from: p.id, to: cur, why: p.e.why }); cur = p?.id; }
    return { ids, hops };
  }, [pathEnds, adj]);

  const onNodeClick = (id: string) => {
    if (pathMode) {
      setPathEnds((p) => (!p.from || (p.from && p.to) ? { from: id } : { ...p, to: id }));
      return;
    }
    go(id);
  };
  const back = () => {
    const prev = trail[trail.length - 1];
    if (!prev) return;
    setTrail((t) => t.slice(0, -1));
    setSelected(prev);
    fly.current = { ids: [prev], nonce: fly.current.nonce + 1 };
  };
  const tidy = () => {
    // Keep only the selected node's neighbourhood; everything else is dropped.
    if (!selected) return;
    const keep = new Set([selected, ...(adj.get(selected) ?? []).map((x) => x.id)]);
    for (const id of [...nodes.current.keys()]) if (!keep.has(id)) nodes.current.delete(id);
    for (const [k, e] of [...edges.current]) if (!keep.has(e.from) || !keep.has(e.to)) edges.current.delete(k);
    setFocus(null);
    setVersion((v) => v + 1);
  };
  const openNode = (nd: GNode, how: "open" | "reveal" = "open") => {
    if (nd.file_id != null) api(how === "open" ? "file.open" : "file.reveal", { id: nd.file_id, mode: "copy" }).catch((e) => toast("error", e.message));
    else if (nd.equip_id != null && nd.kind === "equipment") nav.go("equipment", { id: nd.equip_id });
  };

  const sel = selected ? nodes.current.get(selected) : undefined;
  const nodeCount = nodes.current.size;

  return (
    <div className="relative flex h-full">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <GraphCanvas
          nodes={nodes.current} edges={edges.current} version={version} alpha={alpha} theme={resolved}
          selected={selected} hover={hover} setHover={setHover} visible={visible}
          query={q} pathIds={path?.ids ?? null} pathEnds={pathEnds} fly={fly}
          onClick={onNodeClick} onDouble={(id) => { const nd = nodes.current.get(id); if (nd) openNode(nd); }}
          onBackground={() => { if (!pathMode) setHover(null); }}
        />

        {/* Top bar: search, trail */}
        <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start gap-3">
          <div className="pointer-events-auto w-[380px]">
            <div className="flex h-11 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 shadow-lg">
              <Search className="size-4 text-[var(--color-text-faint)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && sugg[0]) { go(`e${sugg[0].key.slice(6)}`); setQ(""); setSugg([]); } if (e.key === "Escape") setQ(""); }}
                placeholder="Find equipment, or type to highlight…" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-text-faint)]" />
              {q && <button onClick={() => setQ("")} className="text-[var(--color-text-faint)] cursor-pointer"><X className="size-4" /></button>}
            </div>
            {sugg.length > 0 && (
              <div className="mt-1.5 card p-1 shadow-xl">
                {sugg.map((s) => (
                  <button key={s.key} onClick={() => { go(`e${s.key.slice(6)}`); setQ(""); setSugg([]); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-[var(--color-surface-3)] cursor-pointer">
                    <Boxes className="size-4 text-[var(--color-accent)]" /><span className="flex-1 truncate font-medium">{s.label}</span><span className="text-[12px] text-[var(--color-text-faint)]">{n(s.count)} files</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 shadow-lg">
            <IconButton label="Start over from THOR" onClick={() => go("root", { fresh: true })} className="size-8"><Home className="size-4" /></IconButton>
            <IconButton label="Back" onClick={back} disabled={!trail.length} className="size-8"><ArrowLeft className="size-4" /></IconButton>
            <div className="flex min-w-0 items-center gap-1 text-[13px]">
              {[...trail.slice(-3), selected].filter(Boolean).map((id, i, arr) => {
                const nd = nodes.current.get(id!);
                const last = i === arr.length - 1;
                return (
                  <span key={`${id}-${i}`} className="flex min-w-0 items-center gap-1">
                    {i > 0 && <span className="text-[var(--color-text-faint)]">›</span>}
                    <button onClick={() => !last && go(id!)} className={cx("max-w-[240px] truncate rounded-md px-1.5 py-0.5 cursor-pointer", last ? "font-bold text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]")}>{nd?.label ?? id}</button>
                  </span>
                );
              })}
            </div>
            {loading && <span className="ml-auto shrink-0 text-[12px] text-[var(--color-text-faint)]">Loading…</span>}
          </div>
        </div>

        {/* Bottom-left tools */}
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
            <ToolBtn active={!!focus} onClick={() => setFocus(focus ? null : selected ? { id: selected, depth: 2 } : null)} icon={<Layers className="size-4" />} label={focus ? "Show everything" : "Go in"} title="Show only what's near the selected item" />
            {focus && [1, 2, 3].map((d) => <button key={d} onClick={() => setFocus({ ...focus, depth: d })} className={cx("h-8 w-8 rounded-lg text-[13px] font-semibold cursor-pointer", focus.depth === d ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]")} title={`${d} step${d > 1 ? "s" : ""} away`}>{d}</button>)}
            <ToolBtn active={pathMode} onClick={() => { setPathMode(!pathMode); setPathEnds({}); }} icon={<Route className="size-4" />} label="Path" title="Click two items to see how they connect" />
            <ToolBtn onClick={tidy} icon={<Sparkles className="size-4" />} label="Tidy" title="Keep only the selected item and its neighbours" />
            <ToolBtn onClick={() => { fly.current = { ids: [...nodes.current.keys()], nonce: fly.current.nonce + 1 }; }} icon={<Maximize2 className="size-4" />} label="Fit" title="Fit everything on screen" />
          </div>
          <span className="rounded-lg bg-[var(--color-surface)]/80 px-2 py-1 text-[12px] text-[var(--color-text-faint)]">{n(nodeCount)} items · click to walk · double-click to open</span>
        </div>
        {pathMode && (
          <div className="absolute bottom-20 left-4 z-20 w-[380px] rounded-xl border border-[color-mix(in_srgb,var(--color-info)_40%,transparent)] bg-[var(--color-surface)] p-3.5 shadow-xl">
            <div className="text-[14px] font-bold">How are these connected?</div>
            <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">{!pathEnds.from ? "Click the first item." : !pathEnds.to ? `From ${nodes.current.get(pathEnds.from)?.label} — now click the second item.` : path && path.hops.length ? "" : "No connection among the items loaded. Walk out further and try again."}</div>
            {path && path.hops.length > 0 && (
              <ol className="mt-2 space-y-1.5 text-[13px]">
                {path.hops.map((h, i) => (
                  <li key={i} className="flex gap-2"><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-info)] text-[11px] font-bold text-white">{i + 1}</span><span><b>{nodes.current.get(h.from)?.label}</b> → <b>{nodes.current.get(h.to)?.label}</b><span className="block text-[12px] text-[var(--color-text-faint)]">{h.why}</span></span></li>
                ))}
              </ol>
            )}
          </div>
        )}
        <Legend />
      </div>

      <NodePanel
        nd={sel} adj={selected ? adj.get(selected) ?? [] : []} nodes={nodes.current} trailLen={trail.length}
        onBack={back} onWalk={(id) => go(id)} onOpen={openNode} onExpandMore={() => selected && expand(selected, 2)}
        onSearch={(nd) => nav.go("search", nd.equip_id != null && nd.kind === "equipment" ? { eq: nd.equip_id } : { q: nd.label })}
        onFocus={() => selected && setFocus({ id: selected, depth: 1 })}
      />
    </div>
  );
}

function ToolBtn({ active, onClick, icon, label, title }: { active?: boolean; onClick: () => void; icon: React.ReactNode; label: string; title: string }) {
  return (
    <button onClick={onClick} title={title} className={cx("flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium cursor-pointer", active ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]")}>{icon}{label}</button>
  );
}

function Legend() {
  const items: [string, string][] = [["Unit", "--color-violet"], ["Equipment type", "--color-info"], ["Equipment", "--color-accent"], ["Relief device", "--color-warn"], ["Drawing family", "--cat-drawings"], ["Folder", "--color-text-muted"]];
  return (
    <div className="absolute right-4 top-[72px] z-10 flex max-w-[560px] flex-wrap justify-end gap-x-3 gap-y-1 rounded-xl border border-[var(--color-border)] glass px-3 py-2 text-[12px] text-[var(--color-text-muted)] shadow-md">
      {items.map(([l, v]) => <span key={l} className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: `var(${v})` }} />{l}</span>)}
      <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-[var(--color-text-faint)]" />Not verified</span>
    </div>
  );
}

// ── Side panel ─────────────────────────────────────────────────────────────
function NodePanel({ nd, adj, nodes, trailLen, onBack, onWalk, onOpen, onExpandMore, onSearch, onFocus }: {
  nd?: SimNode; adj: { id: string; e: GEdge }[]; nodes: Map<string, SimNode>; trailLen: number;
  onBack: () => void; onWalk: (id: string) => void; onOpen: (nd: GNode, how?: "open" | "reveal") => void; onExpandMore: () => void; onSearch: (nd: GNode) => void; onFocus: () => void;
}) {
  if (!nd) return <aside className="w-[360px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)]" />;
  const list = adj
    .map((a) => ({ ...a, nd: nodes.get(a.id) }))
    .filter((x) => x.nd)
    .sort((a, b) => Number(!!a.e.dashed) - Number(!!b.e.dashed) || (b.nd!.count ?? 0) - (a.nd!.count ?? 0));
  const groups = new Map<string, typeof list>();
  for (const x of list) {
    const k = KIND_LABEL[x.nd!.kind] ?? x.nd!.kind;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(x);
  }
  const color = resolveColor(nd);
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] px-5 py-4">
        {trailLen > 0 && <button onClick={onBack} className="mb-2 flex items-center gap-1 text-[12.5px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"><ArrowLeft className="size-3.5" />Back</button>}
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color }}>
          {nd.kind === "file" ? <FileText className="size-3.5" /> : nd.kind === "folder" ? <Folder className="size-3.5" /> : nd.kind === "equipment" ? <Boxes className="size-3.5" /> : <Shapes className="size-3.5" />}
          {nd.relief ? "Relief device" : KIND_LABEL[nd.kind] ?? nd.kind}
        </div>
        <div className="mt-1 break-words text-[20px] font-[750] leading-tight tracking-tight">{nd.label}</div>
        {nd.sub && <div className="mt-1 text-[14.5px] font-medium text-[var(--color-text)]">{nd.sub}</div>}
        <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
          {[nd.unit, nd.year && `${nd.year}`, nd.count != null && nd.kind !== "file" && `${n(nd.count)} ${nd.kind === "equipment" ? "documents" : "items"}`].filter(Boolean).join(" · ")}
        </div>
        {nd.folder && <div className="mt-1 break-all text-[12px] text-[var(--color-text-faint)]">{nd.folder}</div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {nd.file_id != null && <Button size="sm" variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => onOpen(nd)}>Open</Button>}
          {nd.file_id != null && <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => onOpen(nd, "reveal")}>Show in folder</Button>}
          {nd.kind === "equipment" && <Button size="sm" variant="primary" icon={<Boxes className="size-3.5" />} onClick={() => onOpen(nd)}>Equipment page</Button>}
          {(nd.kind === "equipment" || nd.kind === "hub") && <Button size="sm" icon={<Search className="size-3.5" />} onClick={() => onSearch(nd)}>Search its files</Button>}
          <Button size="sm" icon={<Layers className="size-3.5" />} onClick={onFocus}>Go in</Button>
          <Button size="sm" icon={<Network className="size-3.5" />} onClick={onExpandMore}>Expand 2 steps</Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="px-2 pb-2 text-[14px] font-bold">Connected · {list.length}</div>
        {[...groups.entries()].map(([k, xs]) => (
          <div key={k} className="mb-3">
            <div className="px-2 pb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">{k}</div>
            {xs.slice(0, 60).map((x) => (
              <button key={x.id} onClick={() => onWalk(x.id)} className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--color-surface-3)] cursor-pointer">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: resolveColor(x.nd!) }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-[var(--color-text)]">{x.nd!.label}{x.nd!.count != null && x.nd!.kind !== "file" ? <span className="ml-1.5 font-normal text-[var(--color-text-faint)]">{n(x.nd!.count)}</span> : null}</span>
                  {x.nd!.sub && x.nd!.kind !== "hub" && <span className="block truncate text-[12.5px] text-[var(--color-text-muted)]">{x.nd!.sub}{x.nd!.kind === "file" && x.nd!.year ? ` · ${x.nd!.year}` : ""}{x.nd!.latest ? " · latest revision" : ""}</span>}
                  {x.e.why && x.e.why !== x.nd!.sub && x.e.why !== x.nd!.category && <span className={cx("block text-[12px]", x.e.dashed ? "text-[var(--color-warn)]" : "text-[var(--color-text-faint)]")}>{x.e.why}</span>}
                </span>
              </button>
            ))}
            {xs.length > 60 && <div className="px-2 text-[12px] text-[var(--color-text-faint)]">+{xs.length - 60} more on the canvas</div>}
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Canvas ─────────────────────────────────────────────────────────────────
function GraphCanvas({ nodes, edges, version, alpha, theme, selected, hover, setHover, visible, query, pathIds, pathEnds, fly, onClick, onDouble, onBackground }: {
  nodes: Map<string, SimNode>; edges: Map<string, GEdge>; version: number; alpha: React.MutableRefObject<number>; theme: string;
  selected: string | null; hover: string | null; setHover: (id: string | null) => void; visible: Set<string> | null;
  query: string; pathIds: string[] | null; pathEnds: { from?: string; to?: string }; fly: React.MutableRefObject<{ ids: string[]; nonce: number }>;
  onClick: (id: string) => void; onDouble: (id: string) => void; onBackground: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef({ x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 });
  const drag = useRef<{ id: string | null; sx: number; sy: number; moved: boolean; panX: number; panY: number } | null>(null);
  const lastFly = useRef(-1);
  const props = useRef({ selected, hover, visible, query, pathIds, pathEnds, version });
  props.current = { selected, hover, visible, query, pathIds, pathEnds, version };
  const colors = useRef<Record<string, string>>({});

  useEffect(() => {
    const base: Record<string, string> = {};
    for (const v of ["--color-text", "--color-text-muted", "--color-text-faint", "--color-surface", "--color-bg", "--color-border", "--color-accent", "--color-info", "--color-warn"]) base[v] = cssVar(v);
    colors.current = base;
    for (const nd of nodes.values()) (nd as SimNode & { c?: string }).c = resolveColor(nd);
  }, [theme, version, nodes]);

  const toWorld = (cx: number, cy: number) => { const c = cam.current; const el = canvas.current!; return { x: (cx - el.clientWidth / 2) / c.k + c.x, y: (cy - el.clientHeight / 2) / c.k + c.y }; };
  const hit = (cx: number, cy: number): string | null => {
    const p = toWorld(cx, cy);
    let best: string | null = null, bd = Infinity;
    for (const nd of nodes.values()) {
      if (props.current.visible && !props.current.visible.has(nd.id)) continue;
      const d = Math.hypot(nd.x - p.x, nd.y - p.y);
      if (d < Math.max(nd.r + 4, 9 / cam.current.k) && d < bd) { bd = d; best = nd.id; }
    }
    return best;
  };

  useEffect(() => {
    let raf = 0;
    const step = () => {
      const el = canvas.current;
      if (!el) { raf = requestAnimationFrame(step); return; }
      const dpr = window.devicePixelRatio || 1;
      const W = el.clientWidth, H = el.clientHeight;
      if (el.width !== W * dpr || el.height !== H * dpr) { el.width = W * dpr; el.height = H * dpr; }
      const ctx = el.getContext("2d")!;
      const { selected, hover, visible, query, pathIds, pathEnds } = props.current;
      const list = [...nodes.values()].filter((nd) => !visible || visible.has(nd.id));
      const elist = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to) && (!visible || (visible.has(e.from) && visible.has(e.to))));

      // Physics: repulsion, springs, gentle pull to centre; cools down.
      const a = alpha.current;
      if (a > 0.01) {
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          for (let j = i + 1; j < list.length; j++) {
            const q2 = list[j];
            let dx = q2.x - p.x, dy = q2.y - p.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
            if (d2 > 250000) continue;
            const f = (900 * a) / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f, fy = (dy / d) * f;
            p.vx -= fx; p.vy -= fy; q2.vx += fx; q2.vy += fy;
          }
        }
        for (const e of elist) {
          const s = nodes.get(e.from)!, t = nodes.get(e.to)!;
          const dx = t.x - s.x, dy = t.y - s.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const rest = 34 + s.r + t.r + (t.kind === "file" || s.kind === "file" ? 0 : 30);
          const f = ((d - rest) / d) * 0.06 * a * (e.dashed ? 0.4 : 1);
          s.vx += dx * f; s.vy += dy * f; t.vx -= dx * f; t.vy -= dy * f;
        }
        for (const nd of list) {
          if (nd.fixed) { nd.vx = 0; nd.vy = 0; continue; }
          nd.vx -= nd.x * 0.0009 * a; nd.vy -= nd.y * 0.0009 * a;
          nd.x += nd.vx; nd.y += nd.vy;
          nd.vx *= 0.82; nd.vy *= 0.82;
        }
        alpha.current *= 0.985;
      }

      // Camera fly-to.
      if (fly.current.nonce !== lastFly.current) {
        const ids = fly.current.ids.filter((id) => nodes.has(id));
        if (ids.length) {
          lastFly.current = fly.current.nonce;
          const pts = ids.length === 1 ? [nodes.get(ids[0])!, ...[...edges.values()].filter((e) => e.from === ids[0] || e.to === ids[0]).map((e) => nodes.get(e.from === ids[0] ? e.to : e.from)).filter(Boolean) as SimNode[]] : ids.map((id) => nodes.get(id)!);
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
          const c = cam.current;
          c.tx = ids.length === 1 ? nodes.get(ids[0])!.x : (minX + maxX) / 2;
          c.ty = ids.length === 1 ? nodes.get(ids[0])!.y : (minY + maxY) / 2;
          c.tk = Math.max(0.35, Math.min(1.8, Math.min((W * 0.6) / Math.max(80, maxX - minX), (H * 0.6) / Math.max(80, maxY - minY))));
        }
      }
      const c = cam.current;
      c.x += (c.tx - c.x) * 0.12; c.y += (c.ty - c.y) * 0.12; c.k += (c.tk - c.k) * 0.12;

      // Draw.
      const col = colors.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(W / 2, H / 2);
      ctx.scale(c.k, c.k);
      ctx.translate(-c.x, -c.y);
      const spot = hover ?? selected;
      const near = new Set<string>();
      if (spot) { near.add(spot); for (const e of elist) { if (e.from === spot) near.add(e.to); if (e.to === spot) near.add(e.from); } }
      const ql = query.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const matches = (nd: SimNode) => !!ql && nd.label.toLowerCase().replace(/[^a-z0-9]/g, "").includes(ql);
      const onPath = new Set(pathIds ?? []);
      const pathEdge = (e: GEdge) => { if (!pathIds) return false; const i = pathIds.indexOf(e.from), j = pathIds.indexOf(e.to); return i >= 0 && j >= 0 && Math.abs(i - j) === 1; };

      for (const e of elist) {
        const s = nodes.get(e.from)!, t = nodes.get(e.to)!;
        const lit = spot && (e.from === spot || e.to === spot);
        const pe = pathEdge(e);
        ctx.globalAlpha = pe ? 1 : spot ? (lit ? 0.85 : 0.08) : ql ? 0.1 : 0.32;
        ctx.strokeStyle = pe ? "#22d3ee" : lit ? (e.dashed ? col["--color-warn"] : col["--color-text-muted"]) : col["--color-text-faint"];
        ctx.lineWidth = (pe ? 3 : lit ? 1.6 : 1) / Math.max(0.6, c.k);
        ctx.setLineDash(e.dashed ? [5 / c.k, 4 / c.k] : []);
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        const len = Math.hypot(t.x - s.x, t.y - s.y);
        const bow = Math.min(22, len * 0.1);
        const nx = -(t.y - s.y) / (len || 1), ny = (t.x - s.x) / (len || 1);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.quadraticCurveTo(mx + nx * bow, my + ny * bow, t.x, t.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const now = performance.now();
      for (const nd of list) {
        const grow = Math.min(1, (now - nd.born) / 350);
        const r = nd.r * (0.3 + 0.7 * grow * grow * (3 - 2 * grow));
        const dim = (spot && !near.has(nd.id)) || (ql && !matches(nd)) || (pathIds && pathIds.length > 0 && !onPath.has(nd.id));
        const color = (nd as SimNode & { c?: string }).c ?? col["--color-text-muted"];
        ctx.globalAlpha = dim ? 0.16 : 1;
        if (nd.id === selected || matches(nd) || onPath.has(nd.id)) {
          const g = ctx.createRadialGradient(nd.x, nd.y, r * 0.5, nd.x, nd.y, r * 3.2);
          g.addColorStop(0, (onPath.has(nd.id) ? "#22d3ee" : matches(nd) ? "#eab308" : color) + "66");
          g.addColorStop(1, "transparent");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(nd.x, nd.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2); ctx.fill();
        if (nd.expanded && nd.kind !== "file") { ctx.strokeStyle = col["--color-surface"]; ctx.lineWidth = 1.5 / c.k; ctx.stroke(); }
        if (nd.id === selected || nd.id === pathEnds.from || nd.id === pathEnds.to) {
          ctx.strokeStyle = col["--color-text"]; ctx.lineWidth = 2.5 / c.k;
          ctx.beginPath(); ctx.arc(nd.x, nd.y, r + 4 / c.k, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // Labels last, on plates, most important first; skip overlaps.
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const labelled = list
        .filter((nd) => {
          if (nd.id === spot || near.has(nd.id) || matches(nd) || onPath.has(nd.id)) return true;
          if (spot || ql) return false;
          return nd.kind !== "file" || c.k > 1.3;
        })
        .sort((a2, b2) => Number(b2.id === spot) - Number(a2.id === spot) || (BASE_R[b2.kind] ?? 0) - (BASE_R[a2.kind] ?? 0) || (b2.count ?? 0) - (a2.count ?? 0));
      const fs = 12.5 / c.k;
      for (const nd of labelled) {
        const strong = nd.id === spot || nd.kind === "root" || nd.kind === "unit" || nd.kind === "equipment";
        ctx.font = `${strong ? 650 : 500} ${(nd.id === spot ? 14 : 12.5) / c.k}px Inter, system-ui, sans-serif`;
        const text = nd.label.length > 30 ? nd.label.slice(0, 29) + "…" : nd.label;
        const w = ctx.measureText(text).width + 10 / c.k, h = fs + 7 / c.k;
        const x = nd.x - w / 2, y = nd.y + nd.r + 4 / c.k;
        if (nd.id !== spot && placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y)) continue;
        placed.push({ x, y, w, h });
        const dim = (spot && !near.has(nd.id)) || (ql && !matches(nd));
        ctx.globalAlpha = dim ? 0.3 : 0.94;
        ctx.fillStyle = col["--color-surface"];
        ctx.beginPath(); ctx.roundRect(x, y, w, h, 4 / c.k); ctx.fill();
        ctx.globalAlpha = dim ? 0.4 : 1;
        ctx.fillStyle = col["--color-text"];
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 5 / c.k, y + h / 2);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges, alpha, fly]);

  const lastClick = useRef(0);
  return (
    <canvas
      ref={canvas}
      className="h-full w-full cursor-grab active:cursor-grabbing"
      style={{ background: "radial-gradient(circle at 50% 40%, var(--color-surface-2), var(--color-bg))" }}
      onPointerDown={(e) => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const id = hit(e.clientX - r.left, e.clientY - r.top);
        drag.current = { id, sx: e.clientX, sy: e.clientY, moved: false, panX: cam.current.tx, panY: cam.current.ty };
        if (id) { const nd = nodes.get(id)!; nd.fixed = true; }
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const d = drag.current;
        if (d) {
          if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.moved = true;
          if (!d.moved) return;
          if (d.id) {
            const p = toWorld(e.clientX - r.left, e.clientY - r.top);
            const nd = nodes.get(d.id)!; nd.x = p.x; nd.y = p.y; alpha.current = Math.max(alpha.current, 0.3);
          } else {
            const c = cam.current;
            c.tx = d.panX - (e.clientX - d.sx) / c.k; c.ty = d.panY - (e.clientY - d.sy) / c.k; c.x = c.tx; c.y = c.ty;
          }
          return;
        }
        const id = hit(e.clientX - r.left, e.clientY - r.top);
        if (id !== hover) setHover(id);
        (e.target as HTMLCanvasElement).style.cursor = id ? "pointer" : "grab";
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.id) nodes.get(d.id)!.fixed = false;
        if (d.moved) return;
        const now = performance.now();
        if (d.id) {
          if (now - lastClick.current < 350) onDouble(d.id);
          else onClick(d.id);
          lastClick.current = now;
        } else onBackground();
      }}
      onPointerLeave={() => setHover(null)}
      onWheel={(e) => {
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const c = cam.current;
        const before = toWorld(e.clientX - r.left, e.clientY - r.top);
        const k = Math.max(0.08, Math.min(6, c.tk * Math.exp(-e.deltaY * 0.0015)));
        c.tk = k; c.k = k;
        const after = toWorld(e.clientX - r.left, e.clientY - r.top);
        c.tx += before.x - after.x; c.ty += before.y - after.y; c.x = c.tx; c.y = c.ty;
      }}
    />
  );
}
