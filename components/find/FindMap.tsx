"use client";

// FindMap - the estate map (unit > type > equipment > documents) in a box.
// It follows the folder you're in (goes into that unit) and, when equipment
// is picked, flies to it with its documents hung under it. Tap a dot to go
// in, tap a document to preview it, Esc or the crumbs to climb out.

import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import EstateMap from "@/components/graph/EstateMap";
import { findMapBase, mapWithDocs, equipDocs, type MapBase, type FindDoc } from "@/lib/findEverywhere";
import type { GraphNode } from "@/lib/orgGraph";

interface Props {
  orgId: string;
  /** The unit of the folder you're in. */
  unit: string | null;
  /** Picked equipment, and its documents when the caller already has them. */
  assetId: string | null;
  docs?: FindDoc[] | null;
  /** Equipment to light while a question is open ("which E-22?"). */
  candidates?: string[];
  onPickAsset?: (assetId: string) => void;
  onDoc: (doc: { id: string; href: string }) => void;
  className?: string;
}

export default function FindMap({ orgId, unit, assetId, docs, candidates, onPickAsset, onDoc, className = "" }: Props) {
  const [base, setBase] = useState<MapBase | null>(null);
  // Equipment tapped on the map itself (when the caller doesn't pick).
  const [own, setOwn] = useState<{ id: string; docs: FindDoc[] } | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [flyTo, setFlyTo] = useState<{ ids: string[]; nonce: number } | null>(null);
  const [enter, setEnter] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void findMapBase(orgId).then((b) => { if (alive) setBase(b); });
    return () => { alive = false; };
  }, [orgId]);

  const focusAsset = assetId ?? own?.id ?? null;
  const candKey = (candidates ?? []).join(",");
  const focusDocs = assetId ? (docs ?? []) : (own?.docs ?? []);
  const graph = useMemo(() => (base ? mapWithDocs(base, focusAsset, focusDocs) : null), [base, focusAsset, focusDocs]);
  const has = (id: string) => !!graph?.nodes.some((n) => n.id === id);

  // Follow the folder: go into its unit (or the whole estate) when nothing is picked.
  const unitReady = !!unit && has(`cbunit:${unit}`);
  useEffect(() => {
    if (focusAsset || !base) return;
    setEnter({ id: unitReady && !candKey ? `cbunit:${unit}` : "__all__", nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit, unitReady, !!base, !!focusAsset, candKey]);

  // Fly to the picked equipment once its documents are on the map.
  const assetReady = !!focusAsset && has(`asset:${focusAsset}`);
  const docsKey = focusDocs.map((d) => d.id).join(",");
  useEffect(() => {
    if (!focusAsset || !assetReady) return;
    setFlyTo({ ids: [`asset:${focusAsset}`], nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAsset, assetReady, docsKey]);

  // The picked equipment and its documents stay lit; the rest dims.
  const highlight = useMemo(() => new Set(focusAsset
    ? [`asset:${focusAsset}`, ...focusDocs.map((d) => `doc:${d.id}`)]
    : (candKey ? candKey.split(",") : []).map((id) => `asset:${id}`)), [focusAsset, focusDocs, candKey]);

  const pickAsset = (id: string) => {
    if (onPickAsset) { onPickAsset(id); return; }
    void equipDocs(orgId, id).then((d) => setOwn({ id, docs: d }));
  };

  const onSelect = (n: GraphNode | null) => {
    setSelected(n);
    if (!n) return;
    if (n.type === "document") onDoc({ id: n.id.slice(4), href: n.href });
    else if (n.type === "asset") pickAsset(n.id.slice(6));
  };
  const onOpen = (n: GraphNode) => {
    if (n.type === "document") onDoc({ id: n.id.slice(4), href: n.href });
    else if (n.type === "asset") pickAsset(n.id.slice(6));
  };

  return (
    <div className={`relative overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 ${className}`}>
      {!graph ? (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-4 h-4 animate-spin" /></div>
      ) : graph.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-[11px] text-[var(--color-text-muted)]">No equipment in the registry yet, so there is nothing to map.</div>
      ) : (
        <EstateMap nodes={graph.nodes} edges={graph.edges} query="" selectedId={selected?.id ?? null} highlightIds={highlight}
          flyTo={flyTo} enter={enter} compact onSelect={onSelect} onOpen={onOpen} />
      )}
    </div>
  );
}
