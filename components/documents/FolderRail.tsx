"use client";

// The library's folders as a rail at the left edge: a narrow strip of the
// top folders, and on hover (or keyboard focus) the whole tree beside it.
//
// The tree reads four levels deep: each level steps in 16 px, a thin guide
// line drops from every open folder (the one holding the folder you're in
// is drawn darker), a chevron turns a quarter circle to open (the icon never
// swaps), and the arrow keys drive it (up and down move, right opens, left
// closes or goes to the parent, Enter opens the folder). Dragging files or
// folders over a closed folder opens it after a short pause, so they can go
// deeper without letting go. Skeleton rows hold the place while the folder
// list loads.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Home, FolderPlus, ChevronRight, Folder, PanelLeftOpen } from "lucide-react";
import type { LibraryCollection } from "@/types/schema";
import { NodeIcon } from "@/lib/nodeIcons";
import { Skeleton } from "@/components/ui/Skeleton";

/** A folder's icon, honoring its customization everywhere: a customized
 *  folder shows its own glyph in its color; a plain one keeps the classic
 *  folder glyph so long trees stay calm. */
function FolderGlyph({ folder, active }: { folder: LibraryCollection; active: boolean }) {
  if (folder.color || folder.icon) {
    return (
      <span className="w-4 h-4 grid place-items-center shrink-0" style={{ color: folder.color || "var(--color-text-muted)" }}>
        <NodeIcon name={folder.icon} className="w-3.5 h-3.5" />
      </span>
    );
  }
  return <Folder className={`w-4 h-4 shrink-0 ${active ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`} />;
}

export interface RailDropPayload {
  folderId?: string;
  folderIds?: string[];
  docIds?: string[];
}

// Documents per folder (including subfolders), shared down the tree.
const TotalsCtx = createContext<Map<string, number> | undefined>(undefined);

