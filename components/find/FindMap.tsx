"use client";

// FindMap - the map in a box, always beside the list it belongs to. It
// shows where you are:
//   in a folder      that folder: its subfolders and files (named as in the
//                    list), and under each file the equipment on it;
//   Documents home   the libraries and the top folders in each;
//   on equipment     the equipment you searched, its documents hung under it.
// One level opens at a time so every label reads. A switch at its top
// right zooms out: this folder (or the libraries), its unit, the whole
// site. It starts on where you are every time, and goes back there when
// you move: a zoomed-out map never follows you into the next folder.
//
// It also drives: tap a subfolder and the list opens it; tap a library or
// a top folder and it opens; tap a unit and the list opens that unit's
// folder; tap a piece of equipment and it is searched with its documents;
// tap a file and it opens right here, over the page, and closing it leaves
// you where you were. Esc or the crumbs climb out.

import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import EstateMap from "@/components/graph/EstateMap";
import DocInPlace from "@/components/documents/DocInPlace";
import { equipOnDocs, findMapBase, mapWithDocs, type MapBase, type FindDoc } from "@/lib/findEverywhere";
import { buildFolderMap, type FolderMapDoc, type FolderMapEquip, type FolderMapSub } from "@/lib/folderMap";
import { buildLibrariesMap, libraryMapTarget, type MapLibrary } from "@/lib/libraryMap";
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
  /** Its files are still loading: the subfolders show, the files follow. */
  loading?: boolean;
}

export type { MapLibrary };

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
  /** The Documents home: the libraries and their top folders. */
  libraries?: MapLibrary[] | null;
  /** A library (folderId null) or one of its top folders tapped on the map. */
  onPlace?: (libraryId: string, folderId: string | null) => void;
  className?: string;
}

type Scope = "here" | "unit" | "site";

