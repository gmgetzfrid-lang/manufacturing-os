// lib/graphView.ts — what the /graph page does with an assembled graph.
//
// Pure (no I/O, no DOM), so every rule the page applies is tested directly
// (lib/__tests__/graphView.test.ts):
//
//   * the visible slice — the lens / filter, "hide unlinked", focus mode at a
//     depth — and each node's hop distance from the focused root (GPV-9);
//   * which of an Ask answer's nodes the slice can show, and why the rest
//     are not drawn (GPV-12);
//   * what a Connect between two nodes writes, or why it is refused — a flow
//     ends at registry equipment or a Site Codebook unit, by the node's own
//     unit identity (GPV-7 / AREA-10);
//   * the keyboard's walk over the map (GPV-13);
//   * what the map says when it draws no mention links (IRLS-14);
//   * the rate at which the view is written to the URL (GPV-11 — the
//     History API throws past a browser's budget; clock and timer injected).
//
// Nothing here makes an edge. The view only ever REMOVES nodes and edges the
// assembly drew (99-fix-sequencing "Do not": never infer an edge at render
// time).

import type {
  GraphEdge, GraphNode, GraphNodeType, MentionCoverage, OrgGraph,
} from "@/lib/orgGraph";
import { buildAdjacency, neighborhood } from "@/lib/graphSim";
import type { GraphSettings } from "@/lib/graphSettings";

export interface GraphViewSlice {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Proposal ghosts whose two ends are both in the slice. */
  ghosts: GraphEdge[];
  /** Focus mode: each node's hop distance from the root. null otherwise. */
  depthOf: Map<string, number> | null;
}

export type ViewFilter = Pick<GraphSettings, "hiddenTypes" | "showLibraryEdges" | "hideUnlinked" | "showProposals" | "localDepth">;

/** The visible slice of an assembled graph. */
export function sliceView(
  graph: Pick<OrgGraph, "nodes" | "edges">, f: ViewFilter, proposals: GraphEdge[], focusId: string | null,
): GraphViewSlice {
  const typeOk = (t: GraphNodeType) =>
    !f.hiddenTypes.includes(t) && (t !== "library" || f.showLibraryEdges);
  let nodes = graph.nodes.filter((n) => typeOk(n.type));
  let ids = new Set(nodes.map((n) => n.id));
  let edges = graph.edges.filter((e) =>
    ids.has(e.a) && ids.has(e.b) && (f.showLibraryEdges || e.type !== "library"));

  if (f.hideUnlinked) {
    const linked = new Set<string>();
    for (const e of edges) { linked.add(e.a); linked.add(e.b); }
    nodes = nodes.filter((n) => linked.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
  }

  // Focus mode: collapse to one node's neighbourhood at the chosen depth,
  // KEEPING each node's distance — the renderers fade by it (GPV-9).
  let depthOf: Map<string, number> | null = null;
  if (focusId && ids.has(focusId)) {
    depthOf = neighborhood(focusId, buildAdjacency(edges), f.localDepth);
    nodes = nodes.filter((n) => depthOf!.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.a) && ids.has(e.b));
  }

  const ghosts = f.showProposals ? proposals.filter((e) => ids.has(e.a) && ids.has(e.b)) : [];
  return { nodes, edges, ghosts, depthOf };
}

/** Links touching a node in a slice (GM-11's "in this view" count): edges,
 *  not proposal ghosts, counted as the assembly counts `degree`. */
export function viewDegree(nodeId: string, edges: GraphEdge[]): number {
  let n = 0;
  for (const e of edges) if (e.a === nodeId || e.b === nodeId) n += 1;
  return n;
}

// ── GPV-12: an answer, against the view ─────────────────────────────────

