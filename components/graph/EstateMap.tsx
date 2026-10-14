"use client";

// components/graph/EstateMap.tsx — the org graph as the estate people carry
// in their head: operating area → equipment type → equipment → the
// documents about it; projects; what is not placed yet, by library. Same
// renderer as the Documents map: icons, readable labels, no overlap, click
// to go in, Esc to climb out. A document's other ties are drawn only when
// it is picked, never as a web over the whole view.

import React, { useEffect, useMemo, useRef, useState } from "react";
import FileGraph, { type FileGraphNode, type FileGraphHandle, type FileGraphLight } from "@/components/documents/FileGraph";
import { CONTAINER_TYPES, fileTypeOf, type FileTypeInfo } from "@/lib/fileFinder/fileTypes";
import { buildEstateTree, type TreeNode } from "@/lib/estateTree";
import type { GraphNode, GraphEdge } from "@/lib/orgGraph";

const AUTO_NODES = 60;
const MAX_DEPTH = 2;

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
const GROUP: FileTypeInfo = { ...CONTAINER_TYPES.folder, color: "#64748b", label: "Group" };
const CATEGORY: FileTypeInfo = { key: "equipment", label: "Equipment type", color: "#0d9488", ext: "" };

function typeOf(t: TreeNode): { kind: FileGraphNode["kind"]; type: FileTypeInfo } {
  switch (t.kind) {
    case "area": return { kind: "library", type: CONTAINER_TYPES.unit };
    case "group": return { kind: "library", type: GROUP };
    case "category": return { kind: "folder", type: CATEGORY };
    case "asset": return { kind: "folder", type: CONTAINER_TYPES.equipment };
    case "project": return { kind: "folder", type: CONTAINER_TYPES.project };
    case "library": return { kind: "folder", type: CONTAINER_TYPES.library };
    default: return { kind: "file", type: fileTypeOf(t.label) };
  }
}

