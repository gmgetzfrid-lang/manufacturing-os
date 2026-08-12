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
} from "lucide-react";
import { LibraryCollection } from "@/types/schema";
import NodeCover from "@/components/documents/NodeCover";

interface FolderGridProps {
  folders: LibraryCollection[];
  /** Every folder in the library — lets each card show its subfolder count. */
  allFolders?: LibraryCollection[];
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
  isController: boolean;
}

export default function FolderGrid({
  folders,
  allFolders,
  onOpen,
  onRename,
  onMove,
  onMoveInto,
  onDocsDrop,
  onReorder,
  onPermissions,
  onCustomize,
  onReviewCycle,
  onAckPolicy,
  onReviewControl,
  onRetention,
  isController
}: FolderGridProps) {
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
      className="absolute z-50 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg w-48 py-1 overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-right"
      style={contextMenu?.id === id ? { top: 0, left: 0, position: 'relative' } : { top: '100%', right: 0 }}
    >
      <button onClick={() => { onOpen(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
        <FolderOpen className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Open
      </button>
      {isController && (
        <>
          <div className="h-px bg-[var(--color-surface-2)] my-1" />
          <button onClick={() => { onRename?.(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <Pencil className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Rename
          </button>
          <button onClick={() => { onMove?.(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <ArrowRight className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Move
          </button>
          <button onClick={() => { onCustomize?.(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <Palette className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Customize
          </button>
          {onReviewCycle && (
            <button onClick={() => { onReviewCycle(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <CalendarClock className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Review cycle
            </button>
          )}
          {onAckPolicy && (
            <button onClick={() => { onAckPolicy(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <ClipboardCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Read &amp; understood
            </button>
          )}
          {onReviewControl && (
            <button onClick={() => { onReviewControl(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <ShieldCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Pre-publish review
            </button>
          )}
          {onRetention && (
            <button onClick={() => { onRetention(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <Archive className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Retention
            </button>
          )}
          <button onClick={() => { onPermissions?.(id); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <Lock className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Permissions
          </button>
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

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {folders.map(folder => {
        const kids = subCount(folder.id);
        return (
        <div
          key={folder.id}
          onClick={() => onOpen(folder.id!)}
          onContextMenu={(e) => handleContextMenu(e, folder.id!)}
          draggable={isController && !!onMoveInto}
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-folder-id", folder.id!);
            e.dataTransfer.effectAllowed = "move";
            setDraggingId(folder.id!);
          }}
          onDragEnd={() => setDraggingId(null)}
          onDragOver={(e) => {
            if (!acceptsDrag(e)) return;
            const isFolderDrag = e.dataTransfer.types.includes("application/x-folder-id");
            // Edge quarters reorder among siblings; the middle moves INSIDE.
            // Windows/macOS both use this split, and it is the only way one
            // drag gesture can mean two things without a mode switch.
            const r = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - r.left) / Math.max(1, r.width);
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
          }}
          onDragLeave={() => setDropTarget((cur) => (cur?.id === folder.id ? null : cur))}
          onDrop={(e) => {
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const zone = (dropTarget && dropTarget.id === folder.id) ? dropTarget.zone : "into";
            setDropTarget(null);
            const dragFolder = e.dataTransfer.getData("application/x-folder-id");
            const dragDocs = e.dataTransfer.getData("application/x-doc-ids");
            if (dragFolder && zone !== "into" && onReorder && dragFolder !== folder.id) {
              onReorder(dragFolder, folder.id!, zone);
            } else if (dragFolder && onMoveInto && !isDescendant(dragFolder, folder.id!)) {
              onMoveInto(dragFolder, folder.id!);
            } else if (dragDocs && onDocsDrop) {
              try {
                const ids = JSON.parse(dragDocs) as string[];
                if (Array.isArray(ids) && ids.length > 0) onDocsDrop(ids, folder.id!);
              } catch { /* malformed payload — ignore the drop */ }
            }
          }}
          className={`
            group relative flex flex-col p-4 rounded-2xl border transition-all duration-200 cursor-pointer hover-lift
            ${(dropTarget && dropTarget.id === folder.id && dropTarget.zone === "into")
              ? 'bg-blue-50/80 dark:bg-blue-950/30 border-blue-400 ring-2 ring-blue-300'
              : (dropTarget && dropTarget.id === folder.id && dropTarget.zone === "before")
              ? 'border-l-4 border-l-blue-500 border-[var(--color-border)]'
              : (dropTarget && dropTarget.id === folder.id && dropTarget.zone === "after")
              ? 'border-r-4 border-r-blue-500 border-[var(--color-border)]'
              : contextMenu?.id === folder.id
              ? 'bg-[var(--color-accent-soft)]/60 border-[var(--color-accent)]/50 shadow-md ring-1 ring-[var(--color-accent)]/30'
              : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-accent)]/50'}
          `}
        >
          <div className="flex items-start justify-between mb-3">
            <NodeCover
              appearance={{ color: folder.color, icon: folder.icon, coverImageUrl: folder.coverImageUrl, coverTint: folder.coverTint }}
              className="w-12 h-12"
              rounded="rounded-xl"
              iconSize="w-6 h-6"
            />

            <div className="relative">
              <button
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
                className={`p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors ${contextMenu?.id === folder.id ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-faint)] opacity-60 sm:opacity-0 group-hover:opacity-100'}`}
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </div>
          </div>

          <h3 className="text-sm font-bold text-[var(--color-text)] truncate mb-0.5 select-none">{folder.name}</h3>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <p className="text-[10px] text-[var(--color-text-faint)] font-medium truncate select-none min-w-0">
              {folder.description?.trim()
                ? folder.description
                : kids !== null && kids > 0
                  ? `${kids} subfolder${kids === 1 ? '' : 's'}`
                  : (folder.pathNames && folder.pathNames.length > 1 ? folder.pathNames.slice(0, -1).join(' / ') : 'Folder')}
            </p>
            {/* Open affordance — appears on hover, keeps the card scannable at rest. */}
            <span className="shrink-0 w-5 h-5 rounded-md grid place-items-center text-[var(--color-accent)] bg-[var(--color-accent-soft)] opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200">
              <ArrowRight className="w-3 h-3" />
            </span>
          </div>

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
    </div>
  );
}
