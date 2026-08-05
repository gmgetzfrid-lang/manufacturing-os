"use client";

// /graph — the org as one living map, in 2D or 3D.
//
// Everything the org knows — documents, equipment, units, libraries,
// projects — clustered by the relationships it actually stores. Beyond a
// note-graph, because a controlled document system knows things a vault
// doesn't:
//
//   * ORPHANS / HUBS / BRIDGES — analysis of the web's shape, not just a
//     picture of it
//   * PATH — pick two things and see the actual chain that connects them
//   * FOCUS — collapse to one node's neighbourhood at a depth you choose
//   * PROPOSALS — connections the system found, drawn as ghosts until a
//     human confirms them

import React, { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Loader2, Search, Waypoints, X, ArrowUpRight, Info, Lightbulb,
  CircleDashed, Flame, Spline, Sparkles, Route, Maximize2, CornerDownLeft, Quote,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  buildOrgGraph, type OrgGraph, type GraphNode, type GraphNodeType, type GraphEdge,
} from "@/lib/orgGraph";
import { computeInsights } from "@/lib/graphInsights";
import NodePeek from "@/components/graph/NodePeek";
import { listPendingPairs } from "@/lib/linkProposals";
import {
  GraphSim, buildAdjacency, neighborhood, shortestPath,
} from "@/lib/graphSim";
import {
  loadSettings, saveSettings, DEFAULT_GRAPH_SETTINGS, type GraphSettings,
} from "@/lib/graphSettings";
import { NODE_COLORS, EDGE_LABELS } from "@/components/graph/graphTheme";
import GraphControls from "@/components/graph/GraphControls";
import OrgGraph2D from "@/components/graph/OrgGraph2D";

// three.js only downloads when 3D is switched on.
const OrgGraph3D = React.lazy(() => import("@/components/graph/OrgGraph3D"));

const TYPE_LABELS: Record<GraphNodeType, string> = {
  document: "Documents", asset: "Equipment", unit: "Units",
  library: "Libraries", project: "Projects", plant: "Plants",
};
const TYPE_ORDER: GraphNodeType[] = ["unit", "asset", "document", "library", "project", "plant"];

interface GraphAsk {
  question: string;
  hits: Array<{ knowledgeDocumentId: string; documentName: string; libraryId: string; page: number; snippet: string }>;
  nodeIds: string[];
  assets: Array<{ assetId: string; tag: string; snippet: string; count: number }>;
  note?: string;
}