export default function EstateMap({ nodes, edges, query, selectedId, highlightIds, flyTo, onSelect, onOpen }: Props) {
  const ref = useRef<FileGraphHandle | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const { tree, treeById, children } = useMemo(() => {
    const t = buildEstateTree(nodes, edges);
    const children = new Map<string, TreeNode[]>();
    for (const n of t) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    const tree: FileGraphNode[] = t.map((n) => {
      const { kind, type } = typeOf(n);
      const leaf = !(children.get(n.id)?.length);
      return { id: n.id, kind: leaf && n.kind === "asset" ? "file" : kind, label: n.label, parentId: n.parentId, childCount: children.get(n.id)?.length ?? 0, type };
    });
    return { tree, treeById: new Map(tree.map((n) => [n.id, n])), children };
  }, [nodes, edges]);

  const ancestors = (id: string): string[] => { const out: string[] = []; let p = treeById.get(id)?.parentId ?? null; const seen = new Set<string>(); while (p && !seen.has(p)) { seen.add(p); out.push(p); p = treeById.get(p)?.parentId ?? null; } return out; };

  // ── Search light ──────────────────────────────────────────────────────
  const lit = useMemo(() => {
    const m = new Map<string, FileGraphLight>();
    const q = norm(query);
    if (q.length >= 2) for (const t of tree) { const l = norm(t.label); if (l === q) m.set(t.id, { verdict: "strong", score: 100 }); else if (l.includes(q)) m.set(t.id, { verdict: "possible", score: 50 }); }
    for (const id of highlightIds) if (treeById.has(id)) m.set(id, { verdict: "strong", score: 100 });
    return m;
  }, [tree, treeById, query, highlightIds]);

  // ── What is in view ───────────────────────────────────────────────────
  const { visible, collapsed, upNode } = useMemo(() => {
    const vis = new Map<string, FileGraphNode>();
    const roots = focusId && treeById.has(focusId) ? [treeById.get(focusId)!] : tree.filter((t) => !t.parentId);
    for (const r of roots) vis.set(r.id, r);
    let frontier = roots, count = roots.length, first = true, depth = 0;
    while (frontier.length && depth < MAX_DEPTH) {
      depth++;
      // At the top, open each operating area one level (its equipment types)
      // but keep big groups ("Not placed yet", Projects) closed with a
      // count; inside one, open a level or two while it stays readable.
      const opening = !focusId ? frontier.filter((n) => (children.get(n.id)?.length ?? 0) <= 12) : frontier;
      const kids = opening.flatMap((n) => (children.get(n.id) ?? []).map((c) => treeById.get(c.id)!));
      if (!kids.length) break;
      if (!focusId && !first) break;
      if (!first && count + kids.length > AUTO_NODES) break;
      if (first && count + kids.length > AUTO_NODES * 2) break;
      for (const k of kids) vis.set(k.id, k);
      count += kids.length; first = false;
      frontier = kids.filter((k) => k.kind !== "file");
    }
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

  // Other ties of the picked thing only: a document's second piece of
  // equipment, its project. Never a web over the whole view.
  const filedLinks = useMemo<Array<[string, string]>>(() => {
    if (!selectedId) return [];
    const vis = new Set(visible.map((v) => v.id));
    const parent = treeById.get(selectedId)?.parentId;
    const out: Array<[string, string]> = [];
    for (const e of edges) {
      const other: string | null = e.a === selectedId ? e.b : e.b === selectedId ? e.a : null;
      // Only ties that leave what you are looking at: never to its own
      // contents, never to where it sits.
      if (!other || other === parent || !vis.has(other) || ancestors(other).includes(selectedId)) continue;
      out.push([selectedId, other]);
    }
    return out.slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, edges, visible, treeById]);

  useEffect(() => {
    if (!flyTo?.ids.length) return;
    const id = flyTo.ids.find((x) => treeById.has(x));
    if (!id) return;
    const t = treeById.get(id)!;
    if (t.parentId && t.parentId !== focusId) setFocusId(t.parentId);
    window.setTimeout(() => ref.current?.focus(id), 140);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape" && focusId) setFocusId(treeById.get(focusId)?.parentId ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, treeById]);

  const crumbs = focusId ? [...ancestors(focusId).reverse(), focusId].map((id) => treeById.get(id)).filter((x): x is FileGraphNode => !!x) : [];

  return (
    <div className="absolute inset-0">
      <div className="absolute inset-x-0 bottom-0 top-10">
      <FileGraph ref={ref} visible={visible} collapsed={collapsed} upNode={upNode} sameBytes={new Map()} lit={lit}
        selectedId={selectedId} onSelect={(id) => onSelect(id ? byId.get(id) ?? null : null)}
        onDrill={(id) => { if (byId.has(id)) onSelect(byId.get(id)!); if ((children.get(id) ?? []).length) setFocusId(id); }}
        onUp={() => setFocusId(focusId ? treeById.get(focusId)?.parentId ?? null : null)}
        onOpen={(id) => { const n = byId.get(id); if (n) onOpen(n); }} filedLinks={filedLinks} />
      </div>
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 text-[11px] pointer-events-auto max-w-[70%] flex-wrap justify-center">
        <button onClick={() => setFocusId(null)} className={`rounded-md border px-2 py-1 font-semibold ${focusId ? "bg-[var(--color-surface)]/90 border-[var(--color-border)]" : "bg-violet-600 text-white border-transparent"}`}>Whole estate</button>
        {crumbs.map((c) => (
          <React.Fragment key={c.id}>
            <span className="text-[var(--color-text-faint)]">›</span>
            <button onClick={() => setFocusId(c.id)} className={`rounded-md border px-2 py-1 font-semibold ${c.id === focusId ? "bg-violet-600 text-white border-transparent" : "bg-[var(--color-surface)]/90 border-[var(--color-border)]"}`}>{c.label}</button>
          </React.Fragment>
        ))}
        {!focusId
          ? <span className="ml-2 text-[var(--color-text-muted)]">operating area › equipment type › equipment › documents · click to go in · Esc to climb out</span>
          : <span className="ml-2 text-[var(--color-text-muted)]">Esc or ↑ to climb out</span>}
      </div>
    </div>
  );
}
