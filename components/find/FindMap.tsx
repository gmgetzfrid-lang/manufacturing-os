"use client";

// FindMap - the map in a box, always beside the list it belongs to. It
// shows where you are:
//   in a folder      that folder: its subfolders and files, and under each
//                    file the equipment on it;
//   on equipment     the equipment you searched, its documents hung under it;
//   nowhere yet      the whole site (unit > type > equipment).
// One level opens at a time so every label reads. A switch at its top
// right changes what it shows: this folder, its unit, or the whole site.
//
// It also drives: tap a subfolder and the list opens it; tap a unit and the
// list opens that unit's folder; tap a piece of equipment and it is searched
// with its documents; tap a file and it opens right here, over the page, and
// closing it leaves you where you were. Esc or the crumbs climb out.

import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import EstateMap from "@/components/graph/EstateMap";
import DocInPlace from "@/components/documents/DocInPlace";
import { equipOnDocs, findMapBase, mapWithDocs, type MapBase, type FindDoc } from "@/lib/findEverywhere";
import { buildFolderMap, type FolderMapDoc, type FolderMapEquip, type FolderMapSub } from "@/lib/folderMap";
import type { GraphNode } from "@/lib/orgGraph";

/** The folder the list is showing (id null: the top of a library). */
export interface MapFolder {
  id: string | null;
  name: string;
  subfolders: FolderMapSub[];
  docs: FolderMapDoc[];
  /** The folder above it, when there is one to go up to. */
  up?: { id: string | null; name: string } | null;
  /** Files in the folder beyond the ones in `docs`. */
  more?: number;
}

const NONE = new Set<string>();

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
  /** A file tapped on the map. Not given: it opens here, over the page. */
  onDoc?: (doc: { id: string; href: string }) => void;
  /** The folder the list is in: the map shows it (unless equipment is
   *  picked or a question is open). */
  folder?: MapFolder | null;
  /** A subfolder (or the folder above) tapped on the map. */
  onFolder?: (folderId: string | null) => void;
  className?: string;
}

type Scope = "folder" | "unit" | "site";
const SCOPE_KEY = "map:scope";

