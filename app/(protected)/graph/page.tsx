"use client";

// /graph — the whole org as one living, zoomable map.
//
// Every document, equipment item, unit, library and project the org has,
// clustered by their real persisted relationships. Wheel or pinch to zoom,
// drag to pan, drag a node to rearrange, click to inspect, double-click to
// open. The layout is remembered per org — the map you build is the map
// you come back to.

import React, { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, Waypoints, X, ArrowUpRight, Info } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { buildOrgGraph, type OrgGraph, type GraphNode, type GraphNodeType } from "@/lib/orgGraph";
import OrgGraphCanvas, { NODE_COLORS } from "@/components/graph/OrgGraphCanvas";

const TYPE_LABELS: Record<GraphNodeType, string> = {
  document: "Documents", asset: "Equipment", unit: "Units",
  library: "Libraries", project: "Projects", plant: "Plants",
};
const TYPE_ORDER: GraphNodeType[] = ["unit", "asset", "document", "library", "project", "plant"];

function GraphPageInner() {
  const { activeOrgId } = useRole();
  const router = useRouter();
  const params = useSearchParams();
  const focusDoc = params.get("focus");

  const [graph, setGraph] = React.useState<OrgGraph | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<Set<GraphNodeType>>(new Set());
  const [showLibraryEdges, setShowLibraryEdges] = React.useState(false);
  const [hideUnlinked, setHideUnlinked] = React.useState(false);
  const [rawQuery, setRawQuery] = React.useState("");
  const [selected, setSelected] = React.useState<GraphNode | null>(null);

  React.useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    buildOrgGraph(activeOrgId)
      .then((g) => { if (alive) setGraph(g); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [activeOrgId]);

  const query = rawQuery.toLowerCase().replace(/[^a-z0-9]+/g, "");

  // Visible slice: type filters + the library-edge toggle + unlinked toggle.
  // Degrees are recomputed against what's actually shown so "unlinked" means
  // unlinked *in this view*.
  const view = React.useMemo(() => {
    if (!graph) return null;
    const typeOk = (t: GraphNodeType) => !hidden.has(t) && (t !== "library" || showLibraryEdges);
    let nodes = graph.nodes.filter((n) => typeOk(n.type));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) =>
      ids.has(e.a) && ids.has(e.b) && (showLibraryEdges || e.type !== "library"));
    if (hideUnlinked) {
      const linked = new Set<string>();
      for (const e of edges) { linked.add(e.a); linked.add(e.b); }
      nodes = nodes.filter((n) => linked.has(n.id));
    }
    return { nodes, edges };
  }, [graph, hidden, showLibraryEdges, hideUnlinked]);

  const counts = React.useMemo(() => {
    const c = {} as Record<GraphNodeType, number>;
    for (const t of TYPE_ORDER) c[t] = 0;
    for (const n of graph?.nodes ?? []) c[n.type] += 1;
    return c;
  }, [graph]);

  const toggleType = (t: GraphNodeType) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const open = React.useCallback((n: GraphNode) => { router.push(n.href); }, [router]);

  const connections = React.useMemo(() => {
    if (!selected || !view) return [];
    const ids = new Set<string>();
    for (const e of view.edges) {
      if (e.a === selected.id) ids.add(e.b);
      if (e.b === selected.id) ids.add(e.a);
    }
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    return [...ids].map((id) => byId.get(id)).filter((n): n is GraphNode => !!n)
      .sort((a, b) => b.degree - a.degree).slice(0, 10);
  }, [selected, view]);

  if (!activeOrgId) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>;
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Control bar */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <Waypoints className="w-4 h-4 text-violet-600 shrink-0" />
        <h1 className="text-sm font-black text-[var(--color-text)] mr-1">Org graph</h1>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Light up E-22, crude, plot plan…"
            className="pl-7 pr-6 py-1.5 w-56 border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)]"
          />
          {rawQuery && (
            <button onClick={() => setRawQuery("")} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {TYPE_ORDER.map((t) => (
            (t === "plant" && counts.plant === 0) ? null : (
              <button key={t} onClick={() => t === "library" ? setShowLibraryEdges((v) => !v) : toggleType(t)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[10px] font-bold transition-colors ${
                  (t === "library" ? showLibraryEdges : !hidden.has(t))
                    ? "border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)]"
                    : "border-[var(--color-border)] text-[var(--color-text-faint)] opacity-50"
                }`}>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: NODE_COLORS[t] }} />
                {TYPE_LABELS[t]} <span className="font-mono font-normal">{counts[t]}</span>
              </button>
            )
          ))}
          <button onClick={() => setHideUnlinked((v) => !v)}
            className={`px-2 py-1 rounded-full border text-[10px] font-bold ${
              hideUnlinked
                ? "border-violet-400 text-violet-700 bg-violet-50 dark:bg-violet-950/40"
                : "border-[var(--color-border)] text-[var(--color-text-faint)]"
            }`}>
            Hide unlinked
          </button>
        </div>
      </div>

      {/* The map */}
      <div className="relative flex-1 min-h-0">
        {error ? (
          <div className="flex items-center justify-center h-full text-sm text-rose-600 px-6 text-center">{error}</div>
        ) : !view ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" />
            <div className="text-xs text-[var(--color-text-muted)]">Assembling the org graph…</div>
          </div>
        ) : (
          <>
            <OrgGraphCanvas
              nodes={view.nodes}
              edges={view.edges}
              focusId={focusDoc ? `doc:${focusDoc}` : null}
              query={query}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              onOpen={open}
              storageKey={`orgGraph:pos:${activeOrgId}`}
            />

            {/* Hints + truncation notes */}
            <div className="pointer-events-none absolute top-2 right-3 text-right space-y-1">
              <div className="text-[10px] font-bold text-[var(--color-text-faint)]">
                scroll / pinch to zoom · drag to pan · double-click to open
              </div>
              {(graph?.truncations ?? []).map((t) => (
                <div key={t} className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5">
                  <Info className="w-3 h-3" /> {t}
                </div>
              ))}
            </div>

            {/* Info card for the selected node */}
            {selected && (
              <div className="absolute bottom-3 left-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur shadow-xl p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[selected.type] }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-black text-[var(--color-text)] break-words">{selected.label}</div>
                    {selected.sub && <div className="text-[11px] text-[var(--color-text-muted)] break-words">{selected.sub}</div>}
                    <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">
                      {TYPE_LABELS[selected.type].replace(/s$/, "")} · {selected.degree} connection{selected.degree === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)} aria-label="Close"
                    className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
                </div>
                {connections.length > 0 && (
                  <div className="max-h-36 overflow-y-auto space-y-0.5 border-t border-[var(--color-border)] pt-2">
                    {connections.map((c) => (
                      <button key={c.id} onClick={() => setSelected(c)}
                        className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[c.type] }} />
                        <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{c.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => open(selected)}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-black text-white bg-violet-600 hover:bg-violet-500 rounded-lg px-2 py-1.5">
                  Open <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>}>
      <GraphPageInner />
    </Suspense>
  );
}