function GraphPageInner() {
  const { activeOrgId } = useRole();
  const router = useRouter();
  const params = useSearchParams();
  const focusParam = params.get("focus");

  const [graph, setGraph] = React.useState<OrgGraph | null>(null);
  const [proposals, setProposals] = React.useState<GraphEdge[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  const [rawQuery, setRawQuery] = React.useState("");
  const [selected, setSelected] = React.useState<GraphNode | null>(null);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [insightTab, setInsightTab] = React.useState<"orphans" | "hubs" | "bridges">("orphans");
  const [highlight, setHighlight] = React.useState<{ ids: string[]; nonce: number } | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [pathEnds, setPathEnds] = React.useState<{ from: GraphNode | null; to: GraphNode | null }>({ from: null, to: null });
  const [pathMode, setPathMode] = React.useState(false);

  // Asking the graph a question. The label filter stays — it's the right tool
  // for "where is E-22" — but it can never answer "any standards about pipe
  // supports", because that answer is in the TEXT of a file named
  // PIP-STE-05121. Enter searches the indexed corpus and lights up the
  // documents and equipment that hold the answer.
  const [answer, setAnswer] = React.useState<GraphAsk | null>(null);
  const [asking, setAsking] = React.useState(false);

  // Stable instance held as state, not a ref: it's read during render to
  // hand to the renderers, and its identity never changes.
  const [sim] = React.useState(() => new GraphSim());

  // ── Load settings, then data ──────────────────────────────────────────
  React.useEffect(() => {
    if (activeOrgId) setSettings(loadSettings(activeOrgId));
  }, [activeOrgId]);

  React.useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    buildOrgGraph(activeOrgId)
      .then((g) => { if (alive) setGraph(g); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    listPendingPairs(activeOrgId)
      .then((pairs) => {
        if (!alive) return;
        setProposals(pairs.map((p) => ({ a: `doc:${p.a}`, b: `doc:${p.b}`, type: "proposed" as const })));
      })
      .catch(() => { if (alive) setProposals([]); });
    return () => { alive = false; };
  }, [activeOrgId]);

  const patchSettings = React.useCallback((patch: Partial<GraphSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (activeOrgId) saveSettings(activeOrgId, next);
      return next;
    });
  }, [activeOrgId]);

  const resetSettings = React.useCallback(() => {
    setSettings(DEFAULT_GRAPH_SETTINGS);
    if (activeOrgId) saveSettings(activeOrgId, DEFAULT_GRAPH_SETTINGS);
  }, [activeOrgId]);

  const query = rawQuery.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const posKey = `orgGraph:pos${settings.mode === "3d" ? "3d" : ""}:${activeOrgId ?? ""}`;

  // ── The visible slice ─────────────────────────────────────────────────
  const view = React.useMemo(() => {
    if (!graph) return null;
    const typeOk = (t: GraphNodeType) =>
      !settings.hiddenTypes.includes(t) && (t !== "library" || settings.showLibraryEdges);
    let nodes = graph.nodes.filter((n) => typeOk(n.type));
    let ids = new Set(nodes.map((n) => n.id));
    let edges = graph.edges.filter((e) =>
      ids.has(e.a) && ids.has(e.b) && (settings.showLibraryEdges || e.type !== "library"));

    if (settings.hideUnlinked) {
      const linked = new Set<string>();
      for (const e of edges) { linked.add(e.a); linked.add(e.b); }
      nodes = nodes.filter((n) => linked.has(n.id));
      ids = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    }

    // Focus mode: collapse to one node's neighbourhood at the chosen depth.
    if (focusId && ids.has(focusId)) {
      const near = neighborhood(focusId, buildAdjacency(edges), settings.localDepth);
      nodes = nodes.filter((n) => near.has(n.id));
      ids = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
    }

    const ghosts = settings.showProposals
      ? proposals.filter((e) => ids.has(e.a) && ids.has(e.b))
      : [];
    return { nodes, edges, ghosts };
  }, [graph, settings, proposals, focusId]);

  // ── Feed the simulation ───────────────────────────────────────────────
  React.useEffect(() => {
    if (!view || !activeOrgId) return;
    // 2D and 3D keep SEPARATE saved layouts. Restoring a flat disc into the
    // 3D view guarantees a pancake that looks exactly like the 2D map.
    let restore: Record<string, [number, number, number]> | undefined;
    try {
      const raw = localStorage.getItem(posKey);
      if (raw) restore = JSON.parse(raw);
    } catch { /* first visit */ }
    sim.setGraph(
      view.nodes.map((n) => ({ id: n.id, mass: 1 + Math.min(4, n.degree * 0.12) })),
      [...view.edges, ...view.ghosts].map((e) => ({
        a: e.a, b: e.b,
        // Proposals pull weakly: an unconfirmed guess shouldn't rearrange
        // a map you already know.
        strength: e.type === "proposed" ? 0.25 : e.type === "library" ? 0.4 : 1,
      })),
      { restore },
    );
  }, [view, activeOrgId, sim, posKey]);

  // Live forces: dragging a slider is answered on the next frame, which is
  // the whole point of having sliders.
  React.useEffect(() => {
    sim.configure({
      centerForce: settings.centerForce,
      repelForce: settings.repelForce,
      linkForce: settings.linkForce,
      linkDistance: settings.linkDistance,
      dimensions: settings.mode === "3d" ? 3 : 2,
    });
  }, [
    sim, settings.centerForce, settings.repelForce, settings.linkForce,
    settings.linkDistance, settings.mode,
  ]);

  const persistPositions = React.useCallback(() => {
    if (!activeOrgId) return;
    try {
      localStorage.setItem(posKey, JSON.stringify(sim.positions()));
    } catch { /* quota — the map re-settles next visit */ }
  }, [activeOrgId, sim, posKey]);

  // ── Deep link ?focus=<docId> ──────────────────────────────────────────
  React.useEffect(() => {
    if (!focusParam || !view) return;
    const id = `doc:${focusParam}`;
    const node = view.nodes.find((n) => n.id === id);
    if (node) {
      setSelected(node);
      setHighlight({ ids: [id], nonce: Date.now() });
    }
  }, [focusParam, view]);

  const insights = React.useMemo(
    () => (view ? computeInsights(view.nodes, view.edges) : null),
    [view],
  );

  const counts = React.useMemo(() => {
    const c = {} as Record<GraphNodeType, number>;
    for (const t of TYPE_ORDER) c[t] = 0;
    for (const n of graph?.nodes ?? []) c[n.type] += 1;
    return c;
  }, [graph]);

  // ── Path between two nodes ────────────────────────────────────────────
  const path = React.useMemo(() => {
    if (!view || !pathEnds.from || !pathEnds.to) return null;
    const adj = buildAdjacency([...view.edges, ...view.ghosts]);
    const ids = shortestPath(pathEnds.from.id, pathEnds.to.id, adj, 8);
    if (!ids) return { ids: [] as string[], hops: [] as Array<{ node: GraphNode; via: string }> };
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const edgeType = (a: string, b: string) =>
      [...view.edges, ...view.ghosts].find((e) =>
        (e.a === a && e.b === b) || (e.a === b && e.b === a))?.type;
    const hops = ids.map((id, i) => ({
      node: byId.get(id)!,
      via: i === 0 ? "start" : (EDGE_LABELS[edgeType(ids[i - 1], id) ?? "tag"] ?? "connected"),
    })).filter((h) => h.node);
    return { ids, hops };
  }, [view, pathEnds]);

  const pathIds = React.useMemo(() => new Set(path?.ids ?? []), [path]);
  const highlightIds = React.useMemo(() => new Set(highlight?.ids ?? []), [highlight]);

  const runAsk = React.useCallback(async () => {
    const question = rawQuery.trim();
    if (!activeOrgId || question.length < 3 || asking) return;
    setAsking(true);
    try {
      const { supabase } = await import("@/lib/supabase");
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/graph/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ orgId: activeOrgId, question }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json();
      if (!res.ok) { setAnswer({ question, hits: [], nodeIds: [], assets: [], note: body.error }); return; }
      setAnswer(body as GraphAsk);
      // The part a search box can't do: put the answer ON THE MAP.
      if (body.nodeIds?.length) setHighlight({ ids: body.nodeIds, nonce: Date.now() });
    } catch {
      setAnswer({ question, hits: [], nodeIds: [], assets: [], note: "That search timed out." });
    } finally {
      setAsking(false);
    }
  }, [activeOrgId, rawQuery, asking]);

  const open = React.useCallback((n: GraphNode) => { router.push(n.href); }, [router]);

  // Walking the web needs a back stack. Following four links and having no
  // way back to where you started is how a graph becomes a maze.
  const [trail, setTrail] = React.useState<GraphNode[]>([]);

  const handleSelect = React.useCallback((n: GraphNode | null) => {
    if (pathMode && n) {
      setPathEnds((prev) => (!prev.from || prev.to ? { from: n, to: null } : { ...prev, to: n }));
      return;
    }
    setSelected((prev) => {
      // Only a genuine hop is history — reselecting the same node isn't.
      if (n && prev && prev.id !== n.id) setTrail((t) => [...t.slice(-19), prev]);
      if (!n) setTrail([]);
      return n;
    });
    if (!n) setHighlight(null);
  }, [pathMode]);

  const peekBack = React.useCallback(() => {
    setTrail((t) => {
      if (t.length === 0) return t;
      const prev = t[t.length - 1];
      setSelected(prev);
      setHighlight({ ids: [prev.id], nonce: Date.now() });
      return t.slice(0, -1);
    });
  }, []);

  const spotlight = React.useCallback((ids: string[], select?: GraphNode) => {
    setHighlight((prev) => ({ ids, nonce: (prev?.nonce ?? 0) + 1 }));
    if (select) setSelected(select);
  }, []);

  const connections = React.useMemo(() => {
    if (!selected || !view) return [];
    const ids = new Set<string>();
    for (const e of [...view.edges, ...view.ghosts]) {
      if (e.a === selected.id) ids.add(e.b);
      if (e.b === selected.id) ids.add(e.a);
    }
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    return [...ids].map((id) => byId.get(id)).filter((n): n is GraphNode => !!n)
      .sort((a, b) => b.degree - a.degree).slice(0, 12);
  }, [selected, view]);

  if (!activeOrgId) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>;
  }

  const focusNode = focusId ? view?.nodes.find((n) => n.id === focusId) ?? null : null;

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <Waypoints className="w-4 h-4 text-violet-600 shrink-0" />
        <h1 className="text-sm font-black text-[var(--color-text)] mr-1">Org graph</h1>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runAsk(); }}
            placeholder="Find E-22, or ask a question…"
            title="Type to light up matching nodes. Press Enter to search what your documents SAY."
            className="pl-7 pr-16 py-1.5 w-72 border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)]"
          />
          {/* Enter searches the TEXT, not the labels. A label filter can never
              answer "any standards about pipe supports" — the answer lives in
              a document whose name is PIP-STE-05121. */}
          {rawQuery.trim().length > 2 && (
            <button onClick={() => void runAsk()} disabled={asking}
              title="Search what your documents say"
              className="absolute right-6 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[10px] font-black text-violet-700 hover:text-violet-600 disabled:opacity-50">
              {asking ? <Loader2 className="w-3 h-3 animate-spin" /> : <>Ask <CornerDownLeft className="w-3 h-3" /></>}
            </button>
          )}
          {rawQuery && (
            <button onClick={() => { setRawQuery(""); setAnswer(null); }} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <button onClick={() => { setPathMode((v) => !v); setPathEnds({ from: null, to: null }); }}
          title="Pick two things and see how they connect"
          className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-full border text-[10px] font-black ${
            pathMode ? "border-cyan-400 text-cyan-700 bg-cyan-50 dark:bg-cyan-950/40"
                     : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"
          }`}>
          <Route className="w-3.5 h-3.5" /> Connection path
        </button>

        {focusNode && (
          <button onClick={() => setFocusId(null)}
            className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-full border border-violet-400 bg-violet-50 dark:bg-violet-950/40 text-[10px] font-black text-violet-700">
            <Maximize2 className="w-3.5 h-3.5" />
            Focused: {focusNode.label.slice(0, 18)} · {settings.localDepth} hop{settings.localDepth === 1 ? "" : "s"}
            <X className="w-3 h-3" />
          </button>
        )}

        {view && (
          <span className="text-[10px] font-mono text-[var(--color-text-faint)] ml-auto">
            {view.nodes.length} nodes · {view.edges.length} links
            {view.ghosts.length > 0 && ` · ${view.ghosts.length} proposed`}
          </span>
        )}
      </div>

      {/* Map */}
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
            {settings.mode === "3d" ? (
              <Suspense fallback={
                <div className="absolute inset-0 flex items-center justify-center bg-[#0b1020]">
                  <div className="text-[11px] font-bold text-slate-400">Loading the 3D engine…</div>
                </div>
              }>
                <OrgGraph3D
                  nodes={view.nodes}
                  edges={[...view.edges, ...view.ghosts]}
                  sim={sim}
                  settings={settings}
                  query={query}
                  selectedId={selected?.id ?? null}
                  highlightIds={highlightIds}
                  pathIds={pathIds}
                  regions={insights?.regions ?? []}
                  flyTo={highlight}
                  onSelect={handleSelect}
                  onOpen={open}
                  onSettled={persistPositions}
                />
              </Suspense>
            ) : (
              <OrgGraph2D
                nodes={view.nodes}
                edges={[...view.edges, ...view.ghosts]}
                sim={sim}
                settings={settings}
                query={query}
                selectedId={selected?.id ?? null}
                highlightIds={highlightIds}
                pathIds={pathIds}
                regions={insights?.regions ?? []}
                flyTo={highlight}
                onSelect={handleSelect}
                onOpen={open}
                onSettled={persistPositions}
              />
            )}

            <GraphControls
              settings={settings}
              onChange={patchSettings}
              counts={counts}
              onReset={resetSettings}
            />

            {/* Insights */}
            <div className="absolute top-2 left-3 flex flex-col items-start gap-2 max-h-[calc(100%-1rem)] z-10">
              <button onClick={() => setInsightsOpen((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-black shadow-sm ${
                  insightsOpen ? "border-violet-400 text-violet-700 bg-[var(--color-surface)]"
                               : "border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)]/90 backdrop-blur"
                }`}>
                <Lightbulb className="w-3.5 h-3.5 text-violet-600" /> Insights
                {insights && insights.orphans.length > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-700 text-[9px] font-black">
                    {insights.orphans.length}
                  </span>
                )}
              </button>

              {insightsOpen && insights && (
                <div className="w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl overflow-hidden flex flex-col min-h-0">
                  <div className="flex border-b border-[var(--color-border)]">
                    {([
                      { key: "orphans" as const, label: "Orphans", icon: CircleDashed, count: insights.orphans.length, tone: "text-rose-600" },
                      { key: "hubs" as const, label: "Hubs", icon: Flame, count: insights.hubs.length, tone: "text-amber-600" },
                      { key: "bridges" as const, label: "Bridges", icon: Spline, count: insights.bridges.length, tone: "text-violet-600" },
                    ]).map((t) => (
                      <button key={t.key}
                        onClick={() => { setInsightTab(t.key); if (t.key === "orphans") patchSettings({ hideUnlinked: false }); }}
                        className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-2 text-[10px] font-black uppercase tracking-wide ${
                          insightTab === t.key ? `${t.tone} border-b-2 border-current` : "text-[var(--color-text-faint)]"
                        }`}>
                        <t.icon className="w-3 h-3" /> {t.label} <span className="font-mono font-normal">{t.count}</span>
                      </button>
                    ))}
                  </div>

                  <div className="overflow-y-auto max-h-72 p-1.5 space-y-0.5">
                    {insightTab === "orphans" && (
                      insights.orphans.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-muted)] p-2">
                          No orphans — everything shown is tied into the web.
                        </div>
                      ) : (
                        <>
                          <div className="text-[10px] text-[var(--color-text-muted)] px-1.5 pb-1">
                            Floating with no equipment, unit, project or link — no context yet.
                          </div>
                          {insights.orphans.slice(0, 100).map((n) => (
                            <button key={n.id} onClick={() => spotlight([n.id], n)}
                              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[n.type] }} />
                              <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{n.label}</span>
                              <ArrowUpRight className="w-3 h-3 text-[var(--color-text-faint)] shrink-0" />
                            </button>
                          ))}
                          {insights.orphans.length > 100 && (
                            <div className="text-[10px] text-[var(--color-text-faint)] px-1.5 py-1">…and {insights.orphans.length - 100} more</div>
                          )}
                        </>
                      )
                    )}

                    {insightTab === "hubs" && (
                      insights.hubs.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-muted)] p-2">Hubs appear once nodes collect 3+ connections.</div>
                      ) : (
                        <>
                          <div className="text-[10px] text-[var(--color-text-muted)] px-1.5 pb-1">
                            The most-referenced nodes. Touch one and the blast radius is wide.
                          </div>
                          {insights.hubs.map((h) => (
                            <button key={h.node.id} onClick={() => spotlight([h.node.id], h.node)}
                              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[h.node.type] }} />
                              <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{h.node.label}</span>
                              <span className="shrink-0 text-[10px] font-mono text-amber-700">{h.degree}</span>
                            </button>
                          ))}
                        </>
                      )
                    )}

                    {insightTab === "bridges" && (
                      insights.bridges.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-muted)] p-2">
                          No single-thread bridges — every big neighbourhood has redundant connections.
                        </div>
                      ) : (
                        <>
                          <div className="text-[10px] text-[var(--color-text-muted)] px-1.5 pb-1">
                            One thin line holding two clusters together. Click to light it up.
                          </div>
                          {insights.bridges.map((b) => (
                            <button key={`${b.a.id}|${b.b.id}`} onClick={() => { spotlight([b.a.id, b.b.id]); setSelected(null); }}
                              className="w-full px-1.5 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-left">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[b.a.type] }} />
                                <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{b.a.label}</span>
                                <span className="text-[10px] text-amber-600 font-black shrink-0">↔</span>
                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[b.b.type] }} />
                                <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{b.b.label}</span>
                              </div>
                              <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">
                                Only link between clusters of {b.sideA} and {b.sideB} nodes
                              </div>
                            </button>
                          ))}
                        </>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Path panel */}
            {pathMode && (
              <div className="absolute bottom-3 right-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-cyan-300 dark:border-cyan-900 bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl p-3 space-y-2 z-10">
                <div className="flex items-center gap-1.5">
                  <Route className="w-3.5 h-3.5 text-cyan-600" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)] flex-1">Connection path</span>
                  <button onClick={() => { setPathMode(false); setPathEnds({ from: null, to: null }); }}
                    aria-label="Close" className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {!pathEnds.from ? (
                  <div className="text-[11px] text-[var(--color-text-muted)]">Click the first node on the map.</div>
                ) : !pathEnds.to ? (
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    From <b className="text-[var(--color-text)]">{pathEnds.from.label}</b> — now click the second node.
                  </div>
                ) : path && path.ids.length === 0 ? (
                  <div className="text-[11px] text-amber-700">
                    Nothing connects <b>{pathEnds.from.label}</b> and <b>{pathEnds.to.label}</b> within 8 hops in this view.
                    Try turning filters back on.
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {(path?.hops.length ?? 1) - 1} hop{(path?.hops.length ?? 2) - 1 === 1 ? "" : "s"} apart
                    </div>
                    {path?.hops.map((h, i) => (
                      <div key={h.node.id} className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: NODE_COLORS[h.node.type] }} />
                        <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{h.node.label}</span>
                        {i > 0 && <span className="shrink-0 text-[9px] text-cyan-700">{h.via}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {pathEnds.from && (
                  <button onClick={() => setPathEnds({ from: null, to: null })}
                    className="text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    Start over
                  </button>
                )}
              </div>
            )}

            {/* Hints + truncation */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-center space-y-1 pointer-events-none">
              <div className="text-[10px] font-bold text-[var(--color-text-faint)]">
                {settings.mode === "3d"
                  ? "drag to orbit · shift-drag or right-drag to pan · scroll to zoom · double-click to open"
                  : "scroll or pinch to zoom · drag to pan · drag a node to move it · double-click to open"}
              </div>
              {(graph?.truncations ?? []).map((t) => (
                <div key={t} className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5">
                  <Info className="w-3 h-3" /> {t}
                </div>
              ))}
            </div>

            {view.ghosts.length > 0 && (
              <Link href="/admin/proposed-links"
                className="absolute bottom-3 left-3 inline-flex items-center gap-1 text-[10px] font-black text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-1 hover:bg-amber-100 z-10">
                <Sparkles className="w-3 h-3" />
                {view.ghosts.length} dashed connection{view.ghosts.length === 1 ? "" : "s"} awaiting review
              </Link>
            )}

            {/* The answer, with its evidence, over the lit-up map. This is
                the thing a label filter can never be: you asked in English,
                and the map is now showing you WHERE that knowledge lives. */}
            {answer && !pathMode && (
              <div className="absolute top-3 left-3 w-96 max-w-[calc(100%-1.5rem)] max-h-[75%] flex flex-col rounded-xl border border-violet-300 dark:border-violet-800 bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl z-10">
                <div className="flex items-start gap-2 p-3 pb-2 shrink-0">
                  <Quote className="w-3.5 h-3.5 mt-0.5 text-violet-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-black text-[var(--color-text)] break-words">{answer.question}</div>
                    <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">
                      {answer.hits.length > 0
                        ? `${answer.hits.length} passage${answer.hits.length === 1 ? "" : "s"} · ${answer.nodeIds.length} node${answer.nodeIds.length === 1 ? "" : "s"} lit up`
                        : "No matches"}
                    </div>
                  </div>
                  <button onClick={() => setAnswer(null)} aria-label="Close answer"
                    className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
                </div>

                <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5 min-h-0">
                  {answer.note && (
                    <div className="text-[11px] text-[var(--color-text-muted)] leading-snug bg-[var(--color-surface-2)] rounded-lg px-2 py-1.5">
                      {answer.note}
                    </div>
                  )}

                  {/* Equipment the answer is about — click to fly there. */}
                  {answer.assets.length > 0 && (
                    <div className="flex flex-wrap gap-1 pb-1">
                      {answer.assets.map((a) => (
                        <button key={a.assetId} title={a.snippet}
                          onClick={() => {
                            const n = view?.nodes.find((x) => x.id === `asset:${a.assetId}`);
                            if (n) { handleSelect(n); setHighlight({ ids: [n.id], nonce: Date.now() }); }
                          }}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-[var(--color-border-strong)] text-[10px] font-black text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: NODE_COLORS.asset }} />
                          {a.tag}
                          <span className="text-[var(--color-text-faint)]">{a.count}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {answer.hits.map((h, i) => (
                    <div key={`${h.knowledgeDocumentId}-${h.page}-${i}`}
                      className="rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5">
                      <div className="flex items-center gap-1 text-[10px] font-black text-[var(--color-text)]">
                        <span className="truncate">{h.documentName}</span>
                        <span className="ml-auto shrink-0 text-[var(--color-text-faint)]">p.{h.page}</span>
                      </div>
                      {/* ts_headline marks the terms; render as text, never HTML. */}
                      <div className="text-[11px] text-[var(--color-text-muted)] leading-snug mt-0.5">
                        {h.snippet.replace(/<\/?b>/g, "")}
                      </div>
                      <Link href={`/knowledge/${h.libraryId}?doc=${h.knowledgeDocumentId}&page=${h.page}`}
                        className="inline-flex items-center gap-1 text-[10px] font-black text-violet-700 hover:text-violet-600 mt-1">
                        Open at page {h.page} <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Peek — see it, understand why it's linked, walk on. The old
                card here told you the node's type and then made you leave the
                map to learn anything else, which is why the graph felt like a
                picture instead of a tool. */}
            {selected && !pathMode && activeOrgId && (
              <NodePeek
                node={selected}
                orgId={activeOrgId}
                connections={connections}
                focused={!!focusId}
                historyDepth={trail.length}
                colorFor={(t) => NODE_COLORS[t]}
                labelFor={(t) => TYPE_LABELS[t].replace(/s$/, "")}
                onSelect={handleSelect}
                onBack={peekBack}
                onGoIn={() => { setFocusId(selected.id); setHighlight({ ids: [selected.id], nonce: Date.now() }); }}
                onGoOut={() => { setFocusId(null); setHighlight({ ids: [selected.id], nonce: Date.now() }); }}
                onOpen={() => open(selected)}
                onPath={() => { setPathMode(true); setPathEnds({ from: selected, to: null }); }}
                onClose={() => { setSelected(null); setTrail([]); setHighlight(null); }}
              />
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