export interface AnswerVisibility {
  /** Node ids the map can light up. */
  shown: string[];
  /** On the map but filtered out by a hidden node type, per type. */
  hiddenByType: Array<{ type: GraphNodeType; count: number }>;
  /** On the map, of a shown type, but outside the focused neighbourhood or
   *  dropped by "hide unlinked". */
  outsideFocus: number;
  /** Not on this map at all (beyond a cap, outside the scope or the
   *  reader's access). */
  offMap: number;
}

export function answerVisibility(
  nodeIds: string[], view: Pick<GraphViewSlice, "nodes">, graph: Pick<OrgGraph, "nodes">,
  f: Pick<GraphSettings, "hiddenTypes" | "showLibraryEdges">,
): AnswerVisibility {
  const inView = new Set(view.nodes.map((n) => n.id));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const shown: string[] = [];
  const perType = new Map<GraphNodeType, number>();
  let outsideFocus = 0, offMap = 0;
  for (const id of new Set(nodeIds)) {
    if (inView.has(id)) { shown.push(id); continue; }
    const n = byId.get(id);
    if (!n) { offMap += 1; continue; }
    const typeHidden = f.hiddenTypes.includes(n.type) || (n.type === "library" && !f.showLibraryEdges);
    if (typeHidden) perType.set(n.type, (perType.get(n.type) ?? 0) + 1);
    else outsideFocus += 1;
  }
  return {
    shown,
    hiddenByType: [...perType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    outsideFocus, offMap,
  };
}

// ── GPV-7: what a Connect writes ────────────────────────────────────────

export type FlowEndpoint = { kind: "asset" | "unit"; ref: string };

const prefixOf = (id: string) => id.slice(0, Math.max(0, id.indexOf(":")));
const rawIdOf = (id: string) => id.slice(id.indexOf(":") + 1);

/** A node as a process-flow end, or the reason it cannot be one. A flow
 *  ends at registry equipment or a Site Codebook unit (20261155 refuses any
 *  other unit ref); a unit end is written as the node's own codebook code
 *  (`GraphNode.unitCode`, DEC-67), which is also the node id the rebuild
 *  draws it on (`cbunit:<code>`). */
export function flowEndpoint(n: GraphNode): FlowEndpoint | { refused: string } | null {
  const kind = prefixOf(n.id);
  if (kind === "asset") return { kind: "asset", ref: rawIdOf(n.id) };
  if (kind === "cbunit") {
    const code = (n.unitCode ?? rawIdOf(n.id)).trim();
    return code ? { kind: "unit", ref: code } : { refused: `${n.label} has no Site Codebook code — a flow cannot end there.` };
  }
  if (kind === "unit") {
    return {
      refused: `${n.label} is an operational unit that is not mapped to a Site Codebook unit, so a flow cannot end there — `
        + "a flow ends at registry equipment or a Site Codebook unit. Map it on Operational scope (/admin/scope), then draw the flow on its codebook unit.",
    };
  }
  if (kind === "system") {
    return { refused: `${n.label} is a system — a flow ends at registry equipment or a Site Codebook unit. Draw it on the system's unit or its equipment.` };
  }
  return null;
}

/** Whether the peek offers Connect on a node, or the sentence it shows
 *  instead (GPV-7: never offered where the write could not land). */
export function connectOffer(n: GraphNode): { offered: true } | { offered: false; reason: string | null } {
  const kind = prefixOf(n.id);
  if (kind === "doc" || kind === "asset") return { offered: true };
  const end = flowEndpoint(n);
  if (end && "refused" in end) return { offered: false, reason: end.refused };
  if (end) return { offered: true };
  return { offered: false, reason: null };
}

export const CONNECT_PAIR_MESSAGE =
  "Draw a link between two documents or a document and equipment — or a FLOW between two equipment items or two units (the first one feeds the second). Library and project ties are derived from filing.";

export type ConnectPlan =
  | { kind: "related"; documentId: string; targetDocumentId: string }
  | { kind: "tag"; documentId: string; assetId: string; tag: string }
  | { kind: "flow"; from: FlowEndpoint; to: FlowEndpoint; a: string; b: string }
  | { kind: "refused"; message: string };

/** What drawing a connection from `from` to `target` writes. The flow's
 *  optimistic edge (`a`, `b`) uses the node ids the rebuild produces. */
export function planConnect(from: GraphNode, target: GraphNode): ConnectPlan | null {
  if (from.id === target.id) return null;
  const ka = prefixOf(from.id), kb = prefixOf(target.id);
  if (ka === "doc" && kb === "doc") return { kind: "related", documentId: rawIdOf(from.id), targetDocumentId: rawIdOf(target.id) };
  if ((ka === "doc" && kb === "asset") || (ka === "asset" && kb === "doc")) {
    const doc = ka === "doc" ? from : target, asset = ka === "asset" ? from : target;
    return { kind: "tag", documentId: rawIdOf(doc.id), assetId: rawIdOf(asset.id), tag: asset.label };
  }
  const unitish = (k: string) => k === "cbunit" || k === "unit" || k === "system";
  const sameFamily = (ka === "asset" && kb === "asset") || (unitish(ka) && unitish(kb));
  if (!sameFamily) return { kind: "refused", message: CONNECT_PAIR_MESSAGE };
  const ea = flowEndpoint(from), eb = flowEndpoint(target);
  if (!ea || !eb) return { kind: "refused", message: CONNECT_PAIR_MESSAGE };
  if ("refused" in ea) return { kind: "refused", message: ea.refused };
  if ("refused" in eb) return { kind: "refused", message: eb.refused };
  const nodeId = (e: FlowEndpoint) => (e.kind === "asset" ? `asset:${e.ref}` : `cbunit:${e.ref}`);
  return { kind: "flow", from: ea, to: eb, a: nodeId(ea), b: nodeId(eb) };
}

// ── GPV-13: the keyboard's walk ─────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The nodes the arrow keys step through, in order: the search matches when
 *  something is typed; the selected node's neighbours (walking the web);
 *  otherwise every node, most connected first. */
export function keyboardOrder(
  nodes: GraphNode[], edges: GraphEdge[], query: string, selectedId: string | null,
): GraphNode[] {
  const byLabel = (a: GraphNode, b: GraphNode) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  const byWeight = (a: GraphNode, b: GraphNode) => b.degree - a.degree || byLabel(a, b);
  const q = norm(query);
  if (q.length >= 2) return nodes.filter((n) => norm(n.label).includes(q)).sort(byLabel);
  if (selectedId && nodes.some((n) => n.id === selectedId)) {
    const near = new Set<string>();
    for (const e of edges) {
      if (e.a === selectedId) near.add(e.b);
      if (e.b === selectedId) near.add(e.a);
    }
    const list = nodes.filter((n) => near.has(n.id)).sort(byWeight);
    if (list.length > 0) return list;
  }
  return [...nodes].sort(byWeight);
}

// ── IRLS-14: no mention links, and why ──────────────────────────────────

export interface MentionNotice { text: string; canRebuild: boolean }

/** With zero mention links drawn, the sentence that says which case it is
 *  and the next step. What the read can tell (lib/orgGraph.ts
 *  MentionCoverage): not installed; installed with no row this reader can
 *  see; rows read but none on this map. It cannot tell "never built" from
 *  "built, nothing named" — so it says both — and the indexer keeps no run
 *  state, so a failed build elsewhere is not something it can name. */
export function mentionNotice(cov: MentionCoverage | undefined | null, equipmentOnMap: number): MentionNotice | null {
  if (!cov || cov.drawn > 0) return null;
  if (!cov.installed) {
    return {
      text: "The mention index is not installed (migration 20260929_mention_engine.sql), so no document is linked to equipment by what its text says.",
      canRebuild: false,
    };
  }
  if (cov.rows > 0) {
    return {
      text: `${cov.rows.toLocaleString("en-US")} mention${cov.rows === 1 ? "" : "s"} read, but none land on this map — the notes beside this one say why.`,
      canRebuild: false,
    };
  }
  if (equipmentOnMap === 0) {
    return { text: "No “mentioned in the text” links: there is no registry equipment on this map for a document to name.", canRebuild: false };
  }
  return {
    text: "No “mentioned in the text” links on this map. Either the mention index has not been built for these documents, or it found none of this registry's equipment named in the documents you can see — the map cannot tell which. Each document is indexed when it finishes reading; an admin, document controller, manager or supervisor can rebuild the whole index from this map.",
    canRebuild: true,
  };
}

// ── GPV-11: writing the view to the URL within the History API's budget ──

/** Browsers cap the History API: WebKit throws a SecurityError past 100
 *  `replaceState` calls in 30 seconds (10 in older builds), Gecko past 200
 *  in 10. Next.js answers each of the page's writes with a `replaceState` of
 *  its own (its history sync), so one write costs two calls. The page spends
 *  a burst of URL_WRITE_BURST writes, then one per URL_WRITE_REFILL_MS: at
 *  most 40 writes (80 calls) in any 30 seconds and 20 (40 calls) in any 10. */
export const URL_WRITE_BURST = 10;
export const URL_WRITE_REFILL_MS = 1000;
/** After a refused write (the browser's own limit), wait this long. */
export const URL_WRITE_RETRY_MS = 10_000;
/** Consecutive refusals of one value before it is dropped; the next push
 *  tries again. */
const URL_WRITE_MAX_FAILURES = 3;

/** What one write did: `done` spent a call, `noop` found nothing to change,
 *  `failed` was refused (it threw). */
export type UrlWriteResult = "done" | "noop" | "failed";

export interface RateLimitedWriter<T> {
  /** Write `value` now if the budget allows; otherwise it becomes the
   *  pending value, written when the budget refills (a newer push replaces
   *  it — only the latest value is ever written). */
  push(value: T): void;
  /** Drop a pending write (unmount). */
  cancel(): void;
}

/** A token-bucket writer: bursts land at once, a sustained stream is
 *  coalesced to its latest value, and a refused write is retried later
 *  rather than thrown. */
export function rateLimitedWriter<T>(
  write: (value: T) => UrlWriteResult,
  opts: {
    burst?: number; refillMs?: number; retryMs?: number;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => unknown;
    unschedule?: (handle: unknown) => void;
  } = {},
): RateLimitedWriter<T> {
  const burst = opts.burst ?? URL_WRITE_BURST;
  const refillMs = opts.refillMs ?? URL_WRITE_REFILL_MS;
  const retryMs = opts.retryMs ?? URL_WRITE_RETRY_MS;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = opts.unschedule ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let tokens = burst;
  let at = now();
  let pending: { value: T } | null = null;
  let failures = 0;
  let timer: unknown = null;

  function refill() {
    const t = now();
    tokens = Math.min(burst, tokens + Math.max(0, t - at) / refillMs);
    at = t;
  }
  function arm() {
    if (timer !== null || !pending) return;
    timer = schedule(run, Math.max(1, Math.ceil((1 - tokens) * refillMs)));
  }
  function run() {
    timer = null;
    if (!pending) return;
    refill();
    if (tokens < 1) { arm(); return; }
    const { value } = pending;
    pending = null;
    const r = write(value);
    if (r === "done") { tokens -= 1; failures = 0; return; }
    if (r === "noop") { failures = 0; return; }
    // Refused: spend the budget so the retry waits retryMs, keep the value
    // unless a newer one arrived, and give up on it after a few refusals.
    failures += 1;
    tokens = Math.min(tokens, 1 - retryMs / refillMs);
    if (failures >= URL_WRITE_MAX_FAILURES) { failures = 0; return; }
    if (!pending) pending = { value };
    arm();
  }

  return {
    push(value) {
      pending = { value };
      if (timer === null) run();
    },
    cancel() {
      if (timer !== null) unschedule(timer);
      timer = null;
      pending = null;
    },
  };
}