function CountBadge({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className={`ml-auto shrink-0 text-caption tabular-nums ${n ? "text-[var(--color-text-muted)]" : "text-[var(--color-text-faint)]"}`} title="Files here, including subfolders">{n.toLocaleString()}</span>;
}

interface FolderRailProps {
  libraryName: string;
  /** Files in each folder including its subfolders, and the library total. */
  docTotals?: Map<string, number>;
  libraryTotal?: number;
  folders: LibraryCollection[];
  currentFolderId: string | null;
  isController: boolean;
  onNavigate: (id: string | null) => void;
  onCreateFolder: () => void;
  /** Accept dragged documents/folders on rail icons and tree rows: the
   *  rail is a natural move target ("drag onto Piping"), same contract as
   *  the breadcrumb drops. Omitted = rail is navigation-only. */
  onDropItems?: (targetId: string | null, payload: RailDropPayload) => void;
  /** The folder list hasn't arrived yet: skeleton rows hold its place. */
  loading?: boolean;
}

const isItemDrag = (e: React.DragEvent) =>
  e.dataTransfer.types.includes("application/x-doc-ids") || e.dataTransfer.types.includes("application/x-folder-id");

/** Shared drag-drop handlers for any rail/tree element that represents a
 *  folder (or the library root when targetId is null). */
function railDropHandlers(
  targetId: string | null,
  onDropItems?: (targetId: string | null, payload: RailDropPayload) => void,
) {
  if (!onDropItems) return {};
  return {
    onDragOver: (e: React.DragEvent) => {
      if (isItemDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const manyRaw = e.dataTransfer.getData("application/x-folder-ids");
      if (manyRaw) {
        try {
          const ids = (JSON.parse(manyRaw) as string[]).filter(Boolean);
          if (ids.length > 0) { onDropItems(targetId, { folderIds: ids }); return; }
        } catch { /* fall through to the single-id key */ }
      }
      const folderId = e.dataTransfer.getData("application/x-folder-id");
      if (folderId) { onDropItems(targetId, { folderId }); return; }
      const docsRaw = e.dataTransfer.getData("application/x-doc-ids");
      if (docsRaw) {
        try {
          const ids = (JSON.parse(docsRaw) as string[]).filter(Boolean);
          if (ids.length > 0) onDropItems(targetId, { docIds: ids });
        } catch { /* malformed payload: ignore the drop */ }
      }
    },
  };
}

/** How long a drag rests on a closed folder before it opens. */
const SPRING_MS = 600;
const STEP = 16;

type Row = { folder: LibraryCollection; depth: number; hasKids: boolean; open: boolean; parentId: string | null };

function FolderTree({
  folders, currentFolderId, onNavigate, onDropItems, libraryName, libraryTotal,
}: {
  folders: LibraryCollection[];
  currentFolderId: string | null;
  onNavigate: (id: string | null) => void;
  onDropItems?: (targetId: string | null, payload: RailDropPayload) => void;
  libraryName: string;
  libraryTotal?: number;
}) {
  const totals = useContext(TotalsCtx);
  const kids = useMemo(() => {
    const m = new Map<string | null, LibraryCollection[]>();
    for (const f of folders) {
      const k = f.parentId ?? null;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return m;
  }, [folders]);
  const byId = useMemo(() => new Map(folders.map((f) => [f.id!, f])), [folders]);
  // The folders on the way to the one you're in.
  const chain = useMemo(() => {
    const out: string[] = [];
    let at = currentFolderId ? byId.get(currentFolderId) : undefined;
    let guard = 0;
    while (at?.parentId && guard++ < 64) { out.push(at.parentId); at = byId.get(at.parentId); }
    return out;
  }, [currentFolderId, byId]);

  // Open: the top level shows its children, and the way to where you are.
  const [open, setOpen] = useState<Set<string>>(() => new Set((kids.get(null) ?? []).map((f) => f.id!)));
  // Top folders that arrive later open too (the list loads after the rail).
  const rootKey = (kids.get(null) ?? []).map((f) => f.id).join(",");
  const [prevRoots, setPrevRoots] = useState(rootKey);
  if (rootKey !== prevRoots) {
    const before = new Set(prevRoots.split(","));
    setPrevRoots(rootKey);
    const fresh = (kids.get(null) ?? []).map((f) => f.id!).filter((id) => !before.has(id));
    if (fresh.length) setOpen((o) => new Set([...o, ...fresh]));
  }
  const [prevChain, setPrevChain] = useState<string>("");
  const chainKey = chain.join(",");
  if (chainKey !== prevChain) {
    setPrevChain(chainKey);
    if (chain.some((id) => !open.has(id))) setOpen((o) => new Set([...o, ...chain]));
  }
  const toggle = (id: string, to?: boolean) => setOpen((o) => {
    const n = new Set(o);
    if (to ?? !n.has(id)) n.add(id); else n.delete(id);
    return n;
  });

  // The visible rows, in order.
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of kids.get(parent) ?? []) {
        const hasKids = (kids.get(f.id!) ?? []).length > 0;
        const isOpen = hasKids && open.has(f.id!);
        out.push({ folder: f, depth, hasKids, open: isOpen, parentId: parent });
        if (isOpen) walk(f.id!, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [kids, open]);

  // One row takes Tab; the arrows move between rows.
  const ROOT = "__root__";
  const [focusId, setFocusId] = useState<string>(currentFolderId ?? ROOT);
  const ids = [ROOT, ...rows.map((r) => r.folder.id!)];
  const tabId = ids.includes(focusId) ? focusId : (currentFolderId && ids.includes(currentFolderId) ? currentFolderId : ROOT);
  const list = useRef<HTMLDivElement>(null);
  const focusRow = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey = (e: React.KeyboardEvent) => {
    const i = ids.indexOf(tabId);
    const row = rows.find((r) => r.folder.id === tabId);
    switch (e.key) {
      case "ArrowDown": if (i < ids.length - 1) focusRow(ids[i + 1]); break;
      case "ArrowUp": if (i > 0) focusRow(ids[i - 1]); break;
      case "Home": focusRow(ids[0]); break;
      case "End": focusRow(ids[ids.length - 1]); break;
      case "ArrowRight":
        if (row?.hasKids && !row.open) toggle(row.folder.id!, true);
        else if (row?.open) focusRow(ids[i + 1]);
        break;
      case "ArrowLeft":
        if (row?.open) toggle(row.folder.id!, false);
        else if (row) focusRow(row.parentId ?? ROOT);
        break;
      case "Enter": case " ":
        onNavigate(tabId === ROOT ? null : tabId);
        break;
      default: return;
    }
    e.preventDefault();
  };

  // Spring-loaded folders: a drag resting on a closed folder opens it.
  const spring = useRef<{ id: string; t: number } | null>(null);
  const [springing, setSpringing] = useState<string | null>(null);
  const armSpring = (id: string) => {
    if (spring.current?.id === id) return;
    if (spring.current) window.clearTimeout(spring.current.t);
    setSpringing(id);
    spring.current = { id, t: window.setTimeout(() => { toggle(id, true); spring.current = null; setSpringing(null); }, SPRING_MS) };
  };
  const disarm = () => {
    if (spring.current) window.clearTimeout(spring.current.t);
    spring.current = null;
    setSpringing(null);
  };
  useEffect(() => () => { if (spring.current) window.clearTimeout(spring.current.t); }, []);

  const currentParent = currentFolderId ? (byId.get(currentFolderId)?.parentId ?? null) : undefined;
  const rowCls = (active: boolean) => `relative w-full flex items-center gap-1.5 h-9 pointer-coarse:h-11 pr-2 rounded-lg text-left text-body transition-colors outline-offset-[-2px] ${
    active ? "bg-[var(--color-surface-2)] text-[var(--color-text)] font-medium" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
  }`;

  return (
    <div ref={list} role="tree" aria-label={`Folders in ${libraryName}`} onKeyDown={onKey} className="flex flex-col">
      <button
        type="button"
        role="treeitem"
        aria-level={1}
        aria-selected={!currentFolderId}
        data-tree-id={ROOT}
        tabIndex={tabId === ROOT ? 0 : -1}
        onFocus={() => setFocusId(ROOT)}
        onClick={() => onNavigate(null)}
        {...railDropHandlers(null, onDropItems)}
        className={`${rowCls(!currentFolderId)} pl-2`}
      >
        <Home className="w-4 h-4 shrink-0" />
        <span className="truncate">{libraryName}</span>
        <CountBadge n={libraryTotal} />
      </button>
      {rows.map((r) => {
        const f = r.folder;
        const active = currentFolderId === f.id;
        const indent = 8 + r.depth * STEP;
        return (
          <div key={f.id} className="relative">
            {/* Guide lines: one per open ancestor, dropping through its rows.
                The one holding the folder you're in is darker. */}
            {Array.from({ length: r.depth }, (_, d) => {
              const onBranch = d === r.depth - 1 && r.parentId === currentParent && currentParent !== null;
              return (
                <span key={d} aria-hidden
                  className={`absolute top-0 bottom-0 w-px ${onBranch ? "bg-[var(--color-text-muted)]" : "bg-[var(--color-border)]"}`}
                  style={{ left: 8 + d * STEP + 7 }} />
              );
            })}
            <div
              role="treeitem"
              aria-level={r.depth + 2}
              aria-expanded={r.hasKids ? r.open : undefined}
              aria-selected={active}
              data-tree-id={f.id}
              tabIndex={tabId === f.id ? 0 : -1}
              onFocus={(e) => { if (e.target === e.currentTarget) setFocusId(f.id!); }}
              onClick={() => onNavigate(f.id!)}
              onDragEnter={(e) => { if (onDropItems && isItemDrag(e) && r.hasKids && !r.open) armSpring(f.id!); }}
              onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) disarm(); }}
              {...railDropHandlers(f.id ?? null, onDropItems)}
              onDropCapture={() => disarm()}
              className={`${rowCls(active)} cursor-pointer`}
              style={{ paddingLeft: indent }}
              title={f.name}
            >
              <button
                type="button"
                tabIndex={-1}
                aria-label={r.open ? `Close ${f.name}` : `Open ${f.name}`}
                onClick={(e) => { e.stopPropagation(); toggle(f.id!); }}
                className={`pointer-coarse:size-11 relative w-4 h-4 shrink-0 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] ${r.hasKids ? "" : "invisible"}`}
              >
                <ChevronRight className={`ui-chevron w-3.5 h-3.5 ${r.open ? "rotate-90" : ""}`} />
                {springing === f.id && (
                  // The pause before a closed folder springs open.
                  <svg aria-hidden className="absolute -inset-1 w-6 h-6 -rotate-90" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="var(--color-current)" strokeWidth="2"
                      strokeDasharray="63" strokeDashoffset="63" style={{ animation: `rail-spring ${SPRING_MS}ms linear forwards` }} />
                  </svg>
                )}
              </button>
              <FolderGlyph folder={f} active={active} />
              <span className="truncate min-w-0">{f.name}</span>
              <CountBadge n={totals?.get(f.id!)} />
            </div>
          </div>
        );
      })}
      <style>{`@keyframes rail-spring { to { stroke-dashoffset: 0; } }`}</style>
    </div>
  );
}