export default function FindMap({ orgId, unit: unitProp, assetId, docs, candidates, onPickAsset, onUnit, onDoc, folder: folderProp, onFolder, className = "" }: Props) {
  // What the map shows: the folder you're in, its unit, or the whole site.
  // It starts on where you are; a choice made in the switch is remembered.
  const [picked, setPicked] = useState<Scope | null>(null);
  useEffect(() => { try { const v = window.localStorage.getItem(SCOPE_KEY); if (v === "folder" || v === "unit" || v === "site") setPicked(v); } catch { /* per-viewer only */ } }, []);
  const options: Scope[] = [...(folderProp ? ["folder" as const] : []), ...(unitProp ? ["unit" as const] : []), "site"];
  const scope: Scope = picked && options.includes(picked) ? picked : options[0];
  const pick = (s: Scope) => { setPicked(s); try { window.localStorage.setItem(SCOPE_KEY, s); } catch { /* per-viewer only */ } };
  const folder = scope === "folder" ? folderProp ?? null : null;
  const unit = scope === "site" ? null : unitProp;
  const [base, setBase] = useState<MapBase | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [equip, setEquip] = useState<{ key: string; on: Map<string, FolderMapEquip[]> } | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [flyTo, setFlyTo] = useState<{ ids: string[]; nonce: number } | null>(null);
  const [enter, setEnter] = useState<{ id: string; nonce: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void findMapBase(orgId).then((b) => { if (alive) setBase(b); });
    return () => { alive = false; };
  }, [orgId]);

  const candKey = (candidates ?? []).join(",");
  // The folder is the map while nothing more particular is asked of it.
  const inFolder = !!folder && !assetId && !candKey;
  const docKey = inFolder ? folder!.docs.map((d) => d.id).join(",") : "";
  // The equipment on the folder's files. A long list still arriving waits
  // until it settles, so this is read once.
  useEffect(() => {
    if (!inFolder || !docKey) return;
    let alive = true;
    const t = window.setTimeout(() => {
      void equipOnDocs(orgId, docKey.split(",")).then((on) => { if (alive) setEquip({ key: docKey, on }); }).catch(() => undefined);
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [orgId, inFolder, docKey]);
  const folderMap = useMemo(() => (inFolder && folder
    ? buildFolderMap({ folder: { id: folder.id, name: folder.name }, subfolders: folder.subfolders, docs: folder.docs, more: folder.more, onDoc: equip && equip.key === docKey ? equip.on : undefined })
    : null), [inFolder, folder, equip, docKey]);

  const focusDocs = useMemo(() => (assetId ? (docs ?? []) : []), [assetId, docs]);
  const graph = useMemo(() => (base ? mapWithDocs(base, assetId, focusDocs) : null), [base, assetId, focusDocs]);
  const has = (id: string) => !!graph?.nodes.some((n) => n.id === id);

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
  }, [assetId, assetReady, docsKey]);

  // The picked equipment and its documents stay lit; the rest dims.
  const highlight = useMemo(() => new Set(assetId
    ? [`asset:${assetId}`, ...focusDocs.map((d) => `doc:${d.id}`)]
    : (candKey ? candKey.split(",") : []).map((id) => `asset:${id}`)), [assetId, focusDocs, candKey]);

  const act = (n: GraphNode) => {
    if (n.type === "document") { if (onDoc) onDoc({ id: n.id.slice(4), href: n.href }); else setOpenDoc(n.id.slice(4)); }
    else if (n.type === "asset") onPickAsset?.(n.id.slice(6), n.label);
    else if (n.type === "unit" && n.id.startsWith("cbunit:")) onUnit?.(n.id.slice(7));
    // A subfolder: the list opens it, and the map follows the list.
    else if (n.id.startsWith("folder:") && folderMap && n.id !== folderMap.rootId) onFolder?.(n.id.slice(7));
  };
  const rootUp = useMemo(() => (inFolder && folder?.up && onFolder ? { label: folder.up.name, onUp: () => onFolder(folder.up!.id) } : null), [inFolder, folder?.up, onFolder]);

  return (
    <div className={`relative overflow-hidden rounded-xl bg-[var(--color-surface-2)] ${className}`} data-find-map={folderMap ? "folder" : "site"}>
      {options.length > 1 && !assetId && (
        <div role="radiogroup" aria-label="What the map shows"
          className="absolute top-2 right-2 z-20 inline-flex items-center gap-0.5 p-0.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-sm">
          {options.map((o) => (
            <button key={o} type="button" role="radio" aria-checked={scope === o} onClick={() => pick(o)}
              title={o === "folder" ? `Just ${folderProp?.name ?? "this folder"}` : o === "unit" ? `Everything in unit ${unitProp}` : "Every unit on the site"}
              className={`h-7 px-2.5 rounded text-[13px] font-semibold whitespace-nowrap transition-colors ${scope === o ? "bg-[var(--color-main)] text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`}>
              {o === "folder" ? "This folder" : o === "unit" ? `Unit ${unitProp}` : "Whole site"}
            </button>
          ))}
        </div>
      )}
      {openDoc && <DocInPlace docId={openDoc} onClose={() => setOpenDoc(null)} />}
      {folderMap ? (
        folderMap.tree.length <= 1 ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-[13px] text-[var(--color-text-muted)]">Nothing is filed in {folder!.name} yet.</div>
        ) : (
          <EstateMap nodes={folderMap.nodes} edges={[]} tree={folderMap.tree} fileNames={folderMap.fileNames} rootUp={rootUp} query="" selectedId={selected?.id ?? null}
            highlightIds={NONE} flyTo={null} compact onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
        )
      ) : !graph ? (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--color-text-faint)]"><Loader2 className="w-4 h-4 animate-spin" /></div>
      ) : graph.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-[13px] text-[var(--color-text-muted)]">No equipment in the registry yet, so there is nothing to map.</div>
      ) : (
        <EstateMap nodes={graph.nodes} edges={graph.edges} query="" selectedId={selected?.id ?? null} highlightIds={highlight}
          flyTo={flyTo} enter={enter} compact
          onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
      )}
    </div>
  );
}
