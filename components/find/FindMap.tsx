"use client";

// FindMap - the estate map (unit > type > equipment > documents) in a box,
// always beside the list it belongs to. It shows where you are: the whole
// site at the top, the unit of the folder you're in, or the equipment you
// searched with its documents hung under it. One level opens at a time so
// every label reads.
//
// It also drives: tap a unit and the list opens that unit's folder; tap a
// piece of equipment and it is searched with its documents; tap a document
// to preview it. Esc or the crumbs climb out.

import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import EstateMap from "@/components/graph/EstateMap";
import { findMapBase, mapWithDocs, type MapBase, type FindDoc } from "@/lib/findEverywhere";
import type { GraphNode } from "@/lib/orgGraph";

interface Props {
  orgId: string;
  /** The unit of the folder you're in. */
  unit: string | null;
  /** Picked equipment, and its documents. */
  assetId: string | null;
  docs?: FindDoc[] | null;
  /** Equipment to light while a question is open ("which E-22?"). */
  candidates?: string[];
  /** A piece of equipment tapped on the map. */
  onPickAsset?: (assetId: string, tag: string) => void;
  /** A unit tapped on the map. */
  onUnit?: (unitCode: string) => void;
  onDoc: (doc: { id: string; href: string }) => void;
  className?: string;
}

export default function FindMap({ orgId, unit, assetId, docs, candidates, onPickAsset, onUnit, onDoc, className = "" }: Props) {
  const [base, setBase] = useState<MapBase | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [flyTo, setFlyTo] = useState<{ ids: string[]; nonce: number } | null>(null);
  const [enter, setEnter] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void findMapBase(orgId).then((b) => { if (alive) setBase(b); });
    return () => { alive = false; };
  }, [orgId]);

  const focusDocs = useMemo(() => (assetId ? (docs ?? []) : []), [assetId, docs]);
  const graph = useMemo(() => (base ? mapWithDocs(base, assetId, focusDocs) : null), [base, assetId, focusDocs]);
  const has = (id: string) => !!graph?.nodes.some((n) => n.id === id);
  const candKey = (candidates ?? []).join(",");

  // Follow where you are: into the folder's unit, or the whole site (where
  // the candidates of an open question are all in view).
  const unitReady = !!unit && has(`cbunit:${unit}`);
  useEffect(() => {
    if (assetId || !base) return;
    setEnter({ id: unitReady && !candKey ? `cbunit:${unit}` : "__all__", nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, unitReady, !!base, !!assetId, candKey]);

  // Fly to the picked equipment once its documents are on the map.
  const assetReady = !!assetId && has(`asset:${assetId}`);
  const docsKey = focusDocs.map((d) => d.id).join(",");
  useEffect(() => {
    if (!assetId || !assetReady) return;
    setFlyTo({ ids: [`asset:${assetId}`], nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, assetReady, docsKey]);

  // The picked equipment and its documents stay lit; the rest dims.
  const highlight = useMemo(() => new Set(assetId
    ? [`asset:${assetId}`, ...focusDocs.map((d) => `doc:${d.id}`)]
    : (candKey ? candKey.split(",") : []).map((id) => `asset:${id}`)), [assetId, focusDocs, candKey]);

  const act = (n: GraphNode) => {
    if (n.type === "document") onDoc({ id: n.id.slice(4), href: n.href });
    else if (n.type === "asset") onPickAsset?.(n.id.slice(6), n.label);
    else if (n.type === "unit" && n.id.startsWith("cbunit:")) onUnit?.(n.id.slice(7));
  };

  return (
    <div className={`relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 ${className}`} data-find-map>
      {!graph ? (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-4 h-4 animate-spin" /></div>
      ) : graph.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-[11px] text-[var(--color-text-muted)]">No equipment in the registry yet, so there is nothing to map.</div>
      ) : (
        <EstateMap nodes={graph.nodes} edges={graph.edges} query="" selectedId={selected?.id ?? null} highlightIds={highlight}
          flyTo={flyTo} enter={enter} compact
          onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
      )}
    </div>
  );
}