export default function FolderRail({
  libraryName,
  docTotals,
  libraryTotal,
  folders,
  currentFolderId,
  isController,
  onNavigate,
  onCreateFolder,
  onDropItems,
  loading = false,
}: FolderRailProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const shown = hovered || focused;
  const rootFolders = folders.filter((f) => !f.parentId);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
      className="group/rail relative z-30 h-full shrink-0 max-md:hidden"
    >
      {/* The strip: always there, the top folders as icons. */}
      <div className="w-12 h-full bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col items-center py-2 gap-1 overflow-y-auto">
        <div
          className={`flex flex-col items-center gap-1 mb-1 transition-colors ${shown ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
          title="Folders: point here to browse"
        >
          <PanelLeftOpen className="w-4 h-4" />
          <span className="text-caption font-medium leading-none" style={{ writingMode: "vertical-rl" }}>Folders</span>
        </div>

        <div className="w-6 h-px bg-[var(--color-border)] my-1" />

        <button
          type="button"
          onClick={() => onNavigate(null)}
          {...railDropHandlers(null, onDropItems)}
          aria-label={libraryName}
          aria-current={!currentFolderId ? "page" : undefined}
          className={`pointer-coarse:size-11 relative w-9 h-9 rounded-lg grid place-items-center transition-colors ${
            !currentFolderId
              ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
              : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
          }`}
          title={libraryName}
        >
          <Home className="w-4 h-4" />
          {!currentFolderId && <span aria-hidden className="absolute -left-1.5 top-2 bottom-2 w-[3px] rounded-r bg-[var(--color-current)]" />}
        </button>

        {loading && rootFolders.length === 0 && Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="!w-6 !h-6 rounded-md my-1.5" />
        ))}

        {rootFolders.map((folder) => {
          const isActive = currentFolderId === folder.id || (!!currentFolderId && !!folder.id && (folders.find((f) => f.id === currentFolderId)?.pathIds ?? []).includes(folder.id));
          return (
            <button
              type="button"
              key={folder.id}
              onClick={() => onNavigate(folder.id!)}
              {...railDropHandlers(folder.id ?? null, onDropItems)}
              aria-label={folder.name}
              aria-current={currentFolderId === folder.id ? "page" : undefined}
              className={`pointer-coarse:size-11 relative w-9 h-9 rounded-lg grid place-items-center transition-colors ${
                isActive
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                  : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              }`}
              title={folder.name}
            >
              <FolderGlyph folder={folder} active={isActive} />
              {isActive && <span aria-hidden className="absolute -left-1.5 top-2 bottom-2 w-[3px] rounded-r bg-[var(--color-current)]" />}
            </button>
          );
        })}

        <div className="flex-1" />

        {isController && (
          <button
            type="button"
            onClick={onCreateFolder}
            aria-label="New folder"
            className="pointer-coarse:size-11 w-9 h-9 rounded-lg grid place-items-center text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] transition-colors"
            title="New folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* The tree: slides out beside the strip on hover or focus. */}
      <div
        className={`absolute top-0 left-12 h-full transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none pointer-events-none ${
          shown ? "w-72 opacity-100" : "w-0 opacity-0"
        }`}
      >
        <div
          className={`h-full w-72 bg-[var(--color-surface)] border-r border-[var(--color-border)] overflow-hidden ${
            shown ? "ui-float pointer-events-auto" : ""
          }`}
        >
          <div className="h-full flex flex-col">
            <div className="pl-4 pr-2 h-12 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-caption text-[var(--color-text-muted)]">Folders</div>
                <div className="text-body font-medium text-[var(--color-text)] truncate">{libraryName}</div>
              </div>
              {isController && (
                <button
                  type="button"
                  onClick={onCreateFolder}
                  className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
                  title="New folder"
                >
                  <FolderPlus className="w-4 h-4" /> New
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto py-2 px-2 custom-scrollbar">
              {loading && folders.length === 0 ? (
                <div role="status" className="space-y-1 px-2 pt-1">
                  <span className="sr-only">Loading folders</span>
                  {[70, 55, 62, 48].map((w, i) => (
                    <div key={i} className="flex items-center gap-2 h-9" style={{ paddingLeft: i % 2 ? STEP : 0 }}>
                      <Skeleton className="!w-4 !h-4 rounded" />
                      <Skeleton style={{ width: `${w}%` }} />
                    </div>
                  ))}
                </div>
              ) : (
                <TotalsCtx.Provider value={docTotals}>
                  <FolderTree folders={folders} currentFolderId={currentFolderId} onNavigate={onNavigate}
                    onDropItems={onDropItems} libraryName={libraryName} libraryTotal={libraryTotal} />
                </TotalsCtx.Provider>
              )}

              {!loading && folders.length === 0 && (
                <p className="text-body text-[var(--color-text-muted)] py-4 px-3">No folders yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