export default function FindMap({ orgId, unit: unitProp, assetId, docs, candidates, onPickAsset, onUnit, onDoc, folder: folderProp, onFolder, libraries, onPlace, className = "" }: Props) {
  // What the map shows: where you are (this folder, or the libraries), its
  // unit, or the whole site. A choice holds while you stay; moving to
  // another folder starts the map on that folder again.
  const placeKey = folderProp ? `folder:${folderProp.id ?? "top"}` : libraries ? "libraries" : "none";
  const [picked, setPicked] = useState<{ place: string; scope: Scope } | null>(null);
  const hasHere = !!folderProp || !!libraries;
  const options: Scope[] = [...(hasHere ? ["here" as const] : []), ...(unitProp ? ["unit" as const] : []), "site"];
  const scope: Scope = picked && picked.place === placeKey && options.includes(picked.scope) ? picked.scope : options[0];
  const pick = (s: Scope) => setPicked({ place: placeKey, scope: s });
  const folder = scope === "here" ? folderProp ?? null : null;
  const libs = scope === "here" && !folderProp ? libraries ?? null : null;
  const unit = scope === "site" ? null : unitProp;
  const [base, setBase] = useState<MapBase | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [equip, setEquip] = useState<{ key: string; on: Map<string, FolderMapEquip[]> } | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [flyTo, setFlyTo] = useState<{ ids: string[]; nonce: number } | null>(null);
  const [enter, setEnter] = useState<{ id: string; nonce: number } | null>(null);

  const candKey = (candidates ?? []).join(",");
  // The estate (units, equipment) is read only once something asks for it:
  // a folder's or the libraries' map never waits on it.
  const wantsEstate = !(scope === "here" && hasHere && !assetId && !candKey);
  useEffect(() => {
    if (!wantsEstate) return;
    let alive = true;
    void findMapBase(orgId).then((b) => { if (alive) setBase(b); });
    return () => { alive = false; };
  }, [orgId, wantsEstate]);

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

  // The Documents home: the libraries and the top folders in each.
  const libsMap = useMemo(() => (libs && !assetId && !candKey ? buildLibrariesMap(libs) : null), [libs, assetId, candKey]);

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
    // A library or a top folder on the Documents home: it opens.
    else if (libsMap) { const t = libraryMapTarget(libsMap, n.id); if (t) onPlace?.(t.libraryId, t.folderId); }
  };
  // A narrow box: the crumbs go under the switch, not behind it.
  const crumbsCls = options.length > 1 && !assetId ? "@max-lg:top-12 @max-lg:right-2" : "";
  const rootUp = useMemo(() => (inFolder && folder?.up && onFolder ? { label: folder.up.name, onUp: () => onFolder(folder.up!.id) } : null), [inFolder, folder?.up, onFolder]);

  return (
    <div className={`@container relative overflow-hidden rounded-xl bg-[var(--color-surface-2)] ${className}`} data-find-map={folderMap ? "folder" : libsMap ? "libraries" : unit ? "unit" : "site"}>
      {options.length > 1 && !assetId && (
        <div role="radiogroup" aria-label="What the map shows"
          className="absolute top-2 right-2 z-20 inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]">
          {options.map((o) => (
            <button key={o} type="button" role="radio" aria-checked={scope === o} onClick={() => pick(o)}
              title={o === "here" ? (folderProp ? `What is in ${folderProp.name}` : "Every library and its top folders") : o === "unit" ? `Everything in unit ${unitProp}` : "Every unit on the site"}
              className={`h-8 pointer-coarse:h-11 px-2.5 rounded-md text-body font-medium whitespace-nowrap transition-colors ${scope === o ? "bg-[var(--color-surface)] text-[var(--color-text)] ring-1 ring-[var(--color-border-strong)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
              {o === "here" ? (folderProp ? "This folder" : "Libraries") : o === "unit" ? `Unit ${unitProp}` : "Whole site"}
            </button>
          ))}
        </div>
      )}
      {openDoc && <DocInPlace docId={openDoc} onClose={() => setOpenDoc(null)} />}
      {folderMap ? (
        folderMap.tree.length <= 1 ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-body text-[var(--color-text-muted)]">
            {folder!.loading ? <span role="status" className="inline-flex items-center gap-2"><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Loading the files</span> : `Nothing is filed in ${folder!.name} yet.`}
          </div>
        ) : (
          <>
            <EstateMap nodes={folderMap.nodes} edges={[]} tree={folderMap.tree} fileNames={folderMap.fileNames} rootUp={rootUp} query="" selectedId={selected?.id ?? null}
              highlightIds={NONE} flyTo={null} compact crumbsClassName={crumbsCls} onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
            {folder!.loading && (
              <div role="status" className="absolute bottom-2 left-2 z-20 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-body text-[var(--color-text-muted)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the files
              </div>
            )}
          </>
        )
      ) : libsMap ? (
        libsMap.tree.length <= 1 ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-body text-[var(--color-text-muted)]">No libraries yet.</div>
        ) : (
          <EstateMap key={libsMap.rootId} nodes={libsMap.nodes} edges={[]} tree={libsMap.tree} depth={2} query="" selectedId={selected?.id ?? null}
            highlightIds={NONE} flyTo={null} compact crumbsClassName={crumbsCls} onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
        )
      ) : !graph ? (
        <div role="status" className="absolute inset-0 grid place-items-center text-body text-[var(--color-text-muted)]"><span className="inline-flex items-center gap-2"><Loader2 aria-hidden className="w-4 h-4 animate-spin" />Loading the site map</span></div>
      ) : graph.nodes.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-body text-[var(--color-text-muted)]">No equipment in the registry yet, so there is nothing to map.</div>
      ) : (
        <EstateMap nodes={graph.nodes} edges={graph.edges} query="" selectedId={selected?.id ?? null} highlightIds={highlight}
          flyTo={flyTo} enter={enter} compact crumbsClassName={crumbsCls}
          onSelect={(n) => { setSelected(n); if (n) act(n); }} onOpen={act} />
      )}
    </div>
  );
}
