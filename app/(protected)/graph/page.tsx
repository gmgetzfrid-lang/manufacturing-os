"use client";

// /graph — the org as one living map, in 2D or 3D.
//
// Everything the org knows — documents, equipment, units, libraries,
// projects — clustered by the relationships it actually stores. Beyond a
// note-graph, because a controlled document system knows things a vault
// doesn't:
//
//   * ORPHANS / HUBS / BRIDGES — analysis of the web's shape, not just a
//     picture of it — counted on the WHOLE map, whatever the lens shows, and
//     labelled as computed on what this reader can see (GM-1 / GM-6)
//   * PATH — pick two things and see the actual chain that connects them
//   * FOCUS — collapse to one node's neighbourhood at a depth you choose,
//     nearer nodes drawn stronger (GPV-9)
//   * SCOPE — assemble one unit's world (lib/scope.ts), picked here or from a
//     unit's peek, arriving from the operating area as ?scope=unit:<code>
//   * PROPOSALS — connections the system found, drawn as ghosts until a
//     human confirms them; a failed or capped read is said (GM-7)
//
// What you are looking at lives in the URL (GPV-11 — lib/graphSettings.ts
// formatGraphUrl): the lens, the focus and its depth, the scope, the search,
// an asked question and the node in the peek. `?focus=<id>` — every existing
// link's spelling — still selects and flies to a node, once per link
// (GPV-5). Forces, colours and 2D/3D stay per-org local. The URL is written
// within the History API's budget (lib/graphView.ts rateLimitedWriter), only
// while the browser is still on /graph, and the search box reaches it when
// asked or left — never per keystroke.
//
// The map region is focusable: arrow keys step through nodes, Enter selects
// (and picks a Path or Connect end), Escape closes the top overlay (GPV-13).

