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
  /** Drop a dragged DOCUMENT row onto this folder. */
  onDocDrop?: (docId: string, folderId: string) => void;
  isController: boolean;
}

export default function FolderGrid({
  folders,
  allFolders,
  onOpen,
  onRename,
  onMove,
  onMoveInto,
  onDocDrop,
  onPermissions,
  onCustomize,
  onReviewCycle,
  onAckPolicy,
  onReviewControl,
  onRetention,
  isController
}: FolderGridProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    setContextMenu({ id, x: e.clientX, y: e.clientY });
    setMenuOpenId(null);
  };

  const renderMenu = (id: string) => (
    <div 
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      className="absolute z-50 bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] ring-1 ring-black/5 rounded-xl shadow-lg w-48 py-1 overflow-hidden animate-in fade-in zoom-in-95 duration-150 origin-top-right"
      style={contextMenu?.id === id ? { top: 0, left: 0, position: 'relative' } : { top: '100%', right: 0 }}
    >
      <button onClick={() => { onOpen(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
        <FolderOpen className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Open
      </button>
      {isController && (
        <>
          <div className="h-px bg-[var(--color-surface-2)] my-1" />
          <button onClick={() => { onRename?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <Pencil className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Rename
          </button>
          <button onClick={() => { onMove?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <ArrowRight className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Move
          </button>
          <button onClick={() => { onCustomize?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
            <Palette className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Customize
          </button>
          {onReviewCycle && (
            <button onClick={() => { onReviewCycle(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <CalendarClock className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Review cycle
            </button>
          )}
          {onAckPolicy && (
            <button onClick={() => { onAckPolicy(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <ClipboardCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Read &amp; understood
            </button>
          )}
          {onReviewControl && (
            <button onClick={() => { onReviewControl(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <ShieldCheck className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Pre-publish review
            </button>
          )}
          {onRetention && (
            <button onClick={() => { onRetention(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
              <Archive className="w-4 h-4 mr-2 text-[var(--color-text-faint)]" /> Retention
            </button>
          )}
          <button onClick={() => { onPermissions?.(id); setMenuOpenId(null); setContextMenu(null); }} className="w-full text-left px-4 py-2.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-2)] flex items-center font-medium">
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
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

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
    || e.dataTransfer.types.includes("application/x-doc-id");

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
          }}
          onDragOver={(e) => {
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();          // the upload overlay must not fire
            setDropTargetId(folder.id!);
          }}
          onDragLeave={() => setDropTargetId((cur) => (cur === folder.id ? null : cur))}
          onDrop={(e) => {
            if (!acceptsDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTargetId(null);
            const dragFolder = e.dataTransfer.getData("application/x-folder-id");
            const dragDoc = e.dataTransfer.getData("application/x-doc-id");
            if (dragFolder && onMoveInto && !isDescendant(dragFolder, folder.id!)) {
              onMoveInto(dragFolder, folder.id!);
            } else if (dragDoc && onDocDrop) {
              onDocDrop(dragDoc, folder.id!);
            }
          }}
          className={`
            group relative flex flex-col p-4 rounded-2xl border transition-all duration-200 cursor-pointer hover-lift
            ${dropTargetId === folder.id
              ? 'bg-blue-50/80 dark:bg-blue-950/30 border-blue-400 ring-2 ring-blue-300'
              : (menuOpenId === folder.id || contextMenu?.id === folder.id)
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
                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === folder.id ? null : folder.id!); setContextMenu(null); }}
                className={`p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors ${(menuOpenId === folder.id) ? 'bg-[var(--color-surface-2)] text-[var(--color-text)]' : 'text-[var(--color-text-faint)] opacity-60 sm:opacity-0 group-hover:opacity-100'}`}
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {menuOpenId === folder.id && renderMenu(folder.id!)}
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

          {/* Custom Context Menu Overlay */}
          {contextMenu?.id === folder.id && (
            <div 
              className="fixed z-[100]" 
              style={{ top: contextMenu?.y, left: contextMenu?.x }}
              onClick={(e) => e.stopPropagation()} // Prevent closing immediately
            >
              {renderMenu(folder.id!)}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
