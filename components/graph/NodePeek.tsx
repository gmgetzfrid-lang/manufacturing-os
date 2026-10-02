"use client";

// NodePeek — the panel that made the graph worth using.
//
// Before this, clicking a node told you its type and its degree, and the only
// way to see the thing was a hard navigation that threw the map away. So the
// graph was a picture of your data rather than a way through it: you could
// admire the shape and then you had to leave.
//
// This is the Obsidian behaviour, which is: you never leave. Clicking a node
// opens a peek — what it is, WHY it's connected (quoted from the document),
// and where you can go from here. You walk the web node by node, with a back
// stack, and the map stays under you the whole time. Only when you actually
// want the document do you open it, and even then you can come straight back.
//
// One node, one set of numbers (GM-11): the header says how many links the
// node has on the whole map AND how many of them this view shows, and the
// list below says how many nodes it is showing of how many. A Site Codebook
// unit can scope the map to its world (GPV-2 / GAP-306); where Connect
// could not land (a unit with no codebook identity) the panel says why
// instead of offering it (GPV-7).

import React from "react";
import {
  X, ArrowUpRight, ArrowLeft, Focus, Crosshair, Quote, Loader2,
  CornerDownLeft, Layers, FileText, Link2, LocateFixed,
} from "lucide-react";
import type { GraphNode } from "@/lib/orgGraph";
import { mentionsForAsset, mentionsForDocument, type MentionEvidence } from "@/lib/mentions";

export interface NodePeekProps {
  node: GraphNode;
  orgId: string;
  /** Nodes one hop away, for walking the web without leaving. */
  connections: GraphNode[];
  /** True when the map is currently collapsed to a neighbourhood. */
  focused: boolean;
  /** How many steps back the peek can go. */
  historyDepth: number;
  colorFor: (t: GraphNode["type"]) => string;
  /** A node's own colour, when it differs within a type (the unit kinds —
   *  GPV-4). Falls back to colorFor(type). */
  colorOf?: (n: GraphNode) => string;
  labelFor: (t: GraphNode["type"]) => string;
  onSelect: (n: GraphNode) => void;
  onBack: () => void;
  onGoIn: () => void;
  onGoOut: () => void;
  onOpen: () => void;
  onPath: () => void;
  /** Start drawing a manual connection from this node (documents and
   *  equipment only — other ties are derived from the registry). */
  onConnect?: () => void;
  /** Why Connect is not offered on this node, when there is a reason worth
   *  saying (a unit with no Site Codebook identity — GPV-7). */
  connectBlocked?: string | null;
  /** GM-11 — links touching this node in the current view (the header's
   *  `node.degree` counts the whole map). */
  viewDegree?: number;
  /** How many of the node's links on the map are library filing — the part
   *  the Hubs count leaves out. */
  libraryLinks?: number;
  /** How many nodes the node connects to in this view (`connections` is the
   *  first twelve of them). */
  connectionsTotal?: number;
  /** GPV-2 — scope the map to this unit's world. */
  onScope?: () => void;
  /** The scope the map is assembled for, when it is (boundary stub copy). */
  scopeLabel?: string | null;
  onClose: () => void;
}

