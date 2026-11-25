"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  MoreVertical,
  FolderOpen,
  Pencil,
  Lock,
  ArrowRight,
  Palette,
  CalendarClock,
  ClipboardCheck,
  ShieldCheck,
  Archive,
  Trash2,
  Folder,
} from "lucide-react";
import { LibraryCollection } from "@/types/schema";
import NodeCover from "@/components/documents/NodeCover";
import { CardStrip } from "@/components/ui/PageHero";

// Folder name, files, subfolders, menu. On a phone: name (counts under it), menu.
const LIST_COLS = "grid-cols-[minmax(0,1fr)_40px] sm:grid-cols-[minmax(0,1fr)_96px_104px_40px]";

interface FolderGridProps {
  folders: LibraryCollection[];
  /** Every folder in the library — lets each card show its subfolder count. */
  allFolders?: LibraryCollection[];
  /** Documents in each folder INCLUDING its subfolders. */
  docTotals?: Map<string, number>;
  onOpen: (id: string) => void;
  onRename?: (id: string) => void;
  onMove?: (id: string) => void;
  onPermissions?: (id: string) => void;
  onCustomize?: (id: string) => void;
  onReviewCycle?: (id: string) => void;
  onAckPolicy?: (id: string) => void;
  onReviewControl?: (id: string) => void;
  onRetention?: (id: string) => void;
  /** Drop a dragged FOLDER onto this folder. The grid refuses self and
   *  descendants before calling — a folder cannot live inside itself. */
  onMoveInto?: (dragId: string, targetId: string) => void;
  /** Drop dragged DOCUMENT row(s) onto this folder — the array is however
   *  many rows were checked when the drag started. */
  onDocsDrop?: (docIds: string[], folderId: string) => void;
  /** Drop a dragged folder on a tile's EDGE: place it before/after the
   *  target among its siblings — how folders get ordered by hand. */
  onReorder?: (dragId: string, targetId: string, position: "before" | "after") => void;
  onDelete?: (id: string) => void;
  isController: boolean;
  /** Multi-select over tiles (ctrl/shift+click). Plain click still OPENS —
   *  folders navigate on click everywhere in this app. */
  selectedIds?: ReadonlySet<string>;
  onTileSelect?: (id: string, mods: { ctrl: boolean; shift: boolean }) => void;
  /** Move SEVERAL folders at once (a drag that started on a selected tile
   *  carries the whole selection). Falls back to per-id onMoveInto. */
  onMoveManyInto?: (ids: string[], targetId: string) => void;
  /** "strip": one row of white cards that keeps going sideways (the
   *  library's folders over the band). "grid" (default): wrapped tiles. */
  /** "list": a compact ruled table on one white sheet, one row per
   *  folder with its file and subfolder counts. */
  layout?: "grid" | "strip" | "list";
}

