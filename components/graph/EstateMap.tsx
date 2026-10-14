"use client";

// components/graph/EstateMap.tsx — the org graph drawn with the same hand
// as the Documents map.
//
// A force layout shows "a web"; it never shows "where things are". This
// view lays the estate out as the tree people already carry in their head:
// units → equipment → the documents on each piece; projects and libraries
// beside them; everything unplaced in one group. The balloon layout never
// overlaps, every node has an icon and a readable label, a click on a
// container drills in and Esc climbs out, a double-click opens. One doc
// has one place (equipment first, then unit, project, library); its other
// ties are drawn as dashed links.

import React, { useEffect, useMemo, useRef, useState } from "react";
import FileGraph, { type FileGraphNode, type FileGraphHandle, type FileGraphLight } from "@/components/documents/FileGraph";
import { CONTAINER_TYPES, fileTypeOf } from "@/lib/fileFinder/fileTypes";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";

const AUTO_NODES = 140;
const UNPLACED = "__unplaced__";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  query: string;
  selectedId: string | null;
  highlightIds: Set<string>;
  flyTo: { ids: string[]; nonce: number } | null;
  onSelect: (n: GraphNode | null) => void;
  onOpen: (n: GraphNode) => void;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export default function EstateMap({ nodes, edges, query, selectedId, highlightIds, flyTo, onSelect, onOpen }: Props) {
  const ref = useRef<FileGraphHandle | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ── One place per thing ───────────────────────────────────────────────
  const { tree, treeById, children, filedLinks } = useMemo(() => {
    const parent = new Map<string, string>();
    const rank = (t: GraphNode["type"]) => (t === "asset" ? 4 : t === "unit" ? 3 : t === "project" ? 2 : t === "library" ? 1 : t === "plant" ? 3 : 0);
    const claim = (child: string, par: string) => {
      const p = byId.get(par); if (!p) return;
      const cur = parent.get(child);
      if (!cur || rank(p.type) > rank(byId.get(cur)!.type)) parent.set(child, par);
    };
    for (const e of edges) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      // Who contains whom, by edge type.
      if (e.type === "unit") { claim(e.a, e.b); continue; }                 // asset/doc/unit → unit/plant
      if (e.type === "tag") { if (a.type === "document" && b.type === "asset") claim(e.a, e.b); else if (b.type === "document" && a.type === "asset") claim(e.b, e.a); continue; }
      if (e.type === "project") { if (a.type === "project") claim(e.b, e.a); else if (b.type === "project") claim(e.a, e.b); continue; }
      if (e.type === "library") { if (b.type === "library") claim(e.a, e.b); else if (a.type === "library") claim(e.b, e.a); continue; }
      if (e.type === "plot") { if (a.type === "plot") claim(e.b, e.a); else if (b.type === "plot") claim(e.a, e.b); continue; }
    }
    const typeFor = (n: GraphNode) =>
      n.type === "unit" || n.type === "plant" ? CONTAINER_TYPES.unit : n.type === "asset" ? CONTAINER_TYPES.equipment : n.type === "project" ? CONTAINER_TYPES.project
        : n.type === "library" ? CONTAINER_TYPES.library : n.type === "plot" ? CONTAINER_TYPES.folder : fileTypeOf(n.label);
    const kindFor = (n: GraphNode): FileGraphNode["kind"] => (n.type === "document" ? "file" : n.type === "asset" || n.type === "plot" ? "folder" : "library");
    const tree: FileGraphNode[] = [];
    const counts = new Map<string, number>();
    for (const n of nodes) {
      let p = parent.get(n.id) ?? null;
      if (!p && n.type === "document") p = UNPLACED;
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
      tree.push({ id: n.id, kind: kindFor(n), label: n.label, parentId: p, childCount: 0, type: typeFor(n), badge: n.type === "asset" || n.type === "document" ? n.sub?.match(/^Unit \S+$/)?.[0] : undefined });
    }
    if (counts.has(UNPLACED)) tree.push({ id: UNPLACED, kind: "library", label: "Not placed yet", parentId: null, childCount: 0, type: { ...CONTAINER_TYPES.folder, color: "#94a3b8" } });
    for (const t of tree) t.childCount = counts.get(t.id) ?? 0;
    const treeById = new Map(tree.map((t) => [t.id, t]));
    const children = new Map<string, FileGraphNode[]>();
    for (const t of tree) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
    // Every other tie a document has, dashed.
    const filedLinks: Array<[string, string]> = [];
    for (const e of edges) {
      const a = byId.get(e.a), b = byId.get(e.b);
      if (!a || !b) continue;
      const doc = a.type === "document" ? e.a : b.type === "document" ? e.b : null;
      const other = doc === e.a ? e.b : e.a;
      if (!doc || byId.get(other)?.type === "document") continue;
      if (parent.get(doc) !== other) filedLinks.push([doc, other]);
    }
    return { tree, treeById, children, filedLinks: filedLinks.slice(0, 400) };
  }, [nodes, edges, byId]);

  // ── Search light ──────────────────────────────────────────────────────
  const lit = useMemo(() => {
    const m = new Map<string, FileGraphLight>();
    const q = norm(query);
    if (q.length >= 2) for (const t of tree) { const l = norm(t.label); if (l === q) m.set(t.id, { verdict: "strong", score: 100 }); else if (l.includes(q)) m.set(t.id, { verdict: "possible", score: 50 }); }
    for (const id of highlightIds) m.set(id, { verdict: "strong", score: 100 });
    return m;
  }, [tree, query, highlightIds]);

  const ancestors = (id: string): string[] => { const out: string[] = []; let p = treeById.get(id)?.parentId ?? null; const seen = new Set<string>(); while (p && !seen.has(p)) { seen.add(p); out.push(p); p = treeById.get(p)?.parentId ?? null; } return out; };

  // ── What is in view ───────────────────────────────────────────────────
  const { visible, collapsed, upNode } = useMemo(() => {
    const vis = new Map<string, FileGraphNode>();
    const roots = focusId && treeById.has(focusId) ? [treeById.get(focusId)!] : tree.filter((t) => !t.parentId);
    for (const r of roots) vis.set(r.id, r);
    let frontier = roots, count = roots.length, first = true;
    while (frontier.length) {
      const kids = frontier.flatMap((n) => children.get(n.id) ?? []);
      if (!kids.length) break;
      if (!first && count + kids.length > AUTO_NODES) break;
      if (first && !focusId && count + kids.length > AUTO_NODES * 2) break;
      for (const k of kids) vis.set(k.id, k);
      count += kids.length; first = false;
      frontier = kids.filter((k) => k.kind !== "file");
    }
    // The way to every lit node is open.
    let shown = 0;
    for (const id of lit.keys()) {
      if (shown++ > 40) break;
      const chain = [id, ...ancestors(id)].reverse();
      if (focusId && !chain.includes(focusId)) continue;
      for (const c of chain) { const t = treeById.get(c); if (t) vis.set(c, t); }
    }
    const collapsed = new Set<string>();
    for (const n of vis.values()) if (n.kind !== "file" && (children.get(n.id) ?? []).some((k) => !vis.has(k.id))) collapsed.add(n.id);
    const focusNode = focusId ? treeById.get(focusId) : null;
    const upNode = focusNode ? (focusNode.parentId ? treeById.get(focusNode.parentId) ?? null : { id: "__all__", kind: "library" as const, label: "Whole estate", parentId: null, childCount: 0, type: CONTAINER_TYPES.estate }) : null;
    return { visible: [...vis.values()], collapsed, upNode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, treeById, children, focusId, lit]);

  // Fly to what the page asks for (deep links, Ask results).
  useEffect(() => {
    if (!flyTo?.ids.length) return;
    const id = flyTo.ids[0];
    const t = treeById.get(id); if (!t) return;
    if (t.parentId && t.parentId !== focusId) setFocusId(t.parentId);
    window.setTimeout(() => ref.current?.focus(id), 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && focusId) { const t = treeById.get(focusId); setFocusId(t?.parentId ?? null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, treeById]);

  const crumbs = focusId ? [...ancestors(focusId).reverse(), focusId].map((id) => treeById.get(id)).filter((x): x is FileGraphNode => !!x) : [];

  return (
    <div className="absolute inset-0">
      <FileGraph ref={ref} visible={visible} collapsed={collapsed} upNode={upNode} sameBytes={new Map()} lit={lit}
        selectedId={selectedId} onSelect={(id) => onSelect(id ? byId.get(id) ?? null : null)}
        onDrill={(id) => { if (id !== UNPLACED && byId.has(id)) onSelect(byId.get(id)!); if ((children.get(id) ?? []).length) setFocusId(id); }}
        onUp={() => setFocusId(focusId ? treeById.get(focusId)?.parentId ?? null : null)}
        onOpen={(id) => { const n = byId.get(id); if (n) onOpen(n); }} filedLinks={filedLinks} className="absolute inset-0" />
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] pointer-events-auto">
        <button onClick={() => setFocusId(null)} className={`rounded-md border px-2 py-1 font-semibold ${focusId ? "bg-[var(--color-surface)]/90 border-[var(--color-border)]" : "bg-violet-600 text-white border-transparent"}`}>Whole estate</button>
        {crumbs.map((c) => (
          <React.Fragment key={c.id}>
            <span className="text-[var(--color-text-faint)]">›</span>
            <button onClick={() => setFocusId(c.id)} className={`rounded-md border px-2 py-1 font-semibold ${c.id === focusId ? "bg-violet-600 text-white border-transparent" : "bg-[var(--color-surface)]/90 border-[var(--color-border)]"}`}>{c.label}</button>
          </React.Fragment>
        ))}
        <span className="ml-2 text-[var(--color-text-muted)]">{visible.length} in view · click a unit or equipment to go in · Esc to climb out</span>
      </div>
    </div>
  );
}