import React, { Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import {
  Loader2, Search, Waypoints, X, ArrowUpRight, Info, Lightbulb,
  CircleDashed, Flame, Spline, Sparkles, Route, Maximize2, CornerDownLeft, Quote, Link2,
  Minus, Plus, LocateFixed, RefreshCw,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import {
  buildOrgGraph, type OrgGraph, type GraphNode, type GraphNodeType, type GraphEdge,
} from "@/lib/orgGraph";
import { computeInsights } from "@/lib/graphInsights";
import NodePeek from "@/components/graph/NodePeek";
import { readPendingProposalPairs, PENDING_PAIRS_CAP } from "@/lib/linkProposals";
import { GraphSim, buildAdjacency, shortestPath } from "@/lib/graphSim";
import {
  loadSettings, saveSettings, applyGraphUrl, parseGraphUrl, formatGraphUrl, urlFilterOf, matchLens,
  DEFAULT_GRAPH_SETTINGS, LOCAL_DEPTH_MIN, LOCAL_DEPTH_MAX,
  type GraphSettings, type GraphLens, type SavedGraphView,
} from "@/lib/graphSettings";
import { formatScopeParam, parseScopeParam, type ScopeRef } from "@/lib/scope";
import {
  sliceView, viewDegree, answerVisibility, planConnect, connectOffer, keyboardOrder, keyboardBaseOrder,
  keyboardQuery, mentionNotice, rateLimitedWriter, GRAPH_PATH, type UrlWriteResult,
} from "@/lib/graphView";
import { edgeLabelFor, nodeColorFor, unitVariant, type UnitVariant } from "@/components/graph/graphTheme";
import GraphControls from "@/components/graph/GraphControls";
import GraphLensBar from "@/components/graph/GraphLensBar";
import GraphLegend from "@/components/graph/GraphLegend";
import OrgGraph2D from "@/components/graph/OrgGraph2D";

// three.js only downloads when 3D is switched on.
const OrgGraph3D = React.lazy(() => import("@/components/graph/OrgGraph3D"));

const TYPE_LABELS: Record<GraphNodeType, string> = {
  document: "Documents", asset: "Equipment", unit: "Units",
  library: "Libraries", project: "Projects", plant: "Plants", plot: "Plot plans",
};
const TYPE_ORDER: GraphNodeType[] = ["unit", "asset", "document", "library", "project", "plant", "plot"];

interface GraphAsk {
  question: string;
  hits: Array<{ knowledgeDocumentId: string; documentName: string; libraryId: string; page: number; snippet: string }>;
  nodeIds: string[];
  assets: Array<{ assetId: string; tag: string; snippet: string; count: number }>;
  note?: string;
}

/** Add an edge the rebuild would draw, unless it is already there (a flow
 *  keeps its direction; every other type is an unordered pair). */
function withEdge(g: OrgGraph, e: GraphEdge): OrgGraph {
  const same = (x: GraphEdge) => x.type === e.type && (
    (x.a === e.a && x.b === e.b) || (e.type !== "flow" && e.type !== "supersession" && x.a === e.b && x.b === e.a));
  return g.edges.some(same) ? g : { ...g, edges: [...g.edges, e] };
}

const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/** The sessionStorage snapshot key of a map: the org's, or one scope's. */
const snapKeyOf = (orgId: string, scopeKey: string) => (scopeKey ? `org-graph-${orgId}-${scopeKey}` : `org-graph-${orgId}`);

function GraphPageInner() {
  const { activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  const router = useRouter();
  const pathname = usePathname() || "/graph";
  const params = useSearchParams();
  const paramsKey = params.toString();

  const [graph, setGraph] = React.useState<OrgGraph | null>(null);
  // Which snapshot key the graph on screen belongs to (org-wide or a scope):
  // the ref for the data effect, the state for the URL's selection, which
  // must never be honoured against the map a scope change is leaving.
  const graphFor = React.useRef<string | null>(null);
  const [graphKey, setGraphKey] = React.useState<string | null>(null);
  // The snapshot key whose fresh build (or failure) has landed.
  const [freshKey, setFreshKey] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [proposals, setProposals] = React.useState<GraphEdge[]>([]);
  const [proposalRead, setProposalRead] = React.useState<{ total: number | null; capped: boolean; error: string | null } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [settings, setSettings] = React.useState<GraphSettings>(DEFAULT_GRAPH_SETTINGS);
  const [applied, setApplied] = React.useState(false);
  const [rawQuery, setRawQuery] = React.useState("");
  // The search as the URL carries it: committed when asked (Enter / Ask),
  // when the box is left, or when cleared — never on every keystroke, which
  // would spend the History API's budget (GPV-11).
  const [urlQ, setUrlQ] = React.useState("");
  const [selected, setSelected] = React.useState<GraphNode | null>(null);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [insightTab, setInsightTab] = React.useState<"orphans" | "hubs" | "bridges">("orphans");
  const [highlight, setHighlight] = React.useState<{ ids: string[]; nonce: number } | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const [pathEnds, setPathEnds] = React.useState<{ from: GraphNode | null; to: GraphNode | null }>({ from: null, to: null });
  const [pathMode, setPathMode] = React.useState(false);
  // A node a URL asked for (?select= / ?focus=), honoured ONCE when the map
  // holds it — never again on a slider tick (GPV-5).
  const [pendingSelect, setPendingSelect] = React.useState<string | null>(null);
  const [selectMiss, setSelectMiss] = React.useState<string | null>(null);
  const [pendingAsk, setPendingAsk] = React.useState<string | null>(null);
  const [lensUndo, setLensUndo] = React.useState<Pick<GraphSettings, "hiddenTypes" | "showLibraryEdges"> | null>(null);
  const [unitOptions, setUnitOptions] = React.useState<Array<{ code: string; label: string }>>([]);
  const [mentionRun, setMentionRun] = React.useState<{ running: boolean; message: string | null; error: boolean } | null>(null);
  // Drawing a connection BY HAND, right on the map: pick the source in the
  // peek, click the target, the edge is written and drawn. Documents and
  // equipment only — every other tie is derived from the registry.
  const [connect, setConnect] = React.useState<{
    from: GraphNode; status: "picking" | "saving";
    done?: { a: string; b: string }; error?: string;
  } | null>(null);

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

  // Walking the web needs a back stack. Following four links and having no
  // way back to where you started is how a graph becomes a maze.
  const [trail, setTrail] = React.useState<GraphNode[]>([]);

  // ── The URL → the view (on arrival, and on any navigation from outside) ─
  // The page writes its own view back with history.replaceState; a URL the
  // page wrote is not re-applied. `written` holds the writes Next.js has not
  // echoed back through useSearchParams yet, in order — a write can be
  // deferred by the budget, so more than one can be in flight.
  const written = React.useRef<string[]>([]);
  const appliedOrg = React.useRef<string | null>(null);
  // The person's stored settings as loaded, and as they change them: a
  // URL's filter is applied over them without being saved, and a later
  // change of anything else saves onto THESE, never the URL's filter
  // (DEC-88 item 3).
  const stored = React.useRef<GraphSettings | null>(null);
  React.useEffect(() => {
    if (!activeOrgId) return;
    if (appliedOrg.current === activeOrgId) {
      const i = written.current.indexOf(paramsKey);
      if (i >= 0) { written.current = written.current.slice(i); return; }
    }
    appliedOrg.current = activeOrgId;
    written.current = [paramsKey];
    const url = parseGraphUrl(new URLSearchParams(paramsKey));
    const base = loadSettings(activeOrgId);
    stored.current = base;
    setSettings(applyGraphUrl(base, url));
    setFocusId(url.local);
    setRawQuery(url.q ?? "");
    setUrlQ(url.q ?? "");
    setAnswer(null);
    setSelected(null);
    setTrail([]);
    setHighlight(null);
    setSelectMiss(null);
    setLensUndo(null);
    setPendingSelect(url.select);
    setPendingAsk(url.ask && url.q ? url.q : null);
    setApplied(true);
  }, [activeOrgId, paramsKey]);

  const scopeKey = settings.scope ? formatScopeParam(settings.scope) : "";

  // ── Data: the graph (org-wide, or one unit's world) ───────────────────
  React.useEffect(() => {
    if (!activeOrgId || !applied) return;
    let alive = true;
    const scope = scopeKey ? parseScopeParam(scopeKey) : null;
    // Stale-while-revalidate: the graph is a dozen parallel table pulls —
    // fast, but never instant. The LAST BUILT graph paints immediately from
    // sessionStorage (the layout starts settling right away), and the fresh
    // build swaps in when it lands. Oversized graphs skip the cache rather
    // than fight the storage quota. A scoped map has its own snapshot.
    const snapKey = snapKeyOf(activeOrgId, scope ? scopeKey : "");
    setFreshKey(null);
    setError(null);
    let painted = false;
    try {
      const cached = window.sessionStorage.getItem(snapKey);
      if (cached) { setGraph(JSON.parse(cached) as OrgGraph); painted = true; }
    } catch { /* no snapshot */ }
    // A different map (another scope) never shows the last one's nodes.
    if (!painted && graphFor.current !== snapKey) setGraph(null);
    graphFor.current = snapKey;
    setGraphKey(snapKey);
    (scope ? buildOrgGraph(activeOrgId, { scope }) : buildOrgGraph(activeOrgId))
      .then((g) => {
        if (!alive) return;
        setGraph(g);
        setFreshKey(snapKey);
        try {
          const s = JSON.stringify(g);
          if (s.length < 2_000_000) window.sessionStorage.setItem(snapKey, s);
        } catch { /* quota — fresh build still rendered */ }
      })
      .catch((e) => { if (alive) { setError((e as Error).message); setFreshKey(snapKey); } });
    return () => { alive = false; };
  }, [activeOrgId, applied, scopeKey, reloadNonce]);

  // Proposals are org-wide pairs; the view keeps the ones it can draw.
  React.useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    readPendingProposalPairs(activeOrgId)
      .then((r) => {
        if (!alive) return;
        setProposals(r.pairs.map((p) => ({ a: p.nodeA, b: p.nodeB, type: "proposed" as const })));
        setProposalRead({ total: r.total, capped: r.capped, error: r.error });
      })
      .catch((e) => {
        if (!alive) return;
        setProposals([]);
        setProposalRead({ total: null, capped: false, error: (e as Error).message });
      });
    return () => { alive = false; };
  }, [activeOrgId]);

  // The scope picker's units (the Site Codebook's, by its own names).
  React.useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    import("@/lib/codebook")
      .then(({ loadCodebook }) => loadCodebook(activeOrgId))
      .then((book) => { if (alive) setUnitOptions(book.units.map((u) => ({ code: u.code, label: u.label || `Unit ${u.code}` }))); })
      .catch(() => { if (alive) setUnitOptions([]); });
    return () => { alive = false; };
  }, [activeOrgId]);

  // Save what the person changed onto their stored settings — never the
  // filter, depth or scope a URL applied (DEC-88 item 3).
  const persist = React.useCallback((patch: Partial<GraphSettings>) => {
    if (!activeOrgId) return;
    const next = { ...(stored.current ?? loadSettings(activeOrgId)), ...patch };
    stored.current = next;
    saveSettings(activeOrgId, next);
  }, [activeOrgId]);

  const patchSettings = React.useCallback((patch: Partial<GraphSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    persist(patch);
  }, [persist]);

  const resetSettings = React.useCallback(() => {
    // Saved views are the person's, and the scope is the URL's: a reset of
    // the drawing settings keeps both.
    setSettings((prev) => ({ ...DEFAULT_GRAPH_SETTINGS, scope: prev.scope, savedViews: prev.savedViews }));
    if (activeOrgId) persist({ ...DEFAULT_GRAPH_SETTINGS, savedViews: (stored.current ?? loadSettings(activeOrgId)).savedViews });
  }, [activeOrgId, persist]);

  const setScope = React.useCallback((scope: ScopeRef | null, thenSelect?: string) => {
    setSettings((prev) => ({ ...prev, scope }));
    setFocusId(null);
    setSelected(null);
    setTrail([]);
    setHighlight(null);
    setSelectMiss(null);
    setPendingSelect(thenSelect ?? null);
  }, []);

  const query = rawQuery.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const posKey = `orgGraph:pos${settings.mode === "3d" ? "3d" : ""}:${activeOrgId ?? ""}`;

  // ── The visible slice ─────────────────────────────────────────────────
  // Only the settings that FILTER are dependencies: a force slider changes
  // the layout, never the slice (GPV-5's root — the slice used to be rebuilt
  // on every slider tick).
  const view = React.useMemo(() => (graph
    ? sliceView(graph, {
      hiddenTypes: settings.hiddenTypes, showLibraryEdges: settings.showLibraryEdges,
      hideUnlinked: settings.hideUnlinked, showProposals: settings.showProposals, localDepth: settings.localDepth,
    }, proposals, focusId)
    : null), [graph, settings.hiddenTypes, settings.showLibraryEdges, settings.hideUnlinked, settings.showProposals, settings.localDepth, proposals, focusId]);

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

  // ── A node the URL asked for: selected and flown to, ONCE ─────────────
  // Only against the map the current scope asks for: after a scope change
  // the old map is still on screen for one commit, and its node (or its
  // absence) says nothing about the new one.
  const snapKeyNow = activeOrgId ? snapKeyOf(activeOrgId, scopeKey) : null;
  React.useEffect(() => {
    if (!pendingSelect || !view || !snapKeyNow || graphKey !== snapKeyNow) return;
    const node = view.nodes.find((n) => n.id === pendingSelect);
    if (node) {
      setSelected(node);
      setHighlight({ ids: [node.id], nonce: Date.now() });
      setPendingSelect(null);
    } else if (freshKey === snapKeyNow) {
      // The fresh build does not draw it here — say so once, never retry.
      setSelectMiss(pendingSelect);
      setPendingSelect(null);
    }
  }, [pendingSelect, view, graphKey, freshKey, snapKeyNow]);

  // ── Insights: the WHOLE map, labelled (GM-1 / GM-6) ───────────────────
  const insights = React.useMemo(
    () => (graph ? computeInsights(graph.nodes, graph.edges, { access: graph.access ?? null }) : null),
    [graph],
  );
  // Region names label what the map draws, so they follow the view.
  const regions = React.useMemo(() => (view ? computeInsights(view.nodes, view.edges).regions : []), [view]);
  const inView = React.useMemo(() => new Set(view?.nodes.map((n) => n.id) ?? []), [view]);

  const counts = React.useMemo(() => {
    const c = {} as Record<GraphNodeType, number>;
    for (const t of TYPE_ORDER) c[t] = 0;
    for (const n of graph?.nodes ?? []) c[n.type] += 1;
    return c;
  }, [graph]);
  const viewCounts = React.useMemo(() => {
    const c = {} as Record<GraphNodeType, number>;
    for (const t of TYPE_ORDER) c[t] = 0;
    for (const n of view?.nodes ?? []) c[n.type] += 1;
    return c;
  }, [view]);
  const unitBreakdown = React.useMemo(() => {
    const c: Record<UnitVariant, number> = { codebook: 0, operational: 0, system: 0 };
    for (const n of graph?.nodes ?? []) { const v = unitVariant(n); if (v) c[v] += 1; }
    return c;
  }, [graph]);

  // ── Path between two nodes ────────────────────────────────────────────
  const path = React.useMemo(() => {
    if (!view || !pathEnds.from || !pathEnds.to) return null;
    const adj = buildAdjacency([...view.edges, ...view.ghosts]);
    const ids = shortestPath(pathEnds.from.id, pathEnds.to.id, adj, 8);
    if (!ids) return { ids: [] as string[], hops: [] as Array<{ node: GraphNode; via: string }> };
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const edgeOf = (a: string, b: string) =>
      [...view.edges, ...view.ghosts].find((e) =>
        (e.a === a && e.b === b) || (e.a === b && e.b === a));
    const hops = ids.map((id, i) => {
      const e = i === 0 ? undefined : edgeOf(ids[i - 1], id);
      return { node: byId.get(id)!, via: i === 0 ? "start" : (e ? edgeLabelFor(e) : "connected") };
    }).filter((h) => h.node);
    return { ids, hops };
  }, [view, pathEnds]);

  const pathIds = React.useMemo(() => new Set(path?.ids ?? []), [path]);
  const highlightIds = React.useMemo(() => new Set(highlight?.ids ?? []), [highlight]);

  const askQuestion = React.useCallback(async (question: string) => {
    if (!activeOrgId || question.length < 3) return;
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
  }, [activeOrgId]);

  const runAsk = React.useCallback(() => {
    setUrlQ(rawQuery);
    if (asking) return;
    void askQuestion(rawQuery.trim());
  }, [asking, askQuestion, rawQuery]);

  // A URL that carried an asked question (ask=1) asks it again, once.
  React.useEffect(() => {
    if (!pendingAsk || !activeOrgId) return;
    const q = pendingAsk;
    setPendingAsk(null);
    void askQuestion(q);
  }, [pendingAsk, activeOrgId, askQuestion]);

  // ── The view → the URL ────────────────────────────────────────────────
  const urlNow = React.useMemo(() => formatGraphUrl({
    scope: settings.scope,
    ...urlFilterOf(settings),
    local: focusId,
    depth: focusId ? settings.localDepth : null,
    q: urlQ,
    ask: (!!answer && answer.question === urlQ.trim()) || pendingAsk === urlQ.trim(),
    select: selected?.id ?? pendingSelect,
  }, paramsKey), [settings, focusId, urlQ, answer, pendingAsk, selected, pendingSelect, paramsKey]);

  // Written within the History API's budget (a browser throws past it, and
  // Next.js answers each write with a replaceState of its own): a burst
  // lands at once, a stream is coalesced to its latest value, and a refused
  // write is skipped and retried — never thrown into the page.
  const [urlWriter] = React.useState(() => rateLimitedWriter<{ qs: string; href: string }>((v): UrlWriteResult => {
    // Only while the browser is still on the graph: a write the budget
    // deferred can come due after a navigation away (a link, Back) and
    // before this page unmounts — it never rewrites that page's entry.
    if (window.location.pathname !== GRAPH_PATH) return "noop";
    if (window.location.search.replace(/^\?/, "") === v.qs) {
      if (!written.current.includes(v.qs)) written.current.push(v.qs);
      return "noop";
    }
    try {
      // `null` state: Next.js keeps its own history entry and syncs
      // useSearchParams with the new query.
      window.history.replaceState(null, "", v.href);
    } catch {
      return "failed";
    }
    written.current.push(v.qs);
    if (written.current.length > 64) written.current = written.current.slice(-64);
    return "done";
  }));
  // A write still waiting for budget is dropped on a route change away from
  // the graph, on Back / Forward (the URL → view effect applies the entry
  // the browser moved to) and on unmount.
  React.useEffect(() => {
    if (pathname !== GRAPH_PATH) urlWriter.cancel();
  }, [pathname, urlWriter]);
  React.useEffect(() => {
    const drop = () => urlWriter.cancel();
    window.addEventListener("popstate", drop);
    return () => { window.removeEventListener("popstate", drop); urlWriter.cancel(); };
  }, [urlWriter]);

  React.useEffect(() => {
    if (!applied || typeof window === "undefined" || pathname !== GRAPH_PATH) return;
    urlWriter.push({ qs: urlNow, href: urlNow ? `${GRAPH_PATH}?${urlNow}` : GRAPH_PATH });
  }, [applied, urlNow, pathname, urlWriter]);

  // `from=graph` lets the destination page offer a way back; `graphq` is
  // this view, so the way back restores it (BackToGraphChip — GPV-11).
  const open = React.useCallback((n: GraphNode) => {
    const back = urlNow ? `&graphq=${encodeURIComponent(urlNow)}` : "";
    router.push(`${n.href}${n.href.includes("?") ? "&" : "?"}from=graph${back}`);
  }, [router, urlNow]);

  const completeConnect = React.useCallback(async (from: GraphNode, target: GraphNode) => {
    if (!activeOrgId || !uid) return;
    const plan = planConnect(from, target);
    if (!plan) return;
    if (plan.kind === "refused") {
      setConnect((c) => c && ({ ...c, status: "picking", error: plan.message }));
      return;
    }
    setConnect((c) => c && ({ ...c, status: "saving", error: undefined }));
    try {
      if (plan.kind === "flow") {
        // GPV-7: the ends are written by their codebook identity
        // (GraphNode.unitCode), and the edge drawn now is on the node ids the
        // rebuild produces — a refresh never contradicts the confirmation.
        const { createManualFlow } = await import("@/lib/processFlows");
        await createManualFlow({
          orgId: activeOrgId,
          fromKind: plan.from.kind, fromRef: plan.from.ref,
          toKind: plan.to.kind, toRef: plan.to.ref,
          userId: uid, userName: userEmail ?? undefined,
        });
        setGraph((g) => g ? withEdge(g, { a: plan.a, b: plan.b, type: "flow" }) : g);
        setConnect({ from, status: "picking", done: { a: from.label, b: `${target.label} (flow)` } });
        return;
      }
      if (plan.kind === "related") {
        const { addRelatedResource } = await import("@/lib/relatedResources");
        await addRelatedResource({
          orgId: activeOrgId, documentId: plan.documentId, kind: "document",
          targetDocumentId: plan.targetDocumentId, label: "Linked on the graph",
          userId: uid, userName: userEmail ?? undefined,
        });
      } else {
        const { supabase } = await import("@/lib/supabase");
        const { error } = await supabase.from("document_assets").insert({
          org_id: activeOrgId, document_id: plan.documentId, asset_id: plan.assetId,
          tag_text: plan.tag, source: "manual",
        });
        // 23505 = already linked — the edge the user wanted already exists.
        if (error && error.code !== "23505") throw new Error(error.message);
      }
      // Draw it now — the row is real, the rebuild would only rediscover it.
      const edge: GraphEdge = plan.kind === "related"
        ? { a: from.id, b: target.id, type: "related" }
        : { a: `doc:${plan.documentId}`, b: `asset:${plan.assetId}`, type: "tag" };
      setGraph((g) => g ? withEdge(g, edge) : g);
      setConnect({ from, status: "picking", done: { a: from.label, b: target.label } });
    } catch (e) {
      setConnect((c) => c && ({ ...c, status: "picking", error: (e as Error).message }));
    }
  }, [activeOrgId, uid, userEmail]);

  const handleSelect = React.useCallback((n: GraphNode | null) => {
    if (connect?.status === "picking" && n) {
      void completeConnect(connect.from, n);
      return;
    }
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
  }, [pathMode, connect, completeConnect]);

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

  // The peek's list: the NODES the selection is tied to in this view — by a
  // drawn link or by a proposal ghost — and how many of them only by a
  // proposal (GM-11: the list counts nodes, the header counts links).
  const { allConnections, proposedOnly } = React.useMemo(() => {
    if (!selected || !view) return { allConnections: [] as GraphNode[], proposedOnly: 0 };
    const linked = new Set<string>(), proposed = new Set<string>();
    for (const e of view.edges) {
      if (e.a === selected.id) linked.add(e.b);
      if (e.b === selected.id) linked.add(e.a);
    }
    for (const e of view.ghosts) {
      if (e.a === selected.id && !linked.has(e.b)) proposed.add(e.b);
      if (e.b === selected.id && !linked.has(e.a)) proposed.add(e.a);
    }
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const list = [...linked, ...proposed].map((id) => byId.get(id)).filter((n): n is GraphNode => !!n)
      .sort((a, b) => b.degree - a.degree);
    return { allConnections: list, proposedOnly: [...proposed].filter((id) => byId.has(id)).length };
  }, [selected, view]);
  const connections = React.useMemo(() => allConnections.slice(0, 12), [allConnections]);

  // GM-11: one node, labelled numbers — its links on the whole map (the
  // radius uses the same), how many of those are library filing (the Hubs
  // count leaves them out), and its links in this view (drawn edges, never a
  // proposal ghost — the assembly's `degree` counts no proposal either).
  const peekCounts = React.useMemo(() => {
    if (!selected || !graph || !view) return null;
    let library = 0;
    for (const e of graph.edges) if (e.type === "library" && (e.a === selected.id || e.b === selected.id)) library += 1;
    return { library, inView: viewDegree(selected.id, view.edges) };
  }, [selected, graph, view]);

  // ── Lenses, saved views ───────────────────────────────────────────────
  const applyLens = React.useCallback((l: GraphLens) => {
    const m = matchLens(settings.hiddenTypes, settings.showLibraryEdges);
    // A lens over a hand-tuned filter can be taken back (GPV-10).
    setLensUndo(m.exact ? null : { hiddenTypes: settings.hiddenTypes, showLibraryEdges: settings.showLibraryEdges });
    patchSettings({ hiddenTypes: [...l.hidden], showLibraryEdges: l.libEdges });
  }, [settings.hiddenTypes, settings.showLibraryEdges, patchSettings]);

  const undoLens = React.useCallback(() => {
    if (lensUndo) patchSettings(lensUndo);
    setLensUndo(null);
  }, [lensUndo, patchSettings]);

  const saveView = React.useCallback((name: string) => {
    const v: SavedGraphView = {
      id: `v${Date.now().toString(36)}`, name: name.slice(0, 60),
      hiddenTypes: [...settings.hiddenTypes], showLibraryEdges: settings.showLibraryEdges,
      scope: settings.scope, localDepth: settings.localDepth,
    };
    patchSettings({ savedViews: [...settings.savedViews, v].slice(-50) });
  }, [settings, patchSettings]);

  const applyView = React.useCallback((v: SavedGraphView) => {
    patchSettings({ hiddenTypes: [...v.hiddenTypes], showLibraryEdges: v.showLibraryEdges, localDepth: v.localDepth });
    const nextKey = v.scope ? formatScopeParam(v.scope) : "";
    if (nextKey !== scopeKey) setScope(v.scope);
    setLensUndo(null);
  }, [patchSettings, scopeKey, setScope]);

  const deleteView = React.useCallback((id: string) => {
    patchSettings({ savedViews: settings.savedViews.filter((v) => v.id !== id) });
  }, [settings.savedViews, patchSettings]);

  // The link is built from the view, not read off the address bar, which
  // can trail the view by a deferred write.
  const copyLink = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pathname}${urlNow ? `?${urlNow}` : ""}`);
      return true;
    } catch {
      return false;
    }
  }, [pathname, urlNow]);

  // An item the map has but this view hides: show its type (library links
  // with a library), leave focus, then select it when drawn — the one path
  // for "hidden by this view — Show it" and a faded Insights row (GM-1).
  const showTypesOf = React.useCallback((ns: GraphNode[]) => {
    const types = new Set(ns.map((n) => n.type));
    patchSettings({
      hiddenTypes: settings.hiddenTypes.filter((t) => !types.has(t)),
      hideUnlinked: false,
      ...(types.has("library") ? { showLibraryEdges: true } : {}),
    });
    setFocusId(null);
    setSelectMiss(null);
  }, [settings.hiddenTypes, patchSettings]);
  const reveal = React.useCallback((n: GraphNode) => {
    showTypesOf([n]);
    setPendingSelect(n.id);
  }, [showTypesOf]);
  // A bridge the view hides (either end): show both ends' types by the same
  // path, then light the pair up — the spotlight an in-view bridge gets
  // (GM-1, fix pass 3: a click used to spotlight ids the map did not draw).
  const [pendingSpotlight, setPendingSpotlight] = React.useState<string[] | null>(null);
  const revealBridge = React.useCallback((a: GraphNode, b: GraphNode) => {
    showTypesOf([a, b]);
    setSelected(null);
    setPendingSpotlight([a.id, b.id]);
  }, [showTypesOf]);
  // …one commit later (fix pass 4). Lit up in the same commit as the filter
  // change, the renderer's fly — a child effect, so it runs before the
  // page's — framed the pair before the simulation had the revealed end, and
  // the camera went to the end already drawn. This effect is declared after
  // the simulation-feed effect, so by the time it lights the pair up both
  // ends are in the simulation, and the fly the new spotlight starts frames
  // them both — the way a URL's node waits in `pendingSelect`.
  React.useEffect(() => {
    if (!pendingSpotlight) return;
    setPendingSpotlight(null);
    spotlight(pendingSpotlight);
  }, [pendingSpotlight, spotlight]);

  // ── Escape closes the top overlay (GPV-13) ────────────────────────────
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable
        || (t.tagName === "INPUT" && !t.hasAttribute("data-graph-search")));
      if (typing) return;
      if (connect) setConnect(null);
      else if (pathMode) { setPathMode(false); setPathEnds({ from: null, to: null }); }
      else if (answer) setAnswer(null);
      else if (insightsOpen) setInsightsOpen(false);
      else if (selected) { setSelected(null); setTrail([]); setHighlight(null); }
      else if (focusId) setFocusId(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connect, pathMode, answer, insightsOpen, selected, focusId]);

  // ── The keyboard's walk over the map (GPV-13) ─────────────────────────
  // Memoised on what changes the walk (fix pass 3): the node set, the edges,
  // the search once it has two characters, the selected id. The full sort
  // (every node, most connected first) is kept per node set and copied —
  // never redone on a keystroke or a selection.
  const viewNodes = view?.nodes ?? null;
  const viewEdges = view?.edges ?? null;
  const kbdQuery = keyboardQuery(rawQuery);
  const selectedId = selected?.id ?? null;
  const kbdBase = React.useMemo(() => (viewNodes ? keyboardBaseOrder(viewNodes) : []), [viewNodes]);
  const kbdList = React.useMemo(
    () => (viewNodes && viewEdges ? keyboardOrder(viewNodes, viewEdges, kbdQuery, selectedId, kbdBase) : []),
    [viewNodes, viewEdges, kbdQuery, selectedId, kbdBase],
  );
  const [kbd, setKbd] = React.useState<{ list: GraphNode[]; index: number } | null>(null);
  const kbdIndex = kbd && kbd.list === kbdList ? kbd.index : -1;
  const kbdNode = kbdIndex >= 0 ? kbdList[kbdIndex] ?? null : null;
  const onMapKey = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const n = kbdList.length;
    if (n === 0) return;
    let next: number;
    switch (e.key) {
      case "ArrowDown": case "ArrowRight": next = (kbdIndex + 1) % n; break;
      case "ArrowUp": case "ArrowLeft": next = kbdIndex <= 0 ? n - 1 : kbdIndex - 1; break;
      case "Home": next = 0; break;
      case "End": next = n - 1; break;
      case "Enter": case " ":
        if (kbdIndex >= 0 && kbdList[kbdIndex]) { e.preventDefault(); handleSelect(kbdList[kbdIndex]); }
        return;
      default: return;
    }
    e.preventDefault();
    setKbd({ list: kbdList, index: next });
    setHighlight({ ids: [kbdList[next].id], nonce: Date.now() });
  }, [kbdList, kbdIndex, handleSelect]);

  if (!activeOrgId) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-text-faint)]" /></div>;
  }

  const focusNode = focusId ? view?.nodes.find((n) => n.id === focusId) ?? null : null;
  const scopeLabel = settings.scope ? (graph?.scope?.label ?? `Unit ${settings.scope.code}`) : null;
  const visibility = answer && view && graph ? answerVisibility(answer.nodeIds, view, graph, settings) : null;
  const mention = graph ? mentionNotice(graph.mentionCoverage, counts.asset) : null;
  const canRebuildMentions = hasAnyRole(["Admin", "DocCtrl", "Manager", "Supervisor"]);
  const missNode = selectMiss ? graph?.nodes.find((n) => n.id === selectMiss) ?? null : null;
  const orphansHidden = insights ? insights.orphans.filter((n) => !inView.has(n.id)).length : 0;
  const bridgesHidden = insights ? insights.bridges.filter((b) => !inView.has(b.a.id) || !inView.has(b.b.id)).length : 0;
  const offer = selected ? connectOffer(selected) : null;
  const pendingTotal = proposalRead?.total ?? null;

  const rebuildMentions = async () => {
    setMentionRun({ running: true, message: null, error: false });
    try {
      const { supabase } = await import("@/lib/supabase");
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/graph/mentions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({ orgId: activeOrgId }),
        signal: AbortSignal.timeout(70_000),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; documents?: number; mentionsWritten?: number; incomplete?: boolean };
      if (!res.ok) {
        setMentionRun({ running: false, error: true, message: `The mention index could not be rebuilt: ${body.error ?? `HTTP ${res.status}`}` });
        return;
      }
      const docs = Number(body.documents ?? 0), written = Number(body.mentionsWritten ?? 0);
      setMentionRun({
        running: false, error: false,
        message: body.incomplete
          ? `The rebuild stopped at its time limit after ${plural(docs, "document")} (${plural(written, "mention")} written) — the rest were not reached this run.`
          : `Mention index rebuilt — ${plural(docs, "document")} read, ${plural(written, "mention")} written.`,
      });
      setReloadNonce((x) => x + 1);
    } catch (e) {
      setMentionRun({ running: false, error: true, message: `The mention index could not be rebuilt: ${(e as Error).message}` });
    }
  };

  const typeLabel = (t: GraphNodeType) => TYPE_LABELS[t].replace(/s$/, "");
  const kbdStatus = kbdNode
    ? `${kbdNode.label}, ${typeLabel(kbdNode.type)}, ${plural(kbdNode.degree, "link")} — ${kbdIndex + 1} of ${kbdList.length}.`
      + (connect ? " Enter connects to it." : pathMode ? " Enter picks it as a path end." : " Enter opens its panel.")
    : "";

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="[&>div]:mb-0 mr-1">
          <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
        </div>
        <Waypoints className="w-4 h-4 text-violet-600 shrink-0" />
        <h1 className="text-sm font-black text-[var(--color-text)] mr-1">Org graph</h1>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
          <input
            data-graph-search=""
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runAsk(); }}
            onBlur={() => setUrlQ(rawQuery)}
            placeholder="Find E-22, or ask a question…"
            title="Type to light up matching nodes. Press Enter to search what your documents SAY."
            aria-label="Find a node, or ask what your documents say"
            className="pl-7 pr-16 py-1.5 w-72 max-w-[calc(100vw-4.5rem)] border border-[var(--color-border-strong)] rounded-lg text-xs bg-[var(--color-surface)]"
          />
          {/* Enter searches the TEXT, not the labels. A label filter can never
              answer "any standards about pipe supports" — the answer lives in
              a document whose name is PIP-STE-05121. */}
          {rawQuery.trim().length > 2 && (
            <button onClick={() => runAsk()} disabled={asking}
              title="Search what your documents say"
              className="absolute right-6 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[10px] font-black text-violet-700 hover:text-violet-600 disabled:opacity-50">
              {asking ? <Loader2 className="w-3 h-3 animate-spin" /> : <>Ask <CornerDownLeft className="w-3 h-3" /></>}
            </button>
          )}
          {rawQuery && (
            <button onClick={() => { setRawQuery(""); setUrlQ(""); setAnswer(null); }} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <button onClick={() => { setPathMode((v) => !v); setPathEnds({ from: null, to: null }); }}
          title="Pick two things and see how they connect"
          aria-pressed={pathMode}
          className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-full border text-[10px] font-black ${
            pathMode ? "border-lime-400 text-lime-800 bg-lime-50 dark:bg-lime-950/40 dark:text-lime-300"
                     : "border-[var(--color-border-strong)] text-[var(--color-text-muted)]"
          }`}>
          <Route className="w-3.5 h-3.5" /> Connection path
        </button>

        <GraphLensBar
          settings={settings}
          onLens={applyLens}
          canUndo={!!lensUndo}
          onUndo={undoLens}
          onApplyView={applyView}
          onSaveView={saveView}
          onDeleteView={deleteView}
          onCopyLink={copyLink}
        />

        {/* Scope: one unit's world, assembled for it (GPV-2 / GAP-306) —
            a separate control from the lenses. */}
        <label className="inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-text-muted)]">
          <LocateFixed className="w-3.5 h-3.5" />
          <span className="sr-only">Scope</span>
          <select aria-label="Scope the map to one unit" value={scopeKey}
            onChange={(e) => setScope(parseScopeParam(e.target.value))}
            className="px-2 py-1.5 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[10px] font-black text-[var(--color-text)] max-w-[10rem]">
            <option value="">Whole org</option>
            {settings.scope && !unitOptions.some((u) => u.code === settings.scope!.code) && (
              <option value={scopeKey}>{scopeLabel}</option>
            )}
            {unitOptions.map((u) => (
              <option key={u.code} value={formatScopeParam({ kind: "unit", code: u.code })}>{u.label} ({u.code})</option>
            ))}
          </select>
        </label>

        {settings.scope && (
          <button onClick={() => setScope(null)} title="Back to the whole org"
            className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-full border border-violet-400 bg-violet-50 dark:bg-violet-950/40 text-[10px] font-black text-violet-700">
            <LocateFixed className="w-3.5 h-3.5" />
            Scope: {scopeLabel}
            <X className="w-3 h-3" />
          </button>
        )}

        {focusNode && (
          <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-violet-400 bg-violet-50 dark:bg-violet-950/40 text-[10px] font-black text-violet-700">
            <Maximize2 className="w-3.5 h-3.5" />
            Focused: {focusNode.label.slice(0, 18)} ·
            <button onClick={() => patchSettings({ localDepth: Math.max(LOCAL_DEPTH_MIN, settings.localDepth - 1) })}
              disabled={settings.localDepth <= LOCAL_DEPTH_MIN} aria-label="One hop fewer"
              className="p-0.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-30"><Minus className="w-3 h-3" /></button>
            {settings.localDepth} hop{settings.localDepth === 1 ? "" : "s"}
            <button onClick={() => patchSettings({ localDepth: Math.min(LOCAL_DEPTH_MAX, settings.localDepth + 1) })}
              disabled={settings.localDepth >= LOCAL_DEPTH_MAX} aria-label="One hop more"
              className="p-0.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-30"><Plus className="w-3 h-3" /></button>
            <button onClick={() => setFocusId(null)} aria-label="Leave focus — back to the whole map"
              className="p-0.5 rounded hover:bg-violet-100 dark:hover:bg-violet-900/50"><X className="w-3 h-3" /></button>
          </div>
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
            <div className="text-xs text-[var(--color-text-muted)]">
              {settings.scope ? `Assembling ${scopeLabel}…` : "Assembling the org graph…"}
            </div>
          </div>
        ) : (
          <>
            {/* The map region: focusable and labelled; the keyboard steps
                through nodes (GPV-13). */}
            <div
              tabIndex={0}
              role="application"
              aria-roledescription="graph map"
              aria-label={`Org graph map${scopeLabel ? ` of ${scopeLabel}` : ""} — ${view.nodes.length} nodes, ${view.edges.length} links. Arrow keys step through nodes, Enter selects, Escape closes the open panel.`}
              aria-describedby="graph-keyboard-status"
              onKeyDown={onMapKey}
              className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
            >
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
                    regions={regions}
                    flyTo={highlight}
                    depthOf={view.depthOf}
                    depthMax={settings.localDepth}
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
                  regions={regions}
                  flyTo={highlight}
                  depthOf={view.depthOf}
                  depthMax={settings.localDepth}
                  onSelect={handleSelect}
                  onOpen={open}
                  onSettled={persistPositions}
                />
              )}
            </div>
            <div id="graph-keyboard-status" aria-live="polite" className="sr-only">{kbdStatus}</div>

            <GraphControls
              settings={settings}
              onChange={patchSettings}
              counts={counts}
              viewCounts={viewCounts}
              unitBreakdown={unitBreakdown}
              onReset={resetSettings}
            />

            <GraphLegend arrowsOn={settings.showArrows} mode={settings.mode} />

            {/* Insights */}
            <div className="absolute top-2 left-3 flex flex-col items-start gap-2 max-h-[calc(100%-1rem)] z-10">
              <button onClick={() => setInsightsOpen((v) => !v)} aria-expanded={insightsOpen}
                title="Orphans, hubs and bridges — counted on the whole map, whatever this view shows"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-black shadow-sm ${
                  insightsOpen ? "border-violet-400 text-violet-700 bg-[var(--color-surface)]"
                               : "border-[var(--color-border-strong)] text-[var(--color-text)] bg-[var(--color-surface)]/90 backdrop-blur"
                }`}>
                <Lightbulb className="w-3.5 h-3.5 text-violet-600" /> Insights
                {insights && insights.orphans.length > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-700 text-[9px] font-black" data-testid="orphan-badge">
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

                  {/* GM-1 / GM-6: what these were computed on. */}
                  <div className="px-2.5 pt-2 text-[10px] text-[var(--color-text-faint)] leading-snug" data-testid="insights-basis">
                    Counted on the whole map, whatever this view shows. {insights.basis.note}
                  </div>

                  <div className="overflow-y-auto max-h-72 p-1.5 space-y-0.5">
                    {insightTab === "orphans" && (
                      insights.orphans.length === 0 ? (
                        <div className="text-[11px] text-[var(--color-text-muted)] p-2">
                          No orphans — every document and item of equipment on the map is tied into the web.
                        </div>
                      ) : (
                        <>
                          <div className="text-[10px] text-[var(--color-text-muted)] px-1.5 pb-1">
                            No equipment, unit, project or link anywhere on the map — not just in this view — so no context yet.
                            {orphansHidden > 0 && ` ${orphansHidden} of these ${orphansHidden === 1 ? "is" : "are"} hidden by the current view (faded).`}
                          </div>
                          {insights.orphans.slice(0, 100).map((n) => (
                            <button key={n.id} onClick={() => (inView.has(n.id) ? spotlight([n.id], n) : reveal(n))}
                              title={inView.has(n.id) ? undefined : "Hidden by the current lens or filter — click to show it"}
                              className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left ${inView.has(n.id) ? "" : "opacity-50"}`}>
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: nodeColorFor(n) }} />
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
                            The most-referenced nodes on the map. The number is its links, not counting library filing. Touch one and the blast radius is wide.
                          </div>
                          {insights.hubs.map((h) => (
                            <button key={h.node.id} onClick={() => (inView.has(h.node.id) ? spotlight([h.node.id], h.node) : reveal(h.node))}
                              title={inView.has(h.node.id) ? undefined : "Hidden by the current lens or filter — click to show it"}
                              className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left ${inView.has(h.node.id) ? "" : "opacity-50"}`}>
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: nodeColorFor(h.node) }} />
                              <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{h.node.label}</span>
                              <span className="shrink-0 text-[10px] font-mono text-amber-700" title="Links on the map, not counting library filing">{h.degree}</span>
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
                            One thin line holding two clusters of the map together. Click to light it up.
                            {bridgesHidden > 0 && ` ${bridgesHidden} of these ${bridgesHidden === 1 ? "is" : "are"} hidden by the current view (faded) — a click shows it.`}
                          </div>
                          {insights.bridges.map((b) => {
                            const drawn = inView.has(b.a.id) && inView.has(b.b.id);
                            return (
                              <button key={`${b.a.id}|${b.b.id}`}
                                onClick={() => { if (drawn) { spotlight([b.a.id, b.b.id]); setSelected(null); } else revealBridge(b.a, b.b); }}
                                title={drawn ? undefined : "Hidden by the current lens or filter — click to show it"}
                                data-testid="bridge-row"
                                className={`w-full px-1.5 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-left ${drawn ? "" : "opacity-50"}`}>
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: nodeColorFor(b.a) }} />
                                  <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{b.a.label}</span>
                                  <span className="text-[10px] text-amber-600 font-black shrink-0">↔</span>
                                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: nodeColorFor(b.b) }} />
                                  <span className="text-[11px] font-bold text-[var(--color-text)] truncate">{b.b.label}</span>
                                </div>
                                <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">
                                  Only link between clusters of {b.sideA} and {b.sideB} nodes
                                </div>
                              </button>
                            );
                          })}
                        </>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Path panel */}
            {pathMode && (
              <div role="dialog" aria-label="Connection path"
                className="absolute bottom-3 right-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-lime-300 dark:border-lime-900 bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl p-3 space-y-2 z-10">
                <div className="flex items-center gap-1.5">
                  <Route className="w-3.5 h-3.5 text-lime-600" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)] flex-1">Connection path</span>
                  <button onClick={() => { setPathMode(false); setPathEnds({ from: null, to: null }); }}
                    aria-label="Close" className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {!pathEnds.from ? (
                  <div className="text-[11px] text-[var(--color-text-muted)]">Click the first node on the map — or focus the map and pick one with the arrow keys and Enter.</div>
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
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: nodeColorFor(h.node) }} />
                        <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{h.node.label}</span>
                        {i > 0 && <span className="shrink-0 text-[9px] text-lime-700">{h.via}</span>}
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
            <div className="absolute bottom-2 inset-x-3 text-center space-y-1 pointer-events-none">
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
              {/* GM-7: a failed or capped proposal read is said, never shown as "none"
                  — while proposals are drawn at all: with Proposals off there
                  is no drawing for the note to qualify (fix pass 3). */}
              {settings.showProposals && proposalRead?.error && (
                <div className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5" data-testid="proposals-error">
                  <Info className="w-3 h-3" />
                  {proposals.length > 0
                    ? <>Only the first {plural(proposals.length, "proposed connection")} (the newest) could be loaded ({proposalRead.error}) — the rest are not drawn; the review queue still has them.</>
                    : <>Proposed connections couldn&apos;t be loaded ({proposalRead.error}) — none are drawn; the review queue still has them.</>}
                </div>
              )}
              {settings.showProposals && proposalRead?.capped && (
                <div className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5" data-testid="proposals-capped">
                  <Info className="w-3 h-3" /> {proposals.length.toLocaleString("en-US")} read (the newest) of {pendingTotal !== null ? pendingTotal.toLocaleString("en-US") : `at least ${PENDING_PAIRS_CAP.toLocaleString("en-US")}`} proposed connections.
                </div>
              )}
              {/* IRLS-14: no mention links, and which case it is. */}
              {mention && (
                <div className="inline-flex flex-wrap items-center justify-center gap-1 text-[10px] text-sky-800 dark:text-sky-200 bg-sky-50 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-900 rounded-2xl px-2 py-0.5 pointer-events-auto" data-testid="mention-notice">
                  <Info className="w-3 h-3 shrink-0" /> {mention.text}
                  {mention.canRebuild && canRebuildMentions && (
                    <button onClick={() => void rebuildMentions()} disabled={mentionRun?.running}
                      className="inline-flex items-center gap-1 font-black underline disabled:opacity-50">
                      <RefreshCw className={`w-3 h-3 ${mentionRun?.running ? "animate-spin" : ""}`} />
                      {mentionRun?.running ? "Rebuilding…" : "Rebuild the mention index"}
                    </button>
                  )}
                </div>
              )}
              {mentionRun?.message && (
                <div className={`inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-0.5 border ${mentionRun.error
                  ? "text-rose-700 bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-900"
                  : "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-900"}`} data-testid="mention-run">
                  <Info className="w-3 h-3" /> {mentionRun.message}
                </div>
              )}
              {selectMiss && (
                <div className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-0.5 pointer-events-auto" data-testid="select-miss">
                  <Info className="w-3 h-3" />
                  {missNode
                    ? <>{missNode.label} is on the map but hidden by this view.
                        <button className="font-black underline" onClick={() => reveal(missNode)}>Show it</button></>
                    : <>The linked item isn&apos;t on this map — beyond a cap, outside {scopeLabel ?? "the map"}, or outside your access.</>}
                  <button aria-label="Dismiss" onClick={() => setSelectMiss(null)}><X className="w-3 h-3" /></button>
                </div>
              )}
            </div>

            {/* Shown only when this view draws proposal ghosts, as the base
                did — never with Proposals off (fix pass 3) — and counting the
                reader's whole queue, not the drawing (GM-7). */}
            {view.ghosts.length > 0 && (
              <Link href="/admin/proposed-links"
                className="absolute bottom-3 left-3 inline-flex items-center gap-1 text-[10px] font-black text-amber-700 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-full px-2 py-1 hover:bg-amber-100 z-10"
                data-testid="proposals-chip">
                <Sparkles className="w-3 h-3" />
                {pendingTotal !== null
                  ? <>{plural(pendingTotal, "connection")} awaiting review{view.ghosts.length !== pendingTotal ? ` · ${view.ghosts.length} drawn here` : ""}</>
                  : <>{view.ghosts.length} dashed connection{view.ghosts.length === 1 ? "" : "s"} awaiting review</>}
              </Link>
            )}

            {/* The answer, with its evidence, over the lit-up map. This is
                the thing a label filter can never be: you asked in English,
                and the map is now showing you WHERE that knowledge lives. */}
            {answer && !pathMode && (
              <div role="dialog" aria-label={`Search results for ${answer.question}`}
                className="absolute top-3 left-3 w-96 max-w-[calc(100%-1.5rem)] max-h-[75%] flex flex-col rounded-xl border border-violet-300 dark:border-violet-800 bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl z-10">
                <div className="flex items-start gap-2 p-3 pb-2 shrink-0">
                  <Quote className="w-3.5 h-3.5 mt-0.5 text-violet-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-black text-[var(--color-text)] break-words">{answer.question}</div>
                    <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5" data-testid="answer-count">
                      {answer.hits.length > 0
                        ? `${plural(answer.hits.length, "passage")} · ${plural(visibility?.shown.length ?? 0, "node")} lit up on this map`
                        : "No matches"}
                    </div>
                    {/* GPV-12: the matches this view cannot show, and how to show them. */}
                    {visibility && (visibility.hiddenByType.length > 0 || visibility.outsideFocus > 0 || visibility.offMap > 0) && (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5 text-[10px]" data-testid="answer-hidden">
                        {visibility.hiddenByType.map((h) => (
                          <button key={h.type} className="font-black text-violet-700 hover:underline"
                            onClick={() => patchSettings({
                              hiddenTypes: settings.hiddenTypes.filter((t) => t !== h.type),
                              ...(h.type === "library" ? { showLibraryEdges: true } : {}),
                            })}>
                            {h.count} more in {TYPE_LABELS[h.type]} — show
                          </button>
                        ))}
                        {visibility.outsideFocus > 0 && (
                          <button className="font-black text-violet-700 hover:underline"
                            onClick={() => { setFocusId(null); patchSettings({ hideUnlinked: false }); }}>
                            {visibility.outsideFocus} more outside this neighbourhood — show
                          </button>
                        )}
                        {visibility.offMap > 0 && (
                          <span className="text-[var(--color-text-faint)]">
                            {visibility.offMap} not on this map (beyond a cap{settings.scope ? ", or outside this scope" : ""})
                          </span>
                        )}
                      </div>
                    )}
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
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: nodeColorFor({ id: `asset:${a.assetId}`, type: "asset" }) }} />
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
            {/* Connect panel — the manual edge, drawn where the map is. */}
            {connect && (
              <div role="dialog" aria-label="Draw a connection"
                className="absolute bottom-3 right-3 w-72 max-w-[calc(100%-1.5rem)] rounded-xl border border-emerald-300 dark:border-emerald-900 bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl p-3 space-y-2 z-10">
                <div className="flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text)] flex-1">Draw a connection</span>
                  <button onClick={() => setConnect(null)} aria-label="Done connecting"
                    className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {connect.done && (
                  <div className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                    Connected {connect.done.a} ↔ {connect.done.b} ✓
                  </div>
                )}
                {connect.error && (
                  <div className="text-[11px] text-rose-600 leading-snug" data-testid="connect-error">{connect.error}</div>
                )}
                {connect.status === "saving" ? (
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                    <Loader2 className="w-3 h-3 animate-spin" /> Writing the link…
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    From <b className="text-[var(--color-text)]">{connect.from.label}</b> — click the node to connect it to.
                  </div>
                )}
                <div className="text-[10px] text-[var(--color-text-faint)]">
                  Document ↔ document or document ↔ equipment makes a LINK. Equipment ↔ equipment or
                  Site Codebook unit ↔ unit makes a FLOW — the first feeds the second, drawn with an arrow on the Process layout lens.
                </div>
              </div>
            )}

            {selected && !pathMode && !connect && activeOrgId && (
              <NodePeek
                node={selected}
                orgId={activeOrgId}
                connections={connections}
                connectionsTotal={allConnections.length}
                connectionsProposedOnly={proposedOnly}
                viewDegree={peekCounts?.inView}
                libraryLinks={peekCounts?.library}
                focused={!!focusId}
                historyDepth={trail.length}
                colorFor={(t) => nodeColorFor({ id: "", type: t })}
                colorOf={nodeColorFor}
                labelFor={typeLabel}
                onSelect={handleSelect}
                onBack={peekBack}
                onGoIn={() => { setFocusId(selected.id); setHighlight({ ids: [selected.id], nonce: Date.now() }); }}
                onGoOut={() => { setFocusId(null); setHighlight({ ids: [selected.id], nonce: Date.now() }); }}
                onOpen={() => open(selected)}
                onPath={() => { setPathMode(true); setPathEnds({ from: selected, to: null }); }}
                onConnect={offer?.offered
                  ? () => { setConnect({ from: selected, status: "picking" }); setSelected(null); setTrail([]); }
                  : undefined}
                connectBlocked={offer && !offer.offered ? offer.reason : null}
                onScope={selected.id.startsWith("cbunit:") && settings.scope?.code !== (selected.unitCode ?? selected.id.slice("cbunit:".length))
                  ? () => {
                    const code = selected.unitCode ?? selected.id.slice("cbunit:".length);
                    const ref = parseScopeParam(`unit:${code}`);
                    if (ref) setScope(ref, selected.id);
                  }
                  : undefined}
                scopeLabel={scopeLabel}
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