export default function FolderGrid({
  folders,
  allFolders,
  onOpen,
  docTotals,
  onRename,
  onMove,
  onMoveInto,
  onDocsDrop,
  onReorder,
  onDelete,
  onPermissions,
  onCustomize,
  onReviewCycle,
  onAckPolicy,
  onReviewControl,
  onRetention,
  isController,
  selectedIds,
  onTileSelect,
  onMoveManyInto,
  layout = "grid",
}: FolderGridProps) {
  const strip = layout === "strip";
  const list = layout === "list";
  // Spring-loaded folders: hovering a tile mid-drag for ~900ms opens it, so
  // deep drops don't need a separate navigation step first.
  const springRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearSpring = () => {
    if (springRef.current) { clearTimeout(springRef.current.timer); springRef.current = null; }
  };
  useEffect(() => clearSpring, []);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ id, x: e.clientX, y: e.clientY });
      };

  const renderMenu = (id: string) => (
    <div 
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      role="menu" className="ui-float ui-float-in absolute z-50 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] rounded-xl w-56 py-1 overflow-hidden origin-top-right"
      style={contextMenu?.id === id ? { top: 0, left: 0, position: 'relative' } : { top: '100%', right: 0 }}
    >
      <button onClick={() => { onOpen(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
        <FolderOpen className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Open
      </button>
      {isController && (
        <>
          <div className="h-px bg-[var(--color-border)] my-1" />
          <button onClick={() => { onRename?.(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
            <Pencil className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Rename
          </button>
          <button onClick={() => { onMove?.(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
            <ArrowRight className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Move
          </button>
          <button onClick={() => { onCustomize?.(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
            <Palette className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Customize
          </button>
          {onReviewCycle && (
            <button onClick={() => { onReviewCycle(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
              <CalendarClock className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Review cycle
            </button>
          )}
          {onAckPolicy && (
            <button onClick={() => { onAckPolicy(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
              <ClipboardCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Read &amp; understood
            </button>
          )}
          {onReviewControl && (
            <button onClick={() => { onReviewControl(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
              <ShieldCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Pre-publish review
            </button>
          )}
          {onRetention && (
            <button onClick={() => { onRetention(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
              <Archive className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Retention
            </button>
          )}
          <button onClick={() => { onPermissions?.(id); setContextMenu(null); }} role="menuitem" className="w-full text-left px-3 min-h-10 text-body text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center">
            <Lock className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Permissions
          </button>
          {onDelete && (
            <>
              <div className="h-px bg-[var(--color-border)] my-1" />
              <button onClick={() => { onDelete(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-body text-[var(--state-overdue)] hover:bg-[color-mix(in_srgb,var(--state-overdue)_10%,transparent)] flex items-center font-medium">
                <Trash2 className="w-4 h-4 mr-2" /> Delete
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  const subCount = (id?: string) =>
    allFolders && id ? allFolders.filter((f) => f.parentId === id).length : null;

  // Drag-and-drop moving. These MIME keys are how a drop distinguishes a
  // folder tile from a document row from the OS dropping files — and why
  // dragging a tile can never trigger the page's file-upload overlay.
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: "into" | "before" | "after" } | null>(null);
  /** The folder currently being dragged FROM this grid — known here (unlike
   *  in dataTransfer, unreadable during dragover), so an invalid target can
   *  show the browser's not-allowed cursor instead of a welcoming ring. */
  const [draggingId, setDraggingId] = useState<string | null>(null);

  /** targetId inside dragId's own subtree? Walk up the parent chain. */
  const isDescendant = (dragId: string, targetId: string): boolean => {
    if (dragId === targetId) return true;
    let cur = allFolders?.find((f) => f.id === targetId);
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur.parentId === dragId) return true;
      cur = allFolders?.find((f) => f.id === cur!.parentId);
    }
    return false;
  };

  const acceptsDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("application/x-folder-id")
    || e.dataTransfer.types.includes("application/x-doc-ids");

  const metaLine = (folder: LibraryCollection, kids: number | null) => {
    const n = docTotals?.get(folder.id!);
    const parts: string[] = [];
    if (n !== undefined) parts.push(`${n.toLocaleString()} file${n === 1 ? '' : 's'}`);
    if (kids !== null && kids > 0) parts.push(`${kids} ${strip ? "folder" : "subfolder"}${kids === 1 ? '' : 's'}`);
    if (parts.length) return parts.join(' · ');
    return folder.description?.trim()
      ? folder.description
      : (folder.pathNames && folder.pathNames.length > 1 ? folder.pathNames.slice(0, -1).join(' / ') : 'Folder');
  };
  // A short list of folders is split by space, not a line under every row
  // (B3); a long one keeps its row lines.
  const ruled = folders.length > 8;
  const tiles = (
    <>
      {folders.map(folder => {
        const kids = subCount(folder.id);
        const dropInto = !!dropTarget && dropTarget.id === folder.id && dropTarget.zone === "into";
        const dropBefore = !!dropTarget && dropTarget.id === folder.id && dropTarget.zone === "before";
        const dropAfter = !!dropTarget && dropTarget.id === folder.id && dropTarget.zone === "after";
        const menuButton = (
          <button
            type="button"
            aria-label={`Folder actions: ${folder.name}`}
            aria-haspopup="menu"
            aria-expanded={contextMenu?.id === folder.id}
            onClick={(e) => {
              e.stopPropagation();
              // Anchor the menu to the button, but render it FIXED at
              // the top level — inside the tile it inherits the tile's
              // hover transform, which makes a new stacking context and
              // leaves the dropdown flickering under the next section's
              // header. Same path the right-click menu already uses.
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setContextMenu(contextMenu?.id === folder.id
                ? null
                : { id: folder.id!, x: Math.max(8, r.right - 208), y: r.bottom + 4 });
            }}
            className={`ui-hit p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors ${contextMenu?.id === folder.id ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-faint)] opacity-60 sm:opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        );
        const rowProps = {
          onClick: (e: React.MouseEvent) => {
            // Ctrl/shift+click SELECTS (Explorer); plain click still opens.
            if (onTileSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) {
              if (e.shiftKey) window.getSelection()?.removeAllRanges();
              onTileSelect(folder.id!, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
              return;
            }
            onOpen(folder.id!);
          },
          onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, folder.id!),
          draggable: isController && !!onMoveInto,
          onDragStart: (e: React.DragEvent<HTMLElement>) => {
            e.dataTransfer.setData("application/x-folder-id", folder.id!);
            // Dragging a SELECTED tile carries the whole selection.
            const ids = selectedIds?.has(folder.id!) && selectedIds.size > 1
              ? [...selectedIds] : [folder.id!];
            if (ids.length > 1) {
              e.dataTransfer.setData("application/x-folder-ids", JSON.stringify(ids));
              const ghost = document.createElement("div");
              ghost.textContent = `${ids.length} folders`;
              ghost.style.cssText =
                "position:absolute;top:-1000px;padding:6px 12px;background:#1e293b;color:#fff;"
                + "border-radius:10px;font-size:12px;font-weight:700;";
              document.body.appendChild(ghost);
              e.dataTransfer.setDragImage(ghost, 12, 12);
              setTimeout(() => ghost.remove(), 0);
            }
            e.dataTransfer.effectAllowed = "move";
            setDraggingId(folder.id!);
          },
          onDragEnd: () => { setDraggingId(null); clearSpring(); },
          onDragOver: (e: React.DragEvent<HTMLElement>) => {
            // Spring-load: linger over a tile mid-drag (any payload, files
            // from the OS included) and it opens, so you can drop deeper
            // without a separate navigation trip first.
            if ((acceptsDrag(e) || e.dataTransfer.types.includes("Files")) && draggingId !== folder.id) {
              if (springRef.current?.id !== folder.id) {
                clearSpring();
                springRef.current = {
                  id: folder.id!,
                  timer: setTimeout(() => { springRef.current = null; onOpen(folder.id!); }, 900),
                };
              }
            }
            if (!acceptsDrag(e)) return;
            const isFolderDrag = e.dataTransfer.types.includes("application/x-folder-id");
            // Edge quarters reorder among siblings; the middle moves INSIDE.
            // Windows/macOS both use this split, and it is the only way one
            // drag gesture can mean two things without a mode switch.
            // (In the list, rows stack, so the top and bottom edges reorder.)
            const r = e.currentTarget.getBoundingClientRect();
            const frac = list
              ? (e.clientY - r.top) / Math.max(1, r.height)
              : (e.clientX - r.left) / Math.max(1, r.width);
            const zone: "into" | "before" | "after" =
              isFolderDrag && onReorder && frac < 0.25 ? "before"
              : isFolderDrag && onReorder && frac > 0.75 ? "after"
              : "into";
            // Self/descendant can still be dropped BESIDE itself for
            // reorder; only "into" is forbidden.
            if (zone === "into" && draggingId && isDescendant(draggingId, folder.id!)) return;
            if (zone !== "into" && draggingId === folder.id) return;
            e.preventDefault();
            e.stopPropagation();          // the upload overlay must not fire
            setDropTarget({ id: folder.id!, zone });
          },
          onDragLeave: () => {
            setDropTarget((cur) => (cur?.id === folder.id ? null : cur));
            if (springRef.current?.id === folder.id) clearSpring();
          },
          onDrop: (e: React.DragEvent<HTMLElement>) => {
            clearSpring();
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const zone = (dropTarget && dropTarget.id === folder.id) ? dropTarget.zone : "into";
            setDropTarget(null);
            const dragFolder = e.dataTransfer.getData("application/x-folder-id");
            const dragFolders = e.dataTransfer.getData("application/x-folder-ids");
            const dragDocs = e.dataTransfer.getData("application/x-doc-ids");
            // A multi-folder drag: every selected folder moves in (edge
            // reorder is a single-folder gesture — with many it means move).
            let folderIds: string[] = [];
            if (dragFolders) {
              try { folderIds = (JSON.parse(dragFolders) as string[]).filter(Boolean); }
              catch { folderIds = []; }
            }
            if (folderIds.length > 1) {
              const movable = folderIds.filter((id) => !isDescendant(id, folder.id!));
              if (movable.length > 0) {
                if (onMoveManyInto) onMoveManyInto(movable, folder.id!);
                else if (onMoveInto) for (const id of movable) onMoveInto(id, folder.id!);
              }
            } else if (dragFolder && zone !== "into" && onReorder && dragFolder !== folder.id) {
              onReorder(dragFolder, folder.id!, zone);
            } else if (dragFolder && onMoveInto && !isDescendant(dragFolder, folder.id!)) {
              onMoveInto(dragFolder, folder.id!);
            } else if (dragDocs && onDocsDrop) {
              try {
                const ids = JSON.parse(dragDocs) as string[];
                if (Array.isArray(ids) && ids.length > 0) onDocsDrop(ids, folder.id!);
              } catch { /* malformed payload — ignore the drop */ }
            }
          },
        };
        if (list) return (
          <div
            key={folder.id}
            role="row"
            {...rowProps}
            className={`group relative grid ${LIST_COLS} items-center gap-x-3 px-4 min-h-12 py-1.5 ${ruled ? "border-t border-[var(--color-border)] max-sm:[&:nth-child(2)]:border-t-0" : ""} cursor-pointer transition-colors ${
              dropInto ? "bg-[var(--color-surface-2)] ring-2 ring-inset ring-[var(--color-border-strong)]"
              : dropBefore ? "shadow-[inset_0_3px_0_0_var(--color-text-muted)]"
              : dropAfter ? "shadow-[inset_0_-3px_0_0_var(--color-text-muted)]"
              : selectedIds?.has(folder.id!) ? "bg-[var(--color-accent-soft)]"
              : contextMenu?.id === folder.id ? "bg-[var(--color-surface-2)]"
              : "hover:bg-[var(--color-surface-2)]"}`}
          >
            {selectedIds?.has(folder.id!) && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--color-main)]" />}
            {/* The open target is a real button; its click bubbles to the
                row, which also handles ctrl/shift selection. */}
            <div role="cell" className="min-w-0">
              <button type="button" className="w-full min-w-0 flex items-center gap-3 text-left rounded focus-visible:outline-2 focus-visible:outline-offset-2">
                {folder.color || folder.icon || folder.coverImageUrl ? (
                  <NodeCover
                    appearance={{ color: folder.color, icon: folder.icon, coverImageUrl: folder.coverImageUrl, coverTint: folder.coverTint }}
                    className="w-7 h-7 shrink-0"
                    rounded="rounded-md"
                    iconSize="w-3.5 h-3.5"
                  />
                ) : (
                  <Folder aria-hidden className="w-[18px] h-[18px] shrink-0 text-[var(--color-text-faint)]" />
                )}
                <span className="min-w-0">
                  <span className="block text-reading font-medium text-[var(--color-text)] group-hover:text-[var(--color-accent-text)] truncate select-none">{folder.name}</span>
                  <span className="sm:hidden block text-body text-[var(--color-text-muted)] truncate select-none">{metaLine(folder, kids)}</span>
                </span>
              </button>
            </div>
            {/* Counts as plain right-aligned figures; a zero is muted. */}
            <div role="cell" className={`max-sm:hidden text-right text-body tabular-nums ${(docTotals?.get(folder.id!) ?? 0) > 0 ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
              {(docTotals?.get(folder.id!) ?? 0).toLocaleString()}
            </div>
            <div role="cell" className={`max-sm:hidden text-right text-body tabular-nums ${kids ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>
              {(kids ?? 0).toLocaleString()}
            </div>
            <div role="cell" className="flex justify-end">{menuButton}</div>
          </div>
        );
        return (
        <div
          key={folder.id}
          {...rowProps}
          className={strip ? `
            group relative shrink-0 basis-[248px] sm:basis-[280px] flex items-center gap-3 pl-4 pr-2 py-3.5 rounded-xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-shadow cursor-pointer
            ${dropInto ? 'ring-2 ring-[var(--color-border-strong)] bg-[var(--color-surface-2)]'
              : dropBefore ? 'shadow-[inset_4px_0_0_0_var(--color-border-strong),var(--shadow-card)]'
              : dropAfter ? 'shadow-[inset_-4px_0_0_0_var(--color-border-strong),var(--shadow-card)]'
              : selectedIds?.has(folder.id!) ? 'ring-2 ring-[var(--color-border-strong)]'
              : contextMenu?.id === folder.id ? 'ring-1 ring-[var(--color-border-strong)]'
              : 'hover:ring-1 hover:ring-[var(--color-border)]'}
          ` : `
            group relative flex flex-col p-4 rounded-2xl border transition-all duration-200 cursor-pointer hover-lift
            ${(dropTarget && dropTarget.id === folder.id && dropTarget.zone === "into")
              ? 'bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] border-[var(--color-border-strong)] ring-2 ring-[var(--color-border-strong)]'
              : (dropTarget && dropTarget.id === folder.id && dropTarget.zone === "before")
              ? 'border-l-4 border-l-[var(--color-border-strong)] border-[var(--color-border)]'
              : (dropTarget && dropTarget.id === folder.id && dropTarget.zone === "after")
              ? 'border-r-4 border-r-[var(--color-border-strong)] border-[var(--color-border)]'
              : selectedIds?.has(folder.id!)
              ? 'bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] border-[var(--color-border)] ring-1 ring-[var(--color-border-strong)]'
              : contextMenu?.id === folder.id
              ? 'bg-[var(--color-surface-2)] border-[var(--color-border-strong)] shadow-md ring-1 ring-[var(--color-border-strong)]'
              : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}
          `}
        >
          {strip ? (
            <>
              {/* The open target is a real button; its click bubbles to the
                  tile, which also handles ctrl/shift selection. */}
              <button type="button" className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4">
                <NodeCover
                  appearance={{ color: folder.color, icon: folder.icon, coverImageUrl: folder.coverImageUrl, coverTint: folder.coverTint }}
                  className="w-9 h-9 shrink-0"
                  rounded="rounded-lg"
                  iconSize="w-4 h-4"
                />
                <span className="min-w-0">
                  <span className="block text-body font-medium text-[var(--color-text)] truncate select-none">{folder.name}</span>
                  <span className="block text-body text-[var(--color-text-muted)] truncate select-none">{metaLine(folder, kids)}</span>
                </span>
              </button>
              {menuButton}
            </>
          ) : (
          <>
          <div className="flex items-start justify-between mb-3">
            <NodeCover
              appearance={{ color: folder.color, icon: folder.icon, coverImageUrl: folder.coverImageUrl, coverTint: folder.coverTint }}
              className="w-12 h-12"
              rounded="rounded-xl"
              iconSize="w-6 h-6"
            />

            <div className="relative">
              {menuButton}
            </div>
          </div>

          <h3 className="text-body font-medium text-[var(--color-text)] truncate mb-0.5 select-none">{folder.name}</h3>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <p className="text-body text-[var(--color-text-faint)] font-medium truncate select-none min-w-0">
              {metaLine(folder, kids)}
            </p>
            {/* Open affordance — appears on hover, keeps the card scannable at rest. */}
            <span className="shrink-0 w-5 h-5 rounded-md grid place-items-center text-[var(--color-text)] bg-[var(--color-surface-2)] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200">
              <ArrowRight className="w-3 h-3" />
            </span>
          </div>
          </>
          )}

        </div>
        );
      })}

      {/* The one menu overlay, rendered at the GRID ROOT. It must never sit
          inside a tile: tiles lift on hover with a CSS transform, and
          position:fixed inside a transformed ancestor resolves against the
          TILE, not the viewport — the menu teleported off-screen whenever
          the cursor was over the card and reappeared on mouse-out. */}
      {contextMenu && (
        <div
          className="fixed z-[100]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {renderMenu(contextMenu.id)}
        </div>
      )}
    </>
  );
  if (list) {
    return (
      <div role="table" aria-label="Folders" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div role="row" className={`max-sm:hidden grid ${LIST_COLS} items-center gap-x-3 px-4 h-10 text-body font-medium text-[var(--color-text-muted)] ${ruled ? "" : "border-b border-[var(--color-border)]"}`}>
          <span role="columnheader">Folder</span>
          <span role="columnheader" className="text-right">Files</span>
          <span role="columnheader" className="text-right">Subfolders</span>
          <span role="columnheader" aria-label="Actions" />
        </div>
        {tiles}
      </div>
    );
  }
  return strip
    ? <CardStrip className="!pb-7 -mb-5 pt-0.5 -mt-0.5">{tiles}</CardStrip>
    : <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">{tiles}</div>;
}