export default function NodePeek({
  node, orgId, connections, focused, historyDepth,
  colorFor, colorOf, labelFor, onSelect, onBack, onGoIn, onGoOut, onOpen, onPath, onConnect,
  connectBlocked, viewDegree, libraryLinks, connectionsTotal, onScope, scopeLabel, onClose,
}: NodePeekProps) {
  const [evidence, setEvidence] = React.useState<MentionEvidence[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Evidence load is per-node and cancellable: walking the web quickly must
  // never let a slow earlier request overwrite a newer node's panel.
  React.useEffect(() => {
    const [kind, id] = splitId(node.id);
    if (kind !== "asset" && kind !== "doc") { setEvidence(null); return; }
    let live = true;
    setLoading(true);
    setEvidence(null);
    const load = kind === "asset"
      ? mentionsForAsset(orgId, id, 40)
      : mentionsForDocument(orgId, id, 40);
    load
      .then((rows) => { if (live) setEvidence(rows); })
      .catch(() => { if (live) setEvidence([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [node.id, orgId]);

  const isAsset = node.id.startsWith("asset:");
  const links = (n: number) => `${n} link${n === 1 ? "" : "s"}`;
  const totalConnected = connectionsTotal ?? connections.length;
  const dot = (n: GraphNode) => (colorOf ? colorOf(n) : colorFor(n.type));

  return (
    <div role="dialog" aria-label={`${labelFor(node.type)}: ${node.label}`}
      className="absolute bottom-12 right-3 w-80 max-w-[calc(100%-1.5rem)] max-h-[70%] flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/97 backdrop-blur shadow-2xl z-10">
      {/* Header */}
      <div className="flex items-start gap-2 p-3 pb-2 shrink-0">
        {historyDepth > 0 && (
          <button onClick={onBack} title="Back to the previous node"
            className="mt-0.5 p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: dot(node) }} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-black text-[var(--color-text)] break-words">{node.label}</div>
          {node.sub && <div className="text-[11px] text-[var(--color-text-muted)] break-words">{node.sub}</div>}
          <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5" data-testid="peek-degree">
            {labelFor(node.type)} · {links(node.degree)} on the map
            {libraryLinks !== undefined && libraryLinks > 0 && ` (${libraryLinks} library filing)`}
            {viewDegree !== undefined && viewDegree !== node.degree && ` · ${viewDegree} in this view`}
          </div>
          {node.outside !== undefined && node.outside > 0 && (
            <div className="text-[10px] text-amber-700 mt-0.5">
              {links(node.outside)} lead{node.outside === 1 ? "s" : ""} out of {scopeLabel ?? "this scope"} — not drawn here.
            </div>
          )}
        </div>
        <button onClick={onClose} aria-label="Close"
          className="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"><X className="w-3.5 h-3.5" /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 space-y-2 min-h-0">
        {/* WHY — the reason this thing sits where it sits. A link you can't
            interrogate is a link nobody trusts. */}
        {(loading || (evidence && evidence.length > 0)) && (
          <div className="border-t border-[var(--color-border)] pt-2">
            <div className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              <Quote className="w-3 h-3" />
              {isAsset ? "Mentioned in" : "Mentions"}
              {evidence && <span className="text-[var(--color-text-faint)]">· {evidence.length}</span>}
            </div>
            {loading && (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)] py-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Reading the evidence…
              </div>
            )}
            {evidence?.slice(0, 12).map((e, i) => (
              <div key={`${e.assetId}-${e.knowledgeDocumentId ?? e.documentId}-${e.page}-${i}`}
                className="mb-1.5 rounded-lg bg-[var(--color-surface-2)] px-2 py-1.5">
                <div className="flex items-center gap-1 text-[10px] font-black text-[var(--color-text)]">
                  <FileText className="w-3 h-3 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="truncate">{isAsset ? e.documentName : e.assetTag}</span>
                  <span className="ml-auto shrink-0 text-[var(--color-text-faint)] font-bold">
                    p.{e.page}{e.count > 1 ? ` · ${e.count}×` : ""}
                  </span>
                </div>
                {/* The sentence. This is the entire point of the panel. */}
                <div className="text-[11px] text-[var(--color-text-muted)] leading-snug mt-0.5 italic">
                  “{e.snippet}”
                </div>
                {e.confidence < 0.9 && (
                  <div className="text-[9px] font-black uppercase tracking-wider text-amber-700 mt-0.5">
                    {e.origin} match · unreviewed
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {evidence !== null && evidence.length === 0 && !loading && (isAsset || node.id.startsWith("doc:")) && (
          <div className="border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-text-faint)] leading-snug">
            No text mentions indexed yet. Run the mention indexer to derive links
            from what your documents actually say.
          </div>
        )}

        {/* WHERE TO — walking the web is the whole interaction. */}
        {connections.length > 0 && (
          <div className="border-t border-[var(--color-border)] pt-2">
            <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              Connected in this view · {totalConnected}
              {totalConnected > connections.length && (
                <span className="normal-case font-bold tracking-normal text-[var(--color-text-faint)]"> (the {connections.length} most connected)</span>
              )}
            </div>
            <div className="space-y-0.5">
              {connections.map((c) => (
                <button key={c.id} onClick={() => onSelect(c)}
                  className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--color-surface-2)] text-left group">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: dot(c) }} />
                  <span className="flex-1 min-w-0 text-[11px] font-bold text-[var(--color-text)] truncate">{c.label}</span>
                  <CornerDownLeft className="w-3 h-3 shrink-0 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Movement. In, out, across, through — without losing the map. */}
      <div className="p-3 pt-2 space-y-1.5 shrink-0 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-1.5">
          <button onClick={onGoIn} title="Collapse the map to this node's neighbourhood"
            className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] font-black text-violet-700 border border-violet-300 dark:border-violet-800 rounded-lg px-2 py-1.5 hover:bg-violet-50 dark:hover:bg-violet-950/40">
            <Focus className="w-3.5 h-3.5" /> Go in
          </button>
          <button onClick={onGoOut} disabled={!focused} title="Back to the whole map"
            className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] font-black text-[var(--color-text)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-2)] disabled:opacity-40">
            <Layers className="w-3.5 h-3.5" /> Go out
          </button>
          <button onClick={onPath} title="Trace how this connects to something else" aria-label="Trace a connection path from this node"
            className="inline-flex items-center justify-center gap-1 text-[11px] font-black text-lime-700 border border-lime-300 dark:border-lime-800 rounded-lg px-2 py-1.5 hover:bg-lime-50 dark:hover:bg-lime-950/40">
            <Crosshair className="w-3.5 h-3.5" />
          </button>
          {onConnect && (
            <button onClick={onConnect} title="Draw a connection from this node — click it, then click the other node"
              aria-label="Draw a connection from this node"
              className="inline-flex items-center justify-center gap-1 text-[11px] font-black text-emerald-700 border border-emerald-300 dark:border-emerald-800 rounded-lg px-2 py-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/40">
              <Link2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {!onConnect && connectBlocked && (
          <div className="text-[10px] text-[var(--color-text-faint)] leading-snug" data-testid="connect-blocked">{connectBlocked}</div>
        )}
        {onScope && (
          <button onClick={onScope} title="Assemble the map for this unit only — its equipment, its documents and its shelves"
            className="w-full inline-flex items-center justify-center gap-1 text-[11px] font-black text-violet-700 border border-violet-300 dark:border-violet-800 rounded-lg px-2 py-1.5 hover:bg-violet-50 dark:hover:bg-violet-950/40">
            <LocateFixed className="w-3.5 h-3.5" /> Scope the map to this unit
          </button>
        )}
        <button onClick={onOpen}
          className="w-full inline-flex items-center justify-center gap-1 text-[11px] font-black text-white bg-violet-600 hover:bg-violet-500 rounded-lg px-2 py-1.5">
          Open {labelFor(node.type).replace(/s$/, "").toLowerCase()} <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** "asset:abc" → ["asset", "abc"]. Ids are namespaced so one selection model
 *  can carry six entity kinds. */
function splitId(id: string): [string, string] {
  const at = id.indexOf(":");
  return at < 0 ? ["", id] : [id.slice(0, at), id.slice(at + 1)];
}
